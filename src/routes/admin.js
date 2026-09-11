import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { asyncHandler, AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { requireAuth, requireOnboarding, requireVerified } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { setFlash } from '../middleware/view.js';
import {
  ApprovalRequest, BusinessOrganization, CmsContent, CountrySetting, DataExport, FeatureFlag, GiftCard,
  Incident, IpBlock, LaunchEvidence, LoyaltyAccount, LoyaltyEntry, MarketingCampaign, MfaRecoveryRequest, OutboxEvent, PaymentIntent, Payout, PayoutAccount, Product, ProviderEvent,
  PrivacyRequest, PromoterVerification, ReconciliationRun, Referral, SecurityEvent, SecurityFinding, SellerVerification, Shipment, SupportTicket, TrustCase, User, OperationalAlert, WorkerHeartbeat, Warehouse,
} from '../models/index.js';
import { writeAudit } from '../services/audit.js';
import {
  adminCountryScope, applyApproval, createApproval, createCmsRevision, exportPath,
  platformReport, queueConsentCampaign, revealGiftCard,
} from '../services/stage9.js';
import { clearMfa, PRIVILEGED_MFA_ROLES } from '../services/mfa.js';
import { invalidateIpBlockCache, verifySecurityEventIntegrity, writeSecurityEvent } from '../services/security.js';
import { ensureLaunchEvidence, RECOVERY_EVIDENCE_KEYS } from '../services/launch.js';
import { env } from '../config/env.js';
import { approvePrivacyRequest, setPrivacyLegalHold } from '../services/privacy.js';
import { assertOperationalCountry, operationalCountriesFor, operationalCountryScope } from '../services/authorization.js';
import { operationalMetricSnapshot } from '../services/invariants.js';
import { cursorScope, cursorSort, pageResult } from '../services/pagination.js';
import { createPlatformStaffInvitation, revokePlatformStaffInvitation, staffInvitationsForAdmin } from '../services/staff-access.js';
import { hydratePlatformAuthorization, platformGrantRowsForAdmin } from '../services/platform-grants.js';

const router=Router();
const adminOnly=(req,_res,next)=>['country_admin','super_admin'].includes(req.user?.role)?next():next(new AppError('Administrator access required.',403,'FORBIDDEN'));
router.post('/admin/impersonation/stop', noStore, requireAuth, asyncHandler(async(req,res)=>{const prior=req.session.impersonation;const targetPublicId=req.user?.publicId||'';delete req.session.impersonation;await writeAudit(req,'admin.impersonation_stopped',{targetType:'user',targetPublicId,metadata:{approval:prior?.approvalPublicId||''}});res.redirect('/admin/impersonation');}));
router.use('/admin',noStore,requireAuth,requireVerified,requireOnboarding,adminOnly);
function countryScope(req,field='country'){return operationalCountryScope(req.user,field);}
function grantedCountries(req){return operationalCountriesFor(req.user).filter(code=>code!=='*');}
const ADMIN_PAGE_SIZE=50;
async function pagedQuery(Model,base,cursor,{field='createdAt',direction=-1,type='date',populate=[],select=''}={}){
  let query=Model.find(cursorScope(base,cursor,{field,direction,type})).sort(cursorSort(field,direction)).limit(ADMIN_PAGE_SIZE+1);
  if(select)query=query.select(select);
  for(const spec of populate)query=query.populate(...(Array.isArray(spec)?spec:[spec]));
  const [rows,total]=await Promise.all([query.lean(),Model.countDocuments(base)]);
  return pageResult(rows,{field,direction,type,limit:ADMIN_PAGE_SIZE,total});
}

function ensureCountry(req,country){
  let clean=String(country||'').trim().toUpperCase();
  if(req.user.role==='super_admin')return clean||String(req.user.country||'UG').toUpperCase();
  const grants=grantedCountries(req);
  if(!clean){if(grants.length!==1)throw new AppError('Choose an operational country for this action.',422,'COUNTRY_REQUIRED');clean=grants[0];}
  assertOperationalCountry(req.user,clean,'Country is outside your operational scope.');
  return clean;
}

router.get('/admin',asyncHandler(async(req,res)=>{
  const scope=countryScope(req);
  const sellerStores=req.user.role==='country_admin'?await (await import('../models/Store.js')).Store.find(countryScope(req)).select('_id').lean():null;
  const payoutAccountIds=req.user.role==='country_admin'?await PayoutAccount.find(countryScope(req)).distinct('_id'):null;
  const payoutQuery=payoutAccountIds?{payoutAccountId:{$in:payoutAccountIds},status:{$in:['requested','approved']}}:{status:{$in:['requested','approved']}};
  const [approvals,support,trust,payouts,products,sellers,promoters,incidents]=await Promise.all([
    ApprovalRequest.countDocuments({...scope,status:'requested'}),SupportTicket.countDocuments({...scope,status:{$nin:['resolved','closed']}}),TrustCase.countDocuments({...scope,status:{$nin:['resolved','dismissed']}}),Payout.countDocuments(payoutQuery),Product.countDocuments(req.user.role==='country_admin'?{...countryScope(req,'countries'),status:'submitted'}:{status:'submitted'}),SellerVerification.countDocuments(sellerStores?{storeId:{$in:sellerStores.map(x=>x._id)},status:{$in:['submitted','appealed']}}:{status:{$in:['submitted','appealed']}}),PromoterVerification.countDocuments({...scope,status:'submitted'}),Incident.countDocuments({...scope,status:{$ne:'resolved'}}),
  ]);
  const recentApprovals=await ApprovalRequest.find(scope).populate('requestedByUserId','name publicId').sort({createdAt:-1}).limit(12).lean();
  res.render('admin',{section:'attention',counts:{approvals,support,trust,payouts,products,sellers,promoters,incidents},recentApprovals});
}));


router.get('/admin/business',asyncHandler(async(req,res)=>{const base=req.user.role==='country_admin'?countryScope(req):{};const page=await pagedQuery(BusinessOrganization,base,req.query.after,{populate:[['ownerUserId','name email']]});res.render('admin',{section:'business',organizations:page.items,queuePage:page.page});}));
router.post('/admin/business/:id/request-terms',asyncHandler(async(req,res)=>{const org=await BusinessOrganization.findOne({publicId:req.params.id,...(req.user.role==='country_admin'?countryScope(req):{})});if(!org)throw new AppError('Business organization not found.',404,'BUSINESS_ORG_NOT_FOUND');const payload={approved:req.body.approved==='on',invoiceTermsDays:req.body.invoiceTermsDays,creditLimitMinor:req.body.creditLimitMinor};const approval=await createApproval({user:req.user,type:'business_credit_terms',country:org.country,targetType:'business_organization',targetPublicId:org.publicId,payload,reason:req.body.reason});await writeAudit(req,'admin.business_terms_requested',{targetType:'approval',targetPublicId:approval.publicId,country:org.country,metadata:{organization:org.publicId}});setFlash(req,'success','Business credit terms sent to approval centre.');res.redirect('/admin/business');}));

router.get('/admin/staff',asyncHandler(async(req,res)=>{const staffRoles=['warehouse','support','moderator','finance','country_admin'];const grants=grantedCountries(req);const candidateScope=req.user.role==='country_admin'?{country:{$in:grants},role:{$in:['customer',...staffRoles]},status:{$in:['active','suspended']}}:{role:{$in:['customer',...staffRoles]},status:{$in:['active','suspended']}};const warehouseScope=req.user.role==='country_admin'?{country:{$in:grants},active:true}:{active:true};const [grantPage,candidatePage,invitationPage,warehouses]=await Promise.all([platformGrantRowsForAdmin(req.user,{cursor:req.query.grantsAfter,limit:ADMIN_PAGE_SIZE}),pagedQuery(User,candidateScope,req.query.candidateAfter,{field:'name',direction:1,type:'string',select:'+operationalCountries publicId name email role status country emailVerifiedAt phoneVerifiedAt security.mfaEnabled platformAccessManagedAt'}),staffInvitationsForAdmin(req.user,{cursor:req.query.invitationsAfter,limit:ADMIN_PAGE_SIZE}),Warehouse.find(warehouseScope).select('publicId name country').sort({country:1,name:1}).lean()]);res.render('admin',{section:'staff',staffGrants:grantPage.items,candidates:candidatePage.items,invitations:invitationPage.items,staffRoles,warehouses,operationalCountries:grants,queuePages:{grants:grantPage.page,candidates:candidatePage.page,invitations:invitationPage.page}});}));
router.post('/admin/staff/invite',asyncHandler(async(req,res)=>{const input=z.object({email:z.string().trim().email().max(254),role:z.enum(['warehouse','support','moderator','finance','country_admin']),operationalCountries:z.string().trim().max(200).default(''),warehouseScopes:z.string().trim().max(1200).optional().default(''),grantDurationDays:z.coerce.number().int().min(1).max(365).default(180),reason:z.string().trim().min(3).max(1000)}).parse(req.body);const countries=[...new Set(input.operationalCountries.split(',').map(v=>v.trim().toUpperCase()).filter(Boolean))],warehouseScopes=[...new Set(input.warehouseScopes.split(',').map(v=>v.trim()).filter(Boolean))];const invitation=await createPlatformStaffInvitation(req,{email:input.email,role:input.role,operationalCountries:countries,warehouseScopes,grantDurationDays:input.grantDurationDays,reason:input.reason});await writeAudit(req,'admin.staff_invited',{targetType:'platform_staff_invitation',targetPublicId:invitation.publicId,country:invitation.approvalCountry,metadata:{emailMasked:invitation.emailMasked,role:invitation.role,countries:invitation.operationalCountries,warehouseScopes:invitation.warehouseScopes,grantDurationDays:invitation.grantDurationDays}});setFlash(req,'success','Secure staff invitation queued. Access remains inactive until identity verification, MFA and four-eyes approval are complete.');res.redirect('/admin/staff');}));
router.post('/admin/staff/invitations/:id/revoke',asyncHandler(async(req,res)=>{const invitation=await revokePlatformStaffInvitation(req,req.params.id);await writeAudit(req,'admin.staff_invitation_revoked',{targetType:'platform_staff_invitation',targetPublicId:invitation.publicId,country:invitation.approvalCountry});setFlash(req,'success','Staff invitation revoked.');res.redirect('/admin/staff');}));
router.post('/admin/staff/request',asyncHandler(async(req,res)=>{const input=z.object({targetUserPublicId:z.string().trim().min(4).max(120),action:z.enum(['grant','suspend','revoke']),role:z.enum(['warehouse','support','moderator','finance','country_admin']).optional(),operationalCountries:z.string().trim().max(200).optional().default(''),warehouseScopes:z.string().trim().max(1200).optional().default(''),grantDurationDays:z.coerce.number().int().min(1).max(365).default(180),reason:z.string().trim().min(3).max(1000)}).parse(req.body);const target=await User.findOne({publicId:input.targetUserPublicId}).select('+operationalCountries');if(!target)throw new AppError('Staff account not found.',404,'STAFF_ACCOUNT_NOT_FOUND');await hydratePlatformAuthorization(target);if(target.role==='super_admin')throw new AppError('Super Admin access cannot be changed here.',403,'SUPER_ADMIN_PROTECTED');const countries=[...new Set(input.operationalCountries.split(',').map(v=>v.trim().toUpperCase()).filter(Boolean))],warehouseScopes=[...new Set(input.warehouseScopes.split(',').map(v=>v.trim()).filter(Boolean))];if(req.user.role==='country_admin'){if(input.action==='grant'&&['finance','country_admin'].includes(input.role||''))throw new AppError('Only Super Admin can provision Finance or Country Admin.',403,'STAFF_ROLE_SCOPE');if(input.action==='grant'){if(!countries.length){const grants=grantedCountries(req);if(grants.length!==1)throw new AppError('Choose exactly one operational country for this staff grant.',422,'COUNTRY_REQUIRED');countries.push(grants[0]);}if(countries.length!==1)throw new AppError('Country Admin staff grants must target exactly one country.',403,'COUNTRY_SCOPE');assertOperationalCountry(req.user,countries[0]);}const targetCountry=String(target.country||'').toUpperCase();if(target.role!=='customer'&&!operationalCountriesFor(target).some(code=>grantedCountries(req).includes(code))&&!grantedCountries(req).includes(targetCountry))throw new AppError('Target staff account is outside your country scope.',403,'COUNTRY_SCOPE');}const approvalCountry=req.user.role==='country_admin'?(countries[0]||ensureCountry(req,target.country)):'';const approval=await createApproval({user:req.user,type:'platform_staff_access',country:approvalCountry,targetType:'user',targetPublicId:target.publicId,payload:{action:input.action,role:input.role||target.role,operationalCountries:countries,warehouseScopes,grantDurationDays:input.grantDurationDays},reason:input.reason});await writeAudit(req,'admin.staff_access_requested',{targetType:'approval',targetPublicId:approval.publicId,country:approval.country,metadata:{target:target.publicId,action:input.action,role:input.role||'',countries,warehouseScopes,grantDurationDays:input.grantDurationDays}});setFlash(req,'success','Staff access change sent to the approval centre.');res.redirect('/admin/staff');}));

router.get('/admin/countries',asyncHandler(async(req,res)=>{const countries=await CountrySetting.find(req.user.role==='country_admin'?{code:{$in:grantedCountries(req)}}:{}).sort({name:1}).lean();res.render('admin',{section:'countries',countries});}));
router.post('/admin/countries/:code/request-update',asyncHandler(async(req,res)=>{
  const country=ensureCountry(req,req.params.code);const setting=await CountrySetting.findOne({code:country});if(!setting)throw new AppError('Country not found.',404,'COUNTRY_NOT_FOUND');
  const payload={active:req.body.active==='on',taxBps:req.body.taxBps,platformFeeBps:req.body.platformFeeBps,freeStandardShippingThresholdMinor:req.body.freeStandardShippingThresholdMinor,returnWindowDays:req.body.returnWindowDays,card:req.body.card==='on',mobile:req.body.mobile==='on',cod:req.body.cod==='on',standardEnabled:req.body.standardEnabled==='on',expressEnabled:req.body.expressEnabled==='on',pickupEnabled:req.body.pickupEnabled==='on',defaultStandardSlaHours:req.body.defaultStandardSlaHours,defaultExpressSlaHours:req.body.defaultExpressSlaHours,requirePhotoForCod:req.body.requirePhotoForCod==='on',requireSignatureForDelivery:req.body.requireSignatureForDelivery==='on',requirePhotoForFailedAttempt:req.body.requirePhotoForFailedAttempt==='on',loyaltyEnabled:req.body.loyaltyEnabled==='on',referralEnabled:req.body.referralEnabled==='on',giftCardsEnabled:req.body.giftCardsEnabled==='on',loyaltyPointsPer1000Minor:req.body.loyaltyPointsPer1000Minor,referralRewardPoints:req.body.referralRewardPoints,promoterCommissionBps:req.body.promoterCommissionBps};
  const approval=await createApproval({user:req.user,type:'country_settings',country,targetType:'country',targetPublicId:country,payload,reason:req.body.reason});await writeAudit(req,'admin.country_change_requested',{targetType:'approval',targetPublicId:approval.publicId,country,metadata:{target:country}});setFlash(req,'success','Country configuration change sent to approval centre.');res.redirect('/admin/countries');
}));

router.get('/admin/features',asyncHandler(async(req,res)=>{const query=req.user.role==='country_admin'?countryScope(req,'countries'):{};const flags=await FeatureFlag.find(query).sort({key:1}).lean();res.render('admin',{section:'features',flags});}));
router.post('/admin/features/request',asyncHandler(async(req,res)=>{
  const countries=String(req.body.countries||'').split(',').map(v=>v.trim().toUpperCase()).filter(Boolean);if(req.user.role==='country_admin'){if(countries.length!==1)throw new AppError('Country Admin feature changes must target exactly one operational country.',403,'COUNTRY_SCOPE');assertOperationalCountry(req.user,countries[0]);}
  const roles=String(req.body.roles||'').split(',').map(v=>v.trim()).filter(Boolean);const payload={key:req.body.key,description:req.body.description,enabled:req.body.enabled==='on',countries,roles,rolloutPercentage:req.body.rolloutPercentage,startsAt:req.body.startsAt||null,endsAt:req.body.endsAt||null};const approval=await createApproval({user:req.user,type:'feature_flag',country:req.user.role==='country_admin'?countries[0]:'',targetType:'feature_flag',targetPublicId:String(req.body.key||''),payload,reason:req.body.reason});await writeAudit(req,'admin.feature_flag_requested',{targetType:'approval',targetPublicId:approval.publicId,metadata:{key:req.body.key}});setFlash(req,'success','Feature rollout change sent for approval.');res.redirect('/admin/features');
}));

router.get('/admin/cms',asyncHandler(async(req,res)=>{const content=await CmsContent.find(countryScope(req)).sort({updatedAt:-1}).lean();res.render('admin',{section:'cms',content});}));
router.post('/admin/cms/revision',asyncHandler(async(req,res)=>{const country=ensureCountry(req,req.body.country||'');const result=await createCmsRevision({user:req.user,key:req.body.key,type:req.body.type,country,title:req.body.title,body:req.body.body,data:{placement:String(req.body.placement||'')},reason:req.body.reason});await writeAudit(req,'cms.revision_created',{targetType:'cms',targetPublicId:result.content.publicId,country,metadata:{version:result.version}});setFlash(req,'success',`Draft revision v${result.version} saved.`);res.redirect('/admin/cms');}));
router.post('/admin/cms/:id/publish-request',asyncHandler(async(req,res)=>{const content=await CmsContent.findOne({publicId:req.params.id,...countryScope(req)});if(!content)throw new AppError('CMS content not found.',404,'CMS_NOT_FOUND');const version=Number(req.body.version);if(!content.revisions.some(row=>row.version===version))throw new AppError('Revision not found.',404,'CMS_REVISION_NOT_FOUND');const approval=await createApproval({user:req.user,type:'cms_publish',country:content.country,targetType:'cms',targetPublicId:content.publicId,payload:{version,scheduledFor:req.body.scheduledFor||null},reason:req.body.reason});await writeAudit(req,'cms.publish_requested',{targetType:'approval',targetPublicId:approval.publicId,country:content.country,metadata:{content:content.publicId,version}});setFlash(req,'success','CMS publication sent for approval.');res.redirect('/admin/cms');}));
router.post('/admin/cms/:id/rollback-request',asyncHandler(async(req,res)=>{const content=await CmsContent.findOne({publicId:req.params.id,...countryScope(req)});if(!content)throw new AppError('CMS content not found.',404,'CMS_NOT_FOUND');const version=Number(req.body.version);if(!content.revisions.some(row=>row.version===version))throw new AppError('Revision not found.',404,'CMS_REVISION_NOT_FOUND');const approval=await createApproval({user:req.user,type:'cms_rollback',country:content.country,targetType:'cms',targetPublicId:content.publicId,payload:{version},reason:req.body.reason});await writeAudit(req,'cms.rollback_requested',{targetType:'approval',targetPublicId:approval.publicId,country:content.country,metadata:{version}});setFlash(req,'success','Rollback sent for approval.');res.redirect('/admin/cms');}));

router.get('/admin/approvals',asyncHandler(async(req,res)=>{const page=await pagedQuery(ApprovalRequest,countryScope(req),req.query.after,{populate:[['requestedByUserId','name publicId role country'],['decidedByUserId','name publicId']]});res.render('admin',{section:'approvals',approvals:page.items,queuePage:page.page});}));
router.post('/admin/approvals/:id/approve',asyncHandler(async(req,res)=>{const approval=await ApprovalRequest.findOne({publicId:req.params.id,...countryScope(req)});if(!approval)throw new AppError('Approval request not found.',404,'APPROVAL_NOT_FOUND');const result=await applyApproval(approval,req.user);await writeAudit(req,'admin.approval_applied',{targetType:'approval',targetPublicId:approval.publicId,country:approval.country,metadata:{type:approval.type,result}});setFlash(req,'success','Approved and applied.');res.redirect('/admin/approvals');}));
router.post('/admin/approvals/:id/reject',asyncHandler(async(req,res)=>{const approval=await ApprovalRequest.findOne({publicId:req.params.id,status:'requested',...countryScope(req)});if(!approval)throw new AppError('Approval request not found.',404,'APPROVAL_NOT_FOUND');if(approval.requestedByUserId.equals(req.user._id))throw new AppError('A different administrator must reject this request.',403,'FOUR_EYES_REQUIRED');approval.status='rejected';approval.decidedByUserId=req.user._id;approval.decidedAt=new Date();approval.decisionReason=String(req.body.reason||'').trim();if(approval.decisionReason.length<3)throw new AppError('Rejection reason is required.',422,'REASON_REQUIRED');await approval.save();await writeAudit(req,'admin.approval_rejected',{targetType:'approval',targetPublicId:approval.publicId,country:approval.country,metadata:{reason:approval.decisionReason}});setFlash(req,'success','Approval request rejected.');res.redirect('/admin/approvals');}));

router.get('/admin/growth',asyncHandler(async(req,res)=>{const scope=countryScope(req);const [cardsPage,campaignsPage,referralsPage,loyaltyPage]=await Promise.all([
  pagedQuery(GiftCard,scope,req.query.cardsAfter),
  pagedQuery(MarketingCampaign,scope,req.query.campaignsAfter),
  pagedQuery(Referral,scope,req.query.referralsAfter,{populate:[['referrerUserId','name publicId'],['referredUserId','name publicId']]}),
  pagedQuery(LoyaltyAccount,scope,req.query.loyaltyAfter,{field:'points',direction:-1,type:'number',populate:[['userId','name publicId']]}),
]);res.render('admin',{section:'growth',cards:cardsPage.items,campaigns:campaignsPage.items,referrals:referralsPage.items,loyalty:loyaltyPage.items,queuePages:{cards:cardsPage.page,campaigns:campaignsPage.page,referrals:referralsPage.page,loyalty:loyaltyPage.page}});}));
router.post('/admin/growth/gift-cards/request',asyncHandler(async(req,res)=>{const country=ensureCountry(req,req.body.country);const approval=await createApproval({user:req.user,type:'gift_card_issue',country,targetType:'gift_card',payload:{valueMinor:req.body.valueMinor,expiresAt:req.body.expiresAt||null,note:req.body.note},reason:req.body.reason});await writeAudit(req,'growth.gift_card_requested',{targetType:'approval',targetPublicId:approval.publicId,country});setFlash(req,'success','Gift card issuance sent for approval.');res.redirect('/admin/growth');}));
router.get('/admin/growth/gift-cards/:id',asyncHandler(async(req,res)=>{const card=await revealGiftCard(req.params.id,req.user);await writeAudit(req,'growth.gift_card_revealed',{targetType:'gift_card',targetPublicId:card.publicId,country:card.country,metadata:{last4:card.codeLast4}});res.set('Cache-Control','private, no-store').render('admin',{section:'gift-card-detail',card});}));
router.post('/admin/growth/campaigns',asyncHandler(async(req,res)=>{const country=ensureCountry(req,req.body.country||'');const scheduledAt=req.body.scheduledAt?new Date(req.body.scheduledAt):null;const campaign=await MarketingCampaign.create({publicId:publicId('mkt'),name:String(req.body.name||'').trim(),country,subject:String(req.body.subject||'').trim(),body:String(req.body.body||''),roles:String(req.body.roles||'').split(',').map(v=>v.trim()).filter(Boolean),scheduledAt,status:scheduledAt&&scheduledAt>new Date()?'scheduled':'draft',createdByUserId:req.user._id});await writeAudit(req,'growth.campaign_created',{targetType:'marketing_campaign',targetPublicId:campaign.publicId,country,metadata:{scheduledAt:scheduledAt?.toISOString()||''}});setFlash(req,'success',campaign.status==='scheduled'?'Consent-aware campaign scheduled.':'Consent-aware campaign saved.');res.redirect('/admin/growth');}));
router.post('/admin/growth/campaigns/:id/queue',asyncHandler(async(req,res)=>{const campaign=await MarketingCampaign.findOne({publicId:req.params.id,...countryScope(req)});if(!campaign)throw new AppError('Campaign not found.',404,'CAMPAIGN_NOT_FOUND');await queueConsentCampaign(campaign,req.user);await writeAudit(req,'growth.campaign_queued',{targetType:'marketing_campaign',targetPublicId:campaign.publicId,country:campaign.country,metadata:{eligible:campaign.eligibleCount,queued:campaign.queuedCount}});setFlash(req,'success',`Campaign queued for ${campaign.queuedCount} consented account(s).`);res.redirect('/admin/growth');}));

router.get('/admin/reports',asyncHandler(async(req,res)=>{const country=String(req.query.country||'').trim().toUpperCase();const report=await platformReport(req.user,{country});res.render('admin',{section:'reports',report,reportCountries:grantedCountries(req)});}));

router.get('/admin/exports',asyncHandler(async(req,res)=>{const page=await pagedQuery(DataExport,countryScope(req),req.query.after,{populate:[['requestedByUserId','name publicId']]});res.render('admin',{section:'exports',exports:page.items,queuePage:page.page});}));
router.post('/admin/exports/request',asyncHandler(async(req,res)=>{const type=z.enum(['orders','sellers','promoters','support','audit']).parse(req.body.type);const country=ensureCountry(req,req.body.country||'');const exp=await DataExport.create({publicId:publicId('exp'),type,country,requestedByUserId:req.user._id,reason:String(req.body.reason||'').trim()});const approval=await createApproval({user:req.user,type:'data_export',country,targetType:'data_export',targetPublicId:exp.publicId,payload:{exportPublicId:exp.publicId},reason:exp.reason});await writeAudit(req,'admin.export_requested',{targetType:'approval',targetPublicId:approval.publicId,country,metadata:{export:exp.publicId,type}});setFlash(req,'success','Privacy-controlled export sent for approval.');res.redirect('/admin/exports');}));
router.get('/admin/exports/:id/download',asyncHandler(async(req,res)=>{const exp=await DataExport.findOne({publicId:req.params.id,...countryScope(req)}).select('+storageKey');if(!exp)throw new AppError('Export not found.',404,'EXPORT_NOT_FOUND');const file=await exportPath(exp);await writeAudit(req,'admin.export_downloaded',{targetType:'data_export',targetPublicId:exp.publicId,country:exp.country,metadata:{type:exp.type,rowCount:exp.rowCount}});res.set('Cache-Control','private, no-store').download(file,`classic-mart-${exp.type}-${exp.publicId}.csv`);}));

router.get('/admin/privacy',asyncHandler(async(req,res)=>{const page=await pagedQuery(PrivacyRequest,countryScope(req),req.query.after,{populate:[['userId','publicId name email role status'],['processedByUserId','publicId name']]});res.render('admin',{section:'privacy',privacyRequests:page.items,queuePage:page.page});}));
router.post('/admin/privacy/:id/hold',asyncHandler(async(req,res)=>{const doc=await PrivacyRequest.findOne({publicId:req.params.id,...countryScope(req)});if(!doc)throw new AppError('Privacy request not found.',404,'PRIVACY_REQUEST_NOT_FOUND');const active=req.body.active==='true'||req.body.active==='on';const reason=String(req.body.reason||'').trim();if(active&&reason.length<3)throw new AppError('Legal-hold reason is required.',422,'PRIVACY_HOLD_REASON');await setPrivacyLegalHold(doc,req.user,{active,reason});await writeAudit(req,'privacy.legal_hold_changed',{targetType:'privacy_request',targetPublicId:doc.publicId,country:doc.country,metadata:{active,reason}});setFlash(req,'success',active?'Legal hold applied.':'Legal hold released.');res.redirect('/admin/privacy');}));
router.post('/admin/privacy/:id/approve',asyncHandler(async(req,res)=>{const doc=await PrivacyRequest.findOne({publicId:req.params.id,...countryScope(req)});if(!doc)throw new AppError('Privacy request not found.',404,'PRIVACY_REQUEST_NOT_FOUND');const decision=String(req.body.decision||'Approved after review.').trim();await approvePrivacyRequest(doc,req.user,decision);await writeAudit(req,'privacy.request_approved',{targetType:'privacy_request',targetPublicId:doc.publicId,country:doc.country,metadata:{type:doc.type}});setFlash(req,'success',doc.type==='deletion'?'Deletion approved and queued for obligation checks.':'Privacy request completed.');res.redirect('/admin/privacy');}));
router.post('/admin/privacy/:id/reject',asyncHandler(async(req,res)=>{const doc=await PrivacyRequest.findOne({publicId:req.params.id,status:{$in:['requested','blocked']},...countryScope(req)});if(!doc)throw new AppError('Privacy request not found.',404,'PRIVACY_REQUEST_NOT_FOUND');const reason=String(req.body.reason||'').trim();if(reason.length<3)throw new AppError('Rejection reason is required.',422,'REASON_REQUIRED');doc.status='rejected';doc.decision=reason;doc.processedByUserId=req.user._id;doc.completedAt=new Date();await doc.save();await writeAudit(req,'privacy.request_rejected',{targetType:'privacy_request',targetPublicId:doc.publicId,country:doc.country,metadata:{reason}});setFlash(req,'success','Privacy request rejected with a recorded reason.');res.redirect('/admin/privacy');}));

router.get('/admin/incidents',asyncHandler(async(req,res)=>{const page=await pagedQuery(Incident,countryScope(req),req.query.after,{populate:[['ownerUserId','name publicId']]});res.render('admin',{section:'incidents',incidents:page.items,queuePage:page.page});}));
router.post('/admin/incidents',asyncHandler(async(req,res)=>{const country=ensureCountry(req,req.body.country||'');const incident=await Incident.create({publicId:publicId('inc'),country,severity:z.enum(['sev1','sev2','sev3','sev4']).parse(req.body.severity),title:String(req.body.title||'').trim(),summary:String(req.body.summary||'').trim(),ownerUserId:req.user._id,timeline:[{type:'incident.opened',message:String(req.body.summary||'').trim(),actorUserId:req.user._id}]});await writeAudit(req,'incident.opened',{targetType:'incident',targetPublicId:incident.publicId,country});setFlash(req,'success','Incident opened.');res.redirect('/admin/incidents');}));
router.post('/admin/incidents/:id/update',asyncHandler(async(req,res)=>{const incident=await Incident.findOne({publicId:req.params.id,...countryScope(req)});if(!incident)throw new AppError('Incident not found.',404,'INCIDENT_NOT_FOUND');const status=z.enum(['open','investigating','monitoring','resolved']).parse(req.body.status);const message=String(req.body.message||'').trim();if(message.length<3)throw new AppError('Incident update is required.',422,'INCIDENT_UPDATE_REQUIRED');incident.status=status;if(status==='resolved')incident.resolvedAt=new Date();incident.timeline.push({type:`incident.${status}`,message,actorUserId:req.user._id});await incident.save();await writeAudit(req,'incident.updated',{targetType:'incident',targetPublicId:incident.publicId,country:incident.country,metadata:{status}});setFlash(req,'success','Incident timeline updated.');res.redirect('/admin/incidents');}));


router.get('/admin/health',asyncHandler(async(req,res)=>{
  const scope=countryScope(req),globalAllowed=req.user.role==='super_admin',now=new Date();
  const paymentScope=globalAllowed?{}:scope;
  const providerScope=globalAllowed?{provider:'pesapal'}:{provider:'pesapal',...scope};
  let payoutScope={status:'unknown'};
  if(!globalAllowed){const payoutAccountIds=await PayoutAccount.find(scope).distinct('_id');payoutScope={payoutAccountId:{$in:payoutAccountIds},status:'unknown'};}
  const alertScope=globalAllowed?{}:{country:{$in:grantedCountries(req)}};
  const activeAlertScope={...alertScope,status:{$in:['open','acknowledged','investigating']}};
  const [paymentsFailed,reconciliationFailed,outboxPending,providerExceptionCount,payoutUnknown,supportOverdue,deliveryExceptions,highRiskAlerts,metricSnapshot,alertPage]=await Promise.all([
    PaymentIntent.countDocuments({...paymentScope,status:'failed'}),
    ReconciliationRun.countDocuments({...scope,status:'failed'}),
    globalAllowed?OutboxEvent.countDocuments({status:{$in:['pending','failed']}}):Promise.resolve(null),
    ProviderEvent.countDocuments({...providerScope,$or:[{status:{$in:['failed','dead']}},{orderPublicId:''}]}),
    Payout.countDocuments(payoutScope),
    SupportTicket.countDocuments({...scope,status:{$nin:['resolved','closed']},slaDueAt:{$lt:now}}),
    Shipment.countDocuments({...scope,status:{$in:['failed','rescheduled','return_to_sender']}}),
    OperationalAlert.countDocuments({...activeAlertScope,severity:{$in:['high','critical']}}),
    globalAllowed?operationalMetricSnapshot():Promise.resolve(null),
    pagedQuery(OperationalAlert,activeAlertScope,req.query.after,{field:'lastSeenAt',direction:-1,populate:[['acknowledgedByUserId resolvedByUserId','name publicId']]}),
  ]);
  const workers=globalAllowed?await WorkerHeartbeat.find({expiresAt:{$gt:now}}).sort({lastHeartbeatAt:-1}).lean():[];
  const health={
    mongo:{readyState:mongoose.connection.readyState,host:mongoose.connection.host||'',database:mongoose.connection.name||''},
    queues:{outboxPending,restricted:!globalAllowed},
    providers:{providerExceptions:providerExceptionCount,paymentsFailed},
    payouts:{unknown:payoutUnknown},
    support:{overdue:supportOverdue},
    delivery:{exceptions:deliveryExceptions},
    risk:{high:highRiskAlerts},
    reconciliation:{failed:reconciliationFailed},
    metrics:metricSnapshot,
    workers:{restricted:!globalAllowed,active:workers.length,items:workers},
    checkedAt:now,
  };
  res.render('admin',{section:'health',health,alerts:alertPage.items,queuePage:alertPage.page});
}));
router.post('/admin/health/alerts/:id/status',asyncHandler(async(req,res)=>{const status=z.enum(['acknowledged','investigating','resolved','suppressed']).parse(req.body.status);const scope=req.user.role==='super_admin'?{}:{country:{$in:grantedCountries(req)}};const alert=await OperationalAlert.findOne({publicId:req.params.id,...scope});if(!alert)throw new AppError('Operational alert not found.',404,'OPERATIONAL_ALERT_NOT_FOUND');const note=String(req.body.note||'').trim();if(['resolved','suppressed'].includes(status)&&note.length<3)throw new AppError('A resolution/suppression note is required.',422,'ALERT_NOTE_REQUIRED');alert.status=status;if(['acknowledged','investigating'].includes(status)){alert.acknowledgedByUserId=req.user._id;alert.acknowledgedAt=new Date();}if(status==='resolved'){alert.resolvedByUserId=req.user._id;alert.resolvedAt=new Date();alert.resolutionNote=note;}if(status==='suppressed')alert.resolutionNote=note;await alert.save();await writeAudit(req,'operations.alert_status_changed',{targetType:'operational_alert',targetPublicId:alert.publicId,country:alert.country,metadata:{status,note}});setFlash(req,'success','Operational alert updated.');res.redirect('/admin/health');}));

router.get('/admin/impersonation',asyncHandler(async(req,res)=>{const userScope=req.user.role==='country_admin'?{...countryScope(req),role:{$nin:['super_admin']}}:{role:{$nin:['super_admin']}};const approvalScope={...countryScope(req),type:'impersonation'};const [userPage,approvalPage]=await Promise.all([pagedQuery(User,userScope,req.query.usersAfter,{field:'name',direction:1,type:'string',select:'publicId name role country status'}),pagedQuery(ApprovalRequest,approvalScope,req.query.approvalsAfter,{populate:[['requestedByUserId','name publicId']]})]);res.render('admin',{section:'impersonation',users:userPage.items,approvals:approvalPage.items,queuePages:{users:userPage.page,approvals:approvalPage.page}});}));
router.post('/admin/impersonation/request',asyncHandler(async(req,res)=>{const target=await User.findOne({publicId:String(req.body.targetUserPublicId||'')}).lean();if(!target)throw new AppError('Target account not found.',404,'USER_NOT_FOUND');ensureCountry(req,target.country);if(target.role==='super_admin')throw new AppError('Super Admin accounts cannot be impersonated.',403,'IMPERSONATION_FORBIDDEN');const approval=await createApproval({user:req.user,type:'impersonation',country:target.country,targetType:'user',targetPublicId:target.publicId,payload:{targetUserPublicId:target.publicId},reason:req.body.reason});await writeAudit(req,'admin.impersonation_requested',{targetType:'approval',targetPublicId:approval.publicId,country:target.country,metadata:{target:target.publicId}});setFlash(req,'success','Read-only impersonation sent for approval.');res.redirect('/admin/impersonation');}));
router.post('/admin/impersonation/start',asyncHandler(async(req,res)=>{
  const approval=await ApprovalRequest.findOne({publicId:String(req.body.approvalId||''),type:'impersonation',status:'applied'});
  if(!approval)throw new AppError('Approved impersonation request not found.',404,'APPROVAL_NOT_FOUND');
  if(!approval.appliedAt||Date.now()-new Date(approval.appliedAt).getTime()>30*60_000)throw new AppError('Impersonation approval has expired. Request a new approval.',409,'IMPERSONATION_APPROVAL_EXPIRED');
  if(approval.consumedAt)throw new AppError('Impersonation approval has already been used.',409,'IMPERSONATION_APPROVAL_USED');
  if(!approval.requestedByUserId.equals(req.user._id)&&req.user.role!=='super_admin')throw new AppError('Only the requester or Super Admin can use this approval.',403,'IMPERSONATION_SCOPE');
  const target=await User.findOne({publicId:approval.payload.targetUserPublicId,status:'active'});
  if(!target)throw new AppError('Target account is unavailable.',404,'USER_NOT_FOUND');
  ensureCountry(req,target.country);
  const consumed=await ApprovalRequest.findOneAndUpdate({_id:approval._id,consumedAt:null},{$set:{consumedAt:new Date()}},{returnDocument:'after'});
  if(!consumed)throw new AppError('Impersonation approval has already been used.',409,'IMPERSONATION_APPROVAL_USED');
  req.session.impersonation={targetUserId:String(target._id),approvalPublicId:approval.publicId,startedAt:Date.now()};
  await writeAudit(req,'admin.impersonation_started',{targetType:'user',targetPublicId:target.publicId,country:target.country,metadata:{approval:approval.publicId,readOnly:true,maxMinutes:30}});
  res.redirect('/dashboard');
}));


router.get('/admin/security',asyncHandler(async(req,res)=>{
  const scope=countryScope(req); await ensureLaunchEvidence();
  const eventScope=req.user.role==='country_admin'?countryScope(req):{};
  const blockScope={revokedAt:null,expiresAt:{$gt:new Date()}};
  const recoveryScope=req.user.role==='country_admin'?countryScope(req):{};
  const privilegedScope=req.user.role==='country_admin'?{...countryScope(req),role:{$in:[...PRIVILEGED_MFA_ROLES]}}:{role:{$in:[...PRIVILEGED_MFA_ROLES]}};
  const [eventsPage,blocksPage,findingsPage,evidence,recoveryPage,siemCounts,privilegedPage]=await Promise.all([
    pagedQuery(SecurityEvent,eventScope,req.query.eventsAfter,{field:'occurredAt',direction:-1,select:'+integrity +ipHash +userAgentHash'}),
    req.user.role==='super_admin'?pagedQuery(IpBlock,blockScope,req.query.blocksAfter,{select:'+ipHash'}):Promise.resolve({items:[],page:{hasMore:false,next:'',count:0,total:0}}),
    pagedQuery(SecurityFinding,scope,req.query.findingsAfter,{populate:[['ownerUserId riskRequestedByUserId riskApprovedByUserId','name publicId']]}),
    LaunchEvidence.find({}).populate('verifiedByUserId','name publicId').sort({key:1}).lean(),
    pagedQuery(MfaRecoveryRequest,recoveryScope,req.query.recoveryAfter,{populate:[['targetUserId requestedByUserId decidedByUserId','name publicId role country security.mfaEnabled']]}),
    SecurityEvent.aggregate([{$group:{_id:'$siemStatus',count:{$sum:1}}}]),
    pagedQuery(User,privilegedScope,req.query.privilegedAfter,{field:'name',direction:1,type:'string',select:'publicId name role country security.mfaEnabled'}),
  ]);
  const events=eventsPage.items.map(event=>({...event,integrityOk:verifySecurityEventIntegrity(event),ipHashShort:String(event.ipHash||'').slice(0,16)}));
  res.render('admin',{section:'security',events,blocks:blocksPage.items,findings:findingsPage.items,evidence,recoveryRequests:recoveryPage.items,privilegedUsers:privilegedPage.items,queuePages:{events:eventsPage.page,blocks:blocksPage.page,findings:findingsPage.page,recovery:recoveryPage.page,privileged:privilegedPage.page},siemCounts:Object.fromEntries(siemCounts.map(x=>[x._id,x.count])),securityConfig:{ids:env.security.idsEnabled,ips:env.security.ipsEnabled,siemMode:env.security.siem.mode,siemFormat:env.security.siem.format,mfaRequired:env.security.privilegedMfaRequired,launchCountries:env.security.launchCountries},recoveryPolicy:env.disasterRecovery});
}));

router.post('/admin/security/blocks/:id/revoke',asyncHandler(async(req,res)=>{
  if(req.user.role!=='super_admin')throw new AppError('Only Super Admin can revoke global IPS blocks.',403,'FORBIDDEN');
  const block=await IpBlock.findOne({publicId:req.params.id,revokedAt:null}).select('+ipHash');
  if(!block)throw new AppError('IP block not found.',404,'IP_BLOCK_NOT_FOUND');
  block.revokedAt=new Date();block.revokedByUserId=req.user._id;await block.save();
  invalidateIpBlockCache(block.ipHash);
  await writeAudit(req,'security.ip_block_revoked',{targetType:'ip_block',targetPublicId:block.publicId,metadata:{reason:block.reason}});
  await writeSecurityEvent(req,'ips.block_revoked',{category:'operations',severity:'medium',result:'success',metadata:{blockPublicId:block.publicId}});
  setFlash(req,'success','The IPS block was revoked.');res.redirect('/admin/security');
}));

router.post('/admin/security/findings',asyncHandler(async(req,res)=>{
  const country=ensureCountry(req,req.body.country||'');
  const severity=z.enum(['low','medium','high','critical']).parse(req.body.severity);
  const title=String(req.body.title||'').trim();const details=String(req.body.details||'').trim();
  if(title.length<3||details.length<3)throw new AppError('Finding title and details are required.',422,'SECURITY_FINDING_INVALID');
  const finding=await SecurityFinding.create({publicId:publicId('fnd'),country,severity,title,details,ownerUserId:req.user._id});
  await writeAudit(req,'security.finding_created',{targetType:'security_finding',targetPublicId:finding.publicId,country,metadata:{severity}});
  setFlash(req,'success','Security finding recorded.');res.redirect('/admin/security');
}));

router.post('/admin/security/findings/:id/remediate',asyncHandler(async(req,res)=>{
  const finding=await SecurityFinding.findOne({publicId:req.params.id,...countryScope(req)});
  if(!finding)throw new AppError('Security finding not found.',404,'SECURITY_FINDING_NOT_FOUND');
  const remediation=String(req.body.remediation||'').trim();if(remediation.length<3)throw new AppError('Describe the remediation evidence.',422,'REMEDIATION_REQUIRED');
  finding.status='remediated';finding.remediation=remediation;finding.remediatedAt=new Date();finding.ownerUserId=req.user._id;await finding.save();
  await writeAudit(req,'security.finding_remediated',{targetType:'security_finding',targetPublicId:finding.publicId,country:finding.country,metadata:{severity:finding.severity}});
  setFlash(req,'success','Finding marked remediated with evidence.');res.redirect('/admin/security');
}));

router.post('/admin/security/findings/:id/request-risk',asyncHandler(async(req,res)=>{
  const finding=await SecurityFinding.findOne({publicId:req.params.id,...countryScope(req)});
  if(!finding)throw new AppError('Security finding not found.',404,'SECURITY_FINDING_NOT_FOUND');
  if(!['high','critical'].includes(finding.severity))throw new AppError('Formal four-eyes risk acceptance is reserved for high/critical findings.',409,'RISK_ACCEPTANCE_NOT_REQUIRED');
  const reason=String(req.body.reason||'').trim();if(reason.length<10)throw new AppError('Provide a concrete risk-acceptance reason.',422,'RISK_REASON_REQUIRED');
  finding.status='acceptance_requested';finding.riskReason=reason;finding.riskRequestedByUserId=req.user._id;finding.riskRequestedAt=new Date();finding.riskApprovedByUserId=undefined;finding.riskApprovedAt=undefined;await finding.save();
  await writeAudit(req,'security.risk_acceptance_requested',{targetType:'security_finding',targetPublicId:finding.publicId,country:finding.country});
  setFlash(req,'success','Risk acceptance requires approval by a different administrator.');res.redirect('/admin/security');
}));

router.post('/admin/security/findings/:id/approve-risk',asyncHandler(async(req,res)=>{
  const finding=await SecurityFinding.findOne({publicId:req.params.id,...countryScope(req)});
  if(!finding||finding.status!=='acceptance_requested')throw new AppError('Pending risk-acceptance request not found.',404,'RISK_ACCEPTANCE_NOT_FOUND');
  if(String(finding.riskRequestedByUserId)===String(req.user._id))throw new AppError('A different administrator must approve risk acceptance.',403,'FOUR_EYES_REQUIRED');
  finding.status='risk_accepted';finding.riskApprovedByUserId=req.user._id;finding.riskApprovedAt=new Date();await finding.save();
  await writeAudit(req,'security.risk_accepted',{targetType:'security_finding',targetPublicId:finding.publicId,country:finding.country,metadata:{severity:finding.severity}});
  await writeSecurityEvent(req,'security.risk_accepted',{category:'operations',severity:finding.severity==='critical'?'critical':'high',result:'success',metadata:{findingPublicId:finding.publicId}});
  setFlash(req,'success','Risk acceptance approved under four-eyes control.');res.redirect('/admin/security');
}));

router.post('/admin/security/evidence/:key',asyncHandler(async(req,res)=>{
  if(req.user.role!=='super_admin')throw new AppError('Only Super Admin can sign global launch evidence.',403,'FORBIDDEN');
  const status=z.enum(['missing','passed','failed','not_applicable']).parse(req.body.status);
  const evidence=String(req.body.evidence||'').trim();
  if(['passed','not_applicable'].includes(status)&&evidence.length<3)throw new AppError('Evidence or justification is required.',422,'LAUNCH_EVIDENCE_REQUIRED');
  const key=String(req.params.key||'');
  const verifiedAt=new Date();
  const update={status,evidence,verifiedByUserId:req.user._id,verifiedAt};
  if(RECOVERY_EVIDENCE_KEYS.has(key)&&status==='passed'){
    const numberOrUndefined=(value)=>String(value??'').trim()===''?undefined:Number(value);
    const rpoMinutes=numberOrUndefined(req.body.rpoMinutes),rtoMinutes=numberOrUndefined(req.body.rtoMinutes);
    if(rpoMinutes!==undefined&&(!Number.isFinite(rpoMinutes)||rpoMinutes<0))throw new AppError('Measured RPO must be zero or a positive number of minutes.',422,'DR_RPO_INVALID');
    if(rtoMinutes!==undefined&&(!Number.isFinite(rtoMinutes)||rtoMinutes<0))throw new AppError('Measured RTO must be zero or a positive number of minutes.',422,'DR_RTO_INVALID');
    if(key==='pitr'&&rpoMinutes===undefined)throw new AppError('Measured RPO is required for PITR evidence.',422,'DR_RPO_REQUIRED');
    if(['backup-restore','rollback'].includes(key)&&rtoMinutes===undefined)throw new AppError('Measured RTO is required for restore/rollback evidence.',422,'DR_RTO_REQUIRED');
    const sourceSnapshotAt=req.body.sourceSnapshotAt?new Date(req.body.sourceSnapshotAt):undefined;
    const restoredAt=req.body.restoredAt?new Date(req.body.restoredAt):undefined;
    if(key==='backup-restore'&&(!sourceSnapshotAt||Number.isNaN(sourceSnapshotAt.getTime())||!restoredAt||Number.isNaN(restoredAt.getTime())))throw new AppError('Backup restore evidence requires valid snapshot and restore timestamps.',422,'DR_TIMESTAMPS_REQUIRED');
    update.recoveryMetrics={rpoMinutes,rtoMinutes,sourceSnapshotAt,restoredAt,drillId:String(req.body.drillId||'').trim(),provider:String(req.body.provider||'').trim(),scope:String(req.body.scope||'').trim()};
    update.validUntil=new Date(verifiedAt.getTime()+env.disasterRecovery.evidenceMaxAgeDays*86_400_000);
  }else if(RECOVERY_EVIDENCE_KEYS.has(key)){
    update.recoveryMetrics=undefined;update.validUntil=undefined;
  }
  const item=await LaunchEvidence.findOneAndUpdate({key},{$set:update},{returnDocument:'after'});
  if(!item)throw new AppError('Launch evidence item not found.',404,'LAUNCH_EVIDENCE_NOT_FOUND');
  await writeAudit(req,'security.launch_evidence_updated',{targetType:'launch_evidence',targetPublicId:item.key,metadata:{status,recoveryMetrics:RECOVERY_EVIDENCE_KEYS.has(key)?update.recoveryMetrics||{}:{}}});
  setFlash(req,'success','Launch evidence updated.');res.redirect('/admin/security');
}));

router.post('/admin/security/mfa-recovery',asyncHandler(async(req,res)=>{
  const target=await User.findOne({publicId:String(req.body.targetPublicId||'')});
  if(!target||!target.security?.mfaEnabled)throw new AppError('Target account does not have active MFA.',404,'MFA_TARGET_NOT_FOUND');
  if(!PRIVILEGED_MFA_ROLES.has(target.role))throw new AppError('Administrative MFA recovery is limited to privileged operational accounts.',403,'MFA_RECOVERY_TARGET_FORBIDDEN');
  ensureCountry(req,target.country);
  if(String(target._id)===String(req.user._id))throw new AppError('You cannot request administrative MFA recovery for yourself.',403,'MFA_SELF_RECOVERY_FORBIDDEN');
  const reason=String(req.body.reason||'').trim();if(reason.length<10)throw new AppError('Provide the recovery reason and verification context.',422,'MFA_RECOVERY_REASON_REQUIRED');
  const recovery=await MfaRecoveryRequest.create({publicId:publicId('mfr'),targetUserId:target._id,targetPublicId:target.publicId,country:target.country,reason,requestedByUserId:req.user._id,expiresAt:new Date(Date.now()+30*60_000)});
  await writeAudit(req,'security.mfa_recovery_requested',{targetType:'mfa_recovery',targetPublicId:recovery.publicId,country:target.country,metadata:{target:target.publicId}});
  await writeSecurityEvent(req,'mfa.admin_recovery_requested',{category:'mfa',severity:'high',result:'detected',country:target.country,metadata:{requestPublicId:recovery.publicId,target:target.publicId}});
  setFlash(req,'success','MFA recovery request created. A different administrator must approve it within 30 minutes.');res.redirect('/admin/security');
}));

router.post('/admin/security/mfa-recovery/:id/approve',asyncHandler(async(req,res)=>{
  const decisionReason=String(req.body.decisionReason||'').trim();if(decisionReason.length<3)throw new AppError('Approval reason is required.',422,'DECISION_REASON_REQUIRED');
  let applied;
  await mongoose.connection.transaction(async(session)=>{
    const recovery=await MfaRecoveryRequest.findOne({publicId:req.params.id,status:'requested'}).session(session).populate('targetUserId');
    if(!recovery||!recovery.targetUserId)throw new AppError('MFA recovery request not found.',404,'MFA_RECOVERY_NOT_FOUND');
    ensureCountry(req,recovery.country);
    if(recovery.expiresAt<=new Date()){recovery.status='expired';await recovery.save({session});throw new AppError('MFA recovery request expired.',409,'MFA_RECOVERY_EXPIRED');}
    if(String(recovery.requestedByUserId)===String(req.user._id)||String(recovery.targetUserId._id)===String(req.user._id))throw new AppError('A different administrator who is not the target must approve MFA recovery.',403,'FOUR_EYES_REQUIRED');
    if(recovery.targetUserId.role==='super_admin'&&req.user.role!=='super_admin')throw new AppError('Only a Super Admin can approve recovery for another Super Admin.',403,'FORBIDDEN');
    recovery.status='approved';recovery.decidedByUserId=req.user._id;recovery.decisionReason=decisionReason;recovery.decidedAt=new Date();
    await clearMfa(recovery.targetUserId,'admin_mfa_recovery','',session);
    recovery.status='applied';recovery.appliedAt=new Date();await recovery.save({session});
    applied={publicId:recovery.publicId,targetPublicId:recovery.targetPublicId,country:recovery.country};
  });
  await writeAudit(req,'security.mfa_recovery_applied',{targetType:'user',targetPublicId:applied.targetPublicId,country:applied.country,metadata:{request:applied.publicId}});
  await writeSecurityEvent(req,'mfa.admin_recovery_applied',{category:'mfa',severity:'critical',result:'success',country:applied.country,metadata:{requestPublicId:applied.publicId,target:applied.targetPublicId}});
  setFlash(req,'success','MFA was reset atomically, all target sessions were revoked, and the account must enroll again when required.');res.redirect('/admin/security');
}));

router.post('/admin/security/mfa-recovery/:id/reject',asyncHandler(async(req,res)=>{
  const recovery=await MfaRecoveryRequest.findOne({publicId:req.params.id,status:'requested'});
  if(!recovery)throw new AppError('MFA recovery request not found.',404,'MFA_RECOVERY_NOT_FOUND');ensureCountry(req,recovery.country);
  if(String(recovery.requestedByUserId)===String(req.user._id))throw new AppError('A different administrator must decide this request.',403,'FOUR_EYES_REQUIRED');
  recovery.status='rejected';recovery.decidedByUserId=req.user._id;recovery.decisionReason=String(req.body.decisionReason||'Rejected by reviewer').slice(0,1000);recovery.decidedAt=new Date();await recovery.save();
  await writeAudit(req,'security.mfa_recovery_rejected',{targetType:'mfa_recovery',targetPublicId:recovery.publicId,country:recovery.country});setFlash(req,'success','MFA recovery request rejected.');res.redirect('/admin/security');
}));

export default router;

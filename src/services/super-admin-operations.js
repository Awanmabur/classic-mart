import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { ApprovalRequest, CmsContent, CountrySetting, FeatureFlag, Incident, OperationalAlert, PlatformGrant, PrivacyRequest, SecurityFinding, SubscriptionPlan, User, Warehouse } from '../models/index.js';
import { ROLES } from '../core/roles.js';
import { superAdminAccess, requireSuperAdminStepUp } from './super-admin-access.js';
import { createApproval, applyApproval } from './stage9.js';
import { writeAudit } from './audit.js';
import { marketRewardCatalogue } from './customer-rewards.js';
import { safeCmsData, cmsRevisionDigest } from './country-admin-growth-pages.js';
import { approvePrivacyRequest, setPrivacyLegalHold, retryPrivacyRequest, releasePrivacyRestriction, rejectPrivacyRequest } from './privacy.js';
import { reviewSellerSubscriptionRequest } from './seller-subscription-operations.js';
import { sellerPlanTerms } from './seller-subscription-operations.js';
import { countryAdminPersonalAccountEligible } from './country-admin-people-actions.js';

const version=z.union([z.number(),z.string().regex(/^\d+$/)]).pipe(z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)),reason=z.string().trim().min(10).max(1000);
const boolean=value=>[true,'true','on','1'].includes(value);
const list=value=>[...new Set((Array.isArray(value)?value:String(value||'').split(',')).map(item=>String(item).trim()).filter(Boolean))];
const changed=()=>new AppError('This source changed. Reload before continuing.',409,'SUPER_ADMIN_SOURCE_CHANGED');
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const checkVersion=(row,expected)=>{if(Number(row.__v||0)!==version.parse(expected))throw changed();};
export async function superAdminTransaction(request,work,{country}={}){
  const session=await mongoose.startSession();try{return await session.withTransaction(async()=>{const context=await superAdminAccess(request,{session,write:true,country});return work(context,session);});}finally{await session.endSession();}
}
export async function decideSuperApproval(request,id,raw){
  const input=z.object({decision:z.enum(['approve','reject']),reason,version}).parse(raw),source=await ApprovalRequest.findOne({publicId:id});
  if(!source)throw new AppError('Pending approval not found.',404,'APPROVAL_NOT_FOUND');checkVersion(source,input.version);
  if(input.decision==='approve')return applyApproval(source,request.user,{request,decisionReason:input.reason,beforeApply:async({session})=>{await superAdminAccess(request,{session,write:true,country:''});}});
  return superAdminTransaction(request,async(context,session)=>{
    const row=await ApprovalRequest.findOne({_id:source._id,status:'requested'}).session(session);if(!row)throw changed();checkVersion(row,input.version);
    if(String(row.requestedByUserId)===String(context.actor._id))throw new AppError('A different administrator must decide this request.',403,'FOUR_EYES_REQUIRED');
    row.status='rejected';row.decidedByUserId=context.actor._id;row.decidedAt=new Date();row.decisionReason=input.reason;await row.save({session});
    await writeAudit(request,'super_admin.approval_rejected',{actor:context.actor,session,country:row.country,targetType:'approval',targetPublicId:row.publicId,metadata:{type:row.type,reason:input.reason}});return row;
  },{country:''});
}
export async function requestSuperStaffChange(request,raw){
  const input=z.object({targetUserPublicId:z.string().trim().min(4).max(120),action:z.enum(['grant','suspend','revoke']),role:z.enum(['warehouse','support','moderator','finance','country_admin']),grantDurationDays:z.coerce.number().int().min(1).max(365).default(180),version,reason}).parse(raw);
  const countries=list(raw.operationalCountries).map(value=>value.toUpperCase()),warehouses=list(raw.warehouseScopes);
  return superAdminTransaction(request,async(context,session)=>{
    const target=await User.findOne({publicId:input.targetUserPublicId}).select('+operationalCountries').session(session);if(!target)throw new AppError('Staff account not found.',404,'STAFF_ACCOUNT_NOT_FOUND');checkVersion(target,input.version);
    if(target.role==='super_admin'||String(target._id)===String(context.actor._id))throw new AppError('Super Admin and self access are protected.',403,'SUPER_ADMIN_PROTECTED');
    if(input.action==='grant'&&(!countries.length||countries.some(value=>!/^[A-Z]{2}$/.test(value))))throw new AppError('Choose explicit operational countries.',422,'STAFF_COUNTRY_REQUIRED');
    if(input.action==='grant'){
      if(!['customer','warehouse','support','moderator','finance','country_admin'].includes(target.role))throw new AppError('Use a dedicated staff identity.',409,'STAFF_DEDICATED_ACCOUNT_REQUIRED');
      if(await CountrySetting.countDocuments({code:{$in:countries},active:true}).session(session)!==countries.length)throw new AppError('Choose active operational countries.',422,'STAFF_COUNTRY_INVALID');
      if((input.role==='warehouse'&&!warehouses.length)||(input.role!=='warehouse'&&warehouses.length))throw new AppError('Only warehouse staff require explicit warehouse assignments.',422,'STAFF_WAREHOUSE_SCOPE_ROLE');
      if(warehouses.length){const rows=await Warehouse.find({publicId:{$in:warehouses},active:true}).select('country').session(session).lean();if(rows.length!==warehouses.length||rows.some(row=>!countries.includes(row.country)))throw new AppError('Choose warehouses in the requested operational countries.',422,'STAFF_WAREHOUSE_SCOPE_INVALID');}
    }else if(!target.platformAccessManagedAt||!await PlatformGrant.exists({userId:target._id,status:{$in:['active','suspended']}}).session(session))throw new AppError('A current staff assignment is required.',409,'STAFF_GRANT_UNAVAILABLE');
    return createApproval({user:context.actor,request,type:'platform_staff_access',country:'',targetType:'user',targetPublicId:target.publicId,
      payload:{action:input.action,role:input.role,operationalCountries:countries,warehouseScopes:warehouses,grantDurationDays:input.grantDurationDays,sourceVersion:target.__v||0,targetTokenVersion:target.security.tokenVersion},reason:input.reason},{session});
  },{country:''});
}
export async function requestSuperCustomerState(request,id,raw){
  const input=z.object({status:z.enum(['active','suspended']),version,reason}).parse(raw);
  return superAdminTransaction(request,async(context,session)=>{
    const target=await User.findOne({publicId:id}).session(session);if(!target||!await countryAdminPersonalAccountEligible(target,'customer',session))throw new AppError('Use the staff or merchant review workflow for this account.',409,'PERSONAL_ACCOUNT_REQUIRED');checkVersion(target,input.version);
    if(target.status===input.status||String(target._id)===String(context.actor._id))throw new AppError('Choose a different account state.',409,'ACCOUNT_STATE_CONFLICT');
    return createApproval({user:context.actor,request,type:'personal_account_status',country:target.country,targetType:'user',targetPublicId:target.publicId,payload:{status:input.status,previousStatus:target.status,sourceVersion:target.__v||0,tokenVersion:target.security.tokenVersion},reason:input.reason},{session});
  },{country:''});
}
export function countryPolicySnapshot(setting){
  return {active:Boolean(setting.active),taxBps:setting.taxBps,platformFeeBps:setting.platformFeeBps,freeStandardShippingThresholdMinor:setting.freeStandardShippingThresholdMinor,returnWindowDays:setting.returnWindowDays,policyVersion:setting.policyVersion,
    payments:{card:Boolean(setting.payments?.card),mobile:Boolean(setting.payments?.mobile),cod:Boolean(setting.payments?.cod)},delivery:setting.delivery?.toObject?.()||setting.delivery||{},growth:setting.growth?.toObject?.()||setting.growth||{}};
}
export const countryPolicyDigest=setting=>digest(countryPolicySnapshot(setting));
function flattenedCountryPolicy(setting){const source=countryPolicySnapshot(setting);return {...source,...source.payments,...source.delivery,...source.growth};}
export async function requestSuperCountryPolicy(request,code,raw,kind='market'){
  const input=z.object({version,reason}).parse(raw);
  return superAdminTransaction(request,async(context,session)=>{
    const setting=await CountrySetting.findOne({code}).session(session);if(!setting)throw new AppError('Market not found.',404,'COUNTRY_NOT_FOUND');
    // Authorization fences may increment __v. The submitted policy digest binds
    // commercial fields without treating an unrelated access read as an edit.
    if(raw.sourceDigest!==countryPolicyDigest(setting))throw changed();
    let payload=flattenedCountryPolicy(setting);
    if(kind==='reward'){
      const reward=z.object({key:z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),label:z.string().trim().min(2).max(120),kind:z.enum(['voucher','shipping','gold_trial']),pointsCost:z.coerce.number().int().min(1).max(1000000000),validDays:z.coerce.number().int().min(1).max(365),valueMinor:z.coerce.number().int().min(0).max(1000000000),minimumSpendMinor:z.coerce.number().int().min(0).max(1000000000),maximumDiscountMinor:z.coerce.number().int().min(0).max(1000000000),multiplierBps:z.coerce.number().int().min(10000).max(50000),trialShippingDiscountBps:z.coerce.number().int().min(0).max(10000)}).parse(raw);
      reward.enabled=boolean(raw.enabled);payload.rewardCatalogue=[...(payload.rewardCatalogue||[]).filter(row=>row.key!==reward.key),reward];
      marketRewardCatalogue({growth:{...payload,loyaltyEnabled:true}});
    }else if(kind==='club'){
      const club=z.object({tier:z.enum(['classic','silver','gold']),multiplierBps:z.coerce.number().int().min(10000).max(50000),standardShippingDiscountBps:z.coerce.number().int().min(0).max(10000),minimumSpendMinor:z.coerce.number().int().min(0).max(1000000000)}).parse(raw);
      payload.clubBenefits=[...(payload.clubBenefits||[]).filter(row=>row.tier!==club.tier),club];
    }else{
      const numbers=z.object({taxBps:z.coerce.number().int().min(0).max(10000),platformFeeBps:z.coerce.number().int().min(0).max(5000),freeStandardShippingThresholdMinor:z.coerce.number().int().min(0).max(10000000000),returnWindowDays:z.coerce.number().int().min(0).max(365),defaultStandardSlaHours:z.coerce.number().int().min(1).max(720),defaultExpressSlaHours:z.coerce.number().int().min(1).max(720),loyaltyPointsPer1000Minor:z.coerce.number().int().min(0).max(10000),referralRewardPoints:z.coerce.number().int().min(0).max(1000000),promoterCommissionBps:z.coerce.number().int().min(0).max(5000),policyVersion:z.string().trim().min(1).max(40)}).parse(raw);payload={...payload,...numbers};
      for(const field of ['active','card','mobile','cod','standardEnabled','expressEnabled','pickupEnabled','requirePhotoForCod','requireSignatureForDelivery','requirePhotoForFailedAttempt','loyaltyEnabled','referralEnabled','giftCardsEnabled'])payload[field]=boolean(raw[field]);
    }
    payload.sourceDigest=countryPolicyDigest(setting);
    return createApproval({user:context.actor,request,type:'country_settings',country:code,targetType:'country',targetPublicId:code,payload,reason:input.reason},{session});
  },{country:''});
}
const entitlements=z.object({productLimit:z.coerce.number().int().min(0).max(1000000),seatLimit:z.coerce.number().int().min(1).max(1000000),campaignLimit:z.coerce.number().int().min(0).max(1000000),analyticsDays:z.coerce.number().int().min(1).max(3660),analyticsExport:z.boolean()});
export async function saveSuperSubscriptionPlan(request,raw,id=''){
  const input=z.object({key:z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,79}$/),name:z.string().trim().min(2).max(140),description:z.string().trim().max(1000).default(''),country:z.string().regex(/^[A-Z]{2}$/),priceMinor:z.coerce.number().int().min(0).max(10000000000),cadence:z.enum(['monthly','quarterly','yearly','one_time']),reason,version:version.optional()}).parse(raw);
  const typed=entitlements.parse({...raw,analyticsExport:boolean(raw.analyticsExport)});
  return superAdminTransaction(request,async(context,session)=>{
    const market=await CountrySetting.findOne({code:input.country,active:true}).session(session);if(!market)throw new AppError('Choose an active market.',422,'COUNTRY_NOT_FOUND');
    let plan=id?await SubscriptionPlan.findOne({publicId:id,audience:'seller'}).session(session):null;if(id&&!plan)throw new AppError('Plan not found.',404,'SUBSCRIPTION_PLAN_NOT_FOUND');
    if(plan){checkVersion(plan,input.version);if(plan.status!=='draft')throw new AppError('Published commercial terms are retained. Create a new draft plan for changed terms.',409,'SUBSCRIPTION_PLAN_IMMUTABLE');}
    else plan=new SubscriptionPlan({publicId:publicId('spl'),audience:'seller',createdByUserId:context.actor._id});
    Object.assign(plan,{key:input.key,name:input.name,description:input.description,country:market.code,currency:market.currency,priceMinor:input.priceMinor,cadence:input.cadence,entitlements:typed,status:'draft',updatedByUserId:context.actor._id});await plan.save({session});
    await writeAudit(request,'super_admin.subscription_plan_drafted',{actor:context.actor,session,targetType:'subscription_plan',targetPublicId:plan.publicId,country:plan.country,metadata:{reason:input.reason,terms:sellerPlanTerms(plan)}});return plan;
  },{country:''});
}
export async function requestSuperPlanPublication(request,id,raw){
  const input=z.object({version,reason,status:z.enum(['active','retired'])}).parse(raw);
  return superAdminTransaction(request,async(context,session)=>{const plan=await SubscriptionPlan.findOne({publicId:id,audience:'seller'}).session(session);if(!plan)throw new AppError('Plan not found.',404,'SUBSCRIPTION_PLAN_NOT_FOUND');checkVersion(plan,input.version);
    if(input.status==='active'&&plan.status!=='draft'||input.status==='retired'&&plan.status!=='active')throw new AppError('The plan is not in the required publication state.',409,'SUBSCRIPTION_PLAN_STATE');
    if(await ApprovalRequest.exists({type:'subscription_plan',targetPublicId:id,status:'requested'}).session(session))throw new AppError('A plan publication decision is already pending.',409,'SUBSCRIPTION_PLAN_REVIEW_PENDING');
    return createApproval({user:context.actor,request,type:'subscription_plan',country:plan.country,targetType:'subscription_plan',targetPublicId:id,payload:{status:input.status,sourceVersion:plan.__v||0,termsDigest:digest(sellerPlanTerms(plan))},reason:input.reason},{session});
  },{country:''});
}
export async function applySuperPlanApproval({approval,context,session}){
  if(context.actor.role!=='super_admin'||!context.grant||context.grant.role!=='super_admin'||!context.grant.operationalCountries.includes('*'))throw new AppError('A global Super Admin grant is required.',403,'SUPER_ADMIN_GRANT_REQUIRED');
  const plan=await SubscriptionPlan.findOne({publicId:approval.targetPublicId,audience:'seller',country:approval.country}).session(session);if(!plan)throw changed();checkVersion(plan,approval.payload.sourceVersion);
  if(digest(sellerPlanTerms(plan))!==approval.payload.termsDigest||String(plan.updatedByUserId)===String(context.actor._id)||String(plan.createdByUserId)===String(context.actor._id))throw new AppError('An independent reviewer must verify unchanged plan terms.',403,'SUBSCRIPTION_PLAN_REVIEW_CONFLICT');
  const next=approval.payload.status;if(!['active','retired'].includes(next)||next==='active'&&plan.status!=='draft'||next==='retired'&&plan.status!=='active')throw changed();
  plan.status=next;await plan.save({session});return {subscriptionPlan:plan.publicId,status:plan.status};
}
export async function decideSuperSubscriptionRequest(request,id,raw){return superAdminTransaction(request,(context,session)=>reviewSellerSubscriptionRequest(request,id,raw,{session,actor:context.actor}),{country:''});}
export async function actSuperPrivacy(request,id,raw){
  const input=z.object({action:z.enum(['approve','reject','hold','release_hold','retry','release_restriction']),version,reason:z.string().trim().min(3).max(2000)}).parse(raw);
  const context=await superAdminAccess(request);requireSuperAdminStepUp(request);
  const doc=await PrivacyRequest.findOne({publicId:id});if(!doc)throw new AppError('Privacy request not found.',404,'PRIVACY_REQUEST_NOT_FOUND');checkVersion(doc,input.version);
  if(input.action==='hold'||input.action==='release_hold')return setPrivacyLegalHold(doc,context.actor,{active:input.action==='hold',reason:input.reason,request});
  if(input.action==='reject')return rejectPrivacyRequest(doc,context.actor,input.reason,{request});
  if(input.action==='retry')return retryPrivacyRequest(doc,context.actor,input.reason,{request});
  if(input.action==='release_restriction')return releasePrivacyRestriction(doc,context.actor,input.reason,{request});
  const corrections={};for(const field of ['name','publicName','location','bio'])if(typeof raw['correction_'+field]==='string'&&boolean(raw['apply_'+field]))corrections[field]=raw['correction_'+field];
  return approvePrivacyRequest(doc,context.actor,input.reason,{request,...(doc.type==='correction'?{corrections}:{})});
}
export async function saveSuperCmsRevision(request,raw){
  const input=z.object({key:z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{1,119}$/),type:z.enum(['home_module','banner','collection','hero','press','help','legal']),country:z.string().regex(/^$|^[A-Z]{2}$/).default(''),title:z.string().trim().min(2).max(180),body:z.string().trim().min(3).max(20000),reason,version:version.optional()}).parse(raw);
  return superAdminTransaction(request,async(context,session)=>{let row=await CmsContent.findOne({key:input.key,country:input.country}).session(session);if(row){checkVersion(row,input.version);if(row.type!==input.type||row.scheduledVersion)throw new AppError('Content type is fixed; cancel an outstanding schedule before editing.',409,'CMS_SOURCE_CHANGED');}else row=new CmsContent({publicId:publicId('cms'),key:input.key,type:input.type,country:input.country});
    const revisionVersion=Math.max(0,...row.revisions.map(revision=>revision.version))+1;row.revisions.push({version:revisionVersion,title:input.title,body:input.body,data:safeCmsData(raw),reason:input.reason,createdByUserId:context.actor._id});row.status=row.activeVersion?'published':'draft';await row.save({session});
    await writeAudit(request,'super_admin.cms_revision_created',{actor:context.actor,session,targetType:'cms',targetPublicId:row.publicId,country:row.country,metadata:{version:revisionVersion}});return row;
  },{country:input.country});
}
export async function requestSuperCmsPublication(request,id,raw){
  const input=z.object({version,revisionVersion:z.coerce.number().int().positive(),action:z.enum(['publish','rollback']),scheduledFor:z.string().trim().max(40).default(''),reason}).parse(raw);
  let scheduledFor=null;if(input.scheduledFor){scheduledFor=new Date(input.scheduledFor.endsWith('Z')?input.scheduledFor:input.scheduledFor+'Z');if(!Number.isFinite(scheduledFor.getTime())||scheduledFor<=new Date())throw new AppError('Choose a future publication time in UTC.',422,'CMS_SCHEDULE_INVALID');}
  return superAdminTransaction(request,async(context,session)=>{const row=await CmsContent.findOne({publicId:id}).session(session);if(!row)throw new AppError('Content not found.',404,'CMS_NOT_FOUND');checkVersion(row,input.version);
    const revision=row.revisions.find(item=>item.version===input.revisionVersion);if(!revision||row.scheduledVersion||row.activeVersion===revision.version||input.action==='rollback'&&!revision.publishedAt)throw new AppError('The content revision cannot be published in its current state.',409,'CMS_SOURCE_CHANGED');
    if(await ApprovalRequest.exists({targetPublicId:id,type:{$in:['cms_publish','cms_rollback']},status:'requested'}).session(session))throw new AppError('Content already has a pending publication decision.',409,'CMS_APPROVAL_PENDING');
    row.increment();await row.save({session});return createApproval({user:context.actor,request,type:input.action==='publish'?'cms_publish':'cms_rollback',country:row.country,targetType:'cms',targetPublicId:row.publicId,payload:{version:revision.version,sourceVersion:row.__v||0,activeVersion:row.activeVersion,digest:cmsRevisionDigest(revision),scheduledFor:scheduledFor?.toISOString()||null},reason:input.reason},{session});
  },{country:''});
}
export async function cancelSuperCmsSchedule(request,id,raw){
  const input=z.object({version,reason}).parse(raw);return superAdminTransaction(request,async(context,session)=>{const row=await CmsContent.findOne({publicId:id}).session(session);if(!row)throw new AppError('Content not found.',404,'CMS_NOT_FOUND');checkVersion(row,input.version);if(!row.scheduledVersion)throw changed();const revision=row.revisions.find(item=>item.version===row.scheduledVersion);if(revision)revision.scheduledFor=null;row.scheduledVersion=0;row.status=row.activeVersion?'published':'draft';await row.save({session});await writeAudit(request,'super_admin.cms_schedule_cancelled',{actor:context.actor,session,targetType:'cms',targetPublicId:id,country:row.country,metadata:{reason:input.reason}});return row;},{country:''});
}
export async function requestSuperFeatureChange(request,raw){
  const input=z.object({key:z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),description:z.string().trim().max(500).default(''),rolloutPercentage:z.coerce.number().int().min(0).max(100),startsAt:z.string().trim().max(40).optional(),endsAt:z.string().trim().max(40).optional(),reason}).parse(raw),countries=list(raw.countries).map(value=>value.toUpperCase()),roles=list(raw.roles);
  if(countries.some(value=>!/^[A-Z]{2}$/.test(value)))throw new AppError('Choose valid market codes.',422,'COUNTRY_INVALID');
  if(roles.some(value=>!ROLES.includes(value)))throw new AppError('Choose valid account roles.',422,'FEATURE_ROLE_INVALID');
  return superAdminTransaction(request,async(context,session)=>{const row=await FeatureFlag.findOne({key:input.key}).session(session);if(row)checkVersion(row,raw.version);
    if(await CountrySetting.countDocuments({code:{$in:countries},active:true}).session(session)!==countries.length)throw new AppError('Choose active feature markets.',422,'COUNTRY_INVALID');
    const schedule={};for(const field of ['startsAt','endsAt']){const value=input[field];schedule[field]=value===undefined?row?.[field]?.toISOString()||null:value?new Date(value.endsWith('Z')?value:value+'Z'):null;if(schedule[field] instanceof Date){if(!Number.isFinite(schedule[field].getTime()))throw new AppError('Feature schedules use a valid UTC date and time.',422,'FEATURE_SCHEDULE_INVALID');schedule[field]=schedule[field].toISOString();}}
    if(schedule.startsAt&&schedule.endsAt&&schedule.startsAt>=schedule.endsAt)throw new AppError('Feature end must follow its start.',422,'FEATURE_SCHEDULE_INVALID');
    return createApproval({user:context.actor,request,type:'feature_flag',country:'',targetType:'feature_flag',targetPublicId:input.key,payload:{...input,...schedule,countries,roles,enabled:boolean(raw.enabled),sourceVersion:row?row.__v||0:null},reason:input.reason},{session});
  },{country:''});
}
export async function actSuperSecurityRecord(request,domain,id,raw){
  const input=z.object({version,reason,status:z.string().trim().max(40)}).parse(raw),Model={alerts:OperationalAlert,incidents:Incident,findings:SecurityFinding}[domain];if(!Model)throw new AppError('Security source not found.',404,'SECURITY_RECORD_NOT_FOUND');
  return superAdminTransaction(request,async(context,session)=>{const row=await Model.findOne({publicId:id}).session(session);if(!row)throw new AppError('Security source not found.',404,'SECURITY_RECORD_NOT_FOUND');checkVersion(row,input.version);
    if(domain==='alerts'){if(!['acknowledged','investigating','resolved','suppressed'].includes(input.status))throw new AppError('Choose a valid alert state.',422,'ALERT_STATUS_INVALID');row.status=input.status;row.resolutionNote=input.reason;if(['acknowledged','investigating'].includes(input.status)){row.acknowledgedByUserId=context.actor._id;row.acknowledgedAt=new Date();}if(input.status==='resolved'){row.resolvedByUserId=context.actor._id;row.resolvedAt=new Date();}}
    else if(domain==='incidents'){if(!['investigating','monitoring','resolved'].includes(input.status))throw new AppError('Choose a valid incident state.',422,'INCIDENT_STATUS_INVALID');row.status=input.status;if(input.status==='resolved')row.resolvedAt=new Date();row.timeline.push({type:`incident.${input.status}`,message:input.reason,actorUserId:context.actor._id});}
    else{if(input.status!=='remediated')throw new AppError('Record verified remediation or use the independent risk-acceptance workflow.',422,'SECURITY_FINDING_STATE');row.status='remediated';row.remediation=input.reason;row.remediatedAt=new Date();}
    row.increment();await row.save({session});await writeAudit(request,'super_admin.security_record_updated',{actor:context.actor,session,targetType:domain,targetPublicId:id,country:row.country,metadata:{status:row.status,reason:input.reason}});return row;
  },{country:''});
}

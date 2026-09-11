import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { hashToken } from '../core/crypto.js';
import { encryptSensitive, decryptSensitive } from '../core/sensitive.js';
import {
  AiModelRegistry, ApprovalRequest, AuditLog, CmsContent, CountrySetting, DataExport, FeatureFlag,
  BusinessOrganization, GiftCard, Incident, LedgerTransaction, LoyaltyAccount, LoyaltyEntry, MarketingCampaign, Order,
  PaymentIntent, Payout, PayoutAccount, PromoterVerification, Referral, Refund, SearchEvent, Store, SupportTicket, User, Warehouse,
} from '../models/index.js';
import { addOutboxEvent } from './outbox.js';
import { assertOperationalCountry, operationalCountriesFor, operationalCountryScope } from './authorization.js';
import { activatePlatformGrant, revokePlatformGrant, suspendPlatformGrant } from './platform-grants.js';
import { env } from '../config/env.js';

const exportDir=env.exportDir;

export function adminCountryScope(user, field='country'){
  return operationalCountryScope(user,field);
}
export function ensureAdminScope(user,country){
  assertOperationalCountry(user,country,'This operation is outside your country scope.');
}
function percentageBucket(identity,key){
  const digest=crypto.createHash('sha256').update(`${identity}:${key}`).digest();
  return digest.readUInt32BE(0)%100;
}
export function featureEnabled(flag,{country,role,identity='anonymous',now=new Date()}={}){
  if(!flag?.enabled)return false;
  if(flag.startsAt&&new Date(flag.startsAt)>now)return false;
  if(flag.endsAt&&new Date(flag.endsAt)<=now)return false;
  if(flag.countries?.length&&!flag.countries.includes(String(country||'').toUpperCase()))return false;
  if(flag.roles?.length&&!flag.roles.includes(role||'customer'))return false;
  return percentageBucket(identity,flag.key)<Number(flag.rolloutPercentage??100);
}
export async function activeFeatureMap({country,role,identity}){
  const flags=await FeatureFlag.find({enabled:true}).lean();
  return Object.fromEntries(flags.map(flag=>[flag.key,featureEnabled(flag,{country,role,identity})]));
}

export async function createApproval({user,type,country='',targetType='',targetPublicId='',payload,reason}){
  if(!reason||String(reason).trim().length<3)throw new AppError('A reason is required for high-risk changes.',422,'APPROVAL_REASON_REQUIRED');
  const cleanCountry=String(country||'').toUpperCase();
  if(user?.role==='country_admin'&&!cleanCountry)throw new AppError('Country-scoped administrators cannot create global approval requests.',403,'COUNTRY_SCOPE');
  if(cleanCountry)ensureAdminScope(user,cleanCountry);
  return ApprovalRequest.create({publicId:publicId('apr'),type,country:cleanCountry,targetType,targetPublicId,payload,reason:String(reason).trim(),requestedByUserId:user._id});
}

function safeCountryPatch(payload={}){
  const number=(v,min,max)=>Math.min(max,Math.max(min,Math.floor(Number(v)||0)));
  return {
    active:Boolean(payload.active),
    taxBps:number(payload.taxBps,0,10000),
    platformFeeBps:number(payload.platformFeeBps,0,5000),
    freeStandardShippingThresholdMinor:number(payload.freeStandardShippingThresholdMinor,0,10_000_000_000),
    returnWindowDays:number(payload.returnWindowDays,0,365),
    payments:{card:Boolean(payload.card),mobile:Boolean(payload.mobile),cod:Boolean(payload.cod)},
    delivery:{
      standardEnabled:Boolean(payload.standardEnabled),expressEnabled:Boolean(payload.expressEnabled),pickupEnabled:Boolean(payload.pickupEnabled),
      defaultStandardSlaHours:number(payload.defaultStandardSlaHours||72,1,720),defaultExpressSlaHours:number(payload.defaultExpressSlaHours||24,1,720),requirePhotoForCod:Boolean(payload.requirePhotoForCod),requireSignatureForDelivery:Boolean(payload.requireSignatureForDelivery),requirePhotoForFailedAttempt:Boolean(payload.requirePhotoForFailedAttempt),
    },
    growth:{
      loyaltyEnabled:Boolean(payload.loyaltyEnabled),referralEnabled:Boolean(payload.referralEnabled),giftCardsEnabled:Boolean(payload.giftCardsEnabled),
      loyaltyPointsPer1000Minor:number(payload.loyaltyPointsPer1000Minor||1,0,10000),referralRewardPoints:number(payload.referralRewardPoints||100,0,1_000_000),promoterCommissionBps:number(payload.promoterCommissionBps??300,0,5000),
    },
  };
}
function safeFlagPayload(payload={}){
  const key=String(payload.key||'').trim().toLowerCase();
  if(!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(key))throw new AppError('Feature flag key is invalid.',422,'FEATURE_KEY_INVALID');
  return {key,description:String(payload.description||'').trim().slice(0,500),enabled:Boolean(payload.enabled),countries:[...new Set((payload.countries||[]).map(v=>String(v).toUpperCase()).filter(v=>/^[A-Z]{2}$/.test(v)))],roles:[...new Set(payload.roles||[])],rolloutPercentage:Math.min(100,Math.max(0,Number(payload.rolloutPercentage??100))),startsAt:payload.startsAt?new Date(payload.startsAt):null,endsAt:payload.endsAt?new Date(payload.endsAt):null};
}

export async function applyApproval(approval,decider){
  if(!approval)throw new AppError('Approval request is no longer pending.',409,'APPROVAL_STATE');
  const session=await mongoose.startSession();let result={},postCommitExportPublicId='';
  try{
    await session.withTransaction(async()=>{
      const freshApproval=await ApprovalRequest.findOne({_id:approval._id,status:'requested'}).session(session);
      if(!freshApproval)throw new AppError('Approval request is no longer pending.',409,'APPROVAL_STATE');
      if(freshApproval.requestedByUserId.equals(decider._id))throw new AppError('A different administrator must approve this change.',403,'FOUR_EYES_REQUIRED');
      if(freshApproval.country)ensureAdminScope(decider,freshApproval.country);
      if(freshApproval.type==='country_settings'){
        const setting=await CountrySetting.findOne({code:freshApproval.country}).session(session);if(!setting)throw new AppError('Country configuration not found.',404,'COUNTRY_NOT_FOUND');
        Object.assign(setting,safeCountryPatch(freshApproval.payload));await setting.save({session});result={country:setting.code};
      }else if(freshApproval.type==='feature_flag'){
        const p=safeFlagPayload(freshApproval.payload);
        if(freshApproval.country&&(p.countries.length!==1||p.countries[0]!==freshApproval.country))throw new AppError('Country-scoped feature approval must target exactly its country.',403,'COUNTRY_SCOPE');
        let flag=await FeatureFlag.findOne({key:p.key}).session(session);
        if(flag&&freshApproval.country){const existingCountries=flag.countries||[];if(existingCountries.length===0||existingCountries.some(code=>code!==freshApproval.country))throw new AppError('Country Admin cannot modify a global or cross-country feature flag.',403,'COUNTRY_SCOPE');}
        if(!flag)flag=new FeatureFlag({publicId:publicId('flg'),key:p.key});
        Object.assign(flag,p,{version:Number(flag.version||0)+1,lastReason:freshApproval.reason,updatedByUserId:decider._id});await flag.save({session});result={featureFlag:flag.publicId};
      }else if(freshApproval.type==='cms_publish'||freshApproval.type==='cms_rollback'){
        const content=await CmsContent.findOne({publicId:freshApproval.targetPublicId}).session(session);if(!content)throw new AppError('CMS content not found.',404,'CMS_NOT_FOUND');
        if(content.country)ensureAdminScope(decider,content.country);
        const version=Number(freshApproval.payload.version);const revision=content.revisions.find(row=>row.version===version);if(!revision)throw new AppError('CMS revision not found.',404,'CMS_REVISION_NOT_FOUND');
        const scheduledFor=freshApproval.payload.scheduledFor?new Date(freshApproval.payload.scheduledFor):null;
        if(scheduledFor&&scheduledFor>Date.now()){content.status='scheduled';content.scheduledVersion=version;revision.scheduledFor=scheduledFor;}else{content.activeVersion=version;content.scheduledVersion=0;content.status='published';revision.publishedAt=new Date();}
        await content.save({session});result={content:content.publicId,version};
      }else if(freshApproval.type==='gift_card_issue'){
        const setting=await CountrySetting.findOne({code:freshApproval.country,active:true}).session(session).lean();if(!setting?.growth?.giftCardsEnabled)throw new AppError('Gift cards are not enabled in this country.',409,'GIFT_CARDS_DISABLED');
        const raw=`CM-${crypto.randomBytes(9).toString('hex').toUpperCase()}`;const amount=Math.floor(Number(freshApproval.payload.valueMinor||0));if(amount<=0)throw new AppError('Gift card value must be positive.',422,'GIFT_CARD_VALUE');
        const [card]=await GiftCard.create([{publicId:publicId('gft'),codeHash:hashToken(raw),codeEncrypted:encryptSensitive(raw),codeLast4:raw.slice(-4),country:freshApproval.country,currency:setting.currency,initialValueMinor:amount,balanceMinor:amount,issuedByUserId:decider._id,expiresAt:freshApproval.payload.expiresAt?new Date(freshApproval.payload.expiresAt):null,note:String(freshApproval.payload.note||'').slice(0,500)}],{session});result={giftCard:card.publicId};
      }else if(freshApproval.type==='data_export'){
        const exp=await DataExport.findOne({publicId:freshApproval.targetPublicId}).session(session);if(!exp)throw new AppError('Export request not found.',404,'EXPORT_NOT_FOUND');
        exp.status='approved';exp.approvedByUserId=decider._id;await exp.save({session});postCommitExportPublicId=exp.publicId;result={export:exp.publicId};
      }else if(freshApproval.type==='impersonation'){
        result={targetUserPublicId:String(freshApproval.payload.targetUserPublicId||'')};
      }else if(freshApproval.type==='ai_model_registry'){
        if(decider.role!=='super_admin')throw new AppError('Only Super Admin can approve global AI model registry changes.',403,'FORBIDDEN');
        const model=await AiModelRegistry.findOne({publicId:freshApproval.targetPublicId}).session(session);if(!model)throw new AppError('AI model registry entry not found.',404,'AI_MODEL_NOT_FOUND');
        const p=freshApproval.payload||{};model.enabled=Boolean(p.enabled);model.priority=Math.min(10000,Math.max(0,Math.floor(Number(p.priority)||0)));model.maxInputChars=Math.min(500000,Math.max(1000,Math.floor(Number(p.maxInputChars)||24000)));model.inputCostMicrosPerMillion=Math.max(0,Math.floor(Number(p.inputCostMicrosPerMillion)||0));model.outputCostMicrosPerMillion=Math.max(0,Math.floor(Number(p.outputCostMicrosPerMillion)||0));model.embeddingCostMicrosPerMillion=Math.max(0,Math.floor(Number(p.embeddingCostMicrosPerMillion)||0));model.updatedByUserId=decider._id;await model.save({session});result={aiModel:model.publicId};
      }else if(freshApproval.type==='business_credit_terms'){
        const org=await BusinessOrganization.findOne({publicId:freshApproval.targetPublicId}).session(session);if(!org)throw new AppError('Business organization not found.',404,'BUSINESS_ORG_NOT_FOUND');ensureAdminScope(decider,org.country);const p=freshApproval.payload||{};org.invoiceTermsApproved=Boolean(p.approved);org.invoiceTermsDays=org.invoiceTermsApproved?Math.min(120,Math.max(0,Math.floor(Number(p.invoiceTermsDays)||0))):0;org.creditLimitMinor=org.invoiceTermsApproved?Math.min(10_000_000_000,Math.max(0,Math.floor(Number(p.creditLimitMinor)||0))):0;org.status=org.invoiceTermsApproved?'active':'risk_review';await org.save({session});result={businessOrganization:org.publicId};
      }else if(freshApproval.type==='platform_staff_access'){
        const target=await User.findOne({publicId:freshApproval.targetPublicId}).select('+operationalCountries').session(session);if(!target)throw new AppError('Staff account not found.',404,'STAFF_ACCOUNT_NOT_FOUND');
        if(target.role==='super_admin')throw new AppError('Super Admin access cannot be changed through staff provisioning.',403,'SUPER_ADMIN_PROTECTED');
        const p=freshApproval.payload||{},action=String(p.action||'grant');
        const platformRoles=new Set(['warehouse','support','moderator','finance','country_admin']);
        const requestedRole=String(p.role||target.role||'');
        const countries=[...new Set((Array.isArray(p.operationalCountries)?p.operationalCountries:[]).map(v=>String(v).trim().toUpperCase()).filter(v=>/^[A-Z]{2}$/.test(v)))];
        const warehouseScopes=[...new Set((Array.isArray(p.warehouseScopes)?p.warehouseScopes:[]).map(v=>String(v||'').trim()).filter(Boolean))].slice(0,100);
        const grantDurationDays=Math.max(1,Math.min(365,Math.floor(Number(p.grantDurationDays)||180)));
        if(action==='grant'){
          if(!platformRoles.has(requestedRole))throw new AppError('Requested platform role is invalid.',422,'STAFF_ROLE_INVALID');
          if(!target.emailVerifiedAt||!target.phoneVerifiedAt)throw new AppError('Staff must verify email and phone before activation.',409,'STAFF_VERIFICATION_REQUIRED');
          if(!target.security?.mfaEnabled)throw new AppError('Staff must enroll MFA before privileged access can be activated.',409,'STAFF_MFA_REQUIRED');
          if(['seller','business','promoter','delivery'].includes(target.role))throw new AppError('Marketplace operator identities cannot be converted directly into platform staff. Use a dedicated staff account.',409,'STAFF_DEDICATED_ACCOUNT_REQUIRED');
          if(!countries.length)throw new AppError('At least one operational country is required.',422,'STAFF_COUNTRY_REQUIRED');
          const valid=await CountrySetting.countDocuments({code:{$in:countries}}).session(session);if(valid!==countries.length)throw new AppError('One or more operational countries are invalid.',422,'STAFF_COUNTRY_INVALID');
          if(decider.role==='country_admin'){
            if(['finance','country_admin'].includes(requestedRole))throw new AppError('Only Super Admin can provision Finance or Country Admin access.',403,'STAFF_ROLE_SCOPE');
            const allowed=operationalCountryScope(decider,'code');const allowedCountries=Array.isArray(allowed.code?.$in)?allowed.code.$in:[decider.country];
            if(countries.some(code=>!allowedCountries.includes(code)))throw new AppError('Staff country assignment is outside your scope.',403,'COUNTRY_SCOPE');
          }
          if(['finance','country_admin'].includes(requestedRole)&&decider.role!=='super_admin')throw new AppError('Only Super Admin can provision Finance or Country Admin access.',403,'STAFF_ROLE_SCOPE');
          if(requestedRole!=='warehouse'&&warehouseScopes.length)throw new AppError('Warehouse scopes can only be assigned to Warehouse staff.',422,'STAFF_WAREHOUSE_SCOPE_ROLE');
          if(warehouseScopes.length){const scoped=await Warehouse.find({publicId:{$in:warehouseScopes},active:true}).select('publicId country').session(session).lean();if(scoped.length!==warehouseScopes.length||scoped.some(row=>!countries.includes(String(row.country||'').toUpperCase())))throw new AppError('One or more warehouse scopes are invalid or outside the approved countries.',422,'STAFF_WAREHOUSE_SCOPE_INVALID');}
          const grant=await activatePlatformGrant({user:target,role:requestedRole,operationalCountries:countries,warehouseScopes,approvedByUserId:decider._id,approvalPublicId:freshApproval.publicId,reason:freshApproval.reason,durationDays:grantDurationDays,session});result={user:target.publicId,role:grant.role,operationalCountries:grant.operationalCountries,warehouseScopes:grant.warehouseScopes,status:'active',platformGrant:grant.publicId,expiresAt:grant.expiresAt};
        }else if(action==='suspend'){
          if(decider.role==='country_admin'&&['finance','country_admin'].includes(target.role))throw new AppError('Country Admin cannot suspend this platform role.',403,'STAFF_ROLE_SCOPE');
          await suspendPlatformGrant({user:target,actorUserId:decider._id,reason:freshApproval.reason,session});result={user:target.publicId,status:target.status};
        }else if(action==='revoke'){
          if(decider.role!=='super_admin'&&target.role==='country_admin')throw new AppError('Only Super Admin can revoke Country Admin access.',403,'STAFF_ROLE_SCOPE');
          await revokePlatformGrant({user:target,actorUserId:decider._id,reason:freshApproval.reason,session});result={user:target.publicId,role:target.role,status:target.status};
        }else throw new AppError('Staff access action is invalid.',422,'STAFF_ACTION_INVALID');
      }else throw new AppError('Unsupported approval type.',422,'APPROVAL_TYPE');
      freshApproval.status='applied';freshApproval.decidedByUserId=decider._id;freshApproval.decidedAt=new Date();freshApproval.appliedAt=new Date();await freshApproval.save({session});
    });
  }finally{await session.endSession();}
  if(postCommitExportPublicId){const exp=await DataExport.findOne({publicId:postCommitExportPublicId});if(exp)await generateExport(exp);}
  return result;
}

export async function createCmsRevision({user,key,type,country='',title='',body='',data={},reason}){
  const cleanCountry=String(country||'').toUpperCase();if(user?.role==='country_admin'&&!cleanCountry)throw new AppError('Country-scoped administrators cannot create global CMS content.',403,'COUNTRY_SCOPE');if(cleanCountry)ensureAdminScope(user,cleanCountry);
  const cleanKey=String(key||'').trim().toLowerCase();if(!/^[a-z0-9][a-z0-9._-]{1,119}$/.test(cleanKey))throw new AppError('CMS key is invalid.',422,'CMS_KEY_INVALID');
  let content=await CmsContent.findOne({key:cleanKey,country:cleanCountry});if(!content)content=new CmsContent({publicId:publicId('cms'),key:cleanKey,type,country:cleanCountry});
  if(content.type!==type)throw new AppError('CMS content type cannot be changed.',409,'CMS_TYPE_LOCKED');
  const version=Math.max(0,...content.revisions.map(r=>Number(r.version)))+1;content.revisions.push({version,title:String(title||'').trim(),body:String(body||''),data,reason:String(reason||'').trim(),createdByUserId:user._id});content.status=content.activeVersion?'published':'draft';await content.save();return {content,version};
}

export async function publishScheduledCms(now=new Date()){
  const docs=await CmsContent.find({status:'scheduled'});let activated=0;
  for(const doc of docs){const revision=doc.revisions.find(row=>row.version===doc.scheduledVersion);if(revision?.scheduledFor&&revision.scheduledFor<=now){doc.activeVersion=doc.scheduledVersion;doc.scheduledVersion=0;doc.status='published';revision.publishedAt=now;await doc.save();activated++;}}
  return activated;
}

async function ensureLoyalty(userId,country,session){
  let account=await LoyaltyAccount.findOne({userId}).session(session||null);if(!account){const [created]=await LoyaltyAccount.create([{publicId:publicId('loy'),userId,country,points:0}],session?{session}:undefined);account=created;}return account;
}
export async function addLoyaltyPoints({userId,country,points,idempotencyKey,type,referenceType='',referencePublicId='',reason='',actorUserId},session){
  if(!userId||!points)return null;const existing=await LoyaltyEntry.findOne({idempotencyKey}).session(session||null);if(existing)return existing;
  const account=await ensureLoyalty(userId,country,session);const next=account.points+points;if(next<0)throw new AppError('Loyalty balance is insufficient.',409,'LOYALTY_BALANCE');account.points=next;if(points>0)account.lifetimeEarned+=points;else account.lifetimeRedeemed+=Math.abs(points);account.tier=account.lifetimeEarned>=5000?'gold':account.lifetimeEarned>=1000?'silver':'classic';await account.save({session});
  const docs=await LoyaltyEntry.create([{publicId:publicId('loe'),idempotencyKey,userId,country,type,pointsDelta:points,balanceAfter:account.points,referenceType,referencePublicId,reason,actorUserId}],session?{session}:undefined);return docs[0];
}
export async function ensureReferralCode(user){
  let referral=await Referral.findOne({referrerUserId:user._id,referredUserId:null});if(referral)return referral;const code=`CM${crypto.randomBytes(4).toString('hex').toUpperCase()}`;return Referral.create({publicId:publicId('ref'),code,referrerUserId:user._id,country:user.country,status:'available'});
}
export async function acceptReferralCode(code,user){
  if(!code)return null;const referral=await Referral.findOne({code:String(code).trim().toUpperCase(),status:'available'});if(!referral)return null;if(referral.referrerUserId.equals(user._id))throw new AppError('You cannot use your own referral code.',422,'REFERRAL_SELF');if(referral.country!==user.country)throw new AppError('Referral code is not valid in your country.',422,'REFERRAL_COUNTRY');if(await Referral.exists({referredUserId:user._id}))return null;referral.referredUserId=user._id;referral.status='pending';referral.acceptedAt=new Date();await referral.save();return referral;
}
export async function applyGrowthForPaidOrder(order,session){
  if(!order.userId)return;const setting=await CountrySetting.findOne({code:order.country}).session(session).lean();if(!setting)return;
  if(setting.growth?.loyaltyEnabled){const rate=Number(setting.growth.loyaltyPointsPer1000Minor||0);const points=Math.floor(Number(order.totals.subtotalMinor||0)/1000)*rate;if(points>0)await addLoyaltyPoints({userId:order.userId,country:order.country,points,idempotencyKey:`order:${order.publicId}:loyalty`,type:'order_earn',referenceType:'order',referencePublicId:order.publicId,reason:'Verified order reward'},session);}
  if(setting.growth?.referralEnabled){const referral=await Referral.findOne({referredUserId:order.userId,status:'pending'}).session(session);if(referral){const previous=await Order.countDocuments({userId:order.userId,status:{$in:['paid','confirmed','fulfilled','partially_refunded','refunded']},_id:{$ne:order._id}}).session(session);if(previous===0){const reward=Number(setting.growth.referralRewardPoints||100);referral.status='rewarded';referral.qualifiedOrderPublicId=order.publicId;referral.qualifiedAt=new Date();referral.rewardedAt=new Date();referral.referrerRewardPoints=reward;referral.referredRewardPoints=reward;await referral.save({session});await addLoyaltyPoints({userId:referral.referrerUserId,country:order.country,points:reward,idempotencyKey:`referral:${referral.publicId}:referrer`,type:'referral_earn',referenceType:'referral',referencePublicId:referral.publicId,reason:'Qualified referral reward'},session);await addLoyaltyPoints({userId:order.userId,country:order.country,points:reward,idempotencyKey:`referral:${referral.publicId}:referred`,type:'referral_earn',referenceType:'referral',referencePublicId:referral.publicId,reason:'Welcome referral reward'},session);}}}
}
export async function redeemGiftCard({user,code}){
  const card=await GiftCard.findOne({codeHash:hashToken(String(code||'').trim())}).select('+codeHash');if(!card||card.status!=='active')throw new AppError('Gift card is invalid or no longer active.',404,'GIFT_CARD_INVALID');if(card.country!==user.country)throw new AppError('Gift card belongs to another country.',409,'GIFT_CARD_COUNTRY');if(card.expiresAt&&card.expiresAt<=new Date()){card.status='expired';await card.save();throw new AppError('Gift card has expired.',409,'GIFT_CARD_EXPIRED');}
  const setting=await CountrySetting.findOne({code:user.country}).lean();if(!setting?.growth?.giftCardsEnabled)throw new AppError('Gift cards are not enabled in this country.',409,'GIFT_CARDS_DISABLED');const divisor=1000;const rate=Math.max(1,Number(setting?.growth?.loyaltyPointsPer1000Minor||1));const points=Math.max(1,Math.floor(card.balanceMinor/divisor)*rate);await addLoyaltyPoints({userId:user._id,country:user.country,points,idempotencyKey:`gift:${card.publicId}`,type:'gift_card_redeem',referenceType:'gift_card',referencePublicId:card.publicId,reason:`Gift card value ${card.balanceMinor} ${card.currency}`});card.balanceMinor=0;card.status='redeemed';card.redeemedByUserId=user._id;card.redeemedAt=new Date();await card.save();return {card,points};
}

export async function queueConsentCampaign(campaign,actor,{ignoreSchedule=false}={}){
  if(!['draft','scheduled'].includes(campaign.status))throw new AppError('Campaign cannot be queued in its current state.',409,'CAMPAIGN_STATE');
  if(!ignoreSchedule&&campaign.scheduledAt&&campaign.scheduledAt>new Date())throw new AppError('Campaign is scheduled for a future time.',409,'CAMPAIGN_NOT_DUE');
  const query={'consents.marketing':true,status:'active'};if(campaign.country)query.country=campaign.country;if(campaign.roles?.length)query.role={$in:campaign.roles};
  const users=await User.find(query).select('publicId email country role').lean();campaign.status='running';campaign.startedAt=new Date();campaign.eligibleCount=users.length;campaign.queuedCount=0;await campaign.save();
  for(const user of users){await addOutboxEvent({type:'marketing.campaign_message',aggregateType:'marketing_campaign',aggregatePublicId:campaign.publicId,payload:{userPublicId:user.publicId,email:user.email,subject:campaign.subject,body:campaign.body,country:user.country,consentBasis:'marketing'}});campaign.queuedCount++;}
  campaign.status='completed';campaign.completedAt=new Date();await campaign.save();return campaign;
}
export async function queueDueCampaigns(now=new Date()){
  const due=await MarketingCampaign.find({status:'scheduled',scheduledAt:{$lte:now}}).limit(100);
  let queued=0;for(const campaign of due){await queueConsentCampaign(campaign,null,{ignoreSchedule:true});queued++;}return queued;
}

function csvCell(value){
  let text=String(value??'');
  // Prevent spreadsheet-formula execution when an operator opens exports in Excel/Sheets.
  if(/^[=+@-]/.test(text)) text=`'${text}`;
  return /[",\n]/.test(text)?`"${text.replaceAll('"','""')}"`:text;
}
const exportSpecs={
  orders:{Model:Order,headers:['orderId','country','status','currency','subtotalMinor','shippingMinor','taxMinor','totalMinor','createdAt'],row:x=>[x.publicId,x.country,x.status,x.totals?.currency,x.totals?.subtotalMinor,x.totals?.shippingMinor,x.totals?.taxMinor,x.totals?.totalMinor,x.createdAt?.toISOString()]},
  sellers:{Model:Store,headers:['storeId','name','country','status','createdAt'],row:x=>[x.publicId,x.name,x.country,x.status,x.createdAt?.toISOString()]},
  promoters:{Model:PromoterVerification,headers:['verificationId','country','status','createdAt'],row:x=>[x.publicId,x.country,x.status,x.createdAt?.toISOString()]},
  support:{Model:SupportTicket,headers:['ticketId','country','status','priority','category','createdAt'],row:x=>[x.publicId,x.country,x.status,x.priority,x.category,x.createdAt?.toISOString()]},
  audit:{Model:AuditLog,headers:['requestId','actorPublicId','action','targetType','targetPublicId','country','result','createdAt'],row:x=>[x.requestId,x.actorPublicId,x.action,x.targetType,x.targetPublicId,x.country,x.result,x.createdAt?.toISOString()]},
};
export async function generateExport(exp){
  let handle=null;
  try{
    exp.status='processing';exp.failureMessage='';await exp.save();await fs.mkdir(exportDir,{recursive:true});
    const spec=exportSpecs[exp.type];if(!spec)throw new AppError('Unsupported export type.',422,'EXPORT_TYPE');
    const scope=exp.country?{country:exp.country}:{},key=`${exp.publicId}.csv`,filePath=path.join(exportDir,key);
    handle=await fs.open(filePath,'w',0o600);
    await handle.write(`${spec.headers.map(csvCell).join(',')}\n`);
    let rowCount=0;
    const cursor=spec.Model.find(scope).sort({createdAt:-1,_id:-1}).lean().cursor({batchSize:500});
    for await(const doc of cursor){await handle.write(`${spec.row(doc).map(csvCell).join(',')}\n`);rowCount++;}
    await handle.sync();await handle.close();handle=null;
    exp.status='ready';exp.storageKey=key;exp.rowCount=rowCount;exp.readyAt=new Date();exp.expiresAt=new Date(Date.now()+24*60*60*1000);await exp.save();return exp;
  }catch(error){if(handle)await handle.close().catch(()=>{});exp.status='failed';exp.failureMessage=String(error.message||error).slice(0,500);await exp.save();throw error;}
}
export async function exportPath(exp){if(exp.status!=='ready'||!exp.storageKey||!exp.expiresAt||exp.expiresAt<=new Date())throw new AppError('Export is not available.',404,'EXPORT_NOT_READY');return path.join(exportDir,exp.storageKey);}
export async function expireExports(now=new Date()){
  const docs=await DataExport.find({status:'ready',expiresAt:{$lte:now}}).select('+storageKey');for(const exp of docs){if(exp.storageKey)await fs.rm(path.join(exportDir,exp.storageKey),{force:true}).catch(()=>{});exp.status='expired';exp.storageKey='';await exp.save();}return docs.length;
}

export async function platformReport(user,{country:requestedCountry=''}={}){
  const requested=String(requestedCountry||'').trim().toUpperCase();
  if(requested)assertOperationalCountry(user,requested,'Report country is outside your operational scope.');
  const scope=requested?{country:requested}:operationalCountryScope(user,'country');
  const matchCountry=(path)=>{const value=scope.country;if(value===undefined)return{};return{[path]:value};};
  const now=new Date(),paidStatuses=['paid','confirmed','fulfilled','partially_refunded','refunded'];
  const [orderStatusRows,gmvRows,storeTotal,verifiedStores,promoterTotal,verifiedPromoters,supportOpen,supportOverdue,userRoleRows,topSearchRows,openIncidents,paymentRows,refundRows,payoutRows,ledgerCount]=await Promise.all([
    Order.aggregate([{ $match:scope },{$group:{_id:'$status',count:{$sum:1}}}]),
    Order.aggregate([{ $match:{...scope,status:{$in:paidStatuses}} },{$group:{_id:'$totals.currency',amountMinor:{$sum:'$totals.totalMinor'},orders:{$sum:1}}},{$sort:{_id:1}}]),
    Store.countDocuments(scope),Store.countDocuments({...scope,status:'verified'}),
    PromoterVerification.countDocuments(scope),PromoterVerification.countDocuments({...scope,status:'verified'}),
    SupportTicket.countDocuments({...scope,status:{$nin:['resolved','closed']}}),
    SupportTicket.countDocuments({...scope,status:{$nin:['resolved','closed']},dueAt:{$lt:now}}),
    User.aggregate([{ $match:scope },{$group:{_id:'$role',count:{$sum:1}}}]),
    SearchEvent.aggregate([{ $match:scope },{$project:{query:{$toLower:{$trim:{input:'$query'}}}}},{$match:{query:{$ne:''}}},{$group:{_id:'$query',count:{$sum:1}}},{$sort:{count:-1,_id:1}},{$limit:10}]),
    Incident.countDocuments({...scope,status:{$ne:'resolved'}}),
    PaymentIntent.aggregate([
      {$lookup:{from:Order.collection.name,localField:'orderId',foreignField:'_id',as:'order'}},{$unwind:'$order'},
      ...(Object.keys(matchCountry('order.country')).length?[{$match:matchCountry('order.country')}]:[]),
      {$group:{_id:null,total:{$sum:1},succeeded:{$sum:{$cond:[{$eq:['$status','succeeded']},1,0]}}}},
    ]),
    Refund.aggregate([
      {$lookup:{from:Order.collection.name,localField:'orderId',foreignField:'_id',as:'order'}},{$unwind:'$order'},
      ...(Object.keys(matchCountry('order.country')).length?[{$match:matchCountry('order.country')}]:[]),
      {$group:{_id:null,total:{$sum:1},completed:{$sum:{$cond:[{$eq:['$status','completed']},1,0]}}}},
    ]),
    Payout.aggregate([
      {$lookup:{from:PayoutAccount.collection.name,localField:'payoutAccountId',foreignField:'_id',as:'account'}},{$unwind:'$account'},
      ...(Object.keys(matchCountry('account.country')).length?[{$match:matchCountry('account.country')}]:[]),
      {$group:{_id:null,total:{$sum:1},pending:{$sum:{$cond:[{$in:['$status',['requested','approved','submitting','submitted','unknown']]},1,0]}}}},
    ]),
    LedgerTransaction.countDocuments(scope),
  ]);
  const orderTotal=orderStatusRows.reduce((sum,row)=>sum+Number(row.count||0),0);
  const userTotal=userRoleRows.reduce((sum,row)=>sum+Number(row.count||0),0);
  const payment=paymentRows[0]||{total:0,succeeded:0},refund=refundRows[0]||{total:0,completed:0},payout=payoutRows[0]||{total:0,pending:0};
  const gmvByCurrency=Object.fromEntries(gmvRows.filter(row=>row._id).map(row=>[row._id,{amountMinor:Number(row.amountMinor||0),orders:Number(row.orders||0)}]));
  const currencies=Object.keys(gmvByCurrency);
  const granted=operationalCountriesFor(user).filter(code=>code!=='*');
  return {
    country:requested||((user.role==='super_admin')?'GLOBAL':granted.length===1?granted[0]:'MULTI'),
    countries:requested?[requested]:granted,
    currency:currencies.length===1?currencies[0]:'',gmvByCurrency,
    orders:{total:orderTotal,byStatus:Object.fromEntries(orderStatusRows.map(row=>[row._id,row.count]))},
    finance:{payments:payment.total,succeededPayments:payment.succeeded,refunds:refund.total,completedRefunds:refund.completed,payouts:payout.total,pendingPayouts:payout.pending,ledgerTransactions:ledgerCount},
    stores:{total:storeTotal,verified:verifiedStores},promoters:{total:promoterTotal,approved:verifiedPromoters},
    support:{open:supportOpen,overdue:supportOverdue},users:{total:userTotal,byRole:Object.fromEntries(userRoleRows.map(row=>[row._id,row.count]))},
    topSearches:topSearchRows.map(row=>({query:row._id,count:row.count})),incidentsOpen:openIncidents,
  };
}
export async function stage9Maintenance(){return {cmsActivated:await publishScheduledCms(),campaignsQueued:await queueDueCampaigns(),exportsExpired:await expireExports()};}
export async function revealGiftCard(publicId,user){const card=await GiftCard.findOne({publicId,...adminCountryScope(user)}).select('+codeEncrypted').lean();if(!card)throw new AppError('Gift card not found.',404,'GIFT_CARD_NOT_FOUND');return {...card,code:decryptSensitive(card.codeEncrypted)};}
export async function publishedCms(key,country){
  const clean=String(key||'').toLowerCase();
  const doc=await CmsContent.findOne({key:clean,country:String(country||'').toUpperCase(),status:'published'}).lean() || await CmsContent.findOne({key:clean,country:'',status:'published'}).lean();
  if(!doc?.activeVersion)return null;const revision=doc.revisions.find(row=>row.version===doc.activeVersion);return revision?{key:doc.key,type:doc.type,country:doc.country,version:revision.version,title:revision.title,body:revision.body,data:revision.data}:null;
}

export async function publishedCmsList({prefix='',type='',country='',limit=20}={}){
  const cleanPrefix=String(prefix||'').trim().toLowerCase();
  const cleanCountry=String(country||'').trim().toUpperCase();
  const query={status:'published'};
  if(type)query.type=String(type).trim().toLowerCase();
  if(cleanPrefix)query.key={$regex:`^${cleanPrefix.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`};
  query.country={$in:[cleanCountry,'']};
  const docs=await CmsContent.find(query).sort({country:-1,key:1}).limit(Math.min(100,Math.max(1,Number(limit)||20))*2).lean();
  const byKey=new Map();
  for(const doc of docs){
    const current=byKey.get(doc.key);
    if(current&&current.country===cleanCountry)continue;
    if(!doc.activeVersion)continue;
    const revision=doc.revisions.find(row=>row.version===doc.activeVersion);
    if(!revision)continue;
    byKey.set(doc.key,{key:doc.key,type:doc.type,country:doc.country,version:revision.version,title:revision.title,body:revision.body,data:revision.data||{}});
  }
  return [...byKey.values()].sort((a,b)=>a.key.localeCompare(b.key)).slice(0,Math.min(100,Math.max(1,Number(limit)||20)));
}

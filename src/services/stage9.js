import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { hashToken } from '../core/crypto.js';
import { encryptSensitive, decryptSensitive } from '../core/sensitive.js';
import {
  AiModelRegistry, ApprovalRequest, AuditLog, CmsContent, CountrySetting, DataExport, FeatureFlag,
  BusinessOrganization, GiftCard, Incident, LedgerTransaction, LoyaltyAccount, LoyaltyEntry, MarketingCampaign, Order,
  PaymentIntent, Payout, PromoterVerification, Referral, Refund, SearchEvent, Store, SupportTicket, User,
} from '../models/index.js';
import { addOutboxEvent } from './outbox.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const exportDir=path.join(root,'storage','exports');

export function adminCountryScope(user, field='country'){
  return user?.role==='country_admin'?{[field]:user.country}:{};
}
export function ensureAdminScope(user,country){
  if(user?.role==='super_admin')return;
  if(user?.role!=='country_admin'||String(country||'').toUpperCase()!==user.country)throw new AppError('This operation is outside your country scope.',403,'COUNTRY_SCOPE');
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
      defaultStandardSlaHours:number(payload.defaultStandardSlaHours||72,1,720),defaultExpressSlaHours:number(payload.defaultExpressSlaHours||24,1,720),
    },
    growth:{
      loyaltyEnabled:Boolean(payload.loyaltyEnabled),referralEnabled:Boolean(payload.referralEnabled),giftCardsEnabled:Boolean(payload.giftCardsEnabled),
      loyaltyPointsPer1000Minor:number(payload.loyaltyPointsPer1000Minor||1,0,10000),referralRewardPoints:number(payload.referralRewardPoints||100,0,1_000_000),
    },
  };
}
function safeFlagPayload(payload={}){
  const key=String(payload.key||'').trim().toLowerCase();
  if(!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(key))throw new AppError('Feature flag key is invalid.',422,'FEATURE_KEY_INVALID');
  return {key,description:String(payload.description||'').trim().slice(0,500),enabled:Boolean(payload.enabled),countries:[...new Set((payload.countries||[]).map(v=>String(v).toUpperCase()).filter(v=>/^[A-Z]{2}$/.test(v)))],roles:[...new Set(payload.roles||[])],rolloutPercentage:Math.min(100,Math.max(0,Number(payload.rolloutPercentage??100))),startsAt:payload.startsAt?new Date(payload.startsAt):null,endsAt:payload.endsAt?new Date(payload.endsAt):null};
}

export async function applyApproval(approval,decider){
  if(!approval||approval.status!=='requested')throw new AppError('Approval request is no longer pending.',409,'APPROVAL_STATE');
  if(approval.requestedByUserId.equals(decider._id))throw new AppError('A different administrator must approve this change.',403,'FOUR_EYES_REQUIRED');
  if(approval.country)ensureAdminScope(decider,approval.country);
  let result={};
  if(approval.type==='country_settings'){
    const setting=await CountrySetting.findOne({code:approval.country});if(!setting)throw new AppError('Country configuration not found.',404,'COUNTRY_NOT_FOUND');
    Object.assign(setting,safeCountryPatch(approval.payload));await setting.save();result={country:setting.code};
  }else if(approval.type==='feature_flag'){
    const p=safeFlagPayload(approval.payload);
    if(approval.country&&(p.countries.length!==1||p.countries[0]!==approval.country))throw new AppError('Country-scoped feature approval must target exactly its country.',403,'COUNTRY_SCOPE');
    let flag=await FeatureFlag.findOne({key:p.key});
    if(flag&&approval.country){const existingCountries=flag.countries||[];if(existingCountries.length===0||existingCountries.some(code=>code!==approval.country))throw new AppError('Country Admin cannot modify a global or cross-country feature flag.',403,'COUNTRY_SCOPE');}
    if(!flag)flag=new FeatureFlag({publicId:publicId('flg'),key:p.key});
    Object.assign(flag,p,{version:Number(flag.version||0)+1,lastReason:approval.reason,updatedByUserId:decider._id});await flag.save();result={featureFlag:flag.publicId};
  }else if(approval.type==='cms_publish'||approval.type==='cms_rollback'){
    const content=await CmsContent.findOne({publicId:approval.targetPublicId});if(!content)throw new AppError('CMS content not found.',404,'CMS_NOT_FOUND');
    if(content.country)ensureAdminScope(decider,content.country);
    const version=Number(approval.payload.version);const revision=content.revisions.find(row=>row.version===version);if(!revision)throw new AppError('CMS revision not found.',404,'CMS_REVISION_NOT_FOUND');
    const scheduledFor=approval.payload.scheduledFor?new Date(approval.payload.scheduledFor):null;
    if(scheduledFor&&scheduledFor>Date.now()){content.status='scheduled';content.scheduledVersion=version;revision.scheduledFor=scheduledFor;}else{content.activeVersion=version;content.scheduledVersion=0;content.status='published';revision.publishedAt=new Date();}
    await content.save();result={content:content.publicId,version};
  }else if(approval.type==='gift_card_issue'){
    const setting=await CountrySetting.findOne({code:approval.country,active:true}).lean();if(!setting?.growth?.giftCardsEnabled)throw new AppError('Gift cards are not enabled in this country.',409,'GIFT_CARDS_DISABLED');
    const raw=`CM-${crypto.randomBytes(9).toString('hex').toUpperCase()}`;const amount=Math.floor(Number(approval.payload.valueMinor||0));if(amount<=0)throw new AppError('Gift card value must be positive.',422,'GIFT_CARD_VALUE');
    const card=await GiftCard.create({publicId:publicId('gft'),codeHash:hashToken(raw),codeEncrypted:encryptSensitive(raw),codeLast4:raw.slice(-4),country:approval.country,currency:setting.currency,initialValueMinor:amount,balanceMinor:amount,issuedByUserId:decider._id,expiresAt:approval.payload.expiresAt?new Date(approval.payload.expiresAt):null,note:String(approval.payload.note||'').slice(0,500)});result={giftCard:card.publicId};
  }else if(approval.type==='data_export'){
    const exp=await DataExport.findOne({publicId:approval.targetPublicId});if(!exp)throw new AppError('Export request not found.',404,'EXPORT_NOT_FOUND');
    exp.status='approved';exp.approvedByUserId=decider._id;await exp.save();await generateExport(exp);result={export:exp.publicId};
  }else if(approval.type==='impersonation'){
    result={targetUserPublicId:String(approval.payload.targetUserPublicId||'')};
  }else if(approval.type==='ai_model_registry'){
    if(decider.role!=='super_admin')throw new AppError('Only Super Admin can approve global AI model registry changes.',403,'FORBIDDEN');
    const model=await AiModelRegistry.findOne({publicId:approval.targetPublicId});if(!model)throw new AppError('AI model registry entry not found.',404,'AI_MODEL_NOT_FOUND');
    const p=approval.payload||{};model.enabled=Boolean(p.enabled);model.priority=Math.min(10000,Math.max(0,Math.floor(Number(p.priority)||0)));model.maxInputChars=Math.min(500000,Math.max(1000,Math.floor(Number(p.maxInputChars)||24000)));model.inputCostMicrosPerMillion=Math.max(0,Math.floor(Number(p.inputCostMicrosPerMillion)||0));model.outputCostMicrosPerMillion=Math.max(0,Math.floor(Number(p.outputCostMicrosPerMillion)||0));model.embeddingCostMicrosPerMillion=Math.max(0,Math.floor(Number(p.embeddingCostMicrosPerMillion)||0));model.updatedByUserId=decider._id;await model.save();result={aiModel:model.publicId};
  }else if(approval.type==='business_credit_terms'){
    const org=await BusinessOrganization.findOne({publicId:approval.targetPublicId});if(!org)throw new AppError('Business organization not found.',404,'BUSINESS_ORG_NOT_FOUND');ensureAdminScope(decider,org.country);const p=approval.payload||{};org.invoiceTermsApproved=Boolean(p.approved);org.invoiceTermsDays=org.invoiceTermsApproved?Math.min(120,Math.max(0,Math.floor(Number(p.invoiceTermsDays)||0))):0;org.creditLimitMinor=org.invoiceTermsApproved?Math.min(10_000_000_000,Math.max(0,Math.floor(Number(p.creditLimitMinor)||0))):0;org.status=org.invoiceTermsApproved?'active':'risk_review';await org.save();result={businessOrganization:org.publicId};
  }else throw new AppError('Unsupported approval type.',422,'APPROVAL_TYPE');
  approval.status='applied';approval.decidedByUserId=decider._id;approval.decidedAt=new Date();approval.appliedAt=new Date();await approval.save();return result;
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

function csvCell(value){const text=String(value??'');return /[",\n]/.test(text)?`"${text.replaceAll('"','""')}"`:text;}
export async function generateExport(exp){
  try{exp.status='processing';await exp.save();await fs.mkdir(exportDir,{recursive:true});let rows=[];let headers=[];const scope=exp.country?{country:exp.country}:{};
    if(exp.type==='orders'){headers=['orderId','country','status','currency','subtotalMinor','shippingMinor','taxMinor','totalMinor','createdAt'];const docs=await Order.find(scope).sort({createdAt:-1}).limit(5000).lean();rows=docs.map(x=>[x.publicId,x.country,x.status,x.totals?.currency,x.totals?.subtotalMinor,x.totals?.shippingMinor,x.totals?.taxMinor,x.totals?.totalMinor,x.createdAt?.toISOString()]);}
    else if(exp.type==='sellers'){headers=['storeId','name','country','status','createdAt'];const docs=await Store.find(scope).sort({createdAt:-1}).limit(5000).lean();rows=docs.map(x=>[x.publicId,x.name,x.country,x.status,x.createdAt?.toISOString()]);}
    else if(exp.type==='promoters'){headers=['verificationId','country','status','createdAt'];const docs=await PromoterVerification.find(scope).sort({createdAt:-1}).limit(5000).lean();rows=docs.map(x=>[x.publicId,x.country,x.status,x.createdAt?.toISOString()]);}
    else if(exp.type==='support'){headers=['ticketId','country','status','priority','category','createdAt'];const docs=await SupportTicket.find(scope).sort({createdAt:-1}).limit(5000).lean();rows=docs.map(x=>[x.publicId,x.country,x.status,x.priority,x.category,x.createdAt?.toISOString()]);}
    else if(exp.type==='audit'){headers=['requestId','actorPublicId','action','targetType','targetPublicId','country','result','createdAt'];const docs=await AuditLog.find(scope).sort({createdAt:-1}).limit(5000).lean();rows=docs.map(x=>[x.requestId,x.actorPublicId,x.action,x.targetType,x.targetPublicId,x.country,x.result,x.createdAt?.toISOString()]);}
    const csv=[headers,...rows].map(row=>row.map(csvCell).join(',')).join('\n');const key=`${exp.publicId}.csv`;await fs.writeFile(path.join(exportDir,key),csv,{mode:0o600});exp.status='ready';exp.storageKey=key;exp.rowCount=rows.length;exp.readyAt=new Date();exp.expiresAt=new Date(Date.now()+24*60*60*1000);await exp.save();return exp;
  }catch(error){exp.status='failed';exp.failureMessage=error.message;await exp.save();throw error;}
}
export async function exportPath(exp){if(exp.status!=='ready'||!exp.storageKey||!exp.expiresAt||exp.expiresAt<=new Date())throw new AppError('Export is not available.',404,'EXPORT_NOT_READY');return path.join(exportDir,exp.storageKey);}
export async function expireExports(now=new Date()){
  const docs=await DataExport.find({status:'ready',expiresAt:{$lte:now}}).select('+storageKey');for(const exp of docs){if(exp.storageKey)await fs.rm(path.join(exportDir,exp.storageKey),{force:true}).catch(()=>{});exp.status='expired';exp.storageKey='';await exp.save();}return docs.length;
}

export async function platformReport(user){
  const country=user.role==='country_admin'?user.country:'';
  const scope=country?{country}:{};
  const userScope=country?{country}:{};
  const [orders,stores,promoters,tickets,searches,users,incidents]=await Promise.all([
    Order.find(scope).select('_id status totals createdAt country').lean(),
    Store.find(scope).select('status country').lean(),
    PromoterVerification.find(scope).select('status country').lean(),
    SupportTicket.find(scope).select('status priority createdAt dueAt country').lean(),
    SearchEvent.find(scope).select('query resultsCount country createdAt').sort({createdAt:-1}).limit(1000).lean(),
    User.find(userScope).select('_id role status country').lean(),
    Incident.find(scope).sort({createdAt:-1}).limit(50).lean(),
  ]);
  const orderIds=orders.map(o=>o._id);
  const userIds=users.map(u=>u._id);
  const [payments,refunds,payouts,ledgerCount]=await Promise.all([
    PaymentIntent.find(country?{orderId:{$in:orderIds}}:{}).select('status amountMinor currency orderId').lean(),
    Refund.find(country?{orderId:{$in:orderIds}}:{}).select('status amountMinor currency orderId').lean(),
    Payout.find(country?{ownerUserId:{$in:userIds}}:{}).select('status amountMinor currency ownerUserId').lean(),
    LedgerTransaction.countDocuments(scope),
  ]);
  const gmv=orders.filter(o=>['paid','confirmed','fulfilled','partially_refunded','refunded'].includes(o.status)).reduce((sum,o)=>sum+Number(o.totals?.totalMinor||0),0);
  const currency=(await CountrySetting.findOne(country?{code:country}:{active:true}).lean())?.currency||'';
  const searchMap=new Map();
  for(const row of searches){const key=String(row.query||'').trim().toLowerCase();if(key)searchMap.set(key,(searchMap.get(key)||0)+1);}
  const topSearches=[...searchMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10).map(([query,count])=>({query,count}));
  return {
    country:country||'GLOBAL',currency,
    orders:{total:orders.length,gmv,byStatus:Object.fromEntries([...new Set(orders.map(o=>o.status))].map(s=>[s,orders.filter(o=>o.status===s).length]))},
    finance:{payments:payments.length,succeededPayments:payments.filter(p=>p.status==='succeeded').length,refunds:refunds.length,completedRefunds:refunds.filter(r=>r.status==='completed').length,payouts:payouts.length,pendingPayouts:payouts.filter(p=>['requested','approved','submitted'].includes(p.status)).length,ledgerTransactions:ledgerCount},
    stores:{total:stores.length,verified:stores.filter(s=>s.status==='verified').length},
    promoters:{total:promoters.length,approved:promoters.filter(p=>p.status==='verified').length},
    support:{open:tickets.filter(t=>!['resolved','closed'].includes(t.status)).length,overdue:tickets.filter(t=>t.dueAt&&t.dueAt<new Date()&&!['resolved','closed'].includes(t.status)).length},
    users:{total:users.length,byRole:Object.fromEntries([...new Set(users.map(u=>u.role))].map(r=>[r,users.filter(u=>u.role===r).length]))},
    topSearches,incidents,
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

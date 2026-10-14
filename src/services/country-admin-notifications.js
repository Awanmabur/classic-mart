import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { CountrySetting, Notification, PlatformGrant, Product, PromoterVerification, SellerVerification, Store, User } from '../models/index.js';

const SOURCES={product:{Model:Product,path:'/admin/products'},seller_verification:{Model:SellerVerification,path:'/admin/seller-approvals'},
  promoter_verification:{Model:PromoterVerification,path:'/admin/promoter-approvals'},review:{path:'/admin/reviews'}};
const same=(a,b)=>String(a || '') === String(b || '');
async function recordedSource(type,id,country,kind,session) {
  const config=SOURCES[type];if(!config)return null;
  if(type === 'review') {
    const {Review,Order}=await import('../models/index.js');
    const row=await Review.findOne({publicId:id,country,verifiedPurchase:true,status:'disputed'}).session(session);
    const order=row && await Order.findOne({_id:row.orderId,publicId:row.orderPublicId,userId:row.userId,country,fulfillmentState:'delivered'}).session(session);
    const line=order?.items.find(item=>same(item.productId,row.productId) && item.productPublicId === row.productPublicId && Number(item.deliveredQuantity)>0 && (!row.orderLinePublicId || row.orderLinePublicId === item.linePublicId));
    const product=line && await Product.findOne({_id:row.productId,publicId:row.productPublicId,storeId:line.storeId}).session(session);
    const store=product && await Store.findOne({_id:product.storeId,publicId:line.storePublicId}).session(session);
    if(!row || !order || !line || !product || !store || !row.disputedAt || !row.disputeReason || kind !== 'escalation')return null;
    return {row,Model:Review,path:config.path,countries:[...new Set([country,store.country])],records:[[Review,row],[Order,order],[Product,product],[Store,store]]};
  }
  const row=await config.Model.findOne({publicId:id}).session(session);if(!row)return null;
  if(type === 'promoter_verification') {
    const owner=await User.findOne({_id:row.userId,role:'promoter',status:'active',platformAccessManagedAt:null,emailVerifiedAt:mongoose.trusted({$type:'date'}),onboardingCompletedAt:mongoose.trusted({$type:'date'})}).session(session);
    if(!owner || row.country !== country || row.status !== 'appealed' || !row.submittedAt || !row.disclosureAcceptedAt || !row.appeal?.submittedAt || !row.appeal?.originalReviewerUserId || !row.appeal?.message || kind !== 'escalation')return null;
    return {row,Model:config.Model,path:config.path,countries:[country],records:[[config.Model,row]]};
  }
  const store=await Store.findById(row.storeId).session(session);
  if(!store || store.country !== country || !same(type === 'product'?row.ownerUserId:row.userId,store.ownerUserId))return null;
  const valid=type === 'product'?row.status === 'submitted' && store.status === 'verified' && Boolean(row.moderation?.riskLevel === 'high' || row.moderation?.secondReviewRequired)
    :store.status === 'pending_verification' && (kind === 'priority'?row.status === 'submitted' && row.sellerType === 'business' && row.submittedAt && row.declarationAcceptedAt:row.status === 'appealed' && row.appeal?.message && row.appeal?.submittedAt);
  if(!valid || type === 'product' && kind !== 'priority')return null;
  return {row,Model:config.Model,path:config.path,countries:[country],records:[[config.Model,row],[Store,store]]};
}

/** Preferences control genuine in-app work alerts from a persisted source transition. */
export async function queueCountryAdminAlert({country,kind='priority',sourceType,sourcePublicId},session) {
  if(!session?.inTransaction())throw new AppError('Country Admin work alerts require a source transaction.',500,'COUNTRY_ADMIN_TRANSACTION_REQUIRED');
  if(typeof country !== 'string' || !/^[A-Z]{2}$/.test(country) || !['priority','escalation'].includes(kind)
    || typeof sourceType !== 'string' || !Object.hasOwn(SOURCES,sourceType)
    || typeof sourcePublicId !== 'string' || !/^[A-Za-z0-9_-]{4,100}$/.test(sourcePublicId))throw new AppError('Country Admin alert context is invalid.',500,'COUNTRY_ADMIN_ALERT_INVALID');
  const source=await recordedSource(sourceType,sourcePublicId,country,kind,session);if(!source)return 0;
  const markets=await CountrySetting.find({code:mongoose.trusted({$in:source.countries}),active:true}).select('code currency timeZone __v').session(session).lean();
  if(markets.length !== source.countries.length || markets.some(row=>!row.currency || !row.timeZone))return 0;
  const now=new Date(),preference=kind === 'priority'?'preferences.countryAdminHighRiskAlerts':'preferences.countryAdminEscalationAlerts';
  const recipients=await User.aggregate([
    {$match:{status:'active',platformAccessManagedAt:{$type:'date'},emailVerifiedAt:{$type:'date'},phoneVerifiedAt:{$type:'date'},onboardingCompletedAt:{$type:'date'},'security.mfaEnabled':true,[preference]:{$ne:false}}},
    {$lookup:{from:PlatformGrant.collection.name,localField:'_id',foreignField:'userId',as:'grants',pipeline:[{$match:{status:'active',startsAt:{$lte:now},expiresAt:{$gt:now}}}]}},
    {$match:{$expr:{$and:[{$eq:[{$size:'$grants'},1]},{$eq:[{$first:'$grants.role'},'country_admin']},{$setIsSubset:[source.countries,{$ifNull:[{$first:'$grants.operationalCountries'},[]]}]}]}}},
    {$project:{_id:1,role:1,__v:1,'security.tokenVersion':1,grant:{$first:'$grants'}}},
  ]).session(session);
  if(!recipients.length)return 0;
  // Serialize the saved source/market with current jurisdiction and preferences.
  for(const [Model,row] of source.records) {
    const result=await Model.updateOne({_id:row._id,__v:row.__v || 0},{$inc:{moderationEvidenceReadRevision:1}},{session,timestamps:false});
    if(result.modifiedCount !== 1)throw new AppError('The alert source changed.',409,'COUNTRY_ADMIN_SOURCE_CHANGED');
  }
  for(const market of markets) {
    const result=await CountrySetting.updateOne({_id:market._id,active:true,currency:market.currency,timeZone:market.timeZone,__v:market.__v || 0},{$inc:{__v:1}},{session,timestamps:false});
    if(result.modifiedCount !== 1)throw new AppError('The alert market changed.',409,'COUNTRY_ADMIN_SOURCE_CHANGED');
  }
  let count=0;
  for(const recipient of recipients) {
    const actorFence=await User.updateOne({_id:recipient._id,role:recipient.role,status:'active',platformAccessManagedAt:mongoose.trusted({$type:'date'}),__v:recipient.__v || 0,
      emailVerifiedAt:mongoose.trusted({$type:'date'}),phoneVerifiedAt:mongoose.trusted({$type:'date'}),onboardingCompletedAt:mongoose.trusted({$type:'date'}),'security.mfaEnabled':true,'security.tokenVersion':recipient.security.tokenVersion,[preference]:mongoose.trusted({$ne:false})},{$inc:{__v:1}},{session,timestamps:false});
    if(actorFence.modifiedCount !== 1)continue;
    const grantFence=await PlatformGrant.updateOne({_id:recipient.grant._id,userId:recipient._id,role:'country_admin',status:'active',startsAt:mongoose.trusted({$lte:new Date()}),expiresAt:mongoose.trusted({$gt:new Date()}),__v:recipient.grant.__v || 0},{$inc:{__v:1}},{session,timestamps:false});
    if(grantFence.modifiedCount !== 1)continue;
    await Notification.create([{publicId:publicId('ntf'),userId:recipient._id,country,type:'country_admin_work',
      title:kind === 'priority'?'High risk Country Admin work awaiting review':'Country Admin appeal or dispute awaiting review',
      body:'A recorded marketplace source requires independent review in your authorized country.',importance:kind === 'priority'?'high':'normal',
      href:source.path+'?'+new URLSearchParams({record:sourcePublicId,country})}],{session});count++;
  }
  return count;
}

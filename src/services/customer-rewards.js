import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { CustomerReward } from '../models/CustomerReward.js';
import { CountrySetting } from '../models/CountrySetting.js';
import { User } from '../models/User.js';
import { LoyaltyAccount } from '../models/LoyaltyAccount.js';
import { LedgerTransaction } from '../models/LedgerTransaction.js';
import { Shipment } from '../models/Shipment.js';
import { Refund } from '../models/Refund.js';
import { PaymentIntent } from '../models/PaymentIntent.js';
import { ensureLoyaltyAccount, addLoyaltyPoints, assertLoyaltyBenefitsAvailable } from './loyalty.js';
import { customerClubSummary } from './customer-club.js';

const transaction=session=>{if(!session?.inTransaction?.())throw new AppError('Reward movement requires an active transaction.',500,'REWARD_TRANSACTION_REQUIRED');};
const integer=(value,min=0)=>Number.isSafeInteger(Number(value))&&Number(value)>=min;
export function marketRewardCatalogue(setting){
  if(!setting?.growth?.loyaltyEnabled)return [];
  const catalogue=(setting.growth.rewardCatalogue||[]).filter(row=>row.enabled!==false).map(row=>typeof row.toObject==='function'?row.toObject():{...row});
  const keys=new Set();
  for(const row of catalogue){
    if(!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(row.key||'')||keys.has(row.key)||!['voucher','shipping','gold_trial'].includes(row.kind)||!row.label||!integer(row.pointsCost,1)||!integer(row.validDays,1)||row.validDays>365||!['valueMinor','minimumSpendMinor','maximumDiscountMinor'].every(field=>integer(row[field]||0))||!integer(row.multiplierBps||10000,10000)||Number(row.multiplierBps||10000)>50000||!integer(row.trialShippingDiscountBps||0)||Number(row.trialShippingDiscountBps||0)>10000||(row.kind!=='gold_trial'&&Number(row.valueMinor||row.maximumDiscountMinor||0)<=0))throw new AppError('The market reward policy requires review.',409,'REWARD_POLICY_INVALID');
    keys.add(row.key);
  }
  return catalogue;
}
export async function rewardMarketActor(user,country,currency,session){
  const actor=await User.findById(user?._id).select('status role security.tokenVersion').session(session||null);
  const setting=await CountrySetting.findOne({code:country,currency,active:true}).session(session||null);
  if(!actor||actor.status!=='active'||Number(actor.security?.tokenVersion||0)!==Number(user?.security?.tokenVersion||0))throw new AppError('Your account or session is unavailable.',403,'ACCOUNT_UNAVAILABLE');
  if(!setting)throw new AppError('The reward market is unavailable.',409,'REWARD_MARKET_UNAVAILABLE');
  if(session?.inTransaction?.()){
    const userFence=await User.updateOne({_id:actor._id,status:'active','security.tokenVersion':actor.security.tokenVersion},{$inc:{rewardReadRevision:1}},{session});
    const marketFence=await CountrySetting.updateOne({_id:setting._id,__v:setting.__v||0,active:true,currency},{$inc:{__v:1}},{session});
    if(userFence.modifiedCount!==1||marketFence.modifiedCount!==1)throw new AppError('Account or reward policy changed. Refresh and retry.',409,'REWARD_SOURCE_CHANGED');
  }
  return setting;
}
function publicReward(row){return {publicId:row.publicId,rewardKey:row.rewardKey,label:row.label,kind:row.kind,pointsCost:row.pointsCost,valueMinor:row.valueMinor,minimumSpendMinor:row.minimumSpendMinor,maximumDiscountMinor:row.maximumDiscountMinor,status:row.status,expiresAt:row.expiresAt,orderPublicId:row.orderPublicId||'',multiplierBps:row.multiplierBps,trialShippingDiscountBps:row.trialShippingDiscountBps};}
export async function customerRewardSummary({userId,country,currency,setting=null,session=null}){
  const policy=setting||await CountrySetting.findOne({code:country,currency,active:true}).session(session).lean();
  const account=await LoyaltyAccount.findOne({userId,country}).session(session).lean();
  const rewards=await CustomerReward.find({userId,country,currency,status:{$in:['issued','reserved','used']},expiresAt:{$gt:new Date()}}).sort({createdAt:-1}).limit(100).session(session).lean();
  const debt=Number(account?.reversalDebtPoints||0);
  return {account:account||{points:0,lifetimeEarned:0,lifetimeRedeemed:0,reversalDebtPoints:0,tier:'classic'},rewards:rewards.map(publicReward),catalogue:marketRewardCatalogue(policy).map(row=>({...row,available:!debt&&Number(account?.points||0)>=row.pointsCost})),club:customerClubSummary(account,0,policy),activeGoldTrial:rewards.find(row=>row.kind==='gold_trial'&&row.status==='used')?publicReward(rewards.find(row=>row.kind==='gold_trial'&&row.status==='used')):null,benefitsPaused:debt>0};
}
export async function redeemCustomerReward(input,providedSession=null){
  if(!providedSession){const session=await mongoose.startSession();try{return await session.withTransaction(()=>redeemCustomerReward(input,session));}finally{await session.endSession();}}
  transaction(providedSession);const session=providedSession,{user,country,currency,rewardKey}=input;
  if(!/^[A-Za-z0-9:_-]{8,120}$/.test(input.idempotencyKey||''))throw new AppError('A reward request reference is required.',422,'REWARD_IDEMPOTENCY_REQUIRED');
  const setting=await rewardMarketActor(user,country,currency,session),key=`reward:${user._id}:${input.idempotencyKey}`;
  const existing=await CustomerReward.findOne({idempotencyKey:key}).session(session);
  if(existing){if(existing.country!==country||existing.currency!==currency||existing.rewardKey!==rewardKey)throw new AppError('Reward request reference was already used.',409,'REWARD_IDEMPOTENCY_CONFLICT');return existing;}
  const account=await ensureLoyaltyAccount(user._id,country,session);assertLoyaltyBenefitsAvailable(account);
  const selected=marketRewardCatalogue(setting).find(row=>row.key===rewardKey);if(!selected)throw new AppError('This reward is not currently available.',409,'REWARD_UNAVAILABLE');
  if(selected.kind==='gold_trial'&&await CustomerReward.exists({userId:user._id,country,currency,kind:'gold_trial',expiresAt:{$gt:new Date()},status:{$in:['issued','used']}}).session(session))throw new AppError('A Gold trial is already active.',409,'GOLD_TRIAL_ACTIVE');
  const rewardId=publicId('rwd');await addLoyaltyPoints({userId:user._id,country,points:-selected.pointsCost,idempotencyKey:`redeem:${rewardId}`,type:'reward_redeem',referenceType:'customer_reward',referencePublicId:rewardId,reason:selected.label},session);
  const [reward]=await CustomerReward.create([{publicId:rewardId,idempotencyKey:key,userId:user._id,country,currency,rewardKey,label:selected.label,kind:selected.kind,pointsCost:selected.pointsCost,valueMinor:Number(selected.valueMinor||0),minimumSpendMinor:Number(selected.minimumSpendMinor||0),maximumDiscountMinor:Number(selected.maximumDiscountMinor||0),multiplierBps:Number(selected.multiplierBps||10000),trialShippingDiscountBps:Number(selected.trialShippingDiscountBps||0),status:selected.kind==='gold_trial'?'used':'issued',...(selected.kind==='gold_trial'?{consumedAt:new Date()}:{}),expiresAt:new Date(Date.now()+selected.validDays*86400000)}],{session});return reward;
}
export async function reserveOrderReward(order,session){
  transaction(session);const rewardId=order.fundingSnapshot?.rewardPublicId;if(!rewardId)return null;
  const account=await ensureLoyaltyAccount(order.userId,order.country,session);assertLoyaltyBenefitsAvailable(account);account.increment();account.markModified('points');await account.save({session});
  const reward=await CustomerReward.findOne({publicId:rewardId,userId:order.userId,country:order.country,currency:order.totals.currency,kind:{$in:['voucher','shipping']},expiresAt:{$gt:new Date()},$or:[{status:'issued'},{status:'reserved',orderPublicId:order.publicId}]}).session(session);
  if(!reward)throw new AppError('The selected reward is no longer available.',409,'REWARD_UNAVAILABLE');
  const expected=Number(order.fundingSnapshot.rewardGoodsMinor||0)+Number(order.fundingSnapshot.rewardShippingMinor||0);
  if(expected<=0||expected>Number(reward.maximumDiscountMinor||reward.valueMinor)||reward.kind==='voucher'&&Number(order.fundingSnapshot.rewardShippingMinor||0)>0||reward.kind==='shipping'&&Number(order.fundingSnapshot.rewardGoodsMinor||0)>0)throw new AppError('Reward funding does not match its original issued value.',409,'REWARD_FUNDING_INVALID');
  reward.status='reserved';reward.orderPublicId=order.publicId;await reward.save({session});return reward;
}
export async function consumeOrderReward(order,session){
  transaction(session);const rewardId=order.fundingSnapshot?.rewardPublicId;if(!rewardId)return null;
  // Eligibility was committed with the order reservation. Later point recovery
  // must not block reconciliation of cash already independently received.
  const reward=await CustomerReward.findOne({publicId:rewardId,userId:order.userId,country:order.country,currency:order.totals.currency,orderPublicId:order.publicId,status:{$in:['reserved','used']}}).session(session);
  if(!reward)throw new AppError('The original order reward reservation is missing.',409,'REWARD_RESERVATION_MISSING');
  if(reward.status==='used')return reward;reward.status='used';reward.consumedAt=new Date();await reward.save({session});return reward;
}
export async function releaseOrderReward(order,session){
  transaction(session);const rewardId=order.fundingSnapshot?.rewardPublicId;if(!rewardId)return null;
  if(await PaymentIntent.exists({orderId:order._id,status:{$in:['succeeded','partially_refunded','refunded','reversed']}}).session(session))throw new AppError('A paid reward can only be restored through confirmed reversal.',409,'REWARD_RELEASE_PAID');
  const reward=await CustomerReward.findOne({publicId:rewardId,userId:order.userId,country:order.country,currency:order.totals.currency,orderPublicId:order.publicId,status:'reserved'}).session(session);if(!reward)return null;
  reward.status=reward.expiresAt<=new Date()?'expired':'issued';reward.orderPublicId='';await reward.save({session});return reward;
}
export async function restoreOrderRewardAfterRefund(order,intent,session){
  transaction(session);if(!order.fundingSnapshot?.rewardPublicId)return null;
  const refunds=await Refund.find({orderId:order._id,paymentIntentId:intent._id,status:'completed'}).select('publicId amountMinor').session(session).lean();
  if(refunds.reduce((sum,row)=>sum+Number(row.amountMinor),0)!==Number(order.totals.totalMinor))return null;
  const shipments=intent.provider==='cod'?await Shipment.find({orderId:order._id,kind:'outbound'}).select('publicId').session(session).lean():[];
  const original=await LedgerTransaction.findOne(intent.provider==='cod'?{referenceType:'cod_reconciliation',idempotencyKey:{$in:shipments.map(row=>`cod:${row.publicId}`)}}:{idempotencyKey:`payment:${intent.publicId}`}).session(session).lean();
  if(!original)throw new AppError('Original reward-funded settlement is missing.',409,'REWARD_SETTLEMENT_MISSING');
  const net=new Map();const apply=tx=>{for(const entry of tx.entries)net.set(String(entry.accountId),(net.get(String(entry.accountId))||0)+Number(entry.debitMinor)-Number(entry.creditMinor));};apply(original);
  for(const refund of refunds){const tx=await LedgerTransaction.findOne({idempotencyKey:`refund:${refund.publicId}`}).session(session).lean();if(!tx)throw new AppError('Confirmed refund ledger is missing.',409,'REWARD_SETTLEMENT_MISSING');apply(tx);}
  // Delivery revenue/expense remaining after goods returns means the original
  // shipping benefit has been consumed. Cash totals alone cannot restore it.
  if([...net.values()].some(value=>value!==0))return null;
  const reward=await CustomerReward.findOne({publicId:order.fundingSnapshot.rewardPublicId,userId:order.userId,country:order.country,currency:order.totals.currency,orderPublicId:order.publicId,status:'used'}).session(session);if(!reward)return null;
  reward.status=reward.expiresAt<=new Date()?'expired':'issued';reward.orderPublicId='';reward.restoredAt=new Date();await reward.save({session});return reward;
}

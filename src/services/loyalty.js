import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { LoyaltyAccount } from '../models/LoyaltyAccount.js';
import { LoyaltyEntry } from '../models/LoyaltyEntry.js';
import { Order } from '../models/Order.js';
import { Refund } from '../models/Refund.js';
import { Referral } from '../models/Referral.js';
import { Chargeback } from '../models/Chargeback.js';
import { PaymentIntent } from '../models/PaymentIntent.js';

export const loyaltyTier=earned=>earned>=5000?'gold':earned>=1000?'silver':'classic';
const nonnegative=value=>Number.isSafeInteger(value)&&value>=0;
function transaction(session){if(!session?.inTransaction?.())throw new AppError('Loyalty movement requires an active transaction.',500,'LOYALTY_TRANSACTION_REQUIRED');}
export async function ensureLoyaltyAccount(userId,country,session){
  if(!userId||!/^[A-Z]{2}$/.test(country||''))throw new AppError('Loyalty market is invalid.',422,'LOYALTY_MARKET_INVALID');
  let account=await LoyaltyAccount.findOne({userId,country}).session(session||null);
  if(!account){const [created]=await LoyaltyAccount.create([{publicId:publicId('loy'),userId,country}],session?{session}:undefined);account=created;}
  if(!['points','lifetimeEarned','lifetimeRedeemed'].every(field=>nonnegative(Number(account[field])))||!nonnegative(Number(account.reversalDebtPoints||0)))throw new AppError('Loyalty account requires reconciliation.',409,'LOYALTY_ACCOUNT_INVALID');
  return account;
}
export function assertLoyaltyBenefitsAvailable(account){if(Number(account?.reversalDebtPoints||0)>0)throw new AppError('Rewards are paused while reversed purchase points are being recovered.',409,'LOYALTY_REVERSAL_DEBT');}
export async function addLoyaltyPoints({userId,country,points,idempotencyKey,type,referenceType='',referencePublicId='',reason='',actorUserId},session){
  transaction(session);if(!userId||!points)return null;
  if(!Number.isSafeInteger(points)||!idempotencyKey)throw new AppError('Loyalty movement is invalid.',422,'LOYALTY_MOVEMENT_INVALID');
  const existing=await LoyaltyEntry.findOne({idempotencyKey}).session(session);
  if(existing){if(String(existing.userId)!==String(userId)||existing.country!==country||existing.type!==type||existing.referenceType!==referenceType||existing.referencePublicId!==referencePublicId||(points>0?Number(existing.earnedPoints||existing.pointsDelta):Number(existing.pointsDelta))!==points)throw new AppError('Loyalty movement reference conflicts.',409,'LOYALTY_IDEMPOTENCY_CONFLICT');return existing;}
  const account=await ensureLoyaltyAccount(userId,country,session);let delta=points,debtDelta=0;
  if(points>0){const repaid=Math.min(points,Number(account.reversalDebtPoints||0));delta-=repaid;debtDelta=repaid?-repaid:0;account.reversalDebtPoints=Number(account.reversalDebtPoints||0)-repaid;account.lifetimeEarned+=points;}
  else{assertLoyaltyBenefitsAvailable(account);if(account.points+points<0)throw new AppError('Loyalty balance is insufficient.',409,'LOYALTY_BALANCE');account.lifetimeRedeemed+=-points;}
  account.points+=delta;account.tier=loyaltyTier(account.lifetimeEarned);await account.save({session});
  const [entry]=await LoyaltyEntry.create([{publicId:publicId('loe'),idempotencyKey,userId,country,type,pointsDelta:delta,earnedPoints:Math.max(0,points),balanceAfter:account.points,debtDelta,debtAfter:account.reversalDebtPoints,referenceType,referencePublicId,reason,actorUserId}],{session});return entry;
}

function originalEarned(entry){const points=Number(entry.earnedPoints||entry.pointsDelta||0);if(!nonnegative(points))throw new AppError('Original loyalty earning is invalid.',409,'LOYALTY_EARNING_INVALID');return points;}
async function reverseEarning(earning,{targetPoints,type,referencePublicId,refundPublicId='',chargebackPublicId=''},session){
  const original=originalEarned(earning);
  const prior=await LoyaltyEntry.find({reversalOfEntryPublicId:earning.publicId,type:{$in:['order_refund','referral_refund','order_chargeback','referral_chargeback']}}).session(session).lean();
  let reversed=0;for(const entry of prior){if(String(entry.userId)!==String(earning.userId)||entry.country!==earning.country||!nonnegative(Number(entry.reversedPoints)))throw new AppError('Loyalty reversal lineage is invalid.',409,'LOYALTY_REVERSAL_INVALID');reversed+=Number(entry.reversedPoints);}
  if(!nonnegative(targetPoints)||targetPoints>original||reversed>original)throw new AppError('Loyalty reversal exceeds original earning.',409,'LOYALTY_REVERSAL_INVALID');
  const amount=Math.max(0,targetPoints-reversed);if(!amount)return null;
  const idempotencyKey=`${chargebackPublicId?'chargeback':'refund'}:${chargebackPublicId||refundPublicId}:${earning.publicId}`;
  if(await LoyaltyEntry.exists({idempotencyKey}).session(session))return null;
  const account=await ensureLoyaltyAccount(earning.userId,earning.country,session),available=Math.min(account.points,amount),debt=amount-available;
  if(account.lifetimeEarned<amount)throw new AppError('Loyalty lifetime earning is inconsistent.',409,'LOYALTY_LIFETIME_INVALID');
  account.points-=available;account.reversalDebtPoints=Number(account.reversalDebtPoints||0)+debt;account.lifetimeEarned-=amount;account.tier=loyaltyTier(account.lifetimeEarned);await account.save({session});
  const [entry]=await LoyaltyEntry.create([{publicId:publicId('loe'),idempotencyKey,userId:earning.userId,country:earning.country,type,pointsDelta:available?-available:0,balanceAfter:account.points,earnedPoints:0,reversedPoints:amount,debtDelta:debt,debtAfter:account.reversalDebtPoints,reversalOfEntryPublicId:earning.publicId,refundPublicId,chargebackPublicId,referenceType:chargebackPublicId?'chargeback':'refund',referencePublicId,reason:'Reverse original verified purchase earning'}],{session});return entry;
}

async function reverseOrderAndReferrals(order,{completedMinor,earnedReversedMinor=null,refundPublicId='',chargebackPublicId=''},session){
  if(!order.userId)return;
  const base=Number(order.totals?.totalMinor||0);if(!Number.isSafeInteger(base)||base<=0||!nonnegative(completedMinor)||completedMinor>base)throw new AppError('Loyalty reversal cash basis is invalid.',409,'LOYALTY_REVERSAL_BASIS');
  const earning=await LoyaltyEntry.findOne({idempotencyKey:`order:${order.publicId}:loyalty`,type:'order_earn',userId:order.userId,country:order.country,referencePublicId:order.publicId}).session(session);
  if(earning){const earningBase=order.loyaltySnapshot?.eligibleMinor===undefined?base:Number(order.loyaltySnapshot.eligibleMinor),reversedBasis=earnedReversedMinor===null?earningBase:Math.min(earningBase,earnedReversedMinor);if(!nonnegative(earningBase)||!nonnegative(reversedBasis))throw new AppError('Loyalty earning basis is invalid.',409,'LOYALTY_REVERSAL_BASIS');const target=earningBase===0?0:Number(BigInt(originalEarned(earning))*BigInt(reversedBasis)/BigInt(earningBase));await reverseEarning(earning,{targetPoints:target,type:chargebackPublicId?'order_chargeback':'order_refund',referencePublicId:chargebackPublicId||refundPublicId,refundPublicId,chargebackPublicId},session);}
  if(completedMinor!==base)return;
  // Referral bonuses are independent of the order-earning programme and its
  // current settings. Always recover actual immutable original entries.
  const referral=await Referral.findOne({qualifiedOrderPublicId:order.publicId,country:order.country,status:{$in:['rewarded','rejected']}}).session(session);
  if(!referral)return;
  if(String(referral.referredUserId)!==String(order.userId)||String(referral.referrerUserId)===String(order.userId))throw new AppError('Original referral ownership does not match the qualified purchase.',409,'LOYALTY_REFERRAL_SOURCE_INVALID');
  for(const side of ['referrer','referred']){
    const expectedUserId=side==='referrer'?referral.referrerUserId:order.userId;
    const original=await LoyaltyEntry.findOne({idempotencyKey:`referral:${referral.publicId}:${side}`,type:'referral_earn',userId:expectedUserId,country:order.country,referencePublicId:referral.publicId}).session(session);
    if(!original&&Number(referral[side+'RewardPoints']||0)>0)throw new AppError('Original referral earning is missing or belongs to another account.',409,'LOYALTY_REFERRAL_SOURCE_INVALID');
    if(original)await reverseEarning(original,{targetPoints:originalEarned(original),type:chargebackPublicId?'referral_chargeback':'referral_refund',referencePublicId:chargebackPublicId||refundPublicId,refundPublicId,chargebackPublicId},session);
  }
  if(referral.status!=='rejected'){referral.status='rejected';await referral.save({session});}
}

export async function reverseGrowthForRefund(orderLike,refundLike,session){
  transaction(session);const order=await Order.findById(orderLike._id).session(session),refund=await Refund.findOne({_id:refundLike._id,orderId:orderLike._id,status:'completed'}).session(session);
  if(!order||!refund||refund.currency!==order.totals.currency)throw new AppError('Completed refund evidence is required for loyalty reversal.',409,'LOYALTY_REFUND_PROOF');
  const refunds=await Refund.find({orderId:order._id,status:'completed'}).select('amountMinor currency allocations').session(session).lean();
  if(refunds.some(row=>row.currency!==order.totals.currency))throw new AppError('Refund market changed.',409,'LOYALTY_REFUND_PROOF');
  const completedMinor=refunds.reduce((sum,row)=>sum+Number(row.amountMinor),0),eligible=Number(order.loyaltySnapshot?.eligibleMinor??order.totals.totalMinor);
  const earnedReversedMinor=completedMinor===Number(order.totals.totalMinor)?eligible:refunds.reduce((sum,row)=>sum+(row.allocations||[]).reduce((part,allocation)=>part+Number(allocation.grossMinor||0),0),0);
  await reverseOrderAndReferrals(order,{completedMinor,earnedReversedMinor,refundPublicId:refund.publicId},session);
}

export async function reverseGrowthForLostChargeback(chargebackLike,session){
  transaction(session);const chargeback=await Chargeback.findOne({_id:chargebackLike._id,publicId:chargebackLike.publicId,status:'lost',provider:'pesapal'}).session(session);
  if(!chargeback||!(chargeback.reviewedAt instanceof Date)||!(chargeback.resolvedAt instanceof Date)||!chargeback.reviewedByUserId||!chargeback.resolvedByUserId||String(chargeback.reviewedByUserId)===String(chargeback.resolvedByUserId))throw new AppError('An independently resolved lost chargeback is required.',409,'LOYALTY_CHARGEBACK_PROOF');
  const order=await Order.findById(chargeback.orderId).session(session),intent=await PaymentIntent.findById(chargeback.paymentIntentId).session(session);
  if(!order||!intent||order.paymentState!=='failed'||intent.provider!=='pesapal'||intent.providerStatus!=='REVERSED'||!(intent.lastVerifiedAt instanceof Date)||String(intent.orderId)!==String(order._id)||intent.orderPublicId!==order.publicId||chargeback.paymentIntentPublicId!==intent.publicId||!intent.providerTrackingId||chargeback.providerTrackingId!==intent.providerTrackingId||chargeback.reviewedAt>chargeback.resolvedAt||chargeback.orderPublicId!==order.publicId||order.country!==chargeback.country||intent.country!==order.country||intent.currency!==order.totals.currency||chargeback.currency!==intent.currency||intent.amountMinor!==order.totals.totalMinor)throw new AppError('Chargeback provider evidence does not match the original order.',409,'LOYALTY_CHARGEBACK_PROOF');
  await reverseOrderAndReferrals(order,{completedMinor:Number(order.totals.totalMinor),chargebackPublicId:chargeback.publicId},session);
}

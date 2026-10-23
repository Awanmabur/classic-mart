import { AppError } from '../core/errors.js';
import { CustomerReward } from '../models/CustomerReward.js';
import { LoyaltyAccount } from '../models/LoyaltyAccount.js';
import { assertLoyaltyBenefitsAvailable, ensureLoyaltyAccount } from './loyalty.js';
import { rewardMarketActor } from './customer-rewards.js';

const integer=value=>Number.isSafeInteger(Number(value))&&Number(value)>=0;
const share=(amount,bps)=>Number(BigInt(amount)*BigInt(bps)/10000n);
/** The quote contains only reviewed, executable benefits for the exact market. */
export async function quoteCheckoutBenefits({user,country,currency,subtotalMinor,shippingMinor,deliveryMethod='standard',rewardPublicId='',goodsCashFloorMinor=1,maximumGoodsDiscountMinor=null,session=null}){
  if(![subtotalMinor,shippingMinor,goodsCashFloorMinor].every(integer)||maximumGoodsDiscountMinor!==null&&!integer(maximumGoodsDiscountMinor))throw new AppError('Reward quote amounts are invalid.',422,'REWARD_QUOTE_INVALID');
  const empty={fundingSnapshot:{rewardPublicId:'',rewardGoodsMinor:0,rewardShippingMinor:0,clubShippingMinor:0,totalMinor:0,grossShippingMinor:Number(shippingMinor)},loyaltySnapshot:{enabled:false,pointsPer1000Minor:0,multiplierBps:10000,eligibleMinor:Number(subtotalMinor),tier:'classic',trialRewardPublicId:''},reward:null,club:null};
  if(!user?._id){if(rewardPublicId)throw new AppError('Sign in to use a reward.',401,'REWARD_LOGIN_REQUIRED');return empty;}
  const policy=await rewardMarketActor(user,country,currency,session);
  const account=session?.inTransaction?.()?await ensureLoyaltyAccount(user._id,country,session):await LoyaltyAccount.findOne({userId:user._id,country}).session(session).lean();
  const benefitsPaused=Number(account?.reversalDebtPoints||0)>0;
  // Reversed points pause benefits rather than purchases. A cash purchase can
  // earn the base points that repay the debt, without a trial/tier multiplier.
  if(rewardPublicId)assertLoyaltyBenefitsAvailable(account);
  if(session?.inTransaction?.()){account.increment();account.markModified('points');await account.save({session});}
  const tier=account?.tier||'classic',benefit=benefitsPaused?null:(policy.growth?.clubBenefits||[]).find(row=>row.tier===tier);
  let multiplier=Number(benefit?.multiplierBps||10000),clubBps=Number(benefit?.standardShippingDiscountBps||0);
  if(!integer(multiplier)||multiplier<10000||multiplier>50000||!integer(clubBps)||clubBps>10000)throw new AppError('Club policy requires review.',409,'CLUB_POLICY_INVALID');
  const trial=benefitsPaused?null:await CustomerReward.findOne({userId:user._id,country,currency,kind:'gold_trial',status:'used',expiresAt:{$gt:new Date()}}).sort({expiresAt:-1}).session(session);
  if(trial){if(!integer(trial.multiplierBps)||trial.multiplierBps<10000||trial.multiplierBps>50000||!integer(trial.trialShippingDiscountBps)||trial.trialShippingDiscountBps>10000)throw new AppError('The original Club trial requires review.',409,'CLUB_POLICY_INVALID');multiplier=Math.max(multiplier,trial.multiplierBps);clubBps=Math.max(clubBps,trial.trialShippingDiscountBps);if(session?.inTransaction?.()){trial.increment();trial.markModified('status');await trial.save({session});}}
  const clubShippingMinor=deliveryMethod==='standard'&&Number(subtotalMinor)>=Number(benefit?.minimumSpendMinor||0)?share(Number(shippingMinor),clubBps):0;
  let reward=null,rewardGoodsMinor=0,rewardShippingMinor=0;
  if(rewardPublicId){
    reward=await CustomerReward.findOne({publicId:rewardPublicId,userId:user._id,country,currency,status:'issued',expiresAt:{$gt:new Date()},kind:{$in:['voucher','shipping']}}).session(session).lean();
    if(!reward)throw new AppError('This reward is unavailable for the selected market.',409,'REWARD_UNAVAILABLE');
    if(Number(subtotalMinor)<reward.minimumSpendMinor)throw new AppError('This order does not reach the reward minimum spend.',422,'REWARD_MINIMUM_SPEND');
    const value=Number(reward.maximumDiscountMinor||reward.valueMinor||0);
    if(reward.kind==='voucher')rewardGoodsMinor=Math.min(value,Math.max(0,Number(subtotalMinor)-Number(goodsCashFloorMinor)),maximumGoodsDiscountMinor===null?Number.MAX_SAFE_INTEGER:Number(maximumGoodsDiscountMinor));
    else rewardShippingMinor=Math.min(value,Number(shippingMinor)-clubShippingMinor);
    if(rewardGoodsMinor+rewardShippingMinor<=0)throw new AppError('This reward has no eligible value for this order.',422,'REWARD_NOT_APPLICABLE');
  }
  const rate=Number(policy.growth?.loyaltyPointsPer1000Minor||0);if(!integer(rate))throw new AppError('Loyalty rate requires review.',409,'LOYALTY_POLICY_INVALID');
  return {fundingSnapshot:{rewardPublicId:reward?.publicId||'',rewardGoodsMinor,rewardShippingMinor,clubShippingMinor,totalMinor:rewardGoodsMinor+rewardShippingMinor+clubShippingMinor,grossShippingMinor:Number(shippingMinor)},loyaltySnapshot:{enabled:Boolean(policy.growth?.loyaltyEnabled),pointsPer1000Minor:rate,multiplierBps:multiplier,eligibleMinor:Number(subtotalMinor)-rewardGoodsMinor,tier:benefitsPaused?'classic':trial?'gold':tier,trialRewardPublicId:trial?.publicId||''},reward,club:benefit||null,benefitsPaused};
}
export function allocateRewardGoodsMinor(amountMinor,lines){
  if(!integer(amountMinor))throw new AppError('Reward goods funding is invalid.',422,'REWARD_QUOTE_INVALID');
  const weights=lines.map(line=>Math.max(0,Number(line.customerPaidMinor??line.lineTotalMinor)-Number(line.quantity||1))),total=weights.reduce((sum,value)=>sum+value,0);
  if(!Number.isSafeInteger(total)||weights.some(value=>!integer(value))||amountMinor>total)throw new AppError('Reward must leave at least one cash minor unit per purchased unit.',422,'REWARD_CASH_FLOOR');
  let seen=0,allocated=0;return weights.map(weight=>{seen+=weight;const target=total?Number(BigInt(amountMinor)*BigInt(seen)/BigInt(total)):0,part=target-allocated;allocated=target;return part;});
}

import { Router } from 'express';
import { customerView } from '../dashboard/customer-view.js';
import { accountWorkspaceView } from '../dashboard/account-workspace-view.js';
import { primaryWorkspaceFor } from '../dashboard/access.js';
import { asyncHandler } from '../core/errors.js';
import { requireAuth, requireOnboarding, requireVerified } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { LoyaltyAccount, LoyaltyEntry, Referral } from '../models/index.js';
import { ensureReferralCode, redeemGiftCard } from '../services/stage9.js';
import { setFlash } from '../middleware/view.js';
import { writeAudit } from '../services/audit.js';
import { cursorScope, cursorSort, pageResult } from '../services/pagination.js';
import { z } from 'zod';
import { currentCustomerAccess, customerTransaction } from '../services/customer-access.js';
import { redeemCustomerReward } from '../services/customer-rewards.js';

const router=Router();
router.use('/account/rewards',noStore,requireAuth,requireVerified,requireOnboarding);
router.get('/account/rewards',asyncHandler(async(req,res)=>{
  await currentCustomerAccess(req);
  const referral=await ensureReferralCode(req.user,{country:req.country.code});
  const pageSize=40,entryBase={userId:req.user._id,country:req.country.code},referralBase={referrerUserId:req.user._id,country:req.country.code,referredUserId:{$ne:null}};
  const [account,entryRows,referralRows,entryTotal,referralTotal]=await Promise.all([
    LoyaltyAccount.findOne({userId:req.user._id,country:req.country.code}).lean(),
    LoyaltyEntry.find(cursorScope(entryBase,req.query.entriesAfter)).sort(cursorSort()).limit(pageSize+1).lean(),
    Referral.find(cursorScope(referralBase,req.query.referralsAfter)).populate('referredUserId','name publicId').sort(cursorSort()).limit(pageSize+1).lean(),
    LoyaltyEntry.countDocuments(entryBase),Referral.countDocuments(referralBase),
  ]);
  const entryPage=pageResult(entryRows,{limit:pageSize,total:entryTotal}),referralPage=pageResult(referralRows,{limit:pageSize,total:referralTotal});
  const shell = primaryWorkspaceFor(req.user) !== 'customer' || req.session?.activeStorePublicId
    ? await accountWorkspaceView(req, 'rewards')
    : { workspace: 'customer', initialPage: 'rewards', allowedWorkspaces: ['customer'], ...await customerView(req, 'rewards'), accountSupplement: 'rewards' };
  res.render('approved-dashboard', { ...shell,account,entries:entryPage.items,referral,referrals:referralPage.items,queuePages:{entries:entryPage.page,referrals:referralPage.page}});
}));
router.post('/account/rewards/redeem',asyncHandler(async(req,res)=>{
  const input=z.object({rewardKey:z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),idempotencyKey:z.string().trim().min(8).max(120)}).parse(req.body);
  const reward=await customerTransaction(async session=>{
    const actor=await currentCustomerAccess(req,{session,write:true});
    const row=await redeemCustomerReward({user:actor,country:req.country.code,currency:req.country.currency,...input},session);
    await writeAudit(req,'customer.reward_redeemed',{session,targetType:'customer_reward',targetPublicId:row.publicId,country:req.country.code,metadata:{rewardKey:row.rewardKey,kind:row.kind,pointsCost:row.pointsCost}});
    return row;
  });
  setFlash(req,'success',`${reward.label} is ready. View its expiry and availability below.`);
  res.redirect(303,String(req.body.returnTo||'')==='/rewards'?'/rewards':'/account/rewards');
}));
router.post('/account/rewards/gift-card',asyncHandler(async(req,res)=>{
  const result=await redeemGiftCard({user:req.user,code:req.body.code,country:req.country.code,currency:req.country.currency,request:req});
  await writeAudit(req,'growth.gift_card_redeemed',{targetType:'gift_card',targetPublicId:result.card.publicId,country:req.user.country,metadata:{points:result.points}});
  setFlash(req,'success',`Gift card redeemed for ${result.points} reward point(s).`);res.redirect(String(req.body.returnTo||'')==='/dashboard/rewards'?'/dashboard/rewards':'/account/rewards');
}));
export default router;

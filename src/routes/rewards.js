import { Router } from 'express';
import { asyncHandler } from '../core/errors.js';
import { requireAuth, requireOnboarding, requireVerified } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { LoyaltyAccount, LoyaltyEntry, Referral } from '../models/index.js';
import { ensureReferralCode, redeemGiftCard } from '../services/stage9.js';
import { setFlash } from '../middleware/view.js';
import { writeAudit } from '../services/audit.js';
import { cursorScope, cursorSort, pageResult } from '../services/pagination.js';

const router=Router();
router.use('/account/rewards',noStore,requireAuth,requireVerified,requireOnboarding);
router.get('/account/rewards',asyncHandler(async(req,res)=>{
  const referral=await ensureReferralCode(req.user);
  const pageSize=40,entryBase={userId:req.user._id},referralBase={referrerUserId:req.user._id,referredUserId:{$ne:null}};
  const [account,entryRows,referralRows,entryTotal,referralTotal]=await Promise.all([
    LoyaltyAccount.findOne({userId:req.user._id}).lean(),
    LoyaltyEntry.find(cursorScope(entryBase,req.query.entriesAfter)).sort(cursorSort()).limit(pageSize+1).lean(),
    Referral.find(cursorScope(referralBase,req.query.referralsAfter)).populate('referredUserId','name publicId').sort(cursorSort()).limit(pageSize+1).lean(),
    LoyaltyEntry.countDocuments(entryBase),Referral.countDocuments(referralBase),
  ]);
  const entryPage=pageResult(entryRows,{limit:pageSize,total:entryTotal}),referralPage=pageResult(referralRows,{limit:pageSize,total:referralTotal});
  res.render('rewards',{account,entries:entryPage.items,referral,referrals:referralPage.items,queuePages:{entries:entryPage.page,referrals:referralPage.page}});
}));
router.post('/account/rewards/gift-card',asyncHandler(async(req,res)=>{
  const result=await redeemGiftCard({user:req.user,code:req.body.code});
  await writeAudit(req,'growth.gift_card_redeemed',{targetType:'gift_card',targetPublicId:result.card.publicId,country:req.user.country,metadata:{points:result.points}});
  setFlash(req,'success',`Gift card redeemed for ${result.points} reward point(s).`);res.redirect('/account/rewards');
}));
export default router;

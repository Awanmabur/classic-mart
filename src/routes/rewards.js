import { Router } from 'express';
import { asyncHandler } from '../core/errors.js';
import { requireAuth, requireOnboarding, requireVerified } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { LoyaltyAccount, LoyaltyEntry, Referral } from '../models/index.js';
import { ensureReferralCode, redeemGiftCard } from '../services/stage9.js';
import { setFlash } from '../middleware/view.js';
import { writeAudit } from '../services/audit.js';

const router=Router();
router.use('/account/rewards',noStore,requireAuth,requireVerified,requireOnboarding);
router.get('/account/rewards',asyncHandler(async(req,res)=>{
  const referral=await ensureReferralCode(req.user);
  const [account,entries,referrals]=await Promise.all([
    LoyaltyAccount.findOne({userId:req.user._id}).lean(),
    LoyaltyEntry.find({userId:req.user._id}).sort({createdAt:-1}).limit(50).lean(),
    Referral.find({referrerUserId:req.user._id,referredUserId:{$ne:null}}).populate('referredUserId','name publicId').sort({createdAt:-1}).limit(50).lean(),
  ]);
  res.render('rewards',{account,entries,referral,referrals});
}));
router.post('/account/rewards/gift-card',asyncHandler(async(req,res)=>{
  const result=await redeemGiftCard({user:req.user,code:req.body.code});
  await writeAudit(req,'growth.gift_card_redeemed',{targetType:'gift_card',targetPublicId:result.card.publicId,country:req.user.country,metadata:{points:result.points}});
  setFlash(req,'success',`Gift card redeemed for ${result.points} reward point(s).`);res.redirect('/account/rewards');
}));
export default router;

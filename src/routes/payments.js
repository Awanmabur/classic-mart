import { Router } from 'express';
import { z } from 'zod';
import rateLimit from '../middleware/rate-limit.js';
import { AppError } from '../core/errors.js';
import { hasPermission } from '../core/roles.js';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { financeAccess } from '../services/finance-workspace-access.js';
import { PaymentIntent, WalletTopUp } from '../models/index.js';
import { initiatePayment, getPaymentIntentForOrder, verifyAndApplyPayment, processPesapalNotification, requeueProviderEvent, createRefund, completeManualRefund, savePayoutAccount, requestPayout, submitPayout, confirmPayoutSubmission, markPayoutUnknown, reconcilePayout, reconcilePayments, rejectPayout, payoutAccountsForRequest, reviewPayoutAccount, approvePayout } from '../services/payments.js';
import { processWalletPesapalNotification } from '../services/customer-wallet.js';
import { reviewChargeback, resolveChargeback } from '../services/chargebacks.js';

const router=Router();
const financeMutationLimit=rateLimit({ scope: 'payments:1',windowMs:15*60_000,limit:60,standardHeaders:'draft-8',legacyHeaders:false});
router.use('/api/v1/finance',noStore,requireAuth,requireVerified,requireOnboarding,async(req,res,next)=>{
  try{res.set('X-Robots-Tag','noindex, nofollow, noarchive');await financeAccess(req,{workspace:false});verifyDeferredCsrf(req);return req.method==='POST'?financeMutationLimit(req,res,next):next();}catch(error){next(error);}
});
const idem=z.string().trim().min(12).max(120);
router.post('/api/v1/orders/:orderId/payment-intents',async(req,res,next)=>{try{res.status(201).json({payment:await initiatePayment(req,{orderId:req.params.orderId,idempotencyKey:idem.parse(req.body.idempotencyKey)})});}catch(e){next(e);}});

router.get('/api/v1/orders/:orderId/payment',async(req,res,next)=>{try{const {intent}=await getPaymentIntentForOrder(req,req.params.orderId);res.set('Cache-Control','private, no-store').json({payment:intent?{id:intent.publicId,status:intent.status,provider:intent.provider,method:intent.method,amountMinor:intent.amountMinor,currency:intent.currency,paidAt:intent.paidAt}:null});}catch(e){next(e);}});

router.get('/payments/return',async(req,res,next)=>{try{
  const trackingId=String(req.query.OrderTrackingId||req.query.orderTrackingId||'').trim();
  const merchantRef=String(req.query.OrderMerchantReference||req.query.orderMerchantReference||'').trim();
  let intent=merchantRef?await PaymentIntent.findOne({provider:'pesapal',providerReference:merchantRef}):null;
  if(!intent&&trackingId)intent=await PaymentIntent.findOne({provider:'pesapal',providerTrackingId:trackingId});
  if(intent&&trackingId){
    if(intent.providerTrackingId&&intent.providerTrackingId!==trackingId)throw new AppError('Pesapal callback reference mismatch.',400,'PESAPAL_REFERENCE_MISMATCH');
    await verifyAndApplyPayment(intent.publicId,trackingId);
  }
  res.redirect(`/track-order?order=${encodeURIComponent(intent?.orderPublicId||'')}`);
}catch(e){next(e);}});
async function pesapalNotification(req,res,next){try{
  const body=req.body&&typeof req.body==='object'?req.body:{};
  const trackingId=String(req.query.OrderTrackingId||req.query.orderTrackingId||body.OrderTrackingId||body.orderTrackingId||'').trim();
  const merchantRef=String(req.query.OrderMerchantReference||req.query.orderMerchantReference||body.OrderMerchantReference||body.orderMerchantReference||'').trim();
  const notificationType=String(req.query.OrderNotificationType||req.query.orderNotificationType||body.OrderNotificationType||body.orderNotificationType||'IPNCHANGE').trim()||'IPNCHANGE';
  const walletTopUp=merchantRef?await WalletTopUp.findOne({providerReference:merchantRef}).select('_id').lean():null;
  const result=walletTopUp?await processWalletPesapalNotification(req,body,req.query||{}):await processPesapalNotification(req.rawBody||JSON.stringify(body),body,req.query||{});
  res.status(200).json({orderNotificationType:notificationType,orderTrackingId:trackingId,orderMerchantReference:merchantRef,status:200,accepted:true,duplicate:Boolean(result?.duplicate)});
}catch(e){next(e);}}
router.get('/webhooks/pesapal',pesapalNotification);

router.post('/webhooks/pesapal',pesapalNotification);
function financeOnly(req,_res,next){if(hasPermission(req.user,'finance:manage')||hasPermission(req.user,'finance:country')||req.user?.role==='super_admin')return next();return next(new AppError('Finance permission required.',403,'FORBIDDEN'));}
function publicRefund(row){return {publicId:row.publicId,status:row.status,amountMinor:row.amountMinor,currency:row.currency,provider:row.provider,reason:row.reason,createdAt:row.createdAt,completedAt:row.completedAt||null,version:row.__v||0};}
function publicChargeback(row){return {publicId:row.publicId,orderPublicId:row.orderPublicId,paymentIntentPublicId:row.paymentIntentPublicId,country:row.country,currency:row.currency,amountMinor:row.amountMinor,status:row.status,openedAt:row.openedAt,reviewedAt:row.reviewedAt||null,resolvedAt:row.resolvedAt||null,reviewNote:row.reviewNote||'',resolutionNote:row.resolutionNote||''};}

router.post('/api/v1/finance/refunds',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({orderId:z.string().min(4).max(100),amountMinor:z.coerce.number().int().positive().optional(),reason:z.string().trim().min(3).max(300),idempotencyKey:idem,version:z.coerce.number().int().nonnegative().optional(),allocations:z.array(z.object({storePublicId:z.string().trim().min(4).max(100),orderLineId:z.string().trim().min(4).max(100),productPublicId:z.string().trim().max(100).optional(),grossMinor:z.coerce.number().int().positive()})).max(100).optional()}).parse(req.body);res.status(201).json({refund:publicRefund(await createRefund(req,input))});}catch(e){next(e);}});

router.post('/api/v1/finance/refunds/:id/manual-complete',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reference:z.string().trim().min(4).max(180),version:z.coerce.number().int().nonnegative().optional()}).parse(req.body);res.json({refund:publicRefund(await completeManualRefund(req,req.params.id,input))});}catch(e){next(e);}});


router.post('/api/v1/payout-accounts',requireAuth,requireVerified,async(req,res,next)=>{try{const input=z.object({method:z.enum(['mobile_money','bank']),label:z.string().trim().min(2).max(100),destination:z.object({account_bank:z.string().trim().min(2).max(40).optional(),network:z.string().trim().min(2).max(40).optional(),account_number:z.string().trim().min(4).max(80).optional(),phone:z.string().trim().min(7).max(32).optional(),beneficiary_name:z.string().trim().min(2).max(120)}).refine(v=>(v.account_bank||v.network)&&(v.account_number||v.phone),{message:'Bank/network and account/phone are required.'})}).parse(req.body);res.status(201).json({account:await savePayoutAccount(req,input)});}catch(e){next(e);}});

router.get('/api/v1/payout-accounts',requireAuth,requireVerified,async(req,res,next)=>{try{res.json({accounts:await payoutAccountsForRequest(req)});}catch(e){next(e);}});

router.post('/api/v1/payouts',requireAuth,requireVerified,async(req,res,next)=>{try{const input=z.object({payoutAccountId:z.string().min(4).max(100),amountMinor:z.coerce.number().int().positive(),idempotencyKey:idem}).parse(req.body);res.status(201).json({payout:await requestPayout(req,input)});}catch(e){next(e);}});

router.post('/api/v1/finance/payout-accounts/:id/verify',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reason:z.string().trim().min(5).max(300).default('Verified after independent destination review.'),version:z.coerce.number().int().nonnegative().optional()}).parse(req.body||{});await reviewPayoutAccount(req,req.params.id,{...input,decision:'verify'});res.json({ok:true});}catch(e){next(e);}});

router.post('/api/v1/finance/payouts/:id/approve',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reason:z.string().trim().min(5).max(300).default('Approved after independent payout review.'),version:z.coerce.number().int().nonnegative().optional()}).parse(req.body||{});const payout=await approvePayout(req,req.params.id,input);res.json({ok:true,payout});}catch(e){next(e);}});

router.post('/api/v1/finance/payouts/:id/reject',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reason:z.string().trim().min(3).max(300),version:z.coerce.number().int().nonnegative().optional()}).parse(req.body);const payout=await rejectPayout(req,req.params.id,input);res.json({payout});}catch(e){next(e);}});

router.post('/api/v1/finance/reconciliation',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({hours:z.coerce.number().int().min(1).max(168).default(24),country:z.string().regex(/^[A-Z]{2}$/).optional()}).parse(req.body||{});res.status(201).json({run:await reconcilePayments(req,input)});}catch(e){next(e);}});

router.post('/api/v1/finance/provider-events/:id/replay',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reason:z.string().trim().min(5).max(300)}).parse(req.body||{});const event=await requeueProviderEvent(req,req.params.id,input);res.json({event:{id:event.publicId,status:event.status,nextAttemptAt:event.nextAttemptAt,manualReplayCount:event.manualReplayCount}});}catch(e){next(e);}});

router.post('/api/v1/finance/payouts/:id/submit',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({version:z.coerce.number().int().nonnegative().optional()}).parse(req.body||{});const payout=await submitPayout(req,req.params.id,input);res.json({payout});}catch(e){next(e);}});

router.post('/api/v1/finance/payouts/:id/submission-confirm',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reference:z.string().trim().min(4).max(180),version:z.coerce.number().int().nonnegative().optional(),submissionAttemptId:z.string().uuid().optional()}).parse(req.body);const payout=await confirmPayoutSubmission(req,req.params.id,input);res.json({payout});}catch(e){next(e);}});

router.post('/api/v1/finance/payouts/:id/unknown',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reason:z.string().trim().min(8).max(400),version:z.coerce.number().int().nonnegative().optional(),submissionAttemptId:z.string().uuid().optional()}).parse(req.body);const payout=await markPayoutUnknown(req,req.params.id,input);res.json({payout});}catch(e){next(e);}});

router.post('/api/v1/finance/payouts/:id/reconcile',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reference:z.string().trim().min(4).max(180),outcome:z.enum(['paid','failed']),message:z.string().trim().max(400).optional().default(''),version:z.coerce.number().int().nonnegative().optional(),submissionAttemptId:z.string().uuid().optional()}).parse(req.body);const payout=await reconcilePayout(req,req.params.id,{reference:input.reference,success:input.outcome==='paid',message:input.message,version:input.version,submissionAttemptId:input.submissionAttemptId});res.json({payout});}catch(e){next(e);}});



router.post('/api/v1/finance/chargebacks/:id/review',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({note:z.string().trim().max(500).optional().default('')}).parse(req.body||{});res.json({chargeback:publicChargeback(await reviewChargeback(req,req.params.id,input.note))});}catch(e){next(e);}});

router.post('/api/v1/finance/chargebacks/:id/resolve',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({outcome:z.enum(['won','lost']),note:z.string().trim().max(500).optional().default('')}).parse(req.body||{});res.json({chargeback:publicChargeback(await resolveChargeback(req,req.params.id,input))});}catch(e){next(e);}});

export default router;

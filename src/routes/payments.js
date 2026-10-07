import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { hasPermission } from '../core/roles.js';
import { requireAuth, requireVerified } from '../middleware/auth.js';
import { PaymentIntent, LedgerTransaction, LedgerAccount, Order, Refund, PayoutAccount, Payout, ReconciliationRun, Store, Chargeback, ProviderEvent, Shipment, WalletTopUp } from '../models/index.js';
import { initiatePayment, getPaymentIntentForOrder, verifyAndApplyPayment, processPesapalNotification, requeueProviderEvent, createRefund, completeManualRefund, savePayoutAccount, requestPayout, submitPayout, confirmPayoutSubmission, markPayoutUnknown, reconcilePayout, reconcilePayments, rejectPayout, payoutOwnerContext, payoutAccountsForRequest, payoutsForRequest } from '../services/payments.js';
import { moneySummary } from '../services/money.js';
import { processWalletPesapalNotification } from '../services/customer-wallet.js';
import { assertOperationalCountry, operationalCountriesFor } from '../services/authorization.js';
import { reviewChargeback, resolveChargeback } from '../services/chargebacks.js';
import { cursorScope, cursorSort, pageResult } from '../services/pagination.js';
import { writeAudit } from '../services/audit.js';
import { reconcileCod } from '../services/logistics.js';
import { getCountries } from '../services/country.js';
import { sellerFinanceStatement, streamSellerLedgerCsv } from '../services/seller-finance.js';
import { setFlash } from '../middleware/view.js';

const router=Router();
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
function financeCountryScope(user){const scopes=operationalCountriesFor(user);return scopes.includes('*')?{}:{country:{$in:scopes}};}
function csvCell(value){let text=String(value??'');if(/^[=+@-]/.test(text))text=`'${text}`;return `"${text.replaceAll('\"','\"\"')}"`;}

router.post('/api/v1/finance/refunds',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({orderId:z.string().min(4).max(100),amountMinor:z.coerce.number().int().positive().optional(),reason:z.string().trim().min(3).max(300),idempotencyKey:idem}).parse(req.body);res.status(201).json({refund:await createRefund(req,input)});}catch(e){next(e);}});

router.post('/api/v1/finance/refunds/:id/manual-complete',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reference:z.string().trim().min(4).max(180)}).parse(req.body);res.json({refund:await completeManualRefund(req,req.params.id,input)});}catch(e){next(e);}});


router.post('/api/v1/payout-accounts',requireAuth,requireVerified,async(req,res,next)=>{try{const input=z.object({method:z.enum(['mobile_money','bank']),label:z.string().trim().min(2).max(100),destination:z.object({account_bank:z.string().trim().min(2).max(40).optional(),network:z.string().trim().min(2).max(40).optional(),account_number:z.string().trim().min(4).max(80).optional(),phone:z.string().trim().min(7).max(32).optional(),beneficiary_name:z.string().trim().min(2).max(120)}).refine(v=>(v.account_bank||v.network)&&(v.account_number||v.phone),{message:'Bank/network and account/phone are required.'})}).parse(req.body);res.status(201).json({account:await savePayoutAccount(req,input)});}catch(e){next(e);}});

router.get('/api/v1/payout-accounts',requireAuth,requireVerified,async(req,res,next)=>{try{res.json({accounts:await payoutAccountsForRequest(req)});}catch(e){next(e);}});

router.post('/api/v1/payouts',requireAuth,requireVerified,async(req,res,next)=>{try{const input=z.object({payoutAccountId:z.string().min(4).max(100),amountMinor:z.coerce.number().int().positive(),idempotencyKey:idem}).parse(req.body);res.status(201).json({payout:await requestPayout(req,input)});}catch(e){next(e);}});

router.post('/api/v1/finance/payout-accounts/:id/verify',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const account=await PayoutAccount.findOne({publicId:req.params.id});if(account)assertOperationalCountry(req.user,account.country,'Payout account is outside your country scope.');if(!account)throw new AppError('Payout account not found.',404,'PAYOUT_ACCOUNT_NOT_FOUND');account.status='verified';account.verifiedAt=new Date();await account.save();await writeAudit(req,'finance.payout_account_verified',{targetType:'payout_account',targetPublicId:account.publicId,country:account.country,metadata:{status:account.status}});res.json({ok:true});}catch(e){next(e);}});

router.post('/api/v1/finance/payouts/:id/approve',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const payout=await Payout.findOne({publicId:req.params.id,status:'requested'});const payoutAccount=payout?await PayoutAccount.findById(payout.payoutAccountId).lean():null;if(payoutAccount&&req.user.role!=='super_admin')assertOperationalCountry(req.user,payoutAccount.country,'Payout is outside your country scope.');if(!payout)throw new AppError('Requested payout not found.',404,'PAYOUT_NOT_FOUND');if((payout.requestedByUserId||payout.ownerUserId).equals(req.user._id))throw new AppError('You cannot approve a payout you requested.',403,'FOUR_EYES_REQUIRED');payout.status='approved';payout.approvedByUserId=req.user._id;payout.approvedAt=new Date();await payout.save();await writeAudit(req,'finance.payout_approved',{targetType:'payout',targetPublicId:payout.publicId,country:payoutAccount?.country||undefined,metadata:{amountMinor:payout.amountMinor,currency:payout.currency}});res.json({ok:true,payout});}catch(e){next(e);}});

router.post('/api/v1/finance/payouts/:id/reject',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reason:z.string().trim().min(3).max(300)}).parse(req.body);const payout=await rejectPayout(req,req.params.id,input);await writeAudit(req,'finance.payout_rejected',{targetType:'payout',targetPublicId:payout.publicId,metadata:{reason:input.reason}});res.json({payout});}catch(e){next(e);}});

router.post('/api/v1/finance/reconciliation',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({hours:z.coerce.number().int().min(1).max(168).default(24)}).parse(req.body||{});res.status(201).json({run:await reconcilePayments(req,input)});}catch(e){next(e);}});

router.post('/api/v1/finance/provider-events/:id/replay',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reason:z.string().trim().min(5).max(300)}).parse(req.body||{});const event=await requeueProviderEvent(req,req.params.id,input);await writeAudit(req,'finance.provider_event_requeued',{targetType:'provider_event',targetPublicId:event.publicId,metadata:{reason:input.reason,replayCount:event.manualReplayCount}});res.json({event:{id:event.publicId,status:event.status,nextAttemptAt:event.nextAttemptAt,manualReplayCount:event.manualReplayCount}});}catch(e){next(e);}});

router.post('/api/v1/finance/payouts/:id/submit',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const payout=await submitPayout(req,req.params.id);await writeAudit(req,'finance.payout_submission_started',{targetType:'payout',targetPublicId:payout.publicId,metadata:{submissionAttemptId:payout.submissionAttemptId}});res.json({payout});}catch(e){next(e);}});

router.post('/api/v1/finance/payouts/:id/submission-confirm',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reference:z.string().trim().min(4).max(180)}).parse(req.body);const payout=await confirmPayoutSubmission(req,req.params.id,input);await writeAudit(req,'finance.payout_submission_confirmed',{targetType:'payout',targetPublicId:payout.publicId,metadata:{submissionAttemptId:payout.submissionAttemptId}});res.json({payout});}catch(e){next(e);}});

router.post('/api/v1/finance/payouts/:id/unknown',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reason:z.string().trim().min(8).max(400)}).parse(req.body);const payout=await markPayoutUnknown(req,req.params.id,input);await writeAudit(req,'finance.payout_marked_unknown',{targetType:'payout',targetPublicId:payout.publicId,metadata:{reason:input.reason}});res.json({payout});}catch(e){next(e);}});

router.post('/api/v1/finance/payouts/:id/reconcile',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reference:z.string().trim().min(4).max(180),outcome:z.enum(['paid','failed']),message:z.string().trim().max(400).optional().default('')}).parse(req.body);const payout=await reconcilePayout(req,req.params.id,{reference:input.reference,success:input.outcome==='paid',message:input.message});await writeAudit(req,'finance.payout_reconciled',{targetType:'payout',targetPublicId:payout.publicId,metadata:{outcome:input.outcome}});res.json({payout});}catch(e){next(e);}});



router.post('/api/v1/finance/chargebacks/:id/review',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({note:z.string().trim().max(500).optional().default('')}).parse(req.body||{});res.json({chargeback:await reviewChargeback(req,req.params.id,input.note)});}catch(e){next(e);}});

router.post('/api/v1/finance/chargebacks/:id/resolve',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({outcome:z.enum(['won','lost']),note:z.string().trim().max(500).optional().default('')}).parse(req.body||{});res.json({chargeback:await resolveChargeback(req,req.params.id,input)});}catch(e){next(e);}});

export default router;

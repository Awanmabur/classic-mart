import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { AppError, asyncHandler } from '../core/errors.js';
import { financePageGates, renderFinancePage } from '../dashboard/finance-page-view.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { completeFinanceRefund, loadFinancePaymentPage, requestFinanceRefund, reviewFinanceRefundNonDisbursement, streamFinancePaymentCsv, verifyFinancePayment } from '../services/finance-payment-pages.js';
const router=Router();
const mutateLimit=rateLimit({ scope: 'finance-payment-pages:1',windowMs:15*60_000,limit:35,standardHeaders:'draft-8',legacyHeaders:false});
const exportLimit=rateLimit({ scope: 'finance-payment-pages:2',windowMs:15*60_000,limit:20,standardHeaders:'draft-8',legacyHeaders:false});
function queryShape(req){const query=new URL(req.originalUrl,'http://localhost').searchParams;for(const key of ['country','q','search','status','after','record','order','return'])if(query.getAll(key).length>1||[...query.keys()].some(value=>value.startsWith(key+'[')||value.startsWith(key+'.')))throw new AppError('Use one supported value for each finance filter.',422,'FINANCE_FILTER_INVALID');}
for(const slug of ['payments','refunds']){
  const path='/finance/'+slug,pageId='finance-'+slug;
  router.get(path,...financePageGates(),asyncHandler(async(req,res)=>{queryShape(req);return renderFinancePage(req,res,pageId,await loadFinancePaymentPage(req,pageId));}));
  router.get(path+'/export.csv',...financePageGates(),exportLimit,asyncHandler(async(req,res)=>{queryShape(req);await streamFinancePaymentCsv(req,res,pageId);}));
}
router.post('/finance/payments/:id/verify',...financePageGates(),mutateLimit,asyncHandler(async(req,res)=>{verifyDeferredCsrf(req);const payment=await verifyFinancePayment(req,req.params.id,req.body||{});if(req.accepts(['html','json'])==='json')return res.json({payment});setFlash(req,'success','Payment status was checked with Pesapal.');res.redirect('/finance/payments?record='+encodeURIComponent(payment.publicId));}));
router.post('/finance/refunds',...financePageGates(),mutateLimit,asyncHandler(async(req,res)=>{verifyDeferredCsrf(req);const refund=await requestFinanceRefund(req,req.body||{});if(req.accepts(['html','json'])==='json')return res.status(201).json({refund});setFlash(req,'success',refund.status==='completed'?'Refund recorded and posted to the ledger.':'Refund reserved. Review its confirmed outcome before completing it.');res.redirect('/finance/refunds?record='+encodeURIComponent(refund.publicId));}));
router.post('/finance/refunds/:id/complete',...financePageGates(),mutateLimit,asyncHandler(async(req,res)=>{verifyDeferredCsrf(req);const refund=await completeFinanceRefund(req,req.params.id,req.body||{});if(req.accepts(['html','json'])==='json')return res.json({refund});setFlash(req,'success','Confirmed refund recorded and posted to the ledger.');res.redirect('/finance/refunds?record='+encodeURIComponent(refund.publicId));}));
router.post('/finance/refunds/:id/review-no-payment',...financePageGates(),mutateLimit,asyncHandler(async(req,res)=>{verifyDeferredCsrf(req);const refund=await reviewFinanceRefundNonDisbursement(req,req.params.id,req.body||{});if(req.accepts(['html','json'])==='json')return res.json({refund});setFlash(req,'success','Independent no-payment review recorded against the existing refund.');res.redirect('/finance/refunds?record='+encodeURIComponent(refund.publicId));}));
export default router;

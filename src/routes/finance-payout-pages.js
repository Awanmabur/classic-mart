import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { AppError, asyncHandler } from '../core/errors.js';
import { financePageGates, renderFinancePage } from '../dashboard/finance-page-view.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { actOnFinancePayout, loadFinancePayoutPage, revealPayoutDestination, reviewFinanceAppeal, reviewFinanceDestination, streamFinancePayoutCsv } from '../services/finance-payout-pages.js';
const router=Router();
const mutations=rateLimit({ scope: 'finance-payout-pages:1',windowMs:15*60_000,limit:60,standardHeaders:'draft-8',legacyHeaders:false});
const exportsLimit=rateLimit({ scope: 'finance-payout-pages:2',windowMs:15*60_000,limit:20,standardHeaders:'draft-8',legacyHeaders:false});
const reveals=rateLimit({ scope: 'finance-payout-pages:3',windowMs:15*60_000,limit:15,standardHeaders:'draft-8',legacyHeaders:false});
router.get('/finance/payouts',...financePageGates(),asyncHandler(async(req,res)=>renderFinancePage(req,res,'finance-payouts',await loadFinancePayoutPage(req))));
router.get('/finance/payouts/export.csv',...financePageGates(),exportsLimit,asyncHandler(streamFinancePayoutCsv));
function redirectPath(req,tab,key,id) {const query=new URLSearchParams({tab,[key]:id});if(typeof req.query.country==='string'&&req.query.country)query.set('country',req.query.country);return '/finance/payouts?'+query.toString();}
function reply(req,res,data,path,message) {if(req.accepts(['html','json'])==='json')return res.json(data);setFlash(req,'success',message);return res.redirect(path);}
for(const action of ['approve','reject','submit','submission-confirm','unknown','reconcile'])router.post('/finance/payouts/:id/'+action,...financePageGates(),mutations,asyncHandler(async(req,res)=>{
  verifyDeferredCsrf(req);const payout=await actOnFinancePayout(req,req.params.id,action,req.body||{});
  return reply(req,res,{payout:{publicId:payout.publicId,status:payout.status,version:payout.__v||0,submissionAttemptId:payout.submissionAttemptId||'',providerReference:payout.providerReference||''}},redirectPath(req,'payouts','record',payout.publicId),action==='submit'?'Transfer claimed. Perform the external transfer once, then record its reference.':'Payout decision recorded.');
}));
router.post('/finance/payouts/destinations/:id/review',...financePageGates(),mutations,asyncHandler(async(req,res)=>{verifyDeferredCsrf(req);const account=await reviewFinanceDestination(req,req.params.id,req.body||{});return reply(req,res,{account},redirectPath(req,'destinations','destination',account.publicId),'Destination review recorded.');}));
router.post('/finance/payouts/appeals/:id/review',...financePageGates(),mutations,asyncHandler(async(req,res)=>{verifyDeferredCsrf(req);const commission=await reviewFinanceAppeal(req,req.params.id,req.body||{});return reply(req,res,{commission},redirectPath(req,'appeals','appeal',commission.publicId),'Commission appeal review recorded.');}));
router.post('/finance/payouts/:id/destination',...financePageGates(),reveals,asyncHandler(async(req,res)=>{
  verifyDeferredCsrf(req);if(req.accepts(['html','json'])==='json')throw new AppError('Open transfer details using the secure Finance page.',406,'PAYOUT_DESTINATION_HTML_REQUIRED');
  const revealed=await revealPayoutDestination(req,req.params.id),viewRequest=Object.create(req);
  Object.defineProperty(viewRequest,'query',{value:{...req.query,tab:'payouts',record:revealed.payoutPublicId}});
  const flow=await loadFinancePayoutPage(viewRequest);
  flow.revealedDestination= revealed.destination;
  res.set('Cache-Control','private, no-store, max-age=0').set('Referrer-Policy','no-referrer');return renderFinancePage(req,res,'finance-payouts',flow);
}));
export default router;

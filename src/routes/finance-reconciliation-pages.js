import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../core/errors.js';
import { financePageGates, renderFinancePage } from '../dashboard/finance-page-view.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { loadFinanceReconciliationPage, runFinanceReconciliation, replayFinanceProviderEvent, reconcileFinanceCod, reviewFinanceDispute, resolveFinanceDispute, streamFinanceReconciliationCsv } from '../services/finance-reconciliation-pages.js';

const router=Router();
const mutateLimit=rateLimit({windowMs:15*60_000,limit:30,standardHeaders:'draft-8',legacyHeaders:false});
const exportLimit=rateLimit({windowMs:15*60_000,limit:20,standardHeaders:'draft-8',legacyHeaders:false});
for(const slug of ['reconciliation','disputes']){
  const pageId='finance-'+slug;
  router.get('/finance/'+slug,...financePageGates(),asyncHandler(async(request,response)=>renderFinancePage(request,response,pageId,await loadFinanceReconciliationPage(request,pageId))));
  router.get('/finance/'+slug+'/export.csv',...financePageGates(),exportLimit,asyncHandler(async(request,response)=>streamFinanceReconciliationCsv(request,response,pageId)));
}
function action(path,handler,message,redirect){
  router.post(path,...financePageGates(),mutateLimit,asyncHandler(async(request,response)=>{
    verifyDeferredCsrf(request);const record=await handler(request,request.params.id,request.body||{});
    if(request.accepts(['html','json'])==='json')return response.json({record:{publicId:record.publicId,status:record.status||'reconciled',country:record.country,checked:record.checked,matched:record.matched,updated:record.updated,failed:record.failed,manualReplayCount:record.manualReplayCount}});
    setFlash(request,'success',message);return response.redirect(redirect+(redirect.includes('?')?'&':'?')+'country='+encodeURIComponent(record.country||request.financeContext.country||''));
  }));
}
action('/finance/reconciliation/runs',(request,_id,input)=>runFinanceReconciliation(request,input),'Reconciliation finished. Check the saved run for any exceptions.','/finance/reconciliation');
action('/finance/reconciliation/events/:id/replay',replayFinanceProviderEvent,'The matched event was queued for independent provider verification.','/finance/reconciliation?view=events');
action('/finance/reconciliation/cod/:id/reconcile',reconcileFinanceCod,'Cash handover verified and reconciled to the ledger.','/finance/reconciliation?view=cod');
action('/finance/disputes/:id/review',reviewFinanceDispute,'Review started. A different Finance operator must confirm the outcome.','/finance/disputes');
action('/finance/disputes/:id/resolve',resolveFinanceDispute,'Provider outcome independently verified and the dispute resolved.','/finance/disputes');
export default router;

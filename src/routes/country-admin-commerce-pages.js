import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { AppError, asyncHandler } from '../core/errors.js';
import { countryAdminPageGates, renderCountryAdminPage } from '../dashboard/country-admin-page-view.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { uploadVerificationImage } from '../services/media.js';
import { sendStoredMedia } from '../services/media-delivery.js';
import { loadCountryAdminCommercePage, streamCountryAdminCommerceCsv, mutateCountryAdminReturn, verifyCountryAdminPayment,
  requestCountryAdminRefund, completeCountryAdminRefund, uploadCountryAdminRefundEvidence, replayCountryAdminProviderEvent,
  reconcileCountryAdminPayments, countryAdminCommerceEvidenceRecord } from '../services/country-admin-commerce-pages.js';

const router=Router();
const mutateLimit=rateLimit({windowMs:15*60_000,limit:40,standardHeaders:'draft-8',legacyHeaders:false});
const exportLimit=rateLimit({windowMs:15*60_000,limit:15,standardHeaders:'draft-8',legacyHeaders:false});
const uploadLimit=rateLimit({windowMs:15*60_000,limit:12,standardHeaders:'draft-8',legacyHeaders:false});
function queryShape(request){const params=new URL(request.originalUrl,'http://localhost').searchParams;for(const key of params.keys())if(params.getAll(key).length>1||/[.\[\]]/.test(key))throw new AppError('Provide one value for each commerce filter.',422,'ADMIN_COMMERCE_FILTER_INVALID');}
for(const slug of ['orders','returns','payments']){
  const path='/admin/'+slug,pageId='admin-'+slug;
  router.get(path,...countryAdminPageGates(),asyncHandler(async(req,res)=>{queryShape(req);return renderCountryAdminPage(req,res,pageId,await loadCountryAdminCommercePage(req,pageId));}));
  router.get(path+'/export.csv',...countryAdminPageGates(),exportLimit,asyncHandler(async(req,res)=>{queryShape(req);await streamCountryAdminCommerceCsv(req,res,pageId);}));
}
for(const action of ['decision','receive','inspect','refer-finance','exchange'])router.post('/admin/returns/:id/'+action,...countryAdminPageGates(),mutateLimit,asyncHandler(async(req,res)=>{
  verifyDeferredCsrf(req);const returned=await mutateCountryAdminReturn(req,req.params.id,action,req.body||{});
  if(req.accepts(['html','json'])==='json')return res.json({returnRequest:returned});
  setFlash(req,'success',action==='refer-finance'?'Inspected return referred for independent financial review.':'Return action saved against the verified source records.');res.redirect('/admin/returns?record='+encodeURIComponent(returned.publicId));
}));
router.post('/admin/payments/:id/verify',...countryAdminPageGates(),mutateLimit,asyncHandler(async(req,res)=>{
  verifyDeferredCsrf(req);const payment=await verifyCountryAdminPayment(req,req.params.id,req.body||{});if(req.accepts(['html','json'])==='json')return res.json({payment});
  setFlash(req,'success','Payment outcome checked with the provider.');res.redirect('/admin/payments?record='+encodeURIComponent(payment.publicId));
}));
router.post('/admin/payments/refunds',...countryAdminPageGates(),mutateLimit,asyncHandler(async(req,res)=>{
  verifyDeferredCsrf(req);const refund=await requestCountryAdminRefund(req,req.body||{});if(req.accepts(['html','json'])==='json')return res.status(201).json({refund});
  setFlash(req,'success',refund.status==='completed'?'Confirmed refund recorded in the ledger.':'Inspected return refund reserved for independent confirmation.');res.redirect('/admin/payments?view=refunds&record='+encodeURIComponent(refund.publicId));
}));
router.post('/admin/payments/refunds/:id/evidence',...countryAdminPageGates(),uploadLimit,uploadVerificationImage,asyncHandler(async(req,res)=>{
  verifyDeferredCsrf(req);const evidence=await uploadCountryAdminRefundEvidence(req,req.params.id,req.body||{},req.file);if(req.accepts(['html','json'])==='json')return res.status(201).json(evidence);
  setFlash(req,'success','Private disbursement evidence attached to the inspected refund.');res.redirect('/admin/payments?view=refunds&record='+encodeURIComponent(evidence.publicId));
}));
router.post('/admin/payments/refunds/:id/complete',...countryAdminPageGates(),mutateLimit,asyncHandler(async(req,res)=>{
  verifyDeferredCsrf(req);const refund=await completeCountryAdminRefund(req,req.params.id,req.body||{});if(req.accepts(['html','json'])==='json')return res.json({refund});
  setFlash(req,'success','Independently confirmed refund posted to the ledger.');res.redirect('/admin/payments?view=refunds&record='+encodeURIComponent(refund.publicId));
}));
router.post('/admin/payments/events/:id/replay',...countryAdminPageGates(),mutateLimit,asyncHandler(async(req,res)=>{
  verifyDeferredCsrf(req);const event=await replayCountryAdminProviderEvent(req,req.params.id,req.body||{});if(req.accepts(['html','json'])==='json')return res.json({event});
  setFlash(req,'success','Matched event queued for independent provider verification.');res.redirect('/admin/payments?view=events&record='+encodeURIComponent(event.publicId));
}));
router.post('/admin/payments/reconciliation',...countryAdminPageGates(),mutateLimit,asyncHandler(async(req,res)=>{
  verifyDeferredCsrf(req);const run=await reconcileCountryAdminPayments(req,req.body||{});if(req.accepts(['html','json'])==='json')return res.status(201).json({run});
  setFlash(req,'success',`Reconciliation ${run.publicId} saved: ${run.checked} checked, ${run.failed} requiring review.`);res.redirect('/admin/payments?country='+encodeURIComponent(run.country));
}));
router.get('/admin/commerce/evidence/:id',...countryAdminPageGates(),asyncHandler(async(req,res)=>{
  const evidence=await countryAdminCommerceEvidenceRecord(req,req.params.id);
  return sendStoredMedia(res,evidence.storageKey,{contentType:evidence.mimeType,contentDisposition:'inline',authorize:async()=>{
    await countryAdminCommerceEvidenceRecord(req,req.params.id,{audit:false,expectedStorageKey:evidence.storageKey});
  }});
}));
export default router;

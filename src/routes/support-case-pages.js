import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../core/errors.js';
import { supportPageGates, renderSupportPage } from '../dashboard/support-page-view.js';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { uploadVerificationImage } from '../services/media.js';
import { sendStoredMedia } from '../services/media-delivery.js';
import { loadSupportCasePage, streamSupportCaseCsv, decideSupportReturn, receiveSupportReturn, inspectSupportReturn,
  referSupportReturnToFinance, exchangeSupportReturn, assignSupportDispute, reviewSupportDispute, escalateSupportDispute, resolveSupportDispute,
  loadWarehouseReturnIntakes, uploadWarehouseReturnIntakeEvidence, recordWarehouseReturnIntake, supportEvidenceRecord } from '../services/support-case-pages.js';

const router=Router();
const mutateLimit=rateLimit({windowMs:15*60_000,limit:45,standardHeaders:'draft-8',legacyHeaders:false});
const uploadLimit=rateLimit({windowMs:15*60_000,limit:15,standardHeaders:'draft-8',legacyHeaders:false});
const exportLimit=rateLimit({windowMs:15*60_000,limit:20,standardHeaders:'draft-8',legacyHeaders:false});
for(const [slug,pageId] of [['returns','support-returns'],['escalations','support-disputes']]){
  router.get('/support/'+slug,...supportPageGates(),asyncHandler(async(req,res)=>renderSupportPage(req,res,pageId,await loadSupportCasePage(req,pageId))));
  router.get('/support/'+slug+'/export.csv',...supportPageGates(),exportLimit,asyncHandler(async(req,res)=>streamSupportCaseCsv(req,res,pageId)));
}
for(const [path,operation,message] of [
  ['decision',decideSupportReturn,'Return decision saved.'],['receive',receiveSupportReturn,'Verified return receipt saved; warehouse inspection is pending.'],
  ['inspect',inspectSupportReturn,'Return outcome saved against completed warehouse inspection.'],['refer-finance',referSupportReturnToFinance,'Inspected refund referred to Finance. No disbursement has been confirmed.'],
  ['exchange',exchangeSupportReturn,'Exchange replacement committed against real stock and sent for seller fulfilment.']]){
  router.post('/support/returns/:id/'+path,...supportPageGates(),mutateLimit,asyncHandler(async(req,res)=>{verifyDeferredCsrf(req);const result=await operation(req,req.params.id,req.body||{});
    if(req.accepts(['html','json'])==='json')return res.json(result);setFlash(req,'success',message);res.redirect('/support/returns?record='+encodeURIComponent(result.publicId));}));
}
for(const [path,operation,message] of [['assign',assignSupportDispute,'Case assignment saved.'],['review',reviewSupportDispute,'Private review and customer update saved.'],['escalate',escalateSupportDispute,'Departmental referral and customer update saved.'],['resolve',resolveSupportDispute,'Case decision and customer update saved.']]){
  router.post('/support/escalations/:id/'+path,...supportPageGates(),mutateLimit,asyncHandler(async(req,res)=>{verifyDeferredCsrf(req);const result=await operation(req,req.params.id,req.body||{});
    if(req.accepts(['html','json'])==='json')return res.json(result);setFlash(req,'success',message);res.redirect('/support/escalations?record='+encodeURIComponent(result.publicId));}));
}
router.get('/support/evidence/:id',...supportPageGates(),asyncHandler(async(req,res)=>{const evidence=await supportEvidenceRecord(req,req.params.id);await sendStoredMedia(res,evidence.storageKey,{cacheControl:'private, no-store',contentType:'image/webp',contentDisposition:'inline'});}));
const warehouseGates=[requireAuth,requireVerified,requireOnboarding,(req,res,next)=>{res.set({'Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow, noarchive'});next();}];
router.get('/api/v1/warehouse/return-intakes',...warehouseGates,asyncHandler(async(req,res)=>res.json(await loadWarehouseReturnIntakes(req))));
router.post('/api/v1/warehouse/returns/:id/intake',...warehouseGates,mutateLimit,asyncHandler(async(req,res)=>{verifyDeferredCsrf(req);const result=await recordWarehouseReturnIntake(req,req.params.id,req.body||{});res.json(result);}));
router.post('/api/v1/warehouse/returns/:id/intake-evidence',...warehouseGates,uploadLimit,(req,res,next)=>uploadVerificationImage(req,res,error=>{if(error)return next(error);try{verifyDeferredCsrf(req);next();}catch(error){next(error);}}),
  asyncHandler(async(req,res)=>res.status(201).json(await uploadWarehouseReturnIntakeEvidence(req,req.params.id,req.body||{},req.file))));
export default router;

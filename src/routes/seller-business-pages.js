import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { asyncHandler } from '../core/errors.js';
import { setFlash } from '../middleware/view.js';
import { sellerPageGates, renderSellerPage } from '../dashboard/seller-page-view.js';
import { decideSellerBusinessOrder, loadSellerBusinessPage, respondSellerBusinessQuote, sellerBusinessDocument } from '../services/seller-business.js';

const router=Router();
const limiter=rateLimit({scope:'seller-business:1',windowMs:15*60_000,limit:90,standardHeaders:'draft-8',legacyHeaders:false});
const input=request=>{const{_csrf,...data}=request.body||{};if(data.validUntil==='')delete data.validUntil;if(data.offeredUnitMinor!==undefined&&!Array.isArray(data.offeredUnitMinor))data.offeredUnitMinor=[data.offeredUnitMinor];return data;};
const result=(request,response,value,path,message)=>{if(request.accepts(['html','json'])==='json')return response.json(value);setFlash(request,'success',message);return response.redirect(303,path);};
for(const kind of ['quotes','orders']){
  router.get('/seller/business-'+kind,...sellerPageGates('finance'),asyncHandler(async(request,response)=>renderSellerPage(request,response,'seller-business-'+kind,await loadSellerBusinessPage(request,kind))));
  for(const alias of ['/seller/business/'+kind,'/dashboard/seller-business-'+kind])router.get(alias,...sellerPageGates('finance'),asyncHandler(async(request,response)=>{await loadSellerBusinessPage(request,kind);return response.redirect(308,'/seller/business-'+kind+new URL(request.originalUrl,'http://localhost').search);}));
}
router.post('/seller/business-quotes/:id/respond',...sellerPageGates('finance'),limiter,asyncHandler(async(request,response)=>result(request,response,await respondSellerBusinessQuote(request,request.params.id,input(request)),'/seller/business-quotes','Supplier quotation updated.')));
router.post('/seller/business-orders/:id/decision',...sellerPageGates('finance'),limiter,asyncHandler(async(request,response)=>result(request,response,await decideSellerBusinessOrder(request,request.params.id,input(request)),'/seller/business-orders','Purchase order decision recorded.')));
router.get('/seller/business/documents/:id',...sellerPageGates('finance'),asyncHandler(async(request,response)=>{const document=await sellerBusinessDocument(request,request.params.id);return response.render('business-document',{document});}));
export default router;

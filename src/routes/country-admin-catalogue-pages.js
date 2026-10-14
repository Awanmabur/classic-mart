import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { asyncHandler } from '../core/errors.js';
import { countryAdminPageGates, renderCountryAdminPage } from '../dashboard/country-admin-page-view.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { COUNTRY_ADMIN_CATALOGUE_PATHS, loadCountryAdminCataloguePage, streamCountryAdminCatalogueCsv, countryAdminCatalogueAction, readCountryAdminSellerDocument } from '../services/country-admin-catalogue-pages.js';

const router=Router();
const limiter=rateLimit({ scope: 'country-admin-catalogue-pages:1',windowMs:15*60_000,limit:80,standardHeaders:'draft-8',legacyHeaders:false});
async function page(request,response,pageId,error='') {
  const flow=await loadCountryAdminCataloguePage(request,pageId);flow.error=error;
  if(flow.selected) {
    const detail=flow.selected.productFlow || flow.selected.reviewFlow || flow.selected;detail.error=error;
    detail.draft=error?Object.fromEntries(['reason','message','name','slug','description','attributes','countries','status','decision','active','restricted'].filter(key=>typeof request.body?.[key] === 'string').map(key=>[key,request.body[key].slice(0,key === 'attributes'?2000:1000)])):{};
  }
  return renderCountryAdminPage(request,response,pageId,flow);
}
for(const [pageId,path] of Object.entries(COUNTRY_ADMIN_CATALOGUE_PATHS)) {
  router.get(path,...countryAdminPageGates(),asyncHandler((req,res)=>page(req,res,pageId)));
  router.get(path+'/export.csv',...countryAdminPageGates(),limiter,asyncHandler((req,res)=>streamCountryAdminCatalogueCsv(req,res,pageId)));
  router.get(path+'/:publicId',...countryAdminPageGates(),asyncHandler((req,res)=>page(req,res,pageId)));
  const actions=pageId === 'admin-customers'?['suspend','reactivate']:pageId === 'admin-categories'?['update']:pageId === 'admin-reviews'?['claim','release','publish','reject','reply']:['claim','release','decision'];
  for(const action of actions) router.post(path+'/:publicId/'+action,...countryAdminPageGates(),limiter,asyncHandler(async(req,res)=>{
    verifyDeferredCsrf(req);
    try {
      const record=await countryAdminCatalogueAction(req,pageId,action);
      if(req.accepts(['html','json']) === 'json') return res.json({record:{publicId:record.publicId,status:record.status,version:record.version ?? record.__v ?? 0}});
      setFlash(req,'success','Country Admin action saved.');
      const params=new URLSearchParams({country:req.query?.country || '',...(pageId === 'admin-categories'?{type:req.query?.type || 'categories'}:{})});
      return res.redirect(303,path+'/'+encodeURIComponent(record.publicId)+'?'+params);
    } catch(error) {
      const status=error.name === 'ZodError'?422:error.status;
      if(![409,422].includes(status) || req.accepts(['html','json']) === 'json')throw error;
      res.status(status);return page(req,res,pageId,error.name === 'ZodError'?error.issues.map(issue=>issue.message).join(' '):error.message);
    }
  }));
}
router.get('/admin/seller-approvals/:publicId/documents/:documentId',...countryAdminPageGates(),limiter,asyncHandler(async(req,res)=>{
  const data=await readCountryAdminSellerDocument(req);
  if(res.destroyed || res.writableEnded)return;
  res.set({'Content-Type':'image/webp','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'inline'}).send(data);
}));
export default router;

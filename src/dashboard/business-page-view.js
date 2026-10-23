import { AppError } from '../core/errors.js';
import { requireAuth,requireOnboarding,requireVerified } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { liveSellerAccountHeader } from './live-account-header.js';
import { BUSINESS_LIVE_ROUTES,BUSINESS_PAGES,businessNavigation } from './business-routes.js';

const privatePage=(_request,response,next)=>{response.set('X-Robots-Tag','noindex, nofollow, noarchive');next();};
export const businessPageGates=()=>[noStore,privatePage,requireAuth,requireVerified,requireOnboarding];
export async function renderBusinessPage(request,response,pageId,flow){
  const page=BUSINESS_PAGES.find(row=>row[0]===pageId);if(!page)throw new AppError('Business page not found.',404,'BUSINESS_PAGE_NOT_FOUND');
  if(request.accepts(['html','json'])==='json')return response.json(flow);
  const header=await liveSellerAccountHeader(request);
  return response.render('approved-dashboard',{...header,workspace:'business',initialPage:pageId,allowedWorkspaces:['business'],customerRoutes:{...header.customerRoutes,...BUSINESS_LIVE_ROUTES},pageFlow:flow,businessPage:{id:pageId,label:page[1],eyebrow:page[3],title:page[4],description:page[5],kind:page[6],href:BUSINESS_LIVE_ROUTES[pageId]},liveBusiness:{profileRole:'Business Buyer',navigation:businessNavigation(),flow}});
}

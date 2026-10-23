import { AppError } from '../core/errors.js';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { DASHBOARD_PAGES } from './registry.js';
import { SUPER_ADMIN_LIVE_ROUTES } from './super-admin-routes.js';
import { liveSellerAccountHeader } from './live-account-header.js';
import { superAdminAccess, assertSuperAdminReadAccess, superAdminPublicContext } from '../services/super-admin-access.js';

export const superAdminNavigation = () => DASHBOARD_PAGES.superadmin.map(([id,label,icon,group]) => ({id,label,icon,group,href:SUPER_ADMIN_LIVE_ROUTES[id],ready:true}));
export function superAdminPageGates() {
  return [noStore,(_request,response,next)=>{response.set('X-Robots-Tag','noindex, nofollow, noarchive');next();},requireAuth,requireVerified,requireOnboarding,
    async(request,_response,next)=>{try{
      request.requiredOperationalWorkspace='superadmin';
      const params=new URL(request.originalUrl,'http://localhost').searchParams;
      for(const key of params.keys()) if(params.getAll(key).length!==1||/[.\[\]]/.test(key))throw new AppError('Provide one value for each Super Admin filter.',422,'SUPER_ADMIN_FILTER_INVALID');
      request.superAdminContext=await superAdminAccess(request);next();
    }catch(error){next(error);}}];
}
export async function renderSuperAdminPage(request,response,pageId,flow) {
  const page=DASHBOARD_PAGES.superadmin.find(row=>row[0]===pageId);
  if(!page)throw new AppError('Super Admin page not found.',404,'SUPER_ADMIN_PAGE_NOT_FOUND');
  const context=await assertSuperAdminReadAccess(request,request.superAdminContext||await superAdminAccess(request));
  flow.context=superAdminPublicContext(context);
  if(request.accepts(['html','json'])==='json')return response.json(flow);
  const header=await liveSellerAccountHeader(request);
  await assertSuperAdminReadAccess(request,context);
  return response.render('approved-dashboard',{...header,workspace:'superadmin',initialPage:pageId,allowedWorkspaces:['superadmin'],
    customerRoutes:{...header.customerRoutes,...SUPER_ADMIN_LIVE_ROUTES,dashboard:'/super/overview',profile:'/super/settings'},
    superAdminPage:{id:pageId,label:page[1],eyebrow:page[3],title:page[4],description:page[5],kind:page[6],href:SUPER_ADMIN_LIVE_ROUTES[pageId]},
    superAdminFlow:flow,pageFlow:flow,liveSuperAdmin:{profileRole:'Super Admin',navigation:superAdminNavigation(),flow}});
}

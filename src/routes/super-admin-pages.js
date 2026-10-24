import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { asyncHandler } from '../core/errors.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { SUPER_ADMIN_LIVE_ROUTES } from '../dashboard/super-admin-routes.js';
import { superAdminPageGates, renderSuperAdminPage } from '../dashboard/super-admin-page-view.js';
import { loadSuperAdminPage, streamSuperAdminCsv } from '../services/super-admin-pages.js';
import { superAdminAccess, requireSuperAdminStepUp } from '../services/super-admin-access.js';
import {
  superAdminTransaction, decideSuperApproval, requestSuperStaffChange, requestSuperCustomerState,
  requestSuperCountryPolicy, saveSuperSubscriptionPlan, requestSuperPlanPublication,
  decideSuperSubscriptionRequest, actSuperPrivacy, saveSuperCmsRevision, requestSuperCmsPublication,
  cancelSuperCmsSchedule, requestSuperFeatureChange, actSuperSecurityRecord,
} from '../services/super-admin-operations.js';
import { createPlatformStaffInvitation, revokePlatformStaffInvitation } from '../services/staff-access.js';
import { reviewBusinessCreditTerms } from '../services/business-operations.js';
import { reconcileSellerSubscriptionCharge } from '../services/seller-subscription-operations.js';

const router=Router();
const mutations=rateLimit({scope:'super-admin-actions:1',windowMs:15*60_000,limit:60,standardHeaders:'draft-8',legacyHeaders:false});
router.use('/super',...superAdminPageGates());
const body=request=>{const {_csrf,...input}=request.body||{};return input;};
const selected=(path,id,tab='')=>path+'?'+new URLSearchParams({...(tab?{tab}:{}),id});
function action(operation,destination,message){return asyncHandler(async(request,response)=>{
  verifyDeferredCsrf(request);
  requireSuperAdminStepUp(request);
  const result=await operation(request,body(request));
  if(request.accepts(['html','json'])==='json')return response.json(JSON.parse(JSON.stringify(result,(key,value)=>/(?:Encrypted|Hash|Hashes|Secret)$|^(?:storageKey|exportArtifacts|leaseToken|lockedBy)$/.test(key)?undefined:value)));
  setFlash(request,'success',message);
  return response.redirect(303,typeof destination==='function'?destination(request,result):destination);
});}
router.get('/super',asyncHandler(async(request,response)=>response.redirect(308,'/super/overview'+new URL(request.originalUrl,'http://localhost').search)));
for(const[pageId,path]of Object.entries(SUPER_ADMIN_LIVE_ROUTES)){
  router.get(path,asyncHandler(async(request,response)=>renderSuperAdminPage(request,response,pageId,await loadSuperAdminPage(request,pageId))));
  router.get(path+'/export.csv',asyncHandler(async(request,response)=>streamSuperAdminCsv(request,response,pageId)));
  router.get('/dashboard/'+pageId,...superAdminPageGates(),asyncHandler(async(request,response)=>response.redirect(308,path+new URL(request.originalUrl,'http://localhost').search)));
}
router.post('/super/approvals/:id/decision',mutations,action((request,input)=>decideSuperApproval(request,request.params.id,input),'/super/settings?tab=approvals','Independent decision recorded.'));
router.post('/super/roles/requests',mutations,action(requestSuperStaffChange,'/super/roles?tab=approvals','Access change requested. Another Super Admin must decide it.'));
router.post('/super/roles/invitations',mutations,action((request,input)=>superAdminTransaction(request,(_context,session)=>createPlatformStaffInvitation(request,{...input,operationalCountries:String(input.operationalCountries||'').split(',').map(value=>value.trim().toUpperCase()).filter(Boolean),warehouseScopes:String(input.warehouseScopes||'').split(',').map(value=>value.trim()).filter(Boolean)},{session}),{country:''}),'/super/roles?tab=invitations','Staff invitation recorded. Verified acceptance and an independent access decision are required.'));
router.post('/super/roles/invitations/:id/revoke',mutations,action((request,input)=>revokePlatformStaffInvitation(request,request.params.id,input),'/super/roles?tab=invitations','Pending invitation revoked.'));
router.post('/super/customers/:id/status',mutations,action((request,input)=>requestSuperCustomerState(request,request.params.id,input),'/super/settings?tab=approvals','Account state change requested for independent review.'));
for(const kind of ['market','reward','club'])router.post('/super/settings/countries/:code/'+kind,mutations,action((request,input)=>requestSuperCountryPolicy(request,request.params.code,input,kind),'/super/settings?tab=approvals','Market policy change requested for independent review.'));
router.post('/super/subscriptions/plans',mutations,action((request,input)=>saveSuperSubscriptionPlan(request,input),(_request,result)=>selected('/super/subscriptions',result.publicId,'plans'),'Seller plan draft saved.'));
router.post('/super/subscriptions/plans/:id',mutations,action((request,input)=>saveSuperSubscriptionPlan(request,input,request.params.id),(_request,result)=>selected('/super/subscriptions',result.publicId,'plans'),'Seller plan draft saved.'));
router.post('/super/subscriptions/plans/:id/publication',mutations,action((request,input)=>requestSuperPlanPublication(request,request.params.id,input),'/super/settings?tab=approvals','Plan publication requested for independent review.'));
router.post('/super/subscriptions/requests/:id/decision',mutations,action((request,input)=>decideSuperSubscriptionRequest(request,request.params.id,input),'/super/subscriptions?tab=requests','Seller plan request reviewed. Payment is still verified separately.'));
router.post('/super/subscriptions/charges/:id/reconcile',mutations,action((request,input)=>reconcileSellerSubscriptionCharge(request,request.params.id,input),'/super/subscriptions?tab=charges','Original provider payment reconciled.'));
router.post('/super/settings/privacy/:id/actions',mutations,action((request,input)=>actSuperPrivacy(request,request.params.id,input),request=>selected('/super/settings',request.params.id,'privacy'),'Privacy review recorded.'));
router.post('/super/settings/business-credit/:id/decision',mutations,action(async(request,input)=>{await superAdminAccess(request);return reviewBusinessCreditTerms(request,request.params.id,input);},request=>selected('/super/settings',request.params.id,'business-credit'),'Business credit decision recorded.'));
router.post('/super/settings/cms/revisions',mutations,action(saveSuperCmsRevision,(_request,result)=>selected('/super/settings',result.publicId,'cms'),'Content revision saved. Publication requires an independent decision.'));
router.post('/super/settings/cms/:id/publication',mutations,action((request,input)=>requestSuperCmsPublication(request,request.params.id,input),'/super/settings?tab=approvals','Content publication requested for independent review.'));
router.post('/super/settings/cms/:id/cancel-schedule',mutations,action((request,input)=>cancelSuperCmsSchedule(request,request.params.id,input),request=>selected('/super/settings',request.params.id,'cms'),'Content schedule cancelled.'));
router.post('/super/settings/features/requests',mutations,action(requestSuperFeatureChange,'/super/settings?tab=approvals','Feature rollout requested for independent review.'));
router.post('/super/security/:domain/:id/actions',mutations,action((request,input)=>actSuperSecurityRecord(request,request.params.domain,request.params.id,input),request=>selected('/super/security',request.params.id,request.params.domain),'Security record updated with a reason.'));
export default router;

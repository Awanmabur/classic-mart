import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { writeAudit } from './audit.js';
import { cursorScope, cursorSort, decodeCursor, pageResult } from './pagination.js';
import { superAdminAccess, assertSuperAdminReadAccess, superAdminPublicContext } from './super-admin-access.js';
import { SUPER_ADMIN_LIVE_ROUTES } from '../dashboard/super-admin-routes.js';
import {
  ApprovalRequest, AuditLog, BusinessOrganization, Category, CmsContent, CommissionEntry, CountrySetting, DataExport,
  Dispute, FeatureFlag, Incident, LaunchEvidence, MarketingCampaign, OperationalAlert, Order, PaymentIntent,
  Payout, PayoutAccount, PlatformGrant, PlatformStaffInvitation, PrivacyRequest, Product, PromoterVerification, ReconciliationRun,
  Refund, SecurityFinding, Store, SubscriptionPlan, SubscriptionEnrollment, SubscriptionChangeRequest,
  SupportTicket, TrustCase, User, WorkerHeartbeat,
} from '../models/index.js';
import { SubscriptionCharge } from '../models/SubscriptionCharge.js';
import { countryPolicyDigest } from './super-admin-operations.js';

const SIZE=30;
const label=value=>String(value??'').replaceAll('_',' ');
const amount=(value,currency)=>`${currency||''} ${Number.isSafeInteger(value)?value:'—'} minor`;
const key=row=>String(row.publicId||row.code||row._id);
const date=value=>value?new Date(value).toISOString():'—';
const base=(Model,columns,cells,fields,select='',extra={})=>({Model,columns,cells,fields,select,...extra});
const tabs={
  'super-roles':[['grants','Current grants'],['invitations','Invitations'],['approvals','Access decisions']],
  'super-subscriptions':[['requests','Plan requests'],['plans','Plan catalogue'],['enrollments','Enrollments'],['charges','Billing attempts']],
  'super-finance':[['payments','Payments'],['refunds','Refunds'],['payouts','Payouts'],['reconciliation','Reconciliation']],
  'super-disputes':[['disputes','Disputes'],['trust','Trust cases']],
  'super-security':[['findings','Security findings'],['alerts','Operational alerts'],['incidents','Incidents'],['workers','Worker heartbeats'],['evidence','Launch evidence']],
  'super-settings':[['countries','Markets'],['features','Feature flags'],['approvals','Change decisions'],['cms','Content'],['privacy','Privacy operations'],['business-credit','Business credit']],
};
export function superAdminPageDefinition(pageId,tab=''){
  if(['super-users','super-customers','super-admins'].includes(pageId))return base(User,['Account','Name','Role','Country','Status'],r=>[r.publicId,r.name,label(r.role),r.country,label(r.status)],['publicId','name'],
    'publicId name role status country platformAccessManagedAt emailVerifiedAt phoneVerifiedAt onboardingCompletedAt security.mfaEnabled security.tokenVersion createdAt updatedAt __v',
    {base:pageId==='super-customers'?{role:'customer'}:pageId==='super-admins'?{$or:[{platformAccessManagedAt:{$type:'date'}},{role:{$in:['super_admin','country_admin','finance','moderator','support','warehouse']}}]}:{}});
  if(pageId==='super-roles'){
    if(tab==='invitations')return base(PlatformStaffInvitation,['Invitation','Email','Role','Countries','Status'],r=>[r.publicId,r.emailMasked,label(r.role),(r.operationalCountries||[]).join(', '),label(r.status)],['publicId','emailMasked'],'publicId emailMasked role operationalCountries warehouseScopes grantDurationDays approvalCountry reason status expiresAt invitedByUserId acceptedAt approvalRequestPublicId createdAt __v',{countryField:'approvalCountry',global:true});
    if(tab==='approvals')return approvalDefinition({type:'platform_staff_access'});
    return base(PlatformGrant,['Grant','Role','Countries','Expiry','Status'],r=>[r.publicId,label(r.role),(r.operationalCountries||[]).join(', '),date(r.expiresAt),label(r.status)],['publicId','role'],'publicId userId role operationalCountries warehouseScopes startsAt expiresAt status reason approvalPublicId createdAt __v',{countryField:'operationalCountries'});
  }
  if(pageId==='super-sellers')return base(Store,['Store','Name','Country','Currency','Status'],r=>[r.publicId,r.name,r.country,r.currency,label(r.status)],['publicId','name'],'publicId name country currency status ownerUserId createdAt updatedAt __v');
  if(pageId==='super-promoters')return base(PromoterVerification,['Verification','Account','Country','Reviewed','Status'],r=>[r.publicId,String(r.userId),r.country,date(r.reviewedAt),label(r.status)],['publicId'],'publicId userId country status submittedAt reviewedAt reviewReason createdAt __v');
  if(pageId==='super-products')return base(Product,['Product','Title','Countries','Risk','Status'],r=>[r.publicId,r.title,(r.countries||[]).join(', '),label(r.moderation?.riskLevel||'unassessed'),label(r.status)],['publicId','title'],'publicId title countries status moderation.riskLevel moderation.secondReviewRequired storeId createdAt updatedAt __v',{countryField:'countries'});
  if(pageId==='super-categories')return base(Category,['Category','Name','Countries','Restricted','Visibility'],r=>[r.publicId,r.name,(r.countries||[]).join(', ')||'Global',r.restricted?'Yes':'No',r.active?'Active':'Inactive'],['publicId','name'],'publicId name slug countries active restricted createdAt updatedAt __v',{countryField:'countries',global:true,noStatus:true});
  if(['super-orders','super-analytics'].includes(pageId))return base(Order,['Order','Country','Payment','Fulfilment','Total'],r=>[r.publicId,r.country,label(r.paymentState),label(r.fulfillmentState),amount(r.totals?.totalMinor,r.totals?.currency)],['publicId'],'publicId country status paymentState fulfillmentState cancellationState returnState refundState totals createdAt updatedAt __v');
  if(pageId==='super-finance'){
    if(tab==='refunds')return base(Refund,['Refund','Order','Country','Amount','Status'],r=>[r.publicId,r.orderPublicId,r.country,amount(r.amountMinor,r.currency),label(r.status)],['publicId','orderPublicId'],'publicId orderPublicId country currency amountMinor status reason createdAt __v',{join:{Model:Order,localField:'orderId',values:{country:'country',orderPublicId:'publicId'}}});
    if(tab==='payouts')return base(Payout,['Payout','Beneficiary','Country','Amount','Status'],r=>[r.publicId,r.ownerStorePublicId||String(r.ownerUserId||''),r.country,amount(r.amountMinor,r.currency),label(r.status)],['publicId'],'publicId ownerStorePublicId ownerUserId country currency amountMinor status requestedAt createdAt __v',{join:{Model:PayoutAccount,localField:'payoutAccountId',values:{country:'country'}}});
    if(tab==='reconciliation')return base(ReconciliationRun,['Run','Country','Provider','Completed','Status'],r=>[r.publicId,r.country,r.provider||'Pesapal',date(r.completedAt),label(r.status)],['publicId'],'publicId country provider status startedAt completedAt summary createdAt __v');
    return base(PaymentIntent,['Payment','Order','Country','Amount','Status'],r=>[r.publicId,r.orderPublicId,r.country,amount(r.amountMinor,r.currency),label(r.status)],['publicId','orderPublicId'],'publicId orderPublicId country currency amountMinor provider status providerStatus lastVerifiedAt createdAt __v');
  }
  if(pageId==='super-commissions')return base(CommissionEntry,['Entry','Store','Country','Commission','Status'],r=>[r.publicId,r.storePublicId,r.country,amount(r.amountMinor,r.currency),label(r.status)],['publicId','storePublicId'],'publicId storePublicId country currency amountMinor commissionBps status productPublicId createdAt __v',{join:{Model:Order,localField:'orderId',values:{country:'country'}}});
  if(pageId==='super-subscriptions'){
    if(tab==='plans')return base(SubscriptionPlan,['Plan','Name','Country','Price','Status'],r=>[r.publicId,r.name,r.country,amount(r.priceMinor,r.currency),label(r.status)],['publicId','name','key'],'publicId key name description audience country currency priceMinor cadence features entitlements status sortOrder createdByUserId updatedByUserId createdAt __v');
    if(tab==='enrollments')return base(SubscriptionEnrollment,['Enrollment','Store','Country','Period end','Status'],r=>[r.publicId,r.storePublicId,r.country,date(r.currentPeriodEndsAt),label(r.status)],['publicId','storePublicId'],'publicId storePublicId country currency priceMinor status planPublicId startsAt currentPeriodEndsAt cancelAtPeriodEnd terms createdAt __v');
    if(tab==='charges')return base(SubscriptionCharge,['Charge','Store','Country','Amount','Status'],r=>[r.publicId,r.storePublicId,r.country,amount(r.amountMinor,r.currency),label(r.status)],['publicId','storePublicId'],'publicId storePublicId country currency amountMinor status holdReason failureCode providerTrackingId providerStatus lastVerifiedAt paidAt createdAt __v');
    return base(SubscriptionChangeRequest,['Request','Store','Country','Price','Status'],r=>[r.publicId,r.storePublicId,r.country,amount(r.requestedPriceMinor,r.currency),label(r.status)],['publicId','storePublicId'],'publicId storePublicId userId country currency requestedPriceMinor requestedCadence terms planPublicId note status reviewedByUserId reviewedAt reviewReason createdAt __v',{base:{audience:'seller'}});
  }
  if(pageId==='super-disputes'){
    if(tab==='trust')return base(TrustCase,['Case','Subject','Country','Severity','Status'],r=>[r.publicId,r.subjectType,r.country,label(r.severity),label(r.status)],['publicId'],'publicId subjectType subjectPublicId country severity status reason openedByUserId createdAt __v');
    return base(Dispute,['Dispute','Order','Country','Priority','Status'],r=>[r.publicId,r.orderPublicId,r.country,label(r.priority),label(r.status)],['publicId','orderPublicId'],'publicId orderPublicId country subject priority status requestedResolution resolution createdAt __v');
  }
  if(pageId==='super-reports')return base(DataExport,['Export','Dataset','Country','Expiry','Status'],r=>[r.publicId,label(r.type),r.country||'Global',date(r.expiresAt),label(r.status)],['publicId','type'],'publicId type country status requestedByUserId approvedByUserId rowCount expiresAt createdAt __v',{global:true});
  if(pageId==='super-audit')return base(AuditLog,['Request','Actor','Action','Target','Result'],r=>[r.requestId,r.actorPublicId,r.action,r.targetPublicId,r.result],['requestId','actorPublicId','action','targetPublicId'],'requestId actorPublicId action targetType targetPublicId country result createdAt __v',{noStatus:true});
  if(pageId==='super-security'){
    if(tab==='alerts')return base(OperationalAlert,['Alert','Country','Severity','Last seen','Status'],r=>[r.publicId,r.country||'Global',label(r.severity),date(r.lastSeenAt),label(r.status)],['publicId','title'],'publicId country type title message severity status lastSeenAt resolutionNote createdAt __v',{global:true});
    if(tab==='incidents')return base(Incident,['Incident','Title','Country','Severity','Status'],r=>[r.publicId,r.title,r.country||'Global',label(r.severity),label(r.status)],['publicId','title'],'publicId title summary country severity status timeline ownerUserId resolvedAt createdAt __v',{global:true});
    if(tab==='workers')return base(WorkerHeartbeat,['Worker','Host','Last heartbeat','Cycle','Status'],r=>[r.workerId,r.hostname,date(r.lastHeartbeatAt),r.lastCycleOk?'Passed':'Needs review',label(r.status)],['workerId'],'workerId hostname status lastHeartbeatAt lastCycleOk lastCycleCompletedAt lastCycleDurationMs createdAt __v',{noCountry:true,idField:'workerId'});
    if(tab==='evidence')return base(LaunchEvidence,['Control','Verified','Valid until','Evidence','Status'],r=>[r.key,date(r.verifiedAt),date(r.validUntil),r.label,label(r.status)],['key'],'key label status verifiedAt validUntil evidence createdAt __v',{noCountry:true,idField:'key'});
    return base(SecurityFinding,['Finding','Title','Country','Severity','Status'],r=>[r.publicId,r.title,r.country||'Global',label(r.severity),label(r.status)],['publicId','title'],'publicId title country severity status details riskReason riskRequestedByUserId riskApprovedByUserId remediation createdAt __v',{global:true});
  }
  if(pageId==='super-notifications')return base(MarketingCampaign,['Campaign','Country','Queued','Completed','Status'],r=>[r.publicId,r.country||'Global',String(r.queuedCount||0),date(r.completedAt),label(r.status)],['publicId','name'],'publicId name country status roles scheduledAt startedAt completedAt eligibleCount queuedCount createdAt __v',{global:true});
  if(pageId==='super-support')return base(SupportTicket,['Ticket','Country','Queue','Priority','Status'],r=>[r.publicId,r.country,label(r.queue),label(r.priority),label(r.status)],['publicId','subject'],'publicId subject country queue category priority status slaDueAt assignedUserId createdAt __v');
  if(pageId==='super-settings'){
    if(tab==='features')return base(FeatureFlag,['Feature','Countries','Rollout','Version','Status'],r=>[r.key,(r.countries||[]).join(', ')||'Global',`${r.rolloutPercentage}%`,String(r.rolloutVersion??r.version),r.enabled?'Active':'Disabled'],['key','description'],'publicId key description enabled countries roles rolloutPercentage startsAt endsAt version createdAt __v',{countryField:'countries',global:true,noStatus:true});
    if(tab==='approvals')return approvalDefinition({});
    if(tab==='cms')return base(CmsContent,['Content','Country','Type','Public revision','Status'],r=>[r.key,r.country||'Global',label(r.type),String(r.activeVersion),label(r.status)],['publicId','key'],'publicId key country type activeVersion scheduledVersion status revisions createdAt __v',{global:true});
    if(tab==='privacy')return base(PrivacyRequest,['Request','Account','Country','Type','Status'],r=>[r.publicId,r.userPublicId,r.country,label(r.type),label(r.status)],['publicId','userPublicId'],'publicId userPublicId userId country type status details decision identityVerifiedAt legalHold restrictionActive restrictionReleasedAt processedByUserId approvedAt attempts nextAttemptAt lockedUntil lastError completedAt createdAt __v');
    if(tab==='business-credit')return base(BusinessOrganization,['Organization','Country','Requested credit','Terms','Status'],r=>[r.companyName,r.country,amount(r.creditRequestedLimitMinor,r.currency),`${r.creditRequestedTermsDays||0} days`,label(r.status)],['publicId','companyName'],'publicId companyName country currency status creditRequestedAt creditRequestedByUserId creditRequestedLimitMinor creditRequestedTermsDays creditApprovedAt creditReviewedAt creditReviewDecision creditReviewReason invoiceTermsApproved invoiceTermsDays creditLimitMinor createdAt __v',{base:{creditRequestedAt:{$type:'date'}}});
    return base(CountrySetting,['Country','Name','Currency','Policy','Availability'],r=>[r.code,r.name,r.currency,r.policyVersion,r.active?'Active':'Inactive'],['code','name'],'code name currency timeZone locale active taxBps platformFeeBps freeStandardShippingThresholdMinor returnWindowDays policyVersion payments delivery growth createdAt __v',{countryField:'code',noStatus:true,idField:'code'});
  }
  return base(OperationalAlert,['Alert','Country','Severity','Last seen','Status'],r=>[r.publicId,r.country||'Global',label(r.severity),date(r.lastSeenAt),label(r.status)],['publicId','title'],'publicId title message country severity status lastSeenAt createdAt __v',{base:{status:{$nin:['resolved','suppressed']}},global:true});
}
function approvalDefinition(extra){return base(ApprovalRequest,['Request','Type','Country','Target','Status'],r=>[r.publicId,label(r.type),r.country||'Global',r.targetPublicId,label(r.status)],['publicId','targetPublicId'],'publicId type country targetType targetPublicId payload reason status requestedByUserId requesterGrantPublicId requesterTokenVersion decidedByUserId decisionReason createdAt __v',{base:extra,global:true});}
function filters(request,pageId){
  const options=tabs[pageId]||[],fallback=options[0]?.[0]||'';
  const selected=z.object({search:z.string().trim().max(100).default(''),q:z.string().trim().max(100).optional(),status:z.string().trim().max(40).default(''),tab:z.string().trim().max(40).default(fallback),after:z.string().trim().max(512).default(''),id:z.string().trim().max(120).default(''),revisionBefore:z.string().regex(/^$|^[1-9]\d{0,9}$/).default('')}).parse(request.query||{});
  if(options.length&&!options.some(([value])=>value===selected.tab))throw new AppError('Choose an available Super Admin view.',422,'SUPER_ADMIN_TAB_INVALID');
  if(selected.after&&!decodeCursor(selected.after))throw new AppError('The page cursor is invalid.',422,'SUPER_ADMIN_CURSOR_INVALID');
  return {...selected,search:selected.q??selected.search};
}
function queryFor(context,selected,definition){
  const clauses=[definition.base||{}];
  if(context.country&&!definition.noCountry){const field=definition.countryField||'country';clauses.push(definition.global?{$or:[{[field]:context.country},{[field]:''},{[field]:{$size:0}},{[field]:{$exists:false}}]}:{[field]:context.country});}
  if(selected.status&&!definition.noStatus){const valid=definition.Model.schema.path('status')?.enumValues||[];if(valid.length&&!valid.includes(selected.status))throw new AppError('The record status is invalid.',422,'SUPER_ADMIN_STATUS_INVALID');clauses.push({status:selected.status});}
  if(selected.search){const expression=new RegExp(RegExp.escape(selected.search),'i');clauses.push({$or:definition.fields.map(field=>({[field]:expression}))});}
  return clauses.length===1?clauses[0]:{$and:clauses};
}
function sourcePipeline(definition,query){
  const stages=[];
  if(definition.join){const join=definition.join;stages.push({$lookup:{from:join.Model.collection.name,localField:join.localField,foreignField:'_id',as:'scopeSource'}},{$unwind:'$scopeSource'},{$set:Object.fromEntries(Object.entries(join.values).map(([field,path])=>[field,'$scopeSource.'+path]))});}
  stages.push({$match:query});return stages;
}
const projection=definition=>Object.fromEntries(definition.select.split(/\s+/).filter(Boolean).map(field=>[field,1]));
async function sourceRows(definition,query,{after='',limit=SIZE+1,idQuery=null}={}){
  if(definition.join){const stages=sourcePipeline(definition,query);if(idQuery)stages.push({$match:idQuery});if(after)stages.push({$match:cursorScope({},after)});stages.push({$sort:cursorSort()},{$limit:limit},{$project:projection(definition)});return definition.Model.aggregate(stages);}
  const select=definition.Model===CmsContent&&!idQuery?definition.select.replace(/\brevisions\b/,''):definition.select;
  return definition.Model.find(idQuery?{$and:[query,idQuery]}:cursorScope(query,after)).select(select).sort(cursorSort()).limit(limit).lean();
}
async function sourceCount(definition,query){if(!definition.join)return definition.Model.countDocuments(query);const rows=await definition.Model.aggregate([...sourcePipeline(definition,query),{$count:'count'}]);return rows[0]?.count||0;}
async function sourceGroups(definition,query){if(definition.noStatus)return [];return definition.Model.aggregate([...sourcePipeline(definition,query),{$group:{_id:'$status',count:{$sum:1}}}]);}
export async function loadSuperAdminPage(request,pageId){
  if(!SUPER_ADMIN_LIVE_ROUTES[pageId])throw new AppError('Super Admin page not found.',404,'SUPER_ADMIN_PAGE_NOT_FOUND');
  const context=await superAdminAccess(request),selected=filters(request,pageId),definition=superAdminPageDefinition(pageId,selected.tab),query=queryFor(context,selected,definition);
  const [found,total,groups]=await Promise.all([
    sourceRows(definition,query,{after:selected.after}),sourceCount(definition,query),sourceGroups(definition,queryFor(context,{...selected,status:'',search:''},definition)),
  ]);
  const paged=pageResult(found,{limit:SIZE,total}),path=SUPER_ADMIN_LIVE_ROUTES[pageId],parameters=new URLSearchParams();
  if(context.country)parameters.set('country',context.country);if(selected.tab)parameters.set('tab',selected.tab);if(selected.search)parameters.set('search',selected.search);if(selected.status)parameters.set('status',selected.status);
  const rowKey=row=>String(definition.idField?row[definition.idField]:key(row));
  const href=id=>path+'?'+new URLSearchParams({...Object.fromEntries(parameters),id});
  let detail=null;
  if(selected.id){
    const idQuery=definition.idField?{[definition.idField]:selected.id}:mongoose.isValidObjectId(selected.id)?{_id:selected.id}:{publicId:selected.id};
    if(definition.Model===CmsContent){
      const found=await CmsContent.aggregate([{$match:{$and:[query,idQuery]}},{$set:{revisionCount:{$size:'$revisions'},revisions:{$slice:[{$reverseArray:{$filter:{input:'$revisions',as:'revision',cond:{$lt:['$$revision.version',selected.revisionBefore?Number(selected.revisionBefore):Number.MAX_SAFE_INTEGER]}}}},11]}}},{$project:{...projection(definition),revisionCount:1}}]);
      detail=found[0];if(detail){detail.revisionPage={hasMore:detail.revisions.length>10,next:detail.revisions.length>10?detail.revisions[9].version:null};detail.revisions=detail.revisions.slice(0,10);}
    }else detail=(await sourceRows(definition,query,{idQuery,limit:1}))[0];
    if(!detail)throw new AppError('The source record is unavailable in this view.',404,'SUPER_ADMIN_RECORD_NOT_FOUND');detail={...detail,...(definition.Model===FeatureFlag?{rolloutVersion:detail.version}:{}),version:detail.__v||0};if(pageId==='super-settings'&&selected.tab==='countries')detail.sourceDigest=countryPolicyDigest(detail);
    if(definition.Model===ApprovalRequest){
      detail.requester=await User.findById(detail.requestedByUserId).select('publicId name').lean();
      const sourcePaths={country:'/super/settings?tab=countries',feature_flag:'/super/settings?tab=features',cms:'/super/settings?tab=cms',subscription_plan:'/super/subscriptions?tab=plans',user:'/super/users'};
      if(sourcePaths[detail.targetType])detail.sourceHref=sourcePaths[detail.targetType]+(sourcePaths[detail.targetType].includes('?')?'&':'?')+'id='+encodeURIComponent(detail.targetPublicId);
      if(detail.targetType==='feature_flag'){const flag=await FeatureFlag.findOne({key:detail.targetPublicId}).select('publicId').lean();detail.sourceHref=flag?'/super/settings?tab=features&id='+encodeURIComponent(flag.publicId):null;}
      if(detail.type==='subscription_plan')detail.planTerms=await SubscriptionPlan.findOne({publicId:detail.targetPublicId}).select('name country currency cadence priceMinor entitlements status').lean();
    }
  }
  const summary=Object.fromEntries(groups.map(row=>[row._id,row.count])),active=['active','approved','paid','completed','delivered','published','ready','applied'].reduce((sum,status)=>sum+(summary[status]||0),0),attention=['requested','pending','submitted','failed','blocked','held','unknown','open','investigating','risk_review','pending_approval'].reduce((sum,status)=>sum+(summary[status]||0),0);
  let extra={};
  if(['super-overview','super-analytics','super-reports'].includes(pageId)){
    const country=context.country?{country:context.country}:{};
    const [users,orders,stores,tickets,approvalCount,orderGroups]=await Promise.all([User.countDocuments(country),Order.countDocuments(country),Store.countDocuments(country),SupportTicket.countDocuments({...country,status:{$nin:['resolved','closed']}}),ApprovalRequest.countDocuments({...country,status:'requested'}),Order.aggregate([{$match:country},{$group:{_id:'$status',count:{$sum:1}}}])]);
    extra={platformMetrics:[{label:'Accounts',value:users},{label:'Orders',value:orders},{label:'Stores',value:stores},{label:'Open support',value:tickets}],approvalCount,orderGroups:orderGroups.map(row=>({label:label(row._id),count:row.count}))};
  }
  await assertSuperAdminReadAccess(request,context);
  return {kind:'super-admin',pageId,path,context:superAdminPublicContext(context),country:context.country,currency:context.currency,filters:selected,tabs:(tabs[pageId]||[]).map(([value,name])=>({value,label:name})),columns:definition.columns,
    items:paged.items.map(row=>({...row,version:row.__v||0})),rows:paged.items.map(row=>({id:rowKey(row),href:href(rowKey(row)),cells:definition.cells(row)})),selected:detail,detailRows:detail?definition.columns.map((name,index)=>({label:name,value:definition.cells(detail)[index]})):[],page:paged.page,parameters:Object.fromEntries(parameters),
    metrics:extra.platformMetrics||[{label:'Records',value:total,detail:'Matching current filters'},{label:'Active / completed',value:active,detail:'Recorded source status'},{label:'Needs attention',value:attention,detail:'Open or unresolved source status'},{label:'Markets',value:context.country?1:context.countries.length,detail:context.country||'Active platform markets'}],
    statusOptions:definition.noStatus?[]:['',...(definition.Model.schema.path('status')?.enumValues||[])].map(value=>({value,label:value?label(value):'All statuses'})),
    exportHref:path+'/export.csv'+(parameters.size?'?'+parameters:''),...extra};
}
const csv=value=>'"'+(/^[\s\u0000-\u001f\u007f\uFEFF]*[=+@-]/.test(String(value??''))?"'"+String(value??''):String(value??'')).replaceAll('"','""')+'"';
async function writeLine(response,values){if(response.destroyed)throw new AppError('The export connection closed.',499,'EXPORT_CLOSED');if(!response.write(values.map(csv).join(',')+'\r\n'))await new Promise((resolve,reject)=>{const done=()=>{cleanup();resolve();},closed=()=>{cleanup();reject(new AppError('The export connection closed.',499,'EXPORT_CLOSED'));},cleanup=()=>{response.off('drain',done);response.off('close',closed);response.off('error',closed);};response.once('drain',done);response.once('close',closed);response.once('error',closed);});}
export async function streamSuperAdminCsv(request,response,pageId){
  if(!SUPER_ADMIN_LIVE_ROUTES[pageId])throw new AppError('Super Admin page not found.',404,'SUPER_ADMIN_PAGE_NOT_FOUND');
  const context=await superAdminAccess(request),selected=filters(request,pageId),definition=superAdminPageDefinition(pageId,selected.tab),query=queryFor(context,selected,definition),snapshot=new Date();
  const exportQuery={$and:[query,{createdAt:{$lte:snapshot}}]},cursor=definition.join?definition.Model.aggregate([...sourcePipeline(definition,exportQuery),{$sort:cursorSort()},{$project:projection(definition)}]).cursor({batchSize:100}):definition.Model.find(exportQuery).select(definition.select).sort(cursorSort()).lean().cursor({batchSize:100});let rows=0;
  await assertSuperAdminReadAccess(request,context);
  response.set({'Cache-Control':'private, no-store','Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${pageId}-${selected.tab||'records'}.csv"`,'X-Robots-Tag':'noindex, nofollow, noarchive'});
  try{await writeLine(response,definition.columns);for await(const row of cursor){await assertSuperAdminReadAccess(request,context);await writeLine(response,definition.cells(row));rows++;}}finally{await cursor.close();}
  await writeAudit(request,'super_admin.records_exported',{actor:context.actor,targetType:'export',targetPublicId:pageId,country:context.country,metadata:{tab:selected.tab,rows,snapshot:snapshot.toISOString()}});response.end();
}

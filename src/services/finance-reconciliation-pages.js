import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { Chargeback, Order, PaymentIntent, ProviderEvent, ReconciliationRun, Shipment } from '../models/index.js';
import { financeAccess, financePublicContext, assertFinanceExportAccess } from './finance-workspace-access.js';
import { cursorScope, cursorSort, decodeCursor, pageResult } from './pagination.js';
import { formatMinorUnits } from './catalogue.js';
import { reviewChargeback, resolveChargeback } from './chargebacks.js';
import { reconcilePayments, requeueProviderEvent } from './payments.js';
import { reconcileCod } from './logistics.js';
import { writeAudit } from './audit.js';
import { financeProviderEventSource as providerEventSource, financeChargebackSource, financeCodSource } from './finance-record-sources.js';

const SIZE=25, EXPORT_MAX=10000;
const states={runs:['running','completed','failed'],events:['received','processing','processed','ignored','failed','dead'],cod:['ready','blocked','reconciled'],disputes:['open','reviewing','won','lost']};
const escaped=value=>String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const label=value=>String(value||'').replaceAll('_',' ');
const integer=value=>{const number=Number(value||0);if(!Number.isSafeInteger(number))throw new AppError('Finance totals are invalid.',409,'FINANCE_TOTAL_INVALID');return number;};
const date=value=>value?new Date(value).toISOString():'—';
const money=(minor,currency)=>formatMinorUnits(integer(minor),currency,'en');
function moneyScope(context){return {$or:context.countries.filter(row=>!context.country||row.code===context.country).map(row=>({country:row.code,currency:row.currency}))};}
function queryFor(request,pageId){
  const input=z.object({country:z.string().max(2).optional(),view:z.enum(['runs','events','cod']).default('runs'),search:z.string().trim().max(100).default(''),q:z.string().trim().max(100).optional(),status:z.string().max(30).default('all'),after:z.string().max(512).default(''),selected:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional()}).parse(request.query||{});
  input.view=pageId==='finance-disputes'?'disputes':input.view;
  if(input.status!=='all'&&!states[input.view].includes(input.status))throw new AppError('Choose a supported status for this report.',422,'FINANCE_FILTER_INVALID');
  if(input.after&&!decodeCursor(input.after))throw new AppError('The report cursor is invalid.',422,'FINANCE_FILTER_INVALID');
  input.search=input.q??input.search;return input;
}
function codState(row){return row.cod?.reconciledAt?'reconciled':row.cod?.handoverAt&&!row.cod?.mismatchExceptionPublicId&&row.cod?.handoverEvidenceDocumentId&&row.cod.handoverDeclaredMinor===row.cod.collectedMinor&&row.cod.collectedMinor===row.cod.amountMinor?'ready':'blocked';}
function recordSource(view, scope) {
  if (view === 'events') return providerEventSource(scope);
  if (view === 'disputes') return financeChargebackSource(scope);
  if (view === 'cod') return financeCodSource(scope);
  return [{ $match: scope }];
}
const recordProjection = config => Object.fromEntries(config.select.split(' ').map(field => [field, 1]));
function configuration(view,context,input){
  let Model,scope,select,map,columns;
  if(view==='disputes'){
    Model=Chargeback;scope=moneyScope(context);select='publicId orderPublicId paymentIntentPublicId country currency amountMinor status openedAt reviewedAt reviewedByUserId resolvedAt reviewNote resolutionNote timeline createdAt __v';
    map=row=>({publicId:row.publicId,orderPublicId:row.orderPublicId,paymentIntentPublicId:row.paymentIntentPublicId,country:row.country,currency:row.currency,amountMinor:integer(row.amountMinor),status:row.status,openedAt:row.openedAt,reviewedAt:row.reviewedAt,resolvedAt:row.resolvedAt,reviewNote:row.reviewNote,resolutionNote:row.resolutionNote,canResolve:row.status==='reviewing'&&String(row.reviewedByUserId)!==String(context.actor._id),version:row.__v||0,createdAt:row.createdAt});
    columns=['Dispute','Order','Country','Exposure','Status','Opened'];
  }else if(view==='events'){
    Model=ProviderEvent;scope={...context.countryScope,provider:'pesapal'};select='publicId country currency status attempts manualReplayCount paymentIntentPublicId orderPublicId nextAttemptAt createdAt __v';
    map=row=>({publicId:row.publicId,country:row.country,currency:row.currency,status:row.status,attempts:integer(row.attempts),manualReplayCount:integer(row.manualReplayCount),paymentIntentPublicId:row.paymentIntentPublicId,orderPublicId:row.orderPublicId,nextAttemptAt:row.nextAttemptAt,createdAt:row.createdAt,version:row.__v||0});
    columns=['Event','Order','Country','Status','Attempts','Next attempt'];
  }else if(view==='cod'){
    Model=Shipment;scope={...context.countryScope,status:'delivered','cod.required':true};select='publicId orderPublicId country cod deliveryUserId createdAt __v';
    map=row=>({publicId:row.publicId,orderPublicId:row.orderPublicId,country:row.country,currency:row.cod.currency,amountMinor:integer(row.cod.amountMinor),collectedMinor:integer(row.cod.collectedMinor),declaredMinor:row.cod.handoverDeclaredMinor??null,handoverAt:row.cod.handoverAt,reconciledAt:row.cod.reconciledAt,hasHandoverReceipt:Boolean(row.cod.handoverEvidenceDocumentId),hasMismatch:Boolean(row.cod.mismatchExceptionPublicId),status:codState(row),canReconcile:codState(row)==='ready'&&String(row.deliveryUserId)!==String(context.actor._id)&&String(row.cod.handoverByUserId)!==String(context.actor._id),version:row.__v||0,createdAt:row.createdAt});
    columns=['Shipment','Order','Country','Expected cash','Collected cash','Status'];
    if(input.status==='reconciled')scope['cod.reconciledAt']={$ne:null};
    if(input.status==='ready'||input.status==='blocked'){
      const ready={$and:[{'cod.reconciledAt':null},{'cod.handoverAt':{$ne:null}},{'cod.handoverEvidenceDocumentId':{$exists:true,$ne:null}},{'cod.mismatchExceptionPublicId':''},{$expr:{$and:[{$eq:['$cod.handoverDeclaredMinor','$cod.collectedMinor']},{$eq:['$cod.collectedMinor','$cod.amountMinor']}]}}]};
      scope.$and=input.status==='ready'?[ready]:[{'cod.reconciledAt':null},{$nor:[ready]}];
    }
  }else{
    Model=ReconciliationRun;scope={...context.countryScope};select='publicId country provider currency status checked matched updated failed startedAt completedAt createdAt __v';
    map=row=>({publicId:row.publicId,country:row.country,provider:row.provider,currency:row.currency||null,status:row.status,checked:integer(row.checked),matched:integer(row.matched),updated:integer(row.updated),failed:integer(row.failed),startedAt:row.startedAt,completedAt:row.completedAt,createdAt:row.createdAt,version:row.__v||0});
    columns=['Run','Country','Provider','Checked','Updated','Exceptions','Status'];
  }
  if(view!=='cod'&&input.status!=='all')scope.status=input.status;
  if(input.search){const regex=new RegExp(escaped(input.search),'i');scope={$and:[scope,{$or:[{publicId:regex},{orderPublicId:regex},{paymentIntentPublicId:regex}]}]};}
  return {Model,scope,select,map,columns};
}
function cells(view,row){
  if(view==='disputes')return [row.publicId,row.orderPublicId,row.country,money(row.amountMinor,row.currency),label(row.status),date(row.openedAt)];
  if(view==='events')return [row.publicId,row.orderPublicId||'Unmatched',row.country,label(row.status),String(row.attempts),date(row.nextAttemptAt)];
  if(view==='cod')return [row.publicId,row.orderPublicId,row.country,money(row.amountMinor,row.currency),money(row.collectedMinor,row.currency),label(row.status)];
  return [row.publicId,row.country,row.provider,String(row.checked),String(row.updated),String(row.failed),label(row.status)];
}
async function metricsFor(context,view){
  if(view==='disputes'){
    const totals=await Chargeback.aggregate([...financeChargebackSource(moneyScope(context)),{$group:{_id:{status:'$status',currency:'$currency'},count:{$sum:1},amountMinor:{$sum:'$amountMinor'}}}]);
    const count=status=>totals.filter(row=>row._id.status===status).reduce((sum,row)=>sum+row.count,0);
    const exposure=new Map();for(const row of totals.filter(row=>['open','reviewing'].includes(row._id.status)))exposure.set(row._id.currency,(exposure.get(row._id.currency)||0)+row.amountMinor);
    return [{label:'Open disputes',value:count('open'),detail:'Provider reversals awaiting Finance review'},{label:'Under review',value:count('reviewing'),detail:'A second operator must confirm the outcome'},{label:'Protected exposure',value:[...exposure].map(([currency,amount])=>money(amount,currency)).join(' · ')||'0',detail:'Currencies are reported separately'},{label:'Resolved disputes',value:count('won')+count('lost'),detail:'Independently verified won and lost outcomes'}];
  }
  const [runs,failedRuns,eventCounts,readyCash]=await Promise.all([ReconciliationRun.countDocuments(context.countryScope),ReconciliationRun.countDocuments({...context.countryScope,status:'failed'}),ProviderEvent.aggregate([...providerEventSource({...context.countryScope,provider:'pesapal',status:{$in:['failed','dead']}}),{$count:'count'}]),Shipment.aggregate([...financeCodSource({...context.countryScope,status:'delivered','cod.required':true,'cod.reconciledAt':null}),{$count:'count'}]).then(rows=>rows[0]?.count||0)]);
  const exceptions=eventCounts[0]?.count||0;
  return [{label:'Reconciliation runs',value:runs,detail:'Recorded provider and COD reconciliation history'},{label:'Runs with exceptions',value:failedRuns,detail:'Resolve exceptions before running the report again'},{label:'Provider exceptions',value:exceptions,detail:'Failed and dead-letter events in your scope'},{label:'COD awaiting reconciliation',value:readyCash,detail:'Delivered cash shipments; evidence is checked before posting'}];
}
export async function loadFinanceReconciliationPage(request,pageId){
  if(!['finance-reconciliation','finance-disputes'].includes(pageId))throw new AppError('Finance report not found.',404,'FINANCE_PAGE_NOT_FOUND');
  const context=await financeAccess(request),input=queryFor(request,pageId),config=configuration(input.view,context,input),base='/finance/'+(pageId==='finance-disputes'?'disputes':'reconciliation');
  const metricsPromise=metricsFor(context,input.view);
  const [page]=await config.Model.aggregate([...recordSource(input.view,config.scope),{$project:recordProjection(config)},{$facet:{rows:[{$match:cursorScope({},input.after)},{$sort:cursorSort()},{$limit:SIZE+1}],total:[{$count:'count'}]}}]);
  const documents=page?.rows||[],total=page?.total?.[0]?.count||0;
  const metrics=await metricsPromise;
  const result=pageResult(documents,{limit:SIZE,total}),items=result.items.map(config.map);
  let selected=null;
  if(input.selected){const scope={$and:[config.scope,{publicId:input.selected}]};const [row]=await config.Model.aggregate([...recordSource(input.view,scope),{$project:recordProjection(config)},{$limit:1}]);if(!row)throw new AppError('The selected Finance record is unavailable in this report.',404,'FINANCE_RECORD_NOT_FOUND');selected=config.map(row);}
  const params={country:context.country,view:input.view==='disputes'?'runs':input.view,search:input.search,status:input.status};
  const url=(extra={})=>base+'?'+new URLSearchParams({...params,...extra});
  await assertFinanceExportAccess(request,context);
  return {kind:'reconciliation',pageId,...financePublicContext(context),market:context.market,metrics,columns:config.columns,rows:items.map(row=>({id:row.publicId,cells:cells(input.view,row),href:url({selected:row.publicId})})),items,selected,statuses:states[input.view],view:input.view,filters:{...input,view:input.view==='disputes'?'runs':input.view,params},page:result.page,pagination:{nextHref:result.page.hasMore?url({after:result.page.next}):null},exportHref:base+'/export.csv?'+new URLSearchParams(params),tabs:pageId==='finance-reconciliation'?['runs','events','cod'].map(view=>({id:view,label:({runs:'Reconciliation Runs',events:'Provider Exceptions',cod:'Cash on Delivery'})[view],href:base+'?'+new URLSearchParams({country:context.country,view}),active:view===input.view})):[],insights:[{text:pageId==='finance-disputes'?'Start a review, then ask a different operator to resolve it. Pesapal must independently confirm the requested outcome.':'Reconciliation compares Pesapal with saved payment records. Replaying an event schedules verification; it never confirms payment by itself.'}],health:{label:'Recorded controls',value:null,rows:metrics.map(metric=>({label:metric.label,value:metric.value})),note:'Counts reflect saved records. Provider truth and handover evidence are checked when you act.'},workflow:[{title:'Choose the report',text:'Select the country and report to review.'},{title:'Inspect the evidence',text:'Open the saved record and verify its reference and current state.'},{title:'Record the outcome',text:'Complete the protected action and review the resulting audit history.'}]};
}
export async function runFinanceReconciliation(request,input){return reconcilePayments(request,z.object({country:z.string().regex(/^[A-Z]{2}$/),hours:z.coerce.number().int().min(1).max(168).default(24)}).parse(input));}
export async function replayFinanceProviderEvent(request,id,input){const data=z.object({reason:z.string().trim().min(5).max(300)}).parse(input);return requeueProviderEvent(request,id,data);}
export async function reconcileFinanceCod(request,id){const access=await financeAccess(request),shipment=await Shipment.findOne(mongoose.trusted({publicId:id,...access.countryScope}));if(!shipment)throw new AppError('COD shipment not found.',404,'COD_SHIPMENT_MISSING');return reconcileCod({shipment,request,actorUserId:access.actor._id});}
export async function reviewFinanceDispute(request,id,input){const data=z.object({note:z.string().trim().min(5).max(500)}).parse(input);return reviewChargeback(request,id,data.note);}
export async function resolveFinanceDispute(request,id,input){return resolveChargeback(request,id,z.object({outcome:z.enum(['won','lost']),note:z.string().trim().min(5).max(500)}).parse(input));}
export async function streamFinanceReconciliationCsv(request,response,pageId){
  const context=await financeAccess(request),input=queryFor(request,pageId),config=configuration(input.view,context,input);
  const total=(await config.Model.aggregate([...recordSource(input.view,config.scope),{$count:'count'}]))[0]?.count||0;if(total>EXPORT_MAX)throw new AppError('Narrow this report to at most 10,000 records before exporting.',422,'FINANCE_EXPORT_TOO_LARGE');
  const session=await mongoose.startSession();try{await session.withTransaction(async()=>{const fresh=await financeAccess(request,{session,write:true,country:context.country});await writeAudit(request,'finance.'+(pageId==='finance-disputes'?'disputes':'reconciliation')+'_exported',{actor:fresh.actor,targetType:'finance_report',targetPublicId:pageId,country:context.country||undefined,metadata:{view:input.view,status:input.status},session});});}finally{await session.endSession();}
  await assertFinanceExportAccess(request,context);
  const cell=value=>'"'+(/^[\s\u0000-\u001f]*[=+\-@]/.test(String(value??''))?"'":'')+String(value??'').replaceAll('"','""')+'"';
  response.type('text/csv').set('Content-Disposition','attachment; filename="'+pageId+'-'+input.view+'.csv"');response.write(config.columns.map(cell).join(',')+'\r\n');
  const cursor=config.Model.aggregate([...recordSource(input.view,config.scope),{$project:recordProjection(config)},{$sort:cursorSort()}]).cursor({batchSize:100});
  try{for await(const row of cursor){if(response.destroyed)break;await assertFinanceExportAccess(request,context);if(!response.write(cells(input.view,config.map(row)).map(cell).join(',')+'\r\n'))await new Promise(resolve=>{const finish=()=>{response.removeListener('drain',finish);response.removeListener('close',finish);resolve();};response.once('drain',finish);response.once('close',finish);});}}finally{await cursor.close();}if(!response.destroyed)response.end();
}

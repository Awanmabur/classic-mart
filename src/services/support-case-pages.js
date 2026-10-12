import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { env } from '../config/env.js';
import { hasPermission } from '../core/roles.js';
import { ReturnRequest, Dispute, Order, SellerReturnCase, EvidenceDocument, User, Notification,
  SupportTicket, Warehouse, WarehouseTask, StockItem, Shipment, Refund, PlatformGrant, CountrySetting } from '../models/index.js';
import { supportAccess, fenceSupportAccess, assertSupportReadAccess, supportPublicContext } from './support-workspace-access.js';
import { decideReturn, inspectReturn, markReturnReceived, createExchangeReplacement } from './trust.js';
import { createWarehouseTask } from './logistics.js';
import { refreshOrderLifecycle } from './order-state.js';
import { cursorScope, cursorSort, pageResult, decodeCursor } from './pagination.js';
import { formatMinorUnits } from './catalogue.js';
import { writeAudit } from './audit.js';
import { queueFinanceAlert } from './finance-notifications.js';
import { sanitizeAndStoreEvidenceImage } from './media.js';
import { queueSupportAlert } from './support-notifications.js';

const id = z.string().trim().regex(/^[a-z][a-z0-9_-]{4,99}$/, 'Choose a valid case record.');
const version = z.union([z.number(), z.string().regex(/^\d+$/)]).pipe(z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const RETURN_STATUSES = ['requested','approved','rejected','awaiting_return','received','inspected','refund_pending','refund_processing','refunded','exchange_pending','exchanged','closed'];
const DISPUTE_STATUSES = ['open','investigating','awaiting_customer','awaiting_seller','resolved','rejected','appealed','closed'];
const closed = ['resolved','rejected','closed'];
const same = (a,b) => String(a || '') === String(b || '');
const human = value => String(value || '').replaceAll('_',' ').replace(/\b\w/g, value => value.toUpperCase());
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const href = (base, query, changes={}) => { const search=new URLSearchParams({...query,...changes});for(const [key,value] of [...search])if(!value||value==='all')search.delete(key);return base+(search.size?'?'+search:''); };
const and = (...clauses) => mongoose.trusted({$and:clauses.filter(clause=>Object.keys(clause).length)});
const conflict = () => new AppError('This case changed. Reload its latest record.',409,'SUPPORT_CASE_VERSION_CONFLICT');
function checkVersion(row, expected) {if(Number(row.__v || 0)!==expected)throw conflict();}
function filters(query, states) {
  const parsed=z.object({country:z.string().regex(/^$|^[A-Z]{2}$/).optional(),search:z.string().trim().max(100).default(''),q:z.string().trim().max(100).optional(),
    status:z.enum(['all',...states]).default('all'),after:z.string().max(512).default(''),record:id.optional()}).parse(query||{});
  if(parsed.after&&!decodeCursor(parsed.after))throw new AppError('The page cursor is invalid. Reload this queue.',422,'SUPPORT_CURSOR_INVALID');
  return {...parsed,search:parsed.search||parsed.q||''};
}
function pipeline(context, filter={}) {
  const match=and(context.countryScope,filter.status&&filter.status!=='all'?{status:filter.status}:{},filter.search?{$or:[{publicId:new RegExp(escapeRegex(filter.search),'i')},{orderPublicId:new RegExp(escapeRegex(filter.search),'i')},{subject:new RegExp(escapeRegex(filter.search),'i')}]}:{});
  const countries=context.countries.map(row=>({$and:[{$eq:['$country',row.code]},{$eq:['$order.totals.currency',row.currency]}]}));
  return [{$match:match},{$lookup:{from:Order.collection.name,localField:'orderId',foreignField:'_id',as:'order'}},{$unwind:'$order'},
    {$match:{$expr:{$and:[{$eq:['$orderPublicId','$order.publicId']},{$eq:['$country','$order.country']},{$eq:['$userId','$order.userId']},{$or:countries}]}}}];
}
async function evidenceFor(doc,type) {
  return EvidenceDocument.find({_id:mongoose.trusted({$in:doc.evidenceDocumentIds||[]}),country:doc.country,contextType:type,contextPublicId:doc.publicId,status:'ready'})
    .select('publicId description documentType createdAt').sort({createdAt:1}).lean().then(rows=>rows.map(row=>({publicId:row.publicId,description:row.description,documentType:row.documentType,createdAt:row.createdAt,href:'/support/evidence/'+encodeURIComponent(row.publicId)+'?country='+doc.country})));
}
function returnDto(row, currency, selected=false) {
  const dto={publicId:row.publicId,orderPublicId:row.orderPublicId,country:row.country,currency,status:row.status,reason:row.reason,resolution:row.resolution,
    returnMethod:row.returnMethod,amountMinor:(row.items||[]).reduce((sum,item)=>sum+Number(item.requestedRefundMinor||0),0),createdAt:row.createdAt,eligibleUntil:row.eligibleUntil,version:Number(row.__v||0)};
  if(!selected)return dto;
  return {...dto,details:row.details,policyVersion:row.policyVersion,refundPublicId:row.refundPublicId||'',replacementOrderPublicId:row.replacementOrderPublicId||'',returnShipmentPublicId:row.returnShipmentPublicId||'',
    inspection:row.inspection?{condition:row.inspection.condition,notes:row.inspection.notes,inspectedAt:row.inspection.inspectedAt}:null,
    financeReferral:row.financeReferral?.requestedAt?{requestedAt:row.financeReferral.requestedAt,note:row.financeReferral.note}:null,
    items:(row.items||[]).map(item=>({orderLineId:item.orderLineId,title:item.title,sku:item.sku,quantity:item.quantity,requestedRefundMinor:item.requestedRefundMinor,
      warehouseTaskPublicId:item.warehouseTaskPublicId||'',warehouseInspectionStatus:item.warehouseInspectionStatus||'',stockDisposition:item.stockDisposition||'',inspectedQuantity:item.inspectedQuantity||0,
      intakeWarehousePublicId:item.intakeWarehousePublicId||'',intakeEvidencePublicId:item.intakeEvidencePublicId||'',intakeReceivedAt:item.intakeReceivedAt||null})),
    timeline:(row.timeline||[]).slice(-80).map(event=>({type:event.type,message:event.message,at:event.at}))};
}
async function disputeDto(row,actor,selected=false) {
  const assignee=row.assignedUserId?await User.findById(row.assignedUserId).select('publicId name').lean():null;
  const dto={publicId:row.publicId,orderPublicId:row.orderPublicId,country:row.country,status:row.status,subject:row.subject,category:row.category,priority:row.priority,createdAt:row.createdAt,
    assigned:assignee?{publicId:assignee.publicId,name:assignee.name}:null,assignedToMe:same(row.assignedUserId,actor._id),version:Number(row.__v||0),resolvedAt:row.resolvedAt||null};
  if(!selected)return dto;
  return {...dto,description:row.description,review:row.review?.reviewedAt?{notes:row.review.notes,reviewedAt:row.review.reviewedAt}:null,
    escalation:row.escalation?.escalatedAt?{department:row.escalation.department,reason:row.escalation.reason,escalatedAt:row.escalation.escalatedAt,referralTicketPublicId:row.escalation.referralTicketPublicId||''}:null,
    resolution:row.resolution?.resolvedAt?{decision:row.resolution.decision,summary:row.resolution.summary,resolvedAt:row.resolution.resolvedAt}:null,
    events:(row.events||[]).slice(-80).map(event=>({type:event.type,message:event.message,visibility:event.visibility||'customer',at:event.at}))};
}

export async function loadSupportCasePage(request,pageId) {
  if(!['support-returns','support-disputes'].includes(pageId))throw new AppError('Support page not found.',404,'SUPPORT_PAGE_NOT_FOUND');
  const returns=pageId==='support-returns',states=returns?RETURN_STATUSES:DISPUTE_STATUSES,filter=filters(request.query,states),context=await supportAccess(request,{country:filter.country}),Model=returns?ReturnRequest:Dispute;
  const base=returns?'/support/returns':'/support/escalations',all=pipeline(context),filtered=pipeline(context,filter);
  const [records,counts,totalRows]=await Promise.all([
    Model.aggregate([...filtered,{$match:cursorScope({},filter.after)},{$sort:cursorSort()},{$limit:26},{$project:{order:0}}]),
    Model.aggregate([...all,{$group:{_id:'$status',count:{$sum:1}}}]),Model.aggregate([...filtered,{$count:'count'}])]);
  const paged=pageResult(records,{limit:25,total:totalRows[0]?.count||0}),currencyMap=new Map(context.countries.map(row=>[row.code,row.currency]));
  const items=returns?paged.items.map(row=>returnDto(row,currencyMap.get(row.country))):await Promise.all(paged.items.map(row=>disputeDto(row,context.actor)));
  const query={country:context.country,search:filter.search,status:filter.status};let selected=null;
  if(filter.record){const [doc]=await Model.aggregate([...all,{$match:{publicId:filter.record}},{$limit:1}]);if(!doc)throw new AppError('Case record not found.',404,'SUPPORT_CASE_NOT_FOUND');
    selected=returns?returnDto(doc,doc.order.totals.currency,true):await disputeDto(doc,context.actor,true);selected.evidence=await evidenceFor(doc,returns?'return':'dispute');
    if(returns){
      selected.sellerCases=await SellerReturnCase.find({returnRequestId:doc._id,country:doc.country,orderPublicId:doc.orderPublicId}).select('publicId storePublicId status responseMessage evidenceDocumentIds').lean();
      selected.sellerCases=await Promise.all(selected.sellerCases.map(async row=>({publicId:row.publicId,storePublicId:row.storePublicId,status:row.status,responseMessage:row.responseMessage||'',evidence:await evidenceFor({...row,country:doc.country},'seller_return')})));
      const pickup=doc.returnMethod==='pickup'?await Shipment.exists({publicId:doc.returnShipmentPublicId,returnRequestId:doc._id,orderId:doc.orderId,country:doc.country,kind:'return',status:'delivered',deliveredAt:mongoose.trusted({$type:'date'}),'proof.reference':'verified'}):null;
      selected.canReceive=['approved','awaiting_return'].includes(doc.status)&&(doc.returnMethod==='pickup'?Boolean(pickup):doc.items.every(item=>item.intakeReceivedAt&&item.intakeEvidencePublicId&&item.intakeWarehousePublicId));
      selected.canInspect=doc.status==='received'&&doc.items.every(item=>item.warehouseInspectionStatus==='completed');
    }
  }
  const count=values=>counts.filter(row=>values.includes(row._id)).reduce((sum,row)=>sum+row.count,0),total=counts.reduce((sum,row)=>sum+row.count,0);
  await assertSupportReadAccess(request,context);
  return {context:supportPublicContext(context),kind:'cases',caseKind:returns?'returns':'disputes',pageId,items,selected,country:context.country,market:context.market,
    metrics:returns?[{label:'Return requests',value:String(total),detail:'All valid scoped returns'},{label:'Awaiting decision',value:String(count(['requested'])),detail:'Eligible requests awaiting a saved decision'},
      {label:'Goods in review',value:String(count(['awaiting_return','approved','received'])),detail:'Awaiting verified receipt or warehouse inspection'},{label:'Ready for resolution',value:String(count(['refund_pending','exchange_pending'])),detail:'Inspected returns awaiting the next authorized step'}]
      :[{label:'Escalation cases',value:String(total),detail:'All valid scoped order disputes'},{label:'Active investigations',value:String(count(['open','investigating','appealed'])),detail:'Open or reopened reviews'},
        {label:'Awaiting response',value:String(count(['awaiting_customer','awaiting_seller'])),detail:'Cases requiring a customer or seller response'},{label:'Resolved cases',value:String(count(['resolved','rejected','closed'])),detail:'Saved completed decisions'}],
    columns:returns?['Return','Order','Requested value','Resolution','Status']:['Case','Subject','Priority','Assignee','Status'],
    rows:items.map(row=>({id:row.publicId,cells:returns?[row.publicId,row.orderPublicId,formatMinorUnits(row.amountMinor,row.currency,context.actor.locale),human(row.resolution),human(row.status)]:[row.publicId,row.subject,human(row.priority),row.assigned?.name||'Unassigned',human(row.status)],href:href(base,query,{record:row.publicId})})),
    filters:{...filter,country:context.country,statuses:[{value:'all',label:'All statuses'},...states.map(value=>({value,label:human(value)}))]},page:paged.page,
    pagination:{...paged.page,nextHref:paged.page.hasMore?href(base,query,{after:paged.page.next}):''},exportHref:href(base+'/export.csv',query),create:null,
    insights:[{text:returns?'Receipt and stock inspection require saved physical evidence. Finance confirms actual refunds.':'Cases keep review notes separate from customer messages and route specialized decisions to the authorized team.',href:returns?'/support/escalations':'/support/queue',label:returns?'Review escalations':'Open support tickets'}],
    workflow:returns?[{title:'Decide an eligible return',text:'Review the delivered order, buyer evidence and seller response before approving or rejecting.',href:href(base,{country:context.country,status:'requested'}),label:'Review requests'},
      {title:'Complete the inspected resolution',text:'Refer an inspected refund to Finance or reserve an exchange against actual stock.',href:href(base,{country:context.country,status:'refund_pending'}),label:'Review ready returns'}]
      :[{title:'Assign and review',text:'Claim a case, review the order evidence and send a meaningful customer update.',href:base,label:'Review cases'}]};
}

const csvCell = value => {let text=String(value??'');if(/^[\s\u0000-\u001f]*[=+@-]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
function drained(response) {return new Promise((resolve,reject)=>{const done=error=>{response.off('drain',onDrain);response.off('close',onClose);response.off('error',onError);error?reject(error):resolve();};const onDrain=()=>done(),onClose=()=>done(),onError=error=>done(error);response.once('drain',onDrain);response.once('close',onClose);response.once('error',onError);});}
export async function streamSupportCaseCsv(request,response,pageId) {
  const returns=pageId==='support-returns';if(!returns&&pageId!=='support-disputes')throw new AppError('Support export not found.',404,'SUPPORT_PAGE_NOT_FOUND');
  const context=await supportAccess(request),filter=filters(request.query,returns?RETURN_STATUSES:DISPUTE_STATUSES),Model=returns?ReturnRequest:Dispute;
  await writeAudit(request,'support.case_export_requested',{actor:context.actor,targetType:returns?'return':'dispute',country:context.country||undefined});
  response.set({'Cache-Control':'private, no-store','Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="support-${returns?'returns':'escalations'}.csv"`});
  response.write(['Case','Order','Country','Type','Status','Created at'].map(csvCell).join(',')+'\r\n');
  const cursor=Model.aggregate([...pipeline(context,filter),{$sort:cursorSort()},{$project:{publicId:1,orderPublicId:1,country:1,reason:1,category:1,status:1,createdAt:1}}]).cursor({batchSize:100});
  try{for await(const row of cursor){await assertSupportReadAccess(request,context);if(response.destroyed)break;
    const line=[row.publicId,row.orderPublicId,row.country,returns?row.reason:row.category,row.status,new Date(row.createdAt).toISOString()].map(csvCell).join(',')+'\r\n';
    if(!response.write(line))await drained(response);
  }await assertSupportReadAccess(request,context);if(!response.destroyed)response.end();}finally{await cursor.close();}
}

export async function decideSupportReturn(request,returnId,body) {
  await supportAccess(request);const parsed=z.object({version,decision:z.enum(['approve','reject']),note:z.string().trim().min(10).max(300)}).parse(body);
  const doc=await decideReturn(request,id.parse(returnId),parsed);return {publicId:doc.publicId,status:doc.status,version:doc.__v};
}
export async function receiveSupportReturn(request,returnId,body) {
  await supportAccess(request);const parsed=z.object({version,note:z.string().trim().max(300).default('')}).parse(body);
  const doc=await markReturnReceived(request,id.parse(returnId),parsed);return {publicId:doc.publicId,status:doc.status,version:doc.__v};
}
export async function inspectSupportReturn(request,returnId,body) {
  await supportAccess(request);const parsed=z.object({version,condition:z.enum(['unopened','good','damaged','wrong_item','counterfeit_suspected','missing_parts']),notes:z.string().trim().min(10).max(1000)}).parse(body);
  const doc=await inspectReturn(request,id.parse(returnId),parsed);return {publicId:doc.publicId,status:doc.status,version:doc.__v};
}
export async function exchangeSupportReturn(request,returnId,body) {
  await supportAccess(request);const parsed=z.object({version}).parse(body),order=await createExchangeReplacement(request,id.parse(returnId),parsed);
  return {publicId:returnId,replacementOrderPublicId:order.publicId};
}
async function transact(request,operation) {
  const session=await mongoose.startSession();let result;
  try{await session.withTransaction(async()=>{const context=await supportAccess(request,{session,country:''});result=await operation(context,session);});return result;}
  catch(error){if(error.name==='VersionError')throw conflict();throw error;}finally{await session.endSession();}
}
async function caseRecord(Model,context,publicId,session) {
  const row=await Model.findOne(and(context.countryScope,{publicId:id.parse(publicId)})).session(session);if(!row)throw new AppError('Case not found.',404,'SUPPORT_CASE_NOT_FOUND');
  const order=await Order.findOne({_id:row.orderId,publicId:row.orderPublicId,country:row.country,userId:row.userId}).session(session);
  if(!order||context.countries.find(country=>country.code===row.country)?.currency!==order.totals.currency)throw new AppError('The case does not match its original market order.',409,'SUPPORT_CASE_ORDER_MISMATCH');return {row,order};
}
/** Finance consumes this immutable, inspected goods snapshot inside its own authorization transaction. */
export async function returnFinancialAllocations({returnRequest:row,order,session=null,statuses=['refund_pending'],requireReferral=true}) {
  if(!row||!order||!same(row.orderId,order._id)||row.orderPublicId!==order.publicId||row.country!==order.country||!same(row.userId,order.userId)||row.resolution!=='refund'||!statuses.includes(row.status)||!row.inspection?.inspectedAt||requireReferral&&!row.financeReferral?.requestedAt)throw new AppError('This return is not ready for an inspected Finance refund.',409,'RETURN_FINANCE_SNAPSHOT_INVALID');
  const seen=new Set(),allocations=[];let amountMinor=0;
  for(const item of row.items){
    const original=order.items.find(line=>line.linePublicId===item.orderLineId);
    const task=await WarehouseTask.findOne({publicId:item.warehouseTaskPublicId,type:'return_inspection',status:'completed',returnRequestId:row._id,orderId:order._id,returnOrderLineId:item.orderLineId,storeId:item.storeId,variantId:item.variantId,quantity:item.quantity}).session(session).lean();
    const warehouse=task?await Warehouse.exists({_id:task.warehouseId,country:row.country,storeId:item.storeId}).session(session):null;
    if(seen.has(item.orderLineId)||!original||!same(original.storeId,item.storeId)||original.storePublicId!==item.storePublicId||!same(original.productId,item.productId)||!same(original.variantId,item.variantId)||original.productPublicId!==item.productPublicId||original.returnedQuantity<item.quantity||!warehouse||item.warehouseInspectionStatus!=='completed'||item.inspectedQuantity!==item.quantity||!item.warehouseInspectedAt||!item.warehouseInspectedByUserId||task.result?.disposition!==item.stockDisposition||!Number.isSafeInteger(item.requestedRefundMinor)||item.requestedRefundMinor<0)throw new AppError('Finance refund lines must match completed exact warehouse inspections and received order goods.',409,'RETURN_FINANCE_SNAPSHOT_INVALID');
    if(row.returnMethod==='dropoff'&&!await EvidenceDocument.exists({publicId:item.intakeEvidencePublicId,country:row.country,contextType:'return',contextPublicId:row.publicId,contextLinePublicId:item.orderLineId,documentType:'return_receipt',status:'ready',ownerUserId:item.intakeReceivedByUserId}).session(session))throw new AppError('Recorded drop-off receipt evidence is unavailable.',409,'RETURN_FINANCE_SNAPSHOT_INVALID');
    seen.add(item.orderLineId);amountMinor+=item.requestedRefundMinor;if(!Number.isSafeInteger(amountMinor)||amountMinor>2_000_000_000)throw new AppError('Return financial amount is invalid.',409,'RETURN_FINANCE_SNAPSHOT_INVALID');
    if(item.requestedRefundMinor>0)allocations.push({storePublicId:item.storePublicId,productPublicId:item.productPublicId,orderLineId:item.orderLineId,grossMinor:item.requestedRefundMinor});
  }
  if(row.returnMethod==='pickup'&&!await Shipment.exists({publicId:row.returnShipmentPublicId,returnRequestId:row._id,orderId:order._id,country:row.country,kind:'return',status:'delivered',deliveredAt:mongoose.trusted({$type:'date'}),'proof.reference':'verified'}).session(session))throw new AppError('Verified return delivery is unavailable.',409,'RETURN_FINANCE_SNAPSHOT_INVALID');
  if(!allocations.length||amountMinor<=0)throw new AppError('No paid returned goods are available for refund.',409,'RETURN_FINANCE_SNAPSHOT_INVALID');
  return {amountMinor,allocations};
}
export async function referSupportReturnToFinance(request,caseId,body) {
  const parsed=z.object({version,note:z.string().trim().min(10).max(500)}).parse(body);
  return transact(request,async(context,session)=>{const {row}=await caseRecord(ReturnRequest,context,caseId,session);
    if(row.financeReferral?.requestedAt)return {publicId:row.publicId,status:row.status,alreadyReferred:true};checkVersion(row,parsed.version);
    const order=await Order.findById(row.orderId).session(session);await returnFinancialAllocations({returnRequest:row,order,session,requireReferral:false});
    await fenceSupportAccess(context,session);row.financeReferral={requestedAt:new Date(),requestedByUserId:context.actor._id,note:parsed.note};
    row.timeline.push({type:'return.finance_referred',message:'Inspected refund referred to Finance for an independent payment review.',actorUserId:context.actor._id});await row.save({session});
    await queueFinanceAlert({country:row.country,kind:'priority',href:'/finance/refunds?return='+encodeURIComponent(row.publicId)},session);
    await Notification.create([{publicId:publicId('ntf'),userId:row.userId,country:row.country,type:'return_update',title:'Return refund sent for Finance review',body:`${row.publicId}: The inspected refund is awaiting Finance review. No disbursement has been confirmed.`,href:'/returns'}],{session});
    await writeAudit(request,'support.return_finance_referred',{actor:context.actor,targetType:'return',targetPublicId:row.publicId,country:row.country,session});return {publicId:row.publicId,status:row.status,version:row.__v};});
}
async function disputeMutation(request,caseId,parsed,operation) {
  return transact(request,async(context,session)=>{const {row,order}=await caseRecord(Dispute,context,caseId,session);checkVersion(row,parsed.version);
    if(closed.includes(row.status))throw new AppError('This case is finalized. A requester appeal is required to reopen it.',409,'DISPUTE_STATE');
    if(row.events.length>=998)throw new AppError('This case reached its conversation limit. Contact a supervisor for its next step.',409,'DISPUTE_THREAD_LIMIT');
    await fenceSupportAccess(context,session);await operation(context,row,order,session);row.increment();await row.save({session});return {publicId:row.publicId,status:row.status,version:row.__v};});
}
function assertIndependentAppealReviewer(row,actorId) {
  const appeal=(row.events||[]).filter(event=>event.type==='dispute.appealed').at(-1);
  if(appeal&&row.resolution?.resolvedByUserId&&same(row.resolution.resolvedByUserId,actorId)
    &&new Date(appeal.at).getTime()>=new Date(row.resolution.resolvedAt||0).getTime())throw new AppError('An appealed decision requires a different Support reviewer.',409,'DISPUTE_APPEAL_FOUR_EYES');
}
function assignedToActor(context,row) {assertIndependentAppealReviewer(row,context.actor._id);if(!same(row.assignedUserId,context.actor._id)&&!['country_admin','super_admin'].includes(context.actor.role))throw new AppError('Claim this case before reviewing or resolving it.',403,'DISPUTE_ASSIGNMENT_REQUIRED');}
async function customerMessage(context,row,message,session) {
  row.events.push({type:'dispute.customer_update',message,visibility:'customer',actorUserId:context.actor._id});
  await Notification.create([{publicId:publicId('ntf'),userId:row.userId,country:row.country,type:'dispute_update',title:'Your order case has an update',body:`${row.publicId}: ${message}`.slice(0,1500),href:'/returns'}],{session});
}
async function disputeAudit(request,context,row,action,session) {await writeAudit(request,action,{actor:context.actor,targetType:'dispute',targetPublicId:row.publicId,country:row.country,metadata:{status:row.status},session});}
export async function assignSupportDispute(request,caseId,body) {
  const parsed=z.object({version,assignee:id.optional()}).parse(body);
  return disputeMutation(request,caseId,parsed,async(context,row,order,session)=>{
    const target=parsed.assignee?await User.findOne({publicId:parsed.assignee}).session(session):context.actor;
    if(!target)throw new AppError('Support operator not found.',404,'SUPPORT_ASSIGNEE_NOT_FOUND');
    assertIndependentAppealReviewer(row,target._id);
    const targetContext=await supportAccess({user:target,session:{tokenVersion:target.security.tokenVersion},query:{country:row.country}},{session,country:row.country});
    if(row.assignedUserId&&!same(row.assignedUserId,context.actor._id)&&!['country_admin','super_admin'].includes(context.actor.role))throw new AppError('Only the assigned operator or an administrator can transfer this case.',403,'DISPUTE_ASSIGNMENT_REQUIRED');
    if(!same(target._id,context.actor._id))await fenceSupportAccess(targetContext,session);
    row.assignedUserId=target._id;if(['open','appealed'].includes(row.status))row.status='investigating';
    row.events.push({type:'dispute.assigned',message:`Case assigned to ${target.name}.`,visibility:'internal',actorUserId:context.actor._id});
    if(!same(target._id,context.actor._id))await Notification.create([{publicId:publicId('ntf'),userId:target._id,country:row.country,type:'support_assignment',title:'Order escalation assigned',body:'A scoped order case is ready for review.',href:'/support/escalations?record='+encodeURIComponent(row.publicId)}],{session});
    await disputeAudit(request,context,row,'support.dispute_assigned',session);
  });
}
export async function reviewSupportDispute(request,caseId,body) {
  const parsed=z.object({version,notes:z.string().trim().min(20).max(1000),message:z.string().trim().min(10).max(1000),status:z.enum(['investigating','awaiting_customer']).default('investigating')}).parse(body);
  return disputeMutation(request,caseId,parsed,async(context,row,order,session)=>{assignedToActor(context,row);row.status=parsed.status;row.review={notes:parsed.notes,reviewedByUserId:context.actor._id,reviewedAt:new Date()};
    row.events.push({type:'dispute.reviewed',message:parsed.notes,visibility:'internal',actorUserId:context.actor._id});await customerMessage(context,row,parsed.message,session);await disputeAudit(request,context,row,'support.dispute_reviewed',session);
  });
}
export async function escalateSupportDispute(request,caseId,body) {
  const parsed=z.object({version,department:z.enum(['finance','delivery','moderation','seller','support']),reason:z.string().trim().min(20).max(1000),message:z.string().trim().min(10).max(1000)}).parse(body);
  return disputeMutation(request,caseId,parsed,async(context,row,order,session)=>{assignedToActor(context,row);if(!row.review?.reviewedAt)throw new AppError('Record the case review before a departmental handoff.',409,'DISPUTE_REVIEW_REQUIRED');
    if(row.escalation?.department===parsed.department&&row.escalation?.referralTicketPublicId)throw new AppError('This departmental handoff is already recorded.',409,'DISPUTE_ALREADY_ESCALATED');
    const [ticket]=await SupportTicket.create([{publicId:publicId('tkt'),userId:row.userId,orderId:order._id,orderPublicId:order.publicId,country:row.country,category:parsed.department==='finance'?'payment':parsed.department==='delivery'?'delivery':parsed.department==='seller'||parsed.department==='moderation'?'seller':'other',
      subject:`Order case ${row.publicId}`.slice(0,180),priority:row.priority,queue:parsed.department==='finance'?'payments':parsed.department==='delivery'?'delivery':parsed.department==='seller'||parsed.department==='moderation'?'seller':'general',status:'escalated',
      createdByUserId:context.actor._id,source:'staff',slaDueAt:new Date(Date.now()+(row.priority==='urgent'?4:row.priority==='high'?12:48)*3600_000),notes:[{message:parsed.reason,internal:true,actorUserId:context.actor._id}],workflowHistory:[{action:'created',actorUserId:context.actor._id,toStatus:'escalated',note:`Saved ${parsed.department} referral for ${row.publicId}.`}]}],{session});
    row.status='investigating';row.escalation={department:parsed.department,reason:parsed.reason,escalatedAt:new Date(),escalatedByUserId:context.actor._id,referralTicketPublicId:ticket.publicId};
    row.events.push({type:'dispute.escalated',message:`Saved ${parsed.department} referral ${ticket.publicId}.`,visibility:'internal',actorUserId:context.actor._id});
    await queueSupportAlert({country:row.country,kind:'escalation',href:'/support/escalations?record='+encodeURIComponent(row.publicId)},session);
    if(parsed.department==='finance')await queueFinanceAlert({country:row.country,kind:'escalation',href:'/finance/payments?search='+encodeURIComponent(row.orderPublicId)+'&country='+row.country},session);
    await customerMessage(context,row,parsed.message,session);await disputeAudit(request,context,row,'support.dispute_escalated',session);
  });
}
export async function resolveSupportDispute(request,caseId,body) {
  const parsed=z.object({version,decision:z.enum(['customer_service','no_action','refund_confirmed','exchange_confirmed']),summary:z.string().trim().min(20).max(1000)}).parse(body);
  return disputeMutation(request,caseId,parsed,async(context,row,order,session)=>{assignedToActor(context,row);if(!row.review?.reviewedAt)throw new AppError('Record a review before resolving this case.',409,'DISPUTE_REVIEW_REQUIRED');
    if(parsed.decision==='refund_confirmed'&&!await Refund.exists({orderId:order._id,currency:order.totals.currency,status:'completed',completedAt:mongoose.trusted({$type:'date'})}).session(session))throw new AppError('Finance has not confirmed a completed refund for this order.',409,'DISPUTE_REFUND_UNCONFIRMED');
    if(parsed.decision==='exchange_confirmed'&&!await ReturnRequest.exists({orderId:order._id,country:row.country,status:'exchanged',replacementOrderPublicId:mongoose.trusted({$type:'string',$ne:''})}).session(session))throw new AppError('No committed exchange replacement is recorded for this order.',409,'DISPUTE_EXCHANGE_UNCONFIRMED');
    row.status=parsed.decision==='no_action'?'rejected':'resolved';row.resolvedAt=new Date();row.resolution={decision:parsed.decision,summary:parsed.summary,resolvedByUserId:context.actor._id,resolvedAt:row.resolvedAt};
    await customerMessage(context,row,parsed.summary,session);await disputeAudit(request,context,row,'support.dispute_resolved',session);
  });
}

export async function replyToOwnedDispute(request,caseId,body) {
  const parsed=z.object({version,message:z.string().trim().min(10).max(1000)}).parse(body),session=await mongoose.startSession();let result;
  try{await session.withTransaction(async()=>{
    const actor=await User.findById(request.user?._id).session(session);
    if(!actor||actor.status!=='active'||actor.security.tokenVersion!==request.user?.security?.tokenVersion||request.session?.tokenVersion!==undefined&&actor.security.tokenVersion!==request.session.tokenVersion||!env.auth.simpleLogin&&(!actor.emailVerifiedAt||!actor.onboardingCompletedAt))throw new AppError('Your verified account or session is unavailable.',403,'ACCOUNT_UNAVAILABLE');
    const row=await Dispute.findOne({publicId:id.parse(caseId),userId:actor._id}).session(session);if(!row)throw new AppError('Order case not found.',404,'DISPUTE_NOT_FOUND');checkVersion(row,parsed.version);
    if(closed.includes(row.status))throw new AppError('Appeal the completed decision before adding an investigation reply.',409,'DISPUTE_STATE');
    if(row.events.length>=1000)throw new AppError('This case reached its message limit. Contact Support for the next step.',409,'DISPUTE_THREAD_LIMIT');
    const order=await Order.findOne({_id:row.orderId,publicId:row.orderPublicId,country:row.country,userId:actor._id}).session(session);if(!order)throw new AppError('Case order not found.',404,'ORDER_NOT_FOUND');
    const market=await CountrySetting.findOne({code:row.country,active:true,currency:order.totals.currency}).session(session).lean();if(!market)throw new AppError('The original case market is unavailable.',409,'SUPPORT_MARKET_UNAVAILABLE');
    const marketFence=await CountrySetting.updateOne({_id:market._id,active:true,__v:market.__v||0,currency:market.currency,timeZone:market.timeZone},{$inc:{__v:1}},{session});if(marketFence.modifiedCount!==1)throw new AppError('The case market changed. Reload before replying.',409,'SUPPORT_MARKET_CHANGED');
    const orderFence=await Order.updateOne({_id:order._id,userId:actor._id,country:row.country,__v:order.__v||0},{$inc:{__v:1}},{session});if(orderFence.modifiedCount!==1)throw new AppError('The original order changed. Reload before replying.',409,'SUPPORT_CASE_ORDER_CHANGED');
    const fenced=await User.updateOne({_id:actor._id,status:'active',__v:actor.__v||0,'security.tokenVersion':actor.security.tokenVersion},{$inc:{__v:1}},{session});if(fenced.modifiedCount!==1)throw new AppError('Your account changed. Reload before replying.',409,'ACCOUNT_UNAVAILABLE');
    row.events.push({type:'dispute.customer_reply',message:parsed.message,visibility:'customer',actorUserId:actor._id});if(row.status==='awaiting_customer')row.status='investigating';row.increment();await row.save({session});
    await queueSupportAlert({country:row.country,kind:'priority',href:'/support/escalations?record='+encodeURIComponent(row.publicId)},session);
    await writeAudit(request,'customer.dispute_reply',{actor,targetType:'dispute',targetPublicId:row.publicId,country:row.country,session});
    result={publicId:row.publicId,status:row.status,version:row.__v,events:row.events.filter(event=>event.visibility!=='internal').map(event=>({type:event.type,message:event.message,at:event.at}))};
  });return result;}finally{await session.endSession();}
}

/** Physical drop-off receipt is recorded by the receiving warehouse, never inferred by Support. */
async function warehouseIntakeAccess(request,{session=null,mutation=false}={}) {
  if(!request.user?._id)throw new AppError('Warehouse authentication is required.',401,'UNAUTHENTICATED');
  const actor=await User.findById(request.user._id).select('+operationalCountries').session(session);
  if(!actor||actor.status!=='active'||actor.security.tokenVersion!==request.user.security?.tokenVersion||request.session?.tokenVersion!==undefined&&request.session.tokenVersion!==actor.security.tokenVersion)throw new AppError('Your warehouse account or session is unavailable.',403,'ACCOUNT_UNAVAILABLE');
  const storedRole=actor.role,now=new Date();let grant=null;
  if(actor.platformAccessManagedAt){const grants=await PlatformGrant.find({userId:actor._id,status:'active',startsAt:mongoose.trusted({$lte:now}),expiresAt:mongoose.trusted({$gt:now})}).limit(2).session(session).lean();
    if(grants.length!==1)throw new AppError('Current warehouse authorization is unavailable.',403,'WAREHOUSE_PERMISSION_DENIED');grant=grants[0];
    Object.defineProperty(actor,'authorizationContext',{value:{platformManaged:true,activePlatformGrants:[grant]},configurable:true});actor.role=grant.role;actor.operationalCountries=[...grant.operationalCountries];}
  if(!['warehouse','country_admin','super_admin'].includes(actor.role)&&!hasPermission(actor,'warehouse:manage'))throw new AppError('Only an authorized receiving warehouse can record physical intake.',403,'WAREHOUSE_PERMISSION_DENIED');
  if(!env.auth.simpleLogin&&(!actor.emailVerifiedAt||!actor.onboardingCompletedAt||env.security.privilegedMfaRequired&&!actor.security.mfaEnabled))throw new AppError('Complete verification, onboarding and required authenticator enrollment before warehouse receipt.',403,'ACCOUNT_UNAVAILABLE');
  const codes=grant?.operationalCountries|| (actor.role==='super_admin'?['*']:actor.operationalCountries?.length?actor.operationalCountries:[actor.country]);
  if(!codes.length||codes.some(code=>code!=='*'&&!/^[A-Z]{2}$/.test(code))||codes.includes('*')&&actor.role!=='super_admin')throw new AppError('Warehouse country authorization is unavailable.',403,'WAREHOUSE_PERMISSION_DENIED');
  const countries=await CountrySetting.find({active:true,...(codes.includes('*')?{}:{code:mongoose.trusted({$in:codes})})}).select('code currency timeZone __v').session(session).lean();
  if(!countries.length)throw new AppError('Warehouse markets are unavailable.',409,'WAREHOUSE_COUNTRY_UNAVAILABLE');
  const warehouseScopes=grant?.warehouseScopes||actor.roleProfile?.warehouseScopes||[];
  const scope={active:true,country:mongoose.trusted({$in:countries.map(country=>country.code)}),...(warehouseScopes.length?{publicId:mongoose.trusted({$in:warehouseScopes})}:{})};
  if(mutation){
    if(!session?.inTransaction())throw new AppError('Return intake requires a transaction.',500,'WAREHOUSE_TRANSACTION_REQUIRED');
    const account=await User.updateOne({_id:actor._id,status:'active',role:storedRole,__v:actor.__v||0,'security.tokenVersion':actor.security.tokenVersion},{$inc:{__v:1}},{session});if(account.modifiedCount!==1)throw new AppError('Warehouse authorization changed. Reload before receipt.',409,'WAREHOUSE_ACCESS_CHANGED');
    if(grant){const claimed=await PlatformGrant.updateOne({_id:grant._id,__v:grant.__v||0,status:'active',role:grant.role,startsAt:mongoose.trusted({$lte:now}),expiresAt:mongoose.trusted({$gt:now})},{$inc:{__v:1}},{session});if(claimed.modifiedCount!==1)throw new AppError('Warehouse authorization changed. Reload before receipt.',409,'WAREHOUSE_ACCESS_CHANGED');}
    for(const country of countries){const claimed=await CountrySetting.updateOne({_id:country._id,active:true,__v:country.__v||0,currency:country.currency,timeZone:country.timeZone},{$inc:{__v:1}},{session});if(claimed.modifiedCount!==1)throw new AppError('Warehouse market configuration changed.',409,'WAREHOUSE_ACCESS_CHANGED');}
  }
  return {actor,scope,countries,grant};
}
export async function warehouseReturnReceiptEvidenceRecord(request,evidenceId) {
  const access=await warehouseIntakeAccess(request);
  const evidence=await EvidenceDocument.findOne({publicId:id.parse(evidenceId),status:'ready',documentType:'return_receipt',contextType:'return',country:mongoose.trusted({$in:access.countries.map(row=>row.code)})}).select('+storageKey').lean();
  if(!evidence)throw new AppError('Receiving receipt not found.',404,'EVIDENCE_NOT_FOUND');
  const doc=await ReturnRequest.findOne({publicId:evidence.contextPublicId,country:evidence.country,evidenceDocumentIds:evidence._id}).lean();
  const line=doc?.items.find(item=>item.orderLineId===evidence.contextLinePublicId);
  if(!line)throw new AppError('Receiving receipt access denied.',403,'FORBIDDEN');
  const warehouse=await Warehouse.exists(and(access.scope,{storeId:line.storeId,country:doc.country,...(line.intakeWarehousePublicId?{publicId:line.intakeWarehousePublicId}:{})}));
  const order=await Order.exists({_id:doc.orderId,publicId:doc.orderPublicId,userId:doc.userId,country:doc.country,items:mongoose.trusted({$elemMatch:{linePublicId:line.orderLineId,storeId:line.storeId,variantId:line.variantId}})});
  if(!warehouse||!order)throw new AppError('Receiving receipt access denied.',403,'FORBIDDEN');
  const fresh=await warehouseIntakeAccess(request);
  const signature=ctx=>JSON.stringify({grant:String(ctx.grant?._id||''),scope:ctx.scope,countries:ctx.countries.map(row=>row.code+':'+row.currency+':'+row.timeZone).sort()});
  if(signature(fresh)!==signature(access))throw new AppError('Receiving scope changed. Reload before opening this receipt.',403,'WAREHOUSE_SCOPE_CHANGED');
  return evidence;
}
export async function loadWarehouseReturnIntakes(request) {
  const access=await warehouseIntakeAccess(request),warehouses=await Warehouse.find(access.scope).select('publicId storeId country name').limit(501).lean();
  if(warehouses.length>500)throw new AppError('Select a narrower warehouse assignment before opening return intake.',422,'WAREHOUSE_SCOPE_TOO_LARGE');
  const choicesByStoreCountry=new Map();
  for(const warehouse of warehouses){const key=warehouse.country+':'+String(warehouse.storeId);const choices=choicesByStoreCountry.get(key)||[];choices.push(warehouse);choicesByStoreCountry.set(key,choices);}
  const clauses=[...choicesByStoreCountry.values()].map(([row])=>({country:row.country,'items.storeId':row.storeId}));
  if(!clauses.length)return {items:[],warehouses:[],page:{total:0,hasMore:false,next:''}};
  const after=z.string().max(512).default('').parse(request.query?.intakesAfter);if(after&&!decodeCursor(after))throw new AppError('Reload the warehouse intake queue.',422,'WAREHOUSE_CURSOR_INVALID');
  const base=mongoose.trusted({returnMethod:'dropoff',status:mongoose.trusted({$in:['approved','awaiting_return']}),$or:clauses});
  const [rows,total]=await Promise.all([ReturnRequest.find(cursorScope(base,after)).select('publicId orderPublicId country items evidenceDocumentIds __v createdAt').sort(cursorSort()).limit(26).lean(),ReturnRequest.countDocuments(base)]);
  const paged=pageResult(rows,{limit:25,total});
  for(const row of paged.items){
    if(row.items.length>20||new Set(row.items.map(item=>item.orderLineId)).size!==row.items.length)throw new AppError('This return needs its immutable item records corrected before receiving.',409,'RETURN_INTAKE_ITEMS_INVALID');
  }
  const receiptClauses=paged.items.filter(row=>row.evidenceDocumentIds.length).map(row=>({country:row.country,contextPublicId:row.publicId,
    contextLinePublicId:{$in:row.items.filter(item=>choicesByStoreCountry.has(row.country+':'+String(item.storeId))).map(item=>item.orderLineId)},_id:{$in:row.evidenceDocumentIds}}));
  const receiptGroups=receiptClauses.length?await EvidenceDocument.aggregate([
    {$match:{ownerUserId:access.actor._id,contextType:'return',documentType:'return_receipt',status:'ready',$or:receiptClauses}},
    {$group:{_id:{country:'$country',returnPublicId:'$contextPublicId',orderLineId:'$contextLinePublicId'},receipts:{$topN:{n:20,sortBy:{createdAt:-1,_id:-1},output:{publicId:'$publicId',description:'$description',createdAt:'$createdAt'}}}}}
  ]):[];
  const receiptsByLine=new Map(receiptGroups.map(row=>[row._id.country+':'+row._id.returnPublicId+':'+row._id.orderLineId,row.receipts]));
  const items=paged.items.map(row=>({publicId:row.publicId,orderPublicId:row.orderPublicId,country:row.country,version:row.__v,
    lines:row.items.filter(item=>choicesByStoreCountry.has(row.country+':'+String(item.storeId))).map(item=>({orderLineId:item.orderLineId,title:item.title,quantity:item.quantity,intakeReceivedAt:item.intakeReceivedAt||null,intakeWarehousePublicId:item.intakeWarehousePublicId||'',
      warehouses:choicesByStoreCountry.get(row.country+':'+String(item.storeId)).map(({publicId,name})=>({publicId,name})),
      receipts:receiptsByLine.get(row.country+':'+row.publicId+':'+item.orderLineId)||[]
    })) }));
  const current=await warehouseIntakeAccess(request);
  const keys=context=>JSON.stringify({grant:String(context.grant?._id||''),countries:context.countries.map(row=>row.code+':'+row.currency+':'+row.timeZone).sort(),scope:context.scope});
  if(keys(current)!==keys(access))throw new AppError('Your warehouse intake scope changed during this read.',403,'WAREHOUSE_SCOPE_CHANGED');
  return {warehouses:warehouses.map(({publicId,name,country})=>({publicId,name,country})),items,page:paged.page};
}
async function intakeLine(request,returnId,body,session=null,mutation=false) {
  const parsed=z.object({version,orderLineId:id,warehousePublicId:id,evidencePublicId:id.optional(),note:z.string().trim().max(300).default('')}).parse(body);
  const access=await warehouseIntakeAccess(request,{session,mutation});
  const warehouse=await Warehouse.findOne(and(access.scope,{publicId:parsed.warehousePublicId})).session(session);if(!warehouse)throw new AppError('Receiving warehouse is outside your current scope.',403,'RETURN_INTAKE_WAREHOUSE_FORBIDDEN');
  const doc=await ReturnRequest.findOne({publicId:id.parse(returnId),country:warehouse.country,returnMethod:'dropoff',status:mongoose.trusted({$in:['approved','awaiting_return']})}).session(session);
  if(!doc)throw new AppError('Drop-off return is not awaiting warehouse intake.',409,'RETURN_INTAKE_STATE');checkVersion(doc,parsed.version);
  const line=doc.items.find(item=>item.orderLineId===parsed.orderLineId);if(!line||!same(line.storeId,warehouse.storeId))throw new AppError('Return line belongs to another receiving store.',403,'RETURN_INTAKE_LINE_FORBIDDEN');
  const order=await Order.findOne({_id:doc.orderId,publicId:doc.orderPublicId,country:doc.country,userId:doc.userId}).session(session);const original=order?.items.find(item=>item.linePublicId===line.orderLineId);
  if(!original||!same(original.variantId,line.variantId)||!same(original.storeId,line.storeId)||original.returnReservedQuantity<line.quantity)throw new AppError('The received goods do not match the reserved delivered order line.',409,'RETURN_INTAKE_LINE_MISMATCH');
  return {parsed,access,warehouse,doc,line,order};
}
export async function uploadWarehouseReturnIntakeEvidence(request,returnId,body,file) {
  const {access,doc,parsed}=await intakeLine(request,returnId,body);
  const evidence=await sanitizeAndStoreEvidenceImage({file,user:access.actor,country:doc.country,contextType:'return',contextPublicId:doc.publicId,contextLinePublicId:parsed.orderLineId,documentType:'return_receipt',description:`Warehouse intake receipt for ${parsed.orderLineId}`});
  const session=await mongoose.startSession();
  try{await session.withTransaction(async()=>{const context=await intakeLine(request,returnId,body,session,true);context.doc.evidenceDocumentIds.push(evidence._id);context.doc.timeline.push({type:'return.intake_evidence_added',message:`Private receiving evidence saved for ${parsed.orderLineId}.`,actorUserId:context.access.actor._id});await context.doc.save({session});
    await writeAudit(request,'warehouse.return_intake_evidence_added',{actor:context.access.actor,targetType:'return',targetPublicId:doc.publicId,country:doc.country,metadata:{evidencePublicId:evidence.publicId},session});});
    return {publicId:doc.publicId,evidencePublicId:evidence.publicId,version:(await ReturnRequest.findById(doc._id).select('__v').lean()).__v};
  }catch(error){await EvidenceDocument.updateOne({_id:evidence._id},{$set:{status:'rejected'}});throw error;}finally{await session.endSession();}
}
export async function recordWarehouseReturnIntake(request,returnId,body) {
  const session=await mongoose.startSession();let result;
  try{await session.withTransaction(async()=>{const {parsed,access,warehouse,doc,line,order}=await intakeLine(request,returnId,body,session,true);
    if(line.intakeReceivedAt)throw new AppError('This exact return line already has a recorded receipt.',409,'RETURN_INTAKE_DUPLICATE');
    const evidence=await EvidenceDocument.findOne({publicId:parsed.evidencePublicId,ownerUserId:access.actor._id,country:doc.country,contextType:'return',contextPublicId:doc.publicId,contextLinePublicId:line.orderLineId,documentType:'return_receipt',status:'ready',_id:mongoose.trusted({$in:doc.evidenceDocumentIds})}).session(session);
    if(!evidence)throw new AppError('Upload a ready warehouse receipt image for this return before confirming intake.',422,'RETURN_INTAKE_EVIDENCE_REQUIRED');
    await Warehouse.updateOne({_id:warehouse._id,active:true,country:doc.country,storeId:line.storeId},{$inc:{__v:1}},{session});
    line.intakeWarehousePublicId=warehouse.publicId;line.intakeEvidencePublicId=evidence.publicId;line.intakeReceivedAt=new Date();line.intakeReceivedByUserId=access.actor._id;
    doc.timeline.push({type:'return.warehouse_intake',message:`${line.orderLineId} × ${line.quantity} physically received at ${warehouse.publicId}.`,actorUserId:access.actor._id});
    if(doc.items.every(item=>item.intakeReceivedAt)){
      for(const item of doc.items){const receiving=await Warehouse.findOne({publicId:item.intakeWarehousePublicId,storeId:item.storeId,country:doc.country,active:true}).session(session);
        const receipt=await EvidenceDocument.exists({publicId:item.intakeEvidencePublicId,ownerUserId:item.intakeReceivedByUserId,country:doc.country,contextType:'return',contextPublicId:doc.publicId,contextLinePublicId:item.orderLineId,documentType:'return_receipt',status:'ready'}).session(session);
        if(!receiving||!receipt)throw new AppError('A prior warehouse intake or its receipt is unavailable.',409,'RETURN_INTAKE_REQUIRED');
        const original=order.items.find(row=>row.linePublicId===item.orderLineId);if(!original||original.returnReservedQuantity<item.quantity)throw new AppError('Return quantity reservation is inconsistent.',409,'RETURN_RESERVATION_CONFLICT');
        let stock=await StockItem.findOne({storeId:item.storeId,variantId:item.variantId,warehouseId:receiving._id}).session(session);if(!stock)[stock]=await StockItem.create([{publicId:publicId('stk'),storeId:item.storeId,variantId:item.variantId,warehouseId:receiving._id,onHand:0,reserved:0,damaged:0,quarantined:0,reorderPoint:0}],{session});
        const task=await createWarehouseTask({sourceKey:`return-inspection:${doc.publicId}:${item.orderLineId}`,warehouseId:receiving._id,storeId:item.storeId,orderId:order._id,returnRequestId:doc._id,returnOrderLineId:item.orderLineId,stockItemId:stock._id,variantId:item.variantId,type:'return_inspection',reference:doc.publicId,notes:`Inspect physically received return ${doc.publicId}`,quantity:item.quantity},session);
        item.warehouseTaskPublicId=task.publicId;item.warehouseInspectionStatus='pending';original.returnReservedQuantity-=item.quantity;original.returnedQuantity=Number(original.returnedQuantity||0)+item.quantity;if(original.returnedQuantity>original.deliveredQuantity)throw new AppError('Returned quantity exceeds verified delivered goods.',409,'RETURN_QUANTITY_CONFLICT');
      }
      doc.status='received';doc.timeline.push({type:'return.received',message:'All exact return lines have recorded warehouse receipts and authoritative inspection tasks.',actorUserId:access.actor._id});await order.save({session});
      await Notification.create([{publicId:publicId('ntf'),userId:doc.userId,country:doc.country,type:'return_update',title:'Returned goods received',body:`${doc.publicId}: Received goods are awaiting warehouse inspection.`,href:'/returns'}],{session});
    }
    await doc.save({session});await refreshOrderLifecycle(order._id,{session});await writeAudit(request,'warehouse.return_intake_recorded',{actor:access.actor,targetType:'return',targetPublicId:doc.publicId,country:doc.country,metadata:{orderLineId:line.orderLineId,warehousePublicId:warehouse.publicId,evidencePublicId:evidence.publicId},session});
    result={publicId:doc.publicId,status:doc.status,version:doc.__v,warehouseTaskPublicId:line.warehouseTaskPublicId||''};
  });return result;}finally{await session.endSession();}
}

/** Read accepted evidence only when it remains attached to the currently scoped case. */
export async function supportEvidenceRecord(request,publicId) {
  const context=await supportAccess(request),evidence=await EvidenceDocument.findOne(and(context.countryScope,{publicId:id.parse(publicId),status:'ready'})).select('+storageKey').lean();
  if(!evidence)throw new AppError('Evidence not found.',404,'EVIDENCE_NOT_FOUND');let attached=null;
  if(evidence.contextType==='return')attached=await ReturnRequest.exists(and(context.countryScope,{publicId:evidence.contextPublicId,evidenceDocumentIds:evidence._id}));
  else if(evidence.contextType==='dispute')attached=await Dispute.exists(and(context.countryScope,{publicId:evidence.contextPublicId,evidenceDocumentIds:evidence._id}));
  else if(evidence.contextType==='seller_return')attached=await SellerReturnCase.exists(and(context.countryScope,{publicId:evidence.contextPublicId,evidenceDocumentIds:evidence._id}));
  else if(evidence.contextType==='support')attached=await SupportTicket.exists(and(context.countryScope,{publicId:evidence.contextPublicId,evidenceDocumentIds:evidence._id}));
  if(!attached)throw new AppError('Accepted case evidence not found.',404,'EVIDENCE_NOT_FOUND');await assertSupportReadAccess(request,context);return evidence;
}

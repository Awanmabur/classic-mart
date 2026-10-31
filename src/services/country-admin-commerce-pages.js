import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { Order, SellerOrder, Shipment, ReturnRequest, SellerReturnCase, PaymentIntent, Refund, ProviderEvent, EvidenceDocument, Notification } from '../models/index.js';
import { countryAdminAccess, fenceCountryAdminAccess, assertCountryAdminReadAccess, countryAdminPublicContext } from './country-admin-workspace-access.js';
import { cursorScope, cursorSort, pageResult, decodeCursor } from './pagination.js';
import { formatMinorUnits } from './catalogue.js';
import { decideReturn, markReturnReceived, inspectReturn, createExchangeReplacement } from './trust.js';
import { returnFinancialAllocations } from './support-case-pages.js';
import { verifyAndApplyPayment, createRefund, completeManualRefund, requeueProviderEvent, reconcilePayments } from './payments.js';
import { sanitizeAndStoreEvidenceImage } from './media.js';
import { writeAudit } from './audit.js';
import { queueFinanceAlert } from './finance-notifications.js';

const identifier = z.string().trim().regex(/^[a-z][a-z0-9_-]{4,99}$/);
const version = z.union([z.number(), z.string().regex(/^\d+$/)]).pipe(z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const states = {
  orders: ['pending_payment','payment_failed','confirmed','paid','cancellation_pending','cancelled','expired','partially_refunded','refunded'],
  returns: ['requested','approved','rejected','awaiting_return','received','inspected','refund_pending','refund_processing','refunded','exchange_pending','exchanged','closed'],
  payments: ['created','requires_action','pending','succeeded','failed','cancelled','pending_collection','refunded','partially_refunded','reversed'],
  refunds: ['pending','processing','completed','failed','cancelled'],
  events: ['received','processing','processed','ignored','failed','dead'],
};
const and = (...clauses) => { const filters = clauses.filter(clause => clause && Object.keys(clause).length); return filters.length ? mongoose.trusted({$and: filters}) : {}; };
const same = (left,right) => String(left || '') === String(right || '');
const human = value => String(value || '').replaceAll('_',' ').replace(/\b\w/g, letter => letter.toUpperCase());
const escaped = value => String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function integer(value) { const result=Number(value || 0); if(!Number.isSafeInteger(result)||result<0)throw new AppError('The recorded amount is invalid.',409,'ADMIN_COMMERCE_AMOUNT_INVALID');return result; }
function href(base,query,changes={}) {const params=new URLSearchParams({...query,...changes});for(const [key,value] of [...params])if(!value||value==='all')params.delete(key);return base+(params.size?'?'+params:'');}
function input(query,pageId) {
  const parsed=z.object({country:z.string().regex(/^$|^[A-Z]{2}$/).optional(),search:z.string().trim().max(100).default(''),q:z.string().trim().max(100).optional(),
    status:z.string().max(40).default('all'),after:z.string().max(512).default(''),record:identifier.optional(),return:identifier.optional(),
    view:z.enum(['payments','refunds','events']).default('payments')}).parse(query || {});
  if(parsed.return&&query?.view===undefined)parsed.view='refunds';
  const kind=pageId==='admin-orders'?'orders':pageId==='admin-returns'?'returns':pageId==='admin-payments'?parsed.view:null;
  if(!kind)throw new AppError('Commerce page not found.',404,'ADMIN_COMMERCE_PAGE_NOT_FOUND');
  if(parsed.status!=='all'&&!states[kind].includes(parsed.status))throw new AppError('Select a supported commerce status.',422,'ADMIN_COMMERCE_FILTER_INVALID');
  if(parsed.after&&!decodeCursor(parsed.after))throw new AppError('Reload the commerce queue with a valid cursor.',422,'ADMIN_COMMERCE_CURSOR_INVALID');
  return {...parsed,search:parsed.q ?? parsed.search,kind};
}
const models = {orders:Order,returns:ReturnRequest,payments:PaymentIntent,refunds:Refund,events:ProviderEvent};
function markets(context,country='$country',currency='$totals.currency') {
  return {$or:context.countries.filter(row=>!context.country||row.code===context.country).map(row=>({$and:[{$eq:[country,row.code]},{$eq:[currency,row.currency]}]}))};
}
/** Every record is joined to its immutable original order and active market currency. */
function pipeline(context,kind,filter={}) {
  const search=filter.search?new RegExp(escaped(filter.search),'i'):null;
  const match=and(kind==='refunds'?{}:context.countryScope,filter.status&&filter.status!=='all'?{status:filter.status}:{},search?{$or:[{publicId:search},{orderPublicId:search}]}:{});
  if(kind==='orders')return [{$match:match},{$match:{$expr:markets(context)}}];
  if(kind==='events')return [{$match:match},{$lookup:{from:PaymentIntent.collection.name,localField:'merchantReference',foreignField:'providerReference',as:'intent'}},{$unwind:'$intent'},
    {$lookup:{from:Order.collection.name,localField:'intent.orderId',foreignField:'_id',as:'order'}},{$unwind:'$order'},
    {$match:{$expr:{$and:[{$eq:['$provider','pesapal']},{$eq:['$intent.provider','$provider']},{$eq:['$providerTrackingId','$intent.providerTrackingId']},{$ne:['$providerTrackingId','']},
      {$eq:['$country','$order.country']},{$eq:['$intent.country','$order.country']},{$eq:['$intent.orderPublicId','$order.publicId']},{$eq:['$intent.currency','$order.totals.currency']},markets(context,'$order.country','$order.totals.currency'),{$ne:['$verifiedAt',null]}]}}}];
  const result=[{$match:match},{$lookup:{from:Order.collection.name,localField:'orderId',foreignField:'_id',as:'order'}},{$unwind:'$order'}];
  const binding=[markets(context,'$order.country','$order.totals.currency')];
  if(kind==='returns')binding.push({$eq:['$orderPublicId','$order.publicId']},{$eq:['$country','$order.country']},{$eq:['$userId','$order.userId']});
  if(kind==='payments')binding.push({$eq:['$orderPublicId','$order.publicId']},{$eq:['$country','$order.country']},{$eq:['$currency','$order.totals.currency']});
  if(kind==='refunds'){
    result.push({$lookup:{from:PaymentIntent.collection.name,localField:'paymentIntentId',foreignField:'_id',as:'intent'}},{$unwind:'$intent'});
    binding.push({$eq:['$currency','$order.totals.currency']},{$eq:['$intent.orderId','$order._id']},{$eq:['$intent.orderPublicId','$order.publicId']},{$eq:['$intent.country','$order.country']},{$eq:['$intent.currency','$currency']});
  }
  result.push({$match:{$expr:{$and:binding}}});return result;
}
function paymentDto(row) {
  return {publicId:row.publicId,orderPublicId:row.orderPublicId,country:row.country,currency:row.currency,amountMinor:integer(row.amountMinor),provider:row.provider,method:row.method,status:row.status,
    createdAt:row.createdAt,paidAt:row.paidAt||null,lastVerifiedAt:row.lastVerifiedAt||null,refundedMinor:integer(row.refundedMinor),refundReservedMinor:integer(row.refundReservedMinor),
    remainingRefundMinor:Math.max(0,integer(row.amountMinor)-integer(row.refundedMinor)-integer(row.refundReservedMinor)),version:Number(row.__v||0),canVerify:row.provider==='pesapal'&&Boolean(row.providerTrackingId)};
}
function orderDto(row,selected=false) {
  const result={publicId:row.publicId,country:row.country,currency:row.totals.currency,amountMinor:integer(row.totals.totalMinor),status:row.status,paymentState:row.paymentState,fulfillmentState:row.fulfillmentState,
    returnState:row.returnState,refundState:row.refundState,cancellationState:row.cancellationState,createdAt:row.createdAt,version:Number(row.__v||0)};
  if(!selected)return result;
  return {...result,buyer:{name:'Buyer contact protected',email:'••••',phone:'••••'+String(row.contact?.phone||'').slice(-4)},
    items:(row.items||[]).map(item=>({orderLineId:item.linePublicId,storePublicId:item.storePublicId,productPublicId:item.productPublicId,title:item.title,sku:item.sku,quantity:item.quantity,
      deliveredQuantity:item.deliveredQuantity,returnedQuantity:item.returnedQuantity,refundedQuantity:item.refundedQuantity,lineTotalMinor:integer(item.lineTotalMinor),currency:item.currency})),
    timeline:(row.timeline||[]).slice(-40).map(event=>({type:event.type,message:event.message,at:event.at}))};
}
function returnDto(row,selected=false) {
  const result={publicId:row.publicId,orderPublicId:row.orderPublicId,country:row.country,currency:row.order.totals.currency,amountMinor:(row.items||[]).reduce((sum,item)=>integer(sum+integer(item.requestedRefundMinor)),0),
    status:row.status,reason:row.reason,resolution:row.resolution,returnMethod:row.returnMethod,createdAt:row.createdAt,version:Number(row.__v||0)};
  if(!selected)return result;
  return {...result,details:row.details,policyVersion:row.policyVersion,refundPublicId:row.refundPublicId||'',replacementOrderPublicId:row.replacementOrderPublicId||'',
    inspection:row.inspection?.inspectedAt?{condition:row.inspection.condition,notes:row.inspection.notes,inspectedAt:row.inspection.inspectedAt}:null,
    financeReferral:row.financeReferral?.requestedAt?{requestedAt:row.financeReferral.requestedAt,note:row.financeReferral.note}:null,
    items:(row.items||[]).map(item=>({orderLineId:item.orderLineId,title:item.title,sku:item.sku,quantity:item.quantity,requestedRefundMinor:integer(item.requestedRefundMinor),
      warehouseTaskPublicId:item.warehouseTaskPublicId||'',warehouseInspectionStatus:item.warehouseInspectionStatus||'',stockDisposition:item.stockDisposition||'',inspectedQuantity:item.inspectedQuantity||0,
      intakeWarehousePublicId:item.intakeWarehousePublicId||'',intakeReceivedAt:item.intakeReceivedAt||null})),
    timeline:(row.timeline||[]).slice(-40).map(event=>({type:event.type,message:event.message,at:event.at}))};
}
function refundDto(row,actor) {return {publicId:row.publicId,orderPublicId:row.order.publicId,country:row.order.country,currency:row.currency,amountMinor:integer(row.amountMinor),provider:row.provider,
  status:row.status,reason:row.reason,createdAt:row.createdAt,completedAt:row.completedAt||null,returnPublicId:row.returnPublicId||'',manualReference:row.manualReference||'',version:Number(row.__v||0),
  canComplete:Boolean(row.returnPublicId)&&row.status==='processing'&&['cod_manual','external_manual','pesapal'].includes(row.provider)&&!same(row.requestedByUserId,actor._id)};}
function eventDto(row) {return {publicId:row.publicId,orderPublicId:row.order.publicId,paymentPublicId:row.intent.publicId,country:row.order.country,currency:row.order.totals.currency,
  provider:row.provider,eventType:row.eventType,status:row.status,attempts:integer(row.attempts),verifiedAt:row.verifiedAt,processedAt:row.processedAt||null,createdAt:row.createdAt,
  version:Number(row.__v||0),canReplay:['failed','dead','ignored'].includes(row.status)&&(!row.lockedUntil||new Date(row.lockedUntil)<=new Date())};}
const dto=(row,kind,context,selected=false)=>kind==='orders'?orderDto(row,selected):kind==='returns'?returnDto(row,selected):kind==='payments'?paymentDto(row):kind==='refunds'?refundDto(row,context.actor):eventDto(row);
async function record(context,kind,id,{session=null}={}) {
  const [row]=await models[kind].aggregate([...pipeline(context,kind),{$match:{publicId:identifier.parse(id)}},{$limit:1}]).session(session);
  if(!row)throw new AppError('Commerce record not found.',404,'ADMIN_COMMERCE_RECORD_NOT_FOUND');return row;
}
async function evidenceList(doc,type='return',actor=null) {
  return EvidenceDocument.find({ _id:mongoose.trusted({$in:doc.evidenceDocumentIds||[]}),country:doc.country,contextType:type,contextPublicId:doc.publicId,status:'ready'})
    .select('publicId description documentType createdAt contextLinePublicId refundPublicId ownerUserId').sort({createdAt:-1,_id:-1}).limit(25).lean()
    .then(rows=>rows.map(row=>({publicId:row.publicId,description:row.description,documentType:row.documentType,createdAt:row.createdAt,contextLinePublicId:row.contextLinePublicId,refundPublicId:row.refundPublicId,canConfirm:Boolean(actor)&&same(actor._id,row.ownerUserId),
      href:'/admin/commerce/evidence/'+encodeURIComponent(row.publicId)+'?country='+doc.country})));
}
function assertReturnLines(row) {
  const seen=new Set();for(const item of row.items||[]){const original=row.order.items.find(line=>line.linePublicId===item.orderLineId);
    if(seen.has(item.orderLineId)||!original||!same(original.productId,item.productId)||!same(original.variantId,item.variantId)||!same(original.storeId,item.storeId)||original.productPublicId!==item.productPublicId||original.storePublicId!==item.storePublicId||!Number.isSafeInteger(item.quantity)||item.quantity<=0||item.quantity>original.deliveredQuantity)
      throw new AppError('The return does not match its delivered immutable order lines.',409,'ADMIN_RETURN_SOURCE_MISMATCH');seen.add(item.orderLineId);}
}
function independentReturn(row,actor) {
  if([row.inspection?.inspectedByUserId,row.financeReferral?.requestedByUserId].some(value=>value&&same(value,actor._id)))
    throw new AppError('A different operator must review and reserve the inspected return refund.',403,'FOUR_EYES_REQUIRED');
}
async function returnSelection(context,row) {
  assertReturnLines(row);const selected=returnDto(row,true);selected.evidence=await evidenceList(row);
  const cases=await SellerReturnCase.find({returnRequestId:row._id,returnPublicId:row.publicId,orderPublicId:row.orderPublicId,country:row.country}).select('publicId country storePublicId status responseMessage evidenceDocumentIds').limit(25).lean();
  selected.sellerCases=await Promise.all(cases.map(async item=>({publicId:item.publicId,storePublicId:item.storePublicId,status:item.status,responseMessage:item.responseMessage||'',evidence:await evidenceList(item,'seller_return')})));
  selected.canReceive=['approved','awaiting_return'].includes(row.status)&&(row.returnMethod==='pickup'?Boolean(await Shipment.exists({publicId:row.returnShipmentPublicId,returnRequestId:row._id,orderId:row.orderId,orderPublicId:row.orderPublicId,country:row.country,kind:'return',status:'delivered',deliveredAt:mongoose.trusted({$type:'date'}),'proof.reference':'verified'})):row.items.every(item=>item.intakeReceivedAt&&item.intakeWarehousePublicId&&item.intakeEvidencePublicId));
  selected.canInspect=row.status==='received'&&row.items.every(item=>item.warehouseInspectionStatus==='completed'&&item.inspectedQuantity===item.quantity);
  selected.canReserveRefund=false;
  if(row.status==='refund_pending'&&row.financeReferral?.requestedAt){
    await returnFinancialAllocations({returnRequest:row,order:row.order});
    selected.canReserveRefund=![row.inspection?.inspectedByUserId,row.financeReferral?.requestedByUserId].some(value=>same(value,context.actor._id));
  }
  return selected;
}
async function selectedOrder(context,row) {
  const selected=orderDto(row,true);
  const [sellers,shipments,payments,returns]=await Promise.all([
    SellerOrder.find({orderId:row._id,orderPublicId:row.publicId,country:row.country,currency:row.totals.currency}).select('publicId storePublicId status items').limit(101).lean(),
    Shipment.find({orderId:row._id,orderPublicId:row.publicId,country:row.country}).select('publicId kind status deliveredAt proof.reference cod.currency cod.required').limit(26).lean(),
    PaymentIntent.find({orderId:row._id,orderPublicId:row.publicId,country:row.country,currency:row.totals.currency}).select('publicId status amountMinor currency provider method paidAt lastVerifiedAt refundReservedMinor refundedMinor __v providerTrackingId createdAt orderPublicId country').sort(cursorSort()).limit(25).lean(),
    ReturnRequest.find({orderId:row._id,orderPublicId:row.publicId,country:row.country,userId:row.userId}).select('publicId status resolution').sort(cursorSort()).limit(25).lean(),
  ]);
  if(sellers.length>100)throw new AppError('This order has too many seller partitions to display safely.',409,'ADMIN_ORDER_PARTITIONS_INVALID');
  selected.sellerOrders=sellers.filter(seller=>seller.items.every(item=>row.items.some(original=>original.linePublicId===item.orderLineId&&original.storePublicId===seller.storePublicId&&original.productPublicId===item.productPublicId&&original.variantPublicId===item.variantPublicId&&original.quantity===item.quantity)))
    .map(seller=>({publicId:seller.publicId,storePublicId:seller.storePublicId,status:seller.status,lines:seller.items.map(item=>({orderLineId:item.orderLineId,title:item.title,quantity:item.quantity}))}));
  selected.shipments=shipments.filter(item=>!item.cod?.required||item.cod.currency===row.totals.currency).slice(0,25).map(item=>({publicId:item.publicId,kind:item.kind,status:item.status,deliveredAt:item.deliveredAt||null,verifiedDelivery:item.status==='delivered'&&Boolean(item.deliveredAt)&&item.proof?.reference==='verified'}));
  selected.payments=payments.map(paymentDto);selected.returns=returns.map(item=>({publicId:item.publicId,status:item.status,resolution:item.resolution,href:'/admin/returns?country='+row.country+'&record='+encodeURIComponent(item.publicId)}));return selected;
}
function metrics(summary,kind,context) {
  const count=list=>summary.filter(row=>!list||list.includes(row._id.status)).reduce((sum,row)=>integer(sum+row.count),0);
  const money=list=>{const totals=new Map();for(const row of summary)if(list.includes(row._id.status))totals.set(row._id.currency,integer((totals.get(row._id.currency)||0)+integer(row.amountMinor)));return totals.size?[...totals].sort(([a],[b])=>a.localeCompare(b)).map(([currency,amount])=>new Intl.NumberFormat(context.actor.locale||'en',{style:'currency',currency,currencyDisplay:'code',maximumFractionDigits:['UGX','RWF'].includes(currency)?0:2}).format(amount/(['UGX','RWF'].includes(currency)?1:100))).join(' · '):'—';};
  const item=(label,value,detail)=>({label,value:String(value),detail});
  if(kind==='orders')return [item('Orders',count(),'All source orders in the selected markets'),item('Paid orders',count(['paid','partially_refunded','refunded']),'Recorded payment outcomes'),item('Order value',money(states.orders),'Order value separated by currency'),item('Awaiting payment',count(['pending_payment','payment_failed']),'Orders requiring a verified payment outcome')];
  if(kind==='returns')return [item('Return requests',count(),'Returns joined to their original orders'),item('Awaiting decision',count(['requested']),'Delivered goods requiring review'),item('Goods in review',count(['approved','awaiting_return','received']),'Actual receipt and warehouse inspections'),item('Ready for resolution',count(['refund_pending','exchange_pending']),'Inspected goods awaiting independent resolution')];
  if(kind==='payments')return [item('Captured value',money(['succeeded','partially_refunded','refunded']),'Verified payment records separated by currency'),item('Payments',count(),'Payments joined to their original orders'),item('Awaiting outcome',count(['created','requires_action','pending','pending_collection']),'Provider verification or cash reconciliation required'),item('Failed or reversed',count(['failed','reversed']),'Actual recorded provider outcomes')];
  if(kind==='refunds')return [item('Completed value',money(['completed']),'Confirmed refund outcomes separated by currency'),item('Refunds',count(),'Refunds bound to original payments'),item('Awaiting confirmation',count(['pending','processing']),'Reservations awaiting evidence of disbursement'),item('Failed refunds',count(['failed']),'Recorded failures requiring review')];
  return [item('Provider events',count(),'Verified events matched to scoped payments'),item('Processed',count(['processed']),'Worker outcomes already recorded'),item('Awaiting processing',count(['received','processing']),'Queued provider verification'),item('Replay eligible',count(['failed','dead','ignored']),'Failed events requiring a reasoned replay')];
}
export async function loadCountryAdminCommercePage(request,pageId) {
  const filter=input(request.query,pageId),context=await countryAdminAccess(request,{country:filter.country}),Model=models[filter.kind],base='/admin/'+pageId.slice(6);
  const currency=filter.kind==='orders'?'$totals.currency':filter.kind==='returns'||filter.kind==='events'?'$order.totals.currency':'$currency';
  const amount=filter.kind==='orders'?'$totals.totalMinor':filter.kind==='returns'?{$sum:'$items.requestedRefundMinor'}:filter.kind==='events'?0:'$amountMinor';
  const [records,total,summary]=await Promise.all([
    Model.aggregate([...pipeline(context,filter.kind,filter),{$match:cursorScope({},filter.after)},{$sort:cursorSort()},{$limit:26}]),
    Model.aggregate([...pipeline(context,filter.kind,filter),{$count:'count'}]),
    Model.aggregate([...pipeline(context,filter.kind),{$group:{_id:{status:'$status',currency},count:{$sum:1},amountMinor:{$sum:amount}}}]),
  ]);
  const paged=pageResult(records,{limit:25,total:total[0]?.count||0}),items=paged.items.map(row=>dto(row,filter.kind,context));let selected=null,refundOrder=null;
  if(filter.record){const row=await record(context,filter.kind,filter.record);selected=filter.kind==='orders'?await selectedOrder(context,row):filter.kind==='returns'?await returnSelection(context,row):dto(row,filter.kind,context,true);
    if(filter.kind==='refunds'&&row.returnPublicId){const returned=await record(context,'returns',row.returnPublicId);if(!same(returned._id,row.returnRequestId)||returned.refundPublicId!==row.publicId)throw new AppError('Refund and return bindings do not match.',409,'RETURN_REFUND_BINDING_CONFLICT');selected.evidence=(await evidenceList(returned,'return',context.actor)).filter(item=>item.refundPublicId===row.publicId);selected.canComplete=selected.canComplete&&![returned.inspection?.inspectedByUserId,returned.financeReferral?.requestedByUserId].some(value=>same(value,context.actor._id));}
  }
  if(pageId==='admin-payments'&&filter.return){
    const returned=await record(context,'returns',filter.return);assertReturnLines(returned);
    const snapshot=await returnFinancialAllocations({returnRequest:returned,order:returned.order,statuses:['refund_pending','refund_processing','refunded']});
    if(returned.status==='refund_pending'){
      independentReturn(returned,context.actor);
      const payment=await PaymentIntent.findOne({orderId:returned.orderId,orderPublicId:returned.orderPublicId,country:returned.country,currency:returned.order.totals.currency,status:mongoose.trusted({$in:['succeeded','partially_refunded','refunded']})}).sort({paidAt:-1,_id:-1}).lean();
      if(!payment)throw new AppError('Verified return payment not found.',409,'REFUND_PAYMENT_MISSING');
      refundOrder={publicId:returned.orderPublicId,country:returned.country,currency:returned.order.totals.currency,returnPublicId:returned.publicId,returnVersion:Number(returned.__v||0),amountMinor:snapshot.amountMinor,payment:paymentDto(payment),
        items:snapshot.allocations.map(item=>({orderLineId:item.orderLineId,title:returned.items.find(line=>line.orderLineId===item.orderLineId).title,quantity:returned.items.find(line=>line.orderLineId===item.orderLineId).quantity,grossMinor:item.grossMinor}))};
    }else{selected=dto(await record(context,'refunds',returned.refundPublicId),'refunds',context,true);selected.evidence=(await evidenceList(returned,'return',context.actor)).filter(item=>item.refundPublicId===selected.publicId);selected.canComplete=selected.canComplete&&![returned.inspection?.inspectedByUserId,returned.financeReferral?.requestedByUserId].some(value=>same(value,context.actor._id));}
  }
  const query={country:context.country,search:filter.search,status:filter.status,...(pageId==='admin-payments'?{view:filter.view}:{})};
  const money=row=>formatMinorUnits(row.amountMinor,row.currency,context.actor.locale);
  const columns=filter.kind==='orders'?['Order','Market','Value','Payment','Fulfilment']:filter.kind==='returns'?['Return','Order','Requested value','Resolution','Status']:filter.kind==='payments'||filter.kind==='refunds'?['Record','Order','Value','Provider','Status']:['Event','Order','Provider','Attempts','Status'];
  await assertCountryAdminReadAccess(request,context);
  return {kind:'commerce',commerceKind:filter.kind,pageId,context:countryAdminPublicContext(context),...countryAdminPublicContext(context),items,selected,refundOrder,
    idempotencyKey:refundOrder?'return-refund:'+refundOrder.returnPublicId:crypto.randomUUID(),metrics:metrics(summary,filter.kind,context),columns,
    rows:items.map(row=>({id:row.publicId,href:href(base,query,{record:row.publicId}),cells:filter.kind==='orders'?[row.publicId,row.country,money(row),human(row.paymentState),human(row.fulfillmentState)]:filter.kind==='returns'?[row.publicId,row.orderPublicId,money(row),human(row.resolution),human(row.status)]:filter.kind==='events'?[row.publicId,row.orderPublicId,human(row.provider),String(row.attempts),human(row.status)]:[row.publicId,row.orderPublicId,money(row),human(row.provider),human(row.status)]})),
    filters:{...filter,country:context.country,statuses:[{value:'all',label:'All statuses'},...states[filter.kind].map(value=>({value,label:human(value)}))]},page:paged.page,
    pagination:{...paged.page,nextHref:paged.page.hasMore?href(base,query,{after:paged.page.next}):''},exportHref:href(base+'/export.csv',query),tableTitle:human(filter.kind),create:null,
    insights:[{text:'Orders, physical returns and payment outcomes follow their recorded source evidence.',href:'/admin/returns',label:'Review returns'}],
    workflow:[{title:'Review source records',text:'Open an order to inspect its seller partitions, shipment proof and payment records.',href:'/admin/orders',label:'Review orders'},
      {title:'Confirm inspected resolution',text:'Review the actual receipt, warehouse inspection and independently confirmed refund.',href:'/admin/returns',label:'Review returns'}]};
}

export function countryAdminCommerceCsvCell(value) {let result=String(value??'');if(/^[\s\u0000-\u001f]*[=+@-]/u.test(result))result="'"+result;return '"'+result.replaceAll('"','""')+'"';}
async function csvWrite(response,cells) {
  if(response.destroyed)return false;if(response.write(cells.map(countryAdminCommerceCsvCell).join(',')+'\r\n'))return true;
  return new Promise((resolve,reject)=>{const cleanup=()=>{response.off('drain',drain);response.off('close',close);response.off('error',error);};const drain=()=>{cleanup();resolve(true);},close=()=>{cleanup();resolve(false);},error=err=>{cleanup();reject(err);};response.once('drain',drain);response.once('close',close);response.once('error',error);});
}
async function transaction(operation) {const session=await mongoose.startSession();let result;try{await session.withTransaction(async()=>{result=await operation(session);});return result;}finally{await session.endSession();}}
export async function streamCountryAdminCommerceCsv(request,response,pageId) {
  const filter=input(request.query,pageId),context=await countryAdminAccess(request,{country:filter.country});
  await transaction(async session=>{const fresh=await countryAdminAccess(request,{session,country:context.country});await fenceCountryAdminAccess(fresh,session,{allMarkets:true});for(const market of fresh.countries.filter(row=>!fresh.country||row.code===fresh.country))await writeAudit(request,'admin.commerce_exported',{actor:fresh.actor,targetType:'admin_export',country:market.code,metadata:{pageId,view:filter.kind,status:filter.status},session});});
  await assertCountryAdminReadAccess(request,context);
  response.set({'Cache-Control':'private, no-store','Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${pageId}-${filter.kind}.csv"`});
  if(!await csvWrite(response,['Record','Order','Country','Currency','Amount minor','Status','Created at']))return;
  const cursor=models[filter.kind].aggregate([...pipeline(context,filter.kind,filter),{$sort:cursorSort()}]).cursor({batchSize:100});
  try{for await(const row of cursor){await assertCountryAdminReadAccess(request,context);const item=dto(row,filter.kind,context);if(!await csvWrite(response,[item.publicId,item.orderPublicId||item.publicId,item.country,item.currency,item.amountMinor??'',item.status,new Date(item.createdAt).toISOString()]))break;}await assertCountryAdminReadAccess(request,context);if(!response.destroyed)response.end();}finally{await cursor.close();}
}
/** This property is created only by this server module and is rechecked inside domain transactions. */
function adminRequest(request,extra={}) {return Object.assign(Object.create(request),{requiredOperationalWorkspace:'admin',...extra});}
export async function mutateCountryAdminReturn(request,id,action,body={}) {
  const context=await countryAdminAccess(request,{country:''});await record(context,'returns',id);
  let parsed;
  if(action==='decision')parsed=z.object({version,decision:z.enum(['approve','reject']),note:z.string().trim().min(10).max(300)}).parse(body);
  else if(action==='receive')parsed=z.object({version,note:z.string().trim().max(300).default('')}).parse(body);
  else if(action==='inspect')parsed=z.object({version,condition:z.enum(['unopened','good','damaged','wrong_item','counterfeit_suspected','missing_parts']),notes:z.string().trim().min(10).max(1000)}).parse(body);
  else if(action==='exchange')parsed=z.object({version}).parse(body);
  else if(action==='refer-finance'){
    parsed=z.object({version,note:z.string().trim().min(10).max(500)}).parse(body);
    return transaction(async session=>{const fresh=await countryAdminAccess(request,{session,country:''}),row=await record(fresh,'returns',id,{session});
      if(Number(row.__v||0)!==parsed.version)throw new AppError('This return changed. Reload its current record.',409,'ADMIN_COMMERCE_VERSION_CONFLICT');
      if(row.financeReferral?.requestedAt)return {publicId:row.publicId,status:row.status,version:row.__v,alreadyReferred:true};
      await returnFinancialAllocations({returnRequest:row,order:row.order,session,requireReferral:false});await fenceCountryAdminAccess(fresh,session);
      const updated=await ReturnRequest.findOneAndUpdate({_id:row._id,__v:parsed.version,status:'refund_pending'},{$set:{financeReferral:{requestedAt:new Date(),requestedByUserId:fresh.actor._id,note:parsed.note}},$push:{timeline:{type:'return.finance_referred',message:'Inspected refund referred for independent financial review.',actorUserId:fresh.actor._id,at:new Date()}},$inc:{__v:1}},{session,returnDocument:'after'});
      if(!updated)throw new AppError('The inspected return changed.',409,'ADMIN_COMMERCE_VERSION_CONFLICT');
      await queueFinanceAlert({country:row.country,kind:'priority',href:'/finance/refunds?return='+encodeURIComponent(row.publicId)},session);
      await Notification.create([{publicId:publicId('ntf'),userId:row.userId,country:row.country,type:'return_update',title:'Return refund under review',body:row.publicId+': The inspected refund is awaiting independent payment review.',href:'/returns'}],{session});
      await writeAudit(request,'admin.return_finance_referred',{actor:fresh.actor,targetType:'return',targetPublicId:row.publicId,country:row.country,session});return {publicId:updated.publicId,status:updated.status,version:Number(updated.__v||0)};
    });
  }else throw new AppError('Return action not found.',404,'ADMIN_RETURN_ACTION_INVALID');
  const operations={decision:decideReturn,receive:markReturnReceived,inspect:inspectReturn,exchange:createExchangeReplacement};
  const result=await operations[action](adminRequest(request),identifier.parse(id),parsed);
  return action==='exchange'?{publicId:id,replacementOrderPublicId:result.publicId}:{publicId:result.publicId,status:result.status,version:Number(result.__v||0)};
}
export async function verifyCountryAdminPayment(request,id,body={}) {
  const parsed=z.object({version}).parse(body),context=await countryAdminAccess(request,{country:''}),row=await record(context,'payments',id);
  if(row.provider!=='pesapal'||!row.providerTrackingId)throw new AppError('Only a linked Pesapal payment can be independently verified.',409,'PESAPAL_TRACKING_ID_REQUIRED');
  await transaction(async session=>{const fresh=await countryAdminAccess(request,{session,country:row.country}),current=await record(fresh,'payments',id,{session});if(Number(current.__v||0)!==parsed.version)throw new AppError('This payment changed.',409,'ADMIN_COMMERCE_VERSION_CONFLICT');await fenceCountryAdminAccess(fresh,session);await writeAudit(request,'admin.payment_verification_requested',{actor:fresh.actor,targetType:'payment',targetPublicId:id,country:row.country,metadata:{version:parsed.version},session});});
  await verifyAndApplyPayment(row.publicId,row.providerTrackingId,{request:adminRequest(request),country:row.country});
  const fresh=await countryAdminAccess(request,{country:''});return paymentDto(await record(fresh,'payments',id));
}
export async function requestCountryAdminRefund(request,body={}) {
  const parsed=z.object({orderId:identifier,returnPublicId:identifier,returnVersion:version,version,reason:z.string().trim().min(3).max(300),idempotencyKey:z.string().trim().min(12).max(120),amountMinor:z.coerce.number().int().positive().max(2_000_000_000).optional()}).parse(body);
  const context=await countryAdminAccess(request,{country:''}),returned=await record(context,'returns',parsed.returnPublicId);independentReturn(returned,context.actor);
  if(returned.orderPublicId!==parsed.orderId)throw new AppError('The refund order does not match the inspected return.',409,'RETURN_REFUND_BINDING_CONFLICT');
  if(Object.keys(body).some(key=>key.startsWith('line:'))||body.allocations)throw new AppError('Return refunds use the immutable inspected line allocations.',422,'RETURN_REFUND_ALLOCATION_MISMATCH');
  const result=await createRefund(adminRequest(request),parsed),fresh=await countryAdminAccess(request,{country:''});return refundDto(await record(fresh,'refunds',result.publicId),fresh.actor);
}
async function pendingRefund(request,id,{session=null}={}) {
  const context=await countryAdminAccess(request,{session,country:''}),row=await record(context,'refunds',id,{session});
  if(!row.returnPublicId||!row.returnRequestId)throw new AppError('An inspected return binding is required for this refund.',409,'RETURN_REFUND_BINDING_REQUIRED');
  const returned=await record(context,'returns',row.returnPublicId,{session});
  if(!same(returned._id,row.returnRequestId)||returned.refundPublicId!==row.publicId||!same(returned.orderId,row.orderId))throw new AppError('Refund evidence needs a matching inspected return.',409,'RETURN_REFUND_BINDING_CONFLICT');
  if(same(row.requestedByUserId,context.actor._id))throw new AppError('A different operator must confirm refund disbursement.',403,'FOUR_EYES_REQUIRED');
  independentReturn(returned,context.actor);
  return {context,row,returned};
}
export async function uploadCountryAdminRefundEvidence(request,id,body,file) {
  const parsed=z.object({version,description:z.string().trim().min(10).max(300)}).parse(body),initial=await pendingRefund(request,id);
  if(initial.row.status!=='processing'||Number(initial.row.__v||0)!==parsed.version)throw new AppError('Reload the pending refund before saving evidence.',409,'ADMIN_COMMERCE_VERSION_CONFLICT');
  const evidence=await sanitizeAndStoreEvidenceImage({file,user:initial.context.actor,country:initial.row.order.country,contextType:'return',contextPublicId:initial.returned.publicId,refundPublicId:initial.row.publicId,documentType:'refund_disbursement',description:parsed.description});
  try{return await transaction(async session=>{const {context,row,returned}=await pendingRefund(request,id,{session});if(row.status!=='processing'||Number(row.__v||0)!==parsed.version)throw new AppError('The pending refund changed.',409,'ADMIN_COMMERCE_VERSION_CONFLICT');await fenceCountryAdminAccess(context,session);
    const attached=await ReturnRequest.updateOne({_id:returned._id,__v:returned.__v,status:'refund_processing',refundPublicId:row.publicId},{$addToSet:{evidenceDocumentIds:evidence._id},$inc:{__v:1}},{session});if(attached.modifiedCount!==1)throw new AppError('The refund return changed.',409,'RETURN_REFUND_VERSION_CONFLICT');
    await writeAudit(request,'admin.refund_evidence_added',{actor:context.actor,targetType:'refund',targetPublicId:row.publicId,country:row.order.country,metadata:{evidencePublicId:evidence.publicId,returnPublicId:returned.publicId},session});return {publicId:row.publicId,evidencePublicId:evidence.publicId,version:row.__v};
  });}catch(error){await EvidenceDocument.updateOne({_id:evidence._id},{$set:{status:'rejected'}});throw error;}
}
export async function completeCountryAdminRefund(request,id,body={}) {
  const parsed=z.object({version,reference:z.string().trim().min(4).max(180),evidencePublicId:identifier}).parse(body),{context,row,returned}=await pendingRefund(request,id);
  const evidence=await EvidenceDocument.exists({_id:mongoose.trusted({$in:returned.evidenceDocumentIds}),publicId:parsed.evidencePublicId,ownerUserId:context.actor._id,country:row.order.country,contextType:'return',contextPublicId:returned.publicId,refundPublicId:row.publicId,documentType:'refund_disbursement',status:'ready'});
  if(!evidence)throw new AppError('Attach your ready refund disbursement evidence to this inspected return.',422,'REFUND_EVIDENCE_REQUIRED');
  const completed=await completeManualRefund(adminRequest(request,{requiredRefundEvidencePublicId:parsed.evidencePublicId}),identifier.parse(id),{version:parsed.version,reference:parsed.reference});
  const fresh=await countryAdminAccess(request,{country:''});return refundDto(await record(fresh,'refunds',completed.publicId),fresh.actor);
}
export async function replayCountryAdminProviderEvent(request,id,body={}) {
  const parsed=z.object({version,reason:z.string().trim().min(5).max(300)}).parse(body),context=await countryAdminAccess(request,{country:''}),row=await record(context,'events',id);
  if(Number(row.__v||0)!==parsed.version)throw new AppError('This provider event changed.',409,'ADMIN_COMMERCE_VERSION_CONFLICT');
  await requeueProviderEvent(adminRequest(request),identifier.parse(id),parsed);const fresh=await countryAdminAccess(request,{country:''});return eventDto(await record(fresh,'events',id));
}
export async function reconcileCountryAdminPayments(request,body={}) {
  const parsed=z.object({country:z.string().regex(/^[A-Z]{2}$/),hours:z.coerce.number().int().min(1).max(168)}).parse(body);await countryAdminAccess(request,{country:parsed.country});
  const run=await reconcilePayments(adminRequest(request),parsed);return {publicId:run.publicId,country:run.country,currency:run.currency,status:run.status,checked:run.checked,matched:run.matched,updated:run.updated,failed:run.failed,startedAt:run.startedAt,completedAt:run.completedAt};
}
async function commerceEvidenceSource(request,id,{session=null,expectedStorageKey}={}) {
  const context=await countryAdminAccess(request,{session}),evidence=await EvidenceDocument.findOne(and(context.countryScope,{publicId:identifier.parse(id),status:'ready',contextType:mongoose.trusted({$in:['return','seller_return']})})).select('+storageKey').session(session).lean();
  if(!evidence)throw new AppError('Accepted commerce evidence not found.',404,'EVIDENCE_NOT_FOUND');
  if(expectedStorageKey!==undefined&&evidence.storageKey!==expectedStorageKey)throw new AppError('Evidence storage changed. Reload before opening it.',403,'EVIDENCE_SOURCE_CHANGED');
  let returned,seller=null;
  if(evidence.contextType==='return')returned=await record(context,'returns',evidence.contextPublicId,{session});
  else{seller=await SellerReturnCase.findOne(and(context.countryScope,{publicId:evidence.contextPublicId,evidenceDocumentIds:evidence._id,country:evidence.country})).session(session).lean();if(!seller)throw new AppError('Accepted seller evidence not found.',404,'EVIDENCE_NOT_FOUND');returned=await record(context,'returns',seller.returnPublicId,{session});if(!same(seller.returnRequestId,returned._id)||seller.orderPublicId!==returned.orderPublicId||seller.country!==returned.country)throw new AppError('Seller evidence source changed.',403,'EVIDENCE_SOURCE_CHANGED');}
  if(evidence.country!==returned.country)throw new AppError('Evidence no longer matches its original return country.',403,'EVIDENCE_SOURCE_CHANGED');
  if(evidence.contextType==='return'&&!(returned.evidenceDocumentIds||[]).some(value=>same(value,evidence._id)))throw new AppError('Evidence is no longer attached to this return.',404,'EVIDENCE_NOT_FOUND');
  assertReturnLines(returned);return {context,evidence,returned,seller};
}
export async function countryAdminCommerceEvidenceRecord(request,id,{audit=true,expectedStorageKey}={}) {
  if(!audit){const source=await commerceEvidenceSource(request,id,{expectedStorageKey});await assertCountryAdminReadAccess(request,source.context);return source.evidence;}
  return transaction(async session=>{
    const {context,evidence,returned,seller}=await commerceEvidenceSource(request,id,{session,expectedStorageKey});
    await fenceCountryAdminAccess(context,session);
    // Separate read revisions serialize source changes without invalidating open forms.
    const sourceFilter={_id:returned._id,publicId:returned.publicId,country:evidence.country,orderId:returned.order._id,orderPublicId:returned.order.publicId,userId:returned.order.userId,__v:returned.__v||0,...(!seller?{evidenceDocumentIds:evidence._id}:{})};
    const returnFence=await ReturnRequest.updateOne(sourceFilter,{$inc:{countryAdminEvidenceReadRevision:1}},{session,timestamps:false});
    const orderFence=await Order.updateOne({_id:returned.order._id,publicId:returned.orderPublicId,country:returned.country,userId:returned.userId,'totals.currency':returned.order.totals.currency,__v:returned.order.__v||0},{$inc:{moderationEvidenceReadRevision:1}},{session,timestamps:false});
    const evidenceFence=await EvidenceDocument.updateOne({_id:evidence._id,publicId:evidence.publicId,status:'ready',country:returned.country,contextType:evidence.contextType,contextPublicId:evidence.contextPublicId,ownerUserId:evidence.ownerUserId,storageKey:evidence.storageKey,__v:evidence.__v||0},{$inc:{moderationEvidenceReadRevision:1}},{session,timestamps:false});
    if(returnFence.modifiedCount!==1||orderFence.modifiedCount!==1||evidenceFence.modifiedCount!==1)throw new AppError('The attached evidence source changed. Reload before opening it.',409,'EVIDENCE_SOURCE_CHANGED');
    if(seller){const sellerFence=await SellerReturnCase.updateOne({_id:seller._id,publicId:seller.publicId,country:returned.country,returnRequestId:returned._id,returnPublicId:returned.publicId,orderPublicId:returned.orderPublicId,evidenceDocumentIds:evidence._id,__v:seller.__v||0},{$inc:{countryAdminEvidenceReadRevision:1}},{session,timestamps:false});if(sellerFence.modifiedCount!==1)throw new AppError('The seller evidence source changed. Reload before opening it.',409,'EVIDENCE_SOURCE_CHANGED');}
    await writeAudit(request,'admin.commerce_evidence_opened',{actor:context.actor,targetType:'evidence',targetPublicId:evidence.publicId,country:returned.country,metadata:{returnPublicId:returned.publicId},session});
    return evidence;
  });
}

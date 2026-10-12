import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { PaymentIntent, Refund, Order } from '../models/index.js';
import { financeAccess, assertFinanceExportAccess } from './finance-workspace-access.js';
import { cursorScope, cursorSort, pageResult, decodeCursor } from './pagination.js';
import { formatMinorUnits } from './catalogue.js';
import { createRefund, completeManualRefund, verifyAndApplyPayment } from './payments.js';
import { writeAudit } from './audit.js';

const PAYMENT_STATUSES = ['created','requires_action','pending','succeeded','failed','cancelled','pending_collection','refunded','partially_refunded','reversed'];
const REFUND_STATUSES = ['pending','processing','completed','failed','cancelled'];
const paymentFields = 'publicId orderId orderPublicId country amountMinor currency provider method status createdAt paidAt lastVerifiedAt refundReservedMinor refundedMinor __v providerTrackingId';
const refundFields = 'publicId orderId paymentIntentId amountMinor currency provider status reason createdAt completedAt requestedByUserId completedByUserId manualReference allocations __v providerStatus';
const label = value => String(value || '').replaceAll('_',' ');
const escaped = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const checked = value => { const number=Number(value||0); if(!Number.isSafeInteger(number))throw new AppError('Finance amount is outside the supported integer range.',409,'FINANCE_AMOUNT_INVALID'); return number; };
const and = (...values) => ({ $and: values.filter(value => value && Object.keys(value).length) });
function input(query, pageId) {
  const raw=z.object({country:z.string().trim().max(2).optional(),search:z.string().trim().max(100).default(''),q:z.string().trim().max(100).optional(),status:z.string().max(40).default('all'),after:z.string().max(512).default(''),record:z.string().trim().max(100).default(''),order:z.string().trim().max(100).default('')}).parse(query||{});
  const statuses=pageId==='finance-payments'?PAYMENT_STATUSES:REFUND_STATUSES;
  if(raw.status!=='all'&&!statuses.includes(raw.status))throw new AppError('Select a supported payment or refund status.',422,'FINANCE_FILTER_INVALID');
  if(raw.after&&!decodeCursor(raw.after))throw new AppError('The page cursor is invalid.',422,'FINANCE_CURSOR_INVALID');
  return {...raw,search:raw.q??raw.search};
}
export function financePaymentDto(row) {
  return { publicId:row.publicId,orderPublicId:row.orderPublicId,country:row.country,amountMinor:row.amountMinor,currency:row.currency,provider:row.provider,method:row.method,status:row.status,
    createdAt:row.createdAt,paidAt:row.paidAt||null,lastVerifiedAt:row.lastVerifiedAt||null,refundReservedMinor:Number(row.refundReservedMinor||0),refundedMinor:Number(row.refundedMinor||0),
    remainingRefundMinor:Math.max(0,checked(row.amountMinor)-checked(row.refundReservedMinor)-checked(row.refundedMinor)),version:Number(row.__v||0),canVerify:row.provider==='pesapal'&&Boolean(row.providerTrackingId) };
}
function refundDto(row,order,actor) {
  return {publicId:row.publicId,orderPublicId:order.publicId,country:order.country,amountMinor:row.amountMinor,currency:row.currency,provider:row.provider,status:row.status,reason:row.reason,
    createdAt:row.createdAt,completedAt:row.completedAt||null,version:Number(row.__v||0),manualReference:row.manualReference||'',
    canComplete:row.status==='processing'&&['cod_manual','external_manual','pesapal'].includes(row.provider)&&String(row.requestedByUserId)!==String(actor._id)};
}
async function scopedPayment(context,id,{session=null}={}) {
  const row=await PaymentIntent.findOne(and(context.countryScope,{publicId:id})).select(paymentFields).session(session).lean();
  if(!row)throw new AppError('Payment record not found.',404,'PAYMENT_NOT_FOUND');
  const order=await Order.findOne(and(context.countryScope,{_id:row.orderId,publicId:row.orderPublicId,'totals.currency':row.currency,country:row.country})).session(session).lean();
  if(!order)throw new AppError('Payment order does not match the scoped record.',409,'PAYMENT_ORDER_MISMATCH');
  return {row,order};
}
async function refundPipeline(context,filters={},cursor='') {
  const scope={};if(filters.status&&filters.status!=='all')scope.status=filters.status;
  if(filters.search)scope.publicId=new RegExp(escaped(filters.search),'i');
  const base=[{$match:scope},{$lookup:{from:Order.collection.name,localField:'orderId',foreignField:'_id',as:'scopedOrder'}},{$unwind:'$scopedOrder'},{$match:{$and:[Object.fromEntries(Object.entries(context.countryScope).map(([key,value])=>['scopedOrder.'+key,value])),{$expr:{$eq:['$currency','$scopedOrder.totals.currency']}}]}}];
  if(cursor)base.push({$match:cursorScope({},cursor)});
  return base;
}
function paymentPipeline(context,filters={},cursor='') {
  const scope=and(context.countryScope,filters.status&&filters.status!=='all'?{status:filters.status}:{},filters.search?{$or:[{publicId:new RegExp(escaped(filters.search),'i')},{orderPublicId:new RegExp(escaped(filters.search),'i')}]}:{});
  const pipeline=[{$match:scope},{$lookup:{from:Order.collection.name,localField:'orderId',foreignField:'_id',as:'scopedOrder'}},{$unwind:'$scopedOrder'},{$match:{$expr:{$and:[{$eq:['$orderPublicId','$scopedOrder.publicId']},{$eq:['$country','$scopedOrder.country']},{$eq:['$currency','$scopedOrder.totals.currency']}]}}}];
  if(cursor)pipeline.push({$match:cursorScope({},cursor)});
  return pipeline;
}
async function groupedPaymentSummary(context) {
  return PaymentIntent.aggregate([...paymentPipeline(context),{$group:{_id:{currency:'$currency',status:'$status'},count:{$sum:1},amountMinor:{$sum:'$amountMinor'}}}]);
}
async function groupedRefundSummary(context,filters) {
  return Refund.aggregate([...(await refundPipeline(context,filters)),{$group:{_id:{currency:'$currency',status:'$status'},count:{$sum:1},amountMinor:{$sum:'$amountMinor'}}}]);
}
const totalsLabel = (rows,statuses,locale) => {
  const totals=new Map();for(const row of rows)if(statuses.includes(row._id.status))totals.set(row._id.currency,checked((totals.get(row._id.currency)||0)+checked(row.amountMinor)));
  return totals.size?[...totals].sort(([a],[b])=>a.localeCompare(b)).map(([currency,amount])=>new Intl.NumberFormat(locale||'en',{style:'currency',currency,currencyDisplay:'code',maximumFractionDigits:['UGX','RWF'].includes(currency)?0:2}).format(amount/(['UGX','RWF'].includes(currency)?1:100))).join(' · '):'—';
};
function queryHref(base,query,changes={}) { const params=new URLSearchParams({...query,...changes});for(const [key,value]of [...params])if(!value)params.delete(key);return base+(params.size?'?'+params:''); }

export async function loadFinancePaymentPage(request,pageId) {
  if(!['finance-payments','finance-refunds'].includes(pageId))throw new AppError('Finance page not found.',404,'FINANCE_PAGE_NOT_FOUND');
  const filters=input(request.query,pageId),context=await financeAccess(request,{country:filters.country});
  const paymentPage=pageId==='finance-payments',base=paymentPage?'/finance/payments':'/finance/refunds',locale=context.actor.locale||'en';
  const money=row=>formatMinorUnits(checked(row.amountMinor),row.currency,locale);
  const date=value=>value?new Intl.DateTimeFormat(locale,{timeZone:context.market?.timeZone||'UTC',dateStyle:'medium'}).format(new Date(value)):'—';
  let rows,total,summary;
  if(paymentPage){
    const result=await Promise.all([PaymentIntent.aggregate([...paymentPipeline(context,filters,filters.after),{$sort:cursorSort()},{$limit:26},{$project:Object.fromEntries(paymentFields.split(' ').filter(key=>key!=='orderId').map(key=>[key,1]))}]),PaymentIntent.aggregate([...paymentPipeline(context,filters),{$count:'count'}]),groupedPaymentSummary(context)]);
    rows=result[0];total=Number(result[1][0]?.count||0);summary=result[2];
  }else{
    const pipeline=await refundPipeline(context,filters),cursorPipeline=await refundPipeline(context,filters,filters.after);
    const result=await Promise.all([Refund.aggregate([...cursorPipeline,{$sort:cursorSort()},{$limit:26},{$project:{publicId:1,orderId:1,paymentIntentId:1,amountMinor:1,currency:1,provider:1,status:1,reason:1,createdAt:1,completedAt:1,requestedByUserId:1,completedByUserId:1,manualReference:1,__v:1,'scopedOrder.publicId':1,'scopedOrder.country':1}}]),Refund.aggregate([...pipeline,{$count:'count'}]),groupedRefundSummary(context,{})]);
    [rows,summary]=[result[0],result[2]];total=Number(result[1][0]?.count||0);
  }
  const paged=pageResult(rows,{limit:25,total}),items=paged.items.map(row=>paymentPage?financePaymentDto(row):refundDto(row,row.scopedOrder,context.actor));
  let selected=null,refundOrder=null;
  if(filters.record){
    if(paymentPage){const {row}=await scopedPayment(context,filters.record);selected=financePaymentDto(row);}
    else{
      const found=await Refund.aggregate([...(await refundPipeline(context,{})),{$match:{publicId:filters.record}},{$limit:1}]);
      if(!found.length)throw new AppError('Refund record not found.',404,'REFUND_NOT_FOUND');selected=refundDto(found[0],found[0].scopedOrder,context.actor);
    }
  }
  if(!paymentPage&&filters.order){
    const order=await Order.findOne(and(context.countryScope,{publicId:filters.order})).select('publicId country totals paymentState cancellationState items.linePublicId items.storePublicId items.productPublicId items.title items.lineTotalMinor').lean();
    if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');
    const intent=await PaymentIntent.findOne({orderId:order._id,orderPublicId:order.publicId,country:order.country,currency:order.totals.currency,status:{$in:['succeeded','partially_refunded','refunded']}}).select(paymentFields).sort({paidAt:-1,_id:-1}).lean();
    if(!intent)throw new AppError('Verified payment record not found.',409,'REFUND_PAYMENT_MISSING');
    refundOrder={publicId:order.publicId,country:order.country,currency:order.totals.currency,payment:financePaymentDto(intent),items:(order.items||[]).map(row=>({orderLineId:row.linePublicId,storePublicId:row.storePublicId,productPublicId:row.productPublicId,title:row.title,lineTotalMinor:row.lineTotalMinor}))};
  }
  const count=statuses=>summary.filter(row=>statuses.includes(row._id.status)).reduce((sum,row)=>sum+Number(row.count),0);
  const statuses=paymentPage?PAYMENT_STATUSES:REFUND_STATUSES;
  const filteredQuery={country:context.country,search:filters.search,status:filters.status};
  await assertFinanceExportAccess(request,context);
  return {kind:'payments',pageId,country:context.country,countries:context.countries.map(row=>({code:row.code,name:row.name,currency:row.currency})),market:context.market,currency:context.market?.currency||null,timeZone:context.market?.timeZone||'UTC',items,selected,refundOrder,idempotencyKey:crypto.randomUUID(),
    metrics:paymentPage?[{label:'Captured value',value:totalsLabel(summary,['succeeded','partially_refunded','refunded'],locale),detail:'Recorded captured intents, separated by currency'},
      {label:'Successful payments',value:String(count(['succeeded','partially_refunded','refunded'])),detail:'Captured payment records'},
      {label:'Awaiting payment',value:String(count(['created','requires_action','pending','pending_collection'])),detail:'Open intents and COD collections'},
      {label:'Failed payments',value:String(count(['failed'])),detail:'Provider or verification failures'}]
      :[{label:'Refund queue',value:String(count(['pending','processing'])),detail:'Reserved refunds awaiting a confirmed outcome'},
        {label:'Completed refunds',value:totalsLabel(summary,['completed'],locale),detail:'Posted refunds, separated by currency'},
        {label:'Reserved amount',value:totalsLabel(summary,['pending','processing'],locale),detail:'Pending and processing refund reservations'},
        {label:'Failed refunds',value:String(count(['failed'])),detail:'Failed refund records'}],
    columns:paymentPage?['Payment','Order','Amount','Currency','Status']:['Refund','Order','Amount','Currency','Status'],
    rows:items.map(row=>({id:row.publicId,cells:[row.publicId,row.orderPublicId,money(row),row.currency,label(row.status)],href:queryHref(base,filteredQuery,{record:row.publicId})})),
    filters:{search:filters.search,status:filters.status,after:filters.after,country:context.country,statuses:[{value:'all',label:'All statuses'},...statuses.map(value=>({value,label:label(value)}))]},
    pagination:{...paged.page,nextHref:paged.page.hasMore?queryHref(base,filteredQuery,{after:paged.page.next}):''},page:paged.page,
    exportHref:queryHref(base+'/export.csv',filteredQuery),create:paymentPage?null:{label:'Record refund',href:'#finance-refund-request'},
    insights:[{text:paymentPage?'Payment confirmation is verified with the provider. Dashboard actions do not infer payment success.':'Refund completion reverses the recorded settlement and requires a different operator for manual disbursement.',href:paymentPage?'/finance/reconciliation':'/finance/payments',label:paymentPage?'Review reconciliation':'Find payment'}],
    workflow:paymentPage?[{title:'Verify a payment',text:'Open a Pesapal payment to fetch its current verified provider outcome.',href:base,label:'Review payments'}]:[{title:'Record a refund',text:'Find the original payment, enter a reason and allocate partial amounts to order lines.',href:'/finance/payments',label:'Find payment'}]};
}

const version=z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export async function verifyFinancePayment(request,id,body={}) {
  const parsed=z.object({version}).parse(body),context=await financeAccess(request,{country:''});
  const {row}=await scopedPayment(context,id);
  if(Number(row.__v||0)!==parsed.version)throw new AppError('This payment changed. Reload its latest record.',409,'FINANCE_VERSION_CONFLICT');
  if(row.provider!=='pesapal'||!row.providerTrackingId)throw new AppError('Only a linked Pesapal payment can be verified here.',409,'PESAPAL_TRACKING_ID_REQUIRED');
  // Authorize and audit the provider action before publishing any provider request.
  const session=await mongoose.startSession();
  try{await session.withTransaction(async()=>{const authorized=await financeAccess(request,{session,write:true,country:row.country});const current=await scopedPayment(authorized,id,{session});if(Number(current.row.__v||0)!==parsed.version)throw new AppError('This payment changed.',409,'FINANCE_VERSION_CONFLICT');await writeAudit(request,'finance.payment_verification_requested',{actor:authorized.actor,targetType:'payment',targetPublicId:row.publicId,country:row.country,metadata:{version:parsed.version},session});});}finally{await session.endSession();}
  await verifyAndApplyPayment(row.publicId,row.providerTrackingId,{request,country:row.country});
  const fresh=await financeAccess(request,{country:row.country});return financePaymentDto((await scopedPayment(fresh,id)).row);
}
function refundInput(body) {
  const parsed=z.object({orderId:z.string().trim().min(4).max(100),reason:z.string().trim().min(3).max(300),idempotencyKey:z.string().trim().min(12).max(120),version,
    amountMinor:z.union([z.literal(''),z.coerce.number().int().positive().max(2_000_000_000)]).optional(),allocations:z.array(z.object({storePublicId:z.string().trim().min(4).max(100),productPublicId:z.string().trim().max(100).optional(),orderLineId:z.string().trim().min(4).max(100),grossMinor:z.coerce.number().int().positive().max(2_000_000_000)})).max(100).optional()}).parse(body);
  return {...parsed,amountMinor:parsed.amountMinor===''?undefined:parsed.amountMinor};
}
export async function requestFinanceRefund(request,body={}) {
  const context=await financeAccess(request,{country:''}),input=refundInput(body);
  if(!input.allocations){
    const lines=Object.entries(body).filter(([key,value])=>key.startsWith('line:')&&String(value).trim()&&String(value)!=='0');
    if(lines.length){const order=await Order.findOne(and(context.countryScope,{publicId:input.orderId})).select('items').lean();if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');input.allocations=lines.map(([key,value])=>{const line=order.items.find(row=>row.linePublicId===key.slice(5));if(!line)throw new AppError('Unknown order line.',422,'REFUND_ALLOCATION_INVALID');return{storePublicId:line.storePublicId,productPublicId:line.productPublicId,orderLineId:line.linePublicId,grossMinor:z.coerce.number().int().positive().max(2_000_000_000).parse(value)};});}
  }
  const refund=await createRefund(request,input),order=await Order.findById(refund.orderId).select('publicId country').lean();return refundDto(refund,order,context.actor);
}
export async function completeFinanceRefund(request,id,body={}) {
  const context=await financeAccess(request,{country:''}),parsed=z.object({version,reference:z.string().trim().min(4).max(180)}).parse(body);
  const refund=await completeManualRefund(request,id,parsed),order=await Order.findById(refund.orderId).select('publicId country').lean();return refundDto(refund,order,context.actor);
}
export function financeCsvCell(value) {let text=String(value??'');if(/^[\s\u0000-\u001f]*[=+@-]/u.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';}
async function csvWrite(response,cells) {if(response.destroyed)return false;if(response.write(cells.map(financeCsvCell).join(',')+'\r\n'))return true;return new Promise(resolve=>{const drained=()=>{cleanup();resolve(true);},closed=()=>{cleanup();resolve(false);},cleanup=()=>{response.off('drain',drained);response.off('close',closed);};response.once('drain',drained);response.once('close',closed);});}
export async function streamFinancePaymentCsv(request,response,pageId) {
  const filters=input(request.query,pageId),context=await financeAccess(request,{country:filters.country}),payment=pageId==='finance-payments';
  // Audit failure aborts the export before any private CSV bytes are sent.
  const session=await mongoose.startSession();try{await session.withTransaction(async()=>{const fresh=await financeAccess(request,{session,write:true,country:context.country});await writeAudit(request,'finance.'+(payment?'payments':'refunds')+'_exported',{actor:fresh.actor,targetType:'finance_export',country:context.country||undefined,metadata:{status:filters.status},session});});}finally{await session.endSession();}
  await assertFinanceExportAccess(request,context);
  response.type('text/csv; charset=utf-8').set('Content-Disposition','attachment; filename="finance-'+(payment?'payments':'refunds')+'.csv"');
  if(!await csvWrite(response,['Record','Order','Country','Amount minor','Currency','Status','Provider','Recorded at']))return;
  const cursor=payment?PaymentIntent.aggregate([...paymentPipeline(context,filters),{$sort:cursorSort()},{$project:{publicId:1,orderPublicId:1,country:1,amountMinor:1,currency:1,status:1,provider:1,createdAt:1}}]).cursor({batchSize:100}):Refund.aggregate([...(await refundPipeline(context,filters)),{$sort:cursorSort()},{$project:{publicId:1,amountMinor:1,currency:1,status:1,provider:1,createdAt:1,'scopedOrder.publicId':1,'scopedOrder.country':1}}]).cursor({batchSize:100});
  try{for await(const row of cursor){await assertFinanceExportAccess(request,context);if(!await csvWrite(response,[row.publicId,payment?row.orderPublicId:row.scopedOrder.publicId,payment?row.country:row.scopedOrder.country,checked(row.amountMinor),row.currency,row.status,row.provider,row.createdAt?.toISOString()||'']))break;}}finally{await cursor.close();}if(!response.destroyed)response.end();
}

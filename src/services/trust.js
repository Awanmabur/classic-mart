import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { currentTraceFields } from '../core/trace.js';
import { decryptSensitive, encryptSensitive } from '../core/sensitive.js';
import {
  Dispute, EvidenceDocument, InventoryMovement, InventoryReservation, Order, Parcel, Product, ProductVariant, Refund, ReturnRequest, Review, RiskSignal,
  SatisfactionSurvey, SellerOrder, SellerReturnCase, Shipment, StockItem, Store, StoreMember, SupportKnowledge, SupportTicket, TrustCase, Warehouse, WarehouseTask, Notification,
} from '../models/index.js';
import { createWarehouseTask, ensureShipmentForOrder, hashProofCode } from './logistics.js';
import { operationalCountryScope } from './authorization.js';
import { refreshOrderLifecycle } from './order-state.js';
import { proportionalSettlementSlice } from './money.js';
import { createCustomerSupportTicket, createGuestSupportTicket } from './support-ticket-pages.js';
import { supportAccess, fenceSupportAccess } from './support-workspace-access.js';
import { writeAudit } from './audit.js';
import { z } from 'zod';
import { hasPermission } from '../core/roles.js';
import { moderationReviewAccess, fenceModerationReviewAccess } from './moderation-review-access.js';
import { createOwnedDispute, submitOwnedSatisfaction, authorizeCustomerCaseActor, fenceCustomerCaseMarket } from './customer-dispute-pages.js';
import { queueSupportAlert } from './support-notifications.js';

const ACTIVE_RETURN = ['requested','approved','awaiting_return','received','inspected','refund_pending','refund_processing','exchange_pending'];
export async function createPublicSupportTicket(request,input){
  return createGuestSupportTicket(request,input);
}
export function supportRequester(ticket){
  if(!ticket)return {name:'',email:''};
  let email='';try{if(ticket.requesterEmailEncrypted)email=decryptSensitive(ticket.requesterEmailEncrypted);}catch{}
  return {name:ticket.requesterName||'',email:email||ticket.requesterEmailMasked||''};
}
export function supportScope(user){ return operationalCountryScope(user,'country'); }

export async function createReturnRequest(request,input){
  if(!Array.isArray(input.items)||input.items.length<1||input.items.length>20||new Set(input.items.map(item=>item.orderLineId)).size!==input.items.length)throw new AppError('Choose between one and twenty distinct original order lines.',422,'RETURN_ITEMS_INVALID');
  const session=await mongoose.startSession();let result;
  try{await session.withTransaction(async()=>{
    const actor=await authorizeCustomerCaseActor(request,session);
    const order=await Order.findOne({publicId:input.orderId,userId:actor._id}).session(session);
    if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');
    await fenceCustomerCaseMarket(order.country,session,order.totals.currency);
    if(order.fulfillmentState!=='delivered')throw new AppError('This order is not eligible for a goods return until delivery is verified.',409,'RETURN_ORDER_STATE');
    const shipment=await Shipment.findOne({orderId:order._id,kind:'outbound',status:'delivered'}).sort({deliveredAt:-1}).session(session);
    if(!shipment?.deliveredAt||order.fulfillmentState!=='delivered')throw new AppError('Goods returns can only be opened after verified delivery. Use a delivery dispute if the order was not received.',409,'RETURN_DELIVERY_REQUIRED');
    const windowDays=Number(order.policySnapshot?.returnWindowDays??30),eligibleUntil=new Date(shipment.deliveredAt.getTime()+windowDays*86400000);
    if(eligibleUntil<new Date())throw new AppError('The return window has closed.',409,'RETURN_WINDOW_CLOSED');
    const sellerOrders=await SellerOrder.find({orderId:order._id}).session(session).lean(),sellerByStore=new Map(sellerOrders.map(row=>[row.storePublicId,row]));
    const priorRefunds=await Refund.find({orderId:order._id,status:{$in:['pending','processing','completed']},'allocations.0':{$exists:true}}).select('allocations').session(session).lean();
    const priorRefundGrossByLine=new Map();for(const refund of priorRefunds){for(const allocation of refund.allocations||[]){const key=`${allocation.storePublicId}:${allocation.orderLineId}`;priorRefundGrossByLine.set(key,(priorRefundGrossByLine.get(key)||0)+Number(allocation.grossMinor||0));}}
    const requested=[];let total=0;
    for(const raw of input.items){
      const item=order.items.find(x=>String(x.linePublicId)===String(raw.orderLineId));
      if(!item)throw new AppError('An order line is not part of this order.',422,'RETURN_ITEM_INVALID');
      const active=await ReturnRequest.exists({orderId:order._id,userId:request.user._id,status:{$in:ACTIVE_RETURN},'items.orderLineId':item.linePublicId}).session(session);
      if(active)throw new AppError('This delivered order line already has an active return.',409,'RETURN_ALREADY_OPEN');
      const delivered=Math.min(Number(item.quantity||0),Number(item.deliveredQuantity||0));
      const available=Math.max(0,delivered-Number(item.returnReservedQuantity||0)-Number(item.returnedQuantity||0));
      if(!Number.isSafeInteger(raw.quantity)||raw.quantity<1||raw.quantity>available)throw new AppError('Return quantity exceeds the remaining delivered returnable quantity.',422,'RETURN_QUANTITY_INVALID');
      const sellerOrder=sellerByStore.get(item.storePublicId);
      const sellerLine=sellerOrder?.items?.find(row=>String(row.orderLineId||'')===String(item.linePublicId));
      if(!sellerLine||!Number.isSafeInteger(Number(sellerLine.customerPaidMinor))||Number(sellerLine.customerPaidMinor)<0)throw new AppError('The immutable settlement snapshot for this order line is missing. Run the production migration before processing returns.',409,'SELLER_SETTLEMENT_SNAPSHOT_MISSING');
      const consumedQuantity=Number(item.returnReservedQuantity||0)+Number(item.returnedQuantity||0);
      const amount=proportionalSettlementSlice(Number(sellerLine.customerPaidMinor),consumedQuantity,raw.quantity,Number(item.quantity));
      const settlementKey=`${item.storePublicId}:${item.linePublicId}`,priorRefundGross=Number(priorRefundGrossByLine.get(settlementKey)||0),paidBase=Number(sellerLine.customerPaidMinor||0);
      if(priorRefundGross+amount>paidBase)throw new AppError('Return financial impact exceeds the immutable paid amount for this order line.',409,'RETURN_SETTLEMENT_EXHAUSTED');
      const platformFeeReversalMinor=proportionalSettlementSlice(Number(sellerLine.platformFeeMinor),priorRefundGross,amount,paidBase),sellerReceivableReversalMinor=amount-platformFeeReversalMinor;
      total+=amount;item.returnReservedQuantity=Number(item.returnReservedQuantity||0)+raw.quantity;
      requested.push({orderLineId:item.linePublicId,productId:item.productId,variantId:item.variantId,storeId:item.storeId,storePublicId:item.storePublicId,productPublicId:item.productPublicId,variantPublicId:item.variantPublicId,sku:item.sku,title:item.title,variantTitle:item.variantTitle,quantity:raw.quantity,unitPriceMinor:item.unitPriceMinor,requestedRefundMinor:amount,sellerReceivableReversalMinor,platformFeeReversalMinor});
    }
    const [doc]=await ReturnRequest.create([{publicId:publicId('ret'),orderId:order._id,orderPublicId:order.publicId,userId:request.user._id,country:order.country,reason:input.reason,details:input.details,resolution:input.resolution,items:requested,returnMethod:input.returnMethod||'dropoff',dropoffPointPublicId:input.dropoffPointId||'',eligibleUntil,policyVersion:order.policySnapshot?.policyVersion||'2026-07',timeline:[{type:'return.requested',message:`Return requested for ${requested.length} exact order line(s).`,actorUserId:request.user._id}]}],{session});
    const caseByStore=new Map();for(const item of requested){const key=String(item.storeId||'');if(!key)continue;const row=caseByStore.get(key)||{storeId:item.storeId,storePublicId:item.storePublicId,items:[]};row.items.push({orderLineId:item.orderLineId,productPublicId:item.productPublicId,variantPublicId:item.variantPublicId,sku:item.sku,title:item.title,variantTitle:item.variantTitle,quantity:item.quantity,requestedRefundMinor:item.requestedRefundMinor,sellerReceivableReversalMinor:item.sellerReceivableReversalMinor,platformFeeReversalMinor:item.platformFeeReversalMinor});caseByStore.set(key,row);}if(caseByStore.size){await SellerReturnCase.create([...caseByStore.values()].map(row=>({publicId:publicId('src'),returnRequestId:doc._id,returnPublicId:doc.publicId,orderPublicId:order.publicId,storeId:row.storeId,storePublicId:row.storePublicId,country:order.country,status:'pending',slaDueAt:new Date(Date.now()+48*60*60*1000),items:row.items,timeline:[{type:'seller_return.opened',message:'Seller return case opened for the store-owned order lines.'}]})),{session});}
    order.timeline.push({type:'return.requested',message:`Return ${doc.publicId} reserved ${requested.reduce((sum,row)=>sum+row.quantity,0)} delivered unit(s).`});await order.save({session});await refreshOrderLifecycle(order._id,{session});
    if(input.reason==='counterfeit_suspected')await RiskSignal.create([{publicId:publicId('rsk'),country:order.country,subjectType:'order',subjectPublicId:order.publicId,type:'return_counterfeit_suspected',severity:'high',score:80,evidence:[doc.publicId],createdBy:'system'}],{session});
    await queueSupportAlert({country:order.country,kind:'priority',href:'/support/returns?record='+encodeURIComponent(doc.publicId)},session);
    await writeAudit(request,'customer.return_created',{actor,targetType:'return',targetPublicId:doc.publicId,country:order.country,session});
    result={returnRequest:doc,requestedRefundMinor:total,currency:order.totals.currency};
  });return result;}finally{await session.endSession();}
}

async function createReturnShipment(doc, actorUserId, session){
  const order=await Order.findById(doc.orderId).session(session);if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');
  const pickup=String(crypto.randomInt(100000,999999)),delivery=String(crypto.randomInt(100000,999999));
  const shipmentTrace={traceId:order.traceId||currentTraceFields().traceId,traceSpanId:order.traceSpanId||currentTraceFields().traceSpanId};const [shipment]=await Shipment.create([{publicId:publicId('shp'),...shipmentTrace,orderId:order._id,orderPublicId:order.publicId,kind:'return',returnRequestId:doc._id,country:doc.country,mode:'standard',pickupCodeHash:hashProofCode(pickup),deliveryCodeHash:hashProofCode(delivery),pickupCodeEncrypted:encryptSensitive(pickup),deliveryCodeEncrypted:encryptSensitive(delivery),cod:{required:false,amountMinor:0,currency:order.totals.currency,collectedMinor:0},timeline:[{type:'return_shipment_created',message:`Return pickup created for ${doc.publicId}.`,actorUserId}]}],{session});
  doc.returnShipmentPublicId=shipment.publicId;return shipment;
}

const returnVersion = z.union([z.number(), z.string().regex(/^\d+$/)]).pipe(z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
function currentReturnVersion(doc, raw) {
  // Existing service callers can perform the guarded state transition without a
  // page snapshot. Dashboard callers always supply a version.
  if (raw !== undefined && Number(doc.__v || 0) !== returnVersion.parse(raw)) throw new AppError('This return changed. Reload its latest record.', 409, 'SUPPORT_CASE_VERSION_CONFLICT');
}
async function scopedReturn(request, id, session) {
  const context = await supportAccess(request, { session, workspace: false, country: '' });
  const doc = await ReturnRequest.findOne(mongoose.trusted({ $and: [context.countryScope, { publicId: id }] })).session(session);
  if (!doc) throw new AppError('Return request not found.', 404, 'RETURN_NOT_FOUND');
  const order = await Order.findOne({ _id: doc.orderId, publicId: doc.orderPublicId, country: doc.country, userId: doc.userId }).session(session);
  if (!order) throw new AppError('The return does not match its original order.', 409, 'RETURN_ORDER_MISMATCH');
  if(context.countries.find(country=>country.code===doc.country)?.currency!==order.totals.currency)throw new AppError('The return currency does not match its operational market.',409,'RETURN_ORDER_MISMATCH');
  return { context, doc, order };
}
async function returnCustomerNotice(doc, title, body, session) {
  await Notification.create([{ publicId: publicId('ntf'), userId: doc.userId, country: doc.country, type: 'return_update', title,
    body: `${doc.publicId}: ${body}`.slice(0, 1500), href: '/returns' }], { session });
}
async function returnAudit(request, context, doc, action, session) {
  await writeAudit(request, action, { actor: context.actor, targetType: 'return', targetPublicId: doc.publicId, country: doc.country,
    metadata: { status: doc.status, version: doc.__v }, session });
}

export async function decideReturn(request,returnId,input){
  const { decision, note, version } = z.object({ decision: z.enum(['approve','reject']), note: z.string().trim().min(10).max(300), version: returnVersion.optional() }).parse(input);
  const session=await mongoose.startSession();let result;
  try{await session.withTransaction(async()=>{
    const { context, doc, order } = await scopedReturn(request, returnId, session); currentReturnVersion(doc,version);
    if (doc.status !== 'requested') throw new AppError('This return has already been decided.',409,'RETURN_STATE');
    const delivered = await Shipment.exists({ orderId: order._id, kind:'outbound', status:'delivered', deliveredAt: mongoose.trusted({ $type:'date' }), 'proof.reference':'verified' }).session(session);
    if (!delivered || !['delivered','partially_delivered'].includes(order.fulfillmentState)) throw new AppError('Verified original delivery is required before deciding a return.',409,'RETURN_DELIVERY_REQUIRED');
    for (const returned of doc.items) { const original=order.items.find(item=>item.linePublicId===returned.orderLineId); if (!original || Number(original.deliveredQuantity||0)<returned.quantity || Number(original.returnReservedQuantity||0)<returned.quantity || String(original.variantId)!==String(returned.variantId) || String(original.storeId)!==String(returned.storeId)) throw new AppError('The return no longer matches its delivered reserved order lines.',409,'RETURN_RESERVATION_CONFLICT'); }
    await fenceSupportAccess(context,session);
    if(decision==='approve'){
      doc.status='awaiting_return';doc.decidedByUserId=request.user._id;doc.decidedAt=new Date();doc.timeline.push({type:'return.awaiting_return',message:note||'Return approved and awaiting the goods.',actorUserId:request.user._id});
      if(doc.returnMethod==='pickup')await createReturnShipment(doc,request.user._id,session);
      await doc.save({session});await refreshOrderLifecycle(doc.orderId,{session});await returnCustomerNotice(doc,'Return approved',note,session);await returnAudit(request,context,doc,'support.return_approved',session);result=doc;return;
    }
    for(const returned of doc.items){const item=order.items.find(x=>String(x.linePublicId)===String(returned.orderLineId));if(!item)throw new AppError('Return order line is missing.',409,'RETURN_ORDER_LINE_MISSING');if(Number(item.returnReservedQuantity||0)<returned.quantity)throw new AppError('Return quantity reservation is inconsistent.',409,'RETURN_RESERVATION_CONFLICT');item.returnReservedQuantity-=returned.quantity;}
    doc.status='rejected';doc.decidedByUserId=request.user._id;doc.decidedAt=new Date();doc.timeline.push({type:'return.rejected',message:note||'Return rejected; reserved return quantities were released.',actorUserId:request.user._id});await order.save({session});await doc.save({session});await SellerReturnCase.updateMany({returnRequestId:doc._id,status:mongoose.trusted({$ne:'resolved'})},{$set:{status:'resolved'},$push:{timeline:{type:'seller_return.resolved',message:'Marketplace rejected the return request.',actorUserId:request.user._id}}},{session});await refreshOrderLifecycle(order._id,{session});await returnCustomerNotice(doc,'Return decision',note,session);await returnAudit(request,context,doc,'support.return_rejected',session);result=doc;
  });return result;}finally{await session.endSession();}
}

export async function markReturnReceived(request,returnId,raw=''){
  const input = typeof raw === 'string' ? { note: raw } : raw;
  const { note, version } = z.object({note:z.string().trim().max(300).default(''),version:returnVersion.optional()}).parse(input);
  const session=await mongoose.startSession();let received;
  try{await session.withTransaction(async()=>{
    const { context, doc, order } = await scopedReturn(request,returnId,session); currentReturnVersion(doc,version);
    if (!['approved','awaiting_return'].includes(doc.status)) throw new AppError('Return is not awaiting receipt.',409,'RETURN_STATE');
    if(doc.returnMethod==='pickup'){const shipment=await Shipment.findOne({publicId:doc.returnShipmentPublicId,returnRequestId:doc._id,kind:'return',country:doc.country,orderId:doc.orderId}).session(session);if(!shipment||shipment.status!=='delivered'||!shipment.deliveredAt||shipment.proof?.reference!=='verified')throw new AppError('The return pickup has not reached the receiving point with verified delivery proof yet.',409,'RETURN_SHIPMENT_NOT_DELIVERED');}
    else if (doc.items.some(item=>!item.intakeReceivedAt||!item.intakeEvidencePublicId||!item.intakeWarehousePublicId)) throw new AppError('Every drop-off line requires a scoped warehouse intake and saved receipt evidence.',409,'RETURN_INTAKE_REQUIRED');
    await fenceSupportAccess(context,session);
    for(const returned of doc.items){
      const item=order.items.find(x=>String(x.linePublicId)===String(returned.orderLineId));if(!item)throw new AppError('Return order line is missing.',409,'RETURN_ORDER_LINE_MISSING');if(Number(item.returnReservedQuantity||0)<returned.quantity)throw new AppError('Return quantity reservation is inconsistent.',409,'RETURN_RESERVATION_CONFLICT');
      const warehouseRows=await Warehouse.find({storeId:returned.storeId,country:doc.country,active:true,...(doc.returnMethod==='dropoff'?{publicId:returned.intakeWarehousePublicId}:{})}).sort({createdAt:1}).session(session);if(!warehouseRows.length)throw new AppError(`An active warehouse is required before receiving return line ${returned.sku||returned.orderLineId}.`,409,'RETURN_WAREHOUSE_REQUIRED');
      if (doc.returnMethod==='dropoff' && !await EvidenceDocument.exists({publicId:returned.intakeEvidencePublicId,ownerUserId:returned.intakeReceivedByUserId,country:doc.country,contextType:'return',contextPublicId:doc.publicId,contextLinePublicId:returned.orderLineId,documentType:'return_receipt',status:'ready'}).session(session)) throw new AppError('Warehouse intake receipt evidence is unavailable.',409,'RETURN_INTAKE_REQUIRED');
      const warehouseIds=warehouseRows.map(row=>row._id);let stock=await StockItem.findOne({storeId:returned.storeId,variantId:returned.variantId,warehouseId:mongoose.trusted({$in:warehouseIds})}).sort({createdAt:1}).session(session);if(!stock){const [created]=await StockItem.create([{publicId:publicId('stk'),storeId:returned.storeId,warehouseId:warehouseRows[0]._id,variantId:returned.variantId,onHand:0,reserved:0,damaged:0,quarantined:0,reorderPoint:0}],{session});stock=created;}
      const task=await createWarehouseTask({sourceKey:`return-inspection:${doc.publicId}:${returned.orderLineId}`,warehouseId:stock.warehouseId,storeId:returned.storeId,orderId:order._id,returnRequestId:doc._id,returnOrderLineId:returned.orderLineId,stockItemId:stock._id,variantId:returned.variantId,type:'return_inspection',reference:doc.publicId,notes:`Inspect received return ${doc.publicId} · ${returned.sku||returned.title}`,quantity:returned.quantity},session);
      returned.warehouseTaskPublicId=task.publicId;returned.warehouseInspectionStatus='pending';item.returnReservedQuantity-=returned.quantity;item.returnedQuantity=Number(item.returnedQuantity||0)+returned.quantity;if(item.returnedQuantity>item.deliveredQuantity)throw new AppError('Returned quantity exceeds delivered quantity.',409,'RETURN_QUANTITY_CONFLICT');
    }
    doc.status='received';doc.timeline.push({type:'return.received',message:note||'Returned goods received; authoritative warehouse inspection tasks were created for every returned order line.',actorUserId:request.user._id});await order.save({session});await doc.save({session});await refreshOrderLifecycle(order._id,{session});await returnCustomerNotice(doc,'Returned goods received','Received goods are awaiting authoritative warehouse inspection.',session);await returnAudit(request,context,doc,'support.return_received',session);received=doc;
  });return received;}finally{await session.endSession();}
}

export async function inspectReturn(request,returnId,input){
  const parsed=z.object({condition:z.enum(['unopened','good','damaged','wrong_item','counterfeit_suspected','missing_parts']),notes:z.string().trim().min(10).max(1000),version:returnVersion.optional()}).parse(input);
  const session=await mongoose.startSession();let result;
  try{await session.withTransaction(async()=>{
    const {context,doc}=await scopedReturn(request,returnId,session);currentReturnVersion(doc,parsed.version);
    if(doc.status!=='received')throw new AppError('Return must be received before inspection.',409,'RETURN_STATE');
    for(const item of doc.items){
      const task=await WarehouseTask.findOne({publicId:item.warehouseTaskPublicId,type:'return_inspection',status:'completed',returnRequestId:doc._id,returnOrderLineId:item.orderLineId,storeId:item.storeId,variantId:item.variantId,quantity:item.quantity}).session(session);
      const warehouse=task?await Warehouse.exists({_id:task.warehouseId,country:doc.country,storeId:item.storeId}).session(session):null;
      if(!warehouse||item.warehouseInspectionStatus!=='completed'||Number(item.inspectedQuantity)!==Number(item.quantity)||!item.warehouseInspectedAt||!item.warehouseInspectedByUserId||!['good','damaged','quarantine'].includes(item.stockDisposition)||task.result?.disposition!==item.stockDisposition)throw new AppError('Warehouse inspection and stock disposition must be completed for every exact returned order line first.',409,'RETURN_WAREHOUSE_INSPECTION_REQUIRED');
    }
    if(['unopened','good'].includes(parsed.condition)&&doc.items.some(item=>item.stockDisposition!=='good'))throw new AppError('The final condition conflicts with recorded warehouse disposition.',422,'RETURN_INSPECTION_CONFLICT');
    if(parsed.condition==='counterfeit_suspected'&&doc.items.some(item=>item.stockDisposition!=='quarantine'))throw new AppError('Suspected counterfeit goods must be quarantined by the warehouse.',422,'RETURN_INSPECTION_CONFLICT');
    await fenceSupportAccess(context,session);
    doc.inspection={condition:parsed.condition,notes:parsed.notes,inspectedByUserId:context.actor._id,inspectedAt:new Date()};doc.status=doc.resolution==='refund'?'refund_pending':'exchange_pending';doc.timeline.push({type:'return.inspected',message:`Inspection recorded: ${parsed.condition}.`,actorUserId:context.actor._id});await doc.save({session});await refreshOrderLifecycle(doc.orderId,{session});
    if(parsed.condition==='counterfeit_suspected')await RiskSignal.create([{publicId:publicId('rsk'),country:doc.country,subjectType:'order',subjectPublicId:doc.orderPublicId,type:'inspection_counterfeit_suspected',severity:'critical',score:95,evidence:[doc.publicId],createdBy:'operator'}],{session});
    await returnCustomerNotice(doc,'Return inspection completed',doc.resolution==='refund'?'The inspected return is ready for Finance review. Payment has not been confirmed.':'The inspected return is ready for an exchange stock check.',session);await returnAudit(request,context,doc,'support.return_inspected',session);result=doc;
  });return result;}finally{await session.endSession();}
}

export async function createExchangeReplacement(request,returnId,input={}){
  const parsed=z.object({version:returnVersion.optional()}).parse(input);
  const session=await mongoose.startSession();let replacement;
  try{await session.withTransaction(async()=>{
    replacement=null;
    const { context, doc } = await scopedReturn(request,returnId,session);
    if(doc.replacementOrderPublicId){
      replacement=await Order.findOne({publicId:doc.replacementOrderPublicId,country:doc.country,paymentMethod:'exchange'}).session(session);
      if(!replacement)throw new AppError('The recorded exchange replacement is unavailable.',409,'EXCHANGE_REPLACEMENT_MISSING');
      return;
    }
    currentReturnVersion(doc,parsed.version);
    if(doc.status!=='exchange_pending'||doc.resolution!=='exchange')throw new AppError('Return is not ready for exchange.',409,'RETURN_STATE');
    if(!doc.inspection?.inspectedAt||doc.items.some(item=>item.warehouseInspectionStatus!=='completed'))throw new AppError('Complete authoritative receipt and inspection before exchanging goods.',409,'RETURN_WAREHOUSE_INSPECTION_REQUIRED');
    await fenceSupportAccess(context,session);
    const original=await Order.findOne({_id:doc.orderId,country:doc.country,userId:doc.userId}).session(session);
    if(!original)throw new AppError('Original order not found.',404,'ORDER_NOT_FOUND');
    // Claim the return before touching stock so concurrent attempts retry against
    // the committed replacement instead of creating another order or deduction.
    doc.markModified('status');doc.increment();await doc.save({session});
    const items=[],expiresAt=new Date(Date.now()+365*24*60*60*1000);
    for(const [index,returned] of doc.items.entries()){
      const originalItem=original.items.find(item=>String(item.linePublicId)===String(returned.orderLineId));
      if(!originalItem||!Number.isSafeInteger(returned.quantity)||returned.quantity<1||returned.quantity>originalItem.quantity||
        String(originalItem.variantId)!==String(returned.variantId)||String(originalItem.productId)!==String(returned.productId)||
        (returned.storeId&&String(originalItem.storeId)!==String(returned.storeId))){
        throw new AppError('Replacement order line is unavailable.',409,'EXCHANGE_VARIANT_UNAVAILABLE');
      }
      const variant=await ProductVariant.findOne({_id:returned.variantId,productId:originalItem.productId,
        storeId:originalItem.storeId,active:true,currency:original.totals.currency}).session(session);
      const store=await Store.findOne({_id:originalItem.storeId,publicId:originalItem.storePublicId,
        status:'verified',country:original.country,currency:original.totals.currency}).session(session);
      if(!variant||!store)throw new AppError('Replacement variant or store is unavailable.',409,'EXCHANGE_VARIANT_UNAVAILABLE');
      await Store.updateOne({_id:store._id,status:'verified',country:store.country,currency:store.currency},{$inc:{__v:1}},{session});
      const warehouses=await Warehouse.find({storeId:store._id,country:original.country,active:true}).select('_id').session(session).lean();
      const stock=await StockItem.findOneAndUpdate(mongoose.trusted({variantId:variant._id,storeId:store._id,
        warehouseId:{$in:warehouses.map(warehouse=>warehouse._id)},
        $expr:{$gte:[{$subtract:['$onHand',{$add:['$reserved','$damaged','$quarantined']}]},returned.quantity]}}),
        {$inc:{onHand:-returned.quantity,__v:1}},{returnDocument:'before',session,sort:{createdAt:1,_id:1}});
      if(!stock)throw new AppError(`Replacement stock is unavailable for ${returned.title}.`,409,'EXCHANGE_STOCK_UNAVAILABLE');
      const warehouse=await Warehouse.findOne({_id:stock.warehouseId,storeId:store._id,country:original.country,active:true}).session(session);
      if(!warehouse)throw new AppError('Replacement warehouse is unavailable.',409,'EXCHANGE_STOCK_UNAVAILABLE');
      await Warehouse.updateOne({_id:warehouse._id,active:true,country:warehouse.country},{$inc:{__v:1}},{session});
      // These units are committed immediately. Recording the exact stock item
      // makes later seller picking traceable without deducting inventory again.
      const [reservation]=await InventoryReservation.create([{publicId:publicId('rsv'),
        idempotencyKey:`exchange:${doc.publicId}:${index}`,storeId:store._id,stockItemId:stock._id,variantId:variant._id,
        quantity:returned.quantity,status:'committed',committedAt:new Date(),expiresAt,actorUserId:request.user._id}],{session});
      await InventoryMovement.create([{publicId:publicId('mov'),storeId:stock.storeId,stockItemId:stock._id,
        variantId:stock.variantId,warehouseId:stock.warehouseId,type:'sale',quantity:-returned.quantity,
        onHandBefore:stock.onHand,onHandAfter:stock.onHand-returned.quantity,reservedBefore:stock.reserved,reservedAfter:stock.reserved,
        reason:`Exchange replacement for ${doc.publicId}`,reference:doc.publicId,actorUserId:request.user._id}],{session});
      items.push({...originalItem.toObject(),linePublicId:publicId('oli'),reservationPublicId:reservation.publicId,
        quantity:returned.quantity,deliveredQuantity:0,returnReservedQuantity:0,returnedQuantity:0,refundedQuantity:0,
        unitPriceMinor:0,lineTotalMinor:0,unitCostMinor:variant.costMinor,costSnapshotStatus:'captured'});
    }
    const [order]=await Order.create([{publicId:publicId('ord'),...currentTraceFields(),idempotencyKey:`exchange:${doc.publicId}`,checkoutId:`exchange:${doc.publicId}`,cartPublicId:`exchange:${doc.publicId}`,sessionKey:original.sessionKey,userId:original.userId,country:original.country,status:'confirmed',paymentState:'paid',fulfillmentState:'unfulfilled',cancellationState:'none',returnState:'none',refundState:'none',deliveryMethod:original.deliveryMethod,shippingZonePublicId:original.shippingZonePublicId,pickupPointPublicId:original.pickupPointPublicId,paymentMethod:'exchange',contact:original.contact,totals:{subtotalMinor:0,shippingMinor:0,discountMinor:0,taxMinor:0,totalMinor:0,currency:original.totals.currency},items,policySnapshot:original.policySnapshot,timeline:[{type:'exchange.created',message:`Replacement order for return ${doc.publicId}.`}],reservationExpiresAt:expiresAt}],{session});
    const groups=new Map();for(const item of items){const group=groups.get(item.storePublicId)||[];group.push(item);groups.set(item.storePublicId,group);}
    const sellerIds=[];
    for(const [storePublicId,group] of groups){
      const id=publicId('sord');sellerIds.push(id);
      await SellerOrder.create([{publicId:id,orderId:order._id,orderPublicId:order.publicId,storeId:group[0].storeId,
        storePublicId,country:order.country,status:'confirmed',subtotalMinor:0,platformFeeMinor:0,shippingMinor:0,taxMinor:0,
        discountMinor:0,currency:order.totals.currency,items:group.map(item=>({orderLineId:item.linePublicId,
          productPublicId:item.productPublicId,variantPublicId:item.variantPublicId,title:item.title,variantTitle:item.variantTitle,
          sku:item.sku,quantity:item.quantity,unitPriceMinor:0,lineTotalMinor:0,currency:item.currency,
          unitCostMinor:item.unitCostMinor,costSnapshotStatus:item.costSnapshotStatus,
          grossMinor:0,discountMinor:0,customerPaidMinor:0,platformFeeMinor:0,sellerReceivableMinor:0})),
        timeline:[{type:'exchange.created',message:`Exchange replacement for ${doc.publicId}.`}]}],{session});
    }
    order.sellerOrderPublicIds=sellerIds;await order.save({session});
    await ensureShipmentForOrder(order,request.user._id,session);
    doc.replacementOrderPublicId=order.publicId;doc.status='exchanged';doc.timeline.push({type:'return.exchanged',message:`Replacement order ${order.publicId} created and stock committed.`,actorUserId:request.user._id});await doc.save({session});
    await SellerReturnCase.updateMany({returnRequestId:doc._id,status:mongoose.trusted({$ne:'resolved'})},{$set:{status:'resolved'},$push:{timeline:{type:'seller_return.resolved',message:`Exchange completed with replacement order ${order.publicId}.`,actorUserId:request.user._id}}},{session});
    await refreshOrderLifecycle(original._id,{session});await returnCustomerNotice(doc,'Exchange replacement created',`Replacement order ${order.publicId} has reserved stock and is awaiting seller fulfilment.`,session);await returnAudit(request,context,doc,'support.return_exchanged',session);replacement=order;
  });}finally{await session.endSession();}
  return replacement;
}

export async function createDispute(request,input){return createOwnedDispute(request,input);}
export async function createTicket(request,input){return createCustomerSupportTicket(request,input);}
export async function createVerifiedReview(request,input){
  const orderQuery={userId:request.user._id,fulfillmentState:'delivered','items.productPublicId':input.productId};if(input.orderId)orderQuery.publicId=input.orderId;
  const order=await Order.findOne(orderQuery).sort({createdAt:-1});if(!order)throw new AppError('A delivered verified purchase is required to review this product.',403,'VERIFIED_PURCHASE_REQUIRED');
  const item=order.items.find(x=>x.productPublicId===input.productId&&Number(x.deliveredQuantity||0)>0);if(!item)throw new AppError('This product was not delivered in the selected order.',422,'REVIEW_PRODUCT_INVALID');
  const store=await Store.findOne({publicId:item.storePublicId}).lean();if(store&&(String(store.ownerUserId)===String(request.user._id)||await StoreMember.exists({storeId:store._id,userId:request.user._id,status:'active'})))throw new AppError('Store owners and staff cannot review products from a store they operate.',403,'SELF_REVIEW_BLOCKED');
  const product=await Product.findOne({publicId:item.productPublicId});if(!product)throw new AppError('Product not found.',404,'PRODUCT_NOT_FOUND');
  try{const review=await Review.create({publicId:publicId('rev'),userId:request.user._id,orderId:order._id,orderPublicId:order.publicId,productId:product._id,productPublicId:product.publicId,country:order.country,rating:input.rating,title:input.title||'',body:input.body,verifiedPurchase:true,status:'pending'});const recent=await Review.countDocuments({userId:request.user._id,createdAt:{$gte:new Date(Date.now()-86400000)}});if(recent>5)await RiskSignal.create({publicId:publicId('rsk'),country:order.country,subjectType:'user',subjectPublicId:String(request.user._id),type:'review_velocity',severity:'medium',score:55,evidence:[review.publicId],createdBy:'system'}).catch(()=>{});return review;}catch(error){if(error?.code===11000)throw new AppError('You already reviewed this product from this order.',409,'REVIEW_EXISTS');throw error;}
}

export async function disputeReview(request,reviewId,reason){const review=await Review.findOne({publicId:reviewId,status:'published'});if(!review)throw new AppError('Published review not found.',404,'REVIEW_NOT_FOUND');const product=await Product.findById(review.productId);const store=product?await Store.findById(product.storeId):null;const member=store?await StoreMember.findOne({storeId:store._id,userId:request.user._id,status:'active',role:{$in:['owner','admin','support']}}):null;if(!store||(!store.ownerUserId.equals(request.user._id)&&!member))throw new AppError('Only authorized staff from the affected store can dispute this review.',403,'FORBIDDEN');review.status='disputed';review.disputeReason=reason;review.disputedByUserId=request.user._id;review.disputedAt=new Date();await review.save();return review;}

export async function reportTrustIssue(request,input){const product=input.productId?await Product.findOne({publicId:input.productId}).lean():null;const store=input.storeId?await Store.findOne({publicId:input.storeId}).lean():null;if(input.productId&&!product)throw new AppError('Product not found.',404,'PRODUCT_NOT_FOUND');if(input.storeId&&!store)throw new AppError('Store not found.',404,'STORE_NOT_FOUND');const country=product?.countries?.[0]||store?.country||request.user.country;const trustCase=await TrustCase.create({publicId:publicId('case'),reporterUserId:request.user._id,country,type:input.type,productId:product?._id,productPublicId:product?.publicId,storeId:store?._id,storePublicId:store?.publicId,description:input.description});const severity=['counterfeit','unsafe_product','prohibited_product'].includes(input.type)?'high':'medium';await RiskSignal.create({publicId:publicId('rsk'),country,subjectType:product?'product':'store',subjectPublicId:product?.publicId||store?.publicId,type:`trust_${input.type}`,severity,score:severity==='high'?80:55,evidence:[trustCase.publicId],createdBy:'user'});return trustCase;}
export async function publishReview(request,reviewId,input){
  const values=z.object({decision:z.enum(['publish','reject']),reason:z.string().trim().min(3).max(500),version:z.coerce.number().int().nonnegative().optional()}).parse(input);
  const session=await mongoose.startSession();let result;
  try{await session.withTransaction(async()=>{
    const review=await Review.findOne({publicId:reviewId}).session(session);
    if(!review)throw new AppError('Review not found.',404,'REVIEW_NOT_FOUND');
    const access=await moderationReviewAccess(request,session,review.country);
    if(!['pending','disputed'].includes(review.status))throw new AppError('Review is already finalized.',409,'REVIEW_STATE');
    if(values.version!==undefined&&values.version!==(review.__v||0))throw new AppError('The review changed. Reload before deciding.',409,'MODERATION_VERSION_CONFLICT');
    const order=await Order.findOne({_id:review.orderId,publicId:review.orderPublicId,userId:review.userId,country:review.country}).select('publicId').session(session);
    if(!order)throw new AppError('Review purchase linkage needs investigation.',409,'REVIEW_LINKAGE_INVALID');
    await fenceModerationReviewAccess(access,session);
    review.status=values.decision==='publish'?'published':'rejected';review.moderationReason=values.reason;
    review.publishedAt=review.status==='published'?new Date():undefined;await review.save({session});
    await writeAudit(request,'review.moderated',{session,actor:access.actor,targetType:'review',targetPublicId:review.publicId,country:review.country,metadata:{decision:values.decision,reason:values.reason}});
    result=review;
  });return result;}finally{await session.endSession();}
}

export async function reviewTrustCase(request,caseDoc,input){
  const values=z.object({status:z.enum(['investigating','actioned','dismissed','closed']),enforcement:z.enum(['none','suspend_product','restore_product','suspend_store','restore_store']).default('none'),decision:z.string().trim().min(3).max(1000),version:z.coerce.number().int().nonnegative().optional()}).parse(input);
  if(values.status!=='actioned'&&values.enforcement!=='none')throw new AppError('Enforcement requires an actioned trust case.',422,'TRUST_ENFORCEMENT_STATE');
  const session=await mongoose.startSession();let result;
  try{await session.withTransaction(async()=>{
    const doc=await TrustCase.findOne({publicId:caseDoc?.publicId||caseDoc}).session(session);
    if(!doc)throw new AppError('Trust case not found.',404,'TRUST_CASE_NOT_FOUND');
    const access=await moderationReviewAccess(request,session,doc.country);
    const expected=values.version??caseDoc?.__v;
    if(expected!==undefined&&expected!==(doc.__v||0))throw new AppError('The trust case changed. Reload before deciding.',409,'MODERATION_VERSION_CONFLICT');
    if(!['open','investigating','appealed'].includes(doc.status))throw new AppError('This trust case has a recorded outcome.',409,'TRUST_CASE_STATE');
    const appealReview=doc.status==='appealed';
    if(appealReview&&String(doc.assignedUserId||'')===String(access.actor._id))throw new AppError('An appealed trust case requires a different reviewer.',409,'TRUST_APPEAL_FOUR_EYES');
    if(values.enforcement!=='none'&&!hasPermission(access.actor,'catalogue:moderate'))throw new AppError('Catalogue moderation permission is required for enforcement.',403,'CATALOGUE_MODERATION_REQUIRED');
    let product=null,store=null;
    if(values.enforcement!=='none'){
      if(doc.productPublicId)product=await Product.findOne({publicId:doc.productPublicId,_id:doc.productId,countries:doc.country}).session(session);
      if(values.enforcement.endsWith('_product')&&!product)throw new AppError('Product not found for scoped enforcement.',404,'PRODUCT_NOT_FOUND');
      if(product&&!access.scopes.includes('*')&&product.countries.some(country=>!access.scopes.includes(country)))throw new AppError('Global product enforcement requires authority over every selling country.',403,'TRUST_ENFORCEMENT_COUNTRY_FORBIDDEN');
      if(values.enforcement.endsWith('_store')){
        store=doc.storePublicId?await Store.findOne({publicId:doc.storePublicId,_id:doc.storeId,country:doc.country}).session(session):product?await Store.findOne({_id:product.storeId,country:doc.country}).session(session):null;
        if(!store)throw new AppError('Store not found for scoped enforcement.',404,'STORE_NOT_FOUND');
      }
    }
    await fenceModerationReviewAccess(access,session);
    if(values.enforcement==='suspend_product'){
      if(product.status==='closed')throw new AppError('Closed products cannot be suspended.',409,'PRODUCT_STATE');
      if(product.status!=='suspended'){product.suspension.previousStatus=product.status;product.suspension.reason=values.decision;product.suspension.suspendedAt=new Date();product.suspension.suspendedByUserId=access.actor._id;product.status='suspended';await product.save({session});}
    }else if(values.enforcement==='restore_product'){
      if(product.status!=='suspended'||!['draft','submitted','changes_requested','approved','published','rejected','archived'].includes(product.suspension?.previousStatus))throw new AppError('A verified previous product state is required for restoration.',409,'PRODUCT_RESTORE_STATE');
      product.status=product.suspension.previousStatus;product.suspension.reason='';product.suspension.suspendedAt=undefined;product.suspension.suspendedByUserId=undefined;await product.save({session});
    }else if(values.enforcement==='suspend_store'){
      if(store.status==='closed')throw new AppError('Closed stores cannot be suspended.',409,'STORE_STATE');
      if(store.status!=='suspended'){
        const previousStatus=store.status;store.status='suspended';store.suspendedAt=new Date();store.suspensionReason=values.decision;store.suspendedByUserId=access.actor._id;await store.save({session});
        await writeAudit(request,'trust.store_suspended',{session,actor:access.actor,targetType:'store',targetPublicId:store.publicId,country:store.country,metadata:{previousStatus}});
      }
    }else if(values.enforcement==='restore_store'){
      const {AuditLog}=await import('../models/index.js');
      const prior=await AuditLog.findOne({action:'trust.store_suspended',targetType:'store',targetPublicId:store.publicId,country:store.country}).select('metadata').sort({createdAt:-1,_id:-1}).session(session).lean();
      if(store.status!=='suspended'||!['pending_verification','verified'].includes(prior?.metadata?.previousStatus))throw new AppError('A verified previous store state is required for restoration.',409,'STORE_RESTORE_STATE');
      store.status=prior.metadata.previousStatus;store.suspendedAt=undefined;store.suspensionReason='';store.suspendedByUserId=undefined;await store.save({session});
    }
    doc.status=values.status;doc.decision=values.decision;doc.assignedUserId=access.actor._id;doc.resolvedAt=['actioned','dismissed','closed'].includes(values.status)?new Date():undefined;await doc.save({session});
    await writeAudit(request,'trust.case_reviewed',{session,actor:access.actor,targetType:'trust_case',targetPublicId:doc.publicId,country:doc.country,metadata:{status:values.status,enforcement:values.enforcement,appealReview}});
    result=doc;
  });return result;}finally{await session.endSession();}
}

export async function reviewRiskSignal(request,risk,input){
  const values=z.object({status:z.enum(['reviewed','dismissed','actioned']),decision:z.string().trim().min(3).max(1000),version:z.coerce.number().int().nonnegative().optional()}).parse(input);
  const session=await mongoose.startSession();let result;
  try{await session.withTransaction(async()=>{
    const doc=await RiskSignal.findOne({publicId:risk?.publicId||risk}).session(session);if(!doc)throw new AppError('Risk signal not found.',404,'RISK_NOT_FOUND');
    const access=await moderationReviewAccess(request,session,doc.country),expected=values.version??risk?.__v;
    if(expected!==undefined&&expected!==(doc.__v||0))throw new AppError('The risk signal changed. Reload before deciding.',409,'MODERATION_VERSION_CONFLICT');
    if(doc.status!=='open')throw new AppError('The risk signal already has a recorded outcome.',409,'RISK_STATE');
    await fenceModerationReviewAccess(access,session);
    doc.status=values.status;doc.decision=values.decision;doc.reviewedByUserId=access.actor._id;doc.reviewedAt=new Date();await doc.save({session});
    await writeAudit(request,'trust.risk_signal_reviewed',{session,actor:access.actor,targetType:'risk_signal',targetPublicId:doc.publicId,country:doc.country,metadata:{status:values.status}});
    result=doc;
  });return result;}finally{await session.endSession();}
}

export async function createKnowledgeArticle(request,input){const slug=input.slug.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');return SupportKnowledge.create({publicId:publicId('kb'),country:input.country||request.user.country,title:input.title,slug,body:input.body,category:input.category,status:input.status,createdByUserId:request.user._id,updatedByUserId:request.user._id,publishedAt:input.status==='published'?new Date():null});}
export async function submitSatisfaction(request,ticketPublicId,input){return submitOwnedSatisfaction(request,ticketPublicId,input);}
export async function attachEvidence(contextDoc,evidence){if(!contextDoc.evidenceDocumentIds)contextDoc.evidenceDocumentIds=[];if(!contextDoc.evidenceDocumentIds.some(id=>id.equals(evidence._id)))contextDoc.evidenceDocumentIds.push(evidence._id);await contextDoc.save();return contextDoc;}

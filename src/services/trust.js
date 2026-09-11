import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { currentTraceFields } from '../core/trace.js';
import { decryptSensitive, encryptSensitive } from '../core/sensitive.js';
import {
  Dispute, EvidenceDocument, InventoryMovement, Order, Parcel, Product, ProductVariant, Refund, ReturnRequest, Review, RiskSignal,
  SatisfactionSurvey, SellerOrder, SellerReturnCase, Shipment, StockItem, Store, StoreMember, SupportKnowledge, SupportTicket, TrustCase, Warehouse,
} from '../models/index.js';
import { createWarehouseTask, ensureShipmentForOrder, hashProofCode } from './logistics.js';
import { operationalCountryScope } from './authorization.js';
import { refreshOrderLifecycle } from './order-state.js';
import { proportionalSettlementSlice } from './money.js';

const ACTIVE_RETURN = ['requested','approved','awaiting_return','received','inspected','refund_pending','refund_processing','exchange_pending'];
const supportQueueByCategory=Object.freeze({order:'orders',payment:'payments',refund:'payments',delivery:'delivery',return:'returns',account:'accounts',seller:'seller',product:'seller',other:'general'});
function supportQueue(category){return supportQueueByCategory[String(category||'')]||'general';}

function maskEmail(email=''){
  const [local,domain]=String(email).trim().toLowerCase().split('@');
  if(!local||!domain)return '';
  return `${local.slice(0,2)}${'*'.repeat(Math.max(1,Math.min(6,local.length-2)))}@${domain}`;
}
export async function createPublicSupportTicket(request,input){
  let order=null;
  if(input.orderId){
    order=await Order.findOne({publicId:input.orderId,country:request.country.code}).select('_id publicId country contact').lean();
    if(!order)throw new AppError('Order number was not found in this country.',404,'ORDER_NOT_FOUND');
    const supplied=String(input.email||'').trim().toLowerCase();
    const orderEmail=String(order.contact?.email||'').trim().toLowerCase();
    if(!orderEmail||supplied!==orderEmail)throw new AppError('Order number and email do not match.',403,'ORDER_CONTACT_MISMATCH');
  }
  const hours=input.priority==='urgent'?4:input.priority==='high'?12:48;
  return SupportTicket.create({
    publicId:publicId('tkt'),userId:request.user?._id,orderId:order?._id,orderPublicId:order?.publicId,
    country:order?.country||request.country.code,category:input.category,subject:input.subject,priority:input.priority,queue:supportQueue(input.category),
    requesterName:String(input.name||request.user?.name||'').slice(0,120),requesterEmailMasked:maskEmail(input.email),
    requesterEmailEncrypted:encryptSensitive(String(input.email).trim().toLowerCase()),
    slaDueAt:new Date(Date.now()+hours*60*60*1000),notes:[{message:input.message,actorUserId:request.user?._id,internal:false}],workflowHistory:[{action:'created',actorUserId:request.user?._id,toStatus:'open',note:'Support ticket created.'}]
  });
}
export function supportRequester(ticket){
  if(!ticket)return {name:'',email:''};
  let email='';try{if(ticket.requesterEmailEncrypted)email=decryptSensitive(ticket.requesterEmailEncrypted);}catch{}
  return {name:ticket.requesterName||'',email:email||ticket.requesterEmailMasked||''};
}
export function supportScope(user){ return operationalCountryScope(user,'country'); }

export async function createReturnRequest(request,input){
  const session=await mongoose.startSession();let result;
  try{await session.withTransaction(async()=>{
    const order=await Order.findOne({publicId:input.orderId,userId:request.user._id}).session(session);
    if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');
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
    result={returnRequest:doc,requestedRefundMinor:total,currency:order.totals.currency};
  });return result;}finally{await session.endSession();}
}

async function createReturnShipment(doc, actorUserId, session){
  const order=await Order.findById(doc.orderId).session(session);if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');
  const pickup=String(crypto.randomInt(100000,999999)),delivery=String(crypto.randomInt(100000,999999));
  const shipmentTrace={traceId:order.traceId||currentTraceFields().traceId,traceSpanId:order.traceSpanId||currentTraceFields().traceSpanId};const [shipment]=await Shipment.create([{publicId:publicId('shp'),...shipmentTrace,orderId:order._id,orderPublicId:order.publicId,kind:'return',returnRequestId:doc._id,country:doc.country,mode:'standard',pickupCodeHash:hashProofCode(pickup),deliveryCodeHash:hashProofCode(delivery),pickupCodeEncrypted:encryptSensitive(pickup),deliveryCodeEncrypted:encryptSensitive(delivery),cod:{required:false,amountMinor:0,currency:order.totals.currency,collectedMinor:0},timeline:[{type:'return_shipment_created',message:`Return pickup created for ${doc.publicId}.`,actorUserId}]}],{session});
  doc.returnShipmentPublicId=shipment.publicId;return shipment;
}

export async function decideReturn(request,returnId,{decision,note=''}){
  const session=await mongoose.startSession();let result;
  try{await session.withTransaction(async()=>{
    const doc=await ReturnRequest.findOne({publicId:returnId,...supportScope(request.user),status:'requested'}).session(session);if(!doc)throw new AppError('Pending return request not found.',404,'RETURN_NOT_FOUND');
    if(decision==='approve'){
      doc.status='awaiting_return';doc.decidedByUserId=request.user._id;doc.decidedAt=new Date();doc.timeline.push({type:'return.awaiting_return',message:note||'Return approved and awaiting the goods.',actorUserId:request.user._id});
      if(doc.returnMethod==='pickup')await createReturnShipment(doc,request.user._id,session);
      await doc.save({session});await refreshOrderLifecycle(doc.orderId,{session});result=doc;return;
    }
    const order=await Order.findById(doc.orderId).session(session);if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');
    for(const returned of doc.items){const item=order.items.find(x=>String(x.linePublicId)===String(returned.orderLineId));if(!item)throw new AppError('Return order line is missing.',409,'RETURN_ORDER_LINE_MISSING');if(Number(item.returnReservedQuantity||0)<returned.quantity)throw new AppError('Return quantity reservation is inconsistent.',409,'RETURN_RESERVATION_CONFLICT');item.returnReservedQuantity-=returned.quantity;}
    doc.status='rejected';doc.decidedByUserId=request.user._id;doc.decidedAt=new Date();doc.timeline.push({type:'return.rejected',message:note||'Return rejected; reserved return quantities were released.',actorUserId:request.user._id});await order.save({session});await doc.save({session});await SellerReturnCase.updateMany({returnRequestId:doc._id,status:{$ne:'resolved'}},{$set:{status:'resolved'},$push:{timeline:{type:'seller_return.resolved',message:'Marketplace rejected the return request.',actorUserId:request.user._id}}},{session});await refreshOrderLifecycle(order._id,{session});result=doc;
  });return result;}finally{await session.endSession();}
}

export async function markReturnReceived(request,returnId,note=''){
  const session=await mongoose.startSession();let received;
  try{await session.withTransaction(async()=>{
    const doc=await ReturnRequest.findOne({publicId:returnId,...supportScope(request.user),status:{$in:['approved','awaiting_return']}}).session(session);if(!doc)throw new AppError('Return is not awaiting receipt.',409,'RETURN_STATE');
    if(doc.returnMethod==='pickup'){const shipment=await Shipment.findOne({returnRequestId:doc._id,kind:'return'}).session(session);if(!shipment||shipment.status!=='delivered')throw new AppError('The return pickup has not reached the receiving point yet.',409,'RETURN_SHIPMENT_NOT_DELIVERED');}
    const order=await Order.findById(doc.orderId).session(session);if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');
    for(const returned of doc.items){
      const item=order.items.find(x=>String(x.linePublicId)===String(returned.orderLineId));if(!item)throw new AppError('Return order line is missing.',409,'RETURN_ORDER_LINE_MISSING');if(Number(item.returnReservedQuantity||0)<returned.quantity)throw new AppError('Return quantity reservation is inconsistent.',409,'RETURN_RESERVATION_CONFLICT');
      const warehouseRows=await Warehouse.find({storeId:returned.storeId,active:true}).sort({createdAt:1}).session(session);if(!warehouseRows.length)throw new AppError(`An active warehouse is required before receiving return line ${returned.sku||returned.orderLineId}.`,409,'RETURN_WAREHOUSE_REQUIRED');
      const warehouseIds=warehouseRows.map(row=>row._id);let stock=await StockItem.findOne({storeId:returned.storeId,variantId:returned.variantId,warehouseId:{$in:warehouseIds}}).sort({createdAt:1}).session(session);if(!stock){const [created]=await StockItem.create([{publicId:publicId('stk'),storeId:returned.storeId,warehouseId:warehouseRows[0]._id,variantId:returned.variantId,onHand:0,reserved:0,damaged:0,quarantined:0,reorderPoint:0}],{session});stock=created;}
      const task=await createWarehouseTask({sourceKey:`return-inspection:${doc.publicId}:${returned.orderLineId}`,warehouseId:stock.warehouseId,storeId:returned.storeId,orderId:order._id,returnRequestId:doc._id,returnOrderLineId:returned.orderLineId,stockItemId:stock._id,variantId:returned.variantId,type:'return_inspection',reference:doc.publicId,notes:`Inspect received return ${doc.publicId} · ${returned.sku||returned.title}`,quantity:returned.quantity},session);
      returned.warehouseTaskPublicId=task.publicId;returned.warehouseInspectionStatus='pending';item.returnReservedQuantity-=returned.quantity;item.returnedQuantity=Number(item.returnedQuantity||0)+returned.quantity;if(item.returnedQuantity>item.deliveredQuantity)throw new AppError('Returned quantity exceeds delivered quantity.',409,'RETURN_QUANTITY_CONFLICT');
    }
    doc.status='received';doc.timeline.push({type:'return.received',message:note||'Returned goods received; authoritative warehouse inspection tasks were created for every returned order line.',actorUserId:request.user._id});await order.save({session});await doc.save({session});await refreshOrderLifecycle(order._id,{session});received=doc;
  });return received;}finally{await session.endSession();}
}

export async function inspectReturn(request,returnId,input){
  const doc=await ReturnRequest.findOne({publicId:returnId,...supportScope(request.user)}); if(!doc) throw new AppError('Return request not found.',404,'RETURN_NOT_FOUND');
  if(doc.status!=='received') throw new AppError('Return must be received before inspection.',409,'RETURN_STATE');
  const warehouseTasksRequired=doc.items.some(item=>Boolean(item.warehouseTaskPublicId));if(warehouseTasksRequired&&doc.items.some(item=>item.warehouseInspectionStatus!=='completed'))throw new AppError('Warehouse inspection and stock disposition must be completed for every returned order line first.',409,'RETURN_WAREHOUSE_INSPECTION_REQUIRED');
  doc.inspection={condition:input.condition,notes:input.notes||'',inspectedByUserId:request.user._id,inspectedAt:new Date()}; doc.status=doc.resolution==='refund'?'refund_pending':'exchange_pending'; doc.timeline.push({type:'return.inspected',message:`Inspection recorded: ${input.condition}.`,actorUserId:request.user._id}); await doc.save(); await refreshOrderLifecycle(doc.orderId);
  if(input.condition==='counterfeit_suspected') await RiskSignal.create({publicId:publicId('rsk'),country:doc.country,subjectType:'order',subjectPublicId:doc.orderPublicId,type:'inspection_counterfeit_suspected',severity:'critical',score:95,evidence:[doc.publicId],createdBy:'operator'});
  return doc;
}

export async function createExchangeReplacement(request,returnId){
  const doc=await ReturnRequest.findOne({publicId:returnId,...supportScope(request.user)});if(!doc)throw new AppError('Return not found.',404,'RETURN_NOT_FOUND');if(doc.status!=='exchange_pending')throw new AppError('Return is not ready for exchange.',409,'RETURN_STATE');if(doc.replacementOrderPublicId)return Order.findOne({publicId:doc.replacementOrderPublicId});
  const original=await Order.findById(doc.orderId);if(!original)throw new AppError('Original order not found.',404,'ORDER_NOT_FOUND');
  const session=await mongoose.startSession();let replacement;
  try{await session.withTransaction(async()=>{
    const items=[];
    for(const returned of doc.items){const originalItem=original.items.find(i=>String(i.linePublicId)===String(returned.orderLineId));const variant=await ProductVariant.findById(returned.variantId).session(session);if(!originalItem||!variant)throw new AppError('Replacement variant is unavailable.',409,'EXCHANGE_VARIANT_UNAVAILABLE');const stock=await StockItem.findOneAndUpdate(mongoose.trusted({variantId:variant._id,storeId:originalItem.storeId,$expr:{$gte:[{$subtract:['$onHand',{$add:['$reserved','$damaged','$quarantined']}]},returned.quantity]}}),{$inc:{onHand:-returned.quantity}},{returnDocument:'before',session});if(!stock)throw new AppError(`Replacement stock is unavailable for ${returned.title}.`,409,'EXCHANGE_STOCK_UNAVAILABLE');await InventoryMovement.create([{publicId:publicId('mov'),storeId:stock.storeId,stockItemId:stock._id,variantId:stock.variantId,warehouseId:stock.warehouseId,type:'sale',quantity:-returned.quantity,onHandBefore:stock.onHand,onHandAfter:stock.onHand-returned.quantity,reservedBefore:stock.reserved,reservedAfter:stock.reserved,reason:`Exchange replacement for ${doc.publicId}`,reference:doc.publicId,actorUserId:request.user._id}],{session});items.push({...originalItem.toObject?.()||originalItem,reservationPublicId:`exchange:${doc.publicId}`,quantity:returned.quantity,unitPriceMinor:0,lineTotalMinor:0});}
    const [order]=await Order.create([{publicId:publicId('ord'),...currentTraceFields(),idempotencyKey:`exchange:${doc.publicId}`,checkoutId:`exchange:${doc.publicId}`,cartPublicId:`exchange:${doc.publicId}`,sessionKey:original.sessionKey,userId:original.userId,country:original.country,status:'confirmed',paymentState:'paid',fulfillmentState:'unfulfilled',cancellationState:'none',returnState:'none',refundState:'none',deliveryMethod:original.deliveryMethod,shippingZonePublicId:original.shippingZonePublicId,pickupPointPublicId:original.pickupPointPublicId,paymentMethod:'exchange',contact:original.contact,totals:{subtotalMinor:0,shippingMinor:0,discountMinor:0,taxMinor:0,totalMinor:0,currency:original.totals.currency},items,policySnapshot:original.policySnapshot,timeline:[{type:'exchange.created',message:`Replacement order for return ${doc.publicId}.`,actorUserId:request.user._id}],reservationExpiresAt:new Date(Date.now()+365*24*60*60*1000)}],{session});
    const groups=new Map();for(const item of items){const arr=groups.get(item.storePublicId)||[];arr.push(item);groups.set(item.storePublicId,arr);}const sellerIds=[];for(const [storePublicId,group] of groups){const id=publicId('sord');sellerIds.push(id);await SellerOrder.create([{publicId:id,orderId:order._id,orderPublicId:order.publicId,storeId:group[0].storeId,storePublicId,country:order.country,status:'confirmed',subtotalMinor:0,shippingMinor:0,taxMinor:0,discountMinor:0,currency:order.totals.currency,items:group.map(i=>({productPublicId:i.productPublicId,variantPublicId:i.variantPublicId,title:i.title,sku:i.sku,quantity:i.quantity,unitPriceMinor:0,lineTotalMinor:0,currency:i.currency})),timeline:[{type:'exchange.created',message:`Exchange replacement for ${doc.publicId}.`}]}],{session});}order.sellerOrderPublicIds=sellerIds;await order.save({session});doc.replacementOrderPublicId=order.publicId;doc.status='exchanged';doc.timeline.push({type:'return.exchanged',message:`Replacement order ${order.publicId} created and stock committed.`,actorUserId:request.user._id});await doc.save({session});await SellerReturnCase.updateMany({returnRequestId:doc._id,status:{$ne:'resolved'}},{$set:{status:'resolved'},$push:{timeline:{type:'seller_return.resolved',message:`Exchange completed with replacement order ${order.publicId}.`,actorUserId:request.user._id}}},{session});await refreshOrderLifecycle(original._id,{session});replacement=order;
  });}finally{await session.endSession();}
  await ensureShipmentForOrder(replacement,request.user._id);return replacement;
}

export async function createDispute(request,input){const order=await Order.findOne({publicId:input.orderId,userId:request.user._id});if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');const existing=await Dispute.exists({orderId:order._id,userId:request.user._id,status:{$nin:['resolved','rejected','closed']},category:input.category});if(existing)throw new AppError('A similar dispute is already open for this order.',409,'DISPUTE_ALREADY_OPEN');return Dispute.create({publicId:publicId('dsp'),userId:request.user._id,orderId:order._id,orderPublicId:order.publicId,country:order.country,category:input.category,subject:input.subject,description:input.description,priority:['counterfeit','payment'].includes(input.category)?'high':'normal',events:[{type:'dispute.opened',message:input.description,actorUserId:request.user._id}]});}
export async function createTicket(request,input){let order=null;if(input.orderId){order=await Order.findOne({publicId:input.orderId,userId:request.user._id});if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');}const duplicate=await SupportTicket.findOne({userId:request.user._id,orderPublicId:order?.publicId||{$in:[null,'']},category:input.category,status:{$in:['open','in_progress','waiting_customer','escalated']},createdAt:{$gte:new Date(Date.now()-15*60*1000)}}).lean();if(duplicate)throw new AppError(`A similar active support ticket (${duplicate.publicId}) was created recently.`,409,'SUPPORT_DUPLICATE');const hours=input.priority==='urgent'?4:input.priority==='high'?12:48;return SupportTicket.create({publicId:publicId('tkt'),userId:request.user._id,orderId:order?._id,orderPublicId:order?.publicId,country:order?.country||request.user.country,category:input.category,subject:input.subject,priority:input.priority,queue:supportQueue(input.category),slaDueAt:new Date(Date.now()+hours*60*60*1000),notes:[{message:input.message,actorUserId:request.user._id,internal:false}],workflowHistory:[{action:'created',actorUserId:request.user._id,toStatus:'open',note:'Support ticket created.'}]});}
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
export async function publishReview(request,reviewId,{decision,reason=''}){const review=await Review.findOne({publicId:reviewId,...supportScope(request.user)});if(!review)throw new AppError('Review not found.',404,'REVIEW_NOT_FOUND');if(!['pending','disputed'].includes(review.status))throw new AppError('Review is already finalized.',409,'REVIEW_STATE');review.status=decision==='publish'?'published':'rejected';review.moderationReason=reason;if(review.status==='published')review.publishedAt=new Date();await review.save();return review;}

export async function createKnowledgeArticle(request,input){const slug=input.slug.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');return SupportKnowledge.create({publicId:publicId('kb'),country:input.country||request.user.country,title:input.title,slug,body:input.body,category:input.category,status:input.status,createdByUserId:request.user._id,updatedByUserId:request.user._id,publishedAt:input.status==='published'?new Date():null});}
export async function submitSatisfaction(request,ticketPublicId,input){const ticket=await SupportTicket.findOne({publicId:ticketPublicId,userId:request.user._id,status:{$in:['resolved','closed']}});if(!ticket)throw new AppError('Resolved support ticket not found.',404,'TICKET_NOT_FOUND');return SatisfactionSurvey.findOneAndUpdate({ticketId:ticket._id,userId:request.user._id},{$set:{rating:input.rating,comment:input.comment,country:ticket.country},$setOnInsert:{publicId:publicId('sat'),ticketPublicId:ticket.publicId}},{upsert:true,returnDocument:'after'});}
export async function attachEvidence(contextDoc,evidence){if(!contextDoc.evidenceDocumentIds)contextDoc.evidenceDocumentIds=[];if(!contextDoc.evidenceDocumentIds.some(id=>id.equals(evidence._id)))contextDoc.evidenceDocumentIds.push(evidence._id);await contextDoc.save();return contextDoc;}

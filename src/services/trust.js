import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { decryptSensitive, encryptSensitive } from '../core/sensitive.js';
import {
  Dispute, EvidenceDocument, InventoryMovement, Order, Parcel, Product, ProductVariant, ReturnRequest, Review, RiskSignal,
  SatisfactionSurvey, SellerOrder, Shipment, StockItem, Store, StoreMember, SupportKnowledge, SupportTicket, TrustCase,
} from '../models/index.js';
import { ensureShipmentForOrder, hashProofCode } from './logistics.js';

const ACTIVE_RETURN = ['requested','approved','awaiting_return','received','inspected','refund_pending','refund_processing','exchange_pending'];
const RETURNABLE_ORDER_STATES = ['paid','confirmed','partially_refunded','refunded'];

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
    country:order?.country||request.country.code,category:input.category,subject:input.subject,priority:input.priority,
    requesterName:String(input.name||request.user?.name||'').slice(0,120),requesterEmailMasked:maskEmail(input.email),
    requesterEmailEncrypted:encryptSensitive(String(input.email).trim().toLowerCase()),
    slaDueAt:new Date(Date.now()+hours*60*60*1000),notes:[{message:input.message,actorUserId:request.user?._id,internal:false}]
  });
}
export function supportRequester(ticket){
  if(!ticket)return {name:'',email:''};
  let email='';try{if(ticket.requesterEmailEncrypted)email=decryptSensitive(ticket.requesterEmailEncrypted);}catch{}
  return {name:ticket.requesterName||'',email:email||ticket.requesterEmailMasked||''};
}
export function supportScope(user){ return user?.role === 'super_admin' ? {} : { country: user?.country }; }

export async function createReturnRequest(request,input){
  const order=await Order.findOne({publicId:input.orderId,userId:request.user._id});
  if(!order) throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');
  if(!RETURNABLE_ORDER_STATES.includes(order.status)) throw new AppError('This order is not eligible for a return yet.',409,'RETURN_ORDER_STATE');
  const shipment=await Shipment.findOne({orderId:order._id,kind:'outbound',status:'delivered'}).sort({deliveredAt:-1}).lean();
  const windowDays=Number(order.policySnapshot?.returnWindowDays ?? 30); const baseDate=shipment?.deliveredAt || order.createdAt; const eligibleUntil=new Date(baseDate.getTime()+windowDays*24*60*60*1000);
  if(eligibleUntil < new Date()) throw new AppError('The return window has closed.',409,'RETURN_WINDOW_CLOSED');
  const sellerOrders=await SellerOrder.find({orderId:order._id}).lean();
  const sellerByStore=new Map(sellerOrders.map(row=>[row.storePublicId,row]));
  const requested=[]; let total=0;
  for(const raw of input.items){
    const item=order.items.find(x=>x.productPublicId===raw.productId); if(!item) throw new AppError('An item is not part of this order.',422,'RETURN_ITEM_INVALID');
    if(raw.quantity>item.quantity) throw new AppError('Return quantity exceeds the purchased quantity.',422,'RETURN_QUANTITY_INVALID');
    const duplicate=await ReturnRequest.exists({orderId:order._id,userId:request.user._id,status:{$in:ACTIVE_RETURN},'items.productPublicId':item.productPublicId}); if(duplicate) throw new AppError('An active return already exists for this item.',409,'RETURN_ALREADY_OPEN');
    const sellerOrder=sellerByStore.get(item.storePublicId);
    const lineGross=item.unitPriceMinor*item.quantity;
    const lineDiscount=sellerOrder&&sellerOrder.subtotalMinor>0?Math.floor(Number(sellerOrder.discountMinor||0)*lineGross/Number(sellerOrder.subtotalMinor)):0;
    const paidLine=Math.max(0,lineGross-lineDiscount);
    const amount=Math.floor(paidLine*raw.quantity/Math.max(1,item.quantity)); total+=amount; requested.push({productId:item.productId,variantId:item.variantId,storeId:item.storeId,storePublicId:item.storePublicId,productPublicId:item.productPublicId,variantPublicId:item.variantPublicId,title:item.title,quantity:raw.quantity,unitPriceMinor:item.unitPriceMinor,requestedRefundMinor:amount});
  }
  const doc=await ReturnRequest.create({publicId:publicId('ret'),orderId:order._id,orderPublicId:order.publicId,userId:request.user._id,country:order.country,reason:input.reason,details:input.details,resolution:input.resolution,items:requested,returnMethod:input.returnMethod||'dropoff',dropoffPointPublicId:input.dropoffPointId||'',eligibleUntil,policyVersion:order.policySnapshot?.policyVersion||'2026-07',timeline:[{type:'return.requested',message:`Return requested for ${requested.length} item(s).`,actorUserId:request.user._id}]});
  order.timeline.push({type:'return.requested',message:`Return ${doc.publicId} requested.`}); await order.save();
  if(['counterfeit_suspected','not_received'].includes(input.reason)) await RiskSignal.create({publicId:publicId('rsk'),country:order.country,subjectType:'order',subjectPublicId:order.publicId,type:`return_${input.reason}`,severity:input.reason==='counterfeit_suspected'?'high':'medium',score:input.reason==='counterfeit_suspected'?80:50,evidence:[doc.publicId],createdBy:'system'});
  return {returnRequest:doc,requestedRefundMinor:total,currency:order.totals.currency};
}

async function createReturnShipment(doc, actorUserId){
  const existing=await Shipment.findOne({returnRequestId:doc._id,kind:'return'}); if(existing)return existing;
  const order=await Order.findById(doc.orderId); const pickup=String(crypto.randomInt(100000,999999)), delivery=String(crypto.randomInt(100000,999999));
  const shipment=await Shipment.create({publicId:publicId('shp'),orderId:order._id,orderPublicId:order.publicId,kind:'return',returnRequestId:doc._id,country:doc.country,mode:'standard',pickupCodeHash:hashProofCode(pickup),deliveryCodeHash:hashProofCode(delivery),pickupCodeEncrypted:encryptSensitive(pickup),deliveryCodeEncrypted:encryptSensitive(delivery),cod:{required:false,amountMinor:0,currency:order.totals.currency,collectedMinor:0},timeline:[{type:'return_shipment_created',message:`Return pickup created for ${doc.publicId}.`,actorUserId}]});
  doc.returnShipmentPublicId=shipment.publicId; return shipment;
}

export async function decideReturn(request,returnId,{decision,note=''}){
  const doc=await ReturnRequest.findOne({publicId:returnId,...supportScope(request.user)}); if(!doc) throw new AppError('Return request not found.',404,'RETURN_NOT_FOUND');
  if(doc.status!=='requested') throw new AppError('This return has already been reviewed.',409,'RETURN_STATE');
  if(decision==='approve'){doc.status='awaiting_return'; if(doc.returnMethod==='pickup') await createReturnShipment(doc,request.user._id);} else doc.status='rejected';
  doc.decidedByUserId=request.user._id; doc.decidedAt=new Date(); doc.timeline.push({type:`return.${doc.status}`,message:note||`Return ${doc.status}.`,actorUserId:request.user._id}); await doc.save(); return doc;
}

export async function markReturnReceived(request,returnId,note=''){
  const doc=await ReturnRequest.findOne({publicId:returnId,...supportScope(request.user)});if(!doc)throw new AppError('Return request not found.',404,'RETURN_NOT_FOUND');if(!['approved','awaiting_return'].includes(doc.status))throw new AppError('Return is not awaiting receipt.',409,'RETURN_STATE');
  if(doc.returnMethod==='pickup'){const shipment=await Shipment.findOne({returnRequestId:doc._id,kind:'return'}).lean();if(!shipment||shipment.status!=='delivered')throw new AppError('The return pickup has not reached the receiving point yet.',409,'RETURN_SHIPMENT_NOT_DELIVERED');}
  doc.status='received';doc.timeline.push({type:'return.received',message:note||'Returned goods received for inspection.',actorUserId:request.user._id});await doc.save();return doc;
}

export async function inspectReturn(request,returnId,input){
  const doc=await ReturnRequest.findOne({publicId:returnId,...supportScope(request.user)}); if(!doc) throw new AppError('Return request not found.',404,'RETURN_NOT_FOUND');
  if(doc.status!=='received') throw new AppError('Return must be received before inspection.',409,'RETURN_STATE');
  doc.inspection={condition:input.condition,notes:input.notes||'',inspectedByUserId:request.user._id,inspectedAt:new Date()}; doc.status=doc.resolution==='refund'?'refund_pending':'exchange_pending'; doc.timeline.push({type:'return.inspected',message:`Inspection recorded: ${input.condition}.`,actorUserId:request.user._id}); await doc.save();
  if(input.condition==='counterfeit_suspected') await RiskSignal.create({publicId:publicId('rsk'),country:doc.country,subjectType:'order',subjectPublicId:doc.orderPublicId,type:'inspection_counterfeit_suspected',severity:'critical',score:95,evidence:[doc.publicId],createdBy:'operator'});
  return doc;
}

export async function createExchangeReplacement(request,returnId){
  const doc=await ReturnRequest.findOne({publicId:returnId,...supportScope(request.user)});if(!doc)throw new AppError('Return not found.',404,'RETURN_NOT_FOUND');if(doc.status!=='exchange_pending')throw new AppError('Return is not ready for exchange.',409,'RETURN_STATE');if(doc.replacementOrderPublicId)return Order.findOne({publicId:doc.replacementOrderPublicId});
  const original=await Order.findById(doc.orderId);if(!original)throw new AppError('Original order not found.',404,'ORDER_NOT_FOUND');
  const session=await mongoose.startSession();let replacement;
  try{await session.withTransaction(async()=>{
    const items=[];
    for(const returned of doc.items){const originalItem=original.items.find(i=>i.productPublicId===returned.productPublicId&&i.variantPublicId===returned.variantPublicId);const variant=await ProductVariant.findById(returned.variantId).session(session);if(!originalItem||!variant)throw new AppError('Replacement variant is unavailable.',409,'EXCHANGE_VARIANT_UNAVAILABLE');const stock=await StockItem.findOneAndUpdate(mongoose.trusted({variantId:variant._id,storeId:originalItem.storeId,$expr:{$gte:[{$subtract:['$onHand',{$add:['$reserved','$damaged','$quarantined']}]},returned.quantity]}}),{$inc:{onHand:-returned.quantity}},{returnDocument:'before',session});if(!stock)throw new AppError(`Replacement stock is unavailable for ${returned.title}.`,409,'EXCHANGE_STOCK_UNAVAILABLE');await InventoryMovement.create([{publicId:publicId('mov'),storeId:stock.storeId,stockItemId:stock._id,variantId:stock.variantId,warehouseId:stock.warehouseId,type:'sale',quantity:-returned.quantity,onHandBefore:stock.onHand,onHandAfter:stock.onHand-returned.quantity,reservedBefore:stock.reserved,reservedAfter:stock.reserved,reason:`Exchange replacement for ${doc.publicId}`,reference:doc.publicId,actorUserId:request.user._id}],{session});items.push({...originalItem.toObject?.()||originalItem,reservationPublicId:`exchange:${doc.publicId}`,quantity:returned.quantity,unitPriceMinor:0,lineTotalMinor:0});}
    const [order]=await Order.create([{publicId:publicId('ord'),idempotencyKey:`exchange:${doc.publicId}`,checkoutId:`exchange:${doc.publicId}`,cartPublicId:`exchange:${doc.publicId}`,sessionKey:original.sessionKey,userId:original.userId,country:original.country,status:'confirmed',deliveryMethod:original.deliveryMethod,shippingZonePublicId:original.shippingZonePublicId,pickupPointPublicId:original.pickupPointPublicId,paymentMethod:'exchange',contact:original.contact,totals:{subtotalMinor:0,shippingMinor:0,discountMinor:0,taxMinor:0,totalMinor:0,currency:original.totals.currency},items,policySnapshot:original.policySnapshot,timeline:[{type:'exchange.created',message:`Replacement order for return ${doc.publicId}.`,actorUserId:request.user._id}],reservationExpiresAt:new Date(Date.now()+365*24*60*60*1000)}],{session});
    const groups=new Map();for(const item of items){const arr=groups.get(item.storePublicId)||[];arr.push(item);groups.set(item.storePublicId,arr);}const sellerIds=[];for(const [storePublicId,group] of groups){const id=publicId('sord');sellerIds.push(id);await SellerOrder.create([{publicId:id,orderId:order._id,orderPublicId:order.publicId,storeId:group[0].storeId,storePublicId,country:order.country,status:'confirmed',subtotalMinor:0,shippingMinor:0,taxMinor:0,discountMinor:0,currency:order.totals.currency,items:group.map(i=>({productPublicId:i.productPublicId,variantPublicId:i.variantPublicId,title:i.title,sku:i.sku,quantity:i.quantity,unitPriceMinor:0,lineTotalMinor:0,currency:i.currency})),timeline:[{type:'exchange.created',message:`Exchange replacement for ${doc.publicId}.`}]}],{session});}order.sellerOrderPublicIds=sellerIds;await order.save({session});doc.replacementOrderPublicId=order.publicId;doc.status='exchanged';doc.timeline.push({type:'return.exchanged',message:`Replacement order ${order.publicId} created and stock committed.`,actorUserId:request.user._id});await doc.save({session});replacement=order;
  });}finally{await session.endSession();}
  await ensureShipmentForOrder(replacement,request.user._id);return replacement;
}

export async function createDispute(request,input){const order=await Order.findOne({publicId:input.orderId,userId:request.user._id});if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');const existing=await Dispute.exists({orderId:order._id,userId:request.user._id,status:{$nin:['resolved','rejected','closed']},category:input.category});if(existing)throw new AppError('A similar dispute is already open for this order.',409,'DISPUTE_ALREADY_OPEN');return Dispute.create({publicId:publicId('dsp'),userId:request.user._id,orderId:order._id,orderPublicId:order.publicId,country:order.country,category:input.category,subject:input.subject,description:input.description,priority:['counterfeit','payment'].includes(input.category)?'high':'normal',events:[{type:'dispute.opened',message:input.description,actorUserId:request.user._id}]});}
export async function createTicket(request,input){let order=null;if(input.orderId){order=await Order.findOne({publicId:input.orderId,userId:request.user._id});if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');}const duplicate=await SupportTicket.findOne({userId:request.user._id,orderPublicId:order?.publicId||{$in:[null,'']},category:input.category,status:{$in:['open','in_progress','waiting_customer','escalated']},createdAt:{$gte:new Date(Date.now()-15*60*1000)}}).lean();if(duplicate)throw new AppError(`A similar active support ticket (${duplicate.publicId}) was created recently.`,409,'SUPPORT_DUPLICATE');const hours=input.priority==='urgent'?4:input.priority==='high'?12:48;return SupportTicket.create({publicId:publicId('tkt'),userId:request.user._id,orderId:order?._id,orderPublicId:order?.publicId,country:order?.country||request.user.country,category:input.category,subject:input.subject,priority:input.priority,slaDueAt:new Date(Date.now()+hours*60*60*1000),notes:[{message:input.message,actorUserId:request.user._id,internal:false}]});}
export async function createVerifiedReview(request,input){const orderQuery={userId:request.user._id,status:{$in:['paid','confirmed','partially_refunded','refunded']},'items.productPublicId':input.productId};if(input.orderId)orderQuery.publicId=input.orderId;const order=await Order.findOne(orderQuery).sort({createdAt:-1});if(!order)throw new AppError('A verified purchase is required to review this product.',403,'VERIFIED_PURCHASE_REQUIRED');const item=order.items.find(x=>x.productPublicId===input.productId);if(!item)throw new AppError('This product was not purchased in the order.',422,'REVIEW_PRODUCT_INVALID');const store=await Store.findOne({publicId:item.storePublicId}).lean();if(store && (String(store.ownerUserId)===String(request.user._id) || await StoreMember.exists({storeId:store._id,userId:request.user._id,status:'active'})))throw new AppError('Store owners and staff cannot review products from a store they operate.',403,'SELF_REVIEW_BLOCKED');const product=await Product.findOne({publicId:item.productPublicId});if(!product)throw new AppError('Product not found.',404,'PRODUCT_NOT_FOUND');try{const review=await Review.create({publicId:publicId('rev'),userId:request.user._id,orderId:order._id,orderPublicId:order.publicId,productId:product._id,productPublicId:product.publicId,country:order.country,rating:input.rating,title:input.title||'',body:input.body,verifiedPurchase:true,status:'pending'});const recent=await Review.countDocuments({userId:request.user._id,createdAt:{$gte:new Date(Date.now()-24*60*60*1000)}});if(recent>5)await RiskSignal.create({publicId:publicId('rsk'),country:order.country,subjectType:'user',subjectPublicId:String(request.user._id),type:'review_velocity',severity:'medium',score:55,evidence:[review.publicId],createdBy:'system'}).catch(()=>{});return review;}catch(error){if(error?.code===11000)throw new AppError('You already reviewed this product from this order.',409,'REVIEW_EXISTS');throw error;}}

export async function disputeReview(request,reviewId,reason){const review=await Review.findOne({publicId:reviewId,status:'published'});if(!review)throw new AppError('Published review not found.',404,'REVIEW_NOT_FOUND');const product=await Product.findById(review.productId);const store=product?await Store.findById(product.storeId):null;const member=store?await StoreMember.findOne({storeId:store._id,userId:request.user._id,status:'active',role:{$in:['owner','admin','support']}}):null;if(!store||(!store.ownerUserId.equals(request.user._id)&&!member))throw new AppError('Only authorized staff from the affected store can dispute this review.',403,'FORBIDDEN');review.status='disputed';review.disputeReason=reason;review.disputedByUserId=request.user._id;review.disputedAt=new Date();await review.save();return review;}

export async function reportTrustIssue(request,input){const product=input.productId?await Product.findOne({publicId:input.productId}).lean():null;const store=input.storeId?await Store.findOne({publicId:input.storeId}).lean():null;if(input.productId&&!product)throw new AppError('Product not found.',404,'PRODUCT_NOT_FOUND');if(input.storeId&&!store)throw new AppError('Store not found.',404,'STORE_NOT_FOUND');const country=product?.countries?.[0]||store?.country||request.user.country;const trustCase=await TrustCase.create({publicId:publicId('case'),reporterUserId:request.user._id,country,type:input.type,productId:product?._id,productPublicId:product?.publicId,storeId:store?._id,storePublicId:store?.publicId,description:input.description});const severity=['counterfeit','unsafe_product','prohibited_product'].includes(input.type)?'high':'medium';await RiskSignal.create({publicId:publicId('rsk'),country,subjectType:product?'product':'store',subjectPublicId:product?.publicId||store?.publicId,type:`trust_${input.type}`,severity,score:severity==='high'?80:55,evidence:[trustCase.publicId],createdBy:'user'});return trustCase;}
export async function publishReview(request,reviewId,{decision,reason=''}){const review=await Review.findOne({publicId:reviewId,...supportScope(request.user)});if(!review)throw new AppError('Review not found.',404,'REVIEW_NOT_FOUND');if(!['pending','disputed'].includes(review.status))throw new AppError('Review is already finalized.',409,'REVIEW_STATE');review.status=decision==='publish'?'published':'rejected';review.moderationReason=reason;if(review.status==='published')review.publishedAt=new Date();await review.save();return review;}

export async function createKnowledgeArticle(request,input){const slug=input.slug.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');return SupportKnowledge.create({publicId:publicId('kb'),country:input.country||request.user.country,title:input.title,slug,body:input.body,category:input.category,status:input.status,createdByUserId:request.user._id,updatedByUserId:request.user._id,publishedAt:input.status==='published'?new Date():null});}
export async function submitSatisfaction(request,ticketPublicId,input){const ticket=await SupportTicket.findOne({publicId:ticketPublicId,userId:request.user._id,status:{$in:['resolved','closed']}});if(!ticket)throw new AppError('Resolved support ticket not found.',404,'TICKET_NOT_FOUND');return SatisfactionSurvey.findOneAndUpdate({ticketId:ticket._id,userId:request.user._id},{$set:{rating:input.rating,comment:input.comment},$setOnInsert:{publicId:publicId('sat'),ticketPublicId:ticket.publicId}},{upsert:true,returnDocument:'after'});}
export async function attachEvidence(contextDoc,evidence){if(!contextDoc.evidenceDocumentIds)contextDoc.evidenceDocumentIds=[];if(!contextDoc.evidenceDocumentIds.some(id=>id.equals(evidence._id)))contextDoc.evidenceDocumentIds.push(evidence._id);await contextDoc.save();return contextDoc;}

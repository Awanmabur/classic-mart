import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { safeEqual } from '../core/crypto.js';
import { encryptSensitive, decryptSensitive } from '../core/sensitive.js';
import {
  InventoryMovement, InventoryReservation, Order, PaymentIntent, ProviderEvent, Refund, StockItem,
  LedgerAccount, LedgerTransaction, PayoutAccount, Payout, ReconciliationRun, SellerOrder, Store, StoreMember,
} from '../models/index.js';
import { ensureLedgerAccount, postLedgerTransaction, accountBalanceMinor, sellerSettlementBreakdown } from './money.js';
import { orderAccessQuery } from './order-access.js';

const PROVIDER='flutterwave';
const factors={UGX:1,RWF:1,JPY:1,KRW:1};
const factor=(currency)=>factors[currency]||100;
const major=(minor,currency)=>minor/factor(currency);
function flutterwavePayloadHash({ amount, currency, email, txRef }) {
  if (!env.flutterwave.secretKey) return '';
  const hashedSecretKey = crypto.createHash('sha256').update(env.flutterwave.secretKey, 'utf8').digest('hex');
  return crypto.createHash('sha256').update(`${amount}${currency}${email}${txRef}${hashedSecretKey}`, 'utf8').digest('hex');
}
function paymentOptions(method,currency){
  if(method==='card') return 'card';
  return ({UGX:'mobilemoneyuganda',KES:'mpesa',RWF:'mobilemoneyrwanda',TZS:'mobilemoneytanzania'}[currency]||'card');
}
async function flutterwave(path,{method='GET',body}={}){
  if(!env.flutterwave.secretKey) throw new AppError('Online payments are not configured.',503,'PAYMENT_PROVIDER_UNAVAILABLE');
  const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),10_000);
  try{
    const response=await fetch(`${env.flutterwave.baseUrl}${path}`,{method,headers:{Authorization:`Bearer ${env.flutterwave.secretKey}`,'Content-Type':'application/json',Accept:'application/json'},body:body?JSON.stringify(body):undefined,signal:controller.signal});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok||payload.status==='error') throw new AppError(payload.message||'Payment provider request failed.',502,'PAYMENT_PROVIDER_ERROR');
    return payload;
  }catch(error){ if(error instanceof AppError)throw error; throw new AppError('Payment provider is temporarily unavailable.',502,'PAYMENT_PROVIDER_ERROR'); }
  finally{clearTimeout(timeout);}
}
export async function getPaymentIntentForOrder(request,orderId){
  const order=await Order.findOne(mongoose.trusted(orderAccessQuery(request, orderId))).lean(); if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');
  const intent=await PaymentIntent.findOne({orderId:order._id}).sort({createdAt:-1}).lean();
  return {order,intent};
}
export async function initiatePayment(request,{orderId,idempotencyKey}){
  const order=await Order.findOne(mongoose.trusted(orderAccessQuery(request, orderId))); if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');
  if(!['pending_payment','payment_failed'].includes(order.status)) throw new AppError('This order cannot start another payment.',409,'ORDER_PAYMENT_STATE');
  let intent=await PaymentIntent.findOne({orderId:order._id,idempotencyKey}); if(intent)return paymentView(intent);
  if(order.reservationExpiresAt<=new Date()) throw new AppError('The stock reservation expired. Create the order again.',409,'RESERVATION_EXPIRED');
  if(order.paymentMethod==='cod'){
    const docs=await PaymentIntent.create([{publicId:publicId('pay'),orderId:order._id,orderPublicId:order.publicId,idempotencyKey,provider:'cod',method:'cod',status:'pending_collection',amountMinor:order.totals.totalMinor,currency:order.totals.currency,providerReference:`cod:${order.publicId}`}]); intent=docs[0];
    await commitOrderInventoryAndMoney(order,intent,{cod:true});
    const { ensureShipmentForOrder } = await import('./logistics.js'); await ensureShipmentForOrder(await Order.findById(order._id), order.userId || null);
    return paymentView(await PaymentIntent.findById(intent._id));
  }
  const docs=await PaymentIntent.create([{publicId:publicId('pay'),orderId:order._id,orderPublicId:order.publicId,idempotencyKey,provider:PROVIDER,method:order.paymentMethod,status:'created',amountMinor:order.totals.totalMinor,currency:order.totals.currency,providerReference:`cm-${order.publicId}-${crypto.randomUUID()}`}]); intent=docs[0];
  try{
    const providerAmount=major(intent.amountMinor,intent.currency);
    const providerBody={tx_ref:intent.providerReference,amount:providerAmount,currency:intent.currency,redirect_url:`${env.baseUrl}/payments/return`,payment_options:paymentOptions(intent.method,intent.currency),customer:{email:order.contact.email,name:order.contact.fullName,phonenumber:order.contact.phone},customizations:{title:'Classic Mart',description:`Order ${order.publicId}`},meta:{order_id:order.publicId,payment_intent:intent.publicId},configurations:{session_duration:15,max_retry_attempt:5}};
    providerBody.payload_hash=flutterwavePayloadHash({amount:providerAmount,currency:intent.currency,email:order.contact.email,txRef:intent.providerReference});
    const result=await flutterwave('/v3/payments',{method:'POST',body:providerBody});
    if(!result.data?.link) throw new AppError('Payment provider did not return a checkout link.',502,'PAYMENT_PROVIDER_ERROR');
    intent.checkoutUrl=result.data.link; intent.status='requires_action'; await intent.save(); return paymentView(intent);
  }catch(error){intent.status='failed';intent.failureMessage=error.message;await intent.save();throw error;}
}
export function paymentView(intent){return {id:intent.publicId,orderId:intent.orderPublicId,provider:intent.provider,method:intent.method,status:intent.status,amountMinor:intent.amountMinor,currency:intent.currency,checkoutUrl:intent.checkoutUrl||null,providerReference:intent.providerReference||null,paidAt:intent.paidAt||null};}
async function verifyFlutterwaveTransaction(transactionId){
  const result=await flutterwave(`/v3/transactions/${encodeURIComponent(transactionId)}/verify`); return result.data||{};
}
async function verifyFlutterwaveByReference(reference){
  const result=await flutterwave(`/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`);
  return result.data||{};
}
async function commitOrderInventoryAndMoney(orderLike,intentLike,{cod=false,providerTransactionId}={}){
  const session=await mongoose.startSession(); try{await session.withTransaction(async()=>{
    const order=await Order.findById(orderLike._id).session(session); const intent=await PaymentIntent.findById(intentLike._id).session(session);
    if(!order||!intent)return; if(['paid','confirmed'].includes(order.status))return;
    for(const item of order.items){
      const reservation=await InventoryReservation.findOne({publicId:item.reservationPublicId,status:'active'}).session(session); if(!reservation)throw new AppError('Order stock reservation is no longer active.',409,'RESERVATION_INACTIVE');
      const stock=await StockItem.findOneAndUpdate(mongoose.trusted({_id:reservation.stockItemId,onHand:{$gte:reservation.quantity},reserved:{$gte:reservation.quantity}}),{$inc:{onHand:-reservation.quantity,reserved:-reservation.quantity}},{returnDocument:'after',session});
      if(!stock)throw new AppError('Reserved stock is inconsistent.',409,'STOCK_CONFLICT');
      reservation.status='committed';reservation.committedAt=new Date();await reservation.save({session});
      await InventoryMovement.create([{publicId:publicId('mov'),storeId:reservation.storeId,stockItemId:stock._id,variantId:stock.variantId,warehouseId:stock.warehouseId,type:'sale',quantity:-reservation.quantity,onHandBefore:stock.onHand+reservation.quantity,onHandAfter:stock.onHand,reservedBefore:stock.reserved+reservation.quantity,reservedAfter:stock.reserved,reason:cod?'COD order confirmed':'Verified payment sale',reference:order.publicId,actorUserId:reservation.actorUserId}],{session});
    }
    if(cod){order.status='confirmed';order.timeline.push({type:'payment.cod_pending',message:'Cash on delivery selected. Payment will be collected during fulfilment.'});}
    else{
      order.status='paid'; order.timeline.push({type:'payment.verified',message:'Payment verified by the payment provider.'});
      const clearing=await ensureLedgerAccount({code:'provider_clearing',type:'asset',ownerType:'provider',ownerPublicId:PROVIDER,country:order.country,currency:order.totals.currency},session);
      const entries=[{account:clearing,debitMinor:order.totals.totalMinor,creditMinor:0,memo:'Verified customer payment'}];
      const sellerOrders=await SellerOrder.find({orderId:order._id}).session(session).lean();
      let platformFeeTotal=0;
      for(const sellerOrder of sellerOrders){
        const settlement=sellerSettlementBreakdown(sellerOrder); platformFeeTotal+=settlement.platformFeeMinor;
        const store=await Store.findOne({publicId:sellerOrder.storePublicId}).session(session);
        const payable=await ensureLedgerAccount({code:'seller_payable',type:'liability',ownerType:'store',ownerId:store?._id,ownerPublicId:sellerOrder.storePublicId,country:order.country,currency:order.totals.currency},session);
        if(settlement.sellerPayableMinor>0)entries.push({account:payable,debitMinor:0,creditMinor:settlement.sellerPayableMinor,memo:`Seller payable net of discount and marketplace fee for ${order.publicId}`});
      }
      const platformRevenueMinor=platformFeeTotal+Number(order.totals.shippingMinor||0);
      if(platformRevenueMinor>0){const revenue=await ensureLedgerAccount({code:'platform_revenue',type:'revenue',ownerType:'platform',ownerPublicId:'classic-mart',country:order.country,currency:order.totals.currency},session);entries.push({account:revenue,debitMinor:0,creditMinor:platformRevenueMinor,memo:'Marketplace fees and delivery revenue'});}
      if(order.totals.taxMinor>0){const tax=await ensureLedgerAccount({code:'tax_payable',type:'liability',ownerType:'platform',ownerPublicId:'classic-mart',country:order.country,currency:order.totals.currency},session);entries.push({account:tax,debitMinor:0,creditMinor:order.totals.taxMinor,memo:'Collected marketplace tax liability'});}
      await postLedgerTransaction({idempotencyKey:`payment:${intent.publicId}`,referenceType:'payment',referencePublicId:intent.publicId,currency:order.totals.currency,description:`Verified payment for ${order.publicId}`,entries},session);
      const { makeOrderCommissionsPayable } = await import('./promoters.js'); await makeOrderCommissionsPayable(order,session);
      const { applyGrowthForPaidOrder } = await import('./stage9.js'); await applyGrowthForPaidOrder(order,session);
      intent.status='succeeded';intent.paidAt=new Date();intent.providerTransactionId=String(providerTransactionId||intent.providerTransactionId||'');intent.lastVerifiedAt=new Date();
    }
    const sellerStatus = cod ? 'confirmed' : 'confirmed';
    await SellerOrder.updateMany({ orderId: order._id, status: 'pending_payment' }, { $set: { status: sellerStatus }, $push: { timeline: { type: cod ? 'payment.cod_pending' : 'payment.verified', message: cod ? 'COD order confirmed for fulfilment.' : 'Marketplace payment verified.' } } }, { session });
    await order.save({session});await intent.save({session});
  });}finally{await session.endSession();}
}
export async function verifyAndApplyPayment(intentPublicId,transactionId){
  const intent=await PaymentIntent.findOne({publicId:intentPublicId}); if(!intent)throw new AppError('Payment intent not found.',404,'PAYMENT_NOT_FOUND'); if(intent.provider!==PROVIDER) return paymentView(intent);
  const data=await verifyFlutterwaveTransaction(transactionId); intent.lastVerifiedAt=new Date();
  const amountMinor=Math.round(Number(data.amount)*factor(intent.currency)); const ok=['successful','succeeded'].includes(String(data.status).toLowerCase())&&String(data.currency).toUpperCase()===intent.currency&&amountMinor===intent.amountMinor&&String(data.tx_ref||data.reference||'')===intent.providerReference;
  if(!ok){intent.status='failed';intent.failureCode='VERIFICATION_MISMATCH';intent.failureMessage='Provider verification did not match the order amount, currency, reference and successful state.';await intent.save();const order=await Order.findById(intent.orderId);if(order&&order.status==='pending_payment'){order.status='payment_failed';order.timeline.push({type:'payment.failed',message:'Payment verification failed.'});await order.save();}return paymentView(intent);}
  intent.providerTransactionId=String(data.id||transactionId); await intent.save(); const order=await Order.findById(intent.orderId); await commitOrderInventoryAndMoney(order,intent,{providerTransactionId:data.id||transactionId}); const { ensureShipmentForOrder } = await import('./logistics.js'); await ensureShipmentForOrder(await Order.findById(order._id), order.userId || null); return paymentView(await PaymentIntent.findById(intent._id));
}
export function validFlutterwaveWebhook(rawBody,signature){
  if(!env.flutterwave.webhookSecret||!signature)return false;
  const hmac=crypto.createHmac('sha256',env.flutterwave.webhookSecret).update(rawBody).digest('base64');
  return safeEqual(hmac,signature);
}
export async function processFlutterwaveWebhook(rawBody,body,signature){
  if(!validFlutterwaveWebhook(rawBody,signature))throw new AppError('Invalid payment webhook signature.',401,'WEBHOOK_SIGNATURE_INVALID');
  const eventId=String(body.id||body.webhook_id||body.data?.id||crypto.createHash('sha256').update(rawBody).digest('hex')); const eventType=String(body.type||body.event||'unknown'); const rawHash=crypto.createHash('sha256').update(rawBody).digest('hex');
  let event; try{event=await ProviderEvent.create({publicId:publicId('evt'),provider:PROVIDER,eventId,eventType,rawHash,rawEncrypted:encryptSensitive(rawBody),verifiedAt:new Date()});}catch(error){if(error?.code===11000)return {duplicate:true};throw error;}
  try{
    if(/charge\.completed/i.test(eventType)){
      const ref=String(body.data?.tx_ref||body.data?.reference||'');const intent=await PaymentIntent.findOne({providerReference:ref});if(intent&&body.data?.id)await verifyAndApplyPayment(intent.publicId,body.data.id);else event.status='ignored';
    } else if(/refund/i.test(eventType)) {
      const providerRefundId=String(body.data?.id||body.data?.refund_id||'');const refund=await Refund.findOne({providerRefundId});if(refund&&String(body.data?.status||'').toLowerCase()==='completed'){refund.status='completed';refund.completedAt=new Date();await refund.save();const order=await Order.findById(refund.orderId);const intent=await PaymentIntent.findById(refund.paymentIntentId);await postRefundLedger(order,refund,intent);}else event.status='ignored';
    } else if(/transfer\.completed/i.test(eventType)) {
      const ref=String(body.data?.reference||body.data?.tx_ref||'');const payout=await Payout.findOne({$or:[{providerReference:ref},{publicId:ref}]});if(payout){const state=String(body.data?.status||'').toLowerCase();await completePayout(payout,['successful','success','completed'].includes(state),String(body.data?.complete_message||body.data?.message||''));}else event.status='ignored';
    } else event.status='ignored';
    if(event.status!=='ignored')event.status='processed';event.processedAt=new Date();await event.save();return {duplicate:false};
  }catch(error){event.status='failed';event.error=error.message;event.processedAt=new Date();await event.save();throw error;}
}
export async function createRefund(request,{orderId,amountMinor,reason,idempotencyKey,allocations=[]}){
  const order=await Order.findOne({publicId:orderId});
  if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');
  const financeActor=['finance','country_admin','super_admin'].includes(request.user?.role);
  const ownedByUser=Boolean(request.user?._id&&order.userId&&order.userId.equals(request.user._id));
  const ownedByGuest=Boolean(!request.user?._id&&request.session?.cartKey&&order.sessionKey===request.session.cartKey);
  if(financeActor){if(request.user.role!=='super_admin'&&order.country!==request.user.country)throw new AppError('Order is outside your country scope.',403,'COUNTRY_SCOPE');}
  else if(!ownedByUser&&!ownedByGuest)throw new AppError('You cannot refund this order.',403,'ORDER_SCOPE');
  if(!['paid','partially_refunded'].includes(order.status))throw new AppError('Only a verified paid order can be refunded.',409,'REFUND_ORDER_STATE');
  const intent=await PaymentIntent.findOne({orderId:order._id,status:{$in:['succeeded','partially_refunded']}}).sort({paidAt:-1});
  if(!intent)throw new AppError('Verified payment record not found.',409,'REFUND_PAYMENT_MISSING');
  if(intent.provider!=='cod'&&!intent.providerTransactionId)throw new AppError('Verified provider transaction not found.',409,'REFUND_PAYMENT_MISSING');
  const existing=await Refund.findOne({idempotencyKey});if(existing)return existing;
  const prior=await Refund.aggregate([{$match:{orderId:order._id,status:{$in:['processing','completed']}}},{$group:{_id:null,total:{$sum:'$amountMinor'}}}]); const available=order.totals.totalMinor-(prior[0]?.total||0); const amount=Math.min(amountMinor||available,available);if(amount<=0)throw new AppError('Nothing remains refundable.',409,'REFUND_EXHAUSTED');
  if((!Array.isArray(allocations)||allocations.length===0)&&amount<available){
    throw new AppError('Partial refunds require explicit item/seller allocations. Use the inspected return workflow for item refunds.',422,'PARTIAL_REFUND_ALLOCATION_REQUIRED');
  }
  const cleanAllocations=[];
  if(Array.isArray(allocations)&&allocations.length){
    let allocationTotal=0;
    for(const raw of allocations){
      const storePublicId=String(raw.storePublicId||'').trim();const productPublicId=String(raw.productPublicId||'').trim();const grossMinor=Math.floor(Number(raw.grossMinor||0));
      if(!storePublicId||grossMinor<=0)throw new AppError('Refund allocation is invalid.',422,'REFUND_ALLOCATION_INVALID');
      const purchased=order.items.some(item=>item.storePublicId===storePublicId&&(!productPublicId||item.productPublicId===productPublicId));
      if(!purchased)throw new AppError('Refund allocation does not belong to this order.',422,'REFUND_ALLOCATION_INVALID');
      cleanAllocations.push({storePublicId,productPublicId,grossMinor});allocationTotal+=grossMinor;
    }
    if(allocationTotal!==amount)throw new AppError('Refund allocations must equal the refund amount.',422,'REFUND_ALLOCATION_TOTAL');
  }
  const refund=await Refund.create({publicId:publicId('rfd'),idempotencyKey,orderId:order._id,paymentIntentId:intent._id,amountMinor:amount,currency:order.totals.currency,reason,allocations:cleanAllocations,provider:intent.provider==='cod'?'cod_manual':'flutterwave',requestedByUserId:request.user?._id,status:intent.provider==='cod'?'processing':'pending'});
  if(intent.provider==='cod') return refund;
  try{const result=await flutterwave(`/v3/transactions/${encodeURIComponent(intent.providerTransactionId)}/refund`,{method:'POST',body:{amount:major(amount,order.totals.currency),comments:reason,callbackurl:`${env.baseUrl}/webhooks/flutterwave`}}); refund.providerRefundId=String(result.data?.id||'');refund.status=String(result.data?.status||'processing').toLowerCase()==='completed'?'completed':'processing';if(refund.status==='completed'){refund.completedAt=new Date();refund.completedByUserId=request.user?._id;await postRefundLedger(order,refund,intent);}await refund.save();return refund;}catch(error){refund.status='failed';await refund.save();throw error;}
}

export async function completeManualRefund(request,refundPublicId,{reference}){
  const refund=await Refund.findOne({publicId:refundPublicId,provider:'cod_manual',status:'processing'});
  if(!refund)throw new AppError('Pending COD refund not found.',404,'REFUND_NOT_FOUND');
  const order=await Order.findById(refund.orderId);if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');
  if(request.user.role!=='super_admin'&&order.country!==request.user.country)throw new AppError('Refund is outside your country scope.',403,'COUNTRY_SCOPE');
  if(refund.requestedByUserId?.equals(request.user._id))throw new AppError('A different finance operator must confirm COD refund disbursement.',403,'FOUR_EYES_REQUIRED');
  const intent=await PaymentIntent.findById(refund.paymentIntentId);if(!intent||intent.provider!=='cod')throw new AppError('COD payment record not found.',409,'REFUND_PAYMENT_MISSING');
  refund.manualReference=String(reference||'').trim();if(refund.manualReference.length<4)throw new AppError('Enter the cash/mobile-money refund reference.',422,'REFUND_REFERENCE_REQUIRED');
  refund.status='completed';refund.completedAt=new Date();refund.completedByUserId=request.user._id;refund.providerRefundId=`cod:${refund.manualReference}`;
  await postRefundLedger(order,refund,intent);await refund.save();return refund;
}

async function postRefundLedger(orderLike,refund,intentLike){
  const session=await mongoose.startSession();
  try{
    await session.withTransaction(async()=>{
      if(await LedgerTransaction.exists({idempotencyKey:`refund:${refund.publicId}`}).session(session))return;
      // Reload optimistic-concurrency documents inside this transaction. Callers may
      // have loaded them before other fulfilment/refund work advanced __v. Saving
      // those stale documents here can otherwise throw VersionError mid-refund.
      const order=await Order.findById(orderLike._id).session(session);
      const intent=await PaymentIntent.findById(intentLike._id).session(session);
      if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');
      if(!intent)throw new AppError('Verified payment record not found.',409,'REFUND_PAYMENT_MISSING');
      const entries=[];
      const sellerOrders=await SellerOrder.find({orderId:order._id}).session(session).lean();
      const byStore=new Map(sellerOrders.map(row=>[row.storePublicId,row]));
      const allocations=Array.isArray(refund.allocations)?refund.allocations.filter(row=>Number(row.grossMinor)>0):[];
      const affectedStores=new Set();

      if(allocations.length){
        const storeGross=new Map();
        for(const allocation of allocations){
          const row=byStore.get(allocation.storePublicId);
          if(!row)throw new AppError('Refund allocation store is not part of the order.',409,'REFUND_ALLOCATION_INVALID');
          affectedStores.add(allocation.storePublicId);
          storeGross.set(allocation.storePublicId,(storeGross.get(allocation.storePublicId)||0)+Number(allocation.grossMinor));
        }
        let platformFeeRefund=0;
        for(const [storePublicId,gross] of storeGross){
          const row=byStore.get(storePublicId);
          if(gross>row.subtotalMinor)throw new AppError('Refund allocation exceeds seller order subtotal.',409,'REFUND_ALLOCATION_INVALID');
          const fee=Math.min(gross,Math.floor(gross*Number(row.platformFeeMinor||0)/Math.max(1,row.subtotalMinor)));
          const sellerNet=gross-fee;platformFeeRefund+=fee;
          if(sellerNet>0){
            const account=await ensureLedgerAccount({code:'seller_payable',type:'liability',ownerType:'store',ownerPublicId:storePublicId,country:order.country,currency:order.totals.currency},session);
            entries.push({account,debitMinor:sellerNet,creditMinor:0,memo:`Refund seller payable reversal for ${storePublicId}`});
          }
        }
        if(platformFeeRefund>0){
          const account=await ensureLedgerAccount({code:'platform_revenue',type:'revenue',ownerType:'platform',ownerPublicId:'classic-mart',country:order.country,currency:order.totals.currency},session);
          entries.push({account,debitMinor:platformFeeRefund,creditMinor:0,memo:'Refund marketplace fee reversal'});
        }
      }else{
        // Generic finance/cancellation refunds may include shipping/tax and therefore
        // retain proportional allocation across the whole marketplace order.
        const sellerNetTotal=sellerOrders.reduce((sum,row)=>sum+Math.max(0,Number(row.subtotalMinor||0)-Number(row.discountMinor||0)-Number(row.platformFeeMinor||0)),0);
        const platformRevenueTotal=sellerOrders.reduce((sum,row)=>sum+Number(row.platformFeeMinor||0),0)+Number(order.totals.shippingMinor||0);
        const taxTotal=Number(order.totals.taxMinor||0);
        const totalBase=Math.max(1,sellerNetTotal+platformRevenueTotal+taxTotal);
        const sellerRefund=Math.min(refund.amountMinor,Math.floor(refund.amountMinor*sellerNetTotal/totalBase));
        const platformRefund=Math.min(refund.amountMinor-sellerRefund,Math.floor(refund.amountMinor*platformRevenueTotal/totalBase));
        const taxRefund=refund.amountMinor-sellerRefund-platformRefund;
        let allocated=0;
        for(let i=0;i<sellerOrders.length;i++){
          const row=sellerOrders[i];const net=Math.max(0,row.subtotalMinor-Number(row.platformFeeMinor||0));
          const part=i===sellerOrders.length-1?sellerRefund-allocated:Math.floor(sellerRefund*net/Math.max(1,sellerNetTotal));allocated+=part;
          if(part>0){const account=await ensureLedgerAccount({code:'seller_payable',type:'liability',ownerType:'store',ownerPublicId:row.storePublicId,country:order.country,currency:order.totals.currency},session);entries.push({account,debitMinor:part,creditMinor:0,memo:'Refund seller payable reversal'});}
        }
        if(platformRefund>0){const account=await ensureLedgerAccount({code:'platform_revenue',type:'revenue',ownerType:'platform',ownerPublicId:'classic-mart',country:order.country,currency:order.totals.currency},session);entries.push({account,debitMinor:platformRefund,creditMinor:0,memo:'Refund marketplace revenue reversal'});}
        if(taxRefund>0){const tax=await ensureLedgerAccount({code:'tax_payable',type:'liability',ownerType:'platform',ownerPublicId:'classic-mart',country:order.country,currency:order.totals.currency},session);entries.push({account:tax,debitMinor:taxRefund,creditMinor:0,memo:'Refund tax liability reversal'});}
      }

      const clearing=await ensureLedgerAccount({code:intent.provider==='cod'?'cod_clearing':'provider_clearing',type:'asset',ownerType:intent.provider==='cod'?'platform':'provider',ownerPublicId:intent.provider==='cod'?'classic-mart':PROVIDER,country:order.country,currency:order.totals.currency},session);
      entries.push({account:clearing,debitMinor:0,creditMinor:refund.amountMinor,memo:intent.provider==='cod'?'COD customer refund disbursed':'Customer refund'});
      await postLedgerTransaction({idempotencyKey:`refund:${refund.publicId}`,referenceType:'refund',referencePublicId:refund.publicId,currency:refund.currency,country:order.country,description:`Refund for ${order.publicId}`,entries},session);

      const previous=await Refund.aggregate([{$match:{orderId:order._id,status:'completed',_id:{$ne:refund._id}}},{$group:{_id:null,total:{$sum:'$amountMinor'}}}]).session(session);
      const completedMinor=(previous[0]?.total||0)+refund.amountMinor;
      const fully=completedMinor>=order.totals.totalMinor;
      intent.status=fully?'refunded':'partially_refunded';order.status=fully?'refunded':'partially_refunded';await intent.save({session});
      order.timeline.push({type:'refund.completed',message:`Refund ${refund.publicId} completed.`});
      if(fully||!allocations.length){
        await SellerOrder.updateMany({orderId:order._id},{$set:{status:fully?'refunded':'partially_refunded'},$push:{timeline:{type:'refund.completed',message:`Refund ${refund.publicId} applied to marketplace order.`}}},{session});
      }else if(affectedStores.size){
        await SellerOrder.updateMany({orderId:order._id,storePublicId:{$in:[...affectedStores]}},{$set:{status:'partially_refunded'},$push:{timeline:{type:'refund.completed',message:`Item refund ${refund.publicId} applied to this seller order.`}}},{session});
      }

      const { ReturnRequest }=await import('../models/ReturnRequest.js');
      const returnRequest=await ReturnRequest.findOne({refundPublicId:refund.publicId}).session(session);
      if(returnRequest&&returnRequest.status!=='refunded'){returnRequest.status='refunded';returnRequest.timeline.push({type:'return.refunded',message:`Refund ${refund.publicId} completed by the payment provider.`});await returnRequest.save({session});}
      const { reverseOrderCommissions }=await import('./promoters.js');await reverseOrderCommissions(order,refund,session);
      await order.save({session});
    });
  }finally{await session.endSession();}
}

export async function payoutOwnerContext(request) {
  if (request.user?.role === 'promoter') {
    return { ownerType: 'promoter', ownerUserId: request.user._id, ownerPublicId: String(request.user._id), ownerStoreId: null, ownerStorePublicId: '', country: request.user.country, currency: request.user.currency };
  }
  if (request.user?.role === 'delivery') {
    return { ownerType: 'delivery', ownerUserId: request.user._id, ownerPublicId: String(request.user._id), ownerStoreId: null, ownerStorePublicId: '', country: request.user.country, currency: request.user.currency };
  }
  let store = await Store.findOne({ ownerUserId: request.user._id, status: { $ne: 'closed' } });
  let membership = null;
  if (!store) {
    membership = await StoreMember.findOne({ userId: request.user._id, status: 'active', role: { $in: ['owner','admin','finance'] } });
    if (membership) store = await Store.findOne({ _id: membership.storeId, status: { $ne: 'closed' } });
  }
  if (!store) throw new AppError('Seller owner, admin or finance access is required.', 403, 'PAYOUT_OWNER_REQUIRED');
  return { ownerType: 'store', ownerUserId: store.ownerUserId, ownerPublicId: store.publicId, ownerStoreId: store._id, ownerStorePublicId: store.publicId, country: store.country, currency: store.currency, store, membership };
}
function payoutPayableCode(ownerType){return ownerType==='store'?'seller_payable':ownerType==='delivery'?'delivery_payable':'promoter_payable';}
function payoutLedgerOwnerType(account){return account?.ownerType==='seller'?'store':account?.ownerType==='delivery'?'delivery':'promoter';}
async function postPayoutHold(payout, account, ownerType, ownerPublicId, session=null) {
  const payable = await ensureLedgerAccount({code:payoutPayableCode(ownerType),type:'liability',ownerType,ownerPublicId,country:account.country,currency:payout.currency},session);
  const clearing = await ensureLedgerAccount({code:'payout_clearing',type:'liability',ownerType:'platform',ownerPublicId:'classic-mart',country:account.country,currency:payout.currency},session);
  await postLedgerTransaction({idempotencyKey:`payout-hold:${payout.publicId}`,referenceType:'payout',referencePublicId:payout.publicId,currency:payout.currency,description:`Payout reserved for ${payout.publicId}`,entries:[{account:payable,debitMinor:payout.amountMinor,creditMinor:0,memo:'Move payable into payout clearing'},{account:clearing,debitMinor:0,creditMinor:payout.amountMinor,memo:'Pending provider transfer'}]},session);
}
export async function releasePayoutHold(payout, account, reason='Payout rejected', session=null){
  const ownerType=payoutLedgerOwnerType(account);
  const owner=ownerType==='store'?await Store.findOne(payout.ownerStoreId?{_id:payout.ownerStoreId}:{ownerUserId:payout.ownerUserId}).session(session).lean():null;
  const ownerPublicId=ownerType==='store'?(payout.ownerStorePublicId||owner?.publicId):String(payout.ownerUserId);
  const payable=await ensureLedgerAccount({code:payoutPayableCode(ownerType),type:'liability',ownerType,ownerPublicId,country:account.country,currency:payout.currency},session);
  const clearing=await ensureLedgerAccount({code:'payout_clearing',type:'liability',ownerType:'platform',ownerPublicId:'classic-mart',country:account.country,currency:payout.currency},session);
  await postLedgerTransaction({idempotencyKey:`payout-release:${payout.publicId}`,referenceType:'payout',referencePublicId:payout.publicId,currency:payout.currency,description:`Release payout reservation ${payout.publicId}`,entries:[{account:clearing,debitMinor:payout.amountMinor,creditMinor:0,memo:reason},{account:payable,debitMinor:0,creditMinor:payout.amountMinor,memo:'Restore available payable'}]},session);
}
async function completePayout(payout, success, message='') {
  if (!payout || !['submitted','approved'].includes(payout.status)) return;
  const account = await PayoutAccount.findById(payout.payoutAccountId).lean();
  const ownerType = payoutLedgerOwnerType(account);
  const owner = ownerType==='store' ? await Store.findOne(payout.ownerStoreId?{_id:payout.ownerStoreId}:{ownerUserId:payout.ownerUserId}).lean() : null;
  const ownerPublicId = ownerType === 'store' ? (payout.ownerStorePublicId||owner?.publicId) : String(payout.ownerUserId);
  const clearing = await ensureLedgerAccount({code:'payout_clearing',type:'liability',ownerType:'platform',ownerPublicId:'classic-mart',country:account.country,currency:payout.currency});
  if (success) {
    const provider = await ensureLedgerAccount({code:'provider_clearing',type:'asset',ownerType:'provider',ownerPublicId:PROVIDER,country:account.country,currency:payout.currency});
    await postLedgerTransaction({idempotencyKey:`payout-paid:${payout.publicId}`,referenceType:'payout',referencePublicId:payout.publicId,currency:payout.currency,description:`Payout completed ${payout.publicId}`,entries:[{account:clearing,debitMinor:payout.amountMinor,creditMinor:0,memo:'Clear payout liability'},{account:provider,debitMinor:0,creditMinor:payout.amountMinor,memo:'Provider disbursement'}]});
    payout.status='paid';
    if(ownerType==='promoter'){const { settlePromoterCommissions }=await import('./promoters.js');await settlePromoterCommissions(payout.ownerUserId,payout.amountMinor);}
  } else {
    const payable=await ensureLedgerAccount({code:payoutPayableCode(ownerType),type:'liability',ownerType,ownerPublicId,country:account.country,currency:payout.currency});
    await postLedgerTransaction({idempotencyKey:`payout-reverse:${payout.publicId}`,referenceType:'payout',referencePublicId:payout.publicId,currency:payout.currency,description:`Failed payout reversal ${payout.publicId}`,entries:[{account:clearing,debitMinor:payout.amountMinor,creditMinor:0,memo:'Release payout clearing'},{account:payable,debitMinor:0,creditMinor:payout.amountMinor,memo:'Restore payable balance'}]});
    payout.status='failed';payout.failureMessage=message||'Provider reported payout failure.';
  }
  await payout.save();
}
export async function submitPayout(request,payoutPublicId){
  const payout=await Payout.findOne({publicId:payoutPublicId,status:'approved'});if(!payout)throw new AppError('Approved payout not found.',404,'PAYOUT_NOT_FOUND');
  if(payout.approvedByUserId?.equals(request.user._id))throw new AppError('A different finance operator must submit an approved payout.',403,'FOUR_EYES_REQUIRED');
  const account=await PayoutAccount.findOne({_id:payout.payoutAccountId,status:'verified'}).select('+destinationEncrypted');if(account&&request.user.role!=='super_admin'&&account.country!==request.user.country)throw new AppError('Payout is outside your country scope.',403,'COUNTRY_SCOPE');if(!account)throw new AppError('Verified payout destination not found.',409,'PAYOUT_ACCOUNT_REQUIRED');
  let destination;try{destination=JSON.parse(decryptSensitive(account.destinationEncrypted));}catch{throw new AppError('Payout destination is invalid.',422,'PAYOUT_DESTINATION_INVALID');}
  const ownerType=payoutLedgerOwnerType(account);const owner=ownerType==='store'?await Store.findOne(payout.ownerStoreId?{_id:payout.ownerStoreId}:{ownerUserId:payout.ownerUserId}).lean():null;const ownerPublicId=ownerType==='store'?(payout.ownerStorePublicId||owner?.publicId):String(payout.ownerUserId);
  const body={account_bank:String(destination.account_bank||destination.network||''),account_number:String(destination.account_number||destination.phone||''),amount:major(payout.amountMinor,payout.currency),currency:payout.currency,reference:payout.publicId,beneficiary_name:String(destination.beneficiary_name||account.label),callback_url:`${env.baseUrl}/webhooks/flutterwave`,narration:'Classic Mart marketplace payout'};
  if(!body.account_bank||!body.account_number)throw new AppError('Payout destination needs account_bank/network and account_number/phone.',422,'PAYOUT_DESTINATION_INVALID');
  const result=await flutterwave('/v3/transfers',{method:'POST',body});payout.providerReference=String(result.data?.reference||payout.publicId);payout.status='submitted';payout.submittedByUserId=request.user._id;payout.submittedAt=new Date();await payout.save();return payout;
}
export async function savePayoutAccount(request,{method,label,destination}){
  const owner=await payoutOwnerContext(request);
  const docs=await PayoutAccount.create([{publicId:publicId('poa'),ownerUserId:owner.ownerUserId,ownerStoreId:owner.ownerStoreId||undefined,ownerStorePublicId:owner.ownerStorePublicId||'',ownerType:owner.ownerType==='store'?'seller':owner.ownerType,country:owner.country,currency:owner.currency,method,label,destinationEncrypted:encryptSensitive(JSON.stringify(destination)),status:'pending'}]);return docs[0];
}
export async function payoutAccountsForRequest(request){
  const owner=await payoutOwnerContext(request);
  const query=owner.ownerType==='store'?{$or:[{ownerStoreId:owner.ownerStoreId},{ownerUserId:owner.ownerUserId,ownerType:'seller'}]}:{ownerUserId:owner.ownerUserId,ownerType:owner.ownerType};
  return PayoutAccount.find(mongoose.trusted(query)).select('-destinationEncrypted').sort({createdAt:-1}).lean();
}
export async function payoutsForRequest(request){
  const owner=await payoutOwnerContext(request);
  let query;
  if(owner.ownerType==='store') query={$or:[{ownerStoreId:owner.ownerStoreId},{ownerUserId:owner.ownerUserId,ownerStoreId:null}]};
  else {const accountIds=await PayoutAccount.find({ownerUserId:owner.ownerUserId,ownerType:owner.ownerType}).distinct('_id');query={payoutAccountId:{$in:accountIds}};}
  return Payout.find(mongoose.trusted(query)).sort({createdAt:-1}).limit(100).lean();
}
export async function requestPayout(request,{payoutAccountId,amountMinor,idempotencyKey}){
  const owner=await payoutOwnerContext(request);
  const existing=await Payout.findOne({idempotencyKey,requestedByUserId:request.user._id});if(existing)return existing;
  const accountQuery=owner.ownerType==='store'?{publicId:payoutAccountId,status:'verified',$or:[{ownerStoreId:owner.ownerStoreId},{ownerUserId:owner.ownerUserId,ownerType:'seller'}]}:{publicId:payoutAccountId,ownerUserId:owner.ownerUserId,ownerType:owner.ownerType,status:'verified'};
  const account=await PayoutAccount.findOne(mongoose.trusted(accountQuery));if(!account)throw new AppError('Verified payout account required.',409,'PAYOUT_ACCOUNT_REQUIRED');
  const session=await mongoose.startSession();let payout;
  try{await session.withTransaction(async()=>{
    const ledger=await ensureLedgerAccount({code:payoutPayableCode(owner.ownerType),type:'liability',ownerType:owner.ownerType,ownerPublicId:owner.ownerPublicId,country:owner.country,currency:owner.currency},session);
    await LedgerAccount.findOneAndUpdate({_id:ledger._id},{$inc:{mutationVersion:1}},{session,returnDocument:'after'});
    const available=await accountBalanceMinor(ledger._id,session);if(amountMinor>available)throw new AppError('Payout amount exceeds available balance.',409,'PAYOUT_BALANCE');
    const docs=await Payout.create([{publicId:publicId('pyo'),idempotencyKey,ownerUserId:owner.ownerUserId,ownerStoreId:owner.ownerStoreId||undefined,ownerStorePublicId:owner.ownerStorePublicId||'',requestedByUserId:request.user._id,payoutAccountId:account._id,amountMinor,currency:owner.currency,status:'requested'}],{session});payout=docs[0];
    await postPayoutHold(payout,account,owner.ownerType,owner.ownerPublicId,session);
  });}finally{await session.endSession();}
  return payout;
}



export async function reconcilePayments(request,{hours=24}={}){
  const country=request.user?.role==='super_admin'?null:request.user?.country;
  const since=new Date(Date.now()-Math.min(Math.max(Number(hours)||24,1),168)*60*60*1000);
  const run=await ReconciliationRun.create({publicId:publicId('rec'),country:country||'GLOBAL',provider:PROVIDER,startedByUserId:request.user._id,status:'running',startedAt:new Date()});
  const query={provider:PROVIDER,status:{$in:['created','requires_action','pending','failed']},createdAt:{$gte:since}};
  if(country){const orderIds=await Order.find({country}).distinct('_id');query.orderId={$in:orderIds};}
  const intents=await PaymentIntent.find(mongoose.trusted(query)).limit(500);
  const errors=[];let matched=0,updated=0,failed=0;
  for(const intent of intents){
    run.checked+=1;
    try{
      let transactionId=intent.providerTransactionId;
      if(!transactionId&&intent.providerReference){
        const data=await verifyFlutterwaveByReference(intent.providerReference);
        if(data?.id) transactionId=String(data.id);
      }
      if(!transactionId){errors.push(`${intent.publicId}: provider transaction not found`);continue;}
      const before=intent.status;
      const verified=await verifyAndApplyPayment(intent.publicId,transactionId);
      matched+=1;if(verified.status!==before)updated+=1;
    }catch(error){failed+=1;errors.push(`${intent.publicId}: ${error.message}`);}
  }
  run.matched=matched;run.updated=updated;run.failed=failed;run.errorMessages=errors.slice(0,100);run.status=failed&&failed===run.checked?'failed':'completed';run.completedAt=new Date();await run.save();return run;
}

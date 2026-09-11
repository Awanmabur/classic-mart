import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { currentTraceFields, runWithStoredTrace } from '../core/trace.js';
import { encryptSensitive, decryptSensitive } from '../core/sensitive.js';
import {
  BusinessInvoice, Chargeback, InventoryMovement, InventoryReservation, Order, PaymentIntent, ProviderEvent, PurchaseOrder, Refund, StockItem,
  LedgerAccount, LedgerTransaction, PayoutAccount, Payout, ReconciliationRun, SellerOrder, Shipment, Store,
} from '../models/index.js';
import { ensureLedgerAccount, postLedgerTransaction, accountBalanceMinor, sellerSettlementBreakdown, proportionalSettlementSlice } from './money.js';
import { orderAccessQuery } from './order-access.js';
import { refreshOrderLifecycle, syncLegacyOrderStatus } from './order-state.js';
import { getPesapalTransactionStatus, requestPesapalRefund, submitPesapalOrder } from './pesapal.js';
import { cursorScope, cursorSort, pageResult } from './pagination.js';
import { sellerStoreAccesses } from './store.js';

export const PAYMENT_PROVIDER = 'pesapal';
const factors = { UGX: 1, RWF: 1, JPY: 1, KRW: 1 };
const factor = currency => factors[String(currency || '').toUpperCase()] || 100;
const major = (minor, currency) => minor / factor(currency);
const minor = (amount, currency) => Math.round(Number(amount || 0) * factor(currency));
const terminalIntentStatuses = new Set(['succeeded','failed','cancelled','refunded','partially_refunded','reversed']);

function traceForOrder(order) {
  const current = currentTraceFields();
  return { traceId: order?.traceId || current.traceId, traceSpanId: order?.traceSpanId || current.traceSpanId };
}

function userCountryScopes(user) {
  if (!user) return [];
  if (user.role === 'super_admin') return ['*'];
  const grants = Array.isArray(user.operationalCountries) ? user.operationalCountries : [];
  return [...new Set([...grants, user.country].filter(Boolean).map(v => String(v).toUpperCase()))];
}
function assertFinanceCountry(request, country) {
  const scopes = userCountryScopes(request.user);
  if (!scopes.includes('*') && !scopes.includes(String(country || '').toUpperCase())) throw new AppError('Resource is outside your operational country scope.',403,'COUNTRY_SCOPE');
}
function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return { firstName: parts.shift() || 'Customer', lastName: parts.join(' ') || 'Customer' };
}
function paymentView(intent) {
  return {
    id:intent.publicId,orderId:intent.orderPublicId,traceId:intent.traceId||'',provider:intent.provider,purpose:intent.purpose,method:intent.method,status:intent.status,
    amountMinor:intent.amountMinor,currency:intent.currency,checkoutUrl:intent.checkoutUrl||null,
    providerReference:intent.providerReference||null,providerTrackingId:intent.providerTrackingId||null,
    paidAt:intent.paidAt||null,lastVerifiedAt:intent.lastVerifiedAt||null,
  };
}
export { paymentView };

export async function getPaymentIntentForOrder(request,orderId){
  const order=await Order.findOne(mongoose.trusted(orderAccessQuery(request,orderId))).lean();
  if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');
  const intent=await PaymentIntent.findOne({orderId:order._id}).sort({createdAt:-1}).lean();
  return {order,intent};
}

async function createOnlineIntent(order,idempotencyKey){
  const existing=await PaymentIntent.findOne({orderId:order._id,idempotencyKey});
  if(existing)return existing;
  const active=await PaymentIntent.findOne({activeKey:order.publicId});
  if(active)return active;
  const intentPublicId=publicId('pay');
  try{
    const docs=await PaymentIntent.create([{
      publicId:intentPublicId,...traceForOrder(order),orderId:order._id,orderPublicId:order.publicId,country:order.country,idempotencyKey,provider:PAYMENT_PROVIDER,
      purpose:order.businessInvoiceId?'business_invoice':'order_payment',method:order.paymentMethod==='credit_terms'?'pesapal':order.paymentMethod,status:'created',amountMinor:order.totals.totalMinor,currency:order.totals.currency,
      providerReference:intentPublicId,activeKey:order.publicId,
    }]);
    return docs[0];
  }catch(error){
    if(error?.code===11000){
      const raced=await PaymentIntent.findOne({$or:[{orderId:order._id,idempotencyKey},{activeKey:order.publicId}]});
      if(raced)return raced;
    }
    throw error;
  }
}

export async function initiatePayment(request,{orderId,idempotencyKey}){
  const order=await Order.findOne(mongoose.trusted(orderAccessQuery(request,orderId,{requiredLevel:'mutate'})));
  if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');
  const creditInvoicePayable=order.paymentMethod==='credit_terms'&&order.paymentState==='credit_due';
  if(!['unpaid','pending','failed'].includes(order.paymentState)&&!creditInvoicePayable)throw new AppError('This order cannot start another payment.',409,'ORDER_PAYMENT_STATE');
  if(!creditInvoicePayable&&order.reservationExpiresAt<=new Date())throw new AppError('The stock reservation expired. Create the order again.',409,'RESERVATION_EXPIRED');
  const prior=await PaymentIntent.findOne({orderId:order._id,idempotencyKey});if(prior)return paymentView(prior);

  if(order.paymentMethod==='cod'){
    let intent;
    try{
      [intent]=await PaymentIntent.create([{
        publicId:publicId('pay'),...traceForOrder(order),orderId:order._id,orderPublicId:order.publicId,country:order.country,idempotencyKey,provider:'cod',method:'cod',
        status:'pending_collection',amountMinor:order.totals.totalMinor,currency:order.totals.currency,providerReference:`cod:${order.publicId}`,activeKey:order.publicId,
      }]);
    }catch(error){if(error?.code===11000){intent=await PaymentIntent.findOne({$or:[{orderId:order._id,idempotencyKey},{activeKey:order.publicId}]});}else throw error;}
    await commitOrderInventoryAndMoney(order,intent,{cod:true});
    const { ensureShipmentForOrder }=await import('./logistics.js');
    await ensureShipmentForOrder(await Order.findById(order._id),order.userId||null);
    return paymentView(await PaymentIntent.findById(intent._id));
  }

  const intent=await createOnlineIntent(order,idempotencyKey);
  if(intent.checkoutUrl && ['requires_action','pending'].includes(intent.status))return paymentView(intent);
  if(intent.status==='succeeded')return paymentView(intent);

  const names=splitName(order.contact.fullName);
  try{
    const payload=await runWithStoredTrace({traceId:intent.traceId,spanId:intent.traceSpanId},()=>submitPesapalOrder({
      id:intent.providerReference,
      currency:intent.currency,
      amount:major(intent.amountMinor,intent.currency),
      description:`Classic Mart ${order.businessInvoicePublicId?`business invoice ${order.businessInvoicePublicId}`:`order ${order.publicId}`}`.slice(0,100),
      callback_url:`${env.baseUrl}/payments/return`,
      billing_address:{
        email_address:order.contact.email,
        phone_number:order.contact.phone,
        country_code:order.country,
        first_name:names.firstName,
        last_name:names.lastName,
        line_1:order.contact.address,
        line_2:'',
        city:order.contact.city,
        state:'',
        postal_code:'',
        zip_code:'',
      },
    }));
    if(!payload?.redirect_url||!payload?.order_tracking_id)throw new AppError('Pesapal did not return a checkout URL and tracking ID.',502,'PESAPAL_ORDER_INVALID');
    intent.checkoutUrl=String(payload.redirect_url);
    intent.providerTrackingId=String(payload.order_tracking_id);
    intent.providerTransactionId=intent.providerTrackingId;
    intent.status='requires_action';intent.failureCode='';intent.failureMessage='';
    await intent.save();
    return paymentView(intent);
  }catch(error){
    intent.status='failed';intent.failureCode=String(error.code||'PESAPAL_SUBMIT_FAILED').slice(0,80);intent.failureMessage=String(error.message||'Pesapal checkout failed.').slice(0,400);intent.activeKey=undefined;
    await intent.save();throw error;
  }
}

async function commitOrderInventoryAndMoney(orderLike,intentLike,{cod=false,providerTrackingId='',providerConfirmationCode='',providerPaymentMethod=''}={}){
  const session=await mongoose.startSession();
  try{await session.withTransaction(async()=>{
    const order=await Order.findById(orderLike._id).session(session);
    const intent=await PaymentIntent.findById(intentLike._id).session(session);
    if(!order||!intent)return;
    if(intent.purpose==='business_invoice'&&order.paymentMethod==='credit_terms'&&order.paymentState==='credit_due'){
      const invoice=order.businessInvoiceId?await BusinessInvoice.findById(order.businessInvoiceId).session(session):null;
      if(!invoice||!['open','overdue'].includes(invoice.status))throw new AppError('Business credit invoice is not payable.',409,'BUSINESS_INVOICE_NOT_PAYABLE');
      const clearing=await ensureLedgerAccount({code:'provider_clearing',type:'asset',ownerType:'provider',ownerPublicId:PAYMENT_PROVIDER,country:order.country,currency:order.totals.currency},session);
      const receivable=await ensureLedgerAccount({code:'business_accounts_receivable',type:'asset',ownerType:'business',ownerId:order.businessOrganizationId,ownerPublicId:String(order.businessOrganizationId),country:order.country,currency:order.totals.currency},session);
      await postLedgerTransaction({idempotencyKey:`business-invoice-payment:${intent.publicId}`,referenceType:'business_invoice_payment',referencePublicId:invoice.publicId,currency:order.totals.currency,country:order.country,description:`Pesapal payment for business invoice ${invoice.invoiceNumber}`,entries:[{account:clearing,debitMinor:intent.amountMinor,creditMinor:0,memo:'Verified Pesapal business invoice payment'},{account:receivable,debitMinor:0,creditMinor:intent.amountMinor,memo:'Clear business accounts receivable'}]},session);
      intent.status='succeeded';intent.paidAt=intent.paidAt||new Date();intent.activeKey=undefined;intent.providerTrackingId=providerTrackingId||intent.providerTrackingId;intent.providerTransactionId=intent.providerTrackingId||intent.providerTransactionId;intent.providerConfirmationCode=providerConfirmationCode||intent.providerConfirmationCode;intent.providerPaymentMethod=providerPaymentMethod||intent.providerPaymentMethod;
      invoice.status='paid';invoice.paidMinor=invoice.totalMinor;invoice.paidAt=intent.paidAt;invoice.paymentIntentPublicId=intent.publicId;invoice.timeline.push({type:'paid',message:'Business credit invoice paid through verified Pesapal transaction.'});
      order.paymentState='paid';syncLegacyOrderStatus(order);order.timeline.push({type:'business_invoice.paid',message:`Business invoice ${invoice.invoiceNumber} paid through Pesapal.`});
      const { issuePaymentReceipt }=await import('./financial-documents.js');await issuePaymentReceipt(order,intent,session);
      await invoice.save({session});await order.save({session});await intent.save({session});return;
    }
    if(['paid','confirmed'].includes(order.status)){
      if(!cod&&intent.status!=='succeeded'){
        intent.status='succeeded';intent.paidAt=intent.paidAt||new Date();intent.activeKey=undefined;
        intent.providerTrackingId=providerTrackingId||intent.providerTrackingId;intent.providerTransactionId=intent.providerTrackingId||intent.providerTransactionId;
        intent.providerConfirmationCode=providerConfirmationCode||intent.providerConfirmationCode;intent.providerPaymentMethod=providerPaymentMethod||intent.providerPaymentMethod;
        await intent.save({session});
      }
      return;
    }
    for(const item of order.items){
      const reservation=await InventoryReservation.findOne({publicId:item.reservationPublicId,status:'active'}).session(session);
      if(!reservation)throw new AppError('Order stock reservation is no longer active.',409,'RESERVATION_INACTIVE');
      const stock=await StockItem.findOneAndUpdate(
        mongoose.trusted({_id:reservation.stockItemId,onHand:{$gte:reservation.quantity},reserved:{$gte:reservation.quantity}}),
        {$inc:{onHand:-reservation.quantity,reserved:-reservation.quantity}},{returnDocument:'after',session},
      );
      if(!stock)throw new AppError('Reserved stock is inconsistent.',409,'STOCK_CONFLICT');
      reservation.status='committed';reservation.committedAt=new Date();await reservation.save({session});
      await InventoryMovement.create([{publicId:publicId('mov'),storeId:reservation.storeId,stockItemId:stock._id,variantId:stock.variantId,warehouseId:stock.warehouseId,type:'sale',quantity:-reservation.quantity,onHandBefore:stock.onHand+reservation.quantity,onHandAfter:stock.onHand,reservedBefore:stock.reserved+reservation.quantity,reservedAfter:stock.reserved,reason:cod?'COD order confirmed':'Pesapal verified payment sale',reference:order.publicId,actorUserId:reservation.actorUserId}],{session});
    }
    if(cod){
      order.paymentState='pending';syncLegacyOrderStatus(order);order.timeline.push({type:'payment.cod_pending',message:'Cash on delivery selected. Payment will be collected during fulfilment.'});
    }else{
      order.paymentState='paid';syncLegacyOrderStatus(order);order.timeline.push({type:'payment.verified',message:'Payment independently verified with Pesapal.'});
      const clearing=await ensureLedgerAccount({code:'provider_clearing',type:'asset',ownerType:'provider',ownerPublicId:PAYMENT_PROVIDER,country:order.country,currency:order.totals.currency},session);
      const entries=[{account:clearing,debitMinor:order.totals.totalMinor,creditMinor:0,memo:'Verified Pesapal customer payment'}];
      const sellerOrders=await SellerOrder.find({orderId:order._id}).session(session).lean();
      let platformFeeTotal=0;
      for(const sellerOrder of sellerOrders){
        const settlement=sellerSettlementBreakdown(sellerOrder);platformFeeTotal+=settlement.platformFeeMinor;
        const store=await Store.findOne({publicId:sellerOrder.storePublicId}).session(session);
        const payable=await ensureLedgerAccount({code:'seller_payable',type:'liability',ownerType:'store',ownerId:store?._id,ownerPublicId:sellerOrder.storePublicId,country:order.country,currency:order.totals.currency},session);
        if(settlement.sellerPayableMinor>0)entries.push({account:payable,debitMinor:0,creditMinor:settlement.sellerPayableMinor,memo:`Seller payable net of discount and marketplace fee for ${order.publicId}`});
      }
      const platformRevenueMinor=platformFeeTotal+Number(order.totals.shippingMinor||0);
      if(platformRevenueMinor>0){const revenue=await ensureLedgerAccount({code:'platform_revenue',type:'revenue',ownerType:'platform',ownerPublicId:'classic-mart',country:order.country,currency:order.totals.currency},session);entries.push({account:revenue,debitMinor:0,creditMinor:platformRevenueMinor,memo:'Marketplace fees and delivery revenue'});}
      if(order.totals.taxMinor>0){const tax=await ensureLedgerAccount({code:'tax_payable',type:'liability',ownerType:'platform',ownerPublicId:'classic-mart',country:order.country,currency:order.totals.currency},session);entries.push({account:tax,debitMinor:0,creditMinor:order.totals.taxMinor,memo:'Collected marketplace tax liability'});}
      await postLedgerTransaction({idempotencyKey:`payment:${intent.publicId}`,referenceType:'payment',referencePublicId:intent.publicId,currency:order.totals.currency,country:order.country,description:`Pesapal payment for ${order.publicId}`,entries},session);
      const { makeOrderCommissionsPayable }=await import('./promoters.js');await makeOrderCommissionsPayable(order,session);
      const { applyGrowthForPaidOrder }=await import('./stage9.js');await applyGrowthForPaidOrder(order,session);
      if(order.businessInvoiceId){
        const invoice=await BusinessInvoice.findById(order.businessInvoiceId).session(session);if(invoice){invoice.status='paid';invoice.paidMinor=invoice.totalMinor;invoice.paidAt=new Date();invoice.paymentIntentPublicId=intent.publicId;invoice.timeline.push({type:'paid',message:'Immediate business invoice paid through verified Pesapal transaction.'});await invoice.save({session});}
        if(order.purchaseOrderId)await PurchaseOrder.updateOne({_id:order.purchaseOrderId,status:'payment_pending'},{$set:{status:'processing'},$push:{timeline:{type:'payment.verified',message:'Immediate Pesapal payment verified; purchase order released to fulfilment.'}}},{session});
      }
      intent.status='succeeded';intent.paidAt=intent.paidAt||new Date();intent.activeKey=undefined;
      intent.providerTrackingId=providerTrackingId||intent.providerTrackingId;intent.providerTransactionId=intent.providerTrackingId||intent.providerTransactionId;
      intent.providerConfirmationCode=providerConfirmationCode||intent.providerConfirmationCode;intent.providerPaymentMethod=providerPaymentMethod||intent.providerPaymentMethod;
      const { issuePaymentReceipt }=await import('./financial-documents.js');await issuePaymentReceipt(order,intent,session);
    }
    await SellerOrder.updateMany({orderId:order._id,status:'pending_payment'},{$set:{status:'confirmed'},$push:{timeline:{type:cod?'payment.cod_pending':'payment.verified',message:cod?'COD order confirmed for fulfilment.':'Pesapal payment verified.'}}},{session});
    await order.save({session});await intent.save({session});
  });}finally{await session.endSession();}
}

function normalizePesapalStatus(payload){return String(payload?.payment_status_description||payload?.status_description||'').trim().toUpperCase();}
export async function verifyAndApplyPayment(intentPublicId,orderTrackingId){
  const intent=await PaymentIntent.findOne({publicId:intentPublicId});
  if(!intent)throw new AppError('Payment intent not found.',404,'PAYMENT_NOT_FOUND');
  if(intent.provider!==PAYMENT_PROVIDER)return paymentView(intent);
  return runWithStoredTrace({traceId:intent.traceId,spanId:intent.traceSpanId},async()=>{
  const tracking=String(orderTrackingId||intent.providerTrackingId||'').trim();
  if(!tracking)throw new AppError('Pesapal tracking ID is missing.',409,'PESAPAL_TRACKING_ID_REQUIRED');
  const data=await getPesapalTransactionStatus(tracking);
  const status=normalizePesapalStatus(data);intent.lastVerifiedAt=new Date();intent.providerStatus=status;intent.providerTrackingId=tracking;intent.providerTransactionId=tracking;
  if(data?.confirmation_code)intent.providerConfirmationCode=String(data.confirmation_code);
  if(data?.payment_method)intent.providerPaymentMethod=String(data.payment_method);
  const amountMatches=minor(data?.amount,intent.currency)===intent.amountMinor;
  const currencyMatches=String(data?.currency||'').toUpperCase()===intent.currency;
  const referenceMatches=String(data?.merchant_reference||'')===intent.providerReference;
  const order=await Order.findById(intent.orderId);
  if(!order)throw new AppError('Payment order not found.',404,'ORDER_NOT_FOUND');

  if(status==='COMPLETED'){
    if(!amountMatches||!currencyMatches||!referenceMatches){intent.status='failed';intent.activeKey=undefined;intent.failureCode='VERIFICATION_MISMATCH';intent.failureMessage='Pesapal amount, currency or merchant reference did not match the payment intent.';await intent.save();if(['unpaid','pending'].includes(order.paymentState)){order.paymentState='failed';syncLegacyOrderStatus(order);order.timeline.push({type:'payment.failed',message:'Pesapal verification did not match the order.'});await order.save();}return paymentView(intent);}
    await intent.save();
    await commitOrderInventoryAndMoney(order,intent,{providerTrackingId:tracking,providerConfirmationCode:data.confirmation_code||'',providerPaymentMethod:data.payment_method||''});
    const { ensureShipmentForOrder }=await import('./logistics.js');await ensureShipmentForOrder(await Order.findById(order._id),order.userId||null);
    return paymentView(await PaymentIntent.findById(intent._id));
  }
  if(status==='FAILED'||status==='INVALID'){
    intent.status='failed';intent.activeKey=undefined;intent.failureCode=`PESAPAL_${status}`;intent.failureMessage=String(data?.description||data?.message||`Pesapal reported ${status}.`).slice(0,400);await intent.save();
    if(['unpaid','pending'].includes(order.paymentState)){order.paymentState='failed';syncLegacyOrderStatus(order);order.timeline.push({type:'payment.failed',message:`Pesapal reported ${status.toLowerCase()}.`});await order.save();}
    return paymentView(intent);
  }
  if(status==='REVERSED'){
    intent.status='reversed';intent.activeKey=undefined;intent.reversedAt=intent.reversedAt||new Date();await intent.save();
    const { recordProviderChargeback }=await import('./chargebacks.js');
    await recordProviderChargeback({order,intent,providerPayload:data});
    return paymentView(await PaymentIntent.findById(intent._id));
  }
  intent.status='pending';await intent.save();return paymentView(intent);
  });
}

function notificationFields(body,query={}){
  const value=(name)=>body?.[name]??query?.[name]??body?.[name.toLowerCase()]??query?.[name.toLowerCase()]??'';
  return {
    notificationType:String(value('OrderNotificationType')||'IPNCHANGE').slice(0,120),
    trackingId:String(value('OrderTrackingId')).trim().slice(0,180),
    merchantReference:String(value('OrderMerchantReference')).trim().slice(0,100),
  };
}
export async function processPesapalNotification(rawBody,body={},query={}){
  const fields=notificationFields(body,query);
  if(!fields.trackingId||!fields.merchantReference)throw new AppError('Pesapal notification is missing tracking/reference identifiers.',422,'PESAPAL_NOTIFICATION_INVALID');
  const raw=String(rawBody||JSON.stringify({...query,...body}));const rawHash=crypto.createHash('sha256').update(raw).digest('hex');
  const eventId=crypto.createHash('sha256').update(`${fields.notificationType}:${fields.trackingId}:${fields.merchantReference}`).digest('hex');
  const linkedIntent=await PaymentIntent.findOne({provider:PAYMENT_PROVIDER,providerReference:fields.merchantReference}).select('_id publicId orderId orderPublicId traceId traceSpanId').lean();
  const linkedOrder=linkedIntent?.orderId?await Order.findById(linkedIntent.orderId).select('publicId country').lean():null;
  let event;
  try{event=await ProviderEvent.create({publicId:publicId('evt'),traceId:linkedIntent?.traceId||currentTraceFields().traceId,traceSpanId:linkedIntent?.traceSpanId||currentTraceFields().traceSpanId,provider:PAYMENT_PROVIDER,eventId,eventType:fields.notificationType,merchantReference:fields.merchantReference,providerTrackingId:fields.trackingId,paymentIntentPublicId:linkedIntent?.publicId||'',orderPublicId:linkedOrder?.publicId||linkedIntent?.orderPublicId||'',country:linkedOrder?.country||'',rawHash,rawEncrypted:encryptSensitive(raw),verifiedAt:new Date(),status:'received',nextAttemptAt:new Date()});}
  catch(error){if(error?.code===11000)return {duplicate:true};throw error;}
  try{await processPesapalEvent(event.publicId);return {duplicate:false};}catch{return {duplicate:false,deferred:true};}
}

export async function processPesapalEvent(eventPublicId){
  const event=await ProviderEvent.findOne({publicId:eventPublicId,provider:PAYMENT_PROVIDER});if(!event)return null;
  return runWithStoredTrace({traceId:event.traceId,spanId:event.traceSpanId},async()=>{
  const intent=await PaymentIntent.findOne({provider:PAYMENT_PROVIDER,providerReference:event.merchantReference});
  if(!intent){event.status='ignored';event.error='No matching Classic Mart payment intent.';event.processedAt=new Date();event.lockedBy='';event.lockedUntil=null;await event.save();return event;}
  if(!event.paymentIntentPublicId||!event.orderPublicId||!event.country){
    const linkedOrder=await Order.findById(intent.orderId).select('publicId country').lean();
    event.paymentIntentPublicId=intent.publicId;event.orderPublicId=linkedOrder?.publicId||intent.orderPublicId||'';event.country=linkedOrder?.country||event.country||'';
  }
  if(intent.providerTrackingId&&intent.providerTrackingId!==event.providerTrackingId){event.status='failed';event.error='Pesapal tracking ID does not match the payment intent.';event.processedAt=new Date();event.lockedBy='';event.lockedUntil=null;await event.save();throw new AppError('Pesapal tracking ID mismatch.',409,'PESAPAL_TRACKING_MISMATCH');}
  try{await verifyAndApplyPayment(intent.publicId,event.providerTrackingId);event.status='processed';event.error='';event.processedAt=new Date();event.lockedBy='';event.lockedUntil=null;await event.save();return event;}
  catch(error){event.status=event.attempts>=9?'dead':'failed';event.error=String(error.message||'Pesapal event processing failed.').slice(0,500);event.nextAttemptAt=new Date(Date.now()+Math.min(60*60_000,2**Math.min(event.attempts,10)*30_000));event.lockedBy='';event.lockedUntil=null;await event.save();throw error;}
  });
}

export async function processPesapalEvents({limit=20,workerId=`worker:${process.pid}`}={}){
  let processed=0;const now=new Date();
  for(let i=0;i<Math.max(1,Math.min(100,limit));i++){
    const event=await ProviderEvent.findOneAndUpdate({provider:PAYMENT_PROVIDER,status:{$in:['received','failed','processing']},nextAttemptAt:{$lte:now},$or:[{lockedUntil:null},{lockedUntil:{$exists:false}},{lockedUntil:{$lt:now}}]},{$set:{status:'processing',lockedBy:workerId,lockedUntil:new Date(Date.now()+60_000)},$inc:{attempts:1}},{sort:{createdAt:1},returnDocument:'after'});
    if(!event)break;try{await processPesapalEvent(event.publicId);processed++;}catch{}
  }
  return processed;
}


export async function requeueProviderEvent(request,eventPublicId,{reason}){
  const event=await ProviderEvent.findOne({publicId:eventPublicId,provider:PAYMENT_PROVIDER});
  if(!event)throw new AppError('Provider event not found.',404,'PROVIDER_EVENT_NOT_FOUND');
  if(!['failed','dead','ignored'].includes(event.status))throw new AppError('Only failed, dead-letter or ignored provider events can be replayed.',409,'PROVIDER_EVENT_STATE');
  if(event.lockedUntil&&event.lockedUntil>new Date())throw new AppError('Provider event is currently being processed.',409,'PROVIDER_EVENT_LOCKED');
  let country=event.country;
  if(!country&&event.merchantReference){
    const intent=await PaymentIntent.findOne({provider:PAYMENT_PROVIDER,providerReference:event.merchantReference}).select('publicId orderId orderPublicId').lean();
    const order=intent?.orderId?await Order.findById(intent.orderId).select('publicId country').lean():null;
    if(intent)event.paymentIntentPublicId=intent.publicId;
    if(order){event.orderPublicId=order.publicId;event.country=order.country;country=order.country;}
  }
  if(!country&&request.user?.role!=='super_admin')throw new AppError('Unmatched provider events can only be replayed by Super Admin because no country scope can be proven.',403,'PROVIDER_EVENT_SCOPE_UNKNOWN');
  if(country)assertFinanceCountry(request,country);
  event.status='received';event.attempts=0;event.nextAttemptAt=new Date();event.lockedBy='';event.lockedUntil=null;event.processedAt=null;event.error='';
  event.manualReplayCount=Number(event.manualReplayCount||0)+1;event.lastManualReplayAt=new Date();event.lastManualReplayByUserId=request.user?._id;event.manualReplayReason=String(reason||'').trim().slice(0,300);
  await event.save();return event;
}

async function refundCounterTotals(paymentIntentId,session){
  const rows=await Refund.aggregate([
    {$match:{paymentIntentId,status:{$in:['pending','processing','completed']}}},
    {$group:{_id:'$status',total:{$sum:'$amountMinor'}}},
  ]).session(session);
  let reserved=0,completed=0;
  for(const row of rows){if(row._id==='completed')completed+=Number(row.total||0);else reserved+=Number(row.total||0);}
  return {reserved,completed};
}

async function assertRefundCounterConsistency(intent,session){
  const actual=await refundCounterTotals(intent._id,session),reserved=Number(intent.refundReservedMinor||0),completed=Number(intent.refundedMinor||0),captured=Number(intent.amountMinor||0);
  if(actual.reserved!==reserved||actual.completed!==completed||reserved<0||completed<0||reserved+completed>captured){
    throw new AppError('Refund reservation counters are not synchronized with refund history. Run the production migration/reconciliation before issuing another refund.',409,'REFUND_COUNTER_RECONCILIATION_REQUIRED');
  }
  return {reserved,completed,captured};
}

async function syncRefundStateAfterReservationRelease(order,intent,session){
  const active=await Refund.find({orderId:order._id,status:{$in:['pending','processing']}}).select('status').session(session).lean();
  const completed=Number(intent.refundedMinor||0),captured=Number(intent.amountMinor||0);
  if(captured>0&&completed>=captured)order.refundState='complete';
  else if(completed>0)order.refundState='partial';
  else if(active.some(row=>row.status==='pending'))order.refundState='pending';
  else if(active.length)order.refundState='processing';
  else order.refundState='none';
  syncLegacyOrderStatus(order);
  await order.save({session});
}

async function failRefundAndReleaseReservation(refundId,{providerStatus='REJECTED',providerMessage='',failureMessage='' }={}){
  const session=await mongoose.startSession();let failed;
  try{await session.withTransaction(async()=>{
    const refund=await Refund.findById(refundId).session(session);if(!refund)throw new AppError('Refund not found.',404,'REFUND_NOT_FOUND');
    if(refund.status==='failed'||refund.status==='cancelled'){failed=refund;return;}
    if(refund.status==='completed')throw new AppError('Completed refund reservation cannot be released.',409,'REFUND_ALREADY_COMPLETED');
    const intent=await PaymentIntent.findOneAndUpdate({_id:refund.paymentIntentId,refundReservedMinor:{$gte:refund.amountMinor}},{$inc:{refundReservedMinor:-refund.amountMinor}},{session,returnDocument:'after'});
    if(!intent)throw new AppError('Refund reservation counter is inconsistent; manual reconciliation is required.',409,'REFUND_COUNTER_CONFLICT');
    refund.status='failed';refund.providerStatus=String(providerStatus||'REJECTED').slice(0,120);refund.providerMessage=String(providerMessage||'').slice(0,400);refund.failureMessage=String(failureMessage||providerMessage||'Refund failed.').slice(0,400);await refund.save({session});
    const order=await Order.findById(refund.orderId).session(session);if(order)await syncRefundStateAfterReservationRelease(order,intent,session);
    failed=refund;
  });return failed;}finally{await session.endSession();}
}

async function reserveRefund(request,{orderId,amountMinor,reason,idempotencyKey,allocations=[]}){
  const existing=await Refund.findOne({idempotencyKey});if(existing)return {refund:existing,existing:true};
  const session=await mongoose.startSession();let result;
  try{await session.withTransaction(async()=>{
    const order=await Order.findOne({publicId:orderId}).session(session);if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');
    const financeActor=['finance','country_admin','super_admin'].includes(request.user?.role);
    const ownedByUser=Boolean(request.user?._id&&order.userId&&order.userId.equals(request.user._id));const ownedByGuest=Boolean(!request.user?._id&&request.session?.cartKey&&order.sessionKey===request.session.cartKey);
    if(financeActor)assertFinanceCountry(request,order.country);else if(!ownedByUser&&!ownedByGuest)throw new AppError('You cannot refund this order.',403,'ORDER_SCOPE');
    if(!['paid','partially_refunded','refunded'].includes(order.paymentState))throw new AppError('Only a verified paid order can be refunded.',409,'REFUND_ORDER_STATE');
    const intent=await PaymentIntent.findOne({orderId:order._id,status:{$in:['succeeded','partially_refunded','refunded','reversed']}}).sort({paidAt:-1}).session(session);
    if(!intent)throw new AppError('Verified payment record not found.',409,'REFUND_PAYMENT_MISSING');
    if(intent.provider===PAYMENT_PROVIDER&&!intent.providerConfirmationCode)throw new AppError('Pesapal confirmation code is missing; reconcile the payment before refunding.',409,'PESAPAL_CONFIRMATION_REQUIRED');
    if(await Chargeback.exists({paymentIntentId:intent._id,status:{$in:['open','reviewing','lost']}}).session(session))throw new AppError('This payment has an open or lost chargeback and cannot be refunded.',409,'REFUND_CHARGEBACK_BLOCKED');
    const counters=await assertRefundCounterConsistency(intent,session);
    const reservedRefundMinor=counters.reserved,refundedMinor=counters.completed,capturedMinor=counters.captured;
    const available=Math.max(0,capturedMinor-reservedRefundMinor-refundedMinor),amount=Math.min(Number(amountMinor||available),available);if(!Number.isSafeInteger(amount)||amount<=0)throw new AppError('Nothing remains refundable.',409,'REFUND_EXHAUSTED');
    if((!Array.isArray(allocations)||!allocations.length)&&(reservedRefundMinor>0||refundedMinor>0||amount<capturedMinor))throw new AppError('Partial or follow-up refunds require explicit immutable order-line allocations.',422,'PARTIAL_REFUND_ALLOCATION_REQUIRED');
    const cleanAllocations=[];let allocationTotal=0;
    const requestedAllocations=Array.isArray(allocations)?allocations:[];
    if(requestedAllocations.length){
      const sellerOrders=await SellerOrder.find({orderId:order._id}).session(session).lean();
      const sellerLineById=new Map();
      for(const sellerOrder of sellerOrders){
        for(const line of sellerOrder.items||[]){
          const key=`${sellerOrder.storePublicId}:${String(line.orderLineId||'')}`;
          if(line.orderLineId)sellerLineById.set(key,line);
        }
      }
      const priorRefunds=await Refund.find({orderId:order._id,status:{$in:['pending','processing','completed']},'allocations.0':{$exists:true}}).select('allocations').session(session).lean();
      const priorByLine=new Map();
      for(const prior of priorRefunds){for(const allocation of prior.allocations||[]){const key=`${allocation.storePublicId}:${allocation.orderLineId}`;priorByLine.set(key,(priorByLine.get(key)||0)+Number(allocation.grossMinor||0));}}
      for(const raw of requestedAllocations){
        const storePublicId=String(raw.storePublicId||'').trim(),productPublicId=String(raw.productPublicId||'').trim(),orderLineId=String(raw.orderLineId||'').trim(),grossMinor=Math.floor(Number(raw.grossMinor||0));
        if(!storePublicId||!orderLineId||grossMinor<=0)throw new AppError('Refund allocation must identify an immutable order line and a positive amount.',422,'REFUND_ALLOCATION_INVALID');
        const purchased=order.items.some(item=>item.storePublicId===storePublicId&&(!productPublicId||item.productPublicId===productPublicId)&&String(item.linePublicId||'')===orderLineId);
        if(!purchased)throw new AppError('Refund allocation does not belong to this order.',422,'REFUND_ALLOCATION_INVALID');
        const key=`${storePublicId}:${orderLineId}`,line=sellerLineById.get(key);
        if(!line||![line.customerPaidMinor,line.platformFeeMinor,line.sellerReceivableMinor].every(value=>Number.isSafeInteger(Number(value))&&Number(value)>=0)||Number(line.platformFeeMinor)+Number(line.sellerReceivableMinor)!==Number(line.customerPaidMinor))throw new AppError('Immutable seller settlement snapshot is missing or invalid. Run the production migration before refunding this order.',409,'SELLER_SETTLEMENT_SNAPSHOT_MISSING');
        const consumed=Number(priorByLine.get(key)||0),base=Number(line.customerPaidMinor||0);
        if(base<=0||consumed+grossMinor>base)throw new AppError('Refund allocation exceeds the remaining paid amount for this order line.',409,'REFUND_ALLOCATION_EXHAUSTED');
        const platformFeeMinor=proportionalSettlementSlice(Number(line.platformFeeMinor||0),consumed,grossMinor,base),sellerReceivableMinor=grossMinor-platformFeeMinor;
        cleanAllocations.push({storePublicId,productPublicId,variantPublicId:String(line.variantPublicId||''),sku:String(line.sku||''),costSnapshotStatus:String(line.costSnapshotStatus||'legacy_unknown'),orderLineId,grossMinor,platformFeeMinor,sellerReceivableMinor});allocationTotal+=grossMinor;priorByLine.set(key,consumed+grossMinor);
      }
    }
    if(cleanAllocations.length&&allocationTotal!==amount)throw new AppError('Refund allocations must equal the refund amount.',422,'REFUND_ALLOCATION_TOTAL');
    let provider=intent.provider==='cod'?'cod_manual':PAYMENT_PROVIDER;
    if(provider===PAYMENT_PROVIDER){
      const priorProvider=await Refund.exists({paymentIntentId:intent._id,provider:PAYMENT_PROVIDER,status:{$in:['pending','processing','completed']}}).session(session);
      const card=/card|visa|master|amex/i.test(String(intent.providerPaymentMethod||''));
      if(priorProvider||(!card&&amount<available))provider='external_manual';
    }
    const reservedIntent=await PaymentIntent.findOneAndUpdate({_id:intent._id,refundReservedMinor:reservedRefundMinor,refundedMinor,$expr:{$lte:[{$add:[{$ifNull:['$refundReservedMinor',0]},{$ifNull:['$refundedMinor',0]},amount]},'$amountMinor']}},{$inc:{refundReservedMinor:amount}},{session,returnDocument:'after'});
    if(!reservedIntent)throw new AppError('Another refund changed the remaining refundable balance. Reload and retry with the current balance.',409,'REFUND_RESERVATION_CONFLICT');
    const docs=await Refund.create([{publicId:publicId('rfd'),idempotencyKey,orderId:order._id,paymentIntentId:intent._id,amountMinor:amount,currency:order.totals.currency,reason,allocations:cleanAllocations,provider,requestedByUserId:request.user?._id,status:provider===PAYMENT_PROVIDER?'pending':'processing'}],{session});
    order.refundState=provider===PAYMENT_PROVIDER?'pending':'processing';
    if(order.cancellationState==='requested')order.cancellationState='processing';
    syncLegacyOrderStatus(order);await order.save({session});
    result={refund:docs[0],order,intent:reservedIntent,existing:false};
  });return result;}finally{await session.endSession();}
}

export async function createRefund(request,input){
  const {refund,order,intent,existing}=await reserveRefund(request,input);if(existing)return refund;
  if(refund.provider!=='pesapal')return refund;
  try{
    const payload=await requestPesapalRefund({confirmationCode:intent.providerConfirmationCode,amount:major(refund.amountMinor,refund.currency),username:request.user?.name||request.user?.email||'Classic Mart Finance',remarks:refund.reason});
    refund.providerRefundId=String(intent.providerConfirmationCode);refund.providerStatus=String(payload?.status||'');refund.providerMessage=String(payload?.message||'').slice(0,400);
    if(String(payload?.status)==='200'||Number(payload?.error)===200){refund.status='processing';await refund.save();return refund;}
    const message=refund.providerMessage||'Pesapal rejected the refund request.';await failRefundAndReleaseReservation(refund._id,{providerStatus:refund.providerStatus||'REJECTED',providerMessage:message,failureMessage:message});throw new AppError(message,409,'PESAPAL_REFUND_REJECTED');
  }catch(error){
    if(error?.code==='PESAPAL_REFUND_REJECTED')throw error;
    if(error?.ambiguous){refund.status='processing';refund.providerStatus='UNKNOWN';refund.providerMessage='Pesapal refund submission outcome is unknown. Do not resubmit; reconcile in the Pesapal merchant portal.';await refund.save();return refund;}
    const message=String(error.message||'Pesapal refund failed.').slice(0,400);await failRefundAndReleaseReservation(refund._id,{providerStatus:'REJECTED',providerMessage:message,failureMessage:message});throw error;
  }
}

export async function completeManualRefund(request,refundPublicId,{reference}){
  const refund=await Refund.findOne({publicId:refundPublicId,provider:{$in:['cod_manual','external_manual','pesapal']},status:'processing'});
  if(!refund)throw new AppError('Pending refund not found.',404,'REFUND_NOT_FOUND');
  const order=await Order.findById(refund.orderId);if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');assertFinanceCountry(request,order.country);
  if(refund.requestedByUserId?.equals(request.user._id))throw new AppError('A different finance operator must confirm refund disbursement.',403,'FOUR_EYES_REQUIRED');
  const intent=await PaymentIntent.findById(refund.paymentIntentId);if(!intent)throw new AppError('Payment record not found.',409,'REFUND_PAYMENT_MISSING');
  refund.manualReference=String(reference||'').trim();if(refund.manualReference.length<4)throw new AppError('Enter the verified refund/disbursement reference.',422,'REFUND_REFERENCE_REQUIRED');
  refund.status='completed';refund.completedAt=new Date();refund.completedByUserId=request.user._id;refund.providerRefundId=refund.providerRefundId||`${refund.provider}:${refund.manualReference}`;refund.providerStatus='COMPLETED';
  await postRefundLedger(order,refund,intent);return Refund.findById(refund._id);
}

async function postRefundLedger(orderLike,refundLike,intentLike){
  const session=await mongoose.startSession();
  try{await session.withTransaction(async()=>{
    if(await LedgerTransaction.exists({idempotencyKey:`refund:${refundLike.publicId}`}).session(session))return;
    const order=await Order.findById(orderLike._id).session(session),loadedIntent=await PaymentIntent.findById(intentLike._id).session(session),refund=await Refund.findById(refundLike._id).session(session);
    if(!order||!loadedIntent||!refund)throw new AppError('Refund accounting records are incomplete.',409,'REFUND_ACCOUNTING_MISSING');
    await assertRefundCounterConsistency(loadedIntent,session);
    let intent=await PaymentIntent.findOneAndUpdate({_id:loadedIntent._id,refundReservedMinor:{$gte:refund.amountMinor},$expr:{$lte:[{$add:[{$ifNull:['$refundedMinor',0]},refund.amountMinor]},'$amountMinor']}},{$inc:{refundReservedMinor:-refund.amountMinor,refundedMinor:refund.amountMinor}},{session,returnDocument:'after'});
    if(!intent)throw new AppError('Refund completion could not atomically consume the reserved balance.',409,'REFUND_COUNTER_CONFLICT');
    if(refundLike.status==='completed'){
      refund.status='completed';refund.completedAt=refundLike.completedAt||new Date();refund.completedByUserId=refundLike.completedByUserId||refund.completedByUserId;
      refund.manualReference=refundLike.manualReference||refund.manualReference;refund.providerRefundId=refundLike.providerRefundId||refund.providerRefundId;refund.providerStatus=refundLike.providerStatus||'COMPLETED';
    }
    const sellerOrders=await SellerOrder.find({orderId:order._id}).session(session).lean(),byStore=new Map(sellerOrders.map(row=>[row.storePublicId,row]));const entries=[],affectedStores=new Set();
    const allocations=Array.isArray(refund.allocations)?refund.allocations.filter(row=>Number(row.grossMinor)>0):[];
    if(allocations.length){
      let debitTotal=0;
      for(const allocation of allocations){
        const row=byStore.get(allocation.storePublicId);if(!row)throw new AppError('Refund allocation store is not part of the order.',409,'REFUND_ALLOCATION_INVALID');
        const gross=Number(allocation.grossMinor||0),feeShare=Number(allocation.platformFeeMinor||0),sellerShare=Number(allocation.sellerReceivableMinor||0);
        if(!allocation.orderLineId||![gross,feeShare,sellerShare].every(Number.isSafeInteger)||gross<=0||feeShare<0||sellerShare<0||feeShare+sellerShare!==gross)throw new AppError('Refund settlement allocation is missing or invalid.',409,'REFUND_SETTLEMENT_SNAPSHOT_MISSING');
        affectedStores.add(allocation.storePublicId);
        if(sellerShare>0){const account=await ensureLedgerAccount({code:'seller_payable',type:'liability',ownerType:'store',ownerPublicId:allocation.storePublicId,country:order.country,currency:order.totals.currency},session);entries.push({account,debitMinor:sellerShare,creditMinor:0,memo:`Refund exact seller receivable reversal for ${allocation.storePublicId}/${allocation.orderLineId}`});debitTotal+=sellerShare;}
        if(feeShare>0){const revenue=await ensureLedgerAccount({code:'platform_revenue',type:'revenue',ownerType:'platform',ownerPublicId:'classic-mart',country:order.country,currency:order.totals.currency},session);entries.push({account:revenue,debitMinor:feeShare,creditMinor:0,memo:`Refund exact marketplace fee reversal for ${allocation.orderLineId}`});debitTotal+=feeShare;}
      }
      if(debitTotal!==Number(refund.amountMinor))throw new AppError('Refund settlement allocation does not balance to the refund amount.',409,'REFUND_ALLOCATION_TOTAL');
    }else{
      // An allocation-free refund is permitted only for the untouched full captured amount.
      // Reverse the immutable original ledger transaction entry-for-entry; never reconstruct
      // seller/fee/tax shares from current models or a second rounding formula.
      let original=null;
      if(intent.provider==='cod'){
        const shipment=await Shipment.findOne({orderId:order._id,kind:'outbound'}).sort({deliveredAt:-1,createdAt:-1}).session(session).lean();
        if(shipment)original=await LedgerTransaction.findOne({idempotencyKey:`cod:${shipment.publicId}`,referenceType:'cod_reconciliation'}).session(session).lean();
      }else original=await LedgerTransaction.findOne({idempotencyKey:`payment:${intent.publicId}`,referenceType:'payment'}).session(session).lean();
      if(!original)throw new AppError('Original immutable payment settlement is missing; reconcile the payment before refunding.',409,'REFUND_ORIGINAL_SETTLEMENT_MISSING');
      const originalCredits=original.entries.filter(row=>Number(row.creditMinor||0)>0),originalCreditTotal=originalCredits.reduce((sum,row)=>sum+Number(row.creditMinor||0),0);
      if(Number(refund.amountMinor)!==originalCreditTotal)throw new AppError('Allocation-free refund must reverse the complete original settlement.',409,'REFUND_FULL_SETTLEMENT_REQUIRED');
      const accounts=await LedgerAccount.find({_id:{$in:originalCredits.map(row=>row.accountId)}}).session(session),accountById=new Map(accounts.map(row=>[String(row._id),row]));
      for(const row of originalCredits){const account=accountById.get(String(row.accountId));if(!account)throw new AppError('Original settlement ledger account is missing.',409,'REFUND_ORIGINAL_SETTLEMENT_MISSING');entries.push({account,debitMinor:Number(row.creditMinor||0),creditMinor:0,memo:`Exact reversal of ${original.publicId}`});}
    }
    const clearing=await ensureLedgerAccount({code:intent.provider==='cod'?'cod_clearing':'provider_clearing',type:'asset',ownerType:intent.provider==='cod'?'platform':'provider',ownerPublicId:intent.provider==='cod'?'classic-mart':PAYMENT_PROVIDER,country:order.country,currency:order.totals.currency},session);entries.push({account:clearing,debitMinor:0,creditMinor:refund.amountMinor,memo:intent.provider==='cod'?'COD refund disbursed':'Customer refund'});
    await postLedgerTransaction({idempotencyKey:`refund:${refund.publicId}`,referenceType:'refund',referencePublicId:refund.publicId,currency:refund.currency,country:order.country,description:`Refund for ${order.publicId}`,entries},session);
    const previous=await Refund.aggregate([{$match:{orderId:order._id,status:'completed',_id:{$ne:refund._id}}},{$group:{_id:null,total:{$sum:'$amountMinor'}}}]).session(session);const completedMinor=Number(previous[0]?.total||0)+refund.amountMinor,fully=completedMinor>=order.totals.totalMinor;
    intent.status=fully?'refunded':'partially_refunded';order.paymentState=fully?'refunded':'partially_refunded';order.refundState=fully?'complete':'partial';if(order.fulfillmentState==='cancelled'&&order.cancellation?.requestedAt)order.cancellationState='cancelled';syncLegacyOrderStatus(order);await intent.save({session});order.timeline.push({type:'refund.completed',message:`Refund ${refund.publicId} completed.`});
    if(fully||!allocations.length)await SellerOrder.updateMany({orderId:order._id},{$set:{status:fully?'refunded':'partially_refunded'},$push:{timeline:{type:'refund.completed',message:`Refund ${refund.publicId} applied to marketplace order.`}}},{session});else if(affectedStores.size)await SellerOrder.updateMany({orderId:order._id,storePublicId:{$in:[...affectedStores]}},{$set:{status:'partially_refunded'},$push:{timeline:{type:'refund.completed',message:`Item refund ${refund.publicId} applied to this seller order.`}}},{session});
    const { ReturnRequest }=await import('../models/ReturnRequest.js');const returnRequest=await ReturnRequest.findOne({refundPublicId:refund.publicId}).session(session);if(returnRequest&&returnRequest.status!=='refunded'){for(const returned of returnRequest.items||[]){const line=order.items.find(item=>String(item.linePublicId)===String(returned.orderLineId));if(!line)throw new AppError('Refunded return references a missing order line.',409,'REFUND_ORDER_LINE_MISSING');const next=Number(line.refundedQuantity||0)+Number(returned.quantity||0);if(next>Number(line.returnedQuantity||0))throw new AppError('Refunded quantity exceeds physically returned quantity.',409,'REFUND_QUANTITY_CONFLICT');line.refundedQuantity=next;}returnRequest.status='refunded';returnRequest.timeline.push({type:'return.refunded',message:`Refund ${refund.publicId} completed and returned quantities were financially settled.`});await returnRequest.save({session});const { SellerReturnCase }=await import('../models/SellerReturnCase.js');await SellerReturnCase.updateMany({returnRequestId:returnRequest._id,status:{$ne:'resolved'}},{$set:{status:'resolved'},$push:{timeline:{type:'seller_return.resolved',message:`Refund ${refund.publicId} completed.`}}},{session});}
    const { reverseOrderCommissions }=await import('./promoters.js');await reverseOrderCommissions(order,refund,session);
    const { issueRefundCreditNote }=await import('./financial-documents.js');await issueRefundCreditNote(order,refund,intent,session);
    await refund.save({session});await order.save({session});await refreshOrderLifecycle(order._id,{session});
  });}finally{await session.endSession();}
}

export async function payoutOwnerContext(request,{preferredStorePublicId='',strictPreferred=false}={}){
  if(request.user?.role==='promoter')return{ownerType:'promoter',ownerUserId:request.user._id,ownerPublicId:String(request.user._id),ownerStoreId:null,ownerStorePublicId:'',country:request.user.country,currency:request.user.currency,availableStores:[]};
  if(request.user?.role==='delivery')return{ownerType:'delivery',ownerUserId:request.user._id,ownerPublicId:String(request.user._id),ownerStoreId:null,ownerStorePublicId:'',country:request.user.country,currency:request.user.currency,availableStores:[]};
  const accesses=(await sellerStoreAccesses(request.user)).filter(row=>['owner','admin','finance'].includes(row.role));
  if(!accesses.length)throw new AppError('Seller owner, admin or finance access is required.',403,'PAYOUT_OWNER_REQUIRED');
  const requested=String(preferredStorePublicId||request.session?.activeStorePublicId||'').trim();
  let selected=requested?accesses.find(row=>row.store.publicId===requested):null;
  if(requested&&!selected&&strictPreferred)throw new AppError('Selected seller finance workspace is unavailable.',403,'PAYOUT_WORKSPACE_FORBIDDEN');
  selected ||= accesses[0];
  if(request.session)request.session.activeStorePublicId=selected.store.publicId;
  const availableStores=accesses.map(row=>({publicId:row.store.publicId,name:row.store.name,country:row.store.country,currency:row.store.currency,status:row.store.status,role:row.role}));
  return{ownerType:'store',ownerUserId:selected.store.ownerUserId,ownerPublicId:selected.store.publicId,ownerStoreId:selected.store._id,ownerStorePublicId:selected.store.publicId,country:selected.store.country,currency:selected.store.currency,store:selected.store,membership:selected.membership,availableStores};
}
function payoutPayableCode(ownerType){return ownerType==='store'?'seller_payable':ownerType==='delivery'?'delivery_payable':'promoter_payable';}
function payoutLedgerOwnerType(account){return account?.ownerType==='seller'?'store':account?.ownerType==='delivery'?'delivery':'promoter';}
async function postPayoutHold(payout,account,ownerType,ownerPublicId,session=null){const payable=await ensureLedgerAccount({code:payoutPayableCode(ownerType),type:'liability',ownerType,ownerPublicId,country:account.country,currency:payout.currency},session),clearing=await ensureLedgerAccount({code:'payout_clearing',type:'liability',ownerType:'platform',ownerPublicId:'classic-mart',country:account.country,currency:payout.currency},session);await postLedgerTransaction({idempotencyKey:`payout-hold:${payout.publicId}`,referenceType:'payout',referencePublicId:payout.publicId,currency:payout.currency,country:account.country,description:`Payout reserved for ${payout.publicId}`,entries:[{account:payable,debitMinor:payout.amountMinor,creditMinor:0,memo:'Move payable into payout clearing'},{account:clearing,debitMinor:0,creditMinor:payout.amountMinor,memo:'Pending external disbursement'}]},session);}
export async function releasePayoutHold(payout,account,reason='Payout rejected',session=null){const ownerType=payoutLedgerOwnerType(account),owner=ownerType==='store'?await Store.findOne(payout.ownerStoreId?{_id:payout.ownerStoreId}:{ownerUserId:payout.ownerUserId}).session(session).lean():null,ownerPublicId=ownerType==='store'?(payout.ownerStorePublicId||owner?.publicId):String(payout.ownerUserId),payable=await ensureLedgerAccount({code:payoutPayableCode(ownerType),type:'liability',ownerType,ownerPublicId,country:account.country,currency:payout.currency},session),clearing=await ensureLedgerAccount({code:'payout_clearing',type:'liability',ownerType:'platform',ownerPublicId:'classic-mart',country:account.country,currency:payout.currency},session);await postLedgerTransaction({idempotencyKey:`payout-release:${payout.publicId}`,referenceType:'payout',referencePublicId:payout.publicId,currency:payout.currency,country:account.country,description:`Release payout reservation ${payout.publicId}`,entries:[{account:clearing,debitMinor:payout.amountMinor,creditMinor:0,memo:reason},{account:payable,debitMinor:0,creditMinor:payout.amountMinor,memo:'Restore available payable'}]},session);}
export async function rejectPayout(request,payoutPublicId,{reason}){
  const rejectionReason=String(reason||'Rejected by finance').trim().slice(0,300);if(rejectionReason.length<3)throw new AppError('Enter a rejection reason.',422,'PAYOUT_REJECTION_REASON_REQUIRED');
  const session=await mongoose.startSession();let rejected;
  try{
    await session.withTransaction(async()=>{
      const payout=await Payout.findOne({publicId:payoutPublicId,status:{$in:['requested','approved']}}).session(session);
      if(!payout)throw new AppError('Open payout not found.',404,'PAYOUT_NOT_FOUND');
      if((payout.requestedByUserId||payout.ownerUserId).equals(request.user._id))throw new AppError('You cannot reject a payout you requested.',403,'FOUR_EYES_REQUIRED');
      const account=await PayoutAccount.findById(payout.payoutAccountId).session(session);
      if(!account)throw new AppError('Payout account not found.',404,'PAYOUT_ACCOUNT_NOT_FOUND');
      assertFinanceCountry(request,account.country);
      await releasePayoutHold(payout,account,rejectionReason,session);
      payout.status='rejected';payout.failureMessage=rejectionReason;await payout.save({session});rejected=payout;
    });
  }finally{await session.endSession();}
  return rejected;
}

export async function submitPayout(request,payoutPublicId){
  const payout=await Payout.findOne({publicId:payoutPublicId,status:'approved'});
  if(!payout)throw new AppError('Approved payout not found.',404,'PAYOUT_NOT_FOUND');
  if(payout.approvedByUserId?.equals(request.user._id))throw new AppError('A different finance operator must submit an approved payout.',403,'FOUR_EYES_REQUIRED');
  const account=await PayoutAccount.findOne({_id:payout.payoutAccountId,status:'verified'}).select('+destinationEncrypted');
  if(!account)throw new AppError('Verified payout destination not found.',409,'PAYOUT_ACCOUNT_REQUIRED');
  assertFinanceCountry(request,account.country);
  try{JSON.parse(decryptSensitive(account.destinationEncrypted));}catch{throw new AppError('Payout destination is invalid.',422,'PAYOUT_DESTINATION_INVALID');}
  const now=new Date(),submissionAttemptId=crypto.randomUUID();
  const claimed=await Payout.findOneAndUpdate(
    {publicId:payoutPublicId,status:'approved',approvedByUserId:{$ne:request.user._id}},
    {$set:{status:'submitting',submittedByUserId:request.user._id,submissionStartedAt:now,submissionAttemptId,submittedAt:null,providerReference:'',ambiguityReason:'',unknownAt:null,unknownByUserId:null,disbursementProvider:'external'}},
    {new:true}
  );
  if(!claimed)throw new AppError('This payout has already been claimed for submission. Reconcile the existing attempt instead of resubmitting.',409,'PAYOUT_SUBMISSION_CLAIMED');
  return claimed;
}

export async function confirmPayoutSubmission(request,payoutPublicId,{reference}){
  const payout=await Payout.findOne({publicId:payoutPublicId,status:'submitting'});
  if(!payout)throw new AppError('Payout submission is not awaiting confirmation.',404,'PAYOUT_NOT_FOUND');
  if(!payout.submittedByUserId?.equals(request.user._id))throw new AppError('Only the finance operator who began the external transfer may confirm its submission.',403,'PAYOUT_SUBMITTER_REQUIRED');
  const account=await PayoutAccount.findById(payout.payoutAccountId);
  if(!account)throw new AppError('Payout account not found.',404,'PAYOUT_ACCOUNT_NOT_FOUND');
  assertFinanceCountry(request,account.country);
  const ref=String(reference||'').trim();if(ref.length<4)throw new AppError('Enter the external disbursement reference.',422,'PAYOUT_REFERENCE_REQUIRED');
  const confirmed=await Payout.findOneAndUpdate(
    {_id:payout._id,status:'submitting',submittedByUserId:request.user._id,submissionAttemptId:payout.submissionAttemptId},
    {$set:{status:'submitted',providerReference:ref,submittedAt:new Date(),ambiguityReason:'',unknownAt:null,unknownByUserId:null}},
    {new:true}
  );
  if(!confirmed)throw new AppError('Payout submission state changed before confirmation. Re-open the finance queue before taking another action.',409,'PAYOUT_STATE_CHANGED');
  return confirmed;
}

export async function markPayoutUnknown(request,payoutPublicId,{reason}){
  const payout=await Payout.findOne({publicId:payoutPublicId,status:{$in:['submitting','submitted']}});
  if(!payout)throw new AppError('Payout is not in an ambiguous submission state.',404,'PAYOUT_NOT_FOUND');
  const account=await PayoutAccount.findById(payout.payoutAccountId);
  if(!account)throw new AppError('Payout account not found.',404,'PAYOUT_ACCOUNT_NOT_FOUND');
  assertFinanceCountry(request,account.country);
  const ambiguityReason=String(reason||'').trim();if(ambiguityReason.length<8)throw new AppError('Explain why the external payout outcome is uncertain.',422,'PAYOUT_AMBIGUITY_REASON_REQUIRED');
  const unknown=await Payout.findOneAndUpdate(
    {_id:payout._id,status:{$in:['submitting','submitted']}},
    {$set:{status:'unknown',unknownByUserId:request.user._id,unknownAt:new Date(),ambiguityReason:ambiguityReason.slice(0,400)}},
    {new:true}
  );
  if(!unknown)throw new AppError('Payout state changed before it could be marked UNKNOWN.',409,'PAYOUT_STATE_CHANGED');
  return unknown;
}

export async function reconcilePayout(request,payoutPublicId,{reference,success=true,message=''}){
  const ref=String(reference||'').trim();if(ref.length<4)throw new AppError('Enter the external disbursement reference.',422,'PAYOUT_REFERENCE_REQUIRED');
  const session=await mongoose.startSession();let completed;
  try{
    await session.withTransaction(async()=>{
      const payout=await Payout.findOne({publicId:payoutPublicId,status:{$in:['submitted','unknown']}}).session(session);
      if(!payout)throw new AppError('Submitted payout not found.',404,'PAYOUT_NOT_FOUND');
      if(payout.submittedByUserId?.equals(request.user._id))throw new AppError('A different finance operator must reconcile the payout.',403,'FOUR_EYES_REQUIRED');
      const account=await PayoutAccount.findById(payout.payoutAccountId).session(session);
      if(!account)throw new AppError('Payout account not found.',404,'PAYOUT_ACCOUNT_NOT_FOUND');
      assertFinanceCountry(request,account.country);
      const ownerType=payoutLedgerOwnerType(account),owner=ownerType==='store'?await Store.findOne(payout.ownerStoreId?{_id:payout.ownerStoreId}:{ownerUserId:payout.ownerUserId}).session(session).lean():null,ownerPublicId=ownerType==='store'?(payout.ownerStorePublicId||owner?.publicId):String(payout.ownerUserId),clearing=await ensureLedgerAccount({code:'payout_clearing',type:'liability',ownerType:'platform',ownerPublicId:'classic-mart',country:account.country,currency:payout.currency},session);
      if(success){
        const bank=await ensureLedgerAccount({code:'external_disbursement_clearing',type:'asset',ownerType:'provider',ownerPublicId:'external',country:account.country,currency:payout.currency},session);
        await postLedgerTransaction({idempotencyKey:`payout-paid:${payout.publicId}`,referenceType:'payout',referencePublicId:payout.publicId,currency:payout.currency,country:account.country,description:`Payout completed ${payout.publicId}`,entries:[{account:clearing,debitMinor:payout.amountMinor,creditMinor:0,memo:'Clear payout liability'},{account:bank,debitMinor:0,creditMinor:payout.amountMinor,memo:`External disbursement ${ref}`}]},session);
        payout.status='paid';payout.failureMessage='';
        if(ownerType==='promoter'){const {settlePromoterCommissions}=await import('./promoters.js');await settlePromoterCommissions(payout.ownerUserId,payout.amountMinor,session);}
      }else{
        const payable=await ensureLedgerAccount({code:payoutPayableCode(ownerType),type:'liability',ownerType,ownerPublicId,country:account.country,currency:payout.currency},session);
        await postLedgerTransaction({idempotencyKey:`payout-reverse:${payout.publicId}`,referenceType:'payout',referencePublicId:payout.publicId,currency:payout.currency,country:account.country,description:`Failed payout reversal ${payout.publicId}`,entries:[{account:clearing,debitMinor:payout.amountMinor,creditMinor:0,memo:'Release payout clearing'},{account:payable,debitMinor:0,creditMinor:payout.amountMinor,memo:'Restore payable balance'}]},session);
        payout.status='failed';payout.failureMessage=String(message||'External disbursement failed.').slice(0,400);
      }
      payout.providerReference=ref;payout.completedByUserId=request.user._id;payout.completedAt=new Date();await payout.save({session});completed=payout;
    });
  }finally{await session.endSession();}
  return completed;
}

export async function savePayoutAccount(request,{method,label,destination}){const owner=await payoutOwnerContext(request);const docs=await PayoutAccount.create([{publicId:publicId('poa'),ownerUserId:owner.ownerUserId,ownerStoreId:owner.ownerStoreId||undefined,ownerStorePublicId:owner.ownerStorePublicId||'',ownerType:owner.ownerType==='store'?'seller':owner.ownerType,country:owner.country,currency:owner.currency,method,label,destinationEncrypted:encryptSensitive(JSON.stringify(destination)),status:'pending'}]);return docs[0];}
export async function payoutAccountsForRequest(request){const owner=await payoutOwnerContext(request),query=owner.ownerType==='store'?{ownerStoreId:owner.ownerStoreId,ownerType:'seller'}:{ownerUserId:owner.ownerUserId,ownerType:owner.ownerType};return PayoutAccount.find(mongoose.trusted(query)).select('-destinationEncrypted').sort({createdAt:-1}).lean();}
export async function payoutsForRequest(request,{cursor='',limit=50,withPage=false}={}){const owner=await payoutOwnerContext(request);let query;if(owner.ownerType==='store')query={ownerStoreId:owner.ownerStoreId};else{const accountIds=await PayoutAccount.find({ownerUserId:owner.ownerUserId,ownerType:owner.ownerType}).distinct('_id');query={payoutAccountId:{$in:accountIds}};}const size=Math.min(100,Math.max(10,Number(limit)||50));const [rows,total]=await Promise.all([Payout.find(mongoose.trusted(cursorScope(query,cursor))).sort(cursorSort()).limit(size+1).lean(),Payout.countDocuments(mongoose.trusted(query))]);const page=pageResult(rows,{limit:size,total});return withPage?page:page.items;}
export async function requestPayout(request,{payoutAccountId,amountMinor,idempotencyKey}){const owner=await payoutOwnerContext(request),existing=await Payout.findOne({idempotencyKey,requestedByUserId:request.user._id});if(existing)return existing;const accountQuery=owner.ownerType==='store'?{publicId:payoutAccountId,status:'verified',ownerStoreId:owner.ownerStoreId,ownerType:'seller'}:{publicId:payoutAccountId,ownerUserId:owner.ownerUserId,ownerType:owner.ownerType,status:'verified'},account=await PayoutAccount.findOne(mongoose.trusted(accountQuery));if(!account)throw new AppError('Verified payout account required.',409,'PAYOUT_ACCOUNT_REQUIRED');const session=await mongoose.startSession();let payout;try{await session.withTransaction(async()=>{const ledger=await ensureLedgerAccount({code:payoutPayableCode(owner.ownerType),type:'liability',ownerType:owner.ownerType,ownerPublicId:owner.ownerPublicId,country:owner.country,currency:owner.currency},session);await LedgerAccount.findOneAndUpdate({_id:ledger._id},{$inc:{mutationVersion:1}},{session,returnDocument:'after'});const available=await accountBalanceMinor(ledger._id,session);if(amountMinor>available)throw new AppError('Payout amount exceeds available balance.',409,'PAYOUT_BALANCE');const docs=await Payout.create([{publicId:publicId('pyo'),idempotencyKey,ownerUserId:owner.ownerUserId,ownerStoreId:owner.ownerStoreId||undefined,ownerStorePublicId:owner.ownerStorePublicId||'',requestedByUserId:request.user._id,payoutAccountId:account._id,amountMinor,currency:owner.currency,status:'requested'}],{session});payout=docs[0];await postPayoutHold(payout,account,owner.ownerType,owner.ownerPublicId,session);});}finally{await session.endSession();}return payout;}

export async function reconcilePayments(request,{hours=24}={}){
  const scopes=userCountryScopes(request.user),countries=scopes.includes('*')?null:scopes,since=new Date(Date.now()-Math.min(Math.max(Number(hours)||24,1),168)*60*60*1000);
  const run=await ReconciliationRun.create({publicId:publicId('rec'),country:countries?.length===1?countries[0]:'GLOBAL',provider:PAYMENT_PROVIDER,startedByUserId:request.user._id,status:'running',startedAt:new Date()});
  const query={provider:PAYMENT_PROVIDER,status:{$in:['created','requires_action','pending','failed']},createdAt:{$gte:since}};
  if(countries?.length){const orderIds=await Order.find({country:{$in:countries}}).distinct('_id');query.orderId={$in:orderIds};}
  const errors=[];let matched=0,updated=0,failed=0,lastId=null;
  while(true){
    const batchQuery=lastId?{$and:[query,{_id:{$gt:lastId}}]}:query;
    const intents=await PaymentIntent.find(mongoose.trusted(batchQuery)).sort({_id:1}).limit(100);
    if(!intents.length)break;
    for(const intent of intents){
      lastId=intent._id;run.checked+=1;
      try{
        if(!intent.providerTrackingId){failed+=1;if(errors.length<100)errors.push(`${intent.publicId}: Pesapal tracking ID not found`);continue;}
        const before=intent.status,verified=await verifyAndApplyPayment(intent.publicId,intent.providerTrackingId);matched+=1;if(verified.status!==before)updated+=1;
      }catch(error){failed+=1;if(errors.length<100)errors.push(`${intent.publicId}: ${error.message}`);}
    }
  }
  run.matched=matched;run.updated=updated;run.failed=failed;run.errorMessages=errors;run.status=failed&&failed===run.checked?'failed':'completed';run.completedAt=new Date();await run.save();return run;
}

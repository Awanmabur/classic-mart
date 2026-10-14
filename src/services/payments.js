import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { currentTraceFields, runWithStoredTrace } from '../core/trace.js';
import { hashToken } from '../core/crypto.js';
import { encryptSensitive, decryptSensitive } from '../core/sensitive.js';
import {
  BusinessInvoice, Chargeback, InventoryMovement, InventoryReservation, Order, PaymentIntent, ProviderEvent, PurchaseOrder, Refund, StockItem,
  CountrySetting, Device, EvidenceDocument, LedgerAccount, LedgerTransaction, Notification, PayoutAccount, Payout, PromoterVerification, ReconciliationRun, ReturnRequest, SellerOrder, SellerReturnCase, Shipment, Store, StoreMember, User, Warehouse, WarehouseTask,
} from '../models/index.js';
import { ensureLedgerAccount, postLedgerTransaction, accountBalanceMinor, sellerSettlementBreakdown, proportionalSettlementSlice } from './money.js';
import { orderAccessQuery } from './order-access.js';
import { refreshOrderLifecycle, syncLegacyOrderStatus } from './order-state.js';
import { getPesapalTransactionStatus, requestPesapalRefund, submitPesapalOrder } from './pesapal.js';
import { cursorScope, cursorSort, pageResult } from './pagination.js';
import { sellerStoreAccesses } from './store.js';
import { hydratePlatformAuthorization } from './platform-grants.js';
import { primaryWorkspaceFor } from '../dashboard/access.js';
import { financeAccess } from './finance-workspace-access.js';
import { queueFinanceAlert } from './finance-notifications.js';
import { writeAudit } from './audit.js';
import { completeReconciliationHistory } from './reconciliation-history.js';

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

async function createWalletIntent(order,idempotencyKey){
  const existing=await PaymentIntent.findOne({orderId:order._id,idempotencyKey});
  if(existing)return existing;
  const active=await PaymentIntent.findOne({activeKey:order.publicId});
  if(active)return active;
  try{
    const docs=await PaymentIntent.create([{publicId:publicId('pay'),...traceForOrder(order),orderId:order._id,orderPublicId:order.publicId,country:order.country,idempotencyKey,provider:'wallet',purpose:'order_payment',method:'wallet',status:'created',amountMinor:order.totals.totalMinor,currency:order.totals.currency,providerReference:`wallet:${order.publicId}`,activeKey:order.publicId}]);
    return docs[0];
  }catch(error){
    if(error?.code===11000){const raced=await PaymentIntent.findOne({$or:[{orderId:order._id,idempotencyKey},{activeKey:order.publicId}]});if(raced)return raced;}
    throw error;
  }
}

export async function initiatePayment(request,{orderId,idempotencyKey}){
  const order=await Order.findOne(mongoose.trusted(orderAccessQuery(request,orderId,{requiredLevel:'mutate'})));
  if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');
  const prior=await PaymentIntent.findOne({orderId:order._id,idempotencyKey});
  if(prior){
    // A provider intent may already exist when an earlier transaction rolled
    // back. Resume local payment authorisation rather than caching that failure.
    if(order.paymentMethod==='cod'&&prior.provider==='cod'&&['created','pending_collection'].includes(prior.status)&&['unpaid','pending'].includes(order.paymentState)&&order.status==='pending_payment'){
      await commitOrderInventoryAndMoney(order,prior,{cod:true});
      return paymentView(await PaymentIntent.findById(prior._id));
    }
    if(order.paymentMethod==='wallet'&&prior.provider==='wallet'&&prior.status==='created'&&['unpaid','pending','failed'].includes(order.paymentState)){
      if(!request.user?._id||!order.userId||String(order.userId)!==String(request.user._id))throw new AppError('Classic Wallet requires the signed-in customer who owns the order.',403,'WALLET_ORDER_SCOPE');
      await commitOrderInventoryAndMoney(order,prior,{wallet:true});
      return paymentView(await PaymentIntent.findById(prior._id));
    }
    await reconcileAuthorizedShipment(order,prior);
    return paymentView(prior);
  }
  const creditInvoicePayable=order.paymentMethod==='credit_terms'&&order.paymentState==='credit_due';
  if(!['unpaid','pending','failed'].includes(order.paymentState)&&!creditInvoicePayable)throw new AppError('This order cannot start another payment.',409,'ORDER_PAYMENT_STATE');
  if(!creditInvoicePayable&&order.reservationExpiresAt<=new Date())throw new AppError('The stock reservation expired. Create the order again.',409,'RESERVATION_EXPIRED');

  if(order.paymentMethod==='wallet'){
    if(!request.user?._id||!order.userId||String(order.userId)!==String(request.user._id))throw new AppError('Classic Wallet requires the signed-in customer who owns the order.',403,'WALLET_ORDER_SCOPE');
    const intent=await createWalletIntent(order,idempotencyKey);
    if(intent.status==='succeeded')return paymentView(intent);
    await commitOrderInventoryAndMoney(order,intent,{wallet:true});
    return paymentView(await PaymentIntent.findById(intent._id));
  }

  if(order.paymentMethod==='cod'){
    let intent;
    try{
      [intent]=await PaymentIntent.create([{
        publicId:publicId('pay'),...traceForOrder(order),orderId:order._id,orderPublicId:order.publicId,country:order.country,idempotencyKey,provider:'cod',method:'cod',
        status:'created',amountMinor:order.totals.totalMinor,currency:order.totals.currency,providerReference:`cod:${order.publicId}`,activeKey:order.publicId,
      }]);
    }catch(error){if(error?.code===11000){intent=await PaymentIntent.findOne({$or:[{orderId:order._id,idempotencyKey},{activeKey:order.publicId}]});}else throw error;}
    await commitOrderInventoryAndMoney(order,intent,{cod:true});
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

function shipmentPaymentAuthorized(order,intent){
  if(!order||!intent||!['none','rejected'].includes(order.cancellationState)||['cancelled','expired','cancellation_pending','refunded'].includes(order.status))return false;
  if(intent.provider==='cod')return order.paymentMethod==='cod'&&order.paymentState==='pending'&&intent.status==='pending_collection';
  if(intent.provider==='wallet')return order.paymentMethod==='wallet'&&order.paymentState==='paid'&&intent.status==='succeeded';
  return intent.provider===PAYMENT_PROVIDER&&order.paymentState==='paid'&&intent.status==='succeeded'&&intent.providerStatus==='COMPLETED'&&Boolean(intent.lastVerifiedAt)&&Boolean(intent.providerTrackingId);
}

async function ensureAuthorizedShipmentInSession(order,intent,session){
  if(!shipmentPaymentAuthorized(order,intent))return;
  const references=order.items.map(item=>item.reservationPublicId);
  const committed=await InventoryReservation.countDocuments({publicId:{$in:references},status:'committed'}).session(session);
  if(committed!==new Set(references).size)throw new AppError('Confirmed order inventory is not fully committed.',409,'RESERVATION_INCONSISTENT');
  const { ensureShipmentForOrder }=await import('./logistics.js');
  await ensureShipmentForOrder(order,order.userId||null,session);
}

async function reconcileAuthorizedShipment(orderLike,intentLike){
  if(!shipmentPaymentAuthorized(orderLike,intentLike))return;
  const session=await mongoose.startSession();
  try{await session.withTransaction(async()=>{
    const order=await Order.findById(orderLike._id).session(session);
    const intent=await PaymentIntent.findById(intentLike._id).session(session);
    if(!shipmentPaymentAuthorized(order,intent))return;
    // Fence cancellation against replay repair even when no payment or stock
    // fields change. Reconciliation never recommits inventory or ledger entries.
    order.markModified('paymentState');order.increment();await order.save({session});
    await ensureAuthorizedShipmentInSession(order,intent,session);
  });}finally{await session.endSession();}
}

async function commitOrderInventoryAndMoney(orderLike,intentLike,{cod=false,wallet=false,providerTrackingId='',providerConfirmationCode='',providerPaymentMethod='',financeRequest=null,financeCountry=''}={}){
  const session=await mongoose.startSession();
  try{await session.withTransaction(async()=>{
    const order=await Order.findById(orderLike._id).session(session);
    const intent=await PaymentIntent.findById(intentLike._id).session(session);
    if(!order||!intent)return;
    if(financeRequest)await financeAccess(financeRequest,{session,write:true,workspace:false,country:financeCountry||order.country});
    if(String(intent.orderId)!==String(order._id)||intent.orderPublicId!==order.publicId||intent.country!==order.country||intent.currency!==order.totals.currency)throw new AppError('Payment order references do not match.',409,'PAYMENT_ORDER_MISMATCH');
    if(!cod&&!wallet&&await Chargeback.exists({paymentIntentId:intent._id,status:{$in:['open','reviewing','lost']}}).session(session))throw new AppError('This reversed payment requires independent chargeback review before recovery.',409,'CHARGEBACK_REVIEW_REQUIRED');
    if(!['none','rejected'].includes(order.cancellationState)||['cancelled','expired','cancellation_pending','refunded'].includes(order.status))throw new AppError('This order is no longer available for payment.',409,'ORDER_PAYMENT_STATE');
    if(intent.purpose==='business_invoice'&&order.paymentMethod==='credit_terms'&&order.paymentState==='credit_due'){
      const invoice=order.businessInvoiceId?await BusinessInvoice.findById(order.businessInvoiceId).session(session):null;
      if(!invoice||!['open','overdue'].includes(invoice.status))throw new AppError('Business credit invoice is not payable.',409,'BUSINESS_INVOICE_NOT_PAYABLE');
      const clearing=await ensureLedgerAccount({code:'provider_clearing',type:'asset',ownerType:'provider',ownerPublicId:PAYMENT_PROVIDER,country:order.country,currency:order.totals.currency},session);
      const receivable=await ensureLedgerAccount({code:'business_accounts_receivable',type:'asset',ownerType:'business',ownerId:order.businessOrganizationId,ownerPublicId:String(order.businessOrganizationId),country:order.country,currency:order.totals.currency},session);
      await postLedgerTransaction({idempotencyKey:`business-invoice-payment:${intent.publicId}`,referenceType:'business_invoice_payment',referencePublicId:invoice.publicId,currency:order.totals.currency,country:order.country,description:`Pesapal payment for business invoice ${invoice.invoiceNumber}`,entries:[{account:clearing,debitMinor:intent.amountMinor,creditMinor:0,memo:'Verified Pesapal business invoice payment'},{account:receivable,debitMinor:0,creditMinor:intent.amountMinor,memo:'Clear business accounts receivable'}]},session);
      intent.status='succeeded';intent.paidAt=intent.paidAt||new Date();intent.activeKey=undefined;intent.providerTrackingId=providerTrackingId||intent.providerTrackingId;intent.providerTransactionId=intent.providerTrackingId||intent.providerTransactionId;intent.providerConfirmationCode=providerConfirmationCode||intent.providerConfirmationCode;intent.providerPaymentMethod=wallet?'Classic Wallet':(providerPaymentMethod||intent.providerPaymentMethod);if(wallet)intent.providerStatus='COMPLETED';
      invoice.status='paid';invoice.paidMinor=invoice.totalMinor;invoice.paidAt=intent.paidAt;invoice.paymentIntentPublicId=intent.publicId;invoice.timeline.push({type:'paid',message:'Business credit invoice paid through verified Pesapal transaction.'});
      order.paymentState='paid';syncLegacyOrderStatus(order);order.timeline.push({type:'business_invoice.paid',message:`Business invoice ${invoice.invoiceNumber} paid through Pesapal.`});
      const { makeOrderCommissionsPayable }=await import('./promoters.js');await makeOrderCommissionsPayable(order,session);
      const { applyGrowthForPaidOrder }=await import('./stage9.js');await applyGrowthForPaidOrder(order,session);
      const { issuePaymentReceipt }=await import('./financial-documents.js');await issuePaymentReceipt(order,intent,session);
      await invoice.save({session});await order.save({session});await intent.save({session});
      await ensureAuthorizedShipmentInSession(order,intent,session);return;
    }
    if(['paid','confirmed'].includes(order.status)){
      if(!cod&&intent.status!=='succeeded'){
        intent.status='succeeded';intent.paidAt=intent.paidAt||new Date();intent.activeKey=undefined;
        intent.providerTrackingId=providerTrackingId||intent.providerTrackingId;intent.providerTransactionId=intent.providerTrackingId||intent.providerTransactionId;
        intent.providerConfirmationCode=providerConfirmationCode||intent.providerConfirmationCode;intent.providerPaymentMethod=providerPaymentMethod||intent.providerPaymentMethod;
        await intent.save({session});
      }
      order.markModified('paymentState');order.increment();await order.save({session});
      await ensureAuthorizedShipmentInSession(order,intent,session);
      return;
    }
    if(order.reservationExpiresAt<=new Date())throw new AppError('The stock reservation expired. Create the order again.',409,'RESERVATION_EXPIRED');
    let walletAccount=null;
    if(wallet){
      const customer=order.userId?await User.findById(order.userId).select('publicId country currency').session(session).lean():null;
      if(!customer)throw new AppError('Classic Wallet customer record is missing.',409,'WALLET_CUSTOMER_MISSING');
      if(String(customer.country||'').toUpperCase()!==String(order.country||'').toUpperCase()||String(customer.currency||'').toUpperCase()!==String(order.totals.currency||'').toUpperCase())throw new AppError('Classic Wallet currency or country does not match this order.',409,'WALLET_CURRENCY_MISMATCH');
      walletAccount=await ensureLedgerAccount({code:'customer_wallet',type:'liability',ownerType:'customer',ownerId:customer._id,ownerPublicId:customer.publicId,country:order.country,currency:order.totals.currency},session);
      const available=await accountBalanceMinor(walletAccount._id,session);
      if(available<Number(order.totals.totalMinor||0))throw new AppError('Classic Wallet balance is insufficient for this order.',409,'WALLET_BALANCE_INSUFFICIENT');
    }
    for(const item of order.items){
      const reservation=await InventoryReservation.findOne({publicId:item.reservationPublicId,status:'active'}).session(session);
      if(!reservation)throw new AppError('Order stock reservation is no longer active.',409,'RESERVATION_INACTIVE');
      const stock=await StockItem.findOneAndUpdate(
        mongoose.trusted({_id:reservation.stockItemId,onHand:{$gte:reservation.quantity},reserved:{$gte:reservation.quantity}}),
        {$inc:{onHand:-reservation.quantity,reserved:-reservation.quantity,__v:1}},{returnDocument:'after',session},
      );
      if(!stock)throw new AppError('Reserved stock is inconsistent.',409,'STOCK_CONFLICT');
      reservation.status='committed';reservation.committedAt=new Date();await reservation.save({session});
      await InventoryMovement.create([{publicId:publicId('mov'),storeId:reservation.storeId,stockItemId:stock._id,variantId:stock.variantId,warehouseId:stock.warehouseId,type:'sale',quantity:-reservation.quantity,onHandBefore:stock.onHand+reservation.quantity,onHandAfter:stock.onHand,reservedBefore:stock.reserved+reservation.quantity,reservedAfter:stock.reserved,reason:cod?'COD order confirmed':wallet?'Classic Wallet payment sale':'Pesapal verified payment sale',reference:order.publicId,actorUserId:reservation.actorUserId}],{session});
    }
    if(cod){
      order.paymentState='pending';syncLegacyOrderStatus(order);order.timeline.push({type:'payment.cod_pending',message:'Cash on delivery selected. Payment will be collected during fulfilment.'});
      intent.status='pending_collection';
    }else{
      order.paymentState='paid';syncLegacyOrderStatus(order);order.timeline.push({type:'payment.verified',message:wallet?'Payment completed using Classic Wallet.':'Payment independently verified with Pesapal.'});
      const clearing=wallet?null:await ensureLedgerAccount({code:'provider_clearing',type:'asset',ownerType:'provider',ownerPublicId:PAYMENT_PROVIDER,country:order.country,currency:order.totals.currency},session);
      const entries=wallet?[{account:walletAccount,debitMinor:order.totals.totalMinor,creditMinor:0,memo:'Classic Wallet customer payment'}]:[{account:clearing,debitMinor:order.totals.totalMinor,creditMinor:0,memo:'Verified Pesapal customer payment'}];
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
      await postLedgerTransaction({idempotencyKey:`payment:${intent.publicId}`,referenceType:'payment',referencePublicId:intent.publicId,currency:order.totals.currency,country:order.country,description:wallet?`Classic Wallet payment for ${order.publicId}`:`Pesapal payment for ${order.publicId}`,entries},session);
      const { makeOrderCommissionsPayable }=await import('./promoters.js');await makeOrderCommissionsPayable(order,session);
      const { applyGrowthForPaidOrder }=await import('./stage9.js');await applyGrowthForPaidOrder(order,session);
      if(order.businessInvoiceId){
        const invoice=await BusinessInvoice.findById(order.businessInvoiceId).session(session);if(invoice){invoice.status='paid';invoice.paidMinor=invoice.totalMinor;invoice.paidAt=new Date();invoice.paymentIntentPublicId=intent.publicId;invoice.timeline.push({type:'paid',message:'Immediate business invoice paid through verified Pesapal transaction.'});await invoice.save({session});}
        if(order.purchaseOrderId)await PurchaseOrder.updateOne({_id:order.purchaseOrderId,status:'payment_pending'},{$set:{status:'processing'},$push:{timeline:{type:'payment.verified',message:'Immediate Pesapal payment verified; purchase order released to fulfilment.'}}},{session});
      }
      intent.status='succeeded';intent.paidAt=intent.paidAt||new Date();intent.activeKey=undefined;
      intent.providerTrackingId=providerTrackingId||intent.providerTrackingId;intent.providerTransactionId=intent.providerTrackingId||intent.providerTransactionId;
      intent.providerConfirmationCode=providerConfirmationCode||intent.providerConfirmationCode;intent.providerPaymentMethod=wallet?'Classic Wallet':(providerPaymentMethod||intent.providerPaymentMethod);if(wallet)intent.providerStatus='COMPLETED';
      const { issuePaymentReceipt }=await import('./financial-documents.js');await issuePaymentReceipt(order,intent,session);
    }
    await SellerOrder.updateMany({orderId:order._id,status:'pending_payment'},{$set:{status:'confirmed'},$push:{timeline:{type:cod?'payment.cod_pending':'payment.verified',message:cod?'COD order confirmed for fulfilment.':wallet?'Classic Wallet payment verified.':'Pesapal payment verified.'}}},{session});
    await order.save({session});await intent.save({session});
    await ensureAuthorizedShipmentInSession(order,intent,session);
  });}finally{await session.endSession();}
}

function normalizePesapalStatus(payload){return String(payload?.payment_status_description||payload?.status_description||'').trim().toUpperCase();}
export async function verifyAndApplyPayment(intentPublicId,orderTrackingId,{request=null,country=''}={}){
  const intent=await PaymentIntent.findOne({publicId:intentPublicId});
  if(!intent)throw new AppError('Payment intent not found.',404,'PAYMENT_NOT_FOUND');
  if(request)await financeAccess(request,{workspace:false,country:country||intent.country});
  if(intent.provider!==PAYMENT_PROVIDER)return paymentView(intent);
  return runWithStoredTrace({traceId:intent.traceId,spanId:intent.traceSpanId},async()=>{
  const tracking=String(orderTrackingId||intent.providerTrackingId||'').trim();
  if(!tracking)throw new AppError('Pesapal tracking ID is missing.',409,'PESAPAL_TRACKING_ID_REQUIRED');
  if(intent.providerTrackingId&&intent.providerTrackingId!==tracking)throw new AppError('Pesapal tracking reference does not match this payment.',409,'PESAPAL_REFERENCE_MISMATCH');
  const data=await getPesapalTransactionStatus(tracking);
  const status=normalizePesapalStatus(data);intent.lastVerifiedAt=new Date();intent.providerStatus=status;intent.providerTrackingId=tracking;intent.providerTransactionId=tracking;
  if(data?.confirmation_code)intent.providerConfirmationCode=String(data.confirmation_code);
  if(data?.payment_method)intent.providerPaymentMethod=String(data.payment_method);
  const amountMatches=minor(data?.amount,intent.currency)===intent.amountMinor;
  const currencyMatches=String(data?.currency||'').toUpperCase()===intent.currency;
  const referenceMatches=String(data?.merchant_reference||'')===intent.providerReference;
  const amountSupplied=data?.amount!==undefined&&data?.amount!==null&&String(data.amount).trim()!=='';
  const currencySupplied=data?.currency!==undefined&&data?.currency!==null&&String(data.currency).trim()!=='';
  if(status==='REVERSED'&&(!amountMatches||!currencyMatches||!referenceMatches))throw new AppError('Pesapal reversal evidence does not match the original payment.',409,'PESAPAL_REVERSAL_MISMATCH');
  if(status!=='COMPLETED'&&(!referenceMatches||(amountSupplied&&!amountMatches)||(currencySupplied&&!currencyMatches)))throw new AppError('Pesapal status evidence does not match the original payment.',409,'PESAPAL_VERIFICATION_MISMATCH');
  const order=await Order.findById(intent.orderId);
  if(!order)throw new AppError('Payment order not found.',404,'ORDER_NOT_FOUND');
  if(intent.orderPublicId!==order.publicId||intent.country!==order.country||intent.currency!==order.totals.currency)throw new AppError('Payment order references do not match.',409,'PAYMENT_ORDER_MISMATCH');
  // Finance actor/grant/session and market revocations are checked again after
  // the provider responds. Provider evidence and local outcomes share a transaction.
  async function persistProviderOutcome(saveOrder=false){
    const session=await mongoose.startSession();
    try{await session.withTransaction(async()=>{
      if(request)await financeAccess(request,{session,write:true,workspace:false,country:country||order.country});
      await intent.save({session});if(saveOrder)await order.save({session});
      if(request)await writeAudit(request,'finance.payment_provider_verified',{targetType:'payment',targetPublicId:intent.publicId,country:order.country,metadata:{providerStatus:status,status:intent.status},session});
    });}finally{await session.endSession();}
  }
  if(status==='COMPLETED'){
    if(await Chargeback.exists({paymentIntentId:intent._id,status:{$in:['open','reviewing','lost']}}))throw new AppError('This reversed payment requires independent chargeback review before recovery.',409,'CHARGEBACK_REVIEW_REQUIRED');
    if((!amountMatches||!currencyMatches||!referenceMatches)&&['succeeded','partially_refunded','refunded','reversed'].includes(intent.status))throw new AppError('Pesapal evidence cannot overwrite a recorded financial outcome.',409,'PESAPAL_VERIFICATION_MISMATCH');
    if(!amountMatches||!currencyMatches||!referenceMatches){intent.status='failed';intent.activeKey=undefined;intent.failureCode='VERIFICATION_MISMATCH';intent.failureMessage='Pesapal amount, currency or merchant reference did not match the payment intent.';let saveOrder=false;if(['unpaid','pending'].includes(order.paymentState)){order.paymentState='failed';syncLegacyOrderStatus(order);order.timeline.push({type:'payment.failed',message:'Pesapal verification did not match the order.'});saveOrder=true;}await persistProviderOutcome(saveOrder);return paymentView(intent);}
    if(Number(intent.refundedMinor||0)>0||['partially_refunded','refunded'].includes(intent.status)){await persistProviderOutcome();return paymentView(intent);}
    await persistProviderOutcome();
    await commitOrderInventoryAndMoney(order,intent,{providerTrackingId:tracking,providerConfirmationCode:data.confirmation_code||'',providerPaymentMethod:data.payment_method||'',financeRequest:request,financeCountry:country||order.country});
    return paymentView(await PaymentIntent.findById(intent._id));
  }
  if(status==='FAILED'||status==='INVALID'){
    if(['succeeded','partially_refunded','refunded','reversed'].includes(intent.status)||Number(intent.refundedMinor||0)>0)throw new AppError('A failure status cannot overwrite an already captured or reversed payment. Review its financial evidence.',409,'PESAPAL_TERMINAL_STATUS_CONFLICT');
    intent.status='failed';intent.activeKey=undefined;intent.failureCode=`PESAPAL_${status}`;intent.failureMessage=String(data?.description||data?.message||`Pesapal reported ${status}.`).slice(0,400);
    let saveOrder=false;if(['unpaid','pending'].includes(order.paymentState)){order.paymentState='failed';syncLegacyOrderStatus(order);order.timeline.push({type:'payment.failed',message:`Pesapal reported ${status.toLowerCase()}.`});saveOrder=true;}
    await persistProviderOutcome(saveOrder);return paymentView(intent);
  }
  if(status==='REVERSED'){
    const { recordProviderChargeback }=await import('./chargebacks.js');
    await recordProviderChargeback({order,intent,providerPayload:data,financeRequest:request,providerOutcome:{lastVerifiedAt:intent.lastVerifiedAt,providerStatus:status,providerTrackingId:tracking,providerConfirmationCode:intent.providerConfirmationCode,providerPaymentMethod:intent.providerPaymentMethod,version:intent.__v||0}});
    return paymentView(await PaymentIntent.findById(intent._id));
  }
  // A later, duplicated PENDING status must never downgrade a captured/refunded payment.
  if(!terminalIntentStatuses.has(intent.status))intent.status='pending';await persistProviderOutcome();return paymentView(intent);
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


export async function requeueProviderEvent(request,eventPublicId,{reason,version}){
  const cleanReason=String(reason||'').trim();
  if(cleanReason.length<5||cleanReason.length>300)throw new AppError('Add a replay reason between 5 and 300 characters.',422,'PROVIDER_EVENT_REASON');
  const session=await mongoose.startSession();let result;
  try{await session.withTransaction(async()=>{
    const event=await ProviderEvent.findOne({publicId:eventPublicId,provider:PAYMENT_PROVIDER}).session(session);
    if(!event)throw new AppError('Provider event not found.',404,'PROVIDER_EVENT_NOT_FOUND');
    const intent=event.merchantReference?await PaymentIntent.findOne({provider:PAYMENT_PROVIDER,providerReference:event.merchantReference}).session(session):null;
    const order=intent?await Order.findById(intent.orderId).session(session):null;
    if(!intent||!order||intent.orderPublicId!==order.publicId||intent.country!==order.country||intent.currency!==order.totals.currency||intent.providerTrackingId!==event.providerTrackingId||(event.country&&event.country!==order.country))throw new AppError('Provider event cannot be replayed until its payment and country are independently matched.',409,'PROVIDER_EVENT_SCOPE_UNKNOWN');
    const context=await financeAccess(request,{session,write:true,workspace:false,country:order.country});
    if(request.requiredOperationalWorkspace==='admin'&&(!Number.isSafeInteger(version)||Number(event.__v||0)!==version))throw new AppError('This provider event changed. Reload before replaying it.',409,'ADMIN_COMMERCE_VERSION_CONFLICT');
    const updated=await ProviderEvent.findOneAndUpdate({_id:event._id,...(request.requiredOperationalWorkspace==='admin'?{__v:version}:{}),status:{$in:['failed','dead','ignored']},$or:[{lockedUntil:null},{lockedUntil:{$exists:false}},{lockedUntil:{$lte:new Date()}}]},{$set:{country:order.country,paymentIntentPublicId:intent.publicId,orderPublicId:order.publicId,status:'received',attempts:0,nextAttemptAt:new Date(),lockedBy:'',lockedUntil:null,processedAt:null,error:'',lastManualReplayAt:new Date(),lastManualReplayByUserId:context.actor._id,manualReplayReason:cleanReason},$inc:{manualReplayCount:1,__v:1}},{session,returnDocument:'after'});
    if(!updated)throw new AppError('Provider event is no longer eligible for replay.',409,'PROVIDER_EVENT_STATE');
    await writeAudit(request,'finance.provider_event_requeued',{actor:context.actor,targetType:'provider_event',targetPublicId:updated.publicId,country:order.country,metadata:{reason:cleanReason,replayCount:updated.manualReplayCount},session});
    result=updated;
  });return result;}finally{await session.endSession();}
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

async function failRefundAndReleaseReservation(refundId,{providerStatus='REJECTED',providerMessage='',failureMessage='',request=null }={}){
  const session=await mongoose.startSession();let failed;
  try{await session.withTransaction(async()=>{
    const refund=await Refund.findById(refundId).session(session);if(!refund)throw new AppError('Refund not found.',404,'REFUND_NOT_FOUND');
    if(refund.status==='failed'||refund.status==='cancelled'){failed=refund;return;}
    if(refund.status==='completed')throw new AppError('Completed refund reservation cannot be released.',409,'REFUND_ALREADY_COMPLETED');
    const intent=await PaymentIntent.findOneAndUpdate({_id:refund.paymentIntentId,refundReservedMinor:{$gte:refund.amountMinor}},{$inc:{refundReservedMinor:-refund.amountMinor,__v:1}},{session,returnDocument:'after'});
    if(!intent)throw new AppError('Refund reservation counter is inconsistent; manual reconciliation is required.',409,'REFUND_COUNTER_CONFLICT');
    refund.status='failed';refund.providerStatus=String(providerStatus||'REJECTED').slice(0,120);refund.providerMessage=String(providerMessage||'').slice(0,400);refund.failureMessage=String(failureMessage||providerMessage||'Refund failed.').slice(0,400);await refund.save({session});
    const order=await Order.findById(refund.orderId).session(session);if(order)await syncRefundStateAfterReservationRelease(order,intent,session);
    if(request&&order){await writeAudit(request,'finance.refund_submission_failed',{targetType:'refund',targetPublicId:refund.publicId,country:order.country,metadata:{provider:refund.provider,status:refund.status},session});await queueFinanceAlert({country:order.country,kind:'escalation',href:'/finance/refunds?record='+encodeURIComponent(refund.publicId)},session);}
    failed=refund;
  });return failed;}finally{await session.endSession();}
}

async function refundActorAccess(request,order,session,{write=false,financeRequired=false}={}){
  const actor=request.user?._id?await User.findById(request.user._id).select('+operationalCountries').session(session):null;
  if(actor&&(!['active'].includes(actor.status)||actor.security.tokenVersion!==request.user.security?.tokenVersion||(request.session?.tokenVersion!==undefined&&actor.security.tokenVersion!==request.session.tokenVersion)))throw new AppError('Your account or session is unavailable.',403,'ACCOUNT_UNAVAILABLE');
  if(actor)await hydratePlatformAuthorization(actor);
  const financial=financeRequired||['finance','country_admin','super_admin'].includes(request.user?.role)||['finance','country_admin','super_admin'].includes(actor?.role);
  if(financial)return {...await financeAccess(request,{session,write,workspace:false,country:order.country}),finance:true};
  const ownedByUser=Boolean(actor&&order.userId&&String(order.userId)===String(actor._id));
  const ownedByGuest=Boolean(!request.user?._id&&request.session?.cartKey&&order.sessionKey===request.session.cartKey);
  if(!ownedByUser&&!ownedByGuest)throw new AppError('You cannot refund this order.',403,'ORDER_SCOPE');
  if(order.fulfillmentState!=='cancelled'||order.cancellationState!=='processing'||!order.cancellation?.requestedAt)throw new AppError('Customer refunds require an authorized pre-fulfilment cancellation.',403,'REFUND_CANCELLATION_REQUIRED');
  if(write&&actor){const fenced=await User.updateOne({_id:actor._id,status:'active',__v:actor.__v||0,'security.tokenVersion':actor.security.tokenVersion},{$inc:{__v:1}},{session});if(fenced.modifiedCount!==1)throw new AppError('Your account changed. Retry with a current session.',409,'ACCOUNT_CHANGED');}
  return {actor,finance:false};
}

const refundAllocationSnapshot=rows=>rows.map(row=>({storePublicId:String(row.storePublicId||''),productPublicId:String(row.productPublicId||''),orderLineId:String(row.orderLineId||''),grossMinor:Number(row.grossMinor)})).sort((a,b)=>(a.storePublicId+':'+a.orderLineId).localeCompare(b.storePublicId+':'+b.orderLineId));
async function inspectedReturnSnapshot(returnRequest,order,session,statuses){
  const {returnFinancialAllocations}=await import('./support-case-pages.js');
  return returnFinancialAllocations({returnRequest,order,session,statuses});
}

function assertAdminIndependentReturnActor(request,returned,actor) {
  if(request.requiredOperationalWorkspace!=='admin')return;
  if(!returned)throw new AppError('Country Admin refunds require an inspected return.',409,'RETURN_REFUND_BINDING_REQUIRED');
  if([returned.inspection?.inspectedByUserId,returned.financeReferral?.requestedByUserId].some(value=>value&&String(value)===String(actor._id)))
    throw new AppError('A different operator must independently review the inspected return refund.',403,'FOUR_EYES_REQUIRED');
}

async function fenceAdminReturnFinancialSources(request,returned,order,session) {
  if(request.requiredOperationalWorkspace!=='admin')return;
  for(const item of returned.items){
    const task=await WarehouseTask.findOne({publicId:item.warehouseTaskPublicId,type:'return_inspection',status:'completed',returnRequestId:returned._id,orderId:order._id,returnOrderLineId:item.orderLineId,storeId:item.storeId,variantId:item.variantId,quantity:item.quantity,'result.disposition':item.stockDisposition}).session(session).lean();
    const warehouse=task?await Warehouse.findOne({_id:task.warehouseId,country:returned.country,storeId:item.storeId}).session(session).lean():null;
    if(!task||!warehouse)throw new AppError('The inspected return source changed.',409,'RETURN_FINANCE_SNAPSHOT_INVALID');
    const taskFence=await WarehouseTask.updateOne({_id:task._id,__v:task.__v||0,status:'completed',type:'return_inspection',quantity:item.quantity,'result.disposition':item.stockDisposition},{$inc:{__v:1}},{session});
    const warehouseFence=await Warehouse.updateOne({_id:warehouse._id,__v:warehouse.__v||0,country:returned.country,storeId:item.storeId},{$inc:{__v:1}},{session});
    if(taskFence.modifiedCount!==1||warehouseFence.modifiedCount!==1)throw new AppError('The inspected return source changed.',409,'RETURN_FINANCE_SNAPSHOT_INVALID');
    if(returned.returnMethod==='dropoff'){
      const receipt=await EvidenceDocument.findOne({publicId:item.intakeEvidencePublicId,ownerUserId:item.intakeReceivedByUserId,country:returned.country,contextType:'return',contextPublicId:returned.publicId,contextLinePublicId:item.orderLineId,documentType:'return_receipt',status:'ready'}).session(session).lean();
      if(!receipt)throw new AppError('The return receipt changed.',409,'RETURN_FINANCE_SNAPSHOT_INVALID');
      const receiptFence=await EvidenceDocument.updateOne({_id:receipt._id,__v:receipt.__v||0,status:'ready',contextType:'return',contextPublicId:returned.publicId,contextLinePublicId:item.orderLineId,country:returned.country},{$inc:{refundEvidenceReadRevision:1}},{session});
      if(receiptFence.modifiedCount!==1)throw new AppError('The return receipt changed.',409,'RETURN_FINANCE_SNAPSHOT_INVALID');
    }
  }
  if(returned.returnMethod==='pickup'){
    const shipment=await Shipment.findOne({publicId:returned.returnShipmentPublicId,returnRequestId:returned._id,orderId:order._id,country:returned.country,kind:'return',status:'delivered',deliveredAt:mongoose.trusted({$type:'date'}),'proof.reference':'verified'}).session(session).lean();
    if(!shipment)throw new AppError('The return pickup proof changed.',409,'RETURN_FINANCE_SNAPSHOT_INVALID');
    const shipmentFence=await Shipment.updateOne({_id:shipment._id,__v:shipment.__v||0,status:'delivered','proof.reference':'verified'},{$inc:{__v:1}},{session});
    if(shipmentFence.modifiedCount!==1)throw new AppError('The return pickup proof changed.',409,'RETURN_FINANCE_SNAPSHOT_INVALID');
  }
}

async function reserveRefund(request,{orderId,amountMinor,reason,idempotencyKey,allocations=[],version,returnPublicId,returnVersion}){
  if(typeof orderId!=='string'||orderId.length<4||orderId.length>100||typeof idempotencyKey!=='string'||idempotencyKey.length<12||idempotencyKey.length>120||typeof reason!=='string'||reason.trim().length<3||reason.trim().length>300)throw new AppError('Provide a valid order, reason and request key.',422,'REFUND_INPUT_INVALID');
  if(amountMinor!==undefined&&(!Number.isSafeInteger(amountMinor)||amountMinor<=0))throw new AppError('Enter a positive refund amount in minor units.',422,'REFUND_AMOUNT_INVALID');
  if(version!==undefined&&(!Number.isSafeInteger(version)||version<0))throw new AppError('Provide the current payment version.',422,'REFUND_VERSION_INVALID');
  if(!Array.isArray(allocations)||allocations.length>100)throw new AppError('Provide supported order-line allocations.',422,'REFUND_ALLOCATION_INVALID');
  if(returnPublicId!==undefined&&(typeof returnPublicId!=='string'||!/^ret_[a-zA-Z0-9_-]{1,95}$/.test(returnPublicId)))throw new AppError('Provide a valid inspected return.',422,'RETURN_REFUND_INPUT_INVALID');
  if(returnPublicId!==undefined&&(!Number.isSafeInteger(returnVersion)||returnVersion<0))throw new AppError('Provide the current return version.',422,'RETURN_REFUND_VERSION_INVALID');
  if((returnPublicId!==undefined&&idempotencyKey!==`return-refund:${returnPublicId}`)||(returnPublicId===undefined&&idempotencyKey.startsWith('return-refund:')))throw new AppError('The return refund request key must identify its inspected return.',422,'RETURN_REFUND_KEY_INVALID');
  const session=await mongoose.startSession();let result;
  try{await session.withTransaction(async()=>{
    const order=await Order.findOne({publicId:orderId}).session(session);if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');
    const access=await refundActorAccess(request,order,session,{write:true,financeRequired:Boolean(returnPublicId)});
    if(!access.finance&&idempotencyKey!==`cancel:${order.publicId}`)throw new AppError('Customer refund keys must match the authorized cancellation.',403,'REFUND_CANCELLATION_REQUIRED');
    const existing=await Refund.findOne({idempotencyKey}).session(session);
    let returned=null,returnSnapshot=null;
    if(returnPublicId){
      returned=await ReturnRequest.findOne({publicId:returnPublicId,orderId:order._id,orderPublicId:order.publicId,country:order.country,userId:order.userId}).session(session);
      if(!returned)throw new AppError('Return not found for this scoped order.',404,'RETURN_NOT_FOUND');
      if(existing){
        if(String(existing.returnRequestId||'')!==String(returned._id)||existing.returnPublicId!==returnPublicId||returned.refundPublicId!==existing.publicId||!['refund_processing','refunded'].includes(returned.status)||(returned.status==='refunded')!==(existing.status==='completed'))throw new AppError('The saved refund does not match this return.',409,'RETURN_REFUND_BINDING_CONFLICT');
        returnSnapshot=await inspectedReturnSnapshot(returned,order,session,['refund_processing','refunded']);
      }else{
        if(Number(returned.__v||0)!==returnVersion)throw new AppError('The return changed. Reload before recording its refund.',409,'RETURN_REFUND_VERSION_CONFLICT');
        if(returned.refundPublicId)throw new AppError('This return already has a reserved refund.',409,'RETURN_REFUND_BINDING_CONFLICT');
        returnSnapshot=await inspectedReturnSnapshot(returned,order,session,['refund_pending']);
      }
      if((amountMinor!==undefined&&amountMinor!==returnSnapshot.amountMinor)||(allocations.length&&JSON.stringify(refundAllocationSnapshot(allocations))!==JSON.stringify(refundAllocationSnapshot(returnSnapshot.allocations))))throw new AppError('Return refunds must match the exact inspected amount and order lines.',409,'RETURN_REFUND_ALLOCATION_MISMATCH');
      amountMinor=returnSnapshot.amountMinor;allocations=returnSnapshot.allocations;
    }
    assertAdminIndependentReturnActor(request,returned,access.actor);
    await fenceAdminReturnFinancialSources(request,returned,order,session);
    if(existing){
      const requestedAllocations=allocations.map(row=>({storePublicId:row.storePublicId,orderLineId:row.orderLineId,grossMinor:row.grossMinor})).sort((a,b)=>(a.storePublicId+':'+a.orderLineId).localeCompare(b.storePublicId+':'+b.orderLineId));
      const savedAllocations=(existing.allocations||[]).map(row=>({storePublicId:row.storePublicId,orderLineId:row.orderLineId,grossMinor:row.grossMinor})).sort((a,b)=>(a.storePublicId+':'+a.orderLineId).localeCompare(b.storePublicId+':'+b.orderLineId));
      if(String(existing.orderId)!==String(order._id)||String(existing.requestedByUserId||'')!==String(access.actor?._id||'')||existing.reason!==reason.trim()||(amountMinor!==undefined&&existing.amountMinor!==amountMinor)||JSON.stringify(requestedAllocations)!==JSON.stringify(savedAllocations)||Boolean(existing.returnRequestId)!==Boolean(returnPublicId))throw new AppError('This request key already identifies another refund.',409,'REFUND_IDEMPOTENCY_CONFLICT');
      result={refund:existing,order,intent:await PaymentIntent.findById(existing.paymentIntentId).session(session),existing:true};return;
    }
    if(!['paid','partially_refunded','refunded'].includes(order.paymentState))throw new AppError('Only a verified paid order can be refunded.',409,'REFUND_ORDER_STATE');
    const intent=await PaymentIntent.findOne({orderId:order._id,orderPublicId:order.publicId,country:order.country,currency:order.totals.currency,status:{$in:['succeeded','partially_refunded','refunded']}}).sort({paidAt:-1}).session(session);
    if(!intent)throw new AppError('Verified payment record not found.',409,'REFUND_PAYMENT_MISSING');
    if(!['pesapal','cod','wallet'].includes(intent.provider))throw new AppError('This payment provider cannot issue a financial refund.',409,'REFUND_PROVIDER_UNSUPPORTED');
    if(version!==undefined&&Number(intent.__v||0)!==version)throw new AppError('The original payment changed. Reload before refunding.',409,'REFUND_VERSION_CONFLICT');
    if(intent.provider===PAYMENT_PROVIDER&&!intent.providerConfirmationCode)throw new AppError('Pesapal confirmation code is missing; reconcile the payment before refunding.',409,'PESAPAL_CONFIRMATION_REQUIRED');
    if(await Chargeback.exists({paymentIntentId:intent._id,status:{$in:['open','reviewing','lost']}}).session(session))throw new AppError('This payment has an open or lost chargeback and cannot be refunded.',409,'REFUND_CHARGEBACK_BLOCKED');
    const counters=await assertRefundCounterConsistency(intent,session);
    const reservedRefundMinor=counters.reserved,refundedMinor=counters.completed,capturedMinor=counters.captured;
    const available=Math.max(0,capturedMinor-reservedRefundMinor-refundedMinor),amount=amountMinor??available;if(!Number.isSafeInteger(amount)||amount<=0||amount>available)throw new AppError('The refund exceeds the remaining refundable balance.',409,'REFUND_EXHAUSTED');
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
        const storePublicId=String(raw.storePublicId||'').trim(),productPublicId=String(raw.productPublicId||'').trim(),orderLineId=String(raw.orderLineId||'').trim(),grossMinor=Number(raw.grossMinor||0);
        if(!storePublicId||!orderLineId||!Number.isSafeInteger(grossMinor)||grossMinor<=0)throw new AppError('Refund allocation must identify an immutable order line and a positive integer amount.',422,'REFUND_ALLOCATION_INVALID');
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
    let provider=intent.provider==='cod'?'cod_manual':PAYMENT_PROVIDER;if(intent.provider==='wallet')provider='wallet';
    if(provider===PAYMENT_PROVIDER){
      const priorProvider=await Refund.exists({paymentIntentId:intent._id,provider:PAYMENT_PROVIDER,status:{$in:['pending','processing','completed']}}).session(session);
      const card=/card|visa|master|amex/i.test(String(intent.providerPaymentMethod||''));
      if(priorProvider||(!card&&amount<available))provider='external_manual';
    }
    const reservedIntent=await PaymentIntent.findOneAndUpdate({_id:intent._id,refundReservedMinor:reservedRefundMinor,refundedMinor,$expr:{$lte:[{$add:[{$ifNull:['$refundReservedMinor',0]},{$ifNull:['$refundedMinor',0]},amount]},'$amountMinor']}},{$inc:{refundReservedMinor:amount,__v:1}},{session,returnDocument:'after'});
    if(!reservedIntent)throw new AppError('Another refund changed the remaining refundable balance. Reload and retry with the current balance.',409,'REFUND_RESERVATION_CONFLICT');
    const docs=await Refund.create([{publicId:publicId('rfd'),idempotencyKey,orderId:order._id,paymentIntentId:intent._id,...(returned?{returnRequestId:returned._id,returnPublicId:returned.publicId}:{}),amountMinor:amount,currency:order.totals.currency,reason:reason.trim(),allocations:cleanAllocations,provider,requestedByUserId:request.user?._id,status:provider===PAYMENT_PROVIDER?'pending':'processing'}],{session});
    if(returned){returned.refundPublicId=docs[0].publicId;returned.status='refund_processing';returned.timeline.push({type:'return.refund_reserved',message:`Refund ${docs[0].publicId} reserved after the inspected return review. Disbursement is awaiting confirmation.`,actorUserId:access.actor._id});await returned.save({session});}
    await writeAudit(request,'finance.refund_reserved',{actor:access.actor,targetType:'refund',targetPublicId:docs[0].publicId,country:order.country,metadata:{amountMinor:amount,currency:order.totals.currency,provider},session});
    await queueFinanceAlert({country:order.country,kind:'priority',href:'/finance/refunds?record='+encodeURIComponent(docs[0].publicId)},session);
    order.refundState=provider===PAYMENT_PROVIDER?'pending':'processing';
    if(order.cancellationState==='requested')order.cancellationState='processing';
    syncLegacyOrderStatus(order);await order.save({session});
    result={refund:docs[0],order,intent:reservedIntent,existing:false};
  });return result;}finally{await session.endSession();}
}

async function persistRefundSubmission(request,refundLike) {
  if(request.requiredOperationalWorkspace!=='admin'){await refundLike.save();return refundLike;}
  const session=await mongoose.startSession();let result;
  try{await session.withTransaction(async()=>{
    const current=await Refund.findById(refundLike._id).session(session),order=current?await Order.findById(current.orderId).session(session):null;
    if(!current||!order||Number(current.__v||0)!==Number(refundLike.__v||0)||!['pending','processing'].includes(current.status))throw new AppError('The submitted refund changed. Reconcile its actual provider outcome.',409,'REFUND_STATE_CONFLICT');
    const access=await financeAccess(request,{session,write:true,workspace:false,country:order.country});
    const returned=await ReturnRequest.findOne({_id:current.returnRequestId,publicId:current.returnPublicId,orderId:order._id,orderPublicId:order.publicId,userId:order.userId,country:order.country,refundPublicId:current.publicId,status:'refund_processing'}).session(session);
    assertAdminIndependentReturnActor(request,returned,access.actor);
    const snapshot=await inspectedReturnSnapshot(returned,order,session,['refund_processing']);
    if(snapshot.amountMinor!==current.amountMinor||current.currency!==order.totals.currency||JSON.stringify(refundAllocationSnapshot(snapshot.allocations))!==JSON.stringify(refundAllocationSnapshot(current.allocations)))throw new AppError('The provider submission no longer matches its inspected return.',409,'RETURN_REFUND_ALLOCATION_MISMATCH');
    await fenceAdminReturnFinancialSources(request,returned,order,session);
    const returnFence=await ReturnRequest.updateOne({_id:returned._id,__v:returned.__v||0,status:'refund_processing',refundPublicId:current.publicId},{$inc:{__v:1}},{session});
    if(returnFence.modifiedCount!==1)throw new AppError('The submitted refund return changed.',409,'RETURN_REFUND_VERSION_CONFLICT');
    for(const key of ['status','providerRefundId','providerStatus','providerMessage'])current[key]=refundLike[key];await current.save({session});
    await writeAudit(request,'admin.refund_provider_submission_recorded',{actor:access.actor,targetType:'refund',targetPublicId:current.publicId,country:order.country,metadata:{status:current.status},session});result=current;
  });return result;}finally{await session.endSession();}
}

export async function createRefund(request,input){
  const {refund,order,intent,existing}=await reserveRefund(request,input);
  // Wallet completion is local and ledger-idempotent. Resume it after a rolled
  // back accounting attempt; never repeat an external provider submission.
  if(existing&&(refund.provider!=='wallet'||refund.status!=='processing'))return refund;
  if(refund.provider==='wallet'){
    refund.status='completed';refund.completedAt=new Date();refund.completedByUserId=request.user?._id;refund.providerRefundId=`wallet:${refund.publicId}`;refund.providerStatus='COMPLETED';refund.providerMessage='Refund returned to Classic Wallet.';
    await postRefundLedger(order,refund,intent,{request});
    return Refund.findById(refund._id);
  }
  if(refund.provider!=='pesapal')return refund;
  try{
    if(request.requiredOperationalWorkspace==='admin')await financeAccess(request,{workspace:false,country:order.country});
    const payload=await requestPesapalRefund({confirmationCode:intent.providerConfirmationCode,amount:major(refund.amountMinor,refund.currency),username:request.user?.name||request.user?.email||'Classic Mart Finance',remarks:refund.reason});
    refund.providerRefundId=String(intent.providerConfirmationCode);refund.providerStatus=String(payload?.status||'');refund.providerMessage=String(payload?.message||'').slice(0,400);
    if(String(payload?.status)==='200'||Number(payload?.error)===200){refund.status='processing';return await persistRefundSubmission(request,refund);}
    const message=refund.providerMessage||'Pesapal rejected the refund request.';await failRefundAndReleaseReservation(refund._id,{providerStatus:refund.providerStatus||'REJECTED',providerMessage:message,failureMessage:message,request});throw new AppError(message,409,'PESAPAL_REFUND_REJECTED');
  }catch(error){
    if(error?.code==='PESAPAL_REFUND_REJECTED')throw error;
    if(request.requiredOperationalWorkspace==='admin'&&(!error?.ambiguous||[401,403].includes(error.status))&&error?.code!=='PESAPAL_REQUEST_FAILED')throw error;
    if(error?.ambiguous){refund.status='processing';refund.providerStatus='UNKNOWN';refund.providerMessage='Pesapal refund submission outcome is unknown. Do not resubmit; reconcile in the Pesapal merchant portal.';return await persistRefundSubmission(request,refund);}
    const message=String(error.message||'Pesapal refund failed.').slice(0,400);await failRefundAndReleaseReservation(refund._id,{providerStatus:'REJECTED',providerMessage:message,failureMessage:message,request});throw error;
  }
}

export async function completeManualRefund(request,refundPublicId,{reference,version}){
  if(typeof reference!=='string'||reference.trim().length<4||reference.trim().length>180)throw new AppError('Enter the verified refund/disbursement reference.',422,'REFUND_REFERENCE_REQUIRED');
  if(version!==undefined&&(!Number.isSafeInteger(version)||version<0))throw new AppError('Provide the current refund version.',422,'REFUND_VERSION_INVALID');
  const refund=await Refund.findOne({publicId:refundPublicId,provider:{$in:['cod_manual','external_manual','pesapal']},status:{$in:['processing','completed']}});
  if(!refund)throw new AppError('Pending refund not found.',404,'REFUND_NOT_FOUND');
  const order=await Order.findById(refund.orderId);if(!order)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');await financeAccess(request,{workspace:false,country:order.country});
  if(refund.requestedByUserId?.equals(request.user._id))throw new AppError('A different finance operator must confirm refund disbursement.',403,'FOUR_EYES_REQUIRED');
  const intent=await PaymentIntent.findById(refund.paymentIntentId);if(!intent)throw new AppError('Payment record not found.',409,'REFUND_PAYMENT_MISSING');
  refund.manualReference=String(reference||'').trim();if(refund.manualReference.length<4)throw new AppError('Enter the verified refund/disbursement reference.',422,'REFUND_REFERENCE_REQUIRED');
  refund.status='completed';refund.completedAt=new Date();refund.completedByUserId=request.user._id;refund.providerRefundId=refund.providerRefundId||`${refund.provider}:${refund.manualReference}`;refund.providerStatus='COMPLETED';
  await postRefundLedger(order,refund,intent,{request,manual:true,version});return Refund.findById(refund._id);
}

async function postRefundLedger(orderLike,refundLike,intentLike,{request,manual=false,version}={}){
  const session=await mongoose.startSession();
  try{await session.withTransaction(async()=>{
    const order=await Order.findById(orderLike._id).session(session),loadedIntent=await PaymentIntent.findById(intentLike._id).session(session),refund=await Refund.findById(refundLike._id).session(session);
    if(!order||!loadedIntent||!refund)throw new AppError('Refund accounting records are incomplete.',409,'REFUND_ACCOUNTING_MISSING');
    if(!request)throw new AppError('Refund accounting requires an authorized actor.',403,'UNAUTHENTICATED');
    const access=await refundActorAccess(request,order,session,{write:true,financeRequired:manual});
    if(String(refund.paymentIntentId)!==String(loadedIntent._id)||String(loadedIntent.orderId)!==String(order._id)||loadedIntent.orderPublicId!==order.publicId||loadedIntent.country!==order.country||loadedIntent.currency!==order.totals.currency||refund.currency!==order.totals.currency)throw new AppError('Refund accounting references do not match.',409,'REFUND_ACCOUNTING_MISMATCH');
    if(manual&&String(refund.requestedByUserId)===String(access.actor._id))throw new AppError('A different finance operator must confirm refund disbursement.',403,'FOUR_EYES_REQUIRED');
    let returnRequest=null;
    if(refund.returnRequestId||refund.returnPublicId){
      if(!refund.returnRequestId||!refund.returnPublicId)throw new AppError('The return refund binding is incomplete.',409,'RETURN_REFUND_BINDING_CONFLICT');
      returnRequest=await ReturnRequest.findOne({_id:refund.returnRequestId,publicId:refund.returnPublicId,orderId:order._id,orderPublicId:order.publicId,country:order.country,userId:order.userId,refundPublicId:refund.publicId}).session(session);
      if(!returnRequest)throw new AppError('The refund is no longer bound to its inspected return.',409,'RETURN_REFUND_BINDING_CONFLICT');
      const snapshot=await inspectedReturnSnapshot(returnRequest,order,session,['refund_processing','refunded']);
      if(snapshot.amountMinor!==refund.amountMinor||JSON.stringify(refundAllocationSnapshot(snapshot.allocations))!==JSON.stringify(refundAllocationSnapshot(refund.allocations)))throw new AppError('The reserved refund no longer matches its inspected returned goods.',409,'RETURN_REFUND_ALLOCATION_MISMATCH');
    }else if(await ReturnRequest.exists({refundPublicId:refund.publicId}).session(session))throw new AppError('This historical return refund needs an authoritative immutable return binding before completion.',409,'RETURN_REFUND_BINDING_REQUIRED');
    assertAdminIndependentReturnActor(request,returnRequest,access.actor);
    await fenceAdminReturnFinancialSources(request,returnRequest,order,session);
    if(manual&&request.requiredOperationalWorkspace==='admin'){
      const evidence=await EvidenceDocument.findOne({publicId:request.requiredRefundEvidencePublicId||'',_id:mongoose.trusted({$in:returnRequest.evidenceDocumentIds}),ownerUserId:access.actor._id,country:order.country,
        contextType:'return',contextPublicId:returnRequest.publicId,refundPublicId:refund.publicId,documentType:'refund_disbursement',status:'ready'}).session(session).lean();
      if(!evidence)throw new AppError('Ready attached disbursement evidence is required for this exact inspected refund.',422,'REFUND_EVIDENCE_REQUIRED');
      const fenced=await EvidenceDocument.updateOne({_id:evidence._id,__v:evidence.__v||0,ownerUserId:access.actor._id,country:order.country,contextType:'return',contextPublicId:returnRequest.publicId,refundPublicId:refund.publicId,documentType:'refund_disbursement',status:'ready'},{$inc:{refundEvidenceReadRevision:1}},{session});
      if(fenced.modifiedCount!==1)throw new AppError('Refund disbursement evidence changed. Reload before completing it.',409,'REFUND_EVIDENCE_CHANGED');
    }
    if(await LedgerTransaction.exists({idempotencyKey:`refund:${refundLike.publicId}`}).session(session)){
      if(refund.status!=='completed')throw new AppError('Refund outcome and recorded accounting do not match. Reconcile this case before continuing.',409,'REFUND_ACCOUNTING_MISMATCH');
      if(manual&&(refund.manualReference!==refundLike.manualReference||String(refund.completedByUserId)!==String(access.actor._id)))throw new AppError('This refund was completed with different evidence.',409,'REFUND_COMPLETION_CONFLICT');
      if(returnRequest&&returnRequest.status!=='refunded')throw new AppError('Recorded return and refund accounting are inconsistent. Reconcile this case before continuing.',409,'RETURN_REFUND_BINDING_CONFLICT');
      return;
    }
    if(refundLike.status!=='completed')throw new AppError('A verified completed refund outcome is required before accounting.',409,'REFUND_OUTCOME_REQUIRED');
    if(returnRequest&&returnRequest.status!=='refund_processing')throw new AppError('The return is no longer awaiting this reserved refund.',409,'RETURN_REFUND_BINDING_CONFLICT');
    if(!['pending','processing'].includes(refund.status)||(manual&&refund.status!=='processing'))throw new AppError('This refund is no longer available for completion.',409,'REFUND_STATE_CONFLICT');
    if(version!==undefined&&Number(refund.__v||0)!==version)throw new AppError('The refund changed. Reload before completion.',409,'REFUND_VERSION_CONFLICT');
    await assertRefundCounterConsistency(loadedIntent,session);
    let intent=await PaymentIntent.findOneAndUpdate({_id:loadedIntent._id,refundReservedMinor:{$gte:refund.amountMinor},$expr:{$lte:[{$add:[{$ifNull:['$refundedMinor',0]},refund.amountMinor]},'$amountMinor']}},{$inc:{refundReservedMinor:-refund.amountMinor,refundedMinor:refund.amountMinor,__v:1}},{session,returnDocument:'after'});
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
    if(intent.provider==='wallet'){
      const customer=order.userId?await User.findById(order.userId).select('publicId').session(session).lean():null;if(!customer)throw new AppError('Classic Wallet customer record is missing.',409,'WALLET_CUSTOMER_MISSING');
      const wallet=await ensureLedgerAccount({code:'customer_wallet',type:'liability',ownerType:'customer',ownerId:order.userId,ownerPublicId:customer.publicId,country:order.country,currency:order.totals.currency},session);entries.push({account:wallet,debitMinor:0,creditMinor:refund.amountMinor,memo:'Classic Wallet refund credit'});
    }else{
      const clearing=await ensureLedgerAccount({code:intent.provider==='cod'?'cod_clearing':'provider_clearing',type:'asset',ownerType:intent.provider==='cod'?'platform':'provider',ownerPublicId:intent.provider==='cod'?'classic-mart':PAYMENT_PROVIDER,country:order.country,currency:order.totals.currency},session);entries.push({account:clearing,debitMinor:0,creditMinor:refund.amountMinor,memo:intent.provider==='cod'?'COD refund disbursed':'Customer refund'});
    }
    await postLedgerTransaction({idempotencyKey:`refund:${refund.publicId}`,referenceType:'refund',referencePublicId:refund.publicId,currency:refund.currency,country:order.country,description:`Refund for ${order.publicId}`,entries},session);
    await writeAudit(request,'finance.refund_completed',{actor:access.actor,targetType:'refund',targetPublicId:refund.publicId,country:order.country,metadata:{amountMinor:refund.amountMinor,currency:refund.currency,manual},session});
    const previous=await Refund.aggregate([{$match:{orderId:order._id,status:'completed',_id:{$ne:refund._id}}},{$group:{_id:null,total:{$sum:'$amountMinor'}}}]).session(session);const completedMinor=Number(previous[0]?.total||0)+refund.amountMinor,fully=completedMinor>=order.totals.totalMinor;
    intent.status=fully?'refunded':'partially_refunded';order.paymentState=fully?'refunded':'partially_refunded';order.refundState=fully?'complete':'partial';if(order.fulfillmentState==='cancelled'&&order.cancellation?.requestedAt)order.cancellationState='cancelled';syncLegacyOrderStatus(order);await intent.save({session});order.timeline.push({type:'refund.completed',message:`Refund ${refund.publicId} completed.`});
    if(fully||!allocations.length)await SellerOrder.updateMany({orderId:order._id},{$set:{status:fully?'refunded':'partially_refunded'},$push:{timeline:{type:'refund.completed',message:`Refund ${refund.publicId} applied to marketplace order.`}}},{session});else if(affectedStores.size)await SellerOrder.updateMany({orderId:order._id,storePublicId:{$in:[...affectedStores]}},{$set:{status:'partially_refunded'},$push:{timeline:{type:'refund.completed',message:`Item refund ${refund.publicId} applied to this seller order.`}}},{session});
    if(returnRequest){
      for(const returned of returnRequest.items||[]){const line=order.items.find(item=>String(item.linePublicId)===String(returned.orderLineId));if(!line)throw new AppError('Refunded return references a missing order line.',409,'REFUND_ORDER_LINE_MISSING');const next=Number(line.refundedQuantity||0)+Number(returned.quantity||0);if(next>Number(line.returnedQuantity||0))throw new AppError('Refunded quantity exceeds physically returned quantity.',409,'REFUND_QUANTITY_CONFLICT');line.refundedQuantity=next;}
      returnRequest.status='refunded';returnRequest.timeline.push({type:'return.refunded',message:`Refund ${refund.publicId} completed and returned quantities were financially settled.`,actorUserId:access.actor?._id});await returnRequest.save({session});
      await SellerReturnCase.updateMany({returnRequestId:returnRequest._id,returnPublicId:returnRequest.publicId,orderPublicId:order.publicId,country:order.country,status:{$ne:'resolved'}},{$set:{status:'resolved'},$push:{timeline:{type:'seller_return.resolved',message:`Refund ${refund.publicId} completed.`}}},{session});
      await Notification.create([{publicId:publicId('ntf'),userId:returnRequest.userId,country:order.country,type:'return_update',title:'Return refund completed',body:`${returnRequest.publicId}: Refund ${refund.publicId} is confirmed and your returned goods have been financially settled.`,href:'/returns'}],{session});
      await writeAudit(request,'finance.return_refund_completed',{actor:access.actor,targetType:'return',targetPublicId:returnRequest.publicId,country:order.country,metadata:{refundPublicId:refund.publicId,amountMinor:refund.amountMinor,currency:refund.currency},session});
    }
    const { reverseOrderCommissions }=await import('./promoters.js');await reverseOrderCommissions(order,refund,session);
    const { issueRefundCreditNote }=await import('./financial-documents.js');await issueRefundCreditNote(order,refund,intent,session);
    await refund.save({session});await order.save({session});await refreshOrderLifecycle(order._id,{session});
  });}finally{await session.endSession();}
}

/** Personal Promoter funds follow the programme market, independently of shopping preferences. */
export async function pinnedPromoterMarket(user, { session = null, write = false } = {}) {
  const verification = await PromoterVerification.findOne({ userId: user._id }).select('country status').session(session).lean();
  const countryCode = String(verification?.country || user.country || '').toUpperCase();
  const country = await CountrySetting.findOne({ code: countryCode, active: true }).select('code currency timeZone').session(session).lean();
  if (!country) throw new AppError('Your promoter programme market is unavailable.', 409, 'PROMOTER_COUNTRY_UNAVAILABLE');
  if (write) {
    if (verification) await PromoterVerification.updateOne({ _id: verification._id, country: verification.country }, { $inc: { __v: 1 } }, { session });
    await CountrySetting.updateOne({ _id: country._id, active: true, currency: country.currency }, { $inc: { __v: 1 } }, { session });
  }
  return { country: country.code, currency: country.currency, timeZone: country.timeZone };
}

async function promoterPayoutActor(request, session = null) {
  const actor = await User.findById(request.user?._id).select('status role country currency security.tokenVersion emailVerifiedAt onboardingCompletedAt platformAccessManagedAt').session(session);
  if (actor) await hydratePlatformAuthorization(actor);
  if (!actor || actor.status !== 'active' || actor.role !== 'promoter' || actor.security.tokenVersion !== request.user?.security?.tokenVersion
    || primaryWorkspaceFor(actor) !== 'promoter'
    || (request.session?.tokenVersion !== undefined && request.session.tokenVersion !== actor.security.tokenVersion)) {
    throw new AppError('Your promoter account or session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
  }
  if (!env.auth.simpleLogin && (!actor.emailVerifiedAt || !actor.onboardingCompletedAt)) throw new AppError('Complete account verification and onboarding first.', 403, 'ACCOUNT_UNAVAILABLE');
  if (request.sessionID) {
    const device = await Device.findOne({ userId: actor._id, sessionHash: hashToken(request.sessionID), revokedAt: null }).select('_id').session(session).lean();
    if (!device) throw new AppError('Your account session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
    if (session?.inTransaction()) await Device.updateOne({ _id: device._id, revokedAt: null }, { $inc: { __v: 1 } }, { session });
  }
  return actor;
}

export function publicPayoutAccount(account) {
  return { publicId: account.publicId, ownerType: account.ownerType, country: account.country, currency: account.currency, method: account.method,
    label: account.label, status: account.status, verifiedAt: account.verifiedAt, createdAt: account.createdAt };
}

export async function payoutOwnerContext(request,{preferredStorePublicId='',strictPreferred=false}={}){
  const storeContext=Boolean(request.store?._id);
  if(!storeContext&&request.user?.role==='promoter'){
    const actor=await promoterPayoutActor(request),market=await pinnedPromoterMarket(actor);
    return{ownerType:'promoter',ownerUserId:actor._id,ownerPublicId:String(actor._id),ownerStoreId:null,ownerStorePublicId:'',...market,availableStores:[]};
  }
  if(!storeContext&&request.user?.role==='delivery')return{ownerType:'delivery',ownerUserId:request.user._id,ownerPublicId:String(request.user._id),ownerStoreId:null,ownerStorePublicId:'',country:request.user.country,currency:request.user.currency,availableStores:[]};
  const accesses=(await sellerStoreAccesses(request.user)).filter(row=>['owner','admin','finance'].includes(row.role));
  if(!accesses.length)throw new AppError('Seller owner, admin or finance access is required.',403,'PAYOUT_OWNER_REQUIRED');
  if(!env.auth.simpleLogin&&env.security.privilegedMfaRequired){
    const actor=await User.findById(request.user._id).select('security.mfaEnabled').lean();
    if(!actor?.security?.mfaEnabled)throw new AppError('Authenticator enrollment is required for store payouts.',403,'MFA_ENROLLMENT_REQUIRED');
  }
  const requested=String(preferredStorePublicId||request.store?.publicId||request.session?.activeStorePublicId||'').trim();
  let selected=requested?accesses.find(row=>row.store.publicId===requested):null;
  if(requested&&!selected&&(strictPreferred||storeContext))throw new AppError('Selected seller finance workspace is unavailable.',403,'PAYOUT_WORKSPACE_FORBIDDEN');
  selected ||= accesses[0];
  if(request.session)request.session.activeStorePublicId=selected.store.publicId;
  const availableStores=accesses.map(row=>({publicId:row.store.publicId,name:row.store.name,country:row.store.country,currency:row.store.currency,status:row.store.status,role:row.role}));
  return{ownerType:'store',ownerUserId:selected.store.ownerUserId,ownerPublicId:selected.store.publicId,ownerStoreId:selected.store._id,ownerStorePublicId:selected.store.publicId,country:selected.store.country,currency:selected.store.currency,store:selected.store,membership:selected.membership,availableStores};
}
function payoutPayableCode(ownerType){return ownerType==='store'?'seller_payable':ownerType==='delivery'?'delivery_payable':'promoter_payable';}
function payoutLedgerOwnerType(account){return account?.ownerType==='seller'?'store':account?.ownerType==='delivery'?'delivery':'promoter';}
async function postPayoutHold(payout,account,ownerType,ownerPublicId,session=null){const payable=await ensureLedgerAccount({code:payoutPayableCode(ownerType),type:'liability',ownerType,ownerPublicId,country:account.country,currency:payout.currency},session),clearing=await ensureLedgerAccount({code:'payout_clearing',type:'liability',ownerType:'platform',ownerPublicId:'classic-mart',country:account.country,currency:payout.currency},session);await postLedgerTransaction({idempotencyKey:`payout-hold:${payout.publicId}`,referenceType:'payout',referencePublicId:payout.publicId,currency:payout.currency,country:account.country,description:`Payout reserved for ${payout.publicId}`,entries:[{account:payable,debitMinor:payout.amountMinor,creditMinor:0,memo:'Move payable into payout clearing'},{account:clearing,debitMinor:0,creditMinor:payout.amountMinor,memo:'Pending external disbursement'}]},session);}
export async function releasePayoutHold(payout,account,reason='Payout rejected',session=null){const ownerType=payoutLedgerOwnerType(account),owner=ownerType==='store'?await Store.findOne(payout.ownerStoreId?{_id:payout.ownerStoreId}:{ownerUserId:payout.ownerUserId}).session(session).lean():null,ownerPublicId=ownerType==='store'?(payout.ownerStorePublicId||owner?.publicId):String(payout.ownerUserId),payable=await ensureLedgerAccount({code:payoutPayableCode(ownerType),type:'liability',ownerType,ownerPublicId,country:account.country,currency:payout.currency},session),clearing=await ensureLedgerAccount({code:'payout_clearing',type:'liability',ownerType:'platform',ownerPublicId:'classic-mart',country:account.country,currency:payout.currency},session);await postLedgerTransaction({idempotencyKey:`payout-release:${payout.publicId}`,referenceType:'payout',referencePublicId:payout.publicId,currency:payout.currency,country:account.country,description:`Release payout reservation ${payout.publicId}`,entries:[{account:clearing,debitMinor:payout.amountMinor,creditMinor:0,memo:reason},{account:payable,debitMinor:0,creditMinor:payout.amountMinor,memo:'Restore available payable'}]},session);}
function payoutVersion(document, expectedVersion) {
  if (expectedVersion === undefined || expectedVersion === '') return;
  if (!Number.isSafeInteger(Number(expectedVersion)) || Number(expectedVersion) < 0) throw new AppError('Provide a valid record version.',422,'PAYOUT_VERSION_INVALID');
  if (Number(expectedVersion) !== Number(document.__v || 0)) throw new AppError('This record changed. Refresh it before making a decision.',409,'PAYOUT_STATE_CHANGED');
}
function payoutReference(value) {
  const reference=typeof value==='string'?value.trim():'';
  if(reference.length<4||reference.length>180||/[\u0000-\u001f\u007f]/.test(reference))throw new AppError('Enter a supported external disbursement reference.',422,'PAYOUT_REFERENCE_REQUIRED');
  return reference;
}
function payoutReason(value,min=3,max=400) {
  const reason=typeof value==='string'?value.trim():'';
  if(reason.length<min||reason.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason))throw new AppError('Enter a complete review reason within the supported length.',422,'PAYOUT_REASON_REQUIRED');
  return reason;
}
async function guardedPayoutAccount(request,account,{session,write=true}={}) {
  const access=await financeAccess(request,{session,write,workspace:false,country:account.country});
  if(!access.market||access.market.currency!==account.currency)throw new AppError('Payout destination currency does not match its configured market.',409,'PAYOUT_MARKET_INVALID');
  if(write) {
    const result=await PayoutAccount.updateOne({_id:account._id,__v:account.__v||0,country:account.country,currency:account.currency,status:account.status},{$inc:{__v:1}},{session});
    if(!result.modifiedCount)throw new AppError('The payout destination changed. Refresh and retry.',409,'PAYOUT_STATE_CHANGED');
    account.__v=Number(account.__v||0)+1;
  }
  return access;
}
async function guardedPayout(request,payout,session) {
  const account=await PayoutAccount.findById(payout.payoutAccountId).session(session);
  if(!account)throw new AppError('Payout account not found.',404,'PAYOUT_ACCOUNT_NOT_FOUND');
  const access=await guardedPayoutAccount(request,account,{session});
  if(payout.currency!==account.currency||String(payout.ownerUserId)!==String(account.ownerUserId)||String(payout.ownerStoreId||'')!==String(account.ownerStoreId||'')||!Number.isSafeInteger(payout.amountMinor)||payout.amountMinor<1)throw new AppError('Payout ownership, market or amount references are inconsistent.',409,'PAYOUT_REFERENCES_INVALID');
  // An operator can only move an actual reserved liability. A manually inserted
  // payout row never authorizes fabricated money or a disbursement.
  const hold=await LedgerTransaction.findOne({idempotencyKey:`payout-hold:${payout.publicId}`,referenceType:'payout',referencePublicId:payout.publicId,country:account.country,currency:payout.currency}).session(session).lean();
  if(!hold||hold.entries?.length!==2)throw new AppError('Payout funds have no complete reservation.',409,'PAYOUT_HOLD_REQUIRED');
  const accounts=await LedgerAccount.find({_id:{$in:hold.entries.map(entry=>entry.accountId)}}).session(session).lean(),byId=new Map(accounts.map(row=>[String(row._id),row]));
  const ownerType=payoutLedgerOwnerType(account),ownerPublicId=ownerType==='store'?payout.ownerStorePublicId:String(payout.ownerUserId);
  const debit=hold.entries.find(row=>Number(row.debitMinor)===payout.amountMinor&&Number(row.creditMinor||0)===0),credit=hold.entries.find(row=>Number(row.creditMinor)===payout.amountMinor&&Number(row.debitMinor||0)===0);
  const payable=byId.get(String(debit?.accountId)),clearing=byId.get(String(credit?.accountId));
  if(!payable||!clearing||payable.type!=='liability'||clearing.type!=='liability'||payable.code!==payoutPayableCode(ownerType)||payable.ownerType!==ownerType||payable.ownerPublicId!==ownerPublicId||clearing.code!=='payout_clearing'||clearing.ownerType!=='platform'||clearing.ownerPublicId!=='classic-mart'||[payable,clearing].some(row=>row.country!==account.country||row.currency!==payout.currency))throw new AppError('Payout reservation does not match its owner and market.',409,'PAYOUT_HOLD_INVALID');
  const released=await LedgerTransaction.exists({idempotencyKey:{$in:[`payout-release:${payout.publicId}`,`payout-reverse:${payout.publicId}`,`payout-paid:${payout.publicId}`]}}).session(session);
  if(released)throw new AppError('This payout reservation was already finalized.',409,'PAYOUT_HOLD_FINALIZED');
  return {account,access};
}
function independentPayoutActor(payout,actor,message='You cannot decide a payout you requested or own.') {
  if(String(payout.requestedByUserId||payout.ownerUserId)===String(actor._id)||String(payout.ownerUserId)===String(actor._id))throw new AppError(message,403,'FOUR_EYES_REQUIRED');
}
function payoutAttempt(payout,attemptId) {
  if(!payout.submissionAttemptId||!payout.submissionStartedAt)throw new AppError('This payout has no recorded external submission attempt.',409,'PAYOUT_ATTEMPT_REQUIRED');
  if(attemptId!==undefined&&attemptId!==payout.submissionAttemptId)throw new AppError('The external submission attempt changed.',409,'PAYOUT_ATTEMPT_CHANGED');
}
async function payoutTransaction(work) {
  const session=await mongoose.startSession();let result;
  try{await session.withTransaction(async()=>{result=await work(session);});}catch(error){if(error?.code===11000&&error.keyPattern?.providerReference)throw new AppError('This external transfer reference already belongs to another payout.',409,'PAYOUT_REFERENCE_REUSED');throw error;}finally{await session.endSession();}
  return result;
}
async function assertUnusedPayoutReference(payout,reference,session) {
  const provider=payout.disbursementProvider||'external';
  const providerScope=provider==='external'?{$or:[{disbursementProvider:'external'},{disbursementProvider:{$exists:false}},{disbursementProvider:null}]}:{disbursementProvider:provider};
  const existing=await Payout.exists({_id:{$ne:payout._id},...providerScope,providerReference:reference}).session(session);
  if(existing)throw new AppError('This external transfer reference already belongs to another payout.',409,'PAYOUT_REFERENCE_REUSED');
}
export async function reviewPayoutAccount(request,accountPublicId,{decision='verify',reason,version}={}) {
  if(!['verify','reject'].includes(decision))throw new AppError('Choose verify or reject.',422,'PAYOUT_ACCOUNT_DECISION_INVALID');
  const reviewReason=payoutReason(reason,3,400);
  return payoutTransaction(async session=>{
    const account=await PayoutAccount.findOne({publicId:accountPublicId,status:'pending'}).select('+destinationEncrypted').session(session);
    if(!account)throw new AppError('Pending payout destination not found.',404,'PAYOUT_ACCOUNT_NOT_FOUND');
    payoutVersion(account,version);
    const {actor}=await guardedPayoutAccount(request,account,{session});
    if(String(account.ownerUserId)===String(actor._id))throw new AppError('A different finance operator must review your payout destination.',403,'FOUR_EYES_REQUIRED');
    if(decision==='verify') {
      let destination;try{destination=JSON.parse(decryptSensitive(account.destinationEncrypted));}catch{throw new AppError('Payout destination is invalid.',422,'PAYOUT_DESTINATION_INVALID');}
      if(!destination||typeof destination!=='object'||typeof destination.beneficiary_name!=='string'||destination.beneficiary_name.trim().length<2||!(account.method==='bank'?destination.account_bank&&destination.account_number:destination.network&&destination.phone))throw new AppError('Payout destination details are incomplete.',422,'PAYOUT_DESTINATION_INVALID');
    }
    account.status=decision==='verify'?'verified':'disabled';account.verifiedAt=decision==='verify'?new Date():undefined;
    await account.save({session});
    await writeAudit(request,'finance.payout_account_'+(decision==='verify'?'verified':'rejected'),{actor,targetType:'payout_account',targetPublicId:account.publicId,country:account.country,metadata:{decision,reason:reviewReason,status:account.status},session});
    return publicPayoutAccount(account);
  });
}
export async function approvePayout(request,payoutPublicId,{reason,version}={}) {
  const reviewReason=payoutReason(reason||'Approved after checking the reserved funds and destination.',3,400);
  return payoutTransaction(async session=>{
    const payout=await Payout.findOne({publicId:payoutPublicId,status:'requested'}).session(session);
    if(!payout)throw new AppError('Requested payout not found.',404,'PAYOUT_NOT_FOUND');
    payoutVersion(payout,version);
    const {account,access}=await guardedPayout(request,payout,session);independentPayoutActor(payout,access.actor);
    if(account.status!=='verified')throw new AppError('Verified payout destination required.',409,'PAYOUT_ACCOUNT_REQUIRED');
    payout.status='approved';payout.approvedByUserId=access.actor._id;payout.approvedAt=new Date();await payout.save({session});
    await writeAudit(request,'finance.payout_approved',{actor:access.actor,targetType:'payout',targetPublicId:payout.publicId,country:account.country,metadata:{amountMinor:payout.amountMinor,currency:payout.currency,reason:reviewReason},session});
    return payout;
  });
}
export async function rejectPayout(request,payoutPublicId,{reason,version}={}) {
  const rejectionReason=payoutReason(reason,3,300);
  return payoutTransaction(async session=>{
    const payout=await Payout.findOne({publicId:payoutPublicId,status:{$in:['requested','approved']}}).session(session);
    if(!payout)throw new AppError('Open payout not found.',404,'PAYOUT_NOT_FOUND');
    payoutVersion(payout,version);const {account,access}=await guardedPayout(request,payout,session);independentPayoutActor(payout,access.actor);
    await releasePayoutHold(payout,account,rejectionReason,session);
    payout.status='rejected';payout.failureMessage=rejectionReason;await payout.save({session});
    await writeAudit(request,'finance.payout_rejected',{actor:access.actor,targetType:'payout',targetPublicId:payout.publicId,country:account.country,metadata:{reason:rejectionReason},session});
    return payout;
  });
}
export async function submitPayout(request,payoutPublicId,{version}={}) {
  return payoutTransaction(async session=>{
    const payout=await Payout.findOne({publicId:payoutPublicId,status:'approved'}).session(session);
    if(!payout)throw new AppError('This payout has already been claimed or is not approved. Reconcile its recorded attempt.',409,'PAYOUT_SUBMISSION_CLAIMED');
    payoutVersion(payout,version);const {account,access}=await guardedPayout(request,payout,session);independentPayoutActor(payout,access.actor);
    if(String(payout.approvedByUserId)===String(access.actor._id))throw new AppError('A different finance operator must submit an approved payout.',403,'FOUR_EYES_REQUIRED');
    if(account.status!=='verified')throw new AppError('Verified payout destination required.',409,'PAYOUT_ACCOUNT_REQUIRED');
    if(payout.submissionAttemptId||payout.submissionStartedAt||payout.providerReference)throw new AppError('A recorded external attempt cannot be replaced.',409,'PAYOUT_SUBMISSION_CLAIMED');
    const encrypted=await PayoutAccount.findById(account._id).select('+destinationEncrypted').session(session);
    try{JSON.parse(decryptSensitive(encrypted.destinationEncrypted));}catch{throw new AppError('Payout destination is invalid.',422,'PAYOUT_DESTINATION_INVALID');}
    const now=new Date(),submissionAttemptId=crypto.randomUUID();
    const claimed=await Payout.findOneAndUpdate(
      {publicId:payoutPublicId,status:'approved',approvedByUserId:{$ne:request.user._id},__v:payout.__v||0},
      {$set:{status:'submitting',submittedByUserId:access.actor._id,submissionStartedAt:now,submissionAttemptId,submittedAt:null,providerReference:'',ambiguityReason:'',unknownAt:null,unknownByUserId:null,disbursementProvider:'external'},$inc:{__v:1}},
      {new:true,session}
    );
    if(!claimed)throw new AppError('This payout has already been claimed for submission. Reconcile the existing attempt instead of resubmitting.',409,'PAYOUT_SUBMISSION_CLAIMED');
    await writeAudit(request,'finance.payout_submission_started',{actor:access.actor,targetType:'payout',targetPublicId:claimed.publicId,country:account.country,metadata:{submissionAttemptId},session});
    return claimed;
  });
}
export async function confirmPayoutSubmission(request,payoutPublicId,{reference,version,submissionAttemptId}={}) {
  const ref=payoutReference(reference);
  return payoutTransaction(async session=>{
    const payout=await Payout.findOne({publicId:payoutPublicId,status:'submitting'}).session(session);
    if(!payout)throw new AppError('Payout submission is not awaiting confirmation.',404,'PAYOUT_NOT_FOUND');
    payoutVersion(payout,version);payoutAttempt(payout,submissionAttemptId);
    const {account,access}=await guardedPayout(request,payout,session);
    if(String(payout.submittedByUserId)!==String(access.actor._id))throw new AppError('Only the operator who began the external transfer may confirm it.',403,'PAYOUT_SUBMITTER_REQUIRED');
    if(payout.providerReference&&payout.providerReference!==ref)throw new AppError('The external reference cannot be replaced.',409,'PAYOUT_REFERENCE_FROZEN');
    await assertUnusedPayoutReference(payout,ref,session);
    payout.status='submitted';payout.providerReference=ref;payout.submittedAt=new Date();payout.disbursementProvider=payout.disbursementProvider||'external';payout.markModified('disbursementProvider');await payout.save({session});
    await writeAudit(request,'finance.payout_submission_confirmed',{actor:access.actor,targetType:'payout',targetPublicId:payout.publicId,country:account.country,metadata:{submissionAttemptId:payout.submissionAttemptId,reference:ref},session});
    return payout;
  });
}
export async function markPayoutUnknown(request,payoutPublicId,{reason,version,submissionAttemptId}={}) {
  const ambiguityReason=payoutReason(reason,8,400);
  return payoutTransaction(async session=>{
    const payout=await Payout.findOne({publicId:payoutPublicId,status:{$in:['submitting','submitted']}}).session(session);
    if(!payout)throw new AppError('Payout is not in an ambiguous submission state.',404,'PAYOUT_NOT_FOUND');
    payoutVersion(payout,version);payoutAttempt(payout,submissionAttemptId);const {account,access}=await guardedPayout(request,payout,session);independentPayoutActor(payout,access.actor);
    payout.status='unknown';payout.unknownByUserId=access.actor._id;payout.unknownAt=new Date();payout.ambiguityReason=ambiguityReason;await payout.save({session});
    await queueFinanceAlert({country:account.country,kind:'escalation',href:'/finance/payouts?record='+encodeURIComponent(payout.publicId)},session);
    await writeAudit(request,'finance.payout_marked_unknown',{actor:access.actor,targetType:'payout',targetPublicId:payout.publicId,country:account.country,metadata:{submissionAttemptId:payout.submissionAttemptId,reason:ambiguityReason},session});
    return payout;
  });
}
export async function reconcilePayout(request,payoutPublicId,{reference,success=true,message='',version,submissionAttemptId}={}) {
  if(typeof success!=='boolean')throw new AppError('Choose a supported payout outcome.',422,'PAYOUT_OUTCOME_INVALID');
  const ref=payoutReference(reference),evidence=payoutReason(message||'Externally verified disbursement outcome.',3,400);
  return payoutTransaction(async session=>{
    const payout=await Payout.findOne({publicId:payoutPublicId,status:{$in:['submitted','unknown']}}).session(session);
    if(!payout)throw new AppError('Submitted payout not found.',404,'PAYOUT_NOT_FOUND');
    payoutVersion(payout,version);payoutAttempt(payout,submissionAttemptId);const {account,access}=await guardedPayout(request,payout,session);independentPayoutActor(payout,access.actor);
    if(String(payout.submittedByUserId)===String(access.actor._id))throw new AppError('A different finance operator must reconcile the payout.',403,'FOUR_EYES_REQUIRED');
    if(payout.providerReference&&payout.providerReference!==ref)throw new AppError('Use the frozen external transfer reference.',409,'PAYOUT_REFERENCE_FROZEN');
    await assertUnusedPayoutReference(payout,ref,session);
    const ownerType=payoutLedgerOwnerType(account),ownerPublicId=ownerType==='store'?payout.ownerStorePublicId:String(payout.ownerUserId),clearing=await ensureLedgerAccount({code:'payout_clearing',type:'liability',ownerType:'platform',ownerPublicId:'classic-mart',country:account.country,currency:payout.currency},session);
    if(success){
      const bank=await ensureLedgerAccount({code:'external_disbursement_clearing',type:'asset',ownerType:'provider',ownerPublicId:'external',country:account.country,currency:payout.currency},session);
      await postLedgerTransaction({idempotencyKey:`payout-paid:${payout.publicId}`,referenceType:'payout',referencePublicId:payout.publicId,currency:payout.currency,country:account.country,description:`Payout completed ${payout.publicId}`,entries:[{account:clearing,debitMinor:payout.amountMinor,creditMinor:0,memo:'Clear payout liability'},{account:bank,debitMinor:0,creditMinor:payout.amountMinor,memo:`External disbursement ${ref}`}]},session);
      payout.status='paid';payout.failureMessage='';
      if(ownerType==='promoter'){const {settlePromoterCommissions}=await import('./promoters.js');const settlement=await settlePromoterCommissions(payout.ownerUserId,payout.amountMinor,session,{country:account.country,currency:payout.currency});if(settlement.unappliedMinor>0)throw new AppError('Promoter payable does not match settleable commission records.',409,'PAYOUT_COMMISSION_MISMATCH');}
    }else{
      const payable=await ensureLedgerAccount({code:payoutPayableCode(ownerType),type:'liability',ownerType,ownerPublicId,country:account.country,currency:payout.currency},session);
      await postLedgerTransaction({idempotencyKey:`payout-reverse:${payout.publicId}`,referenceType:'payout',referencePublicId:payout.publicId,currency:payout.currency,country:account.country,description:`Failed payout reversal ${payout.publicId}`,entries:[{account:clearing,debitMinor:payout.amountMinor,creditMinor:0,memo:'Release payout clearing'},{account:payable,debitMinor:0,creditMinor:payout.amountMinor,memo:'Restore payable balance'}]},session);
      payout.status='failed';payout.failureMessage=evidence;
    }
    payout.providerReference=ref;payout.completedByUserId=access.actor._id;payout.completedAt=new Date();payout.disbursementProvider=payout.disbursementProvider||'external';payout.markModified('disbursementProvider');await payout.save({session});
    await writeAudit(request,'finance.payout_reconciled',{actor:access.actor,targetType:'payout',targetPublicId:payout.publicId,country:account.country,metadata:{outcome:success?'paid':'failed',reference:ref,evidence,submissionAttemptId:payout.submissionAttemptId},session});
    return payout;
  });
}
export async function revealPayoutDestination(request,payoutPublicId) {
  return payoutTransaction(async session=>{
    const payout=await Payout.findOne({publicId:payoutPublicId,status:'submitting'}).session(session);
    if(!payout)throw new AppError('Claim this approved payout before opening its transfer destination.',409,'PAYOUT_SUBMITTER_REQUIRED');
    const {account,access}=await guardedPayout(request,payout,session);
    if(String(payout.submittedByUserId)!==String(access.actor._id))throw new AppError('Only the claimed transfer operator may open the destination.',403,'PAYOUT_SUBMITTER_REQUIRED');
    const encrypted=await PayoutAccount.findById(account._id).select('+destinationEncrypted').session(session);let raw;
    try{raw=JSON.parse(decryptSensitive(encrypted.destinationEncrypted));}catch{throw new AppError('Payout destination is invalid.',422,'PAYOUT_DESTINATION_INVALID');}
    const destination={beneficiaryName:String(raw.beneficiary_name||''),...(account.method==='bank'?{bank:String(raw.account_bank||''),accountNumber:String(raw.account_number||'')}:{network:String(raw.network||''),phone:String(raw.phone||'')})};
    await writeAudit(request,'finance.payout_destination_opened',{actor:access.actor,targetType:'payout',targetPublicId:payout.publicId,country:account.country,metadata:{destinationPublicId:account.publicId,submissionAttemptId:payout.submissionAttemptId},session});
    return {payoutPublicId:payout.publicId,method:account.method,destination,submissionAttemptId:payout.submissionAttemptId};
  });
}

export async function savePayoutAccount(request,{method,label,destination}){
  const owner=await payoutOwnerContext(request);
  const document=market=>({publicId:publicId('poa'),ownerUserId:owner.ownerUserId,ownerStoreId:owner.ownerStoreId||undefined,ownerStorePublicId:owner.ownerStorePublicId||'',ownerType:owner.ownerType==='store'?'seller':owner.ownerType,country:market.country,currency:market.currency,method,label,destinationEncrypted:encryptSensitive(JSON.stringify(destination)),status:'pending'});
  if(owner.ownerType!=='promoter'){const [account]=await PayoutAccount.create([document(owner)]);return publicPayoutAccount(account);}
  const session=await mongoose.startSession();let account;
  try{await session.withTransaction(async()=>{
    const actor=await promoterPayoutActor(request,session),market=await pinnedPromoterMarket(actor,{session,write:true});
    if(market.country!==owner.country||market.currency!==owner.currency)throw new AppError('Your programme market changed. Refresh and retry.',409,'PAYOUT_OWNER_CHANGED');
    await User.updateOne({_id:actor._id,status:'active',role:'promoter','security.tokenVersion':actor.security.tokenVersion},{$inc:{__v:1}},{session});
    [account]=await PayoutAccount.create([document(market)],{session});
  });}finally{await session.endSession();}
  return publicPayoutAccount(account);
}
export async function payoutAccountsForRequest(request){const owner=await payoutOwnerContext(request),query=owner.ownerType==='store'?{ownerStoreId:owner.ownerStoreId,ownerType:'seller'}:{ownerUserId:owner.ownerUserId,ownerType:owner.ownerType,country:owner.country,currency:owner.currency};const accounts=await PayoutAccount.find(mongoose.trusted(query)).select('publicId ownerType country currency method label status verifiedAt createdAt').sort({createdAt:-1}).lean();return accounts.map(publicPayoutAccount);}
export async function payoutsForRequest(request,{cursor='',limit=50,withPage=false}={}){const owner=await payoutOwnerContext(request);let query;if(owner.ownerType==='store')query={ownerStoreId:owner.ownerStoreId};else{const accountScope={ownerUserId:owner.ownerUserId,ownerType:owner.ownerType};if(owner.ownerType==='promoter')Object.assign(accountScope,{country:owner.country,currency:owner.currency});const accountIds=await PayoutAccount.find(accountScope).distinct('_id');query={payoutAccountId:{$in:accountIds}};if(owner.ownerType==='promoter')Object.assign(query,{ownerUserId:owner.ownerUserId,ownerStoreId:{$exists:false},currency:owner.currency});}const size=Math.min(100,Math.max(10,Number(limit)||50));const [rows,total]=await Promise.all([Payout.find(mongoose.trusted(cursorScope(query,cursor))).sort(cursorSort()).limit(size+1).lean(),Payout.countDocuments(mongoose.trusted(query))]);const page=pageResult(rows,{limit:size,total});return withPage?page:page.items;}
export async function requestPayout(request, { payoutAccountId, amountMinor, idempotencyKey }) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) throw new AppError('Payout amount must be a positive supported whole number.', 422, 'PAYOUT_AMOUNT_INVALID');
  if (typeof payoutAccountId !== 'string' || payoutAccountId.length < 4 || payoutAccountId.length > 100
    || typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 120) {
    throw new AppError('Provide a valid payout destination and request key.', 422, 'PAYOUT_REQUEST_INVALID');
  }
  const owner = await payoutOwnerContext(request);
  const session = await mongoose.startSession();
  let payout;
  try {
    await session.withTransaction(async () => {
      const actor = await User.findById(request.user._id)
        .select('status role country currency security.tokenVersion security.mfaEnabled').session(session).lean();
      if (!actor || actor.status !== 'active' || actor.security.tokenVersion !== request.user.security?.tokenVersion
        || (request.session?.tokenVersion !== undefined && actor.security.tokenVersion !== request.session.tokenVersion)) {
        throw new AppError('Your account or session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
      }
      if (owner.ownerType === 'store') {
        if (!env.auth.simpleLogin && env.security.privilegedMfaRequired && !actor.security.mfaEnabled) {
          throw new AppError('Authenticator enrollment is required for store payouts.', 403, 'MFA_ENROLLMENT_REQUIRED');
        }
        const store = await Store.findOne({ _id: owner.ownerStoreId, publicId: owner.ownerPublicId,
          country: owner.country, currency: owner.currency, ownerUserId: owner.ownerUserId,
          status: { $in: ['pending_verification', 'verified'] } }).session(session).lean();
        const member = await StoreMember.findOne({ storeId: owner.ownerStoreId, userId: actor._id,
          status: 'active', role: { $in: ['owner', 'admin', 'finance'] } }).session(session).lean();
        if (!member) throw new AppError('Seller finance access is required.', 403, 'PAYOUT_OWNER_REQUIRED');
        if (!store) throw new AppError('The selected store is unavailable or its market changed.', 409, 'PAYOUT_WORKSPACE_UNAVAILABLE');
        const country = await CountrySetting.findOne({ code: store.country, currency: store.currency, active: true }).session(session).lean();
        if (!country) throw new AppError('The store country and currency need configuration.', 409, 'SELLER_COUNTRY_UNAVAILABLE');
        // These writes force concurrent suspension, membership revocation and
        // store changes to retry authorization against a fresh snapshot.
        await StoreMember.updateOne({ _id: member._id, status: 'active', role: member.role }, { $inc: { __v: 1 } }, { session });
        await Store.updateOne({ _id: store._id, status: store.status, country: store.country, currency: store.currency }, { $inc: { __v: 1 } }, { session });
      } else if (owner.ownerType === 'promoter') {
        const promoter=await promoterPayoutActor(request,session),market=await pinnedPromoterMarket(promoter,{session,write:true});
        if(market.country!==owner.country||market.currency!==owner.currency)throw new AppError('Your programme market changed. Refresh and retry.',409,'PAYOUT_OWNER_CHANGED');
      } else if (actor.role !== owner.ownerType || actor.country !== owner.country || actor.currency !== owner.currency) {
        throw new AppError('Your payout account context changed. Refresh and retry.', 409, 'PAYOUT_OWNER_CHANGED');
      }
      await User.updateOne({ _id: actor._id, status: 'active', 'security.tokenVersion': actor.security.tokenVersion }, { $inc: { __v: 1 } }, { session });
      const accountQuery = owner.ownerType === 'store'
        ? { publicId: payoutAccountId, status: 'verified', ownerStoreId: owner.ownerStoreId, ownerType: 'seller', country: owner.country, currency: owner.currency }
        : { publicId: payoutAccountId, status: 'verified', ownerUserId: owner.ownerUserId, ownerType: owner.ownerType, country: owner.country, currency: owner.currency };
      // Account verification and ownership participate in the reservation
      // transaction, including its write boundary for destination revocation.
      const account = await PayoutAccount.findOneAndUpdate(accountQuery, { $inc: { __v: 1 } }, { session, returnDocument: 'after' });
      if (!account) throw new AppError('Verified payout account required.', 409, 'PAYOUT_ACCOUNT_REQUIRED');
      const existing = await Payout.findOne({ idempotencyKey }).session(session);
      if (existing) {
        const sameOwner = owner.ownerType === 'store'
          ? String(existing.ownerStoreId) === String(owner.ownerStoreId)
          : !existing.ownerStoreId && String(existing.ownerUserId) === String(owner.ownerUserId);
        if (!sameOwner || String(existing.requestedByUserId) !== String(actor._id)
          || existing.amountMinor !== amountMinor || existing.currency !== owner.currency
          || String(existing.payoutAccountId) !== String(account._id)) {
          throw new AppError('This request key already belongs to a different payout.', 409, 'PAYOUT_IDEMPOTENCY_CONFLICT');
        }
        payout = existing;
        return;
      }
      const ledger = await ensureLedgerAccount({ code: payoutPayableCode(owner.ownerType), type: 'liability',
        ownerType: owner.ownerType, ownerPublicId: owner.ownerPublicId, country: owner.country, currency: owner.currency }, session);
      await LedgerAccount.findOneAndUpdate({ _id: ledger._id }, { $inc: { mutationVersion: 1 } }, { session, returnDocument: 'after' });
      const available = await accountBalanceMinor(ledger._id, session);
      if (!Number.isSafeInteger(available) || amountMinor > available) throw new AppError('Payout amount exceeds available balance.', 409, 'PAYOUT_BALANCE');
      [payout] = await Payout.create([{ publicId: publicId('pyo'), idempotencyKey, ownerUserId: owner.ownerUserId,
        ownerStoreId: owner.ownerStoreId || undefined, ownerStorePublicId: owner.ownerStorePublicId || '',
        requestedByUserId: actor._id, payoutAccountId: account._id, amountMinor, currency: owner.currency, status: 'requested' }], { session });
      await postPayoutHold(payout, account, owner.ownerType, owner.ownerPublicId, session);
      await queueFinanceAlert({country:account.country,kind:'priority',href:'/finance/payouts?record='+encodeURIComponent(payout.publicId)},session);
    });
  } catch (error) {
    if (error?.code === 11000) throw new AppError('This request key already belongs to a payout. Refresh and retry.', 409, 'PAYOUT_IDEMPOTENCY_CONFLICT');
    throw error;
  } finally {
    await session.endSession();
  }
  return payout;
}

export async function reconcilePayments(request,{hours=24,country}={}){
  const range=Number(hours);if(!Number.isInteger(range)||range<1||range>168)throw new AppError('Choose a reconciliation window between 1 and 168 hours.',422,'RECONCILIATION_WINDOW');
  const context=await financeAccess(request,{workspace:false,country});
  if(!context.country)throw new AppError('Select one country to reconcile its provider payments.',422,'RECONCILIATION_COUNTRY_REQUIRED');
  if(!env.pesapal.consumerKey||!env.pesapal.consumerSecret)throw new AppError('Pesapal credentials are required for independent payment reconciliation.',503,'PESAPAL_NOT_CONFIGURED');
  const session=await mongoose.startSession();let run;
  try{await session.withTransaction(async()=>{
    const access=await financeAccess(request,{session,write:true,workspace:false,country:context.country});
    [run]=await ReconciliationRun.create([{publicId:publicId('rec'),country:access.country,currency:access.market.currency,provider:PAYMENT_PROVIDER,startedByUserId:access.actor._id,status:'running',startedAt:new Date()}],{session});
    await writeAudit(request,'finance.reconciliation_started',{actor:access.actor,targetType:'reconciliation_run',targetPublicId:run.publicId,country:access.country,metadata:{hours:range},session});
  });}finally{await session.endSession();}
  const query={country:context.country,currency:context.market.currency,provider:PAYMENT_PROVIDER,status:{$in:['created','requires_action','pending','failed','succeeded','partially_refunded']},createdAt:{$gte:new Date(Date.now()-range*60*60*1000)}};
  const errors=[];let matched=0,updated=0,failed=0,lastId=null,authorizationLost=false;
  while(true){
    if(authorizationLost)break;
    const batchQuery=lastId?{$and:[query,{_id:{$gt:lastId}}]}:query;
    const intents=await PaymentIntent.find(mongoose.trusted(batchQuery)).sort({_id:1}).limit(100);
    if(!intents.length)break;
    for(const intent of intents){
      lastId=intent._id;run.checked+=1;
      try{
        if(!intent.providerTrackingId){failed+=1;if(errors.length<100)errors.push(`${intent.publicId}: Pesapal tracking ID not found`);continue;}
        const order=await Order.findOne({_id:intent.orderId,publicId:intent.orderPublicId,country:context.country,'totals.currency':context.market.currency}).select('_id').lean();
        if(!order)throw new AppError('Payment and order market do not match.',409,'RECONCILIATION_SOURCE_MISMATCH');
        await financeAccess(request,{workspace:false,country:context.country});
        const before=intent.status,verified=await verifyAndApplyPayment(intent.publicId,intent.providerTrackingId,{request,country:context.country});matched+=1;if(verified.status!==before)updated+=1;
      }catch(error){failed+=1;if(errors.length<100)errors.push(`${intent.publicId}: ${String(error.code||'RECONCILIATION_ERROR').slice(0,80)}`);if([401,403].includes(error.status)){authorizationLost=true;break;}}
    }
  }
  return completeReconciliationHistory(request,run,{checked:run.checked,matched,updated,failed,errorMessages:errors});
}

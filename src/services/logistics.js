import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { env } from '../config/env.js';
import { publicId } from '../core/ids.js';
import { currentTraceFields } from '../core/trace.js';
import { encryptSensitive } from '../core/sensitive.js';
import {
  CountrySetting, DeliveryException, DeliveryOffer, EvidenceDocument, InventoryDiscrepancy, InventoryMovement, Order, Parcel, PaymentIntent, ReconciliationRun, ReturnRequest, SellerOrder, SellerShipment, Shipment, ShippingZone, StockItem, Store, Warehouse, WarehouseTask, WarehouseWave,
} from '../models/index.js';
import { ensureLedgerAccount, postLedgerTransaction, sellerSettlementBreakdown } from './money.js';
import { refreshOrderLifecycle, syncLegacyOrderStatus } from './order-state.js';

const allowedTransitions = Object.freeze({
  ready: ['offered'], offered: ['assigned', 'ready'], assigned: ['picked_up', 'failed'], picked_up: ['in_transit', 'failed'],
  in_transit: ['delivered', 'failed', 'rescheduled', 'return_to_sender'], failed: ['rescheduled', 'return_to_sender'],
  rescheduled: ['in_transit', 'failed', 'return_to_sender'], return_to_sender: ['returned'], delivered: [], returned: [],
});
export function canTransitionShipment(from, to) { return (allowedTransitions[from] || []).includes(to); }
export function hashProofCode(value) { return crypto.createHmac('sha256', env.security.integrityKey).update(String(value)).digest('hex'); }
export function verifyProofCode(value, proofHash) { const a = Buffer.from(hashProofCode(value)); const b = Buffer.from(String(proofHash || '')); return a.length === b.length && crypto.timingSafeEqual(a, b); }

const ADDRESS_FAILURE_CODES=new Set(['address_not_found','address_incorrect']);
const FAILURE_CODES=new Set(['recipient_unavailable','address_not_found','address_incorrect','recipient_refused','unsafe_location','parcel_damaged','vehicle_issue','other']);
async function latestDeliveryEvidence(shipmentPublicId,documentTypes,session=null,after=null){
  const filter={contextType:'delivery_job',contextPublicId:shipmentPublicId,status:'ready',documentType:{$in:documentTypes}};
  if(after)filter.createdAt={$gt:after};
  let query=EvidenceDocument.find(filter).sort({createdAt:-1});
  if(session)query=query.session(session);return query.lean();
}
async function deliveryPolicyForOrder(order,session){
  let settingQuery=CountrySetting.findOne({code:order.country,active:true});if(session)settingQuery=settingQuery.session(session);const setting=await settingQuery.lean();
  let zone=null;if(order.shippingZonePublicId){let zoneQuery=ShippingZone.findOne({publicId:order.shippingZonePublicId,country:order.country,active:true});if(session)zoneQuery=zoneQuery.session(session);zone=await zoneQuery.lean();}
  const slaHours=order.deliveryMethod==='express'?Number(zone?.expressSlaHours||setting?.delivery?.defaultExpressSlaHours||24):Number(zone?.standardSlaHours||setting?.delivery?.defaultStandardSlaHours||72);
  return {slaHours:Math.max(1,Math.min(720,slaHours)),proofPolicy:{deliveryPhotoRequired:Boolean(order.paymentMethod==='cod'&&(setting?.delivery?.requirePhotoForCod??true)),signatureRequired:Boolean(setting?.delivery?.requireSignatureForDelivery),failedAttemptPhotoRequired:Boolean(setting?.delivery?.requirePhotoForFailedAttempt??true)}};
}
async function createDeliveryExceptionInSession({shipment,type,reasonCode,description,evidenceRequired=false,evidenceDocumentIds=[],expectedAmountMinor,observedAmountMinor,currency,actorUserId},session){
  const [exception]=await DeliveryException.create([{publicId:publicId('dex'),shipmentId:shipment._id,shipmentPublicId:shipment.publicId,country:shipment.country,deliveryUserId:shipment.deliveryUserId,type,reasonCode,description:String(description||'').trim().slice(0,600),evidenceRequired,evidenceDocumentIds,expectedAmountMinor,observedAmountMinor,currency:currency||'',timeline:[{type:'opened',message:'Delivery exception opened for operational review.',actorUserId}]}],{session});
  return exception;
}


async function ensureSellerShipmentsForRoot(order,rootShipment,actorUserId,session){
  const [sellerOrders,parcels]=await Promise.all([
    SellerOrder.find({orderId:order._id}).session(session),
    Parcel.find({shipmentId:rootShipment._id}).session(session),
  ]);
  const parcelByStore=new Map(parcels.map(row=>[String(row.storePublicId),row]));
  for(const sellerOrder of sellerOrders){
    const parcel=parcelByStore.get(String(sellerOrder.storePublicId));
    if(!parcel)throw new AppError(`Seller parcel is missing for ${sellerOrder.publicId}.`,409,'SELLER_SHIPMENT_PARCEL_MISSING');
    const quantity=(sellerOrder.items||[]).reduce((sum,row)=>sum+Math.max(0,Number(row.quantity||0)),0);
    await SellerShipment.findOneAndUpdate(
      {sellerOrderId:sellerOrder._id},
      {$setOnInsert:{publicId:publicId('sshp'),orderId:order._id,orderPublicId:order.publicId,sellerOrderId:sellerOrder._id,sellerOrderPublicId:sellerOrder.publicId,storeId:sellerOrder.storeId,storePublicId:sellerOrder.storePublicId,country:order.country,rootShipmentId:rootShipment._id,rootShipmentPublicId:rootShipment.publicId,parcelId:parcel._id,parcelPublicId:parcel.publicId,status:parcel.status,lineCount:Math.max(1,(sellerOrder.items||[]).length),quantity:Math.max(1,quantity),timeline:[{type:'created',message:`Seller shipment created for parcel ${parcel.publicId} inside consolidated delivery ${rootShipment.publicId}.`,actorUserId}]}},
      {upsert:true,returnDocument:'after',setDefaultsOnInsert:true,session},
    );
  }
}
async function syncSellerShipmentFromParcel(parcel,actorUserId,session){
  if(!parcel?._id)return;
  const set={status:parcel.status};if(parcel.status==='handed_over')set.handedOverAt=new Date();if(parcel.status==='delivered')set.deliveredAt=new Date();
  await SellerShipment.updateOne({parcelId:parcel._id},{$set:set,$push:{timeline:{type:`parcel.${parcel.status}`,message:`Seller parcel ${parcel.publicId} moved to ${String(parcel.status).replaceAll('_',' ')}.`,actorUserId}}},{session});
}
async function ensureShipmentInSession(order, actorUserId, session) {
  const existing = await Shipment.findOne({ orderId: order._id, kind: 'outbound' }).session(session); if (existing) { await ensureSellerShipmentsForRoot(order,existing,actorUserId,session); return existing; }
  if (!['confirmed', 'paid'].includes(order.status) && order.paymentMethod !== 'cod') throw new AppError('Order is not ready for fulfilment.', 409, 'ORDER_NOT_READY');
  const pickup = String(crypto.randomInt(100000, 999999)); const delivery = String(crypto.randomInt(100000, 999999));
  const deliveryPolicy=await deliveryPolicyForOrder(order,session);const createdAt=new Date();
  const shipmentTrace={traceId:order.traceId||currentTraceFields().traceId,traceSpanId:order.traceSpanId||currentTraceFields().traceSpanId};
  const [shipment] = await Shipment.create([{ publicId: publicId('shp'), ...shipmentTrace, orderId: order._id, orderPublicId: order.publicId, kind:'outbound', country: order.country, mode: order.deliveryMethod, pickupCodeHash: hashProofCode(pickup), deliveryCodeHash: hashProofCode(delivery), pickupCodeEncrypted: encryptSensitive(pickup), deliveryCodeEncrypted: encryptSensitive(delivery), slaDueAt:new Date(createdAt.getTime()+deliveryPolicy.slaHours*60*60*1000), proofPolicy:deliveryPolicy.proofPolicy, cod: { required: order.paymentMethod === 'cod', amountMinor: order.paymentMethod === 'cod' ? order.totals.totalMinor : 0, currency: order.totals.currency, collectedMinor: 0 }, parcelCount: Math.max(1, new Set(order.items.map(item => item.storePublicId)).size), timeline: [{ type: 'shipment_created', message: `Shipment created with ${deliveryPolicy.slaHours}h delivery SLA.`, actorUserId }] }], {session});
  const storeIds = [...new Set(order.items.map(item => item.storePublicId))];
  for (const storePublicId of storeIds) {
    await Parcel.create([{ publicId: publicId('par'), shipmentId: shipment._id, orderPublicId: order.publicId, storePublicId, barcode: `CM-${crypto.randomBytes(8).toString('hex').toUpperCase()}`, items: order.items.filter(item=>item.storePublicId===storePublicId).map(item=>({productPublicId:item.productPublicId,variantPublicId:item.variantPublicId,sku:item.sku,title:item.title,quantity:item.quantity})), timeline: [{ type: 'created', message: 'Parcel created for seller fulfilment.', actorUserId }] }], {session});
  }
  await ensureSellerShipmentsForRoot(order,shipment,actorUserId,session);
  return shipment;
}

export async function ensureShipmentForOrder(order, actorUserId, session=null) {
  if(session)return ensureShipmentInSession(order,actorUserId,session);
  const owned=await mongoose.startSession();let result;try{await owned.withTransaction(async()=>{const fresh=await Order.findById(order._id).session(owned);if(!fresh)throw new AppError('Order not found.',404,'ORDER_NOT_FOUND');result=await ensureShipmentInSession(fresh,actorUserId,owned);});return result;}catch(error){if(error?.code===11000){const existing=await Shipment.findOne({orderId:order._id,kind:'outbound'});if(existing)return existing;}throw error;}finally{await owned.endSession();}
}

export async function offerShipment({ shipment, deliveryUserId, earningMinor, currency, actorUserId }) {
  if (!['ready', 'offered'].includes(shipment.status) || shipment.deliveryUserId) throw new AppError('Shipment cannot be offered in its current state.', 409, 'SHIPMENT_OFFER_STATE');
  const offer = await DeliveryOffer.findOneAndUpdate(
    { shipmentId: shipment._id, deliveryUserId },
    { $set: { shipmentPublicId: shipment.publicId, country: shipment.country, earningMinor, currency, status: 'offered', expiresAt: new Date(Date.now() + 15 * 60 * 1000), respondedAt: null }, $setOnInsert: { publicId: publicId('dof') } },
    { upsert: true, returnDocument: 'after' },
  );
  if (shipment.status === 'ready') { shipment.status = 'offered'; shipment.timeline.push({ type: 'offered', message: 'Delivery job offered to an approved partner.', actorUserId }); await shipment.save(); }
  return offer;
}

async function postDeliveryEarning(shipment, session = null) {
  if(!shipment.deliveryUserId)return null;
  let offerQuery=DeliveryOffer.findOne({shipmentId:shipment._id,deliveryUserId:shipment.deliveryUserId,status:'accepted'});if(session)offerQuery=offerQuery.session(session);const offer=await offerQuery.lean();
  if(!offer||!Number.isSafeInteger(offer.earningMinor)||offer.earningMinor<=0)return null;
  const expense=await ensureLedgerAccount({code:'delivery_expense',type:'expense',ownerType:'platform',ownerPublicId:'classic-mart',country:shipment.country,currency:offer.currency},session);
  const payable=await ensureLedgerAccount({code:'delivery_payable',type:'liability',ownerType:'delivery',ownerPublicId:String(shipment.deliveryUserId),country:shipment.country,currency:offer.currency},session);
  return postLedgerTransaction({idempotencyKey:`delivery-earning:${shipment.publicId}`,referenceType:'delivery_earning',referencePublicId:shipment.publicId,currency:offer.currency,country:shipment.country,description:`Delivery earning for ${shipment.publicId}`,entries:[{account:expense,debitMinor:offer.earningMinor,creditMinor:0,memo:'Delivery partner service expense'},{account:payable,debitMinor:0,creditMinor:offer.earningMinor,memo:'Delivery partner payable'}]},session);
}

export async function acceptDeliveryOffer({ offer, actorUserId }) {
  if (offer.status !== 'offered' || offer.expiresAt <= new Date()) throw new AppError('This delivery offer expired or is no longer available.', 409, 'OFFER_UNAVAILABLE');
  const session = await mongoose.startSession();
  try { return await session.withTransaction(async () => {
    const shipment = await Shipment.findOneAndUpdate({ _id: offer.shipmentId, status: 'offered', deliveryUserId: null }, { $set: { deliveryUserId: actorUserId, status: 'assigned', assignedAt: new Date() }, $push: { timeline: { type: 'assigned', message: 'Delivery partner accepted an explicit offer.', actorUserId } } }, { returnDocument: 'after', session });
    if (!shipment) throw new AppError('Shipment was assigned to another partner.', 409, 'JOB_UNAVAILABLE');
    offer.status = 'accepted'; offer.respondedAt = new Date(); await offer.save({ session });
    await DeliveryOffer.updateMany({ shipmentId: shipment._id, _id: { $ne: offer._id }, status: 'offered' }, { $set: { status: 'cancelled', respondedAt: new Date() } }, { session });
    return shipment;
  }); } finally { await session.endSession(); }
}

export async function transitionShipment({ shipment, nextStatus, actorUserId, proofCode = '', reason = '', reasonCode = 'other', rescheduledFor = null }) {
  const session=await mongoose.startSession();let result;
  try{await session.withTransaction(async()=>{
    const current=await Shipment.findOne({_id:shipment._id,deliveryUserId:shipment.deliveryUserId}).select('+pickupCodeHash +deliveryCodeHash +pickupCodeEncrypted +deliveryCodeEncrypted').session(session);
    if(!current)throw new AppError('Shipment not found.',404,'SHIPMENT_NOT_FOUND');
    if (!canTransitionShipment(current.status, nextStatus)) throw new AppError('Shipment status transition is not allowed.', 409, 'SHIPMENT_TRANSITION_INVALID');
    if(current.proofLockedUntil&&current.proofLockedUntil>new Date())throw new AppError('Proof-code verification is temporarily locked after repeated failures.',429,'PROOF_LOCKED');
    if (nextStatus === 'picked_up' && current.kind === 'outbound') {const unreadyParcels = await Parcel.countDocuments({ shipmentId: current._id, status: { $ne: 'handed_over' } }).session(session);if (unreadyParcels > 0) throw new AppError('Every seller parcel must be packed and handed over before carrier pickup.', 409, 'PARCEL_HANDOFF_REQUIRED');}
    const verifyField=nextStatus==='picked_up'?'pickupCodeHash':nextStatus==='delivered'?'deliveryCodeHash':'';
    if(verifyField&&!verifyProofCode(proofCode,current[verifyField])){
      const attemptsField=nextStatus==='picked_up'?'pickupProofAttempts':'deliveryProofAttempts';current[attemptsField]=Number(current[attemptsField]||0)+1;if(current[attemptsField]>=5){current.proofLockedUntil=new Date(Date.now()+15*60*1000);current[attemptsField]=0;}await current.save({session});throw new AppError(`${nextStatus==='picked_up'?'Pickup':'Delivery'} verification code is invalid.`,422,'PROOF_INVALID');
    }
    current.status = nextStatus;
    if (nextStatus === 'picked_up') { current.pickedUpAt = new Date();current.pickupProofAttempts=0;current.pickupCodeEncrypted=''; await Parcel.updateMany({ shipmentId: current._id, status: { $in: ['packed', 'handed_over'] } }, { $set: { status: 'in_transit' }, $push: { timeline: { type: 'picked_up', message: 'Parcel picked up by delivery partner.', actorUserId } } },{session}); await SellerShipment.updateMany({rootShipmentId:current._id,status:'handed_over'},{$set:{status:'in_transit'},$push:{timeline:{type:'carrier.picked_up',message:`Consolidated carrier shipment ${current.publicId} picked up this seller shipment.`,actorUserId}}},{session}); }
    if (nextStatus === 'delivered') {
      const proofEvidence=await latestDeliveryEvidence(current.publicId,['delivery_photo','delivery_signature'],session,current.lastAttemptAt||current.assignedAt||null);const photo=proofEvidence.find(row=>row.documentType==='delivery_photo');const signature=proofEvidence.find(row=>row.documentType==='delivery_signature');
      if(current.proofPolicy?.deliveryPhotoRequired&&!photo)throw new AppError('Upload the required delivery proof photo before confirming delivery.',422,'DELIVERY_PHOTO_REQUIRED');
      if(current.proofPolicy?.signatureRequired&&!signature)throw new AppError('Upload the required recipient signature before confirming delivery.',422,'DELIVERY_SIGNATURE_REQUIRED');
      current.deliveredAt = new Date();current.lastAttemptAt=current.deliveredAt;current.deliveryProofAttempts=0;current.deliveryCodeEncrypted='';current.proofLockedUntil=null;current.proof = { type: 'otp', reference: 'verified', recordedAt: new Date() };current.proofEvidenceDocumentIds=[...new Set([...(current.proofEvidenceDocumentIds||[]).map(String),...proofEvidence.map(row=>String(row._id))])];
      if (current.cod.required) current.cod.collectedMinor = current.cod.amountMinor;
      await Parcel.updateMany({ shipmentId: current._id }, { $set: { status: 'delivered' }, $push: { timeline: { type: 'delivered', message: 'Parcel delivered with verified OTP.', actorUserId } } },{session});
      await SellerShipment.updateMany({rootShipmentId:current._id},{$set:{status:'delivered',deliveredAt:current.deliveredAt},$push:{timeline:{type:'carrier.delivered',message:`Consolidated carrier shipment ${current.publicId} delivered with verified proof.`,actorUserId}}},{session});
      if(current.kind==='outbound'){
        await SellerOrder.updateMany({ orderId: current.orderId, status: { $in: ['confirmed','processing','ready'] } }, { $set: { status: 'fulfilled' }, $push: { timeline: { type: 'fulfilment.delivered', message: 'Seller parcel delivered with verified proof.' } } },{session});
        const order=await Order.findById(current.orderId).session(session);if(order){order.fulfillmentState='delivered';for(const item of order.items)item.deliveredQuantity=Math.max(Number(item.deliveredQuantity||0),Number(item.quantity||0));order.timeline.push({type:'fulfilment.delivered',message:'Order delivered with verified proof.'});await order.save({session});if(order.businessOrganizationId){const {recordBusinessDelivery}=await import('./business-fulfillment.js');await recordBusinessDelivery({orderId:order._id,actorUserId,session});}}
        await postDeliveryEarning(current,session);
      }else if(current.kind==='return'){
        current.timeline.push({type:'return.received',message:'Returned parcel reached the seller/warehouse for inspection.',actorUserId});
      }
    }
    if (nextStatus === 'failed') {
      if (!reason.trim()) throw new AppError('Failed delivery requires a reason.', 422, 'REASON_REQUIRED');if(!FAILURE_CODES.has(reasonCode))throw new AppError('Choose a valid failed-delivery reason.',422,'DELIVERY_FAILURE_REASON_INVALID');
      const documentType=ADDRESS_FAILURE_CODES.has(reasonCode)?'address_exception':'failed_attempt';const evidence=await latestDeliveryEvidence(current.publicId,[documentType],session,current.lastAttemptAt||current.assignedAt||null);const evidenceRequired=Boolean(current.proofPolicy?.failedAttemptPhotoRequired)||reasonCode==='parcel_damaged';
      const exception=await createDeliveryExceptionInSession({shipment:current,type:ADDRESS_FAILURE_CODES.has(reasonCode)?'address_exception':'failed_delivery',reasonCode,description:reason,evidenceRequired,evidenceDocumentIds:evidence.map(row=>row._id),actorUserId},session);
      current.failedReason = reason.trim();current.failedAttemptCount=Number(current.failedAttemptCount||0)+1;current.lastAttemptAt=new Date();current.timeline.push({type:'delivery.exception_opened',message:`Exception ${exception.publicId} opened (${reasonCode})${evidenceRequired&&!evidence.length?' · evidence pending':''}.`,actorUserId});
    }
    if (['rescheduled','return_to_sender'].includes(nextStatus)) {
      const missingEvidence=await DeliveryException.countDocuments({shipmentId:current._id,status:{$in:['open','investigating']},evidenceRequired:true,evidenceDocumentIds:{$size:0}}).session(session);
      if(missingEvidence>0)throw new AppError('Upload the required failed-attempt/address evidence before rescheduling or returning this shipment.',409,'DELIVERY_EXCEPTION_EVIDENCE_REQUIRED');
    }
    if (nextStatus === 'rescheduled') { const date = new Date(rescheduledFor); if (!Number.isFinite(date.getTime()) || date <= new Date()) throw new AppError('Choose a future reschedule time.', 422, 'RESCHEDULE_INVALID'); current.rescheduledFor = date; }
    if (nextStatus === 'returned') { await Parcel.updateMany({ shipmentId: current._id }, { $set: { status: 'returned' }, $push: { timeline: { type: 'returned', message: 'Parcel returned to seller/warehouse.', actorUserId } } },{session}); await SellerShipment.updateMany({rootShipmentId:current._id},{$set:{status:'returned'},$push:{timeline:{type:'carrier.returned',message:`Consolidated carrier shipment ${current.publicId} was returned.`,actorUserId}}},{session}); }
    current.timeline.push({ type: nextStatus, message: reason || `Shipment moved to ${nextStatus.replaceAll('_', ' ')}.`, actorUserId }); await current.save({session});if(current.kind==='outbound')await refreshOrderLifecycle(current.orderId,{session});result=current;
  });return result;}finally{await session.endSession();}
}

async function recordCycleCountInSession({ stockItemId, countedOnHand, actorUserId, reason = 'Cycle count', sourceKey }, session) {
  if (!Number.isSafeInteger(countedOnHand) || countedOnHand < 0) throw new AppError('Cycle count must be a whole non-negative quantity.', 422, 'COUNT_INVALID');
  const fresh = await StockItem.findById(stockItemId).session(session);
  if (!fresh) throw new AppError('Stock item not found.', 404, 'STOCK_NOT_FOUND');
  if (countedOnHand < fresh.reserved + fresh.damaged + fresh.quarantined) throw new AppError('Counted stock cannot be below reserved, damaged and quarantined stock.', 422, 'COUNT_INVALID');
  const existing = sourceKey ? await InventoryDiscrepancy.findOne({ sourceKey }).session(session) : null;
  if (existing) return existing;
  const warehouse = await Warehouse.findById(fresh.warehouseId).select('country').session(session);
  if (!warehouse) throw new AppError('Warehouse no longer exists.', 409, 'WAREHOUSE_MISSING');
  const variance = countedOnHand - fresh.onHand;
  const [discrepancy] = await InventoryDiscrepancy.create([{
    publicId: publicId('idc'),
    sourceKey: sourceKey || `cycle-count:${publicId('run')}`,
    stockItemId: fresh._id,
    warehouseId: fresh.warehouseId,
    storeId: fresh.storeId,
    variantId: fresh.variantId,
    country: warehouse.country,
    expectedOnHand: fresh.onHand,
    countedOnHand,
    variance,
    reservedSnapshot: fresh.reserved,
    damagedSnapshot: fresh.damaged,
    quarantinedSnapshot: fresh.quarantined,
    reason: String(reason || 'Cycle count').trim().slice(0, 300) || 'Cycle count',
    status: variance === 0 ? 'no_variance' : 'pending_review',
    countedByUserId: actorUserId,
    countedAt: new Date(),
  }], { session });
  return discrepancy;
}

export async function completeCycleCount({ stockItem, countedOnHand, actorUserId, reason = 'Cycle count', sourceKey = '' }) {
  if (!stockItem?._id) throw new AppError('Stock item not found.', 404, 'STOCK_NOT_FOUND');
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await recordCycleCountInSession({
        stockItemId: stockItem._id,
        countedOnHand,
        actorUserId,
        reason,
        sourceKey: sourceKey || `manual-cycle-count:${publicId('run')}`,
      }, session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

export async function reviewInventoryDiscrepancy({ discrepancyPublicId, decision, actorUserId, reviewNote = '' }) {
  if (!['approve', 'reject'].includes(decision)) throw new AppError('Choose approve or reject.', 422, 'INVENTORY_REVIEW_INVALID');
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const discrepancy = await InventoryDiscrepancy.findOne({ publicId: discrepancyPublicId, status: 'pending_review' }).session(session);
      if (!discrepancy) throw new AppError('Pending inventory discrepancy not found.', 404, 'INVENTORY_DISCREPANCY_NOT_FOUND');
      if (String(discrepancy.countedByUserId) === String(actorUserId)) throw new AppError('The operator who counted stock cannot approve or reject their own variance.', 409, 'INVENTORY_REVIEW_FOUR_EYES');
      const note = String(reviewNote || '').trim().slice(0, 300);
      if (decision === 'reject' && !note) throw new AppError('A rejection reason is required.', 422, 'INVENTORY_REVIEW_NOTE_REQUIRED');
      if (decision === 'reject') {
        discrepancy.status = 'rejected';
        discrepancy.reviewedByUserId = actorUserId;
        discrepancy.reviewedAt = new Date();
        discrepancy.reviewNote = note;
        await discrepancy.save({ session });
        result = discrepancy;
        return;
      }

      const stock = await StockItem.findById(discrepancy.stockItemId).session(session);
      if (!stock) throw new AppError('Stock item no longer exists.', 409, 'STOCK_MISSING');
      const stale = stock.onHand !== discrepancy.expectedOnHand
        || stock.reserved !== discrepancy.reservedSnapshot
        || stock.damaged !== discrepancy.damagedSnapshot
        || stock.quarantined !== discrepancy.quarantinedSnapshot;
      if (stale) throw new AppError('Stock changed after this count. Reject it and perform a fresh cycle count instead of applying a stale adjustment.', 409, 'INVENTORY_DISCREPANCY_STALE');
      if (discrepancy.countedOnHand < stock.reserved + stock.damaged + stock.quarantined) throw new AppError('The approved count would make unavailable stock exceed on-hand stock.', 409, 'INVENTORY_DISCREPANCY_INVALID');

      const before = stock.onHand;
      stock.onHand = discrepancy.countedOnHand;
      await stock.save({ session });
      const [movement] = await InventoryMovement.create([{
        publicId: publicId('mov'),
        storeId: stock.storeId,
        stockItemId: stock._id,
        variantId: stock.variantId,
        warehouseId: stock.warehouseId,
        type: 'adjustment',
        quantity: stock.onHand - before,
        onHandBefore: before,
        onHandAfter: stock.onHand,
        reservedBefore: stock.reserved,
        reservedAfter: stock.reserved,
        damagedBefore: stock.damaged,
        damagedAfter: stock.damaged,
        quarantinedBefore: stock.quarantined,
        quarantinedAfter: stock.quarantined,
        reason: note || discrepancy.reason || 'Approved cycle-count discrepancy',
        reference: discrepancy.publicId,
        actorUserId,
      }], { session });
      discrepancy.status = 'approved';
      discrepancy.reviewedByUserId = actorUserId;
      discrepancy.reviewedAt = new Date();
      discrepancy.reviewNote = note;
      discrepancy.adjustmentMovementId = movement._id;
      await discrepancy.save({ session });
      result = discrepancy;
    });
    return result;
  } finally {
    await session.endSession();
  }
}

const warehouseTaskSlaHours=Object.freeze({receive:4,put_away:8,pick:2,pack:2,dispatch:2,cycle_count:24,transfer:12,return_inspection:24});
export async function createWarehouseTask(data, session = null) {
  const assignedUserId=data.assignedUserId||undefined,claimedAt=assignedUserId?new Date():undefined;
  const dueAt=data.dueAt||new Date(Date.now()+Number(warehouseTaskSlaHours[data.type]||24)*60*60*1000);
  const payload={publicId:publicId('wtk'),...data,dueAt,status:assignedUserId?'in_progress':'open',claimedAt,assignmentHistory:assignedUserId?[{userId:assignedUserId,action:'claimed',at:claimedAt}]:[]};
  if(session){const [task]=await WarehouseTask.create([payload],{session});return task;}
  return WarehouseTask.create(payload);
}

export async function claimWarehouseTask({taskPublicId,actorUserId}){
  const now=new Date();
  const task=await WarehouseTask.findOneAndUpdate(
    {publicId:taskPublicId,status:'open',$or:[{assignedUserId:null},{assignedUserId:{$exists:false}}]},
    {$set:{status:'in_progress',assignedUserId:actorUserId,claimedAt:now},$push:{assignmentHistory:{userId:actorUserId,action:'claimed',at:now}}},
    {returnDocument:'after'},
  );
  if(!task)throw new AppError('Warehouse task was already claimed or is no longer open.',409,'WAREHOUSE_TASK_CLAIM_CONFLICT');
  return task;
}

export async function releaseWarehouseTask({taskPublicId,actorUserId,force=false}){
  const query={publicId:taskPublicId,status:'in_progress'};if(!force)query.assignedUserId=actorUserId;
  const task=await WarehouseTask.findOneAndUpdate(query,{$set:{status:'open',assignedUserId:null,claimedAt:null},$push:{assignmentHistory:{userId:actorUserId,action:'released',at:new Date()}}},{returnDocument:'after'});
  if(!task)throw new AppError('Warehouse task is not assigned to you or is no longer in progress.',409,'WAREHOUSE_TASK_RELEASE_CONFLICT');
  return task;
}

async function refreshWarehouseWaveInSession(wavePublicId, actorUserId, taskPublicId, session){
  if(!wavePublicId)return;
  const wave=await WarehouseWave.findOne({publicId:wavePublicId,status:'in_progress'}).session(session);
  if(!wave)return;
  wave.history.push({action:'task_completed',actorUserId,taskPublicId});
  const remaining=await WarehouseTask.countDocuments({_id:{$in:wave.taskIds},status:{$nin:['completed','cancelled']}}).session(session);
  if(remaining===0){wave.status='completed';wave.completedAt=new Date();wave.history.push({action:'completed',actorUserId,at:wave.completedAt});}
  await wave.save({session});
}

export async function createPickWave({warehouseId,actorUserId,batchSize=20}){
  const size=Math.max(2,Math.min(50,Number(batchSize)||20));
  const session=await mongoose.startSession();let wave;
  try{
    await session.withTransaction(async()=>{
      const warehouse=await Warehouse.findOne({_id:warehouseId,active:true}).session(session);
      if(!warehouse)throw new AppError('Active warehouse not found.',404,'WAREHOUSE_NOT_FOUND');
      const candidates=await WarehouseTask.find({warehouseId:warehouse._id,type:'pick',status:'open',$or:[{assignedUserId:null},{assignedUserId:{$exists:false}}]}).sort({dueAt:1,createdAt:1,_id:1}).limit(size).session(session);
      if(!candidates.length)throw new AppError('No open pick tasks are available for this warehouse.',404,'PICK_WAVE_EMPTY');
      const wavePublicId=publicId('wav'),claimedAt=new Date(),claimed=[];
      for(const candidate of candidates){
        const task=await WarehouseTask.findOneAndUpdate({_id:candidate._id,status:'open',$or:[{assignedUserId:null},{assignedUserId:{$exists:false}}]},{$set:{status:'in_progress',assignedUserId:actorUserId,claimedAt,wavePublicId},$push:{assignmentHistory:{userId:actorUserId,action:'claimed',at:claimedAt}}},{returnDocument:'after',session});
        if(!task)throw new AppError('A pick task was claimed by another operator while the wave was being created. Retry the wave.',409,'PICK_WAVE_CLAIM_CONFLICT');
        claimed.push(task);
      }
      const parcelIds=[...new Set(claimed.map(task=>String(task.parcelId||'')).filter(Boolean))].map(id=>new mongoose.Types.ObjectId(id));
      const totalQuantity=claimed.reduce((sum,task)=>sum+Math.max(0,Number(task.quantity||0)),0);
      const dueDates=claimed.map(task=>task.dueAt).filter(Boolean).map(value=>new Date(value).getTime()).filter(Number.isFinite);
      [wave]=await WarehouseWave.create([{publicId:wavePublicId,warehouseId:warehouse._id,storeId:warehouse.storeId,country:warehouse.country,type:'pick',status:'in_progress',assignedUserId:actorUserId,taskIds:claimed.map(task=>task._id),parcelIds,taskCount:claimed.length,totalQuantity,dueAt:dueDates.length?new Date(Math.min(...dueDates)):undefined,startedAt:claimedAt,history:[{action:'created',actorUserId,at:claimedAt}]}],{session});
    });
    return wave;
  }finally{await session.endSession();}
}

export async function releasePickWave({wavePublicId,actorUserId,force=false}){
  const session=await mongoose.startSession();let result;
  try{
    await session.withTransaction(async()=>{
      const query={publicId:wavePublicId,status:'in_progress'};if(!force)query.assignedUserId=actorUserId;
      const wave=await WarehouseWave.findOne(query).session(session);
      if(!wave)throw new AppError('Pick wave is not active or is assigned to another operator.',409,'PICK_WAVE_RELEASE_CONFLICT');
      const now=new Date();
      await WarehouseTask.updateMany({_id:{$in:wave.taskIds},status:'in_progress',wavePublicId:wave.publicId},{$set:{status:'open',assignedUserId:null,claimedAt:null,wavePublicId:''},$push:{assignmentHistory:{userId:actorUserId,action:'released',at:now}}},{session});
      wave.status='released';wave.releasedAt=now;wave.history.push({action:'released',actorUserId,at:now});await wave.save({session});result=wave;
    });
    return result;
  }finally{await session.endSession();}
}

export async function executeWarehouseTask({ task, actorUserId, disposition = '' }) {
  const session = await mongoose.startSession();
  try { return await session.withTransaction(async () => {
    const current = await WarehouseTask.findOne({ _id: task._id, status: 'in_progress', assignedUserId: actorUserId }).session(session);
    if (!current) throw new AppError('Claim this warehouse task before execution; only the assigned operator can complete it.', 409, 'WAREHOUSE_TASK_NOT_OWNED');
    const warehouse = await Warehouse.findById(current.warehouseId).session(session);
    if (!warehouse) throw new AppError('Warehouse no longer exists.', 409, 'WAREHOUSE_MISSING');

    if (current.type === 'receive') {
      if (!current.stockItemId || !Number.isSafeInteger(current.quantity) || current.quantity <= 0) throw new AppError('Receiving needs a stock item and positive quantity.', 422, 'TASK_DATA_REQUIRED');
      const stock = await StockItem.findById(current.stockItemId).session(session); if (!stock || !stock.warehouseId.equals(warehouse._id)) throw new AppError('Stock item is not in this warehouse.', 409, 'STOCK_WAREHOUSE_MISMATCH');
      const before = stock.onHand; stock.onHand += current.quantity; await stock.save({ session });
      await InventoryMovement.create([{ publicId: publicId('mov'), storeId: stock.storeId, stockItemId: stock._id, variantId: stock.variantId, warehouseId: stock.warehouseId, type: 'receipt', quantity: current.quantity, onHandBefore: before, onHandAfter: stock.onHand, reservedBefore: stock.reserved, reservedAfter: stock.reserved, damagedBefore: stock.damaged, damagedAfter: stock.damaged, quarantinedBefore: stock.quarantined, quarantinedAfter: stock.quarantined, reason: current.notes || 'Warehouse receipt', reference: current.reference, actorUserId }], { session });
      current.result = { receivedQuantity: current.quantity };
    } else if (current.type === 'put_away') {
      if (!current.stockItemId || !current.binCode) throw new AppError('Put-away needs a stock item and destination bin.', 422, 'TASK_DATA_REQUIRED');
      const stock=await StockItem.findById(current.stockItemId).session(session);if(!stock||!stock.warehouseId.equals(warehouse._id))throw new AppError('Stock item is not in this warehouse.',409,'STOCK_WAREHOUSE_MISMATCH');
      const before=stock.binCode||'';stock.binCode=current.binCode;await stock.save({session});
      await InventoryMovement.create([{publicId:publicId('mov'),storeId:stock.storeId,stockItemId:stock._id,variantId:stock.variantId,warehouseId:stock.warehouseId,type:'put_away',quantity:0,onHandBefore:stock.onHand,onHandAfter:stock.onHand,reservedBefore:stock.reserved,reservedAfter:stock.reserved,damagedBefore:stock.damaged,damagedAfter:stock.damaged,quarantinedBefore:stock.quarantined,quarantinedAfter:stock.quarantined,binBefore:before,binAfter:stock.binCode,reason:current.notes||'Put-away completed',reference:current.reference,actorUserId}],{session});current.result={binCode:stock.binCode};
    } else if (current.type === 'pick') {
      if(!current.parcelId)throw new AppError('Pick task needs a parcel.',422,'TASK_DATA_REQUIRED');const parcel=await Parcel.findById(current.parcelId).session(session);if(!parcel)throw new AppError('Parcel not found.',404,'PARCEL_NOT_FOUND');if(!['created','picking'].includes(parcel.status))throw new AppError('Parcel is not ready for picking.',409,'PARCEL_STATE');
      const total=parcel.items.reduce((sum,item)=>sum+item.quantity,0);const remaining=total-parcel.pickedQuantity;const qty=current.quantity||remaining;if(!Number.isSafeInteger(qty)||qty<=0||qty>remaining)throw new AppError('Pick quantity exceeds the parcel requirement.',422,'PICK_QUANTITY_INVALID');parcel.pickedQuantity+=qty;parcel.status=parcel.pickedQuantity===total?'picked':'picking';parcel.timeline.push({type:'pick',message:`Picked ${qty} item(s); ${parcel.pickedQuantity}/${total} complete.`,actorUserId});await parcel.save({session});await syncSellerShipmentFromParcel(parcel,actorUserId,session);current.result={pickedQuantity:qty,totalPicked:parcel.pickedQuantity,required:total,parcelStatus:parcel.status};
    } else if (current.type === 'pack') {
      if (!current.parcelId) throw new AppError('Pack task needs a parcel.', 422, 'TASK_DATA_REQUIRED'); const parcel = await Parcel.findById(current.parcelId).session(session); if (!parcel) throw new AppError('Parcel not found.', 404, 'PARCEL_NOT_FOUND');if(parcel.status!=='picked')throw new AppError('Parcel must be completely picked before packing.',409,'PARCEL_STATE');
      parcel.status='packed';parcel.timeline.push({type:'pack',message:'Parcel packing verified.',actorUserId});await parcel.save({session});await syncSellerShipmentFromParcel(parcel,actorUserId,session);current.result={parcelStatus:parcel.status};
    } else if (current.type === 'dispatch') {
      if (!current.parcelId) throw new AppError('Dispatch task needs a parcel.', 422, 'TASK_DATA_REQUIRED'); const parcel = await Parcel.findById(current.parcelId).session(session); if (!parcel) throw new AppError('Parcel not found.', 404, 'PARCEL_NOT_FOUND');if(parcel.status!=='packed')throw new AppError('Only a packed parcel can be dispatched.',409,'PARCEL_STATE');
      parcel.status='handed_over';parcel.timeline.push({type:'dispatch',message:'Parcel dispatched for carrier handoff.',actorUserId});await parcel.save({session});await syncSellerShipmentFromParcel(parcel,actorUserId,session);current.result={parcelStatus:parcel.status};
    } else if (current.type === 'cycle_count') {
      if(!current.stockItemId||!Number.isSafeInteger(current.quantity)||current.quantity<0)throw new AppError('Cycle count needs a stock item and counted on-hand quantity.',422,'TASK_DATA_REQUIRED');
      const stock=await StockItem.findById(current.stockItemId).session(session);if(!stock||!stock.warehouseId.equals(warehouse._id))throw new AppError('Stock item is not in this warehouse.',409,'STOCK_WAREHOUSE_MISMATCH');
      const discrepancy=await recordCycleCountInSession({stockItemId:stock._id,countedOnHand:current.quantity,actorUserId,reason:current.notes||'Warehouse cycle count',sourceKey:`warehouse-task:${current.publicId}`},session);
      current.result={countedOnHand:discrepancy.countedOnHand,expectedOnHand:discrepancy.expectedOnHand,variance:discrepancy.variance,discrepancyPublicId:discrepancy.publicId,reviewStatus:discrepancy.status};
    } else if (current.type === 'transfer') {
      if (!current.stockItemId || !current.destinationWarehouseId || !Number.isSafeInteger(current.quantity) || current.quantity <= 0) throw new AppError('Transfer needs stock, destination warehouse and quantity.', 422, 'TASK_DATA_REQUIRED');
      const source = await StockItem.findById(current.stockItemId).session(session); const destinationWarehouse = await Warehouse.findById(current.destinationWarehouseId).session(session);
      if (!source || !destinationWarehouse || !source.storeId.equals(destinationWarehouse.storeId)) throw new AppError('Transfer warehouses/store do not match.', 409, 'TRANSFER_SCOPE');
      if (source.onHand - source.reserved - source.damaged - source.quarantined < current.quantity) throw new AppError('Transfer quantity exceeds available stock.', 409, 'INSUFFICIENT_STOCK');
      let destination = await StockItem.findOne({ warehouseId: destinationWarehouse._id, variantId: source.variantId }).session(session);
      if (!destination) { const docs = await StockItem.create([{ publicId: publicId('stk'), storeId: source.storeId, warehouseId: destinationWarehouse._id, variantId: source.variantId, onHand: 0, reserved: 0, damaged:0, quarantined:0, reorderPoint: source.reorderPoint }], { session }); destination = docs[0]; }
      const sourceBefore = source.onHand; const destBefore = destination.onHand; source.onHand -= current.quantity; destination.onHand += current.quantity; await source.save({ session }); await destination.save({ session });
      await InventoryMovement.create([{ publicId: publicId('mov'), storeId: source.storeId, stockItemId: source._id, variantId: source.variantId, warehouseId: source.warehouseId, type: 'transfer', quantity: -current.quantity, onHandBefore: sourceBefore, onHandAfter: source.onHand, reservedBefore: source.reserved, reservedAfter: source.reserved, damagedBefore:source.damaged,damagedAfter:source.damaged,quarantinedBefore:source.quarantined,quarantinedAfter:source.quarantined, reason: 'Warehouse transfer out', reference: current.publicId, actorUserId }, { publicId: publicId('mov'), storeId: destination.storeId, stockItemId: destination._id, variantId: destination.variantId, warehouseId: destination.warehouseId, type: 'transfer', quantity: current.quantity, onHandBefore: destBefore, onHandAfter: destination.onHand, reservedBefore: destination.reserved, reservedAfter: destination.reserved, damagedBefore:destination.damaged,damagedAfter:destination.damaged,quarantinedBefore:destination.quarantined,quarantinedAfter:destination.quarantined, reason: 'Warehouse transfer in', reference: current.publicId, actorUserId }], { session });
      current.result = { transferredQuantity: current.quantity, destinationWarehouseId: destinationWarehouse.publicId };
    } else if (current.type === 'return_inspection') {
      const finalDisposition=current.disposition||disposition;
      if(!current.returnRequestId||!current.returnOrderLineId||!current.stockItemId||!Number.isSafeInteger(current.quantity)||current.quantity<=0||!['good','damaged','quarantine'].includes(finalDisposition))throw new AppError('Return inspection must come from an authoritative received return line and include a disposition.',422,'TASK_DATA_REQUIRED');
      const returnRequest=await ReturnRequest.findOne({_id:current.returnRequestId,status:'received'}).session(session);if(!returnRequest)throw new AppError('This return is not in the warehouse inspection stage.',409,'RETURN_INSPECTION_STATE');
      const returned=returnRequest.items.find(item=>String(item.orderLineId)===String(current.returnOrderLineId));if(!returned||String(returned.storeId)!==String(current.storeId)||String(returned.variantId)!==String(current.variantId)||Number(returned.quantity)!==Number(current.quantity))throw new AppError('Warehouse return task no longer matches the immutable returned order line.',409,'RETURN_INSPECTION_SCOPE');
      if(returned.warehouseInspectionStatus==='completed')throw new AppError('This returned order line was already inspected.',409,'RETURN_INSPECTION_DUPLICATE');
      if(returned.warehouseTaskPublicId&&String(returned.warehouseTaskPublicId)!==String(current.publicId))throw new AppError('This returned order line belongs to another warehouse task.',409,'RETURN_INSPECTION_TASK_MISMATCH');
      const stock=await StockItem.findById(current.stockItemId).session(session);if(!stock||!stock.warehouseId.equals(warehouse._id)||String(stock.storeId)!==String(current.storeId)||String(stock.variantId)!==String(current.variantId))throw new AppError('Stock item is outside the authoritative return-line scope.',409,'STOCK_WAREHOUSE_MISMATCH');
      const before={onHand:stock.onHand,damaged:stock.damaged,quarantined:stock.quarantined};stock.onHand+=current.quantity;if(finalDisposition==='damaged')stock.damaged+=current.quantity;if(finalDisposition==='quarantine')stock.quarantined+=current.quantity;await stock.save({session});
      await InventoryMovement.create([{publicId:publicId('mov'),storeId:stock.storeId,stockItemId:stock._id,variantId:stock.variantId,warehouseId:stock.warehouseId,type:'return',quantity:current.quantity,onHandBefore:before.onHand,onHandAfter:stock.onHand,reservedBefore:stock.reserved,reservedAfter:stock.reserved,damagedBefore:before.damaged,damagedAfter:stock.damaged,quarantinedBefore:before.quarantined,quarantinedAfter:stock.quarantined,reason:current.notes||`Returned stock inspected as ${finalDisposition}`,reference:returnRequest.publicId,actorUserId}],{session});
      returned.warehouseTaskPublicId=current.publicId;returned.warehouseInspectionStatus='completed';returned.stockDisposition=finalDisposition;returned.inspectedQuantity=current.quantity;returned.warehouseInspectedByUserId=actorUserId;returned.warehouseInspectedAt=new Date();returnRequest.timeline.push({type:'return.warehouse_inspected',message:`${returned.sku||returned.title} × ${current.quantity} inspected as ${finalDisposition}.`,actorUserId});await returnRequest.save({session});current.result={returnPublicId:returnRequest.publicId,orderLineId:returned.orderLineId,returnedQuantity:current.quantity,disposition:finalDisposition};
    } else throw new AppError('Warehouse task type is unsupported.',422,'TASK_TYPE_INVALID');

    current.status='completed';current.completedAt=new Date();current.assignmentHistory.push({userId:actorUserId,action:'completed',at:current.completedAt});await current.save({session});await refreshWarehouseWaveInSession(current.wavePublicId,actorUserId,current.publicId,session);return current;
  }); } finally { await session.endSession(); }
}

export async function recordCodHandover({shipment,actorUserId,declaredAmountMinor,evidenceDocumentId}){
  if(!Number.isSafeInteger(declaredAmountMinor)||declaredAmountMinor<0)throw new AppError('COD handover amount must be a non-negative whole minor-unit amount.',422,'COD_HANDOVER_AMOUNT_INVALID');
  const session=await mongoose.startSession();let result;
  try{await session.withTransaction(async()=>{
    const current=await Shipment.findOne({_id:shipment._id,deliveryUserId:actorUserId}).session(session);if(!current)throw new AppError('Assigned shipment not found.',404,'SHIPMENT_NOT_FOUND');
    if(!current.cod.required||current.status!=='delivered')throw new AppError('Only delivered COD shipments can be handed over.',409,'COD_HANDOVER_NOT_READY');if(current.cod.reconciledAt)throw new AppError('This COD shipment is already reconciled.',409,'COD_ALREADY_RECONCILED');if(current.cod.handoverAt&&!current.cod.mismatchExceptionPublicId){result={shipment:current,mismatch:false};return;}
    const evidence=await EvidenceDocument.findOne({_id:evidenceDocumentId,contextType:'delivery_job',contextPublicId:current.publicId,documentType:'cod_handover',status:'ready',ownerUserId:actorUserId}).session(session);if(!evidence)throw new AppError('A COD handover receipt image is required.',422,'COD_HANDOVER_RECEIPT_REQUIRED');
    current.cod.handoverDeclaredMinor=declaredAmountMinor;current.cod.handoverAt=new Date();current.cod.handoverByUserId=actorUserId;current.cod.handoverEvidenceDocumentId=evidence._id;
    if(declaredAmountMinor!==Number(current.cod.collectedMinor||0)){
      let exception=null;
      if(current.cod.mismatchExceptionPublicId){
        exception=await DeliveryException.findOne({publicId:current.cod.mismatchExceptionPublicId,shipmentId:current._id,status:{$in:['open','investigating']}}).session(session);
        if(exception){exception.observedAmountMinor=declaredAmountMinor;exception.evidenceDocumentIds.addToSet(evidence._id);exception.status='investigating';exception.timeline.push({type:'handover_corrected_but_mismatch_remains',message:'Delivery partner submitted a replacement COD handover receipt, but the declared amount still does not match.',actorUserId});await exception.save({session});}
      }
      if(!exception){exception=await createDeliveryExceptionInSession({shipment:current,type:'cod_mismatch',reasonCode:'cod_amount_mismatch',description:'Delivery partner declared a COD handover amount that does not equal the collected shipment amount.',evidenceRequired:true,evidenceDocumentIds:[evidence._id],expectedAmountMinor:Number(current.cod.collectedMinor||0),observedAmountMinor:declaredAmountMinor,currency:current.cod.currency,actorUserId},session);current.cod.mismatchExceptionPublicId=exception.publicId;}
      current.timeline.push({type:'cod_handover_mismatch',message:`COD handover mismatch escalated as ${exception.publicId}.`,actorUserId});await current.save({session});result={shipment:current,mismatch:true,exception};return;
    }
    current.timeline.push({type:current.cod.mismatchExceptionPublicId?'cod_handover_corrected':'cod_handover_recorded',message:current.cod.mismatchExceptionPublicId?'Delivery partner corrected the COD handover amount/evidence; supervisor resolution is still required.':'Delivery partner recorded COD cash handover with receipt evidence.',actorUserId});await current.save({session});result={shipment:current,mismatch:Boolean(current.cod.mismatchExceptionPublicId),corrected:Boolean(current.cod.mismatchExceptionPublicId)};
  });return result;}finally{await session.endSession();}
}

export async function resolveDeliveryException({exceptionPublicId,actorUserId,decision,resolutionNote}){
  if(!['resolve','dismiss'].includes(decision))throw new AppError('Choose resolve or dismiss.',422,'DELIVERY_EXCEPTION_DECISION_INVALID');
  if(String(resolutionNote||'').trim().length<3)throw new AppError('Add a resolution note.',422,'DELIVERY_EXCEPTION_NOTE_REQUIRED');
  const session=await mongoose.startSession();let resolved;
  try{await session.withTransaction(async()=>{
    const exception=await DeliveryException.findOne({publicId:exceptionPublicId,status:{$in:['open','investigating']}}).session(session);
    if(!exception)throw new AppError('Open delivery exception not found.',404,'DELIVERY_EXCEPTION_NOT_FOUND');
    if(exception.type==='cod_mismatch'&&decision==='resolve'){
      const shipment=await Shipment.findById(exception.shipmentId).session(session);
      if(shipment&&shipment.cod?.mismatchExceptionPublicId===exception.publicId){
        if(Number(shipment.cod.handoverDeclaredMinor||0)!==Number(shipment.cod.collectedMinor||0))throw new AppError('Correct COD handover evidence/amount before resolving the mismatch.',409,'COD_MISMATCH_UNRESOLVED');
        shipment.cod.mismatchExceptionPublicId='';shipment.timeline.push({type:'cod_mismatch_resolved',message:`COD mismatch ${exception.publicId} resolved by an authorized supervisor.`,actorUserId});await shipment.save({session});
      }
    }
    exception.status=decision==='resolve'?'resolved':'dismissed';exception.resolvedAt=new Date();exception.resolvedByUserId=actorUserId;exception.resolutionNote=String(resolutionNote).trim().slice(0,600);exception.timeline.push({type:exception.status,message:exception.resolutionNote,actorUserId});await exception.save({session});resolved=exception;
  });return resolved;}finally{await session.endSession();}
}

export async function reconcileCod({ shipment, actorUserId }) {
  if (!shipment?._id) throw new AppError('COD shipment is missing.', 404, 'COD_SHIPMENT_MISSING');
  const session = await mongoose.startSession();
  try {
    let reconciledShipment;
    await session.withTransaction(async () => {
      const currentShipment = await Shipment.findById(shipment._id).session(session);
      if (!currentShipment) throw new AppError('COD shipment is missing.', 404, 'COD_SHIPMENT_MISSING');
      if (!currentShipment.cod.required || currentShipment.status !== 'delivered') throw new AppError('Only delivered COD shipments can be reconciled.', 409, 'COD_NOT_READY');
      if (currentShipment.cod.reconciledAt) { reconciledShipment = currentShipment; return; }
      if (!currentShipment.cod.handoverAt || !currentShipment.cod.handoverEvidenceDocumentId) throw new AppError('Delivery partner COD handover receipt is required before finance reconciliation.', 409, 'COD_HANDOVER_REQUIRED');
      if (currentShipment.cod.mismatchExceptionPublicId) throw new AppError('Resolve the open COD handover mismatch before reconciliation.', 409, 'COD_MISMATCH_OPEN');
      if (Number(currentShipment.cod.handoverDeclaredMinor||0) !== Number(currentShipment.cod.collectedMinor||0)) throw new AppError('COD handover amount does not match the collected amount.', 409, 'COD_HANDOVER_MISMATCH');
      if (currentShipment.cod.collectedMinor !== currentShipment.cod.amountMinor) throw new AppError('Collected COD amount does not match the order.', 409, 'COD_MISMATCH');

      const order = await Order.findById(currentShipment.orderId).session(session);
      if (!order) throw new AppError('COD order record is missing.', 409, 'COD_ORDER_MISSING');
      if (!['confirmed', 'paid'].includes(order.status)) throw new AppError('COD order is not ready for reconciliation.', 409, 'COD_ORDER_NOT_READY');
      const intent = await PaymentIntent.findOne({ orderId: order._id, provider: 'cod', status: 'pending_collection' }).session(session);
      if (!intent) throw new AppError('COD payment record is missing.', 409, 'COD_PAYMENT_MISSING');
      if (intent.amountMinor !== order.totals.totalMinor || intent.currency !== order.totals.currency) throw new AppError('COD payment amount or currency no longer matches the order.', 409, 'COD_PAYMENT_MISMATCH');

      const clearing = await ensureLedgerAccount({ code: 'cod_clearing', type: 'asset', ownerType: 'platform', ownerPublicId: 'classic-mart', country: order.country, currency: order.totals.currency }, session);
      const entries = [{ account: clearing, debitMinor: order.totals.totalMinor, creditMinor: 0, memo: 'Reconciled COD collection' }];
      const sellerOrders = await SellerOrder.find({ orderId: order._id }).session(session).lean();
      let platformFeeTotal = 0;
      for (const sellerOrder of sellerOrders) {
        const settlement = sellerSettlementBreakdown(sellerOrder);
        platformFeeTotal += settlement.platformFeeMinor;
        const store = await Store.findOne({ publicId: sellerOrder.storePublicId }).session(session);
        const payable = await ensureLedgerAccount({ code: 'seller_payable', type: 'liability', ownerType: 'store', ownerId: store?._id, ownerPublicId: sellerOrder.storePublicId, country: order.country, currency: order.totals.currency }, session);
        if (settlement.sellerPayableMinor > 0) entries.push({ account: payable, debitMinor: 0, creditMinor: settlement.sellerPayableMinor, memo: 'Seller payable net of discount and marketplace fee from COD' });
      }
      const platformAmount = platformFeeTotal + Number(order.totals.shippingMinor || 0);
      if (platformAmount > 0) {
        const revenue = await ensureLedgerAccount({ code: 'platform_revenue', type: 'revenue', ownerType: 'platform', ownerPublicId: 'classic-mart', country: order.country, currency: order.totals.currency }, session);
        entries.push({ account: revenue, debitMinor: 0, creditMinor: platformAmount, memo: 'COD marketplace fees and delivery revenue' });
      }
      if (order.totals.taxMinor > 0) {
        const tax = await ensureLedgerAccount({ code: 'tax_payable', type: 'liability', ownerType: 'platform', ownerPublicId: 'classic-mart', country: order.country, currency: order.totals.currency }, session);
        entries.push({ account: tax, debitMinor: 0, creditMinor: order.totals.taxMinor, memo: 'COD collected tax liability' });
      }
      await postLedgerTransaction({ idempotencyKey: `cod:${currentShipment.publicId}`, referenceType: 'cod_reconciliation', referencePublicId: currentShipment.publicId, currency: order.totals.currency, country: order.country, description: `COD collection for ${order.publicId}`, entries }, session);

      currentShipment.cod.reconciledAt = new Date();
      currentShipment.timeline.push({ type: 'cod_reconciled', message: 'COD collection reconciled to marketplace ledger.', actorUserId });
      await currentShipment.save({ session });
      intent.status = 'succeeded'; intent.paidAt = new Date();
      order.paymentState = 'paid'; syncLegacyOrderStatus(order); order.timeline.push({ type: 'payment.cod_reconciled', message: 'Cash on delivery collection verified and reconciled.' });
      const { issuePaymentReceipt } = await import('./financial-documents.js'); await issuePaymentReceipt(order, intent, session);
      await intent.save({ session }); await order.save({ session });
      const { makeOrderCommissionsPayable } = await import('./promoters.js'); await makeOrderCommissionsPayable(order, session);
      const { applyGrowthForPaidOrder } = await import('./stage9.js'); await applyGrowthForPaidOrder(order, session);
      reconciledShipment = currentShipment;
    });
    return reconciledShipment;
  } finally { await session.endSession(); }
}


export async function reconcileCodBatch({ country, deliveryUserId, businessDate, currency, declaredAmountMinor, actorUserId }) {
  const cleanCountry=String(country||'').toUpperCase(); const cleanCurrency=String(currency||'').toUpperCase();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate||'')))throw new AppError('Choose a valid business date.',422,'COD_DATE_INVALID');
  if(!Number.isSafeInteger(declaredAmountMinor)||declaredAmountMinor<0)throw new AppError('Declared COD amount must be a non-negative whole minor-unit amount.',422,'COD_DECLARED_INVALID');
  const setting=await CountrySetting.findOne({code:cleanCountry,active:true}).lean();if(!setting)throw new AppError('Country settings are unavailable.',409,'COUNTRY_SETTINGS_MISSING');
  const shipments=await Shipment.find({country:cleanCountry,deliveryUserId,status:'delivered','cod.required':true,'cod.reconciledAt':null,'cod.handoverAt':{$ne:null},'cod.mismatchExceptionPublicId':'','cod.currency':cleanCurrency,$expr:{$eq:[{$dateToString:{date:'$deliveredAt',format:'%Y-%m-%d',timezone:setting.timeZone}},businessDate]}}).sort({deliveredAt:1});
  if(!shipments.length)throw new AppError('No unreconciled delivered COD shipments match this partner and date.',404,'COD_BATCH_EMPTY');
  const expectedAmountMinor=shipments.reduce((sum,shipment)=>sum+Number(shipment.cod.amountMinor||0),0);const collectedAmountMinor=shipments.reduce((sum,shipment)=>sum+Number(shipment.cod.collectedMinor||0),0);
  if(expectedAmountMinor!==collectedAmountMinor)throw new AppError('Driver COD collection does not match the shipment total.',409,'COD_BATCH_MISMATCH');
  if(declaredAmountMinor!==collectedAmountMinor)throw new AppError('Declared handover amount does not match the driver/day COD total.',409,'COD_DECLARED_MISMATCH');
  const run=await ReconciliationRun.create({publicId:publicId('rec'),country:cleanCountry,provider:'cod',startedByUserId:actorUserId,deliveryUserId,businessDate,currency:cleanCurrency,expectedAmountMinor,declaredAmountMinor,shipmentPublicIds:shipments.map(shipment=>shipment.publicId),status:'running',checked:shipments.length,matched:shipments.length,updated:0,failed:0});
  const errors=[];let updated=0;
  for(const shipment of shipments){try{await reconcileCod({shipment,actorUserId});updated+=1;}catch(error){const code=String(error?.code||'COD_RECONCILIATION_ERROR').slice(0,80);const message=error?.expose===false?'Internal COD reconciliation error.':String(error?.message||'COD reconciliation failed').slice(0,180);errors.push(`${shipment.publicId}: ${code}: ${message}`);}}
  run.updated=updated;run.failed=errors.length;run.errorMessages=errors;run.status=errors.length?'failed':'completed';run.completedAt=new Date();await run.save();
  if(errors.length){const firstCode=errors[0]?.split(': ')[1]||'COD_RECONCILIATION_ERROR';throw new AppError(`COD batch reconciled ${updated}/${shipments.length} shipments (${firstCode}). Review reconciliation run ${run.publicId} before retrying.`,409,'COD_BATCH_PARTIAL',{reconciliationRunId:run.publicId,failureCode:firstCode});}
  return run;
}

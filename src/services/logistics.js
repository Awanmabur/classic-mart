import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { encryptSensitive } from '../core/sensitive.js';
import {
  CountrySetting, DeliveryOffer, InventoryMovement, Order, Parcel, PaymentIntent, ReconciliationRun, SellerOrder, Shipment, StockItem, Store, Warehouse, WarehouseTask,
} from '../models/index.js';
import { ensureLedgerAccount, postLedgerTransaction, sellerSettlementBreakdown } from './money.js';

const allowedTransitions = Object.freeze({
  ready: ['offered'], offered: ['assigned', 'ready'], assigned: ['picked_up', 'failed'], picked_up: ['in_transit', 'failed'],
  in_transit: ['delivered', 'failed', 'rescheduled', 'return_to_sender'], failed: ['rescheduled', 'return_to_sender'],
  rescheduled: ['in_transit', 'failed', 'return_to_sender'], return_to_sender: ['returned'], delivered: [], returned: [],
});
export function canTransitionShipment(from, to) { return (allowedTransitions[from] || []).includes(to); }
export function hashProofCode(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
export function verifyProofCode(value, proofHash) { const a = Buffer.from(hashProofCode(value)); const b = Buffer.from(String(proofHash || '')); return a.length === b.length && crypto.timingSafeEqual(a, b); }

export async function ensureShipmentForOrder(order, actorUserId) {
  const existing = await Shipment.findOne({ orderId: order._id }); if (existing) return existing;
  if (!['confirmed', 'paid'].includes(order.status) && order.paymentMethod !== 'cod') throw new AppError('Order is not ready for fulfilment.', 409, 'ORDER_NOT_READY');
  const pickup = String(crypto.randomInt(100000, 999999)); const delivery = String(crypto.randomInt(100000, 999999));
  const shipment = await Shipment.create({ publicId: publicId('shp'), orderId: order._id, orderPublicId: order.publicId, country: order.country, mode: order.deliveryMethod, pickupCodeHash: hashProofCode(pickup), deliveryCodeHash: hashProofCode(delivery), pickupCodeEncrypted: encryptSensitive(pickup), deliveryCodeEncrypted: encryptSensitive(delivery), cod: { required: order.paymentMethod === 'cod', amountMinor: order.paymentMethod === 'cod' ? order.totals.totalMinor : 0, currency: order.totals.currency, collectedMinor: 0 }, parcelCount: Math.max(1, new Set(order.items.map(item => item.storePublicId)).size), timeline: [{ type: 'shipment_created', message: 'Shipment created from confirmed order.', actorUserId }] });
  const storeIds = [...new Set(order.items.map(item => item.storePublicId))];
  for (const storePublicId of storeIds) {
    await Parcel.create({ publicId: publicId('par'), shipmentId: shipment._id, orderPublicId: order.publicId, storePublicId, barcode: `CM-${crypto.randomBytes(8).toString('hex').toUpperCase()}`, items: order.items.filter(item=>item.storePublicId===storePublicId).map(item=>({productPublicId:item.productPublicId,variantPublicId:item.variantPublicId,sku:item.sku,title:item.title,quantity:item.quantity})), timeline: [{ type: 'created', message: 'Parcel created for seller fulfilment.', actorUserId }] });
  }
  return shipment;
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

async function postDeliveryEarning(shipment) {
  if(!shipment.deliveryUserId)return null;
  const offer=await DeliveryOffer.findOne({shipmentId:shipment._id,deliveryUserId:shipment.deliveryUserId,status:'accepted'}).lean();
  if(!offer||!Number.isSafeInteger(offer.earningMinor)||offer.earningMinor<=0)return null;
  const expense=await ensureLedgerAccount({code:'delivery_expense',type:'expense',ownerType:'platform',ownerPublicId:'classic-mart',country:shipment.country,currency:offer.currency});
  const payable=await ensureLedgerAccount({code:'delivery_payable',type:'liability',ownerType:'delivery',ownerPublicId:String(shipment.deliveryUserId),country:shipment.country,currency:offer.currency});
  return postLedgerTransaction({idempotencyKey:`delivery-earning:${shipment.publicId}`,referenceType:'delivery_earning',referencePublicId:shipment.publicId,currency:offer.currency,country:shipment.country,description:`Delivery earning for ${shipment.publicId}`,entries:[{account:expense,debitMinor:offer.earningMinor,creditMinor:0,memo:'Delivery partner service expense'},{account:payable,debitMinor:0,creditMinor:offer.earningMinor,memo:'Delivery partner payable'}]});
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

export async function transitionShipment({ shipment, nextStatus, actorUserId, proofCode = '', reason = '', rescheduledFor = null }) {
  if (!canTransitionShipment(shipment.status, nextStatus)) throw new AppError('Shipment status transition is not allowed.', 409, 'SHIPMENT_TRANSITION_INVALID');
  if (nextStatus === 'picked_up' && shipment.kind === 'outbound') {
    const unreadyParcels = await Parcel.countDocuments({ shipmentId: shipment._id, status: { $ne: 'handed_over' } });
    if (unreadyParcels > 0) throw new AppError('Every seller parcel must be packed and handed over before carrier pickup.', 409, 'PARCEL_HANDOFF_REQUIRED');
  }
  if (nextStatus === 'picked_up' && !verifyProofCode(proofCode, shipment.pickupCodeHash)) throw new AppError('Pickup verification code is invalid.', 422, 'PROOF_INVALID');
  if (nextStatus === 'delivered' && !verifyProofCode(proofCode, shipment.deliveryCodeHash)) throw new AppError('Delivery verification code is invalid.', 422, 'PROOF_INVALID');
  shipment.status = nextStatus;
  if (nextStatus === 'picked_up') { shipment.pickedUpAt = new Date(); await Parcel.updateMany({ shipmentId: shipment._id, status: { $in: ['packed', 'handed_over'] } }, { $set: { status: 'in_transit' }, $push: { timeline: { type: 'picked_up', message: 'Parcel picked up by delivery partner.', actorUserId } } }); }
  if (nextStatus === 'delivered') { shipment.deliveredAt = new Date(); shipment.proof = { type: 'otp', reference: 'verified', recordedAt: new Date() }; if (shipment.cod.required) shipment.cod.collectedMinor = shipment.cod.amountMinor; await Parcel.updateMany({ shipmentId: shipment._id }, { $set: { status: 'delivered' }, $push: { timeline: { type: 'delivered', message: 'Parcel delivered with verified OTP.', actorUserId } } }); await SellerOrder.updateMany({ orderId: shipment.orderId, status: { $in: ['confirmed','processing','ready'] } }, { $set: { status: 'fulfilled' }, $push: { timeline: { type: 'fulfilment.delivered', message: 'Seller parcel delivered with verified proof.' } } }); await postDeliveryEarning(shipment); }
  if (nextStatus === 'failed') { if (!reason.trim()) throw new AppError('Failed delivery requires a reason.', 422, 'REASON_REQUIRED'); shipment.failedReason = reason.trim(); }
  if (nextStatus === 'rescheduled') { const date = new Date(rescheduledFor); if (!Number.isFinite(date.getTime()) || date <= new Date()) throw new AppError('Choose a future reschedule time.', 422, 'RESCHEDULE_INVALID'); shipment.rescheduledFor = date; }
  if (nextStatus === 'returned') await Parcel.updateMany({ shipmentId: shipment._id }, { $set: { status: 'returned' }, $push: { timeline: { type: 'returned', message: 'Parcel returned to seller/warehouse.', actorUserId } } });
  shipment.timeline.push({ type: nextStatus, message: reason || `Shipment moved to ${nextStatus.replaceAll('_', ' ')}.`, actorUserId }); await shipment.save(); return shipment;
}

export async function completeCycleCount({ stockItem, countedOnHand, actorUserId, reason = 'Cycle count' }) {
  if (!Number.isSafeInteger(countedOnHand) || countedOnHand < stockItem.reserved + stockItem.damaged + stockItem.quarantined) throw new AppError('Counted stock cannot be below reserved, damaged and quarantined stock.', 422, 'COUNT_INVALID');
  const session = await mongoose.startSession(); try { return await session.withTransaction(async () => { const fresh = await StockItem.findById(stockItem._id).session(session); const before = fresh.onHand; fresh.onHand = countedOnHand; await fresh.save({ session }); await InventoryMovement.create([{ publicId: publicId('mov'), storeId: fresh.storeId, stockItemId: fresh._id, variantId: fresh.variantId, warehouseId: fresh.warehouseId, type: 'adjustment', quantity: countedOnHand - before, onHandBefore: before, onHandAfter: countedOnHand, reservedBefore: fresh.reserved, reservedAfter: fresh.reserved, reason, reference: 'cycle_count', actorUserId }], { session }); return fresh; }); } finally { await session.endSession(); }
}

export async function createWarehouseTask(data) { return WarehouseTask.create({ publicId: publicId('wtk'), ...data }); }

export async function executeWarehouseTask({ task, actorUserId, disposition = '' }) {
  const session = await mongoose.startSession();
  try { return await session.withTransaction(async () => {
    const current = await WarehouseTask.findOne({ _id: task._id, status: { $in: ['open', 'in_progress'] } }).session(session);
    if (!current) throw new AppError('Warehouse task is already completed or cancelled.', 409, 'TASK_STATE');
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
      const total=parcel.items.reduce((sum,item)=>sum+item.quantity,0);const remaining=total-parcel.pickedQuantity;const qty=current.quantity||remaining;if(!Number.isSafeInteger(qty)||qty<=0||qty>remaining)throw new AppError('Pick quantity exceeds the parcel requirement.',422,'PICK_QUANTITY_INVALID');parcel.pickedQuantity+=qty;parcel.status=parcel.pickedQuantity===total?'picked':'picking';parcel.timeline.push({type:'pick',message:`Picked ${qty} item(s); ${parcel.pickedQuantity}/${total} complete.`,actorUserId});await parcel.save({session});current.result={pickedQuantity:qty,totalPicked:parcel.pickedQuantity,required:total,parcelStatus:parcel.status};
    } else if (current.type === 'pack') {
      if (!current.parcelId) throw new AppError('Pack task needs a parcel.', 422, 'TASK_DATA_REQUIRED'); const parcel = await Parcel.findById(current.parcelId).session(session); if (!parcel) throw new AppError('Parcel not found.', 404, 'PARCEL_NOT_FOUND');if(parcel.status!=='picked')throw new AppError('Parcel must be completely picked before packing.',409,'PARCEL_STATE');
      parcel.status='packed';parcel.timeline.push({type:'pack',message:'Parcel packing verified.',actorUserId});await parcel.save({session});current.result={parcelStatus:parcel.status};
    } else if (current.type === 'dispatch') {
      if (!current.parcelId) throw new AppError('Dispatch task needs a parcel.', 422, 'TASK_DATA_REQUIRED'); const parcel = await Parcel.findById(current.parcelId).session(session); if (!parcel) throw new AppError('Parcel not found.', 404, 'PARCEL_NOT_FOUND');if(parcel.status!=='packed')throw new AppError('Only a packed parcel can be dispatched.',409,'PARCEL_STATE');
      parcel.status='handed_over';parcel.timeline.push({type:'dispatch',message:'Parcel dispatched for carrier handoff.',actorUserId});await parcel.save({session});current.result={parcelStatus:parcel.status};
    } else if (current.type === 'cycle_count') {
      if(!current.stockItemId||!Number.isSafeInteger(current.quantity)||current.quantity<0)throw new AppError('Cycle count needs a stock item and counted on-hand quantity.',422,'TASK_DATA_REQUIRED');const stock=await StockItem.findById(current.stockItemId).session(session);if(!stock||!stock.warehouseId.equals(warehouse._id))throw new AppError('Stock item is not in this warehouse.',409,'STOCK_WAREHOUSE_MISMATCH');if(current.quantity<stock.reserved+stock.damaged+stock.quarantined)throw new AppError('Counted stock cannot be below reserved, damaged and quarantined stock.',422,'COUNT_INVALID');const before=stock.onHand;stock.onHand=current.quantity;await stock.save({session});await InventoryMovement.create([{publicId:publicId('mov'),storeId:stock.storeId,stockItemId:stock._id,variantId:stock.variantId,warehouseId:stock.warehouseId,type:'adjustment',quantity:stock.onHand-before,onHandBefore:before,onHandAfter:stock.onHand,reservedBefore:stock.reserved,reservedAfter:stock.reserved,damagedBefore:stock.damaged,damagedAfter:stock.damaged,quarantinedBefore:stock.quarantined,quarantinedAfter:stock.quarantined,reason:current.notes||'Warehouse cycle count',reference:current.publicId,actorUserId}],{session});current.result={countedOnHand:stock.onHand,variance:stock.onHand-before};
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
      const finalDisposition=current.disposition||disposition;if(!current.stockItemId||!Number.isSafeInteger(current.quantity)||current.quantity<=0||!['good','damaged','quarantine'].includes(finalDisposition))throw new AppError('Return inspection needs stock, quantity and a disposition.',422,'TASK_DATA_REQUIRED');const stock=await StockItem.findById(current.stockItemId).session(session);if(!stock||!stock.warehouseId.equals(warehouse._id))throw new AppError('Stock item is not in this warehouse.',409,'STOCK_WAREHOUSE_MISMATCH');const before={onHand:stock.onHand,damaged:stock.damaged,quarantined:stock.quarantined};stock.onHand+=current.quantity;if(finalDisposition==='damaged')stock.damaged+=current.quantity;if(finalDisposition==='quarantine')stock.quarantined+=current.quantity;await stock.save({session});await InventoryMovement.create([{publicId:publicId('mov'),storeId:stock.storeId,stockItemId:stock._id,variantId:stock.variantId,warehouseId:stock.warehouseId,type:'return',quantity:current.quantity,onHandBefore:before.onHand,onHandAfter:stock.onHand,reservedBefore:stock.reserved,reservedAfter:stock.reserved,damagedBefore:before.damaged,damagedAfter:stock.damaged,quarantinedBefore:before.quarantined,quarantinedAfter:stock.quarantined,reason:current.notes||`Returned stock inspected as ${finalDisposition}`,reference:current.reference,actorUserId}],{session});current.result={returnedQuantity:current.quantity,disposition:finalDisposition};
    } else throw new AppError('Warehouse task type is unsupported.',422,'TASK_TYPE_INVALID');

    current.status = 'completed'; current.completedAt = new Date(); current.assignedUserId = actorUserId; await current.save({ session }); return current;
  }); } finally { await session.endSession(); }
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
      intent.status = 'succeeded'; intent.paidAt = new Date(); await intent.save({ session });
      order.status = 'paid'; order.timeline.push({ type: 'payment.cod_reconciled', message: 'Cash on delivery collection verified and reconciled.' }); await order.save({ session });
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
  const shipments=await Shipment.find({country:cleanCountry,deliveryUserId,status:'delivered','cod.required':true,'cod.reconciledAt':null,'cod.currency':cleanCurrency,$expr:{$eq:[{$dateToString:{date:'$deliveredAt',format:'%Y-%m-%d',timezone:setting.timeZone}},businessDate]}}).sort({deliveredAt:1});
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

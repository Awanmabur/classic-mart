import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { EvidenceDocument, InventoryReservation, Order, ReturnRequest, Shipment, StockItem, Warehouse } from '../models/index.js';

const same = (left, right) => String(left || '') === String(right || '');
async function fenceSource(Model, row, session, conditions = {}) {
  const version = row.__v;
  const result = await Model.updateOne({ _id: row._id, __v: version === undefined ? mongoose.trusted({ $exists: false }) : version, ...conditions }, { $inc: { __v: 1 } }, { session });
  if (result.modifiedCount !== 1) throw new AppError('Shipment allocation changed. Reload before continuing.', 409, 'DELIVERY_SOURCE_CHANGED');
  row.__v = Number(version || 0) + 1;
}

/** Resolve custody from the committed order/return and its real stock allocation. */
export async function shipmentSource(shipment, { session = null, warehouseAccess = null, write = false } = {}) {
  const order = await Order.findOne({ _id: shipment.orderId, publicId: shipment.orderPublicId, country: shipment.country }).session(session);
  if (!order || order.totals.currency !== shipment.cod.currency) throw new AppError('Shipment source no longer matches its order.', 409, 'DELIVERY_SOURCE_INVALID');
  if (write && shipment.kind !== 'return' && ['ready','offered'].includes(shipment.status)) {
    const funded = ['paid','partially_refunded'].includes(order.paymentState) || order.status === 'confirmed' && (order.paymentMethod === 'cod' && order.paymentState === 'pending' || order.paymentMethod === 'credit_terms' && order.paymentState === 'credit_due');
    if (!funded || !['confirmed','paid','partially_refunded'].includes(order.status) || !['none','rejected'].includes(order.cancellationState) || ['pending','processing','complete'].includes(order.refundState)) throw new AppError('The original order is not ready for a delivery offer or assignment.',409,'ORDER_NOT_READY');
  }
  let returned = null, stock, reservations;
  if (shipment.kind === 'return') {
    returned = await ReturnRequest.findOne({ _id: shipment.returnRequestId, orderId: order._id, orderPublicId: order.publicId,
      userId: order.userId, country: order.country, returnShipmentPublicId: shipment.publicId, returnMethod: 'pickup',
      status: { $in: ['approved', 'awaiting_return', ...(write ? [] : ['received', 'inspected', 'refund_pending', 'refund_processing', 'refunded', 'exchange_pending', 'exchanged', 'closed'])] } }).session(session);
    if (!returned || !returned.items.length) throw new AppError('The source return is not awaiting collection.', 409, 'RETURN_PICKUP_UNAVAILABLE');
    if (new Set(returned.items.map(item => item.orderLineId)).size !== returned.items.length) throw new AppError('Return line allocation is ambiguous.', 409, 'RETURN_RECEIVING_UNAVAILABLE');
    const originalItems = returned.items.map(item => {
      const original = order.items.find(row => row.linePublicId === item.orderLineId && same(row.storeId, item.storeId) && same(row.variantId, item.variantId));
      if (!original || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > Number(original.deliveredQuantity || 0)
        || !original.reservationPublicId) throw new AppError('The return does not match its delivered order line.', 409, 'RETURN_RECEIVING_UNAVAILABLE');
      return original;
    });
    reservations = await InventoryReservation.find({ publicId: { $in: originalItems.map(item => item.reservationPublicId) }, status: 'committed' }).session(session).lean();
    if (reservations.length !== originalItems.length || originalItems.some(item => !reservations.some(row => row.publicId === item.reservationPublicId
      && same(row.storeId, item.storeId) && same(row.variantId, item.variantId) && row.quantity === item.quantity))) {
      throw new AppError('Return receiving must use the original committed stock allocation.', 409, 'RETURN_RECEIVING_UNAVAILABLE');
    }
    const stockIds = [...new Set(reservations.map(row => String(row.stockItemId)))];
    stock = await StockItem.find({ _id: { $in: stockIds } }).session(session).lean();
    if (stock.length !== stockIds.length || reservations.some(row => !stock.some(item => same(item._id, row.stockItemId)
      && same(item.storeId, row.storeId) && same(item.variantId, row.variantId)))) throw new AppError('Original return receiving stock is unavailable.', 409, 'RETURN_RECEIVING_UNAVAILABLE');
  } else {
    const ids = [...new Set(order.items.map(item => item.reservationPublicId).filter(Boolean))];
    reservations = await InventoryReservation.find({ publicId: { $in: ids }, status: 'committed' }).session(session).lean();
    if (!ids.length || reservations.length !== ids.length) throw new AppError('Shipment stock allocation is unavailable.', 409, 'DELIVERY_ALLOCATION_UNAVAILABLE');
    if (order.items.some(item => !reservations.some(row => row.publicId === item.reservationPublicId &&
      same(row.storeId, item.storeId) && same(row.variantId, item.variantId) && row.quantity === item.quantity))) {
      throw new AppError('Shipment line allocation does not match the committed order.', 409, 'DELIVERY_ALLOCATION_UNAVAILABLE');
    }
    const stockIds = [...new Set(reservations.map(row => String(row.stockItemId)))];
    stock = await StockItem.find({ _id: { $in: stockIds } }).session(session).lean();
    if (stock.length !== stockIds.length || reservations.some(row => !stock.some(item => same(item._id, row.stockItemId)
      && same(item.storeId, row.storeId) && same(item.variantId, row.variantId)))) throw new AppError('Shipment stock allocation is unavailable.', 409, 'DELIVERY_ALLOCATION_UNAVAILABLE');
  }
  const ids = [...new Set(stock.map(row => String(row.warehouseId)))];
  const warehouses = await Warehouse.find({ $and: [{ _id: { $in: ids }, active: true, country: shipment.country }, warehouseAccess?.scope || {}] }).session(session).lean();
  if (!ids.length || warehouses.length !== ids.length || stock.some(row => !warehouses.some(warehouse => same(warehouse._id, row.warehouseId) && same(warehouse.storeId, row.storeId)))) throw new AppError('This shipment is outside your current warehouse scope.', 403, 'WAREHOUSE_SCOPE');
  if (write) {
    if (!session?.inTransaction()) throw new AppError('Shipment allocation changes require a transaction.', 500, 'DELIVERY_TRANSACTION_REQUIRED');
    await fenceSource(Order, order, session, { publicId: shipment.orderPublicId, country: shipment.country, status: order.status, paymentState: order.paymentState });
    if (returned) await fenceSource(ReturnRequest, returned, session, { status: returned.status, returnShipmentPublicId: shipment.publicId });
    for (const row of reservations) await fenceSource(InventoryReservation, row, session, { status: 'committed', stockItemId: row.stockItemId, variantId: row.variantId, quantity: row.quantity });
    for (const row of stock) await fenceSource(StockItem, row, session, { warehouseId: row.warehouseId, storeId: row.storeId, variantId: row.variantId });
    for (const row of warehouses) {
      const result = await Warehouse.updateOne({ _id: row._id, __v: row.__v || 0, active: true, country: row.country, storeId: row.storeId }, { $inc: { __v: 1 } }, { session });
      if (result.modifiedCount !== 1) throw new AppError('The receiving warehouse changed. Reload before continuing.', 409, 'WAREHOUSE_SCOPE_CHANGED');
    }
  }
  return { order, returned, stock, warehouses, reservations };
}

export async function deliveryEvidenceFor(shipment, { actorUserId = shipment.deliveryUserId, session = null, types = [], after = null } = {}) {
  return EvidenceDocument.find({ ownerUserId: actorUserId, country: shipment.country, contextType: 'delivery_job',
    contextPublicId: shipment.publicId, status: 'ready', ...(types.length ? { documentType: { $in: types } } : {}),
    ...(after ? { createdAt: { $gt: after } } : {}) }).select('publicId documentType createdAt description').session(session).lean();
}

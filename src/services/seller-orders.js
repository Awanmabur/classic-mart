import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { ApiClient, ApiIdempotency, User, Store, StoreMember, SellerOrder, Order, Shipment, SellerShipment, Parcel,
  InventoryReservation, StockItem, Warehouse, WarehouseTask, CountrySetting, Notification } from '../models/index.js';
import { storeCapabilities } from './store.js';
import { createWarehouseTask, executeWarehouseTask, ensureShipmentForOrder } from './logistics.js';
import { refreshOrderLifecycle } from './order-state.js';
import { writeAudit } from './audit.js';
import { addOutboxEvent } from './outbox.js';
import { queueWebhookEvent } from './stage11.js';
import { cursorScope, cursorSort, pageResult } from './pagination.js';

const recordId = z.string().trim().regex(/^[a-z][a-z0-9_-]{4,99}$/, 'Choose a valid order.');
const versionInput = z.union([z.number(), z.string().trim().regex(/^\d+$/, 'Reload the order before continuing.')])
  .pipe(z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER));
const statuses = z.enum(['all', 'processing', 'shipped', 'delivered', 'pending_payment', 'cancelled']);
const actions = z.enum(['processing', 'pick', 'pack', 'dispatch']);
const same = (left, right) => String(left) === String(right);
const safeVersion = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const rootProjection = 'publicId country status paymentState paymentMethod deliveryMethod cancellationState fulfillmentState refundState contact totals.currency items';

/** The current database membership, rather than a cached role, authorizes every read/write. */
async function access(request, session = null, mutation = false, requiredScope = '') {
  const api = Boolean(request.apiClient && request.apiStore);
  const storeId = api ? request.apiStore._id : request.store?._id;
  const actorId = api ? request.apiClient.createdByUserId : request.user?._id;
  if (!storeId || !actorId) throw new AppError('Seller authentication is required.', 401, 'UNAUTHENTICATED');
  let client;
  if (api) {
    client = await ApiClient.findOne({ _id: request.apiClient._id, storeId, status: 'active' }).session(session);
    const scope = requiredScope || (mutation ? 'orders:fulfil' : 'orders:read');
    if (!client || !same(client.createdByUserId, actorId) || (client.expiresAt && client.expiresAt <= new Date()) || !client.scopes.includes(scope) ||
      Number(client.rotatedAt?.getTime() || 0) !== Number(new Date(request.apiClient.rotatedAt || 0).getTime())) {
      throw new AppError('This API client is unavailable for order operations.', 403, 'API_SCOPE_FORBIDDEN');
    }
  }
  const actorQuery = () => User.findById(actorId).select('publicId status security.tokenVersion').session(session);
  const storeQuery = () => Store.findById(storeId).session(session);
  const memberQuery = () => StoreMember.findOne({ storeId, userId: actorId, status: 'active' }).session(session);
  const [actor, store, member] = session ? [await actorQuery(), await storeQuery(), await memberQuery()] :
    await Promise.all([actorQuery(), storeQuery(), memberQuery()]);
  if (!actor || actor.status !== 'active' || (!api && (actor.security.tokenVersion !== request.user.security?.tokenVersion ||
    (request.session?.tokenVersion !== undefined && request.session.tokenVersion !== actor.security.tokenVersion)))) {
    throw new AppError('Your account or session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
  }
  const capabilities = storeCapabilities(member?.role);
  if (!member || (!capabilities.has('*') && !capabilities.has('fulfilment'))) {
    throw new AppError('Your store role cannot manage fulfilment.', 403, 'STORE_PERMISSION_DENIED');
  }
  if (!store || store.status !== 'verified') throw new AppError('This store is unavailable for fulfilment.', 409, 'STORE_LOCKED');
  if (mutation) {
    // Writing the authorization records makes concurrent suspension/revocation
    // conflict with this transaction instead of permitting a snapshot-only race.
    await User.updateOne({ _id: actor._id, status: 'active', 'security.tokenVersion': actor.security.tokenVersion }, { $inc: { __v: 1 } }, { session });
    await StoreMember.updateOne({ _id: member._id, status: 'active', role: member.role }, { $inc: { __v: 1 } }, { session });
    await Store.updateOne({ _id: store._id, status: 'verified', country: store.country, currency: store.currency }, { $inc: { __v: 1 } }, { session });
    if (client) await ApiClient.updateOne({ _id: client._id, status: 'active' }, { $set: { lastUsedAt: new Date() } }, { session });
  }
  return { actor, store, api };
}

export async function assertSellerOrderAccess(request, { mutation = false } = {}) {
  // This preflight also applies to cached external idempotency responses.
  // Atomic mutations perform the same checks again using their own session.
  const result = await access(request, null, false, mutation ? 'orders:fulfil' : 'orders:read');
  if (mutation && result.api && !request.apiClient.scopes.includes('orders:fulfil')) {
    throw new AppError('API key does not include the required scope.', 403, 'API_SCOPE_FORBIDDEN');
  }
  if (request.params?.publicId || request.params?.id) {
    const id = recordId.parse(request.params.publicId || request.params.id);
    if (!await SellerOrder.exists({ publicId: id, storeId: result.store._id, country: result.store.country, currency: result.store.currency })) {
      throw new AppError('Seller order not found.', 404, 'SELLER_ORDER_NOT_FOUND');
    }
  }
  return { store: result.store, actor: result.actor };
}

function readyRoot(root, store) {
  if (!root || root.country !== store.country || root.totals?.currency !== store.currency) return 'Order country or currency does not match this store.';
  if (!['none', 'rejected'].includes(root.cancellationState || 'none') || root.fulfillmentState === 'cancelled' ||
    ['pending', 'processing', 'complete'].includes(root.refundState)) return 'This order is cancelled or has an active refund process.';
  if (!['confirmed', 'paid'].includes(root.status)) return 'Payment confirmation is required before fulfilment.';
  if (root.paymentState === 'paid') return '';
  if (root.paymentMethod === 'cod' && root.paymentState === 'pending' && root.status === 'confirmed') return '';
  if (root.paymentMethod === 'credit_terms' && root.paymentState === 'credit_due' && root.status === 'confirmed') return '';
  if (root.paymentMethod === 'exchange' && root.status === 'confirmed') return '';
  return 'Payment confirmation is required before fulfilment.';
}

function statusLabel(order, sellerShipment, parcel) {
  if (['cancelled', 'expired'].includes(order.status)) return order.status === 'expired' ? 'Expired' : 'Cancelled';
  if (order.status === 'cancellation_pending') return 'Cancellation pending';
  const progress = sellerShipment?.status || parcel?.status;
  if (progress === 'delivered') return 'Delivered';
  if (progress === 'returned') return 'Returned to seller';
  if (progress === 'in_transit' || order.status === 'fulfilled') return 'Shipped';
  if (progress === 'handed_over' || order.status === 'ready') return 'Ready for carrier pickup';
  if (progress === 'packed') return 'Packed';
  if (progress === 'picked') return 'Picked';
  if (progress === 'picking') return 'Picking';
  if (order.status === 'pending_payment') return 'Awaiting payment';
  if (order.status === 'confirmed') return 'Confirmed';
  if (order.status === 'processing') return 'Processing';
  return String(order.status).replaceAll('_', ' ').replace(/^./, value => value.toUpperCase());
}

function actionPlan(order, root, store, parcel) {
  let blockedReason = readyRoot(root, store);
  if (!blockedReason && !['confirmed', 'processing'].includes(order.status)) blockedReason = 'This seller order has completed preparation or is no longer fulfilable.';
  const permitted = !blockedReason;
  return { blockedReason, actions: {
    processing: permitted && order.status === 'confirmed',
    pick: permitted && ['created', 'picking', undefined].includes(parcel?.status),
    pack: permitted && parcel?.status === 'picked',
    dispatch: permitted && parcel?.status === 'packed',
  } };
}

function view(order, root, store, shipment, sellerShipment, parcel, detail = false) {
  const items = (order.items || []).map(item => ({ orderLineId: item.orderLineId, title: item.title, variantTitle: item.variantTitle,
    sku: item.sku, quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, lineTotalMinor: item.lineTotalMinor, currency: item.currency }));
  const totals = { subtotalMinor: order.subtotalMinor, discountMinor: order.discountMinor || 0, shippingMinor: order.shippingMinor || 0,
    taxMinor: order.taxMinor || 0, totalMinor: Math.max(0, order.subtotalMinor - (order.discountMinor || 0)) + (order.shippingMinor || 0) + (order.taxMinor || 0) };
  const label = statusLabel(order, sellerShipment, parcel);
  const result = { id: order.publicId, publicId: order.publicId, orderId: order.orderPublicId, orderPublicId: order.orderPublicId,
    version: safeVersion(order.__v), __v: safeVersion(order.__v), status: order.status, statusLabel: label, displayStatus: label,
    customerName: root?.contact?.fullName || 'Customer', currency: order.currency, createdAt: order.createdAt, updatedAt: order.updatedAt,
    paymentState: root?.paymentState || 'unpaid', paymentMethod: root?.paymentMethod || '', deliveryMethod: root?.deliveryMethod || '',
    fulfilmentState: sellerShipment?.status || parcel?.status || (order.status === 'processing' ? 'processing' : 'unfulfilled'),
    totals, subtotalMinor: totals.subtotalMinor, discountMinor: totals.discountMinor, shippingMinor: totals.shippingMinor, taxMinor: totals.taxMinor,
    items, shipment: shipment ? { publicId: shipment.publicId, status: shipment.status, mode: shipment.mode, parcelCount: shipment.parcelCount } : null,
    sellerShipment: sellerShipment ? { id: sellerShipment.publicId, publicId: sellerShipment.publicId, status: sellerShipment.status,
      parcelPublicId: sellerShipment.parcelPublicId, quantity: sellerShipment.quantity, handedOverAt: sellerShipment.handedOverAt || null,
      deliveredAt: sellerShipment.deliveredAt || null } : null,
    parcel: parcel ? { id: parcel.publicId, publicId: parcel.publicId, status: parcel.status, pickedQuantity: parcel.pickedQuantity,
      quantity: parcel.items.reduce((sum, item) => sum + item.quantity, 0), version: safeVersion(parcel.__v) } : null,
    ...actionPlan(order, root, store, parcel) };
  if (detail) {
    const contact = root?.contact || {};
    result.contact = { fullName: contact.fullName || '', phone: contact.phone || '', address: contact.address || '',
      city: contact.city || '', country: contact.country || '', note: contact.note || '' };
    result.timeline = [...(order.timeline || []), ...(sellerShipment?.timeline || []), ...(parcel?.timeline || [])]
      .map(event => ({ type: event.type, message: event.message, at: event.at }))
      .sort((left, right) => new Date(left.at) - new Date(right.at)).slice(-100);
  }
  return result;
}

async function contexts(orders, store, session = null, detail = false) {
  if (!orders.length) return [];
  const orderIds = orders.map(row => row.orderId), sellerIds = orders.map(row => row._id);
  const rootQuery = () => Order.find({ _id: { $in: orderIds }, country: store.country }).select(rootProjection).session(session).lean();
  const shipmentQuery = () => Shipment.find({ orderId: { $in: orderIds }, country: store.country, kind: 'outbound' })
    .select('publicId orderId status mode parcelCount').session(session).lean();
  const sellerQuery = () => SellerShipment.find({ sellerOrderId: { $in: sellerIds }, storeId: store._id, country: store.country })
    .select('publicId sellerOrderId parcelId parcelPublicId status quantity handedOverAt deliveredAt timeline').session(session).lean();
  const [roots, shipments, sellerShipments] = session ? [await rootQuery(), await shipmentQuery(), await sellerQuery()] :
    await Promise.all([rootQuery(), shipmentQuery(), sellerQuery()]);
  const parcels = shipments.length ? await Parcel.find({ shipmentId: { $in: shipments.map(row => row._id) }, storePublicId: store.publicId })
    .select('publicId orderPublicId status items pickedQuantity __v timeline').session(session).lean() : [];
  const rootMap = new Map(roots.map(row => [String(row._id), row])), shipmentMap = new Map(shipments.map(row => [String(row.orderId), row]));
  const sellerMap = new Map(sellerShipments.map(row => [String(row.sellerOrderId), row])), parcelMap = new Map(parcels.map(row => [row.orderPublicId, row]));
  return orders.map(row => view(row, rootMap.get(String(row.orderId)), store, shipmentMap.get(String(row.orderId)),
    sellerMap.get(String(row._id)), parcelMap.get(row.orderPublicId), detail));
}

function bucketPipeline(store) {
  return [
    { $match: { storeId: store._id, country: store.country, currency: store.currency } },
    { $lookup: { from: SellerShipment.collection.name, localField: '_id', foreignField: 'sellerOrderId',
      pipeline: [{ $match: { storeId: store._id, country: store.country } }, { $project: { status: 1 } }], as: '_sellerShipment' } },
    { $set: { _progress: { $arrayElemAt: ['$_sellerShipment.status', 0] } } },
    { $set: { _bucket: { $switch: { branches: [
      { case: { $in: ['$status', ['cancelled', 'cancellation_pending', 'expired']] }, then: 'cancelled' },
      { case: { $eq: ['$_progress', 'delivered'] }, then: 'delivered' },
      { case: { $or: [{ $eq: ['$_progress', 'in_transit'] }, { $eq: ['$status', 'fulfilled'] }] }, then: 'shipped' },
      { case: { $eq: ['$status', 'pending_payment'] }, then: 'pending_payment' },
      { case: { $in: ['$status', ['confirmed', 'processing', 'ready']] }, then: 'processing' },
    ], default: 'other' } } } },
  ];
}

export async function sellerOrderList(request, { after = '', status = 'all', q = '', shipping = false, limit = 25 } = {}) {
  const { store } = await access(request);
  const chosen = statuses.parse(status || 'all'), search = z.string().trim().max(100).parse(q || '');
  const size = z.coerce.number().int().min(1).max(100).parse(limit);
  const filter = { ...(chosen === 'all' ? {} : { _bucket: chosen }),
    ...(shipping ? { status: { $nin: ['pending_payment', 'expired'] } } : {}),
    ...(search ? { $or: ['publicId', 'orderPublicId', 'items.title', 'items.sku'].map(field => ({ [field]:
      { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } })) } : {}) };
  const country = await CountrySetting.findOne({ code: store.country, active: true }).select('timeZone').lean();
  const timeZone = country?.timeZone || (store.country === 'UG' ? 'Africa/Kampala' : 'UTC');
  const common = bucketPipeline(store), summaryFacet = [{ $group: { _id: '$_bucket', count: { $sum: 1 },
    today: { $sum: { $cond: [{ $gte: ['$createdAt', { $dateTrunc: { date: '$$NOW', unit: 'day', timezone: timeZone } }] }, 1, 0] } } } }];
  let rows, summary, total;
  if (chosen === 'all') {
    // Default navigation uses the compound cursor index before fetching at most
    // one page of context. The complete-store join runs once for metrics only.
    const base = { storeId: store._id, country: store.country, currency: store.currency, ...filter };
    [rows, total, summary] = await Promise.all([
      SellerOrder.find(mongoose.trusted(cursorScope(base, after))).sort(cursorSort()).limit(size + 1).lean(),
      SellerOrder.countDocuments(mongoose.trusted(base)),
      SellerOrder.aggregate([...common, ...summaryFacet]),
    ]);
  } else {
    const [facet] = await SellerOrder.aggregate([...common, { $facet: {
      rows: [{ $match: cursorScope(filter, after) }, { $sort: cursorSort() }, { $limit: size + 1 },
        { $project: { _sellerShipment: 0, _progress: 0, _bucket: 0 } }],
      total: [{ $match: filter }, { $count: 'value' }], summary: summaryFacet,
    } }]);
    rows = facet.rows; summary = facet.summary; total = facet.total[0]?.value || 0;
  }
  const page = pageResult(rows, { limit: size, total });
  const metrics = { today: summary.reduce((sum, row) => sum + row.today, 0), processing: 0, shipped: 0, delivered: 0, pendingPayment: 0, cancelled: 0 };
  for (const row of summary) { const field = row._id === 'pending_payment' ? 'pendingPayment' : row._id; if (field in metrics) metrics[field] = row.count; }
  return { orders: await contexts(page.items, store), page: page.page, metrics,
    filters: { status: chosen, search, shipping: Boolean(shipping) }, mode: shipping ? 'shipping' : 'list' };
}

async function reservationGroups(order, root, store, session = null) {
  const ownLines = root.items.filter(item => same(item.storeId, store._id));
  if (!ownLines.length || ownLines.length !== order.items.length) throw new AppError('Seller order lines do not match the marketplace order.', 409, 'SELLER_ORDER_LINES_INVALID');
  const reservations = await InventoryReservation.find({ publicId: { $in: ownLines.map(item => item.reservationPublicId) }, storeId: store._id }).session(session).lean();
  const stocks = await StockItem.find({ _id: { $in: reservations.map(row => row.stockItemId) }, storeId: store._id }).session(session).lean();
  const stockMap = new Map(stocks.map(row => [String(row._id), row])), reservationMap = new Map(reservations.map(row => [row.publicId, row]));
  const grouped = new Map();
  for (const line of ownLines) {
    const sellerLine = order.items.find(item => item.orderLineId ? item.orderLineId === line.linePublicId : item.variantPublicId === line.variantPublicId);
    const reservation = reservationMap.get(line.reservationPublicId), stock = stockMap.get(String(reservation?.stockItemId));
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || !sellerLine || sellerLine.quantity !== line.quantity || sellerLine.variantPublicId !== line.variantPublicId ||
      !reservation || reservation.status !== 'committed' || reservation.quantity !== line.quantity || !stock ||
      !same(reservation.variantId, line.variantId) || !same(stock.variantId, line.variantId)) {
      throw new AppError('Every seller line requires its committed stock reservation.', 409, 'RESERVATION_NOT_COMMITTED');
    }
    const group = grouped.get(String(stock.warehouseId)) || { warehouseId: stock.warehouseId, quantity: 0 };
    group.quantity += line.quantity; grouped.set(String(stock.warehouseId), group);
  }
  const warehouses = await Warehouse.find({ _id: { $in: [...grouped.values()].map(group => group.warehouseId) }, storeId: store._id,
    country: store.country, active: true }).session(session).lean();
  if (warehouses.length !== grouped.size) throw new AppError('A reservation warehouse is inactive or outside this store country.', 409, 'WAREHOUSE_NOT_FOUND');
  return warehouses.map(warehouse => ({ warehouse, quantity: grouped.get(String(warehouse._id)).quantity }));
}

export async function sellerOrderDetail(request) {
  const { store } = await access(request), id = recordId.parse(request.params?.publicId || request.params?.id);
  const order = await SellerOrder.findOne({ publicId: id, storeId: store._id, country: store.country, currency: store.currency }).lean();
  if (!order) throw new AppError('Seller order not found.', 404, 'SELLER_ORDER_NOT_FOUND');
  const [dto] = await contexts([order], store, null, true);
  let groups = [], preparationError = '';
  if (!dto.blockedReason) {
    const root = await Order.findById(order.orderId).select(rootProjection).lean();
    try { groups = await reservationGroups(order, root, store); }
    catch (error) { preparationError = error.message; dto.blockedReason = preparationError; dto.actions = { processing: false, pick: false, pack: false, dispatch: false }; }
  }
  if (dto.parcel && ['packed', 'handed_over', 'in_transit', 'delivered'].includes(dto.parcel.status)) {
    const packed = await WarehouseTask.findOne({ storeId: store._id, orderId: order.orderId, type: 'pack', status: 'completed' })
      .sort({ completedAt: -1 }).select('warehouseId').lean();
    const warehouse = packed ? await Warehouse.findOne({ _id: packed.warehouseId, storeId: store._id, country: store.country })
      .select('publicId name').lean() : null;
    dto.packWarehousePublicId = warehouse?.publicId || '';
    dto.packWarehouseName = warehouse?.name || '';
    if (dto.actions.dispatch) {
      groups = packed ? groups.filter(group => same(group.warehouse._id, packed.warehouseId)) : [];
      if (!groups.length) { dto.actions.dispatch = false; dto.blockedReason = 'The recorded packing warehouse requires reconciliation.'; }
    }
  }
  return { mode: 'detail', order: dto, actions: dto.actions, blockedReason: dto.blockedReason,
    warehouses: groups.map(({ warehouse, quantity }) => ({ publicId: warehouse.publicId, name: warehouse.name, city: warehouse.city, quantity })), preparationError };
}

export async function transitionSellerOrder(request, rawAction) {
  const action = actions.parse(rawAction), id = recordId.parse(request.params?.publicId || request.params?.id);
  const expected = versionInput.parse(request.body?.version);
  const chosenWarehouse = request.body?.warehousePublicId ? recordId.parse(request.body.warehousePublicId) : '';
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const { actor, store, api } = await access(request, session, true);
      const order = await SellerOrder.findOne({ publicId: id, storeId: store._id, country: store.country, currency: store.currency }).session(session);
      if (!order) throw new AppError('Seller order not found.', 404, 'SELLER_ORDER_NOT_FOUND');
      if (safeVersion(order.__v) !== expected) throw new AppError('The order changed. Reload it before continuing.', 409, 'SELLER_ORDER_VERSION_CONFLICT');
      const root = await Order.findById(order.orderId).session(session);
      if (!root || root.country !== store.country || root.totals.currency !== store.currency || !same(root.publicId, order.orderPublicId)) {
        throw new AppError('Order country or currency does not match this store.', 409, 'ORDER_COUNTRY_INVALID');
      }
      const blocked = readyRoot(root, store);
      if (blocked) throw new AppError(blocked, 409, 'ORDER_NOT_READY');
      if (!['confirmed', 'processing'].includes(order.status) || (action === 'processing' && order.status !== 'confirmed')) {
        throw new AppError('This fulfilment action is not available in the current state.', 409, 'SELLER_ORDER_STATE');
      }
      const groups = await reservationGroups(order, root, store, session);
      for (const group of groups) await Warehouse.updateOne({ _id: group.warehouse._id, storeId: store._id,
        country: store.country, active: true }, { $inc: { __v: 1 } }, { session });
      const fenced = await Order.updateOne({ _id: root._id, __v: safeVersion(root.__v), status: root.status,
        paymentState: root.paymentState, cancellationState: root.cancellationState }, { $inc: { __v: 1 } }, { session });
      if (fenced.modifiedCount !== 1) throw new AppError('The marketplace order changed. Reload it before continuing.', 409, 'SELLER_ORDER_VERSION_CONFLICT');
      const claimed = await SellerOrder.updateOne({ _id: order._id, __v: expected, status: order.status }, { $inc: { __v: 1 } }, { session });
      if (claimed.modifiedCount !== 1) throw new AppError('The order changed. Reload it before continuing.', 409, 'SELLER_ORDER_VERSION_CONFLICT');
      // Repair legacy missing shipment links only after authoritative payment and
      // inventory checks, and inside the same transaction as the seller action.
      const shipment = await ensureShipmentForOrder(root, actor._id, session);
      if (!shipment || shipment.country !== store.country || ['cancelled', 'delivered', 'returned', 'picked_up', 'in_transit', 'return_to_sender'].includes(shipment.status)) {
        throw new AppError('The shipment is no longer awaiting seller preparation.', 409, 'SELLER_ORDER_STATE');
      }
      const parcel = await Parcel.findOne({ shipmentId: shipment._id, orderPublicId: root.publicId, storePublicId: store.publicId }).session(session);
      const sellerShipment = parcel ? await SellerShipment.findOne({ sellerOrderId: order._id, storeId: store._id, country: store.country,
        rootShipmentId: shipment._id, parcelId: parcel._id }).session(session) : null;
      if (!parcel || !sellerShipment) throw new AppError('The seller shipment could not be reconciled.', 409, 'SELLER_SHIPMENT_REQUIRED');
      const quantities = items => {
        const grouped = new Map();
        for (const item of items) {
          const key = `${item.productPublicId}:${item.variantPublicId}`;
          if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) return null;
          grouped.set(key, (grouped.get(key) || 0) + item.quantity);
        }
        return grouped;
      };
      const expectedLines = quantities(order.items), parcelLines = quantities(parcel.items);
      if (!expectedLines || !parcelLines || expectedLines.size !== parcelLines.size ||
        [...expectedLines].some(([key, quantity]) => parcelLines.get(key) !== quantity)) {
        throw new AppError('Parcel contents require reconciliation with the seller order.', 409, 'SELLER_ORDER_LINES_INVALID');
      }
      const plan = actionPlan(order, root, store, parcel);
      if (!plan.actions[action]) throw new AppError('Complete each preparation step in order.', 409, 'SELLER_ORDER_STATE');
      const tasks = [];
      if (action !== 'processing') {
        let selected = groups;
        if (action === 'dispatch') {
          const packed = await WarehouseTask.findOne({ parcelId: parcel._id, shipmentId: shipment._id, orderId: root._id,
            storeId: store._id, type: 'pack', status: 'completed' }).sort({ completedAt: -1 }).session(session);
          selected = packed ? groups.filter(group => same(group.warehouse._id, packed.warehouseId)) : [];
          if (!selected.length) throw new AppError('The recorded packing warehouse requires reconciliation.', 409, 'PACK_WAREHOUSE_UNAVAILABLE');
          if (chosenWarehouse && selected[0].warehouse.publicId !== chosenWarehouse) {
            throw new AppError('Dispatch must use the warehouse where this parcel was packed.', 422, 'CONSOLIDATION_WAREHOUSE_INVALID');
          }
        } else if (action === 'pack') {
          if (groups.length > 1 && !chosenWarehouse) throw new AppError('Select the actual consolidation warehouse for this parcel.', 422, 'CONSOLIDATION_WAREHOUSE_REQUIRED');
          selected = [chosenWarehouse ? groups.find(group => group.warehouse.publicId === chosenWarehouse) : groups[0]];
          if (!selected[0]) throw new AppError('Choose a warehouse holding this order reservation.', 422, 'CONSOLIDATION_WAREHOUSE_INVALID');
        } else if (chosenWarehouse && !groups.some(group => group.warehouse.publicId === chosenWarehouse)) {
          throw new AppError('Choose a warehouse holding this order reservation.', 422, 'CONSOLIDATION_WAREHOUSE_INVALID');
        }
        if (action === 'pick' && parcel.pickedQuantity > 0) {
          const completed = await WarehouseTask.find({ parcelId: parcel._id, orderId: root._id, storeId: store._id,
            type: 'pick', status: 'completed' }).select('warehouseId result.pickedQuantity').session(session).lean();
          const alreadyPicked = new Map();
          for (const task of completed) alreadyPicked.set(String(task.warehouseId), (alreadyPicked.get(String(task.warehouseId)) || 0) + Number(task.result?.pickedQuantity || 0));
          if (completed.reduce((sum, task) => sum + Number(task.result?.pickedQuantity || 0), 0) !== parcel.pickedQuantity) {
            throw new AppError('Partially picked parcel quantities require reconciliation.', 409, 'PICK_QUANTITY_RECONCILIATION_REQUIRED');
          }
          selected = groups.map(group => ({ ...group, quantity: group.quantity - (alreadyPicked.get(String(group.warehouse._id)) || 0) }));
          if (selected.some(group => group.quantity < 0)) throw new AppError('Picked warehouse quantities exceed the reservation.', 409, 'PICK_QUANTITY_RECONCILIATION_REQUIRED');
          selected = selected.filter(group => group.quantity > 0);
        }
        for (const group of selected) {
          const task = await createWarehouseTask({ warehouseId: group.warehouse._id, storeId: store._id, orderId: root._id,
            shipmentId: shipment._id, parcelId: parcel._id, type: action, quantity: action === 'pick' ? group.quantity : 0,
            reference: order.publicId, assignedUserId: actor._id,
            sourceKey: `seller-order:${order.publicId}:${expected + 1}:${action}:${group.warehouse.publicId}`,
            notes: `Seller fulfilment ${action}` }, session);
          await executeWarehouseTask({ task, actorUserId: actor._id, session }); tasks.push(task.publicId);
        }
      }
      const freshParcel = await Parcel.findById(parcel._id).session(session).lean();
      const nextStatus = action === 'dispatch' ? 'ready' : 'processing';
      const message = action === 'dispatch' ? 'Seller parcel handed over and ready for carrier pickup.' :
        action === 'processing' ? 'Seller started order preparation.' : `Seller completed parcel ${action}.`;
      await SellerOrder.updateOne({ _id: order._id, __v: expected + 1 }, { $set: { status: nextStatus },
        $push: { timeline: { type: `fulfilment.${action}`, message, at: new Date() } } }, { session });
      await refreshOrderLifecycle(root._id, { session });
      await writeAudit(request, api ? `external.order_${action}` : `seller.order_${action}`, { session,
        actor: api ? { _id: actor._id, publicId: `api:${request.apiClient.publicId}` } : actor,
        targetType: 'seller_order', targetPublicId: order.publicId, country: store.country,
        metadata: { versionBefore: expected, versionAfter: expected + 1, parcelPublicId: parcel.publicId,
          sellerShipmentPublicId: sellerShipment.publicId, parcelStatus: freshParcel.status, warehouseTaskPublicIds: tasks } });
      if (action === 'dispatch' && root.userId) {
        const buyer = await User.findOne({ _id: root.userId, status: 'active' }).select('email emailVerifiedAt').session(session);
        if (buyer) {
          await Notification.create([{ publicId: publicId('ntf'), userId: buyer._id, country: store.country,
            type: 'order.fulfilment', title: 'Your order is ready for carrier pickup',
            body: 'A seller has completed preparation. Track your order for carrier pickup and delivery updates.',
            href: `/track-order?order=${encodeURIComponent(root.publicId)}`, importance: 'normal' }], { session });
          if (buyer.emailVerifiedAt) await addOutboxEvent({ type: 'seller.order_notification', aggregateType: 'seller_order',
            aggregatePublicId: order.publicId, payload: { email: buyer.email, subject: 'Your Classic Mart order is ready for carrier pickup',
              body: `A seller has completed preparation for order ${root.publicId}. Sign in to Classic Mart to view tracking. Carrier pickup and delivery have not yet been confirmed.` } }, session);
        }
      }
      await queueWebhookEvent({ storeId: store._id, eventType: 'order.updated', resourcePublicId: order.publicId,
        payload: { status: nextStatus, version: expected + 1, parcelStatus: freshParcel.status },
        session, eventId: `seller-order:${order.publicId}:${expected + 1}` });
      const saved = await SellerOrder.findById(order._id).session(session).lean();
      [result] = await contexts([saved], store, session, true);
      if (api && request.externalIdempotency?.recordId) {
        const completed = await ApiIdempotency.updateOne({ _id: request.externalIdempotency.recordId,
          apiClientId: request.apiClient._id, status: 'in_progress' }, { $set: { status: 'completed', statusCode: 200,
          responseBody: { apiVersion: 'v1', order: result }, lockedUntil: null, expiresAt: request.externalIdempotency.expiresAt } }, { session });
        if (completed.modifiedCount !== 1) throw new AppError('The integration request is no longer owned by this operation.', 409, 'IDEMPOTENCY_IN_PROGRESS');
      }
    });
    return result;
  } catch (error) {
    if (error.name === 'VersionError' || error.code === 11000) throw new AppError('The order changed. Reload it before continuing.', 409, 'SELLER_ORDER_VERSION_CONFLICT');
    throw error;
  } finally { await session.endSession(); }
}

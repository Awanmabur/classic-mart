import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { CountrySetting, User, Store, StoreMember, SellerOrder, Order, PaymentIntent, Refund,
  Product, Review, StockItem, Warehouse, SellerVerification } from '../models/index.js';
import { storeCapabilities } from './store.js';

const periodInput = z.enum(['7months', '30days', 'year']).default('7months');
const integer = value => {
  if (!Number.isSafeInteger(value)) throw new AppError('Store overview totals are invalid.', 500, 'SELLER_OVERVIEW_INVALID');
  return value;
};
const calendar = (year, month, day) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
};
function partsAt(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}
function midnight(value, timeZone) {
  const target = Date.UTC(value.year, value.month - 1, value.day);
  let instant = target;
  for (let pass = 0; pass < 4; pass += 1) {
    const local = partsAt(new Date(instant), timeZone);
    const delta = target - Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    if (!delta) return new Date(instant);
    instant += delta;
  }
  // A midnight skipped by a time-zone transition is not a safe reporting boundary.
  throw new AppError('The store reporting calendar needs configuration.', 503, 'SELLER_CALENDAR_UNAVAILABLE');
}
const dateKey = (value, monthly) => `${value.year}-${String(value.month).padStart(2, '0')}${monthly ? '' : '-' + String(value.day).padStart(2, '0')}`;

/** All report boundaries use the configured store calendar, including DST. */
export function sellerOverviewWindow(period = '7months', timeZone = 'UTC', now = new Date()) {
  period = periodInput.parse(period);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new AppError('Reporting date is unavailable.', 503, 'SELLER_CALENDAR_UNAVAILABLE');
  let today;
  try { today = partsAt(now, timeZone); } catch { throw new AppError('The store time zone needs configuration.', 503, 'SELLER_CALENDAR_UNAVAILABLE'); }
  const monthly = period !== '30days';
  const startCalendar = period === 'year' ? calendar(today.year, 1, 1)
    : monthly ? calendar(today.year, today.month - 6, 1) : calendar(today.year, today.month, today.day - 29);
  const start = midnight(startCalendar, timeZone), buckets = [];
  if (monthly) {
    for (let cursor = startCalendar; cursor.year < today.year || cursor.month <= today.month; cursor = calendar(cursor.year, cursor.month + 1, 1)) {
      const boundary = midnight(cursor, timeZone);
      buckets.push({ key: dateKey(cursor, true), keys: [dateKey(cursor, true)], start: boundary,
        label: new Intl.DateTimeFormat('en', { timeZone, month: 'short' }).format(boundary) });
      if (cursor.year === today.year && cursor.month === today.month) break;
    }
  } else {
    // Six five-day bars keep the approved chart legible on narrow screens.
    for (let offset = 0; offset < 30; offset += 5) {
      const cursor = calendar(startCalendar.year, startCalendar.month, startCalendar.day + offset);
      const boundary = midnight(cursor, timeZone);
      buckets.push({ key: dateKey(cursor, false), start: boundary,
        keys: Array.from({ length: 5 }, (_, index) => dateKey(calendar(cursor.year, cursor.month, cursor.day + index), false)),
        label: new Intl.DateTimeFormat('en', { timeZone, month: 'short', day: 'numeric' }).format(boundary) });
    }
  }
  return { period, timeZone, start, end: now, monthly, buckets };
}

/** Re-check database identity and membership; never trust a supplied store or cached member. */
async function overviewAccess(request) {
  if (!request.user?._id || !request.store?._id) throw new AppError('Seller authentication is required.', 401, 'UNAUTHENTICATED');
  const [actor, store, member] = await Promise.all([
    User.findById(request.user._id).select('status security.tokenVersion').lean(),
    Store.findById(request.store._id).lean(),
    StoreMember.findOne({ storeId: request.store._id, userId: request.user._id, status: 'active' }).lean(),
  ]);
  if (!actor || actor.status !== 'active' || actor.security.tokenVersion !== request.user.security?.tokenVersion
    || (request.session?.tokenVersion !== undefined && request.session.tokenVersion !== actor.security.tokenVersion)) {
    throw new AppError('Your account or session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
  }
  const capabilities = storeCapabilities(member?.role);
  if (!member || (!capabilities.has('*') && !capabilities.has('staff'))) throw new AppError('Your store role cannot view this overview.', 403, 'STORE_PERMISSION_DENIED');
  if (!store || !['pending_verification', 'verified'].includes(store.status)) throw new AppError('This store is unavailable.', 409, 'STORE_LOCKED');
  const country = await CountrySetting.findOne({ code: store.country, active: true }).select('currency timeZone').lean();
  if (!country || country.currency !== store.currency) throw new AppError('The store country and currency need configuration.', 409, 'SELLER_COUNTRY_UNAVAILABLE');
  return { store, member, country };
}

export async function loadSellerOverview(request, { period = '7months', now = new Date() } = {}) {
  period = periodInput.parse(period);
  const { store, country } = await overviewAccess(request);
  const window = sellerOverviewWindow(period, country.timeZone, now);
  const scope = { storeId: store._id, storePublicId: store.publicId, country: store.country, currency: store.currency };
  const rootJoin = [
    { $lookup: { from: Order.collection.name, localField: 'orderId', foreignField: '_id', as: 'root',
      pipeline: [{ $project: { publicId: 1, country: 1, 'totals.currency': 1, 'totals.totalMinor': 1, 'items.storeId': 1, 'items.storePublicId': 1 } }] } },
    { $unwind: '$root' },
    { $match: { 'root.country': store.country, 'root.totals.currency': store.currency,
      'root.items': { $elemMatch: { storeId: store._id, storePublicId: store.publicId } }, $expr: { $eq: ['$orderPublicId', '$root.publicId'] } } },
  ];
  const dateGroup = date => ({ $dateToString: { date, format: window.monthly ? '%Y-%m' : '%Y-%m-%d', timezone: window.timeZone } });
  const paidSalesPipeline = [
    { $match: scope }, ...rootJoin,
    { $lookup: { from: PaymentIntent.collection.name, localField: 'orderId', foreignField: 'orderId', as: 'payment',
      let: { orderPublicId: '$orderPublicId' }, pipeline: [
      { $match: { country: store.country, currency: store.currency, status: { $in: ['succeeded', 'partially_refunded', 'refunded'] }, paidAt: { $type: 'date' },
        $expr: { $eq: ['$orderPublicId', '$$orderPublicId'] } } },
      { $sort: { paidAt: 1, _id: 1 } }, { $limit: 1 }, { $project: { paidAt: 1 } },
    ] } },
    { $unwind: '$payment' }, { $match: { 'payment.paidAt': { $gte: window.start, $lt: window.end } } },
    { $group: { _id: dateGroup('$payment.paidAt'), paidMinor: { $sum: { $max: [0, { $subtract: ['$subtotalMinor', { $ifNull: ['$discountMinor', 0] }] }] } } } },
  ];
  const refundPipeline = [
    // Start with the indexed store scope instead of scanning marketplace refunds.
    { $match: scope }, ...rootJoin,
    { $lookup: { from: Refund.collection.name, localField: 'orderId', foreignField: 'orderId', as: 'refund', pipeline: [
      { $match: { currency: store.currency, status: 'completed', completedAt: { $gte: window.start, $lt: window.end },
        $or: [{ 'allocations.storePublicId': store.publicId }, { allocations: { $size: 0 } }] } },
    ] } },
    { $unwind: '$refund' },
    { $lookup: { from: PaymentIntent.collection.name, localField: 'refund.paymentIntentId', foreignField: '_id', as: 'refundPayment',
      let: { orderId: '$orderId', orderPublicId: '$orderPublicId' }, pipeline: [
        { $match: { country: store.country, currency: store.currency, status: { $in: ['succeeded', 'partially_refunded', 'refunded'] },
          paidAt: { $type: 'date' }, $expr: { $and: [{ $eq: ['$orderId', '$$orderId'] }, { $eq: ['$orderPublicId', '$$orderPublicId'] }] } } },
        { $project: { _id: 1 } },
      ] } },
    { $unwind: '$refundPayment' }, { $match: { $expr: { $or: [
      { $gt: [{ $size: '$refund.allocations' }, 0] }, { $eq: ['$refund.amountMinor', '$root.totals.totalMinor'] },
    ] } } },
    // Production full refunds can have no line allocations. Only a full marketplace
    // refund reverses that store's entire paid item subtotal; never include delivery/tax.
    { $set: { itemRefundMinor: { $cond: [{ $eq: [{ $size: '$refund.allocations' }, 0] },
      { $max: [0, { $subtract: ['$subtotalMinor', { $ifNull: ['$discountMinor', 0] }] }] },
      { $sum: { $map: { input: { $filter: { input: '$refund.allocations', as: 'allocation', cond: { $eq: ['$$allocation.storePublicId', store.publicId] } } },
        as: 'allocation', in: '$$allocation.grossMinor' } } },
    ] } } },
    { $group: { _id: dateGroup('$refund.completedAt'), refundMinor: { $sum: '$itemRefundMinor' } } },
  ];
  const [sales, refunds, orders, products, ratings, lowStock, members, latestOrders, latestProducts, verification] = await Promise.all([
    SellerOrder.aggregate(paidSalesPipeline), SellerOrder.aggregate(refundPipeline),
    SellerOrder.aggregate([{ $match: scope }, ...rootJoin, { $facet: {
      period: [{ $match: { createdAt: { $gte: window.start, $lt: window.end } } }, { $count: 'count' }],
      preparation: [{ $match: { status: { $in: ['confirmed', 'processing'] } } }, { $count: 'count' }],
      awaiting: [{ $match: { status: 'pending_payment' } }, { $count: 'count' }],
    } }]),
    Product.aggregate([{ $match: { storeId: store._id, countries: store.country } },
      { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Product.aggregate([{ $match: { storeId: store._id, countries: store.country } },
      { $lookup: { from: Review.collection.name, localField: '_id', foreignField: 'productId', as: 'review',
        pipeline: [{ $match: { status: 'published', country: store.country } }, { $project: { rating: 1 } }] } },
      { $unwind: '$review' }, { $group: { _id: null, average: { $avg: '$review.rating' }, count: { $sum: 1 } } }]),
    StockItem.aggregate([{ $match: { storeId: store._id } },
      { $match: { $expr: { $lte: [{ $subtract: ['$onHand', { $add: ['$reserved', '$damaged', '$quarantined'] }] }, '$reorderPoint'] } } },
      { $lookup: { from: Warehouse.collection.name, localField: 'warehouseId', foreignField: '_id', as: 'warehouse',
        pipeline: [{ $match: { storeId: store._id, country: store.country, active: true } }, { $project: { _id: 1 } }] } },
      { $unwind: '$warehouse' }, { $group: { _id: '$variantId' } }, { $count: 'count' }]),
    StoreMember.aggregate([{ $match: { storeId: store._id, status: 'active' } },
      { $lookup: { from: User.collection.name, localField: 'userId', foreignField: '_id', as: 'actor',
        pipeline: [{ $match: { status: 'active' } }, { $project: { name: 1 } }] } }, { $unwind: '$actor' },
      { $sort: { acceptedAt: 1, _id: 1 } }, { $facet: { total: [{ $count: 'count' }],
        roles: [{ $group: { _id: '$role' } }, { $count: 'count' }], people: [{ $limit: 4 }, { $project: { _id: 0, name: '$actor.name' } }] } }]),
    SellerOrder.aggregate([{ $match: scope }, ...rootJoin, { $sort: { updatedAt: -1, _id: -1 } }, { $limit: 3 },
      { $project: { _id: 0, publicId: 1, status: 1, updatedAt: 1 } }]),
    Product.find({ storeId: store._id, countries: store.country }).select('publicId title status updatedAt').sort({ updatedAt: -1, _id: -1 }).limit(3).lean(),
    SellerVerification.findOne({ storeId: store._id }).select('status updatedAt').lean(),
  ]);
  const paidMap = new Map(sales.map(row => [row._id, integer(row.paidMinor)]));
  const refundMap = new Map(refunds.map(row => [row._id, integer(row.refundMinor)]));
  const trend = window.buckets.map(bucket => ({ key: bucket.key, label: bucket.label,
    paidMinor: integer(bucket.keys.reduce((sum, key) => sum + (paidMap.get(key) || 0), 0)),
    refundMinor: integer(bucket.keys.reduce((sum, key) => sum + (refundMap.get(key) || 0), 0)) }));
  for (const bucket of trend) bucket.netMinor = integer(bucket.paidMinor - bucket.refundMinor);
  const paidMinor = integer(trend.reduce((sum, bucket) => sum + bucket.paidMinor, 0));
  const refundMinor = integer(trend.reduce((sum, bucket) => sum + bucket.refundMinor, 0));
  const productCounts = Object.fromEntries(products.map(row => [row._id, integer(row.count)]));
  const preparation = integer(orders[0]?.preparation[0]?.count || 0);
  const priority = [
    { text: `Prepare ${preparation} ${preparation === 1 ? 'order' : 'orders'} for handover`, href: '/seller/orders?status=processing' },
    { text: `${integer(lowStock[0]?.count || 0)} low-stock product variants need a stock check`, href: '/seller/products' },
    { text: store.status === 'verified' ? 'Review your store profile and fulfilment details' : 'Complete store verification before publishing products', href: store.status === 'verified' ? '/seller/store' : '/seller/onboarding' },
  ];
  const activity = [
    ...latestOrders.map(row => ({ text: `Order ${row.publicId}: ${row.status.replaceAll('_', ' ')}`, at: row.updatedAt,
      href: '/seller/orders/' + encodeURIComponent(row.publicId), icon: 'i-clipboard' })),
    ...latestProducts.map(row => ({ text: `${row.title}: ${row.status.replaceAll('_', ' ')}`, at: row.updatedAt,
      href: '/seller/products/' + encodeURIComponent(row.publicId), icon: 'i-box' })),
    ...(verification ? [{ text: `Store verification: ${verification.status}`, at: verification.updatedAt, href: '/seller/onboarding', icon: 'i-shield' }] : []),
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 3);
  const team = { total: integer(members[0]?.total[0]?.count || 0), roles: integer(members[0]?.roles[0]?.count || 0),
    people: members[0]?.people || [] };
  return {
    store: { publicId: store.publicId, name: store.name, country: store.country, currency: store.currency, status: store.status },
    period, timeZone: window.timeZone, range: { start: window.start, end: window.end },
    metrics: { paidMinor, refundMinor, netSalesMinor: integer(paidMinor - refundMinor),
      orders: integer(orders[0]?.period[0]?.count || 0), publishedProducts: integer(productCounts.published || 0),
      products: integer(products.reduce((sum, row) => sum + row.count, 0)), rating: ratings[0] ? Number(ratings[0].average.toFixed(1)) : null,
      reviews: integer(ratings[0]?.count || 0), preparation, awaitingPayment: integer(orders[0]?.awaiting[0]?.count || 0) },
    trend, priority, activity, team, verification: verification?.status || 'not_started',
  };
}

import {
  Brand,
  Category,
  Order,
  Payout,
  PayoutAccount,
  Product,
  ProductMedia,
  ProductVariant,
  Review,
  SellerContactRequest,
  SellerOrder,
  SellerPromotion,
  SellerReturnCase,
  SellerShipment,
  StockItem,
  SubscriptionChangeRequest,
  SubscriptionEnrollment,
  SubscriptionPlan,
  Warehouse,
} from '../models/index.js';
import { sellerFinanceStatement } from './seller-finance.js';
import { sellerDashboardDataPlan, sellerDashboardViewAccess } from './seller-dashboard-access.js';

const ACTIVE_ORDER_STATUSES = ['confirmed', 'processing', 'ready', 'fulfilled', 'partially_refunded', 'refunded'];

function safeNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function startOfDay(daysAgo = 0) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date;
}

function monthBuckets(count = 7) {
  const now = new Date();
  return Array.from({ length: count }, (_, index) => {
    const offset = count - index - 1;
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset + 1, 1));
    return {
      key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
      label: start.toLocaleDateString('en', { month: 'short' }),
      start,
      end,
    };
  });
}

function uniqueCustomers(orders) {
  const customers = new Map();
  for (const sellerOrder of orders) {
    const order = sellerOrder.orderId;
    if (!order) continue;
    const key = order.userId ? String(order.userId) : `${order.contact?.email || ''}:${order.contact?.phone || ''}`;
    if (!key || key === ':') continue;
    const current = customers.get(key) || {
      key,
      name: order.contact?.fullName || 'Customer',
      email: order.contact?.email || '',
      phone: order.contact?.phone || '',
      city: order.contact?.city || '',
      orders: 0,
      spendMinor: 0,
      lastOrderAt: sellerOrder.createdAt,
    };
    current.orders += 1;
    current.spendMinor += safeNumber(sellerOrder.subtotalMinor);
    if (!current.lastOrderAt || sellerOrder.createdAt > current.lastOrderAt) current.lastOrderAt = sellerOrder.createdAt;
    customers.set(key, current);
  }
  return [...customers.values()].sort((a, b) => new Date(b.lastOrderAt) - new Date(a.lastOrderAt));
}

function productLookups(products, variants, media) {
  const variantsByProduct = new Map();
  for (const variant of variants) {
    const key = String(variant.productId);
    const list = variantsByProduct.get(key) || [];
    list.push(variant);
    variantsByProduct.set(key, list);
  }
  const mediaByProduct = new Map();
  for (const item of media) {
    const key = String(item.productId);
    if (!mediaByProduct.has(key)) mediaByProduct.set(key, item);
  }
  return products.map((product) => ({
    ...product,
    variants: variantsByProduct.get(String(product._id)) || [],
    cover: mediaByProduct.get(String(product._id)) || null,
  }));
}

export async function loadSellerDashboard(request) {
  const store = request.store;
  const membership = request.storeMembership;
  const dataPlan = sellerDashboardDataPlan(membership?.role);
  const access = sellerDashboardViewAccess(membership?.role);
  const storeFilter = { storeId: store._id };
  const productFilter = { storeId: store._id };
  const sevenMonths = monthBuckets(7);
  const analyticsStart = sevenMonths[0].start;
  const insightProductIds = (dataPlan.support || dataPlan.analytics)
    ? await Product.find(productFilter).distinct('_id')
    : [];
  const orderSelect = dataPlan.customerPii
    ? 'publicId userId contact paymentState fulfillmentState returnState refundState createdAt'
    : 'publicId paymentState fulfillmentState returnState refundState createdAt';
  const orderMetrics = dataPlan.fulfilment || dataPlan.analytics;

  const [
    products,
    variants,
    media,
    stock,
    sellerOrders,
    shipments,
    returns,
    promotions,
    reviews,
    messages,
    payoutAccounts,
    payouts,
    plans,
    enrollment,
    changeRequests,
    categories,
    brands,
    warehouses,
    finance,
    ratingAggregate,
    orderStatusAggregate,
    monthlySales,
  ] = await Promise.all([
    dataPlan.catalogue
      ? Product.find(productFilter).populate('categoryId', 'name publicId').populate('brandId', 'name publicId').sort({ updatedAt: -1 }).limit(200).lean()
      : Promise.resolve([]),
    dataPlan.catalogue
      ? ProductVariant.find(storeFilter).sort({ createdAt: -1 }).limit(600).lean()
      : Promise.resolve([]),
    dataPlan.catalogue
      ? ProductMedia.find({ ...storeFilter, status: { $in: ['ready', 'approved'] } }).sort({ productId: 1, position: 1, createdAt: 1 }).lean()
      : Promise.resolve([]),
    dataPlan.inventory
      ? StockItem.find(storeFilter).populate('warehouseId', 'publicId name').populate({ path: 'variantId', select: 'publicId sku title priceMinor currency productId', populate: { path: 'productId', select: 'publicId title status' } }).sort({ updatedAt: -1 }).limit(300).lean()
      : Promise.resolve([]),
    dataPlan.orders
      ? SellerOrder.find(storeFilter).populate({ path: 'orderId', select: orderSelect }).sort({ createdAt: -1 }).limit(200).lean()
      : Promise.resolve([]),
    dataPlan.fulfilment
      ? SellerShipment.find(storeFilter).sort({ updatedAt: -1 }).limit(150).lean()
      : Promise.resolve([]),
    dataPlan.support
      ? SellerReturnCase.find(storeFilter).sort({ slaDueAt: 1, createdAt: -1 }).limit(150).lean()
      : Promise.resolve([]),
    dataPlan.growth
      ? SellerPromotion.find(storeFilter).sort({ createdAt: -1 }).limit(150).lean()
      : Promise.resolve([]),
    dataPlan.support
      ? Review.find({ productId: { $in: insightProductIds } }).sort({ createdAt: -1 }).limit(200).lean()
      : Promise.resolve([]),
    dataPlan.support
      ? SellerContactRequest.find(storeFilter).populate('customerUserId', 'name').sort({ lastMessageAt: -1 }).limit(150).lean()
      : Promise.resolve([]),
    dataPlan.payouts
      ? PayoutAccount.find({ ownerStoreId: store._id, ownerType: 'seller' }).select('-destinationEncrypted').sort({ createdAt: -1 }).lean()
      : Promise.resolve([]),
    dataPlan.payouts
      ? Payout.find({ ownerStoreId: store._id }).sort({ createdAt: -1 }).limit(100).lean()
      : Promise.resolve([]),
    dataPlan.subscriptions
      ? SubscriptionPlan.find({ audience: 'seller', country: store.country, currency: store.currency, status: 'active' }).sort({ sortOrder: 1, priceMinor: 1 }).lean()
      : Promise.resolve([]),
    dataPlan.subscriptions
      ? SubscriptionEnrollment.findOne({ audience: 'seller', storeId: store._id, status: { $in: ['trialing', 'active', 'past_due'] } }).populate('planId').sort({ createdAt: -1 }).lean()
      : Promise.resolve(null),
    dataPlan.subscriptions
      ? SubscriptionChangeRequest.find({ audience: 'seller', storeId: store._id }).populate('planId', 'name').sort({ createdAt: -1 }).limit(20).lean()
      : Promise.resolve([]),
    dataPlan.catalogue
      ? Category.find({ active: true, $or: [{ countries: { $size: 0 } }, { countries: store.country }] }).sort({ name: 1 }).lean()
      : Promise.resolve([]),
    dataPlan.catalogue
      ? Brand.find({ status: 'approved' }).sort({ name: 1 }).limit(500).lean()
      : Promise.resolve([]),
    dataPlan.inventory
      ? Warehouse.find({ storeId: store._id }).sort({ createdAt: 1 }).lean()
      : Promise.resolve([]),
    dataPlan.finance
      ? sellerFinanceStatement({ store, limit: 25 })
      : Promise.resolve({ commerce: { sellerReceivableMinor: 0 }, completedRefundSellerMinor: 0, inFlightPayoutMinor: 0, entries: [], profitability: { rows: [] } }),
    (dataPlan.support || dataPlan.analytics)
      ? Review.aggregate([
          { $match: { productId: { $in: insightProductIds }, status: 'published' } },
          { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } },
        ])
      : Promise.resolve([]),
    orderMetrics
      ? SellerOrder.aggregate([
          { $match: { storeId: store._id } },
          { $group: { _id: '$status', count: { $sum: 1 }, subtotalMinor: { $sum: '$subtotalMinor' } } },
        ])
      : Promise.resolve([]),
    dataPlan.analytics
      ? SellerOrder.aggregate([
          { $match: { storeId: store._id, createdAt: { $gte: analyticsStart }, status: { $in: ACTIVE_ORDER_STATUSES } } },
          { $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } }, salesMinor: { $sum: '$subtotalMinor' }, orders: { $sum: 1 } } },
          { $sort: { '_id.year': 1, '_id.month': 1 } },
        ])
      : Promise.resolve([]),
  ]);

  const productRows = productLookups(products, variants, media);
  const promotionRows = promotions.filter((row) => row.type !== 'voucher');
  const couponRows = promotions.filter((row) => row.type === 'voucher');
  const customers = dataPlan.customerPii ? uniqueCustomers(sellerOrders) : [];
  const rating = ratingAggregate[0] || { average: 0, count: 0 };
  const statusMap = Object.fromEntries(orderStatusAggregate.map((row) => [row._id, row]));
  const orderCount = orderStatusAggregate.reduce((sum, row) => sum + safeNumber(row.count), 0);
  const fulfilledCount = safeNumber(statusMap.fulfilled?.count);
  const lowStock = stock.filter((row) => {
    const available = safeNumber(row.onHand) - safeNumber(row.reserved) - safeNumber(row.damaged) - safeNumber(row.quarantined);
    return available <= safeNumber(row.reorderPoint);
  });
  const salesMap = new Map(monthlySales.map((row) => [`${row._id.year}-${String(row._id.month).padStart(2, '0')}`, row]));
  const trend = sevenMonths.map((bucket) => ({
    label: bucket.label,
    salesMinor: safeNumber(salesMap.get(bucket.key)?.salesMinor),
    orders: safeNumber(salesMap.get(bucket.key)?.orders),
  }));
  const recent30 = sellerOrders.filter((row) => new Date(row.createdAt) >= startOfDay(30));
  const recent30SalesMinor = dataPlan.analytics
    ? recent30.filter((row) => ACTIVE_ORDER_STATUSES.includes(row.status)).reduce((sum, row) => sum + safeNumber(row.subtotalMinor), 0)
    : 0;
  const unreadMessages = dataPlan.support ? messages.filter((row) => row.status === 'new').length : 0;
  const pendingReturns = dataPlan.support ? returns.filter((row) => ['pending', 'acknowledged', 'contested', 'escalated'].includes(row.status)).length : 0;

  return {
    user: {
      publicId: request.user.publicId,
      name: request.user.name,
      email: request.user.email,
      country: request.user.country,
      currency: request.user.currency,
    },
    store: store.toObject ? store.toObject() : store,
    access,
    availableStores: request.res?.locals?.availableStores || [],
    summary: {
      productCount: products.length,
      publishedCount: products.filter((row) => row.status === 'published').length,
      lowStockCount: lowStock.length,
      orderCount,
      recent30SalesMinor,
      fulfillmentRate: orderCount ? Math.round((fulfilledCount / orderCount) * 1000) / 10 : 0,
      averageRating: Math.round(safeNumber(rating.average) * 10) / 10,
      reviewCount: safeNumber(rating.count),
      unreadMessages,
      pendingReturns,
      pendingPayouts: dataPlan.payouts ? payouts.filter((row) => ['requested', 'approved', 'submitting', 'submitted', 'unknown'].includes(row.status)).length : 0,
      payableMinor: dataPlan.finance
        ? safeNumber(finance.commerce?.sellerReceivableMinor) - safeNumber(finance.completedRefundSellerMinor) - safeNumber(finance.inFlightPayoutMinor)
        : 0,
    },
    products: productRows,
    inventory: stock,
    lowStock,
    orders: sellerOrders,
    shipments,
    returns,
    customers,
    promotions: promotionRows,
    coupons: couponRows,
    finance,
    payoutAccounts,
    payouts,
    analytics: { trend, statuses: statusMap },
    reviews,
    messages,
    subscriptions: { plans, enrollment, changeRequests },
    editor: { categories, brands, country: store.country, currency: store.currency },
    warehouses,
  };
}

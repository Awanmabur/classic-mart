import { AppError } from '../core/errors.js';
import { LedgerAccount, LedgerTransaction, Payout, Refund, SellerOrder } from '../models/index.js';
import { cursorScope, cursorSort, pageResult } from './pagination.js';
import { sellerSkuProfitability } from './seller-profitability.js';

function safeInt(value) {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number)) throw new AppError('Seller settlement data is invalid.', 500, 'SELLER_FINANCE_INVALID');
  return number;
}

function lineEconomics(items = []) {
  return items.reduce((totals, item) => ({
    grossMinor: totals.grossMinor + safeInt(item.grossMinor ?? item.lineTotalMinor),
    discountMinor: totals.discountMinor + safeInt(item.discountMinor),
    customerPaidMinor: totals.customerPaidMinor + safeInt(item.customerPaidMinor),
    platformFeeMinor: totals.platformFeeMinor + safeInt(item.platformFeeMinor),
    sellerReceivableMinor: totals.sellerReceivableMinor + safeInt(item.sellerReceivableMinor),
  }), { grossMinor: 0, discountMinor: 0, customerPaidMinor: 0, platformFeeMinor: 0, sellerReceivableMinor: 0 });
}

function storeRefundEconomics(refund, storePublicId) {
  return (refund.allocations || []).filter(row => String(row.storePublicId) === String(storePublicId)).reduce((totals, row) => ({
    grossMinor: totals.grossMinor + safeInt(row.grossMinor),
    platformFeeMinor: totals.platformFeeMinor + safeInt(row.platformFeeMinor),
    sellerReceivableMinor: totals.sellerReceivableMinor + safeInt(row.sellerReceivableMinor),
  }), { grossMinor: 0, platformFeeMinor: 0, sellerReceivableMinor: 0 });
}

export async function sellerFinanceStatement({ store, activityCursor = '', orderCursor = '', refundCursor = '', limit = 25 }) {
  if (!store?._id || !store?.publicId) throw new AppError('Seller finance workspace is unavailable.', 409, 'SELLER_FINANCE_STORE_REQUIRED');
  const size = Math.min(50, Math.max(10, Number(limit) || 25));
  const profitabilityPromise = sellerSkuProfitability({ store, limit: 100 });
  const payable = await LedgerAccount.findOne({ code: 'seller_payable', ownerType: 'store', ownerPublicId: store.publicId, country: store.country, currency: store.currency, active: true }).lean();
  const activityBase = payable ? { country: store.country, currency: store.currency, 'entries.accountId': payable._id } : { _id: null };
  const orderBase = { storeId: store._id };
  const refundBase = { 'allocations.storePublicId': store.publicId };
  const payoutBase = { ownerStoreId: store._id };

  const [activityRows, activityTotal, orderRows, orderTotal, refundRows, refundTotal, commerceAggregate, refundAggregate, payoutAggregate, profitability] = await Promise.all([
    LedgerTransaction.find(cursorScope(activityBase, activityCursor)).sort(cursorSort()).limit(size + 1).lean(),
    payable ? LedgerTransaction.countDocuments(activityBase) : 0,
    SellerOrder.find(cursorScope(orderBase, orderCursor)).sort(cursorSort()).limit(size + 1).lean(),
    SellerOrder.countDocuments(orderBase),
    Refund.find(cursorScope(refundBase, refundCursor)).populate('orderId', 'publicId').sort(cursorSort()).limit(size + 1).lean(),
    Refund.countDocuments(refundBase),
    SellerOrder.aggregate([
      { $match: { storeId: store._id, status: { $nin: ['pending_payment', 'cancelled', 'expired'] } } },
      { $unwind: '$items' },
      { $group: { _id: null, grossMinor: { $sum: '$items.grossMinor' }, discountMinor: { $sum: '$items.discountMinor' }, customerPaidMinor: { $sum: '$items.customerPaidMinor' }, platformFeeMinor: { $sum: '$items.platformFeeMinor' }, sellerReceivableMinor: { $sum: '$items.sellerReceivableMinor' } } },
    ]),
    Refund.aggregate([
      { $match: refundBase },
      { $unwind: '$allocations' },
      { $match: { 'allocations.storePublicId': store.publicId } },
      { $group: { _id: '$status', grossMinor: { $sum: '$allocations.grossMinor' }, platformFeeMinor: { $sum: '$allocations.platformFeeMinor' }, sellerReceivableMinor: { $sum: '$allocations.sellerReceivableMinor' } } },
    ]),
    Payout.aggregate([
      { $match: payoutBase },
      { $group: { _id: '$status', amountMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
    ]),
    profitabilityPromise,
  ]);

  const activityPage = pageResult(activityRows, { limit: size, total: activityTotal });
  activityPage.items = activityPage.items.map(row => {
    const ownEntries = (row.entries || []).filter(entry => String(entry.accountId) === String(payable?._id));
    const deltaMinor = ownEntries.reduce((sum, entry) => sum + safeInt(entry.creditMinor) - safeInt(entry.debitMinor), 0);
    return { ...row, deltaMinor };
  });
  const orderPage = pageResult(orderRows, { limit: size, total: orderTotal });
  orderPage.items = orderPage.items.map(row => ({ ...row, economics: lineEconomics(row.items) }));
  const refundPage = pageResult(refundRows, { limit: size, total: refundTotal });
  refundPage.items = refundPage.items.map(row => ({ ...row, economics: storeRefundEconomics(row, store.publicId) }));

  const refundsByStatus = Object.fromEntries(refundAggregate.map(row => [row._id, { grossMinor: safeInt(row.grossMinor), platformFeeMinor: safeInt(row.platformFeeMinor), sellerReceivableMinor: safeInt(row.sellerReceivableMinor) }]));
  const payoutsByStatus = Object.fromEntries(payoutAggregate.map(row => [row._id, { amountMinor: safeInt(row.amountMinor), count: safeInt(row.count) }]));
  const commerce = commerceAggregate[0] || { grossMinor: 0, discountMinor: 0, customerPaidMinor: 0, platformFeeMinor: 0, sellerReceivableMinor: 0 };
  const pendingRefundSellerMinor = ['pending', 'processing'].reduce((sum, status) => sum + safeInt(refundsByStatus[status]?.sellerReceivableMinor), 0);
  const completedRefundSellerMinor = safeInt(refundsByStatus.completed?.sellerReceivableMinor);
  const inFlightPayoutMinor = ['requested', 'approved', 'submitting', 'submitted', 'unknown'].reduce((sum, status) => sum + safeInt(payoutsByStatus[status]?.amountMinor), 0);

  return {
    store: { publicId: store.publicId, name: store.name, country: store.country, currency: store.currency },
    payableAccountPublicId: payable?.publicId || '',
    commerce: Object.fromEntries(Object.entries(commerce).filter(([key]) => key !== '_id').map(([key, value]) => [key, safeInt(value)])),
    pendingRefundSellerMinor,
    completedRefundSellerMinor,
    inFlightPayoutMinor,
    unknownPayoutCount: safeInt(payoutsByStatus.unknown?.count),
    paidPayoutMinor: safeInt(payoutsByStatus.paid?.amountMinor),
    refundsByStatus,
    payoutsByStatus,
    activity: activityPage,
    orders: orderPage,
    refunds: refundPage,
    profitability,
  };
}

export async function streamSellerLedgerCsv({ store, response }) {
  if (!store?._id || !store?.publicId) throw new AppError('Seller finance workspace is unavailable.', 409, 'SELLER_FINANCE_STORE_REQUIRED');
  const payable = await LedgerAccount.findOne({ code: 'seller_payable', ownerType: 'store', ownerPublicId: store.publicId, country: store.country, currency: store.currency, active: true }).lean();
  const csvCell = value => { let text = String(value ?? ''); if (/^[=+@-]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
  response.write('Date,Transaction,Reference type,Reference,Description,Currency,Payable change minor\n');
  if (!payable) return;
  const cursor = LedgerTransaction.find({ country: store.country, currency: store.currency, 'entries.accountId': payable._id }).sort({ createdAt: 1, _id: 1 }).lean().cursor();
  for await (const row of cursor) {
    const deltaMinor = (row.entries || []).filter(entry => String(entry.accountId) === String(payable._id)).reduce((sum, entry) => sum + safeInt(entry.creditMinor) - safeInt(entry.debitMinor), 0);
    response.write([row.createdAt?.toISOString?.() || '', row.publicId, row.referenceType, row.referencePublicId, row.description, row.currency, deltaMinor].map(csvCell).join(',') + '\n');
  }
}

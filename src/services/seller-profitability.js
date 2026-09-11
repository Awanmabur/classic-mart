import { AppError } from '../core/errors.js';
import { Refund, SellerOrder } from '../models/index.js';

function safeInt(value) {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number)) throw new AppError('Seller profitability data is invalid.', 500, 'SELLER_PROFITABILITY_INVALID');
  return number;
}

export async function sellerSkuProfitability({ store, limit = 100 }) {
  if (!store?._id || !store?.publicId) throw new AppError('Seller profitability workspace is unavailable.', 409, 'SELLER_PROFITABILITY_STORE_REQUIRED');
  const size = Math.max(20, Math.min(250, Number(limit) || 100));
  const saleStatuses = ['confirmed', 'processing', 'ready', 'fulfilled', 'partially_refunded', 'refunded'];
  const [sales, refunds, skuCountRows] = await Promise.all([
    SellerOrder.aggregate([
      { $match: { storeId: store._id, status: { $in: saleStatuses }, subtotalMinor: { $gt: 0 } } },
      { $unwind: '$items' },
      { $group: {
        _id: { variantPublicId: '$items.variantPublicId', sku: '$items.sku', title: '$items.title', variantTitle: '$items.variantTitle' },
        units: { $sum: '$items.quantity' },
        grossMinor: { $sum: '$items.grossMinor' },
        discountMinor: { $sum: '$items.discountMinor' },
        customerPaidMinor: { $sum: '$items.customerPaidMinor' },
        platformFeeMinor: { $sum: '$items.platformFeeMinor' },
        sellerReceivableMinor: { $sum: '$items.sellerReceivableMinor' },
        knownCostUnits: { $sum: { $cond: [{ $eq: ['$items.costSnapshotStatus', 'captured'] }, '$items.quantity', 0] } },
        unknownCostUnits: { $sum: { $cond: [{ $eq: ['$items.costSnapshotStatus', 'captured'] }, 0, '$items.quantity'] } },
        knownCostMinor: { $sum: { $cond: [{ $eq: ['$items.costSnapshotStatus', 'captured'] }, { $multiply: ['$items.unitCostMinor', '$items.quantity'] }, 0] } },
        knownSellerReceivableMinor: { $sum: { $cond: [{ $eq: ['$items.costSnapshotStatus', 'captured'] }, '$items.sellerReceivableMinor', 0] } },
      } },
      { $sort: { sellerReceivableMinor: -1, '_id.sku': 1 } },
      { $limit: size },
    ]),
    Refund.aggregate([
      { $match: { status: 'completed', 'allocations.storePublicId': store.publicId } },
      { $unwind: '$allocations' },
      { $match: { 'allocations.storePublicId': store.publicId } },
      { $group: {
        _id: { variantPublicId: '$allocations.variantPublicId', sku: '$allocations.sku' },
        completedRefundSellerMinor: { $sum: '$allocations.sellerReceivableMinor' },
        knownRefundSellerMinor: { $sum: { $cond: [{ $eq: ['$allocations.costSnapshotStatus', 'captured'] }, '$allocations.sellerReceivableMinor', 0] } },
        unknownRefundSellerMinor: { $sum: { $cond: [{ $eq: ['$allocations.costSnapshotStatus', 'captured'] }, 0, '$allocations.sellerReceivableMinor'] } },
      } },
    ]),
    SellerOrder.aggregate([
      { $match: { storeId: store._id, status: { $in: saleStatuses }, subtotalMinor: { $gt: 0 } } },
      { $unwind: '$items' },
      { $group: { _id: '$items.variantPublicId' } },
      { $count: 'count' },
    ]),
  ]);
  const refundByVariant = new Map(refunds.map(row => [String(row._id?.variantPublicId || ''), row]));
  let totalUnknownCostUnits = 0, totalKnownCostMinor = 0, totalKnownReceivableMinor = 0, totalKnownRefundSellerMinor = 0;
  const rows = sales.map(row => {
    const refund = refundByVariant.get(String(row._id?.variantPublicId || '')) || {};
    const knownCostMinor = safeInt(row.knownCostMinor), knownSellerReceivableMinor = safeInt(row.knownSellerReceivableMinor), knownRefundSellerMinor = safeInt(refund.knownRefundSellerMinor);
    const grossContributionMinor = knownSellerReceivableMinor - knownCostMinor;
    const netContributionMinor = grossContributionMinor - knownRefundSellerMinor;
    const denominator = Math.max(1, knownSellerReceivableMinor);
    totalUnknownCostUnits += safeInt(row.unknownCostUnits); totalKnownCostMinor += knownCostMinor; totalKnownReceivableMinor += knownSellerReceivableMinor; totalKnownRefundSellerMinor += knownRefundSellerMinor;
    return {
      variantPublicId: String(row._id?.variantPublicId || ''), sku: String(row._id?.sku || ''), title: String(row._id?.title || ''), variantTitle: String(row._id?.variantTitle || ''),
      units: safeInt(row.units), grossMinor: safeInt(row.grossMinor), discountMinor: safeInt(row.discountMinor), customerPaidMinor: safeInt(row.customerPaidMinor), platformFeeMinor: safeInt(row.platformFeeMinor), sellerReceivableMinor: safeInt(row.sellerReceivableMinor),
      knownCostUnits: safeInt(row.knownCostUnits), unknownCostUnits: safeInt(row.unknownCostUnits), knownCostMinor, knownSellerReceivableMinor,
      completedRefundSellerMinor: safeInt(refund.completedRefundSellerMinor), knownRefundSellerMinor, unknownRefundSellerMinor: safeInt(refund.unknownRefundSellerMinor), grossContributionMinor, netContributionMinor,
      contributionMarginBps: Math.round(netContributionMinor * 10000 / denominator), costCoverageComplete: safeInt(row.unknownCostUnits) === 0 && safeInt(refund.unknownRefundSellerMinor) === 0,
    };
  });
  return {
    rows,
    totalSkuCount: safeInt(skuCountRows[0]?.count),
    limited: safeInt(skuCountRows[0]?.count) > rows.length,
    summary: {
      totalUnknownCostUnits, totalKnownCostMinor, totalKnownReceivableMinor, totalKnownRefundSellerMinor,
      knownGrossContributionMinor: totalKnownReceivableMinor - totalKnownCostMinor,
      knownNetContributionMinor: totalKnownReceivableMinor - totalKnownCostMinor - totalKnownRefundSellerMinor,
    },
    methodology: 'Contribution uses immutable order-line cost snapshots. Legacy lines without a historical cost snapshot are excluded from margin math, never treated as zero cost. Completed refund seller-receivable reversals are deducted; returned-stock cost recovery is not assumed.',
  };
}

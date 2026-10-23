import { AppError } from '../core/errors.js';
import { SubscriptionEnrollment } from '../models/SubscriptionEnrollment.js';
import { Product } from '../models/Product.js';
import { StoreMember } from '../models/StoreMember.js';
import { StoreTeamInvitation } from '../models/StoreTeamInvitation.js';
import { Campaign } from '../models/Campaign.js';
import { Store } from '../models/Store.js';
import { SubscriptionCharge } from '../models/SubscriptionCharge.js';
import { DEFAULT_SELLER_ENTITLEMENTS } from '../models/subscription-terms.js';

/** Paid period snapshots, rather than mutable catalogue labels, grant capacity. */
export async function sellerEntitlements(store, { session = null, at = new Date() } = {}) {
  const rows = await SubscriptionEnrollment.find({ audience: 'seller', storeId: store._id, country: store.country, currency: store.currency,
    status: { $in: ['active', 'trialing'] }, reversedAt: null,
    startsAt: { $lte: at }, $or: [{ currentPeriodEndsAt: { $gt: at } }, { currentPeriodEndsAt: null }],
    'terms.entitlements': { $exists: true } }).sort({ createdAt: -1, _id: -1 }).session(session).lean();
  const result = { ...DEFAULT_SELLER_ENTITLEMENTS };
  const charges = await SubscriptionCharge.find({ _id: { $in: rows.map(row => row.subscriptionChargeId).filter(Boolean) }, storeId: store._id,
    storePublicId: store.publicId, country: store.country, currency: store.currency, status: 'succeeded', paidAt: { $type: 'date' }, reversedAt: null }).session(session).lean();
  for (const row of rows) {
    const charge = charges.find(item => String(item._id) === String(row.subscriptionChargeId) && String(item.enrollmentId) === String(row._id)
      && item.publicId === row.subscriptionChargePublicId && item.enrollmentPublicId === row.publicId && item.amountMinor === row.priceMinor
      && item.terms?.planPublicId === row.planPublicId && item.terms?.planVersion === row.terms?.planVersion
      && Object.keys(DEFAULT_SELLER_ENTITLEMENTS).every(key => item.terms?.entitlements?.[key] === row.terms?.entitlements?.[key]));
    if (!charge) continue;
    const terms = row.terms.entitlements;
    for (const key of ['productLimit', 'seatLimit', 'campaignLimit', 'analyticsDays']) result[key] = Math.max(result[key], terms[key] || 0);
    result.analyticsExport ||= Boolean(terms.analyticsExport);
  }
  return result;
}

/** Every capacity check takes the same Store write lock, preventing count/write races. */
export async function assertSellerCapacity(store, resource, { session, delta = 1, excludeId } = {}) {
  if (!session?.inTransaction()) throw new AppError('Capacity changes require a transaction.', 500, 'SUBSCRIPTION_TRANSACTION_REQUIRED');
  const fence = await Store.updateOne({ _id: store._id, status: store.status, country: store.country, currency: store.currency }, { $inc: { __v: 1 } }, { session });
  if (fence.modifiedCount !== 1) throw new AppError('Store access changed.', 409, 'STORE_LOCKED');
  store.__v = (store.__v || 0) + 1;
  const entitlements = await sellerEntitlements(store, { session });
  const exclusion = excludeId ? { _id: { $ne: excludeId } } : {};
  let count, limit;
  if (resource === 'products') { count = await Product.countDocuments({ storeId: store._id, status: { $ne: 'archived' }, ...exclusion }).session(session); limit = entitlements.productLimit; }
  else if (resource === 'seats') {
    count = await StoreMember.countDocuments({ storeId: store._id, status: 'active', ...exclusion }).session(session)
      + await StoreTeamInvitation.countDocuments({ storeId: store._id, status: 'pending', expiresAt: { $gt: new Date() }, ...exclusion }).session(session);
    limit = entitlements.seatLimit;
  } else if (resource === 'campaigns') { count = await Campaign.countDocuments({ storeId: store._id, status: { $in: ['draft', 'submitted', 'active', 'paused'] }, ...exclusion }).session(session); limit = entitlements.campaignLimit; }
  else throw new AppError('Unknown capacity resource.', 500, 'SUBSCRIPTION_RESOURCE_INVALID');
  if (count + delta > limit) throw new AppError(`Your current plan allows ${limit} ${resource}. Free capacity or select an approved plan.`, 409, 'SUBSCRIPTION_LIMIT_REACHED');
  return entitlements;
}

export async function assertSellerAnalytics(store, { session = null, export: exporting = false, from, to = new Date() } = {}) {
  const entitlements = await sellerEntitlements(store, { session });
  if (exporting && !entitlements.analyticsExport) throw new AppError('Your current plan does not include analytics exports.', 403, 'SUBSCRIPTION_EXPORT_UNAVAILABLE');
  if (from && new Date(from) < new Date(to.getTime() - entitlements.analyticsDays * 86400000)) throw new AppError(`Your current plan includes ${entitlements.analyticsDays} days of analytics.`, 403, 'SUBSCRIPTION_ANALYTICS_LIMIT');
  return entitlements;
}

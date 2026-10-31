import { AppError } from '../core/errors.js';
import { Coupon, CountrySetting, Order, Product, SellerPromotion, Store, User } from '../models/index.js';
import { allocateSellerLineSettlement } from './money.js';

const lineKey = row => `${row.storeId}:${row.variantId || row.productId}`;

/** Evaluate real country Coupon records after seller offers, preserving their floor capacity. */
export async function countryCouponQuote({ rows, country, currency, codes = [], userId, session = null, base }) {
  const result = { discountMinor: base.discountMinor, freeShipping: base.freeShipping, applications: [...base.applications], storeDiscounts: { ...base.storeDiscounts }, sellerStoreDiscounts: { ...base.storeDiscounts }, countryLineDiscounts: {}, couponReservations: [] };
  if (!rows.length || !codes.length) return result;
  const now = new Date(), market = await CountrySetting.findOne({ code: country, currency, active: true }).session(session).lean(); if (!market) return result;
  const actor = userId ? await User.findOne({ _id: userId, status: 'active' }).select('role country platformAccessManagedAt').session(session).lean() : null;
  const coupons = await Coupon.find({ country, currency, code: { $in: codes.map(code => String(code).toUpperCase()) }, status: 'active', startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $gt: now } }] }).sort({ _id: 1 }).session(session).lean();
  // Older installations may already contain a code in both collections. The
  // seller quote exposes its source ID, not its private coupon code, so resolve
  // that actual source rather than relying on a nonexistent DTO code field.
  const appliedVoucherIds = base.applications.filter(application => application.type === 'voucher').map(application => application.id);
  const appliedSellerCodes = new Set(coupons.length && appliedVoucherIds.length ? (await SellerPromotion.find({ country, type: 'voucher', publicId: { $in: appliedVoucherIds }, code: { $in: coupons.map(coupon => coupon.code) } }).select('code').session(session).lean()).map(row => row.code) : []);
  const products = await Product.find({ publicId: { $in: rows.map(row => row.productId) }, countries: country, status: { $in: ['approved','published'] } }).select('publicId categoryId').populate('categoryId', 'publicId active countries').session(session).lean(); const categories = new Map(products.filter(product => product.categoryId?.active && (!product.categoryId.countries.length || product.categoryId.countries.includes(country))).map(product => [product.publicId, product.categoryId.publicId]));
  const stores = await Store.find({ publicId: { $in: rows.map(row => row.storeId) }, country, currency, status: 'verified' }).select('_id publicId ownerUserId').session(session).lean(); const storeMap = new Map(stores.map(store => [store.publicId, store]));
  const owners = await User.find({ _id: { $in: stores.map(store => store.ownerUserId) }, role: 'seller', status: 'active' }).select('_id').session(session).lean(); const ownerIds = new Set(owners.map(owner => String(owner._id)));
  const baseLineDiscounts = rows.map(() => 0), capacity = rows.map(() => 0);
  for (const storeId of new Set(rows.map(row => row.storeId))) {
    const indices = rows.map((_row, index) => index).filter(index => rows[index].storeId === storeId);
    const settled = allocateSellerLineSettlement(indices.map(index => ({ lineTotalMinor: rows[index].priceMinor * rows[index].quantity })), { discountMinor: base.storeDiscounts[storeId] || 0 });
    const withinFloors = settled.every((item, localIndex) => item.customerPaidMinor >= (rows[indices[localIndex]].minimumPriceMinor || 0) * rows[indices[localIndex]].quantity);
    for (const [localIndex, index] of indices.entries()) { baseLineDiscounts[index] = settled[localIndex].discountMinor; capacity[index] = withinFloors ? Math.max(0, settled[localIndex].customerPaidMinor - (rows[index].minimumPriceMinor || 0) * rows[index].quantity) : 0; }
  }
  for (const coupon of coupons) {
    if (appliedSellerCodes.has(coupon.code) || base.applications.some(application => application.code === coupon.code)) throw new AppError('This coupon code conflicts with a seller offer.', 409, 'COUPON_CODE_AMBIGUOUS');
    if ((coupon.usageLimit && coupon.usageCount >= coupon.usageLimit) || ((coupon.perUserLimit || coupon.firstOrderOnly || coupon.eligibleRoles.length) && !actor) || (coupon.eligibleRoles.length && (actor?.platformAccessManagedAt || !coupon.eligibleRoles.includes(actor?.role)))) continue;
    if (actor && coupon.perUserLimit && await Order.countDocuments({ userId: actor._id, country, couponPublicIds: coupon.publicId }).session(session) >= coupon.perUserLimit) continue;
    if (coupon.firstOrderOnly && await Order.exists({ userId: actor._id, country }).session(session)) continue;
    if (coupon.scope === 'seller') { const store = storeMap.get(coupon.storePublicId); if (!store || String(store._id) !== String(coupon.storeId) || !ownerIds.has(String(store.ownerUserId))) continue; }
    const indices = rows.map((_row,index) => index).filter(index => { const row = rows[index], store = storeMap.get(row.storeId); return store && ownerIds.has(String(store.ownerUserId)) && categories.has(row.productId) && (coupon.scope !== 'seller' || row.storeId === coupon.storePublicId) && (!coupon.eligibleStorePublicIds.length || coupon.eligibleStorePublicIds.includes(row.storeId)) && (!coupon.eligibleCategoryPublicIds.length || coupon.eligibleCategoryPublicIds.includes(categories.get(row.productId))); });
    const subtotal = indices.reduce((sum,index) => sum + rows[index].priceMinor * rows[index].quantity - baseLineDiscounts[index] - (result.countryLineDiscounts[lineKey(rows[index])] || 0), 0); if (!indices.length || subtotal < coupon.minimumSubtotalMinor) continue;
    const raw = coupon.discountType === 'percent' ? Math.floor(subtotal * coupon.discountBps / 10000) : coupon.discountType === 'fixed' ? coupon.discountMinor : 0;
    const amount = Math.min(raw, coupon.maximumDiscountMinor || Number.MAX_SAFE_INTEGER, indices.reduce((sum, index) => sum + capacity[index], 0)); if (coupon.discountType !== 'free_shipping' && amount <= 0) continue;
    const allocations = {}, lineAllocations = []; let remaining = amount;
    for (const index of indices) { const row = rows[index], id = row.storeId, applied = Math.min(remaining, capacity[index]); if (!applied) continue; capacity[index] -= applied; remaining -= applied; allocations[id] = (allocations[id] || 0) + applied; result.storeDiscounts[id] = (result.storeDiscounts[id] || 0) + applied; result.countryLineDiscounts[lineKey(row)] = (result.countryLineDiscounts[lineKey(row)] || 0) + applied; lineAllocations.push({ storePublicId: id, productPublicId: row.productId, variantPublicId: row.variantId || '', discountMinor: applied }); }
    result.discountMinor += amount; result.freeShipping ||= coupon.discountType === 'free_shipping'; result.applications.push({ id: coupon.publicId, type: 'country_coupon', name: coupon.name, discountMinor: amount, allocations, lineAllocations }); result.couponReservations.push({ publicId: coupon.publicId, version: coupon.__v || 0, usageCount: coupon.usageCount });
  }
  return result;
}
/** Serialize both coupon collections through the same active country record. */
export async function assertSellerCouponCodeAvailable(store, code, session) {
  if (!session?.inTransaction()) throw new AppError('Coupon code reservations require a transaction.', 500, 'COUPON_TRANSACTION_REQUIRED');
  const market = await CountrySetting.findOne({ code: store.country, currency: store.currency, active: true }).session(session).lean();
  if (!market) throw new AppError('The store country and currency need configuration.', 409, 'SELLER_COUNTRY_UNAVAILABLE');
  const claimed = await CountrySetting.updateOne({ _id: market._id, active: true, currency: market.currency, __v: market.__v || 0 }, { $inc: { __v: 1 } }, { session });
  if (claimed.modifiedCount !== 1) throw new AppError('The coupon market changed. Try again.', 409, 'COUPON_MARKET_CHANGED');
  if (await Coupon.exists({ country: store.country, code: String(code).trim().toUpperCase() }).session(session)) throw new AppError('That coupon code is already in use.', 409, 'PROMOTION_CODE_EXISTS');
}
/** Coupon/account writes serialize quota and first-order claims with the order transaction. */
export async function reserveCountryCoupons(quote, { userId, country, currency, session }) {
  if (!session?.inTransaction()) throw new AppError('Coupon reservations require the checkout transaction.', 500, 'COUPON_TRANSACTION_REQUIRED');
  if (!quote.couponReservations.length) return [];
  if (userId) { const actor = await User.findOne({ _id: userId, status: 'active' }).session(session).lean(); if (!actor || (await User.updateOne({ _id: actor._id, status: 'active', __v: actor.__v || 0 }, { $inc: { __v: 1 } }, { session })).modifiedCount !== 1) throw new AppError('Coupon account eligibility changed.', 409, 'COUPON_ACCOUNT_CHANGED'); }
  for (const claim of quote.couponReservations) { const result = await Coupon.updateOne({ publicId: claim.publicId, country, currency, status: 'active', __v: claim.version, usageCount: claim.usageCount }, { $inc: { usageCount: 1, __v: 1 } }, { session }); if (result.modifiedCount !== 1) throw new AppError('Coupon eligibility changed. Review checkout again.', 409, 'COUPON_CHANGED'); }
  return quote.couponReservations.map(claim => claim.publicId);
}

import mongoose from 'mongoose';
import { sellerOperationsAccess } from './seller-operations-access.js';
import { requestReviewedSellerSubscription, sellerSubscriptionOperationsPage } from './seller-subscription-operations.js';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { env } from '../config/env.js';
import { CountrySetting, Product, ProductVariant, SellerPromotion, Store, StoreMember, SubscriptionChangeRequest, SubscriptionEnrollment, SubscriptionPlan, User } from '../models/index.js';
import { writeAudit } from './audit.js';
import { storeCapabilities } from './store.js';
import { clearSponsoredOfferCache } from './seller-growth.js';
import { cursorScope, cursorSort, pageResult } from './pagination.js';
import { assertSellerCouponCodeAvailable } from './country-coupons.js';

const LIMIT = 25;
const discountTypes = new Set(['voucher', 'bundle', 'quantity_break']);
const promotionTypes = ['bundle', 'quantity_break', 'free_shipping', 'sponsored'];
const promotionStatuses = ['draft', 'active', 'paused', 'expired'];
const label = value => String(value || '').replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase());
const integer = (max, min = 0) => z.coerce.number().int().min(min).max(max);
const productIds = z.union([z.string().max(20000), z.array(z.string().trim().min(3).max(100)).max(200)]).optional().default('').transform(value => [...new Set((Array.isArray(value) ? value : value.split(/[\s,]+/)).map(value => value.trim()).filter(Boolean))]).refine(value => value.length <= 200 && value.every(id => id.length >= 3 && id.length <= 100), 'Choose at most 200 valid product references.');
const promotionSchema = z.object({
  type: z.enum([...promotionTypes, 'voucher']), name: z.string().trim().min(2).max(140),
  code: z.string().trim().max(40).optional().default(''), productPublicIds: productIds,
  discountBps: integer(9000).default(0), fixedDiscountMinor: integer(2_000_000_000).default(0),
  minQuantity: integer(9999, 1).default(1), minSubtotalMinor: integer(2_000_000_000).default(0),
  disclosureText: z.string().trim().max(300).optional().default(''),
  startsAt: z.string().max(40).optional().default(''), endsAt: z.string().max(40).optional().default(''),
  status: z.enum(['draft', 'active']).default('draft'),
});
const subscriptionSchema = z.object({ planPublicId: z.string().trim().min(3).max(100), note: z.string().trim().max(1000).optional().default('') });

function scope(store) { return { storeId: store._id, country: store.country, currency: store.currency }; }
function publicStore(store) { return { publicId: store.publicId, name: store.name, country: store.country, currency: store.currency, status: store.status }; }
function money(value, currency) {
  const zero = new Set(['UGX', 'RWF', 'JPY', 'KRW']).has(currency);
  return new Intl.NumberFormat('en-UG', { style: 'currency', currency, maximumFractionDigits: zero ? 0 : 2 }).format(Number(value || 0) / (zero ? 1 : 100));
}
function day(value, timeZone) { return value ? new Intl.DateTimeFormat('en-UG', { dateStyle: 'medium', timeZone }).format(new Date(value)) : 'No end date'; }
function regex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function filters(request, statuses) {
  const query = request.query || {};
  const search = typeof query.search === 'string' ? query.search.trim().slice(0, 100) : '';
  const status = typeof query.status === 'string' && statuses.includes(query.status) ? query.status : '';
  return { search, status, after: typeof query.after === 'string' ? query.after.slice(0, 512) : '', statuses: [{ value: '', label: 'All' }, ...statuses.map(value => ({ value, label: label(value) }))] };
}
function effectiveStatus(row, now = new Date()) {
  if (row.status === 'active' && row.endsAt && new Date(row.endsAt) <= now) return 'Ended';
  if (row.status === 'active' && new Date(row.startsAt) > now) return 'Scheduled';
  return label(row.status);
}
function discountLabel(row) {
  if (row.type === 'free_shipping') return 'Free delivery';
  if (row.type === 'sponsored') return 'Sponsored placement';
  return [row.discountBps ? `${row.discountBps / 100}%` : '', row.fixedDiscountMinor ? money(row.fixedDiscountMinor, row.currency) : ''].filter(Boolean).join(' or ');
}

async function sellerAccess(request, capability, session = null) {
  return sellerOperationsAccess(request, capability, { session });
}
async function lockStore(request, capability, session) {
  const { store } = await sellerOperationsAccess(request, capability, { session, write: true });
  return store;
}

export { lockStore as lockSellerGrowthStore };
async function transaction(work) {
  const session = await mongoose.startSession();
  try { let result; await session.withTransaction(async () => { result = await work(session); }); return result; }
  finally { await session.endSession(); }
}

function dates(input, { activating = false } = {}) {
  const now = new Date();
  const startsAt = input.startsAt ? new Date(input.startsAt) : now;
  const endsAt = input.endsAt ? new Date(input.endsAt) : undefined;
  if (!Number.isFinite(startsAt.getTime()) || (endsAt && !Number.isFinite(endsAt.getTime())) || (endsAt && endsAt <= startsAt)) throw new AppError('Enter valid dates with the end after the start.', 422, 'PROMOTION_DATE_INVALID');
  if (endsAt && endsAt <= now) throw new AppError(activating ? 'This promotion has ended and cannot be activated.' : 'The end date must be in the future.', activating ? 409 : 422, activating ? 'PROMOTION_WINDOW_ENDED' : 'PROMOTION_DATE_INVALID');
  return { startsAt, endsAt };
}

async function validateOffer(store, input, session) {
  if (input.type === 'voucher' && !/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(input.code)) throw new AppError('Enter a coupon code with 2–40 letters, numbers, hyphens or underscores.', 422, 'PROMOTION_CODE_REQUIRED');
  if (input.type === 'voucher') await assertSellerCouponCodeAvailable(store, input.code, session);
  if (discountTypes.has(input.type) && !input.discountBps && !input.fixedDiscountMinor) throw new AppError('Enter a percentage or fixed discount.', 422, 'PROMOTION_DISCOUNT_REQUIRED');
  if (!discountTypes.has(input.type) && (input.discountBps || input.fixedDiscountMinor)) throw new AppError('Delivery and sponsored offers do not use a price discount.', 422, 'PROMOTION_DISCOUNT_INVALID');
  if (input.type === 'bundle' && input.productPublicIds.length < 2) throw new AppError('Choose at least two products for a bundle.', 422, 'PROMOTION_PRODUCTS_REQUIRED');
  if (input.type === 'quantity_break' && input.minQuantity < 2) throw new AppError('A quantity offer needs a minimum quantity of at least two.', 422, 'PROMOTION_QUANTITY_INVALID');
  if (input.type === 'sponsored' && (!input.productPublicIds.length || input.disclosureText.length < 3)) throw new AppError('Choose products and enter a clear sponsored placement disclosure.', 422, 'PROMOTION_DISCLOSURE_REQUIRED');
  const eligible = { storeId: store._id, countries: store.country, status: { $in: ['approved', 'published'] } };
  const products = await Product.find({ ...eligible, ...(input.productPublicIds.length ? { publicId: { $in: input.productPublicIds } } : {}) }).select('_id publicId').session(session).lean();
  if (input.productPublicIds.length && products.length !== input.productPublicIds.length) throw new AppError('Choose approved or published products sold by this store in its country.', 422, 'PROMOTION_PRODUCT_INVALID');
  if (!discountTypes.has(input.type) && !input.productPublicIds.length) return;
  const variants = await ProductVariant.find({ storeId: store._id, productId: { $in: products.map(product => product._id) }, currency: store.currency, active: true }).select('productId sku priceMinor minimumPriceMinor').session(session).lean();
  if (!variants.length) throw new AppError('Choose products with an active variant in your store currency.', 422, 'PROMOTION_PRODUCTS_REQUIRED');
  if (input.productPublicIds.length && products.some(product => !variants.some(variant => String(variant.productId) === String(product._id)))) throw new AppError('Every selected product needs an active variant in your store currency.', 422, 'PROMOTION_PRODUCT_INVALID');
  if (!discountTypes.has(input.type)) return;
  for (const variant of variants) {
    const discount = Math.max(input.fixedDiscountMinor, Math.floor(variant.priceMinor * input.discountBps / 10000));
    if (Math.max(0, variant.priceMinor - discount) < Number(variant.minimumPriceMinor || 0)) throw new AppError(`This discount would price ${variant.sku} below its minimum selling price.`, 409, 'MINIMUM_PRICE_VIOLATION');
  }
}

export async function createGrowthPromotion(request, raw, coupon = false) {
  const input = promotionSchema.parse({ ...raw, ...(coupon ? { type: 'voucher' } : {}) });
  if (!coupon && input.type === 'voucher') throw new AppError('Create voucher codes on the Coupons page.', 422, 'PROMOTION_TYPE_INVALID');
  input.code = coupon ? input.code.toUpperCase() : '';
  const window = dates(input, { activating: input.status === 'active' });
  let row;
  try {
    row = await transaction(async session => {
      const store = await lockStore(request, 'growth', session);
      await validateOffer(store, input, session);
      const [created] = await SellerPromotion.create([{ ...input, ...window, publicId: publicId('spr'), ...scope(store), storePublicId: store.publicId, createdByUserId: request.user._id }], { session });
      await writeAudit(request, coupon ? 'seller.coupon.created' : 'seller.promotion.created', { targetType: 'seller_promotion', targetPublicId: created.publicId, country: store.country, session, metadata: { type: created.type, storePublicId: store.publicId } });
      return created;
    });
  } catch (error) {
    if (error.code === 11000) throw new AppError('That coupon code is already in use.', 409, 'PROMOTION_CODE_EXISTS');
    throw error;
  }
  clearSponsoredOfferCache(request.store.country);
  return row;
}

export async function updateGrowthPromotionStatus(request, id, raw, coupon = false) {
  const input = z.object({ status: z.enum(['active', 'paused', 'expired']), version: integer(Number.MAX_SAFE_INTEGER) }).parse(raw);
  const row = await transaction(async session => {
    const store = await lockStore(request, 'growth', session);
    const promotion = await SellerPromotion.findOne({ publicId: id, ...scope(store), type: coupon ? 'voucher' : { $in: promotionTypes } }).session(session);
    if (!promotion) throw new AppError('Promotion not found.', 404, 'PROMOTION_NOT_FOUND');
    if (promotion.__v !== input.version) throw new AppError('This promotion changed. Refresh the page before updating it.', 409, 'PROMOTION_VERSION_CONFLICT');
    if (promotion.status === 'expired' || (input.status === 'paused' && promotion.status !== 'active') || promotion.status === input.status) throw new AppError('This status change is unavailable. Refresh the promotion.', 409, 'PROMOTION_STATUS_CONFLICT');
    if (input.status === 'active') {
      dates(promotion, { activating: true });
      await validateOffer(store, promotion.toObject(), session);
    }
    promotion.status = input.status;
    await promotion.save({ session });
    await writeAudit(request, coupon ? 'seller.coupon.status' : 'seller.promotion.status', { targetType: 'seller_promotion', targetPublicId: promotion.publicId, country: store.country, session, metadata: { status: input.status, storePublicId: store.publicId } });
    return promotion;
  });
  clearSponsoredOfferCache(request.store.country);
  return row;
}

export async function sellerPromotionsPage(request, coupon = false) {
  const { store, country } = await sellerAccess(request, 'growth');
  const date = value => day(value, country.timeZone);
  request.store = store;
  const now = new Date();
  const base = { ...scope(store), type: coupon ? 'voucher' : { $in: promotionTypes } };
  const selected = filters(request, promotionStatuses);
  const query = { ...base, ...(selected.status ? { status: selected.status } : {}), ...(selected.search ? { $or: [{ name: { $regex: regex(selected.search), $options: 'i' } }, { code: { $regex: regex(selected.search), $options: 'i' } }] } : {}) };
  const eligibleProductIds = await ProductVariant.distinct('productId', { storeId: store._id, currency: store.currency, active: true });
  const [found, total, counts, products] = await Promise.all([
    SellerPromotion.find(cursorScope(query, selected.after)).sort(cursorSort()).limit(LIMIT + 1).select('-createdByUserId -storeId').lean(),
    SellerPromotion.countDocuments(query),
    SellerPromotion.aggregate([{ $match: base }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Product.find({ _id: { $in: eligibleProductIds }, storeId: store._id, countries: store.country, status: { $in: ['approved', 'published'] } }).select('publicId title -_id').sort({ title: 1, _id: 1 }).limit(200).lean(),
  ]);
  const paged = pageResult(found, { limit: LIMIT, total });
  const promotions = paged.items.map(({ _id, ...row }) => ({ ...row, effectiveStatus: effectiveStatus(row, now), discountLabel: discountLabel(row) }));
  const summary = Object.fromEntries(counts.map(row => [row._id, row.count]));
  const all = Object.values(summary).reduce((sum, value) => sum + value, 0);
  const domain = coupon ? 'coupons' : 'promotions', path = `/seller/${domain}`;
  return {
    kind: 'growth', domain, store: publicStore(store), country: store.country, currency: store.currency, path, filters: selected, page: paged.page, promotions, products,
    columns: coupon ? ['Coupon', 'Discount', 'Minimum order', 'Validity', 'Status'] : ['Promotion', 'Type', 'Offer', 'Validity', 'Status'],
    rows: promotions.map(row => ({ id: row.publicId, cells: coupon ? [row.code + ' · ' + row.name, row.discountLabel, money(row.minSubtotalMinor, store.currency), `${date(row.startsAt)} – ${date(row.endsAt)}`, row.effectiveStatus] : [row.name, label(row.type), row.discountLabel, `${date(row.startsAt)} – ${date(row.endsAt)}`, row.effectiveStatus], href: `#promotion-${encodeURIComponent(row.publicId)}` })),
    metrics: [{ label: coupon ? 'Total coupons' : 'Total promotions', value: String(all), detail: 'Stored offers for this store' }, { label: 'Active', value: String(summary.active || 0), detail: 'Includes scheduled offers' }, { label: 'Drafts', value: String(summary.draft || 0), detail: 'Ready for your review' }, { label: 'Paused', value: String(summary.paused || 0), detail: 'Excluded from checkout' }],
    create: { label: coupon ? 'Create Coupon' : 'Create Promotion', href: `${path}#sellerGrowthEditor` },
    insights: [{ text: 'Review eligibility and minimum prices before activating an offer.', href: '/seller/products', label: 'View Products' }],
    health: { value: all ? Math.round((summary.active || 0) * 100 / all) : null, label: 'Offer activity', rows: [{ label: 'Active offers', value: String(summary.active || 0) }, { label: 'Expired offers', value: String(summary.expired || 0) }, { label: 'Store market', value: `${store.country} · ${store.currency}` }] },
    workflow: [{ title: 'Choose an offer', text: 'Set the products, discount and eligibility for your store.', href: `${path}#sellerGrowthEditor`, label: 'Create Offer' }, { title: 'Check selling prices', text: 'Active product variants must stay above their stored minimum prices.', href: '/seller/products', label: 'View Products' }, { title: 'Control availability', text: 'Activate, pause or end an offer using the controls below.', href: `${path}#sellerGrowthStatuses`, label: 'Manage Offers' }],
  };
}

export async function requestSellerSubscription(request, raw) {
  return requestReviewedSellerSubscription(request, raw);
}

export async function sellerSubscriptionPage(request) {
  const { store, country } = await sellerOperationsAccess(request, 'staff', { allowSuspended: true });
  const date = value => day(value, country.timeZone);
  request.store = store;
  const base = { audience: 'seller', ...scope(store) };
  const selected = filters(request, ['requested', 'approved', 'rejected', 'cancelled']);
  const query = { ...base, ...(selected.status ? { status: selected.status } : {}), ...(selected.search ? { $or: [{ publicId: { $regex: regex(selected.search), $options: 'i' } }, { planPublicId: { $regex: regex(selected.search), $options: 'i' } }, { note: { $regex: regex(selected.search), $options: 'i' } }] } : {}) };
  const [plans, enrollment, history, total, pending] = await Promise.all([
    SubscriptionPlan.find({ audience: 'seller', country: store.country, currency: store.currency, status: 'active' }).select('publicId name description priceMinor cadence features entitlements').sort({ sortOrder: 1, priceMinor: 1, _id: 1 }).lean(),
    SubscriptionEnrollment.findOne({ ...base, status: { $in: ['trialing', 'active'] }, startsAt: { $lte: new Date() }, $and: [{ $or: [{ currentPeriodEndsAt: { $gt: new Date() } }, { currentPeriodEndsAt: null }] }, { $or: [{ priceMinor: 0 }, { subscriptionChargeId: { $exists: true } }] }] }).populate({ path: 'planId', match: { audience: 'seller', country: store.country, currency: store.currency }, select: 'name features' }).sort({ createdAt: -1, _id: -1 }).lean(),
    SubscriptionChangeRequest.find(cursorScope(query, selected.after)).populate({ path: 'planId', match: { audience: 'seller', country: store.country, currency: store.currency }, select: 'name' }).sort(cursorSort()).limit(LIMIT + 1).lean(),
    SubscriptionChangeRequest.countDocuments(query), SubscriptionChangeRequest.countDocuments({ ...base, status: 'requested' }),
  ]);
  const paged = pageResult(history, { limit: LIMIT, total });
  const operations = await sellerSubscriptionOperationsPage(request);
  const sanitizeEnrollment = row => row ? { publicId: row.publicId, planPublicId: row.planPublicId, planName: row.terms?.name || row.planId?.name || row.planPublicId, features: row.terms ? Object.entries(row.terms.entitlements).map(([key, value]) => `${key}: ${value}`) : [], entitlements: row.terms?.entitlements, priceMinor: row.priceMinor, status: row.status, startsAt: row.startsAt, currentPeriodEndsAt: row.currentPeriodEndsAt, cancelledAt: row.cancelledAt } : null;
  const changeRequests = paged.items.map(row => ({ publicId: row.publicId, planPublicId: row.planPublicId, planName: row.terms?.name || row.planId?.name || row.planPublicId, requestedPriceMinor: row.requestedPriceMinor, requestedCadence: row.requestedCadence, status: row.status, note: row.note, reviewReason: row.reviewReason, createdAt: row.createdAt, reviewedAt: row.reviewedAt }));
  const current = sanitizeEnrollment(enrollment);
  return {
    ...operations, kind: 'growth', domain: 'subscription', store: publicStore(store), country: store.country, currency: store.currency, path: '/seller/subscription', plans: plans.map(({ _id, ...plan }) => plan), enrollment: current, enrollmentHistory: [], changeRequests, pendingRequests: pending,
    filters: selected, page: paged.page, columns: ['Plan request', 'Price', 'Billing cycle', 'Requested', 'Status'],
    rows: changeRequests.map(row => ({ id: row.publicId, cells: [row.planName, money(row.requestedPriceMinor, store.currency), label(row.requestedCadence), date(row.createdAt), label(row.status)], href: `#request-${encodeURIComponent(row.publicId)}` })),
    metrics: [{ label: 'Current plan', value: current?.planName || 'No plan', detail: current ? label(current.status) : 'No enrollment recorded' }, { label: 'Plan price', value: current ? money(current.priceMinor, store.currency) : '—', detail: 'Stored enrollment price' }, { label: 'Available plans', value: String(plans.length), detail: `${store.country} · ${store.currency}` }, { label: 'Pending requests', value: String(pending), detail: 'Awaiting independent review' }],
    create: { label: 'Compare Plans', href: '/seller/subscription#sellerGrowthEditor' },
    insights: [{ text: 'A change request goes to review. Activation follows approval and payment.', href: '/seller/subscription#sellerGrowthEditor', label: 'Compare Plans' }],
    health: { value: null, label: 'Subscription status', rows: [{ label: 'Enrollment', value: current ? label(current.status) : 'No enrollment' }, { label: 'Period ends', value: current?.currentPeriodEndsAt ? date(current.currentPeriodEndsAt) : 'Not recorded' }, { label: 'Pending changes', value: String(pending) }] },
    workflow: [{ title: 'Compare available plans', text: 'Review the actual prices and benefits available for your market.', href: '/seller/subscription#sellerGrowthEditor', label: 'Compare Plans' }, { title: 'Request a change', text: 'Submit one request for independent review.', href: '/seller/subscription#sellerGrowthEditor', label: 'Request Change' }, { title: 'Follow the decision', text: 'Your current enrollment stays in place until approval and payment.', href: '/seller/subscription#sellerSubscriptionHistory', label: 'View History' }],
  };
}

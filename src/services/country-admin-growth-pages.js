import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { ApprovalRequest, Campaign, Category, CmsContent, Coupon, CountrySetting, MarketingCampaign, PlatformGrant, Product, SellerPromotion, Store, StoreMember, User } from '../models/index.js';
import { countryAdminAccess, assertCountryAdminReadAccess, countryAdminPublicContext } from './country-admin-workspace-access.js';
import { writeAudit } from './audit.js';
import { addOutboxEvent } from './outbox.js';
import { optionalProcessingUser, restrictedOptionalUserIds } from './optional-processing.js';
import { cursorScope, cursorSort, decodeCursor, encodeCursor, pageResult } from './pagination.js';
import { clearSponsoredOfferCache } from './seller-growth.js';
import { assertSellerCapacity } from './seller-entitlements.js';
import { sellerConflict } from './seller-operations-access.js';

const SIZE = 25;
const MARKETPLACE_ROLES = ['customer', 'seller', 'business', 'promoter', 'delivery'];
const label = value => String(value || '').replaceAll('_', ' ');
const int = (max = 2_000_000_000) => z.coerce.number().int().min(0).max(max);
const text = max => z.string().trim().max(max);
const list = max => z.union([z.string(), z.array(z.string())]).optional().default('').transform(value => [...new Set((Array.isArray(value) ? value : value.split(/[\s,]+/)).filter(Boolean))]).refine(value => value.length <= max && value.every(item => /^[a-zA-Z0-9_.-]{1,100}$/.test(item)), 'Choose valid references.');
const couponSchema = z.object({ country: z.string().regex(/^[A-Z]{2}$/), code: text(32).min(3).regex(/^[A-Za-z0-9_-]+$/).transform(value => value.toUpperCase()), name: text(140).min(2), description: text(500).default(''),
  scope: z.enum(['platform', 'seller']).default('platform'), storePublicId: text(100).default(''), discountType: z.enum(['percent', 'fixed', 'free_shipping']), discountBps: int(9000).default(0), discountMinor: int().default(0),
  minimumSubtotalMinor: int().default(0), maximumDiscountMinor: int().default(0), usageLimit: int(1_000_000).default(0), perUserLimit: int(1000).default(1), eligibleRoles: list(5), eligibleCategoryPublicIds: list(100), eligibleStorePublicIds: list(100),
  firstOrderOnly: z.union([z.boolean(), z.string()]).optional().transform(value => value === true || value === 'on' || value === 'true'), startsAt: text(40).default(''), endsAt: text(40).default(''), status: z.enum(['draft', 'active']).default('draft') });
const messagingSchema = z.object({ country: z.string().regex(/^[A-Z]{2}$/), name: text(160).min(2), subject: text(180).min(2), body: text(10000).min(3), roles: list(5), scheduledAt: text(40).default('') });
const cmsSchema = z.object({ country: z.string().regex(/^[A-Z]{2}$/), key: text(120).min(3), type: z.enum(['hero', 'press', 'help']), title: text(180).min(2), body: text(20000).min(3),
  image: text(800).default(''), eyebrow: text(100).default(''), category: text(100).default(''), action: text(100).default(''), readTime: text(60).default(''), reason: text(1000).min(3), version: int(Number.MAX_SAFE_INTEGER).optional() });

async function transaction(work) { const session = await mongoose.startSession(); try { let result; await session.withTransaction(async () => { result = await work(session); }); return result; } finally { await session.endSession(); } }
function mutationCountry(raw) { if (typeof raw.country !== 'string' || !/^[A-Z]{2}$/.test(raw.country)) throw new AppError('Choose the country for this change.', 422, 'COUNTRY_ADMIN_COUNTRY_REQUIRED'); return raw.country; }
function version(row, raw) { const expected = int(Number.MAX_SAFE_INTEGER).parse(raw.version); if ((row.__v || 0) !== expected) throw new AppError('This record changed. Reload before saving.', 409, 'COUNTRY_ADMIN_VERSION_CONFLICT'); }
function date(value, name) {
  if (!value) return undefined;
  // The forms explicitly label these values UTC. A datetime-local value has no
  // zone, so do not let the server's host timezone change the requested instant.
  const source = String(value), localUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(source);
  const parsed = new Date(localUtc ? source + 'Z' : source);
  if ((!localUtc && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(source)) || !Number.isFinite(parsed.getTime())
    || (localUtc && parsed.toISOString().slice(0, 16) !== source.slice(0, 16))) throw new AppError(`Enter a valid ${name}.`, 422, 'GROWTH_DATE_INVALID');
  return parsed;
}
function window(input) { const startsAt = date(input.startsAt, 'start date') || new Date(); const endsAt = date(input.endsAt, 'end date'); if (endsAt && (endsAt <= startsAt || endsAt <= new Date())) throw new AppError('The end date must follow the start and be in the future.', 422, 'GROWTH_DATE_INVALID'); return { startsAt, endsAt }; }
function audit(request, action, row, session, metadata = {}) { return writeAudit(request, 'country_admin.' + action, { targetType: row instanceof Coupon ? 'coupon' : row instanceof MarketingCampaign ? 'marketing_campaign' : row instanceof Campaign ? 'campaign' : row instanceof ApprovalRequest ? 'approval' : 'cms', targetPublicId: row.publicId, country: row.country, session, metadata }); }

async function validateCoupon(input, context, session) {
  if (await SellerPromotion.exists({ code: input.code, type: 'voucher', country: context.country }).session(session)) throw new AppError('That code belongs to a seller voucher.', 409, 'COUPON_CODE_EXISTS');
  if (input.eligibleRoles.some(role => !MARKETPLACE_ROLES.includes(role))) throw new AppError('Only marketplace roles can receive a country coupon.', 422, 'COUPON_ROLE_INVALID');
  if ((input.discountType === 'percent' && (!input.discountBps || input.discountMinor)) || (input.discountType === 'fixed' && (!input.discountMinor || input.discountBps)) || (input.discountType === 'free_shipping' && (input.discountBps || input.discountMinor))) throw new AppError('Set one discount matching the selected type.', 422, 'COUPON_DISCOUNT_INVALID');
  let store;
  if (input.scope === 'seller') { store = await Store.findOne({ publicId: input.storePublicId, country: context.country, currency: context.currency, status: 'verified' }).session(session); if (!store) throw new AppError('Choose a verified seller in this country.', 422, 'COUPON_STORE_INVALID');
    const owner = await User.findOne({ _id: store.ownerUserId, role: 'seller', status: 'active' }).session(session); if (!owner) throw new AppError('This seller is unavailable.', 409, 'COUPON_STORE_INVALID');
    await Store.updateOne({ _id: store._id, __v: store.__v || 0, status: 'verified', country: context.country }, { $inc: { __v: 1 } }, { session });
    if (input.eligibleStorePublicIds.some(id => id !== store.publicId)) throw new AppError('A seller coupon must stay within its selected store.', 422, 'COUPON_STORE_INVALID');
  } else if (input.storePublicId) throw new AppError('Platform coupons cannot name a seller owner.', 422, 'COUPON_STORE_INVALID');
  if (input.eligibleStorePublicIds.length && await Store.countDocuments({ publicId: { $in: input.eligibleStorePublicIds }, country: context.country, currency: context.currency, status: 'verified' }).session(session) !== input.eligibleStorePublicIds.length) throw new AppError('All coupon stores must be verified in this country.', 422, 'COUPON_STORE_INVALID');
  if (input.eligibleCategoryPublicIds.length && await Category.countDocuments({ publicId: { $in: input.eligibleCategoryPublicIds }, active: true, $or: [{ countries: context.country }, { countries: { $size: 0 } }] }).session(session) !== input.eligibleCategoryPublicIds.length) throw new AppError('All coupon categories must be available in this country.', 422, 'COUPON_CATEGORY_INVALID');
  return { ...input, ...window(input), country: context.country, currency: context.currency, storeId: store?._id, storePublicId: store?.publicId || '' };
}
export async function createCountryCoupon(request, raw) {
  const input = couponSchema.parse(raw);
  try { return await transaction(async session => { const context = await countryAdminAccess(request, { session, write: true, country: input.country }); const values = await validateCoupon(input, context, session); const [row] = await Coupon.create([{ ...values, publicId: publicId('cpn'), createdByUserId: context.actor._id, updatedByUserId: context.actor._id }], { session }); await audit(request, 'coupon_created', row, session); return couponDto(row); }); }
  catch (error) { if (error.code === 11000) throw new AppError('That coupon code is already in use.', 409, 'COUPON_CODE_EXISTS'); throw error; }
}
export async function updateCountryCoupon(request, id, raw) {
  const input = couponSchema.parse(raw);
  return transaction(async session => { const context = await countryAdminAccess(request, { session, write: true, country: input.country }); const row = await Coupon.findOne({ publicId: id, country: context.country, currency: context.currency }).session(session); if (!row) throw new AppError('Coupon not found.', 404, 'COUPON_NOT_FOUND'); version(row, raw);
    if (!['draft', 'paused'].includes(row.status)) throw new AppError('Pause this coupon before editing it.', 409, 'COUPON_STATE'); if (row.code !== input.code || row.scope !== input.scope || row.storePublicId !== input.storePublicId) throw new AppError('Coupon ownership and code cannot be changed.', 409, 'COUPON_IDENTITY_LOCKED');
    if (input.usageLimit && input.usageLimit < row.usageCount) throw new AppError('The usage limit cannot be below recorded uses.', 422, 'COUPON_USAGE_LIMIT'); Object.assign(row, await validateCoupon(input, context, session), { status: row.status, updatedByUserId: context.actor._id }); await row.save({ session }); await audit(request, 'coupon_updated', row, session, { version: row.__v }); return couponDto(row); });
}
export async function changeCountryCouponStatus(request, id, raw) {
  const status = z.enum(['active', 'paused', 'archived']).parse(raw.status);
  return transaction(async session => { const context = await countryAdminAccess(request, { session, write: true, country: mutationCountry(raw) }); const row = await Coupon.findOne({ publicId: id, country: context.country, currency: context.currency }).session(session); if (!row) throw new AppError('Coupon not found.', 404, 'COUPON_NOT_FOUND'); version(row, raw);
    if (!['draft', 'active', 'paused'].includes(row.status) || row.status === status || (status === 'paused' && row.status !== 'active')) throw new AppError('This coupon status change is unavailable.', 409, 'COUPON_STATE');
    if (status === 'active') { await validateCoupon({ ...row.toObject(), startsAt: row.startsAt?.toISOString(), endsAt: row.endsAt?.toISOString() }, context, session); if (row.usageLimit && row.usageCount >= row.usageLimit) throw new AppError('This coupon has reached its usage limit.', 409, 'COUPON_USAGE_LIMIT'); }
    row.status = status; row.updatedByUserId = context.actor._id; await row.save({ session }); await audit(request, 'coupon_status_changed', row, session, { status, version: row.__v }); return couponDto(row); });
}

function couponDto(row) { return { publicId: row.publicId, version: row.__v || 0, country: row.country, currency: row.currency, code: row.code, name: row.name, description: row.description, scope: row.scope, storePublicId: row.storePublicId,
  status: row.status, discountType: row.discountType, discountBps: row.discountBps, discountMinor: row.discountMinor, minimumSubtotalMinor: row.minimumSubtotalMinor, maximumDiscountMinor: row.maximumDiscountMinor, usageLimit: row.usageLimit, usageCount: row.usageCount, perUserLimit: row.perUserLimit,
  eligibleRoles: row.eligibleRoles, eligibleCategoryPublicIds: row.eligibleCategoryPublicIds, eligibleStorePublicIds: row.eligibleStorePublicIds, firstOrderOnly: row.firstOrderOnly, startsAt: row.startsAt, endsAt: row.endsAt }; }
function campaignDto(row) { return { publicId: row.publicId, version: row.__v || 0, country: row.country, name: row.name, subject: row.subject, body: row.body, roles: row.roles, status: row.status, scheduledAt: row.scheduledAt, startedAt: row.startedAt, completedAt: row.completedAt, eligibleCount: row.eligibleCount, queuedCount: row.queuedCount }; }
function affiliateDto(row) { return { publicId: row.publicId, version: row.__v || 0, country: row.country, name: row.name, status: row.status, scope: row.scope, systemManaged: row.systemManaged, facts: row.facts, productPublicIds: row.productPublicIds, disclosureText: row.disclosureText, reviewReason: row.reviewReason, startsAt: row.startsAt, endsAt: row.endsAt }; }
function contentDto(row, actorId) { return { publicId: row.publicId, version: row.__v || 0, country: row.country, key: row.key, type: row.type, status: row.status, activeVersion: row.activeVersion, scheduledVersion: row.scheduledVersion,
  revisions: row.revisions.map(revision => ({ version: revision.version, title: revision.title, body: revision.body, data: safeCmsData(revision.data), reason: revision.reason, createdAt: revision.createdAt, authoredByMe: String(revision.createdByUserId) === String(actorId), publishedAt: revision.publishedAt, scheduledFor: revision.scheduledFor })) }; }

export async function saveCountryMessagingCampaign(request, raw, id = '') {
  const input = messagingSchema.parse(raw); if (input.roles.some(role => !MARKETPLACE_ROLES.includes(role))) throw new AppError('Choose marketplace audience roles.', 422, 'CAMPAIGN_ROLE_INVALID');
  const scheduledAt = date(input.scheduledAt, 'schedule'); if (scheduledAt && scheduledAt <= new Date()) throw new AppError('Schedule the campaign for a future time.', 422, 'CAMPAIGN_SCHEDULE_INVALID');
  return transaction(async session => { const context = await countryAdminAccess(request, { session, write: true, country: input.country }); let row;
    if (id) { row = await MarketingCampaign.findOne({ publicId: id, country: context.country }).session(session); if (!row) throw new AppError('Campaign not found.', 404, 'CAMPAIGN_NOT_FOUND'); version(row, raw); if (!['draft', 'scheduled'].includes(row.status)) throw new AppError('This campaign can no longer be edited.', 409, 'CAMPAIGN_STATE'); }
    else row = new MarketingCampaign({ publicId: publicId('mkt'), createdByUserId: context.actor._id });
    Object.assign(row, input, { country: context.country, scheduledAt, status: scheduledAt ? 'scheduled' : 'draft', dispatchGrantPublicId: context.grant.publicId, dispatchActorUserId: context.actor._id, dispatchTokenVersion: context.actor.security.tokenVersion, dispatchStoredRole: context.storedRole }); await row.save({ session }); await audit(request, id ? 'campaign_updated' : 'campaign_created', row, session); return campaignDto(row); });
}
export async function cancelCountryMessagingCampaign(request, id, raw) {
  return transaction(async session => { const context = await countryAdminAccess(request, { session, write: true, country: mutationCountry(raw) }); const row = await MarketingCampaign.findOne({ publicId: id, country: context.country }).session(session); if (!row) throw new AppError('Campaign not found.', 404, 'CAMPAIGN_NOT_FOUND'); version(row, raw); if (!['draft', 'scheduled', 'running'].includes(row.status)) throw new AppError('This campaign can no longer be cancelled.', 409, 'CAMPAIGN_STATE'); row.status = 'cancelled'; await row.save({ session }); await audit(request, 'campaign_cancelled', row, session); return campaignDto(row); });
}
export async function queueCountryMessagingCampaign(request, id, raw) {
  return transaction(async session => { const context = await countryAdminAccess(request, { session, write: true, country: mutationCountry(raw) }); const row = await MarketingCampaign.findOne({ publicId: id, country: context.country }).session(session); if (!row) throw new AppError('Campaign not found.', 404, 'CAMPAIGN_NOT_FOUND'); version(row, raw); return campaignDto(await queueCurrentConsentCampaign(row, context, session, request)); });
}
export async function queueCurrentConsentCampaign(row, context, session, request) {
  if (!session?.inTransaction() || !context?.actor || !row.country || row.country !== context.country) throw new AppError('Campaign queueing requires current country authority.', 403, 'CAMPAIGN_AUTHORITY_REQUIRED');
  if (!['draft', 'scheduled'].includes(row.status)) throw new AppError('Campaign cannot be queued in its current state.', 409, 'CAMPAIGN_STATE'); if (row.scheduledAt && row.scheduledAt > new Date()) throw new AppError('Campaign is scheduled for a future time.', 409, 'CAMPAIGN_NOT_DUE');
  if (row.roles.some(role => !MARKETPLACE_ROLES.includes(role))) throw new AppError('The campaign audience is unavailable.', 409, 'CAMPAIGN_ROLE_INVALID');
  row.dispatchGrantPublicId = context.grant?.publicId || 'legacy:' + context.storedRole; row.dispatchActorUserId = context.actor._id; row.dispatchTokenVersion = context.actor.security.tokenVersion; row.dispatchStoredRole = context.storedRole; row.status = 'running'; row.startedAt = new Date(); row.eligibleCount = 0; row.queuedCount = 0;
  const restrictedIds = await restrictedOptionalUserIds({ session });
  let after; while (true) { const users = await User.find({ _id: { $nin: restrictedIds, ...(after ? { $gt: after } : {}) }, country: row.country, status: 'active', platformAccessManagedAt: null, emailVerifiedAt: { $type: 'date' }, 'consents.marketing': true, role: { $in: row.roles.length ? row.roles : MARKETPLACE_ROLES } }).select('_id publicId __v').sort({ _id: 1 }).limit(SIZE).session(session).lean();
    for (const user of users) { const current = await User.updateOne({ _id: user._id, status: 'active', country: row.country, platformAccessManagedAt: null, 'consents.marketing': true, __v: user.__v || 0 }, { $inc: { __v: 1 } }, { session }); if (current.modifiedCount !== 1) throw new AppError('Campaign audience changed. Queue it again.', 409, 'CAMPAIGN_AUDIENCE_CHANGED'); await addOutboxEvent({ type: 'marketing.campaign_message', aggregateType: 'marketing_campaign', aggregatePublicId: row.publicId, payload: { userPublicId: user.publicId, country: row.country, campaignVersion: (row.__v || 0) + 1, consentBasis: 'marketing' } }, session); row.eligibleCount++; row.queuedCount++; }
    if (users.length < SIZE) break; after = users.at(-1)._id;
  }
  if (!row.queuedCount) { row.status = 'completed'; row.completedAt = new Date(); } row.increment(); await row.save({ session }); await audit(request, 'campaign_queued', row, session, { queuedCount: row.queuedCount }); return row;
}

/** Background dispatch uses the immutable creator grant and checks current audience consent. */
export async function marketingDispatchAuthority(row, session = null) {
  if (!row.dispatchActorUserId || !row.dispatchGrantPublicId || !/^[A-Z]{2}$/.test(row.country)) return null;
  const actor = await User.findOne({ _id: row.dispatchActorUserId, status: 'active', role: row.dispatchStoredRole || 'country_admin', 'security.tokenVersion': row.dispatchTokenVersion }).session(session);
  if (!actor) return null;
  try {
    const { currentAdministrativeAuthority } = await import('./stage9.js');
    const context = row.dispatchGrantPublicId.startsWith('legacy:')
      ? await currentAdministrativeAuthority(actor, { country: row.country, session })
      : await countryAdminAccess({ user: actor, query: { country: row.country }, requiredOperationalWorkspace: 'admin' }, { country: row.country, session, write: Boolean(session) });
    const grantPublicId = context.grant?.publicId || 'legacy:' + context.storedRole;
    return grantPublicId === row.dispatchGrantPublicId ? context : null;
  } catch(error) { if ([401,403,409].includes(error.status)) return null; throw error; }
}
export async function prepareMarketingCampaignDelivery(event) {
  const row = await MarketingCampaign.findOne({ publicId: event.aggregatePublicId, country: event.payload?.country, status: 'running' }).lean(); if (!row || (row.__v || 0) !== event.payload?.campaignVersion || !await marketingDispatchAuthority(row)) return null;
  const user = await User.findOne({ publicId: event.payload?.userPublicId, country: row.country, status: 'active', platformAccessManagedAt: null, emailVerifiedAt: { $type: 'date' }, 'consents.marketing': true, role: { $in: row.roles.length ? row.roles : MARKETPLACE_ROLES } }).select('_id email').lean(); const allowed = user ? await optionalProcessingUser(user._id, { marketing: true }) : null; return allowed ? { email: allowed.email, subject: row.subject, text: row.body } : null;
}

export async function decideCountryAffiliateCampaign(request, id, raw) {
  const status = z.enum(['active', 'rejected', 'paused', 'ended']).parse(raw.status), reason = text(500).min(3).parse(raw.reason);
  const result = await transaction(async session => { const context = await countryAdminAccess(request, { session, write: true, country: mutationCountry(raw) }); const row = await Campaign.findOne({ publicId: id, country: context.country, scope: 'seller', systemManaged: false }).session(session); if (!row) throw new AppError('Seller campaign not found.', 404, 'CAMPAIGN_NOT_FOUND'); version(row, raw);
    const transitions = { submitted: ['active', 'rejected'], active: ['paused', 'ended'], paused: ['active', 'ended'] }; if (!transitions[row.status]?.includes(status)) throw new AppError('This campaign decision is unavailable.', 409, 'CAMPAIGN_STATE');
    const store = await Store.findOne({ _id: row.storeId, ownerUserId: row.ownerUserId, country: context.country, status: 'verified' }).session(session); const owner = await User.findOne({ _id: row.ownerUserId, role: 'seller', status: 'active', platformAccessManagedAt: null }).session(session); if (!store || !owner || await PlatformGrant.exists({ userId: row.ownerUserId }).session(session)) throw new AppError('The campaign seller is unavailable.', 409, 'CAMPAIGN_SELLER_UNAVAILABLE');
    if ([row.ownerUserId, row.createdByUserId, row.submittedByUserId].some(id => id && String(id) === String(context.actor._id)) || await StoreMember.exists({storeId: store._id, userId: context.actor._id, status: {$in: ['active', 'invited']}}).session(session)) throw new AppError('An independent Country Admin must review this seller campaign.', 403, 'CAMPAIGN_REVIEW_CONFLICT');
    if (status === 'active') {
      if (row.endsAt && row.endsAt <= new Date()) throw new AppError('This campaign has ended.', 409, 'CAMPAIGN_WINDOW_ENDED');
      await assertSellerCapacity(store, 'campaigns', { session, excludeId: row._id });
      const products = await Product.find({ publicId: { $in: row.productPublicIds }, storeId: store._id, ownerUserId: store.ownerUserId, countries: context.country, status: { $in: ['approved', 'published'] } }).session(session);
      if (!products.length || row.productPublicIds.length !== products.length) throw new AppError('Every campaign product must be approved for this seller and country.', 409, 'CAMPAIGN_PRODUCT_UNAVAILABLE');
      for (const product of products) { const fenced = await Product.updateOne({ _id: product._id, __v: product.__v || 0, status: product.status }, { $inc: { __v: 1 } }, { session }); if (fenced.modifiedCount !== 1) throw sellerConflict(); }
      if (row.assets.some(asset => asset.url && !safeCmsUrl(asset.url))) throw new AppError('Campaign assets need safe marketplace URLs.', 409, 'CAMPAIGN_ASSET_UNAVAILABLE');
    }
    const storeFence = await Store.updateOne({ _id: store._id, __v: store.__v || 0 }, { $inc: { __v: 1 } }, { session });
    const ownerFence = await User.updateOne({ _id: owner._id, __v: owner.__v || 0, role: 'seller', status: 'active' }, { $inc: { __v: 1 } }, { session });
    if (storeFence.modifiedCount !== 1 || ownerFence.modifiedCount !== 1) throw sellerConflict();
    row.status = status; row.pausedBySeller = false; row.reviewedAt = new Date(); row.reviewedByUserId = context.actor._id; row.reviewReason = reason; if (status === 'active') for (const asset of row.assets) asset.approved = true; await row.save({ session }); await audit(request, 'affiliate_campaign_decided', row, session, { status }); return affiliateDto(row); }); clearSponsoredOfferCache(result.country); return result;
}

export function safeCmsUrl(value) { if (typeof value !== 'string') return ''; const input = value.trim(); return /^\/(?:assets\/|media\/)[A-Za-z0-9_./%-]+$/.test(input) && !input.includes('..') && !input.includes('//') && !/%(?:2f|5c|2e)/i.test(input) ? input : ''; }
export function safeCmsData(data = {}) { if (!data || typeof data !== 'object' || Array.isArray(data)) return {}; const result = {}; for (const key of ['eyebrow', 'category', 'action', 'readTime']) if (typeof data[key] === 'string') result[key] = data[key].slice(0, key === 'readTime' ? 60 : 100); if (safeCmsUrl(data.image)) result.image = safeCmsUrl(data.image); return result; }
export function cmsRevisionDigest(revision) { return crypto.createHash('sha256').update(JSON.stringify({ version: revision.version, title: revision.title, body: revision.body, data: safeCmsData(revision.data), author: String(revision.createdByUserId), reason: revision.reason })).digest('hex'); }
function validateCmsKey(input) { if (!((input.type === 'hero' && /^home\.hero\.[a-z0-9][a-z0-9_-]{0,80}$/.test(input.key)) || (input.type === 'press' && /^press\.article\.[a-z0-9][a-z0-9_-]{0,80}$/.test(input.key)) || (input.type === 'help' && input.key === 'help.main'))) throw new AppError('Choose a country homepage slide, press article or help page. Policy content requires Super Admin.', 403, 'CMS_KEY_FORBIDDEN'); if (input.image && !safeCmsUrl(input.image)) throw new AppError('Choose an image from marketplace assets or media.', 422, 'CMS_URL_INVALID'); }
export async function saveCountryCmsRevision(request, raw) {
  const input = cmsSchema.parse(raw); validateCmsKey(input);
  return transaction(async session => { const context = await countryAdminAccess(request, { session, write: true, country: input.country }); let row = await CmsContent.findOne({ key: input.key, country: context.country }).session(session); if (row) { version(row, raw); if (row.type !== input.type) throw new AppError('Content type cannot be changed.', 409, 'CMS_TYPE_LOCKED'); if (row.scheduledVersion) throw new AppError('Cancel or publish the scheduled revision before adding a draft.', 409, 'CMS_SCHEDULE_PENDING'); } else { if (input.version !== undefined) throw new AppError('This content changed. Reload it.', 409, 'CMS_VERSION_CONFLICT'); row = new CmsContent({ publicId: publicId('cms'), key: input.key, type: input.type, country: context.country }); }
    const revisionVersion = Math.max(0, ...row.revisions.map(revision => revision.version)) + 1; row.revisions.push({ version: revisionVersion, title: input.title, body: input.body, data: safeCmsData(input), reason: input.reason, createdByUserId: context.actor._id }); row.status = row.activeVersion ? 'published' : 'draft'; await row.save({ session }); await audit(request, 'cms_revision_created', row, session, { version: revisionVersion }); return { content: contentDto(row, context.actor._id), version: revisionVersion }; });
}
export async function requestCountryCmsPublication(request, id, raw) {
  const revisionVersion = int(Number.MAX_SAFE_INTEGER).min(1).parse(raw.revisionVersion), reason = text(1000).min(3).parse(raw.reason), action = z.enum(['publish', 'rollback']).parse(raw.action), scheduledFor = date(raw.scheduledFor, 'publication schedule');
  if (scheduledFor && scheduledFor <= new Date()) throw new AppError('Choose a future publication schedule.', 422, 'CMS_SCHEDULE_INVALID'); if (action === 'rollback' && scheduledFor) throw new AppError('Rollback cannot be scheduled.', 422, 'CMS_SCHEDULE_INVALID');
  return transaction(async session => { const context = await countryAdminAccess(request, { session, write: true, country: mutationCountry(raw) }); const row = await CmsContent.findOne({ publicId: id, country: context.country }).session(session); if (!row) throw new AppError('Content not found.', 404, 'CMS_NOT_FOUND'); version(row, raw); validateCmsKey(row);
    const revision = row.revisions.find(revision => revision.version === revisionVersion); if (!revision) throw new AppError('Revision not found.', 404, 'CMS_REVISION_NOT_FOUND'); if (row.scheduledVersion || row.activeVersion === revisionVersion || (action === 'rollback' && !revision.publishedAt)) throw new AppError('This publication request is unavailable.', 409, 'CMS_PUBLICATION_STATE');
    if (await ApprovalRequest.exists({ targetPublicId: row.publicId, status: 'requested', type: { $in: ['cms_publish', 'cms_rollback'] } }).session(session)) throw new AppError('This content already has a pending publication decision.', 409, 'CMS_APPROVAL_PENDING');
    row.increment(); await row.save({ session }); const [approval] = await ApprovalRequest.create([{ publicId: publicId('apr'), type: action === 'publish' ? 'cms_publish' : 'cms_rollback', country: context.country, targetType: 'cms', targetPublicId: row.publicId, payload: { version: revisionVersion, sourceVersion: row.__v, activeVersion: row.activeVersion, digest: cmsRevisionDigest(revision), scheduledFor: scheduledFor?.toISOString() || null }, reason, requestedByUserId: context.actor._id, requesterGrantPublicId: context.grant.publicId, requesterTokenVersion: context.actor.security.tokenVersion, requesterStoredRole: context.storedRole }], { session }); await audit(request, 'cms_publication_requested', approval, session, { version: revisionVersion }); return { publicId: approval.publicId, status: approval.status }; });
}
export async function applyCountryCmsApproval({ request, context, approval, session }) {
  if (!session?.inTransaction() || !request?.sessionID || !context?.actor || !approval.country || approval.country !== context.country) throw new AppError('CMS publication requires current country authority.', 403, 'CMS_AUTHORITY_REQUIRED');
  const row = await CmsContent.findOne({ publicId: approval.targetPublicId, country: approval.country }).session(session); if (!row) throw new AppError('Content not found.', 404, 'CMS_NOT_FOUND'); validateCmsKey(row);
  const revision = row.revisions.find(revision => revision.version === Number(approval.payload?.version)); if (!revision || (row.__v || 0) !== approval.payload?.sourceVersion || row.activeVersion !== approval.payload?.activeVersion || cmsRevisionDigest(revision) !== approval.payload?.digest || row.scheduledVersion) throw new AppError('Content changed after this publication request.', 409, 'CMS_SOURCE_CHANGED');
  if (String(approval.requestedByUserId) === String(context.actor._id) || String(revision.createdByUserId) === String(context.actor._id)) throw new AppError('A different administrator must approve the author’s revision.', 403, 'FOUR_EYES_REQUIRED');
  const requester = await User.findOne({ _id: approval.requestedByUserId, status: 'active', 'security.tokenVersion': approval.requesterTokenVersion }).session(session);
  if (!requester || !approval.requesterGrantPublicId) throw new AppError('The requesting administrator authorization changed.', 403, 'APPROVAL_REQUESTER_UNAVAILABLE');
  const { currentAdministrativeAuthority } = await import('./stage9.js');
  const requesterContext = await currentAdministrativeAuthority(requester, { country: approval.country, session });
  if (requesterContext.grant?.publicId !== approval.requesterGrantPublicId || requesterContext.storedRole !== approval.requesterStoredRole) throw new AppError('The requesting administrator authorization changed.', 403, 'APPROVAL_REQUESTER_UNAVAILABLE');
  if (approval.type === 'cms_rollback' && !revision.publishedAt) throw new AppError('Rollback needs a previously published revision.', 409, 'CMS_ROLLBACK_INVALID');
  revision.approvalPublicId = approval.publicId; revision.approvedByUserId = context.actor._id; revision.approvedAt = new Date(); revision.dispatchGrantPublicId = context.grant.publicId; revision.dispatchTokenVersion = context.actor.security.tokenVersion;
  const scheduledFor = date(approval.payload.scheduledFor, 'publication schedule'); if (scheduledFor && scheduledFor > new Date()) { row.status = 'scheduled'; row.scheduledVersion = revision.version; revision.scheduledFor = scheduledFor; }
  else { row.activeVersion = revision.version; row.scheduledVersion = 0; row.status = 'published'; revision.publishedAt = new Date(); }
  await row.save({ session }); await audit(request, 'cms_approval_decided', row, session, { version: revision.version, status: row.status }); return { content: row.publicId, version: revision.version };
}
export async function cancelCountryCmsSchedule(request, id, raw) {
  const reason = text(1000).min(3).parse(raw.reason);
  return transaction(async session => {
    const context = await countryAdminAccess(request, { session, write: true, country: mutationCountry(raw) });
    const row = await CmsContent.findOne({ publicId: id, country: context.country }).session(session);
    if (!row) throw new AppError('Content not found.', 404, 'CMS_NOT_FOUND');
    version(row, raw); validateCmsKey(row);
    const revision = row.revisions.find(item => item.version === row.scheduledVersion);
    if (row.status !== 'scheduled' || !revision?.scheduledFor) throw new AppError('No scheduled publication remains to cancel.', 409, 'CMS_SCHEDULE_UNAVAILABLE');
    const scheduledVersion = row.scheduledVersion;
    row.scheduledVersion = 0; row.status = row.activeVersion ? 'published' : 'draft'; revision.scheduledFor = undefined;
    await row.save({ session }); await audit(request, 'cms_schedule_cancelled', row, session, { version: scheduledVersion, reason });
    return contentDto(row, context.actor._id);
  });
}
export async function decideCountryCmsApproval(request, id, raw) {
  const decision = z.enum(['approve', 'reject']).parse(raw.decision), reason = text(1000).min(3).parse(raw.reason);
  return transaction(async session => { const context = await countryAdminAccess(request, { session, write: true, country: mutationCountry(raw) }); const approval = await ApprovalRequest.findOne({ publicId: id, country: context.country, targetType: 'cms', type: { $in: ['cms_publish', 'cms_rollback'] }, status: 'requested' }).session(session); if (!approval) throw new AppError('Pending CMS approval not found.', 404, 'APPROVAL_NOT_FOUND'); version(approval, raw); if (String(approval.requestedByUserId) === String(context.actor._id)) throw new AppError('Another administrator must decide this request.', 403, 'FOUR_EYES_REQUIRED');
    const result = decision === 'approve' ? await applyCountryCmsApproval({ request, context, approval, session }) : { status: 'rejected' }; approval.status = decision === 'approve' ? 'applied' : 'rejected'; approval.decidedByUserId = context.actor._id; approval.decisionReason = reason; approval.decidedAt = new Date(); if (decision === 'approve') approval.appliedAt = new Date(); approval.increment(); await approval.save({ session }); await audit(request, 'cms_approval_decided', approval, session, { decision }); return result; });
}

function filters(request, pageId) { const input = z.object({ country: text(2).optional(), search: text(100).default(''), q: text(100).optional(), status: text(30).default(''), tab: z.enum(['messaging', 'affiliate']).default('messaging'), after: text(512).default(''), approvalsAfter: text(512).default(''), id: text(120).default('') }).parse(request.query || {}); if ([input.after,input.approvalsAfter].some(value => value && !decodeCursor(value))) throw new AppError('Invalid growth cursor.', 422, 'GROWTH_FILTER_INVALID');
  const statuses = pageId === 'admin-coupons' ? ['draft', 'active', 'paused', 'expired', 'archived'] : pageId === 'admin-content' ? ['draft', 'scheduled', 'published', 'archived'] : input.tab === 'affiliate' ? ['draft', 'submitted', 'active', 'rejected', 'paused', 'ended'] : ['draft', 'scheduled', 'running', 'completed', 'cancelled']; if (input.status && !statuses.includes(input.status)) throw new AppError('Invalid growth status.', 422, 'GROWTH_FILTER_INVALID'); return { ...input, search: input.q ?? input.search, statuses: [{ value: '', label: 'All statuses' }, ...statuses.map(value => ({ value, label: label(value) }))] }; }
function config(pageId, selected) { if (pageId === 'admin-coupons') return { Model: Coupon, path: '/admin/coupons', name: 'Coupons', fields: ['code', 'name'], columns: ['Coupon', 'Country', 'Discount', 'Uses', 'Status'], dto: couponDto, cells: row => [row.code + ' · ' + row.name, row.country, row.discountType === 'percent' ? row.discountBps / 100 + '%' : row.discountType === 'fixed' ? row.currency + ' ' + row.discountMinor : 'Free delivery', row.usageCount + (row.usageLimit ? '/' + row.usageLimit : ''), label(row.status)] };
  if (pageId === 'admin-content') return { Model: CmsContent, path: '/admin/content', name: 'Content', fields: ['key'], columns: ['Content key', 'Country', 'Type', 'Public version', 'Status'], dto: contentDto, cells: row => [row.key, row.country, row.type, String(row.activeVersion || 'Draft'), label(row.status)] };
  return { Model: selected.tab === 'affiliate' ? Campaign : MarketingCampaign, path: '/admin/campaigns', name: selected.tab === 'affiliate' ? 'Seller campaigns' : 'Consent campaigns', fields: ['name'], columns: ['Campaign', 'Country', selected.tab === 'affiliate' ? 'Type' : 'Queued recipients', 'Schedule', 'Status'], dto: selected.tab === 'affiliate' ? affiliateDto : campaignDto, cells: row => [row.name, row.country, selected.tab === 'affiliate' ? label(row.scope) : String(row.queuedCount), row.scheduledAt ? new Date(row.scheduledAt).toISOString() : 'Unscheduled', label(row.status)] }; }
function scopedQuery(context, selected, definition) { const query = { ...context.countryScope, ...(selected.status ? { status: selected.status } : {}) }; if (definition.Model === Coupon) query.$and = [{ $or: context.countries.filter(market => !context.country || market.code === context.country).map(market => ({ country: market.code, currency: market.currency })) }]; if (definition.Model === Campaign) Object.assign(query, { scope: 'seller', systemManaged: false }); if (definition.Model === CmsContent) query.type = { $in: ['hero', 'press', 'help'] }; if (selected.search) { const expression = new RegExp(selected.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); query.$or = definition.fields.map(field => ({ [field]: expression })); } return query; }
export async function loadCountryAdminGrowthPage(request, pageId) {
  if (!['admin-coupons', 'admin-campaigns', 'admin-content'].includes(pageId)) throw new AppError('Growth page not found.', 404, 'GROWTH_PAGE_NOT_FOUND');
  const context = await countryAdminAccess(request), selected = filters(request, pageId), definition = config(pageId, selected), query = scopedQuery(context, selected, definition);
  const [found, total, groups] = await Promise.all([definition.Model.find(cursorScope(query, selected.after)).sort(cursorSort()).limit(SIZE + 1).lean(), definition.Model.countDocuments(query), definition.Model.aggregate([{ $match: scopedQuery(context, { ...selected, status: '', search: '' }, definition) }, { $group: { _id: '$status', count: { $sum: 1 } } }])]);
  const paged = pageResult(found, { limit: SIZE, total }), items = paged.items.map(row => definition.dto(row, context.actor._id)), summary = Object.fromEntries(groups.map(row => [row._id, row.count]));
  let detail = null; if (selected.id) { const row = await definition.Model.findOne({ publicId: selected.id, ...query }).lean(); if (!row) throw new AppError('Growth record not found.', 404, 'GROWTH_RECORD_NOT_FOUND'); detail = definition.dto(row, context.actor._id); }
  let approvals = [], approvalsPage = { hasMore:false,next:'',count:0,total:0 };
  if (pageId === 'admin-content') {
    const approvalQuery = { ...context.countryScope, targetType:'cms', type:{$in:['cms_publish','cms_rollback']}, status:'requested' };
    const [rows,count] = await Promise.all([ApprovalRequest.find(cursorScope(approvalQuery,selected.approvalsAfter)).sort(cursorSort()).limit(SIZE+1).lean(),ApprovalRequest.countDocuments(approvalQuery)]);
    const result = pageResult(rows,{limit:SIZE,total:count}); approvalsPage=result.page;
    approvals=result.items.map(row=>({publicId:row.publicId,version:row.__v||0,country:row.country,targetPublicId:row.targetPublicId,type:row.type,revisionVersion:row.payload?.version,scheduledFor:row.payload?.scheduledFor,reason:row.reason,requestedByMe:String(row.requestedByUserId)===String(context.actor._id)}));
  }
  await assertCountryAdminReadAccess(request, context); const parameters = new URLSearchParams(); if (context.country) parameters.set('country', context.country); if (selected.tab === 'affiliate') parameters.set('tab', 'affiliate'); if (selected.status) parameters.set('status', selected.status); if (selected.search) parameters.set('search', selected.search);
  const href = id => definition.path + '?' + new URLSearchParams({ ...Object.fromEntries(parameters), id });
  return { kind: 'growth', pageId, domain: pageId.slice(6), context: countryAdminPublicContext(context), country: context.country, currency: context.currency, path: definition.path, filters: selected, tab: selected.tab, page: paged.page, items, selected: detail, approvals, approvalsPage, roles: MARKETPLACE_ROLES,
    columns: definition.columns, rows: items.map(row => ({ id: row.publicId, href: href(row.publicId), cells: definition.cells(row) })), exportHref: definition.path + '/export.csv?' + parameters,
    metrics: [{ label: definition.name, value: String(Object.values(summary).reduce((sum, count) => sum + count, 0)), detail: 'Current assigned countries' }, { label: 'Active / public', value: String((summary.active || 0) + (summary.published || 0)), detail: 'Available in the marketplace' }, { label: 'Draft / scheduled', value: String((summary.draft || 0) + (summary.scheduled || 0)), detail: 'Saved preparation' }, { label: 'Paused / cancelled', value: String((summary.paused || 0) + (summary.cancelled || 0)), detail: 'Unavailable to customers' }],
    create: { href: definition.path + '#countryGrowthEditor', label: pageId === 'admin-content' ? 'Create Revision' : pageId === 'admin-coupons' ? 'Create Coupon' : 'Create Campaign' },
    insights: [{ text: 'Changes use current country grants and versioned source records.', href: definition.path + '#countryGrowthEditor', label: 'Manage records' }], health: { value: null, label: 'Country growth records', rows: [{ label: 'Countries', value: String(context.countries.length) }, { label: 'Records', value: String(total) }] }, workflow: [{ title: 'Choose country', text: 'Use one assigned active country for each change.', href: definition.path + '#countryGrowthEditor', label: 'Open editor' }, { title: 'Review source', text: 'Open a stored record to inspect its current version.', href: definition.path + '#countryGrowthRecords', label: 'Review records' }, { title: 'Verify outcome', text: pageId === 'admin-content' ? 'Publication needs another administrator’s approval.' : 'Queueing creates delivery work; consent is checked again before sending.', href: definition.path + '#countryGrowthRecords', label: 'Inspect records' }] };
}
export function countryGrowthCsvCell(value) { let cell = String(value ?? ''); if (/^[\s\u0000-\u001f\u007f\uFEFF]*[=+@-]/.test(cell)) cell = "'" + cell; return '"' + cell.replaceAll('"', '""') + '"'; }
function growthCsvDefinition(pageId, selected) {
  const timestamp = value => value ? new Date(value).toISOString() : '';
  if (pageId === 'admin-coupons') return {
    columns: ['Reference', 'Code', 'Name', 'Country', 'Currency', 'Scope', 'Store reference', 'Discount type', 'Discount basis points', 'Fixed discount minor', 'Minimum subtotal minor', 'Maximum discount minor', 'Usage count', 'Usage limit', 'Per account limit', 'Eligible roles', 'Eligible categories', 'Eligible stores', 'First order only', 'Starts at', 'Ends at', 'Status'],
    cells: row => [row.publicId, row.code, row.name, row.country, row.currency, row.scope, row.storePublicId, row.discountType, row.discountBps, row.discountMinor, row.minimumSubtotalMinor, row.maximumDiscountMinor, row.usageCount, row.usageLimit, row.perUserLimit, row.eligibleRoles.join(';'), row.eligibleCategoryPublicIds.join(';'), row.eligibleStorePublicIds.join(';'), row.firstOrderOnly ? 'yes' : 'no', timestamp(row.startsAt), timestamp(row.endsAt), row.status],
  };
  if (pageId === 'admin-content') return {
    columns: ['Reference', 'Content key', 'Country', 'Type', 'Public version', 'Scheduled version', 'Revision count', 'Latest revision', 'Latest title', 'Latest body', 'Status'],
    cells: row => [row.publicId, row.key, row.country, row.type, row.activeVersion, row.scheduledVersion, row.revisions.length, row.revisions.at(-1)?.version ?? '', row.revisions.at(-1)?.title ?? '', row.revisions.at(-1)?.body ?? '', row.status],
  };
  if (selected.tab === 'affiliate') return {
    columns: ['Reference', 'Name', 'Country', 'Scope', 'Products', 'Approved facts', 'Disclosure', 'Review reason', 'Starts at', 'Ends at', 'Status'],
    cells: row => [row.publicId, row.name, row.country, row.scope, row.productPublicIds.join(';'), row.facts.join(';'), row.disclosureText, row.reviewReason, timestamp(row.startsAt), timestamp(row.endsAt), row.status],
  };
  return {
    columns: ['Reference', 'Name', 'Country', 'Subject', 'Plain text body', 'Audience roles', 'Eligible recipients', 'Queued recipients', 'Scheduled at', 'Started at', 'Completed at', 'Status'],
    cells: row => [row.publicId, row.name, row.country, row.subject, row.body, row.roles.join(';'), row.eligibleCount, row.queuedCount, timestamp(row.scheduledAt), timestamp(row.startedAt), timestamp(row.completedAt), row.status],
  };
}
export async function streamCountryAdminGrowthCsv(request, response, pageId) {
  if (!['admin-coupons', 'admin-campaigns', 'admin-content'].includes(pageId)) throw new AppError('Growth page not found.', 404, 'GROWTH_PAGE_NOT_FOUND');
  const context = await countryAdminAccess(request), selected = filters(request, pageId), definition = config(pageId, selected), csv = growthCsvDefinition(pageId, selected), base = scopedQuery(context, selected, definition); let after = ''; const line = cells => cells.map(countryGrowthCsvCell).join(',') + '\r\n';
  await transaction(async session => {
    const current = await countryAdminAccess(request, { session, write: true, country: context.country });
    for (const market of current.countries.filter(row => !current.country || current.country === row.code)) await writeAudit(request, 'country_admin.growth_exported', { actor: current.actor, targetType: 'growth_export', country: market.code, session, metadata: { domain: pageId, tab: selected.tab, status: selected.status } });
  });
  await assertCountryAdminReadAccess(request, context); response.type('text/csv').set('Content-Disposition', `attachment; filename="classic-mart-${pageId}.csv"`);
  const disconnected = () => new AppError('Export disconnected.', 499, 'EXPORT_DISCONNECTED');
  const write = async value => {
    if (response.destroyed || response.writableEnded) throw disconnected();
    if (!response.write(value)) await new Promise((resolve, reject) => {
      const cleanup = () => { response.removeListener('drain', drained); response.removeListener('close', closed); response.removeListener('error', failed); };
      const drained = () => { cleanup(); resolve(); }, closed = () => { cleanup(); reject(disconnected()); }, failed = error => { cleanup(); reject(error); };
      response.once('drain', drained); response.once('close', closed); response.once('error', failed);
      if (response.destroyed || response.writableEnded) closed();
    });
  };
  await write(line(csv.columns));
  while (true) { await assertCountryAdminReadAccess(request, context); const rows = await definition.Model.find(cursorScope(base, after)).sort(cursorSort()).limit(SIZE).lean(); if (!rows.length) break; for (const row of rows) { await assertCountryAdminReadAccess(request, context); const current = await definition.Model.findOne({ _id: row._id, ...base }).lean(); if (current) await write(line(csv.cells(definition.dto(current, context.actor._id)))); } after = encodeCursor(rows.at(-1)); if (rows.length < SIZE) break; }
  await assertCountryAdminReadAccess(request, context); response.end();
}

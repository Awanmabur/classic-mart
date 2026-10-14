import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import {
  AttributionTouch,
  Campaign,
  CampaignApplication,
  CountrySetting,
  CommissionEntry,
  Order,
  PromoterContactRequest,
  PromoterLink,
  PromoterVerification,
  Product,
  Payout,
  PayoutAccount,
  Refund,
  Store,
  StoreMember,
  User,
} from '../models/index.js';
import { publishedProductsByPublicIds } from './storefront.js';
import { ensureLedgerAccount, postLedgerTransaction } from './money.js';
import { assertOperationalCountry } from './authorization.js';
import { cursorScope, cursorSort, pageResult } from './pagination.js';
import { marketplacePromoterCampaignPublicId } from './seller-growth.js';

const hash = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const DAY_MS = 86_400_000;

function campaignIsLive(campaign, now = new Date()) {
  if (!campaign || campaign.status !== 'active') return false;
  if (campaign.startsAt && campaign.startsAt > now) return false;
  if (campaign.endsAt && campaign.endsAt <= now) return false;
  return true;
}

export async function ensureMarketplacePromoterCampaign(country) {
  const countryCode = String(country || '').trim().toUpperCase();
  if (!countryCode) return null;
  const setting = await CountrySetting.findOne({ code: countryCode, active: true }).select('growth.promoterCommissionBps policyVersion').lean();
  if (!setting) return null;
  const commissionBps = Math.max(0, Math.min(5000, Number(setting.growth?.promoterCommissionBps ?? 300) || 0));
  const publicIdValue = marketplacePromoterCampaignPublicId(countryCode);
  if (commissionBps <= 0) {
    await Campaign.updateOne({ publicId: publicIdValue, systemManaged: true }, { $set: { status: 'paused', commissionBps: 0 } });
    return null;
  }
  return Campaign.findOneAndUpdate(
    { publicId: publicIdValue },
    {
      $set: {
        scope: 'marketplace', systemManaged: true, country: countryCode, name: 'Classic Mart Marketplace Promoter Program',
        status: 'active', visibility: 'public', commissionBps, attributionDays: 30, allowedChannels: [], productPublicIds: [],
        disclosureText: 'Promoters may earn the displayed commission on qualifying Classic Mart purchases.',
        policyVersion: `marketplace-${String(setting.policyVersion || '2026-09').slice(0, 28)}`, endsAt: null,
      },
      $setOnInsert: { startsAt: new Date(), facts: ['Promoters earn the configured marketplace commission on eligible attributed product line totals.'], assets: [] },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
}

export async function submitPromoterVerification(request, input) {
  const { secureSubmitPromoterVerification } = await import('./promoter-campaign-pages.js');
  return secureSubmitPromoterVerification(request, input);
}

export async function reviewPromoterVerification(request, verificationId, { decision, reason = '', version }) {
  const { reviewCountryAdminPromoterLegacy } = await import('./country-admin-people-actions.js');
  return reviewCountryAdminPromoterLegacy(request, verificationId, { decision, reason, version });
}

export async function createCampaign(request, input) {
  const store = request.store || await Store.findOne({ ownerUserId: request.user._id, status: 'verified' });
  if (!store || store.status !== 'verified') throw new AppError('Verified seller store required.', 409, 'STORE_REQUIRED');
  const productIds = [...new Set((input.productPublicIds || []).map(value => String(value).trim()).filter(Boolean))];
  const ownedProducts = await Product.find({ publicId: mongoose.trusted({ $in: productIds }), storeId: store._id, status: 'published', countries: store.country }).select('publicId').lean();
  if (!productIds.length || ownedProducts.length !== productIds.length) throw new AppError('Campaign products must be published products owned by your verified store in this country.', 422, 'CAMPAIGN_PRODUCT_SCOPE');
  return Campaign.create({
    publicId: publicId('cmp'), ownerUserId: store.ownerUserId, storeId: store._id, country: store.country,
    scope: 'seller', systemManaged: false, name: input.name, visibility: input.visibility, commissionBps: input.commissionBps, attributionDays: input.attributionDays,
    allowedChannels: input.allowedChannels, facts: input.facts, productPublicIds: productIds, assets: input.assets || [],
    disclosureText: input.disclosureText, startsAt: input.startsAt || null, endsAt: input.endsAt || null, status: 'draft', policyVersion: '2026-07',
  });
}

export async function submitCampaign(request, campaignPublicId) {
  const query = { publicId: campaignPublicId };
  if (request.store?._id) query.storeId = request.store._id; else query.ownerUserId = request.user._id;
  const campaign = await Campaign.findOne(query);
  if (!campaign) throw new AppError('Campaign not found.', 404, 'CAMPAIGN_NOT_FOUND');
  if (!['draft', 'rejected'].includes(campaign.status)) throw new AppError('Only a draft or rejected campaign can be submitted.', 409, 'CAMPAIGN_STATE');
  if (!campaign.facts.length) throw new AppError('Add at least one approved factual claim before submitting.', 422, 'CAMPAIGN_FACTS_REQUIRED');
  if (!campaign.productPublicIds.length) throw new AppError('Select at least one product for the campaign.', 422, 'CAMPAIGN_PRODUCTS_REQUIRED');
  campaign.status = 'submitted'; campaign.submittedAt = new Date(); campaign.reviewReason = '';
  await campaign.save(); return campaign;
}

export async function reviewCampaign(request, campaignPublicId, { decision, reason = '' }) {
  const campaign = await Campaign.findOne({ publicId: campaignPublicId, status: 'submitted' });
  if (!campaign) throw new AppError('Submitted campaign not found.', 404, 'CAMPAIGN_NOT_FOUND');
  if (campaign.systemManaged || campaign.scope === 'marketplace') throw new AppError('Marketplace promoter policy is managed from country settings.', 409, 'MARKETPLACE_CAMPAIGN_MANAGED');
  if (request.user.role !== 'super_admin') assertOperationalCountry(request.user,campaign.country,'Campaign is outside your country scope.');
  campaign.status = decision === 'approve' ? 'active' : 'rejected';
  campaign.reviewReason = reason; campaign.reviewedAt = new Date(); campaign.reviewedByUserId = request.user._id;
  if (campaign.status === 'active' && !campaign.startsAt) campaign.startsAt = new Date();
  await campaign.save(); return campaign;
}

export async function applyToCampaign(request, campaignPublicId, note = '') {
  const { secureApplyToCampaign } = await import('./promoter-campaign-pages.js');
  return secureApplyToCampaign(request, campaignPublicId, note);
}

export async function reviewCampaignApplication(request, applicationPublicId, { decision, reason = '' }) {
  const application = await CampaignApplication.findOne({ publicId: applicationPublicId, status: 'pending' });
  if (!application) throw new AppError('Pending application not found.', 404, 'CAMPAIGN_APPLICATION_NOT_FOUND');
  const campaign = await Campaign.findById(application.campaignId);
  if (campaign?.scope === 'marketplace' || campaign?.systemManaged) throw new AppError('Marketplace promoter applications are approved automatically and cannot be seller-reviewed.', 409, 'MARKETPLACE_CAMPAIGN_MANAGED');
  const ownsCampaign = campaign && (request.store?._id ? campaign.storeId?.equals(request.store._id) : campaign.ownerUserId?.equals(request.user._id));
  if (!ownsCampaign) throw new AppError('Your store cannot review this application.', 403, 'FORBIDDEN');
  application.status = decision === 'approve' ? 'approved' : 'rejected'; application.reason = reason; application.reviewedAt = new Date(); application.reviewedByUserId = request.user._id;
  await application.save(); return application;
}

export async function createPromoterLink(request, input) {
  const { secureCreatePromoterLink } = await import('./promoter-campaign-pages.js');
  return secureCreatePromoterLink(request, input);
}

async function attributionTransaction(session, operation) {
  if (session) {
    if (!session.inTransaction()) throw new AppError('Promoter changes require a transaction.', 500, 'PROMOTER_TRANSACTION_REQUIRED');
    return operation(session);
  }
  const owned = await mongoose.startSession();
  try { return await owned.withTransaction(() => operation(owned)); }
  finally { await owned.endSession(); }
}

function buyerSessionKey(request) {
  if (!request.session) throw new AppError('A shopping session is required.', 403, 'ATTRIBUTION_SESSION_REQUIRED');
  if (request.user?._id) {
    const accountKey = `account:${request.user._id}:${request.country.code}`;
    if (request.session.cartKey && request.session.cartKey !== accountKey && !request.session.cartKey.startsWith('account:')) request.session.cartMergeKey = request.session.cartKey;
    request.session.cartKey = accountKey;
  }
  request.session.cartKey ||= crypto.randomUUID();
  return request.session.cartKey;
}

async function fenceAttribution(Model, document, session, conditions = {}) {
  const result = await Model.updateOne({ _id: document._id, __v: document.__v || 0, ...conditions }, { $inc: { __v: 1 } }, { session });
  if (result.modifiedCount !== 1) throw new AppError('Promotion eligibility changed. Refresh and try again.', 409, 'PROMOTER_ACCESS_CHANGED');
}

async function eligibleTrackingLink(linkId, country, session) {
  const link = await PromoterLink.findOne({ _id: linkId, active: true }).session(session);
  if (!link) throw new AppError('Promotion link not found.', 404, 'PROMO_LINK_NOT_FOUND');
  const campaign = await Campaign.findById(link.campaignId).session(session);
  if (!campaignIsLive(campaign)) throw new AppError('Campaign is not active.', 410, 'CAMPAIGN_INACTIVE');
  if (campaign.country !== country) throw new AppError('Campaign is unavailable in this country.', 403, 'COUNTRY_SCOPE');
  if (!Number.isSafeInteger(campaign.commissionBps) || campaign.commissionBps < 0 || campaign.commissionBps > 5000 || (campaign.allowedChannels.length && !campaign.allowedChannels.includes(link.channel))) throw new AppError('Campaign promotion policy is unavailable.', 410, 'CAMPAIGN_POLICY_CHANGED');
  const { assertPromoterLinkDestination } = await import('./promoter-campaign-pages.js');
  await assertPromoterLinkDestination({ country: { code: country } }, link, campaign, { session });
  const actor = await User.findOne({ _id: link.promoterUserId, role: 'promoter', status: 'active' }).session(session);
  const verification = await PromoterVerification.findOne({ userId: link.promoterUserId, country, status: 'verified' }).session(session);
  const application = await CampaignApplication.findOne({ campaignId: campaign._id, promoterUserId: link.promoterUserId, country, status: 'approved' }).session(session);
  const setting = await CountrySetting.findOne({ code: country, active: true }).session(session);
  if (!actor?.emailVerifiedAt || !actor.onboardingCompletedAt || !verification || !application || !setting) throw new AppError('Promoter programme access is unavailable.', 410, 'PROMOTER_PROGRAMME_UNAVAILABLE');
  const { hydratePlatformAuthorization } = await import('./platform-grants.js');
  const { primaryWorkspaceFor } = await import('../dashboard/access.js');
  await hydratePlatformAuthorization(actor);
  if (actor.role !== 'promoter' || primaryWorkspaceFor(actor) !== 'promoter') throw new AppError('Promoter programme access is unavailable.', 410, 'PROMOTER_PROGRAMME_UNAVAILABLE');
  await fenceAttribution(User, actor, session, { role: 'promoter', status: 'active', 'security.tokenVersion': actor.security.tokenVersion });
  await fenceAttribution(PromoterVerification, verification, session, { country, status: 'verified' });
  await fenceAttribution(PromoterLink, link, session, { active: true });
  await fenceAttribution(Campaign, campaign, session, { status: 'active', country });
  await fenceAttribution(CampaignApplication, application, session, { status: 'approved', country });
  await fenceAttribution(CountrySetting, setting, session, { active: true, currency: setting.currency });
  // Approval changes conflict with this transaction, including a product or
  // merchant becoming unavailable after destination validation.
  const productIds = campaign.scope !== 'marketplace' ? campaign.productPublicIds : link.destination.startsWith('/products/') ? [link.destination.slice('/products/'.length)] : [];
  if (productIds.length) {
    const { Category, Brand, ProductVariant } = await import('../models/index.js');
    const products = await Product.find({ publicId: mongoose.trusted({ $in: productIds }), status: 'published', countries: country }).session(session);
    if (products.length !== new Set(productIds).size) throw new AppError('The campaign products are unavailable.', 410, 'CAMPAIGN_PRODUCT_SCOPE');
    const stores = new Map(), categories = new Map(), brands = new Map();
    for (const product of products) {
      await fenceAttribution(Product, product, session, { status: 'published', countries: country });
      const storeKey = String(product.storeId), categoryKey = String(product.categoryId);
      if (!stores.has(storeKey)) stores.set(storeKey, await Store.findOne({ _id: product.storeId, status: 'verified', country, currency: setting.currency }).session(session));
      if (!categories.has(categoryKey)) categories.set(categoryKey, await Category.findOne({ _id: product.categoryId, active: true }).session(session));
      const store = stores.get(storeKey), category = categories.get(categoryKey);
      if (!store || !category) throw new AppError('The campaign products are unavailable.', 410, 'CAMPAIGN_PRODUCT_SCOPE');
      const variant = await ProductVariant.findOne({ productId: product._id, storeId: product.storeId, active: true, currency: setting.currency, priceMinor: mongoose.trusted({ $gt: 0 }) }).session(session);
      if (!variant) throw new AppError('The product offer is unavailable.', 410, 'CAMPAIGN_PRODUCT_SCOPE');
      await fenceAttribution(ProductVariant, variant, session, { active: true, currency: setting.currency });
      if (product.brandId && !brands.has(String(product.brandId))) brands.set(String(product.brandId), await Brand.findOne({ _id: product.brandId, status: 'approved' }).session(session));
      if (product.brandId && !brands.get(String(product.brandId))) throw new AppError('The product brand is unavailable.', 410, 'CAMPAIGN_PRODUCT_SCOPE');
    }
    for (const store of stores.values()) await fenceAttribution(Store, store, session, { status: 'verified', country });
    for (const category of categories.values()) await fenceAttribution(Category, category, session, { active: true });
    for (const brand of brands.values()) await fenceAttribution(Brand, brand, session, { status: 'approved' });
  }
  return { link, campaign, actor, setting };
}

async function trackingAudit(request, action, document, session, metadata = {}) {
  const { writeAudit } = await import('./audit.js');
  await writeAudit(request, action, { session, targetType: 'attribution_touch', targetPublicId: document.publicId, country: document.country, metadata });
}

export async function recordTouchForLink(request, candidate, session = null) {
  if (!candidate) throw new AppError('Promotion link not found.', 404, 'PROMO_LINK_NOT_FOUND');
  const sessionKey = buyerSessionKey(request);
  const result = await attributionTransaction(session, async transactionSession => {
    const { link, campaign } = await eligibleTrackingLink(candidate._id, request.country?.code, transactionSession);
    const ipHash = hash(request.ip), userAgentHash = hash(request.get('user-agent')), referrerHash = hash(request.get('referer'));
    const duplicate = await AttributionTouch.findOne({ sessionKey, linkId: link._id, status: 'valid', expiresAt: { $gt: new Date() }, landedAt: { $gte: new Date(Date.now() - 60_000) } }).session(transactionSession);
    if (duplicate) return { link, touch: duplicate };
    const recentIpCount = await AttributionTouch.countDocuments({ promoterUserId: link.promoterUserId, ipHash, landedAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) } }).session(transactionSession);
    const fraudFlags = []; let fraudScore = 0;
    if (recentIpCount >= 20) { fraudFlags.push('ip_velocity'); fraudScore += 60; }
    if (!request.get('user-agent')) { fraudFlags.push('missing_user_agent'); fraudScore += 20; }
    const selfReferral = request.user?._id && String(request.user._id) === String(link.promoterUserId);
    const blocked = selfReferral || fraudScore >= 60;
    const [touch] = await AttributionTouch.create([{ publicId: publicId('tch'), linkId: link._id, campaignId: campaign._id, promoterUserId: link.promoterUserId, sessionKey, country: request.country.code,
      ipHash, userAgentHash, referrerHash, expiresAt: new Date(Date.now() + campaign.attributionDays * DAY_MS), commissionBps: campaign.commissionBps, policyVersion: campaign.policyVersion, fraudScore, fraudFlags,
      status: blocked ? 'blocked' : 'valid', blockReason: selfReferral ? 'self_referral' : blocked ? 'automated_fraud_rule' : '' }], { session: transactionSession });
    await trackingAudit(request, 'promoter.touch_recorded', touch, transactionSession, { linkPublicId: link.publicId, status: touch.status });
    return { link, touch };
  });
  if (result.touch.status === 'valid') {
    request.session.promoterTouchId = result.touch.publicId;
    request.session.promoterTouchSessionKey = result.touch.sessionKey;
  }
  return result;
}

export async function recordTouch(request, token, session = null) {
  if (typeof token !== 'string' || token.length > 100) throw new AppError('Promotion link not found.', 404, 'PROMO_LINK_NOT_FOUND');
  const link = await PromoterLink.findOne({ token, active: true }).session(session);
  return recordTouchForLink(request, link, session);
}

export async function redeemPromoterCoupon(request, code, session = null) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized || normalized.length > 32) throw new AppError('Enter a valid promoter code.', 422, 'PROMO_CODE_REQUIRED');
  const links = await PromoterLink.find({ couponCode: normalized, active: true }).sort({ createdAt: -1 }).limit(2).session(session);
  if (!links.length) throw new AppError('Promoter code is invalid or inactive.', 404, 'PROMO_CODE_INVALID');
  if (links.length > 1) throw new AppError('Promoter code is ambiguous. Ask the promoter for a current code.', 409, 'PROMO_CODE_AMBIGUOUS');
  return recordTouchForLink(request, links[0], session);
}

export async function attributeOrder(request, orderPublicId, session = null) {
  const touchId = request.session?.promoterTouchId;
  if (!touchId) return;
  const sessionKey = buyerSessionKey(request);
  return attributionTransaction(session, async transactionSession => {
    const touch = await AttributionTouch.findOne({ publicId: touchId, status: 'valid', expiresAt: { $gt: new Date() } }).session(transactionSession);
    const order = await Order.findOne({ publicId: orderPublicId, sessionKey, country: request.country.code }).session(transactionSession);
    if (!touch || !order || touch.country !== order.country || !['pending_payment', 'confirmed', 'paid', 'partially_refunded'].includes(order.status) || (order.userId && String(order.userId) !== String(request.user?._id))) return;
    // Identity login preserves this browser's guest cart continuity. Migrate
    // only that server-owned key, never a touch copied from another session.
    if (touch.sessionKey !== sessionKey) {
      if (!request.user?._id || request.session.promoterTouchSessionKey !== touch.sessionKey || String(order.userId) !== String(request.user._id)) return;
      touch.sessionKey = sessionKey;
    }
    let access;
    try { access = await eligibleTrackingLink(touch.linkId, order.country, transactionSession); }
    catch (error) { if (error instanceof AppError && [403,404,409,410,422].includes(error.status)) return; throw error; }
    const { link, campaign, setting } = access;
    if (String(link.promoterUserId) !== String(touch.promoterUserId) || String(campaign._id) !== String(touch.campaignId) || order.totals.currency !== setting.currency) return;
    if (String(order.userId || '') === String(touch.promoterUserId)) { touch.status = 'blocked'; touch.blockReason = 'self_referral'; await touch.save({ session: transactionSession }); return; }
    await fenceAttribution(Order, order, transactionSession, { sessionKey, country: order.country });
    const ownedStoreIds = await Store.find({ ownerUserId: touch.promoterUserId }).distinct('_id').session(transactionSession);
    const memberStoreIds = await StoreMember.find({ userId: touch.promoterUserId, status: 'active' }).distinct('storeId').session(transactionSession);
    const promoterStoreIds = new Set([...ownedStoreIds, ...memberStoreIds].map(String));
    const grouped = new Map();
    for (const item of order.items) {
      if (promoterStoreIds.has(String(item.storeId)) || item.currency !== setting.currency || !Number.isSafeInteger(item.lineTotalMinor) || item.lineTotalMinor <= 0) continue;
      if (campaign.scope !== 'marketplace' && (String(item.storeId) !== String(campaign.storeId) || !campaign.productPublicIds.includes(item.productPublicId))) continue;
      const entry = grouped.get(item.productPublicId) || { item, total: 0 };
      entry.total += item.lineTotalMinor; grouped.set(item.productPublicId, entry);
    }
    const commissionBps = Math.max(0, Math.min(5000, Number(touch.commissionBps ?? campaign.commissionBps) || 0)), policyVersion = String(touch.policyVersion || campaign.policyVersion || '');
    if (!Number.isSafeInteger(commissionBps)) return;
    let eligible = 0;
    for (const { item, total } of grouped.values()) {
      if (!Number.isSafeInteger(total)) continue;
      const amount = Number(BigInt(total) * BigInt(commissionBps) / 10000n);
      if (amount <= 0) continue;
      const row = await CommissionEntry.findOneAndUpdate({ orderId: order._id, promoterUserId: touch.promoterUserId, productPublicId: item.productPublicId },
        { $setOnInsert: { publicId: publicId('com'), orderPublicId: order.publicId, campaignId: campaign._id, touchId: touch._id, storePublicId: item.storePublicId, amountMinor: amount, currency: item.currency, commissionBps, policyVersion, status: 'pending' } },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, session: transactionSession });
      if (String(row.touchId) === String(touch._id) && String(row.campaignId) === String(campaign._id)) eligible += 1;
    }
    if (!eligible) return;
    touch.status = 'converted'; await touch.save({ session: transactionSession });
    await trackingAudit(request, 'promoter.order_attributed', touch, transactionSession, { orderPublicId: order.publicId, commissionRows: eligible });
    return { orderPublicId: order.publicId, commissionRows: eligible };
  });
}

export async function makeOrderCommissionsPayable(order, session = null) {
  if (!order?._id || !['paid', 'partially_refunded'].includes(order.paymentState)) return;
  return attributionTransaction(session, async transactionSession => {
    const commissions = await CommissionEntry.find({ orderId: order._id, orderPublicId: order.publicId, currency: order.totals.currency,
      status: mongoose.trusted({ $in: ['pending', 'partially_reversed'] }), payableAt: null }).session(transactionSession);
    for (const commission of commissions) {
      const campaign = await Campaign.findOne({ _id: commission.campaignId, country: order.country }).session(transactionSession);
      if (!campaign) continue;
      const gross = Number(commission.amountMinor), reversed = Number(commission.reversedAmountMinor || 0);
      if (!Number.isSafeInteger(gross) || !Number.isSafeInteger(reversed) || reversed < 0 || reversed > gross) throw new AppError('Commission amounts are invalid.', 409, 'COMMISSION_AMOUNT_INVALID');
      const net = gross - reversed;
      if (!net) { commission.status = 'reversed'; await commission.save({ session: transactionSession }); continue; }
      const payable = await ensureLedgerAccount({ code: 'promoter_payable', type: 'liability', ownerType: 'promoter', ownerId: commission.promoterUserId, ownerPublicId: String(commission.promoterUserId), country: order.country, currency: commission.currency }, transactionSession);
      const expense = await ensureLedgerAccount({ code: 'promoter_commission_expense', type: 'expense', ownerType: 'platform', ownerPublicId: 'classic-mart', country: order.country, currency: commission.currency }, transactionSession);
      await postLedgerTransaction({ idempotencyKey: `commission:${commission.publicId}`, referenceType: 'commission', referencePublicId: commission.publicId, currency: commission.currency, country: order.country, description: `Promoter commission ${commission.publicId}`, entries: [{ account: expense, debitMinor: net, creditMinor: 0, memo: 'Promoter acquisition cost after refunds' }, { account: payable, debitMinor: 0, creditMinor: net, memo: 'Promoter payable' }] }, transactionSession);
      commission.status = reversed ? 'partially_reversed' : 'payable'; commission.payableAt = new Date(); await commission.save({ session: transactionSession });
    }
  });
}

export async function reverseOrderCommissions(order, refund, session = null) {
  if (!order?._id || String(refund?.orderId) !== String(order._id) || refund.currency !== order.totals.currency || refund.status !== 'completed') throw new AppError('Completed refund does not match this order.', 409, 'COMMISSION_REFUND_SCOPE');
  return attributionTransaction(session, async transactionSession => {
    const commissions = await CommissionEntry.find({ orderId: order._id, orderPublicId: order.publicId, currency: order.totals.currency,
      status: mongoose.trusted({ $in: ['pending', 'payable', 'partially_reversed', 'paid'] }) }).session(transactionSession);
    const priorRefunds = await Refund.find({ orderId: order._id, status: 'completed', currency: order.totals.currency,
      _id: mongoose.trusted({ $ne: refund._id }) }).select('amountMinor allocations').session(transactionSession).lean();
    const refunds = [...priorRefunds, refund];
    for (const commission of commissions) {
      const gross = Number(commission.amountMinor), alreadyReversed = Number(commission.reversedAmountMinor || 0), storedRefundBaseline = Number(commission.refundedCommissionMinor || 0);
      if (![gross, alreadyReversed, storedRefundBaseline].every(Number.isSafeInteger) || alreadyReversed < 0 || alreadyReversed > gross || storedRefundBaseline < 0 || storedRefundBaseline > gross) throw new AppError('Commission amounts are invalid.', 409, 'COMMISSION_AMOUNT_INVALID');
      const remaining = gross - alreadyReversed;
      if (!remaining) continue;
      const originalGross = order.items.filter(item => item.productPublicId === commission.productPublicId && item.storePublicId === commission.storePublicId).reduce((sum, item) => sum + Number(item.lineTotalMinor), 0);
      if (!Number.isSafeInteger(originalGross) || originalGross <= 0) continue;
      let allocatedGross = 0, unallocatedMinor = 0;
      for (const completed of refunds) {
        const allocations = Array.isArray(completed.allocations) ? completed.allocations : [];
        if (allocations.length) allocatedGross += allocations.filter(row => row.productPublicId === commission.productPublicId && row.storePublicId === commission.storePublicId).reduce((sum, row) => sum + Number(row.grossMinor || 0), 0);
        else unallocatedMinor += Number(completed.amountMinor || 0);
      }
      if (![allocatedGross, unallocatedMinor, order.totals.totalMinor].every(Number.isSafeInteger) || allocatedGross < 0 || unallocatedMinor < 0 || order.totals.totalMinor <= 0) throw new AppError('Refund commission allocation is invalid.', 409, 'COMMISSION_REFUND_SCOPE');
      const allocatedTarget = BigInt(gross) * BigInt(Math.min(originalGross, allocatedGross)) / BigInt(originalGross);
      const unallocatedTarget = BigInt(gross) * BigInt(Math.min(order.totals.totalMinor, unallocatedMinor)) / BigInt(order.totals.totalMinor);
      const target = Math.min(gross, Number(allocatedTarget + unallocatedTarget));
      const previousTarget = Math.max(storedRefundBaseline, alreadyReversed);
      const reversal = Math.min(remaining, Math.max(0, target - previousTarget));
      commission.refundedCommissionMinor = Math.max(previousTarget, target);
      if (!reversal) {
        if (commission.refundedCommissionMinor !== storedRefundBaseline) await commission.save({ session: transactionSession });
        continue;
      }
      // An estimate can be partially reversed before any money was posted.
      // Only a posted payable may create a reversing ledger transaction.
      if (commission.payableAt) {
        const payable = await ensureLedgerAccount({ code: 'promoter_payable', type: 'liability', ownerType: 'promoter', ownerId: commission.promoterUserId, ownerPublicId: String(commission.promoterUserId), country: order.country, currency: commission.currency }, transactionSession);
        const expense = await ensureLedgerAccount({ code: 'promoter_commission_expense', type: 'expense', ownerType: 'platform', ownerPublicId: 'classic-mart', country: order.country, currency: commission.currency }, transactionSession);
        await postLedgerTransaction({ idempotencyKey: `commission-reversal:${refund.publicId}:${commission.publicId}`, referenceType: 'commission_reversal', referencePublicId: commission.publicId, currency: commission.currency, country: order.country, description: `Commission reversal for refund ${refund.publicId}`, entries: [{ account: payable, debitMinor: reversal, creditMinor: 0, memo: 'Reverse promoter payable' }, { account: expense, debitMinor: 0, creditMinor: reversal, memo: 'Reverse acquisition expense' }] }, transactionSession);
      }
      commission.reversedAmountMinor = alreadyReversed + reversal;
      commission.reversalRefundPublicId = refund.publicId; commission.reversalReason = `Refund ${refund.publicId}`; commission.reversedAt = new Date();
      commission.status = commission.reversedAmountMinor >= gross ? 'reversed' : 'partially_reversed'; await commission.save({ session: transactionSession });
    }
  });
}

export async function settlePromoterCommissions(userId, amountMinor, session = null, context = {}) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new AppError('Payout amount must be a positive whole amount.', 422, 'COMMISSION_AMOUNT_INVALID');
  return attributionTransaction(session, async transactionSession => {
    let country = context.country, currency = context.currency;
    if ((context.country !== undefined || context.currency !== undefined) && (!country || !currency)) throw new AppError('Payout market requires both country and currency.', 409, 'COMMISSION_MARKET_REQUIRED');
    if (!country || !currency) {
      const [user, verification] = await Promise.all([User.findById(userId).select('country').session(transactionSession).lean(), PromoterVerification.findOne({ userId }).select('country').session(transactionSession).lean()]);
      country = verification?.country || user?.country;
      const setting = country && await CountrySetting.findOne({ code: country, active: true }).select('currency').session(transactionSession).lean();
      currency = setting?.currency;
    }
    if (!/^[A-Z]{2}$/.test(country || '') || !/^[A-Z]{3}$/.test(currency || '')) throw new AppError('Payout market is unavailable.', 409, 'COMMISSION_MARKET_REQUIRED');
    let remaining = amountMinor;
    const commissions = await CommissionEntry.find({ promoterUserId: userId, currency, payableAt: mongoose.trusted({ $ne: null }),
      status: mongoose.trusted({ $in: ['payable', 'partially_reversed'] }) }).sort({ payableAt: 1, createdAt: 1, _id: 1 }).session(transactionSession);
    for (const commission of commissions) {
      if (remaining <= 0) break;
      const order = await Order.findOne({ _id: commission.orderId, publicId: commission.orderPublicId, country, 'totals.currency': currency }).select('_id').session(transactionSession).lean();
      const campaign = order && await Campaign.findOne({ _id: commission.campaignId, country }).select('_id').session(transactionSession).lean();
      if (!order || !campaign) continue;
      const gross = Number(commission.amountMinor), reversed = Number(commission.reversedAmountMinor || 0), paid = Number(commission.paidAmountMinor || 0);
      if (![gross, reversed, paid].every(Number.isSafeInteger) || gross < 0 || reversed < 0 || reversed > gross || paid < 0) throw new AppError('Commission amounts are invalid.', 409, 'COMMISSION_AMOUNT_INVALID');
      const net = gross - reversed, unpaid = Math.max(0, net - paid);
      if (!unpaid) continue;
      const applied = Math.min(unpaid, remaining);
      commission.paidAmountMinor = paid + applied;
      remaining -= applied;
      if (commission.paidAmountMinor >= net) { commission.status = 'paid'; commission.paidAt = new Date(); }
      await commission.save({ session: transactionSession });
    }
    return { appliedMinor: amountMinor - remaining, unappliedMinor: remaining };
  });
}


export async function buildCampaignContentKit(request, input) {
  const { secureBuildCampaignContentKit } = await import('./promoter-campaign-pages.js');
  return secureBuildCampaignContentKit(request, input);
}

export async function appealCommissionReversal(request, commissionPublicId, message) {
  const { appealPromoterCommission } = await import('./promoter-finance-pages.js');
  return appealPromoterCommission(request, commissionPublicId, { message });
}

export async function reviewCommissionAppeal(request, commissionPublicId, { decision, reason, version }) {
  if (!['accept', 'reject'].includes(decision) || typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 1200) throw new AppError('Provide an appeal decision and reason.', 422, 'COMMISSION_APPEAL_DECISION_INVALID');
  const [{ financeAccess }, { writeAudit }] = await Promise.all([import('./finance-workspace-access.js'), import('./audit.js')]);
  const session = await mongoose.startSession(); let result;
  try { await session.withTransaction(async () => {
    let { actor } = await financeAccess(request, { session, workspace: false, country: '' });
    const current = await CommissionEntry.findOne({ publicId: commissionPublicId, 'appeal.status': 'pending', status: { $in: ['reversed', 'partially_reversed'] } }).session(session);
    if (!current) throw new AppError('Pending commission appeal not found.', 404, 'COMMISSION_APPEAL_NOT_FOUND');
    if (version !== undefined && (!Number.isSafeInteger(Number(version)) || Number(version) < 0 || Number(version) !== Number(current.__v || 0))) throw new AppError('This appeal changed. Refresh before reviewing it.', 409, 'COMMISSION_APPEAL_STATE_CHANGED');
    if (String(current.promoterUserId) === String(actor._id)) throw new AppError('You cannot review your own commission appeal.', 403, 'FOUR_EYES_REQUIRED');
    const campaign = await Campaign.findById(current.campaignId).select('country').session(session).lean();
    const order = campaign ? await Order.findOne({ _id: current.orderId, publicId: current.orderPublicId, country: campaign.country, 'totals.currency': current.currency }).select('_id').session(session).lean() : null;
    if (!campaign || !order) throw new AppError('Commission market references are inconsistent.', 409, 'COMMISSION_MARKET_INVALID');
    const financeContext = await financeAccess(request, { session, workspace: false, country: campaign.country, write: true });
    actor = financeContext.actor;
    if (financeContext.market.currency !== current.currency) throw new AppError('Commission currency does not match its configured market.', 409, 'COMMISSION_MARKET_INVALID');
    let restoredPostedMinor = 0;
    if (decision === 'accept') {
      const restore = Number(current.reversedAmountMinor || 0);
      if (!Number.isSafeInteger(restore) || restore < 0 || !Number.isSafeInteger(current.amountMinor) || restore > current.amountMinor) throw new AppError('Commission amounts are invalid.', 409, 'COMMISSION_AMOUNT_INVALID');
      current.refundedCommissionMinor = Math.max(Number(current.refundedCommissionMinor || 0), restore);
      // A pending estimate has never entered the ledger. Accepting its appeal
      // restores the estimate without turning it into withdrawable funds.
      if (current.payableAt && restore > 0) {
        const payable = await ensureLedgerAccount({ code: 'promoter_payable', type: 'liability', ownerType: 'promoter', ownerId: current.promoterUserId, ownerPublicId: String(current.promoterUserId), country: campaign.country, currency: current.currency }, session);
        const expense = await ensureLedgerAccount({ code: 'promoter_commission_expense', type: 'expense', ownerType: 'platform', ownerPublicId: 'classic-mart', country: campaign.country, currency: current.currency }, session);
        await postLedgerTransaction({ idempotencyKey: `commission-appeal:${current.publicId}:${current.appeal.submittedAt?.getTime() ?? current.__v}`, referenceType: 'commission_appeal', referencePublicId: current.publicId, currency: current.currency, country: campaign.country, description: `Accepted commission reversal appeal ${current.publicId}`, entries: [{ account: expense, debitMinor: restore, creditMinor: 0, memo: 'Restore posted commission expense after accepted appeal' }, { account: payable, debitMinor: 0, creditMinor: restore, memo: 'Restore promoter payable after accepted appeal' }] }, session);
        restoredPostedMinor = restore;
      }
      current.reversedAmountMinor = 0; current.reversalReason = ''; current.reversalRefundPublicId = ''; current.reversedAt = undefined;
      current.status = current.payableAt ? (Number(current.paidAmountMinor || 0) >= current.amountMinor ? 'paid' : 'payable') : 'pending';
    }
    current.appeal.status = decision === 'accept' ? 'accepted' : 'rejected'; current.appeal.decision = reason.trim(); current.appeal.reviewedAt = new Date(); current.appeal.reviewedByUserId = actor._id;
    await current.save({ session });
    await writeAudit(request, 'finance.commission_appeal_reviewed', { actor, targetType: 'commission', targetPublicId: current.publicId, country: campaign.country, metadata: { decision, restoredPostedMinor }, session });
    result = current.toObject();
  }); } finally { await session.endSession(); }
  return result;
}


export async function streamPromoterCommissionCsv(response,user){
  const { streamPromoterFinanceCsv } = await import('./promoter-finance-pages.js');
  response.status(200).set('Cache-Control', 'private, no-store');
  return streamPromoterFinanceCsv({ user, query: {} }, response, 'promoter-commissions');
}

export async function promoterSummary(user, paging = {}) {
  const size = 50;
  const verification = await PromoterVerification.findOne({ userId: user._id }).lean();
  const country = String(verification?.country || user.shoppingCountry || user.country || '').toUpperCase();
  await ensureMarketplacePromoterCampaign(country);
  const page = async (Model, base, rawCursor, { field = 'createdAt', direction = -1, populate = null, select = '' } = {}) => {
    const scope = cursorScope(base, rawCursor, { field, direction });
    let query = Model.find(scope).sort(cursorSort(field, direction)).limit(size + 1);
    if (select) query = query.select(select);
    if (populate) query = query.populate(...populate);
    const [rows, total] = await Promise.all([query.lean(), Model.countDocuments(base)]);
    return pageResult(rows, { field, direction, limit: size, total });
  };

  const [linksPage, commissionsPage, applicationsPage, campaignsPage, contactsPage] = await Promise.all([
    page(PromoterLink, { promoterUserId: user._id }, paging.linksAfter),
    page(CommissionEntry, { promoterUserId: user._id }, paging.commissionsAfter),
    page(CampaignApplication, { promoterUserId: user._id }, paging.applicationsAfter),
    page(Campaign, { country, status: 'active' }, paging.campaignsAfter),
    page(PromoterContactRequest, { promoterUserId: user._id }, paging.contactsAfter, { field: 'lastMessageAt', populate: ['customerUserId', 'name'] }),
  ]);

  // Campaign application state is fetched for the visible campaign page so an application
  // cannot disappear merely because the application-history pager is on another page.
  const visibleCampaignIds = campaignsPage.items.map((campaign) => campaign._id);
  const visibleApplications = visibleCampaignIds.length
    ? await CampaignApplication.find({ promoterUserId: user._id, campaignId: mongoose.trusted({ $in: visibleCampaignIds }) }).lean()
    : [];
  const applicationByCampaign = new Map(visibleApplications.map((row) => [String(row.campaignId), row]));
  const campaigns = campaignsPage.items.map((campaign) => ({ ...campaign, promoterApplication: applicationByCampaign.get(String(campaign._id)) || null }));

  // Analytics deliberately operate over the complete promoter history, independently of UI pagination.
  const touchFacetRows = await AttributionTouch.aggregate([
    { $match: { promoterUserId: user._id } },
    { $lookup: { from: PromoterLink.collection.name, localField: 'linkId', foreignField: '_id', as: 'link' } },
    { $set: { link: { $first: '$link' } } },
    { $facet: {
      totals: [
        { $group: { _id: null, clicks: { $sum: 1 }, conversions: { $sum: { $cond: [{ $eq: ['$status', 'converted'] }, 1, 0] } } } },
      ],
      byChannel: [
        { $group: { _id: { $ifNull: ['$link.channel', 'direct'] }, clicks: { $sum: 1 }, conversions: { $sum: { $cond: [{ $eq: ['$status', 'converted'] }, 1, 0] } } } },
        { $sort: { clicks: -1, _id: 1 } },
      ],
      byLink: [
        { $group: { _id: '$linkId', publicId: { $first: '$link.publicId' }, channel: { $first: '$link.channel' }, couponCode: { $first: '$link.couponCode' }, clicks: { $sum: 1 }, conversions: { $sum: { $cond: [{ $eq: ['$status', 'converted'] }, 1, 0] } } } },
        { $sort: { clicks: -1, _id: 1 } },
        { $limit: 250 },
      ],
      byCampaign: [
        { $group: { _id: '$campaignId', clicks: { $sum: 1 }, conversions: { $sum: { $cond: [{ $eq: ['$status', 'converted'] }, 1, 0] } } } },
        { $sort: { clicks: -1, _id: 1 } },
      ],
      byDate: [
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$landedAt', timezone: 'UTC' } }, clicks: { $sum: 1 }, conversions: { $sum: { $cond: [{ $eq: ['$status', 'converted'] }, 1, 0] } } } },
        { $sort: { _id: -1 } },
        { $limit: 90 },
      ],
    } },
  ]);
  const touchFacet = touchFacetRows[0] || { totals: [], byChannel: [], byLink: [], byCampaign: [], byDate: [] };

  const commissionFacetRows = await CommissionEntry.aggregate([
    { $match: { promoterUserId: user._id } },
    { $set: {
      netMinor: { $max: [0, { $subtract: [{ $ifNull: ['$amountMinor', 0] }, { $ifNull: ['$reversedAmountMinor', 0] }] }] },
    } },
    { $set: {
      paidNetMinor: { $min: ['$netMinor', { $ifNull: ['$paidAmountMinor', 0] }] },
      outstandingMinor: { $max: [0, { $subtract: ['$netMinor', { $ifNull: ['$paidAmountMinor', 0] }] }] },
    } },
    { $facet: {
      totals: [
        { $group: { _id: null, earned: { $sum: '$netMinor' }, paid: { $sum: '$paidNetMinor' }, outstanding: { $sum: '$outstandingMinor' }, currency: { $first: '$currency' } } },
      ],
      byCampaign: [
        { $group: { _id: '$campaignId', commissionMinor: { $sum: '$netMinor' } } },
        { $sort: { commissionMinor: -1, _id: 1 } },
      ],
      byProduct: [
        { $group: { _id: '$productPublicId', commissionMinor: { $sum: '$netMinor' } } },
        { $sort: { commissionMinor: -1, _id: 1 } },
        { $limit: 250 },
      ],
      bySeller: [
        { $group: { _id: '$storePublicId', commissionMinor: { $sum: '$netMinor' } } },
        { $sort: { commissionMinor: -1, _id: 1 } },
        { $limit: 250 },
      ],
      byDate: [
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } }, commissionMinor: { $sum: '$netMinor' } } },
        { $sort: { _id: -1 } },
        { $limit: 90 },
      ],
    } },
  ]);
  const commissionFacet = commissionFacetRows[0] || { totals: [], byCampaign: [], byProduct: [], bySeller: [], byDate: [] };
  const touchTotals = touchFacet.totals[0] || { clicks: 0, conversions: 0 };
  const commissionTotals = commissionFacet.totals[0] || { earned: 0, paid: 0, outstanding: 0, currency: user.currency };
  const [commissionStageRows,blockedTouches,pendingAppeals,payoutAccountIds]=await Promise.all([
    CommissionEntry.aggregate([
      {$match:{promoterUserId:user._id}},
      {$set:{netMinor:{$max:[0,{$subtract:[{$ifNull:['$amountMinor',0]},{$ifNull:['$reversedAmountMinor',0]}]}]}}},
      {$set:{paidNetMinor:{$min:['$netMinor',{$ifNull:['$paidAmountMinor',0]}]},outstandingMinor:{$max:[0,{$subtract:['$netMinor',{$ifNull:['$paidAmountMinor',0]}]}]}}},
      {$group:{_id:'$status',count:{$sum:1},grossMinor:{$sum:{$ifNull:['$amountMinor',0]}},reversedMinor:{$sum:{$ifNull:['$reversedAmountMinor',0]}},netMinor:{$sum:'$netMinor'},paidMinor:{$sum:'$paidNetMinor'},outstandingMinor:{$sum:'$outstandingMinor'}}},
    ]),
    AttributionTouch.countDocuments({promoterUserId:user._id,status:'blocked'}),
    CommissionEntry.countDocuments({promoterUserId:user._id,'appeal.status':'pending'}),
    PayoutAccount.find({ownerUserId:user._id,ownerType:'promoter'}).distinct('_id'),
  ]);
  const payoutRows=payoutAccountIds.length?await Payout.aggregate([{$match:{payoutAccountId:{$in:payoutAccountIds}}},{$group:{_id:'$status',count:{$sum:1},amountMinor:{$sum:'$amountMinor'}}}]):[];
  const payoutByStatus=new Map(payoutRows.map(row=>[String(row._id),row]));
  const stageByStatus=new Map(commissionStageRows.map(row=>[String(row._id),row]));
  const pendingStage=stageByStatus.get('pending')||{},payableStage=stageByStatus.get('payable')||{},partialStage=stageByStatus.get('partially_reversed')||{};
  const commissionStages={estimatedMinor:Number(pendingStage.netMinor||0),estimatedCount:Number(pendingStage.count||0),payableMinor:Number(payableStage.outstandingMinor||0)+Number(partialStage.outstandingMinor||0),payableCount:Number(payableStage.count||0)+Number(partialStage.count||0),paidMinor:Number(commissionTotals.paid||0),reversedMinor:commissionStageRows.reduce((sum,row)=>sum+Number(row.reversedMinor||0),0)};
  const promoterRisk={blockedTouches:Number(blockedTouches||0),pendingAppeals:Number(pendingAppeals||0),unknownPayouts:Number(payoutByStatus.get('unknown')?.count||0),submittedPayouts:Number(payoutByStatus.get('submitted')?.count||0)};

  const campaignIds = [...new Set([
    ...touchFacet.byCampaign.map((row) => String(row._id || '')),
    ...commissionFacet.byCampaign.map((row) => String(row._id || '')),
  ].filter((id) => mongoose.isValidObjectId(id)))].map((id) => new mongoose.Types.ObjectId(id));
  const campaignNames = campaignIds.length
    ? await Campaign.find({ _id: mongoose.trusted({ $in: campaignIds }) }).select('_id name').lean()
    : [];
  const campaignNameById = new Map(campaignNames.map((row) => [String(row._id), row.name]));
  const commissionByCampaign = new Map(commissionFacet.byCampaign.map((row) => [String(row._id), Number(row.commissionMinor || 0)]));
  const campaignKeys = new Set([...touchFacet.byCampaign.map((row) => String(row._id)), ...commissionFacet.byCampaign.map((row) => String(row._id))]);
  const analytics = {
    byLink: touchFacet.byLink.map((row) => ({ key: row.publicId || String(row._id), channel: row.channel || '', couponCode: row.couponCode || '', clicks: row.clicks || 0, conversions: row.conversions || 0, commissionMinor: 0 })),
    byChannel: touchFacet.byChannel.map((row) => ({ key: row._id || 'direct', clicks: row.clicks || 0, conversions: row.conversions || 0, commissionMinor: 0 })),
    byCampaign: [...campaignKeys].map((id) => { const touch = touchFacet.byCampaign.find((row) => String(row._id) === id); return { key: id, name: campaignNameById.get(id) || '', clicks: touch?.clicks || 0, conversions: touch?.conversions || 0, commissionMinor: commissionByCampaign.get(id) || 0 }; }),
    byProduct: commissionFacet.byProduct.map((row) => ({ key: row._id || 'Unspecified', clicks: 0, conversions: 0, commissionMinor: row.commissionMinor || 0 })),
    bySeller: commissionFacet.bySeller.map((row) => ({ key: row._id || 'Unspecified', clicks: 0, conversions: 0, commissionMinor: row.commissionMinor || 0 })),
    byDate: (() => {
      const rows = new Map();
      for (const row of touchFacet.byDate) rows.set(row._id, { key: row._id, clicks: row.clicks || 0, conversions: row.conversions || 0, commissionMinor: 0 });
      for (const row of commissionFacet.byDate) { const current = rows.get(row._id) || { key: row._id, clicks: 0, conversions: 0, commissionMinor: 0 }; current.commissionMinor += row.commissionMinor || 0; rows.set(row._id, current); }
      return [...rows.values()].sort((a, b) => b.key.localeCompare(a.key)).slice(0, 90);
    })(),
  };

  return {
    verification,
    links: linksPage.items,
    commissions: commissionsPage.items,
    applications: applicationsPage.items,
    campaigns,
    contacts: contactsPage.items,
    totals: { payable: commissionTotals.outstanding, outstanding: commissionTotals.outstanding, paid: commissionTotals.paid, earned: commissionTotals.earned, currency: commissionTotals.currency || user.currency },
    commissionStages,
    risk:promoterRisk,
    analytics,
    clicks: Number(touchTotals.clicks || 0),
    conversions: Number(touchTotals.conversions || 0),
    queuePages: { links: linksPage.page, commissions: commissionsPage.page, applications: applicationsPage.page, campaigns: campaignsPage.page, contacts: contactsPage.page },
  };
}

function publicPromoterName(user) {
  return user?.roleProfile?.publicName || user?.roleProfile?.businessName || user?.name || 'Classic Mart promoter';
}

function livePublicCampaign(campaign, now = new Date()) {
  return campaign?.visibility === 'public' && campaignIsLive(campaign, now);
}

async function promoterPublicRows(country, { verificationPublicId = '', includeProducts = false, after = '', limit = 50 } = {}) {
  const countryCode = String(country?.code || country || '').toUpperCase();
  const verificationQuery = { country: countryCode, status: 'verified' };
  if (verificationPublicId) verificationQuery.publicId = verificationPublicId;
  const pageSize=Math.min(Math.max(Number(limit)||50,10),100);
  let verifications,page={count:0,total:0,hasMore:false,next:''};
  if(verificationPublicId){verifications=await PromoterVerification.find(verificationQuery).sort({createdAt:-1,_id:-1}).lean();page={count:verifications.length,total:verifications.length,hasMore:false,next:''};}
  else{const [rows,total]=await Promise.all([PromoterVerification.find(cursorScope(verificationQuery,after)).sort(cursorSort()).limit(pageSize+1).lean(),PromoterVerification.countDocuments(verificationQuery)]);const result=pageResult(rows,{limit:pageSize,total});verifications=result.items;page=result.page;}
  if (!verifications.length) return {items:[],page};

  const userIds = verifications.map((row) => row.userId);
  const users = await User.find({ _id: mongoose.trusted({ $in: userIds }), role: 'promoter', status: 'active', country: countryCode })
    .select('publicId name roleProfile country locale')
    .lean();
  const activeUserIds = users.map((user) => user._id);
  if (!activeUserIds.length) return {items:[],page};

  const [applications, links, touchGroups, commissionGroups] = await Promise.all([
    CampaignApplication.find({ promoterUserId: mongoose.trusted({ $in: activeUserIds }), country: countryCode, status: 'approved' }).select('promoterUserId campaignId').lean(),
    PromoterLink.find({ promoterUserId: mongoose.trusted({ $in: activeUserIds }), active: true }).select('promoterUserId campaignId').lean(),
    AttributionTouch.aggregate([
      { $match: { promoterUserId: { $in: activeUserIds }, country: countryCode, status: { $in: ['valid', 'converted'] } } },
      { $group: { _id: '$promoterUserId', clicks: { $sum: 1 }, conversions: { $sum: { $cond: [{ $eq: ['$status', 'converted'] }, 1, 0] } } } },
    ]),
    CommissionEntry.aggregate([
      { $match: { promoterUserId: { $in: activeUserIds } } },
      { $group: { _id: '$promoterUserId', earnedMinor: { $sum: { $cond: [{ $gt: [{ $subtract: [{ $ifNull: ['$amountMinor', 0] }, { $ifNull: ['$reversedAmountMinor', 0] }] }, 0] }, { $subtract: [{ $ifNull: ['$amountMinor', 0] }, { $ifNull: ['$reversedAmountMinor', 0] }] }, 0] } } } },
    ]),
  ]);

  const campaignIds = [...new Set(applications.map((row) => String(row.campaignId)))];
  const campaigns = campaignIds.length
    ? await Campaign.find({ _id: mongoose.trusted({ $in: campaignIds }), country: countryCode, status: 'active', visibility: 'public' }).lean()
    : [];
  const liveCampaigns = campaigns.filter((campaign) => livePublicCampaign(campaign));
  const campaignById = new Map(liveCampaigns.map((campaign) => [String(campaign._id), campaign]));
  const userById = new Map(users.map((user) => [String(user._id), user]));
  const verificationByUser = new Map(verifications.map((row) => [String(row.userId), row]));
  const applicationsByUser = new Map();
  for (const application of applications) {
    const campaign = campaignById.get(String(application.campaignId));
    if (!campaign) continue;
    const key = String(application.promoterUserId);
    const rows = applicationsByUser.get(key) || [];
    rows.push(campaign);
    applicationsByUser.set(key, rows);
  }
  const linkCountByUser = new Map();
  for (const link of links) {
    if (!campaignById.has(String(link.campaignId))) continue;
    const key = String(link.promoterUserId);
    linkCountByUser.set(key, (linkCountByUser.get(key) || 0) + 1);
  }
  const touchByUser = new Map(touchGroups.map((row) => [String(row._id), row]));
  const commissionByUser = new Map(commissionGroups.map((row) => [String(row._id), row]));

  const rows = [];
  for (const userId of activeUserIds) {
    const key = String(userId);
    const user = userById.get(key);
    const verification = verificationByUser.get(key);
    if (!user || !verification) continue;
    const userCampaigns = applicationsByUser.get(key) || [];
    const touches = touchByUser.get(key) || { clicks: 0, conversions: 0 };
    const commission = commissionByUser.get(key) || { earnedMinor: 0 };
    const productPublicIds = [...new Set(userCampaigns.flatMap((campaign) => campaign.productPublicIds || []))];
    const products = includeProducts && productPublicIds.length
      ? await publishedProductsByPublicIds(productPublicIds.slice(0, 30), country)
      : [];
    rows.push({
      id: verification.publicId,
      userPublicId: user.publicId,
      userMongoId: key,
      name: publicPromoterName(user),
      description: user.roleProfile?.bio || user.roleProfile?.focus || 'Verified Classic Mart marketplace promoter.',
      focus: user.roleProfile?.focus || '',
      location: user.roleProfile?.location || '',
      country: user.country,
      locale: user.locale || country?.locale || 'en-UG',
      image: '/assets/image-placeholder.svg',
      channels: verification.channels || [],
      niches: verification.niches || [],
      campaignCount: userCampaigns.length,
      linkCount: linkCountByUser.get(key) || 0,
      clicks: Number(touches.clicks || 0),
      conversions: Number(touches.conversions || 0),
      earnedMinor: Number(commission.earnedMinor || 0),
      campaigns: userCampaigns.map((campaign) => ({
        id: campaign.publicId,
        name: campaign.name,
        facts: (campaign.facts || []).slice(0, 4),
        disclosure: campaign.disclosureText,
        productPublicIds: campaign.productPublicIds || [],
      })),
      products,
    });
  }
  return {items:rows.sort((a, b) => b.conversions - a.conversions || b.clicks - a.clicks || a.name.localeCompare(b.name)),page};
}

export async function publicPromoters(country, options={}) {
  return promoterPublicRows(country,options);
}

export async function publicPromoter(verificationPublicId, country) {
  const result = await promoterPublicRows(country, { verificationPublicId, includeProducts: true });
  return result.items[0] || null;
}

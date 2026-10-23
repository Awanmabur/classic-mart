import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { AiJob, AttributionTouch, Brand, Campaign, CampaignApplication, Category, CountrySetting, Device, Product, ProductVariant, PromoterLink, PromoterVerification, Store, StoreMember, User } from '../models/index.js';
import { promoterAccess } from './promoter-workspace-access.js';
import { hasPublicProductApproval } from './storefront.js';
import { cursorScope, cursorSort, decodeCursor, pageResult, encodeCursor } from './pagination.js';
import { marketplacePromoterCampaignPublicId } from './seller-growth.js';
import { writeAudit } from './audit.js';
import { currentRequestDevice } from './moderation-workspace-access.js';
import { countryAdminPersonalAccountEligible } from './country-admin-people-actions.js';

const recordId = z.string().trim().regex(/^[a-z][a-z0-9_-]{4,99}$/, 'Choose a valid record.');
const revision = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const text = max => z.string().trim().max(max);
const list = (value, max) => z.array(z.string().trim().min(2).max(50)).min(1).max(max).parse(Array.isArray(value) ? value : String(value || '').split(',').map(item => item.trim()).filter(Boolean));
const key = value => String(value);
const literalRegex = value => new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const checked = value => [true, 'true', 'yes', 'on', '1'].includes(value);
const plain = row => row?.toObject ? row.toObject() : row;
const liveScope = country => ({ country, status: 'active', $and: [{ $or: [{ startsAt: null }, { startsAt: { $lte: new Date() } }] }, { $or: [{ endsAt: null }, { endsAt: { $gt: new Date() } }] }] });
const pathFor = mode => '/promoter/' + mode;
const normalizeAccess = access => ({ ...access, countrySetting: access.country, country: typeof access.country === 'string' ? access.country : access.country.code,
  market: { ...access.market, locale: access.country?.locale || access.market.locale, name: access.country?.name || access.market.name } });

function assertVersion(row, expected, label = 'Record') {
  if (expected !== undefined && expected !== null && expected !== '' && (row?.__v || 0) !== revision.parse(expected)) throw new AppError(`${label} changed. Reload the page before continuing.`, 409, 'PROMOTER_VERSION_CONFLICT');
}
async function fence(Model, row, session, extra = {}) {
  const result = await Model.updateOne({ _id: row._id, __v: row.__v || 0, ...extra }, { $inc: { __v: 1 } }, { session });
  if (result.modifiedCount !== 1) throw new AppError('Access changed. Reload the page before continuing.', 409, 'PROMOTER_ACCESS_CHANGED');
}
async function transaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await work(session); });
    return result;
  } catch (error) {
    if (error.code === 11000) throw new AppError('This promoter code or campaign application already exists.', 409, 'PROMOTER_DUPLICATE');
    if (error.name === 'VersionError') throw new AppError('The record changed. Reload the page before continuing.', 409, 'PROMOTER_VERSION_CONFLICT');
    throw error;
  } finally { await session.endSession(); }
}
async function programmeAccess(request, session, { verified = true } = {}) {
  // These mutations apply their own optimistic fences after comparing client revisions.
  const access = normalizeAccess(await promoterAccess(request, { session }));
  const device = await currentRequestDevice(request, { userId: access.actor._id, session });
  if (request.sessionID !== undefined && !device) throw new AppError('Your current promoter device is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
  if (verified && access.verification?.status !== 'verified') throw new AppError('Verified promoter account required.', 403, 'PROMOTER_VERIFICATION_REQUIRED');
  return { ...access, device };
}
async function fenceAccess(access, session, { verification = true } = {}) {
  await fence(User, access.actor, session, { role: 'promoter', status: 'active', 'security.tokenVersion': access.actor.security.tokenVersion });
  await fence(CountrySetting, access.countrySetting, session, { active: true, currency: access.market.currency });
  if (verification && access.verification) await fence(PromoterVerification, access.verification, session, { status: access.verification.status, country: access.country });
  if (access.device) await fence(Device, access.device, session, { userId: access.actor._id, revokedAt: null, sessionHash: access.device.sessionHash });
}

async function approvedProductRows(products, access, session = null) {
  if (!products.length) return [];
  const reads = [
    () => Category.find({ _id: mongoose.trusted({ $in: products.map(row => row.categoryId) }), active: true }).session(session).lean(),
    () => Store.find({ _id: mongoose.trusted({ $in: products.map(row => row.storeId) }), status: 'verified', country: access.country, currency: access.market.currency }).session(session).lean(),
    () => Brand.find({ _id: mongoose.trusted({ $in: products.map(row => row.brandId).filter(Boolean) }), status: 'approved' }).session(session).lean(),
    () => ProductVariant.find({ productId: mongoose.trusted({ $in: products.map(row => row._id) }), active: true, currency: access.market.currency, priceMinor: mongoose.trusted({ $gt: 0 }) }).session(session).select('productId storeId priceMinor').lean(),
  ];
  // Driver transactions require sequential operations on their shared session.
  const results = session ? [] : await Promise.all(reads.map(read => read()));
  if (session) for (const read of reads) results.push(await read());
  const [categories, stores, brands, variants] = results;
  const owners = await User.find({ _id: mongoose.trusted({ $in: stores.map(row => row.ownerUserId) }), status: 'active' }).session(session).select('_id').lean();
  const ownerIds = new Set(owners.map(row => key(row._id)));
  const categoryById = new Map(categories.map(row => [key(row._id), row])), storeById = new Map(stores.filter(row => ownerIds.has(key(row.ownerUserId))).map(row => [key(row._id), row])), brandIds = new Set(brands.map(row => key(row._id)));
  return products.filter(row => {
    const category = categoryById.get(key(row.categoryId)), store = storeById.get(key(row.storeId));
    return category && (!category.countries.length || category.countries.includes(access.country)) && store && (!row.brandId || brandIds.has(key(row.brandId))) && hasPublicProductApproval(row, category, store)
      && variants.some(variant => key(variant.productId) === key(row._id) && key(variant.storeId) === key(row.storeId) && Number.isSafeInteger(variant.priceMinor));
  }).map(row => ({ ...row, href: '/products/' + encodeURIComponent(row.publicId) }));
}
async function approvedProducts(campaign, access, session = null, { productId = '' } = {}) {
  if (campaign.scope === 'marketplace' && !productId) return [];
  const scope = { status: 'published', countries: access.country };
  if (campaign.scope !== 'marketplace') { scope.publicId = mongoose.trusted({ $in: campaign.productPublicIds || [] }); scope.storeId = campaign.storeId; }
  else scope.publicId = productId;
  return approvedProductRows(await Product.find(scope).session(session).lean(), access, session);
}
async function assertNotSelf(campaign, access, session) {
  if (campaign.scope === 'marketplace') return;
  if (key(campaign.ownerUserId) === key(access.actor._id) || await StoreMember.exists({ storeId: campaign.storeId, userId: access.actor._id, status: 'active' }).session(session)) throw new AppError('You cannot promote a store you operate.', 409, 'SELF_REFERRAL');
}
async function campaignAccess(request, campaignPublicId, input, session, { approval = false } = {}) {
  const access = await programmeAccess(request, session);
  const campaign = await Campaign.findOne({ ...liveScope(access.country), publicId: recordId.parse(campaignPublicId) }).session(session);
  if (!campaign) throw new AppError('Active campaign not found.', 404, 'CAMPAIGN_NOT_FOUND');
  assertVersion(campaign, input?.campaignVersion, 'Campaign');
  if (campaign.scope === 'marketplace') {
    const setting = await CountrySetting.findOne({ code: access.country, active: true }).session(session);
    if (!setting || !campaign.systemManaged || campaign.publicId !== marketplacePromoterCampaignPublicId(access.country) || Number(setting.growth?.promoterCommissionBps || 0) <= 0 || campaign.commissionBps !== setting.growth.promoterCommissionBps) throw new AppError('Marketplace programme policy changed. Reload before continuing.', 409, 'CAMPAIGN_POLICY_CHANGED');
  } else if (!await Store.exists({ _id: campaign.storeId, ownerUserId: campaign.ownerUserId, status: 'verified', country: access.country, currency: access.market.currency }).session(session)) {
    throw new AppError('The campaign merchant is unavailable.', 409, 'CAMPAIGN_PRODUCT_SCOPE');
  }
  if (campaign.scope !== 'marketplace' && (!campaign.reviewedByUserId || !campaign.reviewedAt || [campaign.ownerUserId, campaign.createdByUserId, campaign.submittedByUserId].some(value => value && key(value) === key(campaign.reviewedByUserId)))) throw new AppError('An independently reviewed Seller campaign is required.', 409, 'CAMPAIGN_REVIEW_REQUIRED');
  await assertNotSelf(campaign, access, session);
  const products = await approvedProducts(campaign, access, session);
  if (campaign.scope !== 'marketplace' && (!products.length || products.length !== new Set(campaign.productPublicIds).size)) throw new AppError('The campaign products are unavailable.', 409, 'CAMPAIGN_PRODUCT_SCOPE');
  const application = await CampaignApplication.findOne({ campaignId: campaign._id, promoterUserId: access.actor._id, country: access.country }).session(session);
  if (approval && application?.status !== 'approved') throw new AppError('Campaign approval is required.', 403, 'CAMPAIGN_APPROVAL_REQUIRED');
  assertVersion(application, input?.applicationVersion, 'Application');
  return { ...access, campaign, application, products };
}
async function fenceCampaign(access, session) {
  await fenceAccess(access, session);
  await fence(Campaign, access.campaign, session, { status: 'active', country: access.country });
  if (access.application) await fence(CampaignApplication, access.application, session, { status: access.application.status });
  // Product and merchant approval revocations must conflict with a simultaneous write.
  for (const product of access.products) {
    await fence(Product, product, session, { status: 'published', countries: access.country });
    const store = await Store.findById(product.storeId).session(session).lean();
    if (!store || store.status !== 'verified') throw new AppError('The merchant is unavailable.', 409, 'CAMPAIGN_PRODUCT_SCOPE');
    await fence(Store, store, session, { status: 'verified' });
    const owner = await User.findOne({ _id: store.ownerUserId, status: 'active' }).session(session).lean();
    if (!owner) throw new AppError('The merchant account is unavailable.', 409, 'CAMPAIGN_PRODUCT_SCOPE');
    await fence(User, owner, session, { status: 'active' });
    const category = await Category.findById(product.categoryId).session(session).lean();
    if (!category?.active) throw new AppError('The product category is unavailable.', 409, 'CAMPAIGN_PRODUCT_SCOPE');
    await fence(Category, category, session, { active: true });
    if (product.brandId) {
      const brand = await Brand.findById(product.brandId).session(session).lean();
      if (!brand || brand.status !== 'approved') throw new AppError('The product brand is unavailable.', 409, 'CAMPAIGN_PRODUCT_SCOPE');
      await fence(Brand, brand, session, { status: 'approved' });
    }
    const variant = await ProductVariant.findOne({ productId: product._id, storeId: product.storeId, active: true, currency: access.market.currency, priceMinor: mongoose.trusted({ $gt: 0 }) }).session(session).lean();
    if (!variant || !Number.isSafeInteger(variant.priceMinor)) throw new AppError('The product offer is unavailable.', 409, 'CAMPAIGN_PRODUCT_SCOPE');
    await fence(ProductVariant, variant, session, { active: true });
  }
}

export function validatePromoterDestination(value) {
  const destination = z.string().trim().min(1).max(500).parse(value);
  if (destination.includes('\\') || destination.includes('%') || destination.includes('?') || destination.includes('#') || /[\u0000-\u0020]/u.test(destination)) throw new AppError('Choose a local product or marketplace destination.', 422, 'PROMOTER_DESTINATION_INVALID');
  if (!/^\/products\/[a-z][a-z0-9_-]{4,99}$/.test(destination) && destination !== '/products' && destination !== '/') throw new AppError('Choose a local product or marketplace destination.', 422, 'PROMOTER_DESTINATION_INVALID');
  return destination;
}
export const promoterDestination = validatePromoterDestination;
async function destinationFor(value, access, session) {
  const destination = validatePromoterDestination(value);
  if (destination === '/' || destination === '/products') {
    if (access.campaign.scope !== 'marketplace') throw new AppError('Choose an approved product in this campaign.', 422, 'CAMPAIGN_PRODUCT_SCOPE');
    return destination;
  }
  const productId = destination.slice('/products/'.length);
  const product = access.products.find(row => row.publicId === productId) || (access.campaign.scope === 'marketplace' ? (await approvedProducts(access.campaign, access, session, { productId }))[0] : null);
  if (!product) throw new AppError('Choose an approved product in this campaign and country.', 422, 'CAMPAIGN_PRODUCT_SCOPE');
  if (key(product.ownerUserId) === key(access.actor._id) || await StoreMember.exists({ storeId: product.storeId, userId: access.actor._id, status: 'active' }).session(session)) throw new AppError('You cannot promote a store you operate.', 409, 'SELF_REFERRAL');
  if (!access.products.some(row => row.publicId === product.publicId)) access.products.push(product);
  return destination;
}
export async function assertPromoterLinkDestination(request, link, campaign, { session = null } = {}) {
  const setting = await CountrySetting.findOne({ code: campaign.country, active: true }).session(session).lean();
  if (!setting || campaign.country !== request.country?.code) throw new AppError('Campaign is unavailable in this country.', 403, 'COUNTRY_SCOPE');
  const actor = await User.findOne({ _id: link.promoterUserId, role: 'promoter', status: 'active', emailVerifiedAt: mongoose.trusted({ $ne: null }), onboardingCompletedAt: mongoose.trusted({ $ne: null }) }).session(session).lean();
  const verification = actor && await PromoterVerification.findOne({ userId: actor._id, country: campaign.country, status: 'verified' }).session(session).lean();
  const application = actor && await CampaignApplication.findOne({ campaignId: campaign._id, promoterUserId: actor._id, country: campaign.country, status: 'approved' }).session(session).lean();
  if (!actor || !verification || !application) throw new AppError('This promoter programme access is unavailable.', 410, 'PROMOTER_PROGRAMME_UNAVAILABLE');
  if (campaign.scope !== 'marketplace' && (!campaign.reviewedByUserId || !campaign.reviewedAt || !application.reviewedByUserId || !application.reviewedAt
    || [campaign.ownerUserId, campaign.createdByUserId, campaign.submittedByUserId].some(value => value && key(value) === key(campaign.reviewedByUserId)))) throw new AppError('Independent campaign and Seller application approval are required.', 410, 'CAMPAIGN_REVIEW_REQUIRED');
  if (campaign.scope === 'marketplace' && (!campaign.systemManaged || campaign.publicId !== marketplacePromoterCampaignPublicId(campaign.country) || Number(setting.growth?.promoterCommissionBps || 0) <= 0 || Number(campaign.commissionBps) !== Number(setting.growth.promoterCommissionBps))) throw new AppError('Marketplace promoter policy changed.', 410, 'CAMPAIGN_POLICY_CHANGED');
  if (campaign.scope !== 'marketplace' && !await Store.exists({ _id: campaign.storeId, ownerUserId: campaign.ownerUserId, status: 'verified', country: campaign.country, currency: setting.currency }).session(session)) throw new AppError('The campaign merchant is unavailable.', 410, 'CAMPAIGN_PRODUCT_SCOPE');
  const access = { actor, verification, application, campaign, country: campaign.country, market: { country: campaign.country, currency: setting.currency, timeZone: setting.timeZone }, products: [] };
  await assertNotSelf(campaign, access, session);
  if (campaign.scope !== 'marketplace') {
    access.products = await approvedProducts(campaign, access, session);
    if (!access.products.length || access.products.length !== new Set(campaign.productPublicIds).size) throw new AppError('The campaign products are unavailable.', 410, 'CAMPAIGN_PRODUCT_SCOPE');
  }
  return destinationFor(link.destination, access, session);
}
function linkInput(input) {
  return z.object({ destination: z.string(), channel: text(50).default(''), couponCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{0,32}$/, 'Use letters, digits, dashes or underscores for your code.').default(''), subId: text(80).default(''), utmSource: text(80).default('classicmart-promoter'), utmMedium: text(80).default('affiliate'), utmCampaign: text(100).default(''), utmContent: text(100).default('') }).parse(input);
}
async function insertLink(request, input, access, session) {
  const parsed = linkInput(input), destination = await destinationFor(parsed.destination, access, session);
  if (parsed.channel && access.campaign.allowedChannels.length && !access.campaign.allowedChannels.includes(parsed.channel)) throw new AppError('That channel is not allowed for this campaign.', 422, 'CAMPAIGN_CHANNEL_NOT_ALLOWED');
  const [link] = await PromoterLink.create([{ ...parsed, publicId: publicId('plk'), campaignId: access.campaign._id, promoterUserId: access.actor._id, token: crypto.randomBytes(18).toString('base64url'), destination, utmCampaign: parsed.utmCampaign || access.campaign.publicId }], { session });
  await writeAudit(request, 'promoter.link_created', { session, actor: access.actor, targetType: 'promoter_link', targetPublicId: link.publicId, country: access.country, metadata: { campaignPublicId: access.campaign.publicId, destination, channel: parsed.channel } });
  return link;
}
export async function secureApplyToCampaign(request, campaignId, note = '', input = request.body || {}) {
  const applicationNote = text(1000).parse(note);
  return transaction(async session => {
    const access = await campaignAccess(request, campaignId, input, session);
    if (access.application) return access.application;
    await fenceCampaign(access, session);
    const automaticallyApproved = access.campaign.scope === 'marketplace' && access.campaign.systemManaged && access.campaign.visibility === 'public';
    const [application] = await CampaignApplication.create([{ publicId: publicId('cap'), campaignId: access.campaign._id, campaignPublicId: access.campaign.publicId, promoterUserId: access.actor._id, country: access.country, note: applicationNote, status: automaticallyApproved ? 'approved' : 'pending', ...(automaticallyApproved ? { reviewedAt: new Date() } : {}) }], { session });
    await writeAudit(request, 'promoter.campaign_applied', { session, actor: access.actor, targetType: 'campaign_application', targetPublicId: application.publicId, country: access.country, metadata: { campaignPublicId: access.campaign.publicId, status: application.status } });
    return application;
  });
}
export async function secureCreatePromoterLink(request, input) {
  return transaction(async session => {
    const access = await campaignAccess(request, input.campaignId, input, session, { approval: true });
    const link = await insertLink(request, input, access, session);
    await fenceCampaign(access, session);
    return link;
  });
}
export async function updatePromoterLink(request, { deactivate = false } = {}) {
  const version = revision.parse(request.body.version);
  return transaction(async session => {
    const access = await programmeAccess(request, session, { verified: !deactivate });
    const link = await PromoterLink.findOne({ publicId: recordId.parse(request.params.id), promoterUserId: access.actor._id }).session(session);
    if (!link) throw new AppError('Tracking link not found.', 404, 'PROMO_LINK_NOT_FOUND');
    assertVersion(link, version, 'Link');
    const campaign = await Campaign.findOne({ _id: link.campaignId, country: access.country }).session(session);
    if (!campaign) throw new AppError('Tracking link not found.', 404, 'PROMO_LINK_NOT_FOUND');
    if (deactivate) { await fenceAccess(access, session); link.active = false; }
    else {
      const current = await campaignAccess(request, campaign.publicId, {}, session, { approval: true });
      const parsed = linkInput({ ...plain(link), ...request.body });
      link.destination = await destinationFor(parsed.destination, current, session);
      if (parsed.channel && current.campaign.allowedChannels.length && !current.campaign.allowedChannels.includes(parsed.channel)) throw new AppError('That channel is not allowed for this campaign.', 422, 'CAMPAIGN_CHANNEL_NOT_ALLOWED');
      link.channel = parsed.channel; link.subId = parsed.subId;
      await fenceCampaign(current, session);
    }
    link.markModified('active'); await link.save({ session });
    await writeAudit(request, deactivate ? 'promoter.link_deactivated' : 'promoter.link_updated', { session, actor: access.actor, targetType: 'promoter_link', targetPublicId: link.publicId, country: access.country });
    return link;
  });
}

export function safeCampaignAssetUrl(value) {
  const url = String(value || '').trim();
  if (/^\/(?:assets\/[A-Za-z0-9/_-]+\.(?:png|jpe?g|webp|svg|mp4|pdf)|media\/catalogue\/[a-z][a-z0-9_-]{4,99})$/.test(url)) return url;
  // Keep asset delivery on catalogue storage; arbitrary remote URLs may contain private credentials.
  return '';
}
export async function secureBuildCampaignContentKit(request, input) {
  return transaction(async session => {
    const access = await campaignAccess(request, input.campaignId, input, session, { approval: true });
    const destination = input.destination || (access.campaign.scope === 'marketplace' ? '/products' : access.products[0]?.href);
    const link = await insertLink(request, { ...input, destination, utmContent: 'content-studio' }, access, session);
    await fenceCampaign(access, session);
    const campaign = access.campaign, channel = String(input.channel || '').trim(), facts = campaign.facts.map(fact => text(1000).parse(fact)).filter(Boolean).slice(0, 4);
    const disclosure = campaign.disclosureText || 'Sponsored/affiliate promotion for Classic Mart.', factSentence = facts.length ? facts.join(' • ') : 'See the approved Classic Mart listing for current product details.', trackedUrl = '/r/' + link.token;
    const result = { campaignId: campaign.publicId, campaignName: campaign.name, channel, trackedUrl, couponCode: link.couponCode || '', disclosure,
      caption: `${campaign.name}: ${factSentence} ${disclosure} Shop: ${trackedUrl}`,
      whatsapp: `Classic Mart — ${campaign.name}\n${factSentence}\n${disclosure}\n${trackedUrl}`,
      posterText: `${campaign.name}\n${facts[0] || 'See the approved Classic Mart listing for current product details.'}\n${disclosure}`,
      hashtags: '#ClassicMart #Sponsored', approvedFacts: facts, assets: campaign.assets.filter(asset => asset.approved && safeCampaignAssetUrl(asset.url)).map(asset => ({ type: asset.type, label: asset.label, url: safeCampaignAssetUrl(asset.url) })),
      policyVersion: campaign.policyVersion, generator: 'approved-campaign-facts', linkPublicId: link.publicId, locale: access.market.locale };
    const [kit] = await AiJob.create([{ publicId: publicId('aij'), type: 'promoter_content', status: 'completed', country: access.country, actorUserId: access.actor._id, provider: 'deterministic', model: 'approved-campaign-facts', resultSchemaKey: 'promoter_content_kit', input: { campaignPublicId: campaign.publicId, channel }, result, completedAt: new Date(), approval: { status: 'approved', reviewedAt: new Date() } }], { session });
    await writeAudit(request, 'promoter.content_kit_created', { session, actor: access.actor, targetType: 'ai_job', targetPublicId: kit.publicId, country: access.country, metadata: { campaignPublicId: campaign.publicId, generator: result.generator } });
    return { ...result, publicId: kit.publicId };
  });
}

export async function secureSubmitPromoterVerification(request, input) {
  if (!checked(input.disclosureAccepted)) throw new AppError('Accept the affiliate disclosure policy before submitting.', 422, 'PROMOTER_DISCLOSURE_REQUIRED');
  const channels = list(input.channels, 10), niches = list(input.niches, 12);
  const audienceSize = z.coerce.number().int().min(0).max(1_000_000_000).parse(input.audienceSize || 0), audienceLocation = text(180).parse(input.audienceLocation || '');
  return transaction(async session => {
    const access = await programmeAccess(request, session, { verified: false });
    if (!await countryAdminPersonalAccountEligible(access.actor, 'promoter', session)) throw new AppError('A personal Promoter account is required.', 403, 'PROMOTER_WORKSPACE_FORBIDDEN');
    const device = await currentRequestDevice(request, { userId: access.actor._id, session });
    assertVersion(access.verification, input.verificationVersion, 'Verification');
    await fenceAccess(access, session, { verification: false });
    if (device) await fence(Device, device, session, { userId: access.actor._id, sessionHash: device.sessionHash, revokedAt: null });
    const row = access.verification || new PromoterVerification({ publicId: publicId('prv'), userId: access.actor._id, country: access.country });
    row.channels = channels; row.niches = niches; row.audienceSize = audienceSize; row.audienceLocation = audienceLocation;
    row.status = 'submitted'; row.disclosureAcceptedAt = new Date(); row.submittedAt = new Date(); row.reason = '';
    row.assignedUserId = null; row.assignedAt = null; row.reviewedAt = null; row.reviewedByUserId = null;
    row.appeal = { message: '' };
    row.markModified('status'); await row.save({ session });
    await writeAudit(request, 'promoter.verification_submitted', { session, actor: access.actor, targetType: 'promoter_verification', targetPublicId: row.publicId, country: access.country, metadata: { disclosureAccepted: true } });
    return row;
  });
}
export async function savePromoterProfile(request, section) {
  const version = revision.parse(request.body.version);
  return transaction(async session => {
    const access = await programmeAccess(request, session, { verified: false });
    assertVersion(access.actor, version, 'Profile');
    const actor = access.actor, input = request.body;
    if (section === 'identity') {
      actor.name = z.string().trim().min(2).max(120).parse(input.name);
      actor.roleProfile.publicName = text(100).parse(input.publicName || ''); actor.roleProfile.bio = text(1000).parse(input.bio || '');
    } else if (section === 'preferences') {
      actor.preferences.lowData = checked(input.lowData);
      actor.preferences.promoterMessages = checked(input.promoterMessages);
      actor.consents.marketing = checked(input.marketing); actor.consents.recordedAt = new Date();
    } else if (section === 'channels') {
      const row = access.verification || new PromoterVerification({ publicId: publicId('prv'), userId: actor._id, country: access.country });
      assertVersion(access.verification, input.verificationVersion, 'Verification');
      if (['verified', 'submitted', 'appealed'].includes(row.status)) throw new AppError('Submit updated channels for review using the disclosure form.', 409, 'PROMOTER_REVIEW_REQUIRED');
      row.channels = list(input.channels, 10); row.niches = list(input.niches, 12);
      row.audienceSize = z.coerce.number().int().min(0).max(1_000_000_000).parse(input.audienceSize || 0); row.audienceLocation = text(180).parse(input.audienceLocation || '');
      await row.save({ session });
    } else throw new AppError('Choose a valid profile section.', 422, 'PROFILE_SECTION_INVALID');
    actor.markModified('roleProfile'); await actor.save({ session });
    // Force a revision even for an unchanged preferences form so stale saves are rejected.
    if (!actor.isNew && actor.__v === version) await fence(User, actor, session, { role: 'promoter', status: 'active' });
    await writeAudit(request, 'promoter.profile_saved', { session, actor, targetType: 'user', targetPublicId: actor.publicId, country: access.country, metadata: { section } });
    return actor;
  });
}

async function ensureProgramme(access) {
  const commissionBps = Number(access.countrySetting.growth?.promoterCommissionBps || 0);
  const current = await Campaign.findOne({ publicId: marketplacePromoterCampaignPublicId(access.country) }).select('status commissionBps scope systemManaged').lean();
  if (current?.scope === 'marketplace' && current.systemManaged && current.commissionBps === commissionBps && current.status === (commissionBps > 0 ? 'active' : 'paused')) return;
  const { ensureMarketplacePromoterCampaign } = await import('./promoters.js');
  await ensureMarketplacePromoterCampaign(access.country);
}

/** The dashboard and public API share eligibility checks; each chunk uses batched catalogue reads. */
export async function eligiblePromoterCampaigns(countrySetting, { visibility = '', session = null, limit = null, after = '', search = '' } = {}) {
  if (!countrySetting?.active || !countrySetting.code || !countrySetting.currency) return limit === null ? [] : { items: [], page: { count: 0, total: null, hasMore: false, next: '', direction: -1 } };
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw new AppError('Choose a valid campaign page size.', 422, 'CAMPAIGN_QUERY_INVALID');
  if (after && !decodeCursor(after)) throw new AppError('Reload the campaign list before continuing.', 422, 'CAMPAIGN_QUERY_INVALID');
  const access = { country: countrySetting.code, market: { currency: countrySetting.currency } };
  const base = { ...liveScope(access.country), ...(visibility ? { visibility } : {}), ...(search ? { name: literalRegex(String(search).slice(0, 100)) } : {}) };
  const output = [], wanted = limit === null ? null : limit + 1; let cursor = after;
  while (wanted === null || output.length < wanted) {
    const rows = await Campaign.find(cursorScope(base, cursor)).sort(cursorSort()).limit(100).session(session).lean();
    if (!rows.length) break;
    const productIds = [...new Set(rows.flatMap(row => row.scope === 'marketplace' ? [] : row.productPublicIds || []))];
    const products = productIds.length ? await approvedProductRows(await Product.find({ publicId: mongoose.trusted({ $in: productIds }), status: 'published', countries: access.country }).session(session).lean(), access, session) : [];
    const stores = await Store.find({ _id: mongoose.trusted({ $in: rows.map(row => row.storeId).filter(Boolean) }), country: access.country, currency: countrySetting.currency, status: 'verified' }).session(session).select('ownerUserId').lean();
    const storeOwners = new Map(stores.map(row => [key(row._id), key(row.ownerUserId)]));
    for (const row of rows) {
      const campaignProducts = products.filter(product => key(product.storeId) === key(row.storeId) && (row.productPublicIds || []).includes(product.publicId));
      const marketplaceEligible = row.scope === 'marketplace' && row.systemManaged && row.publicId === marketplacePromoterCampaignPublicId(access.country)
        && Number(countrySetting.growth?.promoterCommissionBps || 0) > 0 && row.commissionBps === Number(countrySetting.growth.promoterCommissionBps);
      const sellerEligible = row.scope === 'seller' && campaignProducts.length > 0 && campaignProducts.length === new Set(row.productPublicIds).size && storeOwners.get(key(row.storeId)) === key(row.ownerUserId);
      if (marketplaceEligible || sellerEligible) output.push({ ...row, products: campaignProducts });
      if (wanted !== null && output.length === wanted) break;
    }
    if (rows.length < 100) break;
    cursor = encodeCursor(rows.at(-1));
  }
  if (limit === null) return output;
  const paged = pageResult(output, { limit });
  paged.page.total = null;
  return paged;
}
export function publicCampaignMetadata(row) {
  return { publicId: row.publicId, name: row.name, country: row.country, scope: row.scope, status: row.status, visibility: row.visibility,
    commissionBps: row.commissionBps, attributionDays: row.attributionDays, policyVersion: row.policyVersion, startsAt: row.startsAt, endsAt: row.endsAt };
}
async function availableCampaigns(access) { return eligiblePromoterCampaigns(access.countrySetting); }
function applicationDTO(row) {
  if (!row) return null;
  return { publicId: row.publicId, campaignPublicId: row.campaignPublicId, status: row.status, note: row.note, reason: row.reason, reviewedAt: row.reviewedAt, createdAt: row.createdAt, __v: row.__v || 0 };
}
function verificationDTO(row) {
  if (!row) return null;
  return { publicId: row.publicId, country: row.country, status: row.status, channels: row.channels, niches: row.niches, audienceSize: row.audienceSize,
    audienceLocation: row.audienceLocation, reason: row.reason, disclosureAcceptedAt: row.disclosureAcceptedAt, submittedAt: row.submittedAt, reviewedAt: row.reviewedAt,
    appeal: row.appeal?.submittedAt ? { message: row.appeal.message, submittedAt: row.appeal.submittedAt } : null, __v: row.__v || 0 };
}
function campaignDTO(campaign, application) {
  const allowed = campaign.visibility === 'public' || application?.status === 'approved';
  return { ...publicCampaignMetadata(campaign), allowedChannels: allowed ? campaign.allowedChannels : [], __v: campaign.__v || 0, promoterApplication: applicationDTO(application), applicationVersion: application?.__v || 0,
    disclosureText: allowed ? campaign.disclosureText : '', facts: allowed ? campaign.facts : [], assets: allowed ? campaign.assets.filter(asset => asset.approved && safeCampaignAssetUrl(asset.url)).map(asset => ({ label: asset.label, type: asset.type, url: safeCampaignAssetUrl(asset.url) })) : [], products: allowed ? campaign.products.map(row => ({ publicId: row.publicId, title: row.title, href: row.href })) : [] };
}
function filtersFor(request, statuses) {
  const originalQuery = new URL(request.originalUrl || '/promoter/marketplace', 'http://localhost').searchParams;
  for (const name of ['search', 'status', 'after', 'brand', 'campaign', 'link', 'kit']) {
    if (originalQuery.getAll(name).length > 1 || [...originalQuery.keys()].some(item => item.startsWith(name + '[') || item.startsWith(name + '.'))) throw new AppError('Choose one value for each campaign filter.', 422, 'CAMPAIGN_QUERY_INVALID');
    const value = request.query[name];
    if (value !== undefined && (typeof value !== 'string' || value.length > (name === 'after' ? 512 : 100))) throw new AppError('Choose valid campaign filters.', 422, 'CAMPAIGN_QUERY_INVALID');
  }
  const search = String(request.query.search || '').trim(), status = String(request.query.status || '');
  if (status && !statuses.includes(status)) throw new AppError('Choose a valid campaign status.', 422, 'CAMPAIGN_QUERY_INVALID');
  if (request.query.after && !decodeCursor(request.query.after)) throw new AppError('Reload the campaign list before continuing.', 422, 'CAMPAIGN_QUERY_INVALID');
  return { search, status, statuses: [{ value: '', label: 'All' }, ...statuses.map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) }))], after: String(request.query.after || '').slice(0, 512), params: {} };
}
function metrics(items) { return items.map(([label, value, note]) => ({ label, value: String(value), detail: note || 'Current account records', change: '', tone: 'neutral' })); }
export async function promoterCampaignPage(request, mode) {
  const filters = filtersFor(request, mode === 'links' ? ['active', 'inactive'] : mode === 'content' ? ['completed'] : ['available', 'pending', 'approved', 'rejected', 'revoked']);
  const access = normalizeAccess(await promoterAccess(request));
  await ensureProgramme(access);
  let campaigns = await availableCampaigns(access);
  const brand = typeof request.query.brand === 'string' ? request.query.brand.trim().slice(0, 100) : '';
  if (brand) {
    const store = await Store.findOne({ publicId: recordId.parse(brand), country: access.country, currency: access.market.currency, status: 'verified' }).lean();
    if (!store || !await User.exists({ _id: store.ownerUserId, status: 'active' })) throw new AppError('Brand is unavailable in your promoter market.', 404, 'BRAND_NOT_FOUND');
    campaigns = campaigns.filter(row => key(row.storeId) === key(store._id));
  }
  const ids = campaigns.map(row => row._id);
  const applications = ids.length ? await CampaignApplication.find({ promoterUserId: access.actor._id, country: access.country, campaignId: mongoose.trusted({ $in: ids }) }).lean() : [];
  const applicationById = new Map(applications.map(row => [key(row.campaignId), row])), dtos = campaigns.map(row => campaignDTO(row, applicationById.get(key(row._id))));
  const approved = dtos.filter(row => row.promoterApplication?.status === 'approved');
  if (brand) { filters.params.brand = brand; filters.brand = brand; }
  const search = filters.search ? literalRegex(filters.search) : null;
  const rowHref = (name, value) => pathFor(mode) + '?' + new URLSearchParams({ ...filters.params, ...(filters.search ? { search: filters.search } : {}), ...(filters.status ? { status: filters.status } : {}), ...(filters.after ? { after: filters.after } : {}), [name]: value });
  const historicalCampaigns = await Campaign.find({ country: access.country }).select('publicId name country scope status visibility commissionBps attributionDays policyVersion startsAt endsAt createdAt __v storeId').lean();
  const historyIds = brand ? historicalCampaigns.filter(row => campaigns.some(campaign => key(campaign._id) === key(row._id))).map(row => row._id) : historicalCampaigns.map(row => row._id);
  const base = { promoterUserId: access.actor._id, campaignId: mongoose.trusted({ $in: mode === 'links' ? historyIds : ids }) };
  const [linkCount, activeLinkCount, kitCount, touchCount] = await Promise.all([PromoterLink.countDocuments(base), PromoterLink.countDocuments({ ...base, active: true }), AiJob.countDocuments({ actorUserId: access.actor._id, country: access.country, type: 'promoter_content', resultSchemaKey: 'promoter_content_kit' }), AttributionTouch.countDocuments({ promoterUserId: access.actor._id, country: access.country })]);
  let columns, rows, page, links = [], kits = [];
  if (mode === 'links') {
    const scope = { ...base, ...(filters.status ? { active: filters.status === 'active' } : {}), ...(search ? { $or: [{ destination: search }, { channel: search }, { couponCode: search }] } : {}) };
    const [found, total] = await Promise.all([PromoterLink.find(cursorScope(scope, filters.after)).sort(cursorSort()).limit(21).lean(), PromoterLink.countDocuments(scope)]);
    const result = pageResult(found, { limit: 20, total }); page = result.page;
    const names = new Map(historicalCampaigns.map(row => [key(row._id), row]));
    links = result.items.map(row => ({ publicId: row.publicId, destination: row.destination, channel: row.channel, couponCode: row.couponCode, subId: row.subId,
      active: row.active, createdAt: row.createdAt, __v: row.__v || 0, url: '/r/' + row.token, campaignName: names.get(key(row.campaignId))?.name || '', campaignPublicId: names.get(key(row.campaignId))?.publicId || '' }));
    columns = ['Tracking link', 'Campaign', 'Channel', 'Destination', 'Status']; rows = links.map(row => ({ id: row.publicId, cells: [row.publicId, row.campaignName, row.channel || 'Direct', row.destination, row.active ? 'Active' : 'Inactive'], href: rowHref('link', row.publicId) }));
  } else if (mode === 'content') {
    const scope = { actorUserId: access.actor._id, country: access.country, type: 'promoter_content', resultSchemaKey: 'promoter_content_kit', 'result.campaignId': mongoose.trusted({ $in: approved.map(row => row.publicId) }), ...(search ? { 'result.campaignName': search } : {}) };
    const [found, total] = await Promise.all([AiJob.find(cursorScope(scope, filters.after)).sort(cursorSort()).limit(21).lean(), AiJob.countDocuments(scope)]);
    const result = pageResult(found, { limit: 20, total }); page = result.page;
    kits = result.items.map(row => ({ publicId: row.publicId, createdAt: row.createdAt, status: row.status, campaignName: row.result.campaignName, campaignId: row.result.campaignId,
      channel: row.result.channel, caption: row.result.caption, whatsapp: row.result.whatsapp, posterText: row.result.posterText, hashtags: row.result.hashtags,
      trackedUrl: /^\/r\/[A-Za-z0-9_-]{4,100}$/.test(row.result.trackedUrl || '') ? row.result.trackedUrl : '', disclosure: row.result.disclosure,
      generator: row.result.generator, policyVersion: row.result.policyVersion, approvedFacts: row.result.approvedFacts,
      assets: (row.result.assets || []).filter(asset => safeCampaignAssetUrl(asset.url)).map(asset => ({ type: asset.type, label: asset.label, url: safeCampaignAssetUrl(asset.url) })) }));
    columns = ['Content kit', 'Campaign', 'Channel', 'Created', 'Status']; rows = kits.map(row => ({ id: row.publicId, cells: [row.publicId, row.campaignName, row.channel || 'Direct', new Date(row.createdAt).toLocaleDateString('en-GB', { timeZone: access.market.timeZone }), row.status], href: rowHref('kit', row.publicId) }));
  } else {
    let displayCampaigns = campaigns, records = dtos;
    if (mode === 'campaigns') {
      const history = await CampaignApplication.find({ promoterUserId: access.actor._id, country: access.country, campaignId: mongoose.trusted({ $in: historyIds }) }).lean();
      const historyById = new Map(history.map(row => [key(row.campaignId), row]));
      displayCampaigns = historicalCampaigns.filter(row => historyById.has(key(row._id)));
      records = displayCampaigns.map(row => dtos.find(campaign => campaign.publicId === row.publicId) || { ...publicCampaignMetadata(row), __v: row.__v || 0, promoterApplication: applicationDTO(historyById.get(key(row._id))), facts: [], assets: [], products: [], allowedChannels: [], historical: true });
    }
    let filtered = records;
    if (search) filtered = filtered.filter(row => search.test(row.name));
    if (filters.status) filtered = filtered.filter(row => (row.promoterApplication?.status || 'available') === filters.status);
    // The same validated cursor format is used after eligibility filtering, preserving the filtered total.
    const scope = cursorScope({}, filters.after), boundary = scope.$or;
    const ordered = filtered.map(row => ({ ...row, _id: displayCampaigns.find(item => item.publicId === row.publicId)._id, createdAt: displayCampaigns.find(item => item.publicId === row.publicId).createdAt })).sort((a, b) => +b.createdAt - +a.createdAt || key(b._id).localeCompare(key(a._id)));
    const selected = boundary ? ordered.filter(row => { const before = boundary[0].createdAt.$lt; return row.createdAt < before || (+row.createdAt === +before && key(row._id) < key(boundary[1]._id.$lt)); }) : ordered;
    const result = pageResult(selected.slice(0, 21), { limit: 20, total: filtered.length }); page = result.page;
    columns = ['Campaign', 'Commission', 'Attribution', 'Access', 'Application']; rows = result.items.map(row => ({ id: row.publicId, cells: [row.name, (row.commissionBps / 100).toFixed(2) + '%', row.attributionDays + ' days', row.historical ? 'Closed campaign' : row.visibility === 'invite_only' ? 'Approval required' : 'Public', row.promoterApplication?.status || 'Available'], href: row.historical ? '' : rowHref('campaign', row.publicId) }));
  }
  const selectedCampaign = dtos.find(row => row.publicId === String(request.query.campaign || '')) || null;
  if (request.query.campaign && !selectedCampaign) throw new AppError('Active campaign not found.', 404, 'CAMPAIGN_NOT_FOUND');
  const selectedLink = links.find(row => row.publicId === String(request.query.link || '')) || null, selectedKit = kits.find(row => row.publicId === String(request.query.kit || '')) || null;
  if ((request.query.link && !selectedLink) || (request.query.kit && !selectedKit)) throw new AppError('This saved promotion is unavailable on this page.', 404, 'PROMOTER_RECORD_NOT_FOUND');
  return { kind: 'campaigns', mode, market: access.market, verification: verificationDTO(access.verification), canPromote: access.verification?.status === 'verified', filters, page, columns, rows,
    metrics: metrics([['Available campaigns', campaigns.length], ['Approved campaigns', approved.length], ['Active tracking links', activeLinkCount], [mode === 'content' ? 'Saved content kits' : 'Attributed visits', mode === 'content' ? kitCount : touchCount]]),
    campaigns: approved, marketplaceCampaigns: dtos, links, kits, selectedLink, selectedKit,
    detail: selectedCampaign ? { campaign: selectedCampaign, application: selectedCampaign.promoterApplication, products: selectedCampaign.products, assets: selectedCampaign.assets, facts: selectedCampaign.facts } : null,
    insights: [{ title: 'Campaign access', text: 'Only active campaigns and approved products in ' + access.country + ' are available.' }, { title: 'Programme status', text: access.verification?.status === 'verified' ? 'Your promoter verification is current.' : 'Submit your channels and affiliate disclosure for review before applying or generating links.' }],
    health: { label: 'Programme verification', value: access.verification?.status === 'verified' ? 100 : 0,
      rows: [{ label: 'Verification', value: access.verification?.status || 'draft' }, { label: 'Operating market', value: access.country }, { label: 'Tracking links', value: linkCount }], note: 'Programme approval is required to apply to campaigns and create tracked promotional content.' },
    workflow: [{ title: 'Browse campaigns', text: campaigns.length + ' active campaigns are available in your operating market.', label: 'Browse', href: '/promoter/marketplace' }, { title: 'Review applications', text: applications.length + ' applications for currently active campaigns.', label: 'Review', href: '/promoter/campaigns' }, { title: 'Share tracked links', text: activeLinkCount + ' tracking links are active.', label: 'Create link', href: '/promoter/links' }, { title: 'Use approved copy', text: kitCount + ' content kits have been saved.', label: 'Create content', href: '/promoter/content' }],
    create: ['links', 'content'].includes(mode) ? { label: mode === 'links' ? 'Create Tracking Link' : 'Create Content Kit', href: '#promoterCampaignEditor' } : { label: 'Browse Campaign Marketplace', href: '/promoter/marketplace' },
    exportHref: pathFor(mode) + '/export.csv' + (filters.search || filters.status || brand ? '?' + new URLSearchParams({ ...filters.params, ...(filters.search ? { search: filters.search } : {}), ...(filters.status ? { status: filters.status } : {}) }) : ''), linkCount };
}
export async function promoterProfilePage(request) {
  const access = normalizeAccess(await promoterAccess(request)), actor = access.actor;
  const query = new URL(request.originalUrl || '/promoter/profile', 'http://localhost').searchParams;
  if (query.getAll('section').length > 1 || [...query.keys()].some(name => /^section(?:\[|\.)/.test(name)) || (request.query.section !== undefined && (typeof request.query.section !== 'string' || !['profile', 'business', 'notifications', 'security'].includes(request.query.section)))) throw new AppError('Choose a valid profile section.', 422, 'PROFILE_SECTION_INVALID');
  const section = ['profile', 'business', 'notifications', 'security'].includes(request.query.section) ? request.query.section : 'profile';
  return { market: access.market, actor: { publicId: actor.publicId, name: actor.name, email: actor.email, phone: actor.phone, country: actor.country,
    roleProfile: plain(actor.roleProfile), preferences: plain(actor.preferences), consents: { marketing: actor.consents.marketing }, security: { mfaEnabled: actor.security.mfaEnabled } },
    verification: verificationDTO(access.verification), version: actor.__v || 0, section,
    completion: Math.round([actor.name, actor.roleProfile?.publicName, actor.roleProfile?.bio, access.verification?.channels?.length, access.verification?.niches?.length].filter(Boolean).length / 5 * 100) };
}

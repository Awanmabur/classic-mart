import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { Campaign, CampaignApplication, Product, StoreMember, User, PromoterVerification, PromoterLink } from '../models/index.js';
import { sellerOperationsAccess, sellerTransaction, sellerVersion, sameSellerId, sellerConflict } from './seller-operations-access.js';
import { assertSellerCapacity } from './seller-entitlements.js';
import { writeAudit } from './audit.js';
import { cursorScope, cursorSort, pageResult } from './pagination.js';
import { queueCountryAdminAlert } from './country-admin-notifications.js';
import { clearSponsoredOfferCache } from './seller-growth.js';
const list = (value, max = 100) => z.array(z.string().trim().min(1).max(300)).max(max).parse(Array.isArray(value) ? value : String(value || '').split(/[\n,]/).map(value => value.trim()).filter(Boolean));
const campaignInput = z.object({ name: z.string().trim().min(3).max(140), visibility: z.enum(['public', 'invite_only']).default('public'), commissionBps: z.coerce.number().int().min(1).max(5000), attributionDays: z.coerce.number().int().min(1).max(90).default(30), disclosureText: z.string().trim().min(10).max(300), startsAt: z.union([z.string().max(40), z.date()]).optional(), endsAt: z.union([z.string().max(40), z.date()]).optional() });
const dto = row => ({ publicId: row.publicId, name: row.name, status: row.status, visibility: row.visibility, commissionBps: row.commissionBps, attributionDays: row.attributionDays, productPublicIds: row.productPublicIds, facts: row.facts, allowedChannels: row.allowedChannels, disclosureText: row.disclosureText, reviewReason: row.reviewReason, createdAt: row.createdAt, startsAt: row.startsAt, endsAt: row.endsAt, canResume: row.status === 'paused' && row.pausedBySeller, version: Number(row.__v || 0) });
function campaignValues(raw) {
  const input = campaignInput.parse(raw), products = list(raw.productPublicIds), facts = list(raw.facts, 30), channels = list(raw.allowedChannels, 20);
  if (!facts.length || channels.some(channel => channel.length > 50)) throw new AppError('Add factual claims and supported channel names of up to 50 characters.', 422, 'CAMPAIGN_CONTENT_REQUIRED');
  const date = value => value ? new Date(value) : null;
  const startsAt = date(input.startsAt), endsAt = date(input.endsAt);
  if (startsAt && !Number.isFinite(startsAt.getTime()) || endsAt && (!Number.isFinite(endsAt.getTime()) || endsAt <= (startsAt || new Date()))) throw new AppError('Choose a valid future campaign window.', 422, 'CAMPAIGN_WINDOW_INVALID');
  return { input, products, facts, channels, startsAt, endsAt };
}
async function validateProducts(store, ids, session) {
  if (!ids.length || ids.length !== new Set(ids).size) throw new AppError('Select distinct store products.', 422, 'CAMPAIGN_PRODUCTS_REQUIRED');
  const products = await Product.find({ publicId: { $in: ids }, storeId: store._id, ownerUserId: store.ownerUserId, countries: store.country, status: { $in: ['approved', 'published'] } }).session(session);
  if (products.length !== ids.length) throw new AppError('Every campaign product must be approved for this store and country.', 422, 'CAMPAIGN_PRODUCT_SCOPE');
  for (const product of products) {
    const fenced = await Product.updateOne({ _id: product._id, __v: product.__v || 0, status: product.status }, { $inc: { __v: 1 } }, { session });
    if (fenced.modifiedCount !== 1) throw sellerConflict();
  }
}
const audit = (request, action, context, row, session, metadata = {}) => writeAudit(request, action, { session, actor: context.actor, targetType: 'campaign', targetPublicId: row.publicId, country: context.store.country, metadata: { storePublicId: context.store.publicId, ...metadata } });
export async function createSellerAffiliateCampaign(request, raw) {
  const { input, products, facts, channels, startsAt, endsAt } = campaignValues(raw);
  return sellerTransaction(async session => {
    const context = await sellerOperationsAccess(request, 'growth', { session, write: true });
    if (context.store.status !== 'verified') throw new AppError('Verify the store before creating affiliate campaigns.', 409, 'STORE_REQUIRED');
    await assertSellerCapacity(context.store, 'campaigns', { session });
    await validateProducts(context.store, products, session);
    const [row] = await Campaign.create([{ publicId: publicId('cmp'), scope: 'seller', systemManaged: false, storeId: context.store._id, ownerUserId: context.store.ownerUserId, country: context.store.country, ...input, startsAt, endsAt, productPublicIds: products, facts, allowedChannels: channels, assets: [], createdByUserId: context.actor._id, status: 'draft' }], { session });
    await audit(request, 'seller.affiliate_campaign_created', context, row, session); return dto(row);
  });
}
export async function editSellerAffiliateCampaign(request, id, raw) {
  const { input, products, facts, channels, startsAt, endsAt } = campaignValues(raw);
  const version = z.coerce.number().int().nonnegative().parse(raw.version);
  return sellerTransaction(async session => {
    const context = await sellerOperationsAccess(request, 'growth', { session, write: true });
    const row = await Campaign.findOne({ publicId: id, storeId: context.store._id, ownerUserId: context.store.ownerUserId, country: context.store.country, scope: 'seller', systemManaged: false }).session(session);
    if (!row) throw new AppError('Campaign not found.', 404, 'CAMPAIGN_NOT_FOUND');
    sellerVersion(row, version);
    if (!['draft', 'rejected'].includes(row.status)) throw new AppError('Only an unpublished draft or rejected campaign may be edited.', 409, 'CAMPAIGN_STATE');
    await assertSellerCapacity(context.store, 'campaigns', { session, excludeId: row._id });
    await validateProducts(context.store, products, session);
    Object.assign(row, input, { productPublicIds: products, facts, allowedChannels: channels, startsAt, endsAt, status: 'draft', reviewedAt: undefined, reviewedByUserId: undefined, reviewReason: '', submittedAt: undefined, submittedByUserId: undefined, pausedBySeller: false });
    await row.save({ session }); await audit(request, 'seller.affiliate_campaign_edited', context, row, session); return dto(row);
  });
}
export async function transitionSellerAffiliateCampaign(request, id, raw) {
  const input = z.object({ action: z.enum(['submit', 'pause', 'resume', 'end']), version: z.coerce.number().int().nonnegative() }).parse(raw);
  const result = await sellerTransaction(async session => {
    const context = await sellerOperationsAccess(request, 'growth', { session, write: true });
    const row = await Campaign.findOne({ publicId: id, storeId: context.store._id, ownerUserId: context.store.ownerUserId, country: context.store.country, scope: 'seller', systemManaged: false }).session(session);
    if (!row) throw new AppError('Campaign not found.', 404, 'CAMPAIGN_NOT_FOUND');
    sellerVersion(row, input.version);
    if (input.action === 'submit') {
      if (!['draft', 'rejected'].includes(row.status) || !row.facts.length || !row.disclosureText || row.endsAt && row.endsAt <= new Date()) throw new AppError('Add factual claims, products and disclosure to an eligible draft before submitting.', 409, 'CAMPAIGN_STATE');
      await assertSellerCapacity(context.store, 'campaigns', { session, excludeId: row._id });
      await validateProducts(context.store, row.productPublicIds, session);
      row.status = 'submitted'; row.submittedAt = new Date(); row.submittedByUserId = context.actor._id; row.reviewReason = ''; row.reviewedByUserId = undefined; row.reviewedAt = undefined;
      await queueCountryAdminAlert({ country: row.country, kind: 'priority', sourceType: 'campaign', sourcePublicId: row.publicId }, session);
    } else if (input.action === 'resume') {
      if (row.status !== 'paused' || !row.pausedBySeller || !row.reviewedByUserId || !row.reviewedAt || row.endsAt && row.endsAt <= new Date()) throw new AppError('Only a Seller-paused, independently approved campaign can resume without a new review.', 409, 'CAMPAIGN_STATE');
      await assertSellerCapacity(context.store, 'campaigns', { session, excludeId: row._id });
      await validateProducts(context.store, row.productPublicIds, session);
      row.status = 'active'; row.pausedBySeller = false;
    } else {
      if (!(input.action === 'pause' ? row.status === 'active' : ['draft', 'rejected', 'submitted', 'active', 'paused'].includes(row.status))) throw new AppError('This campaign action is unavailable.', 409, 'CAMPAIGN_STATE');
      row.status = input.action === 'pause' ? 'paused' : 'ended';
      row.pausedBySeller = input.action === 'pause'; if (row.pausedBySeller) row.sellerPausedAt = new Date();
      if (input.action === 'end') await PromoterLink.updateMany({ campaignId: row._id, active: true }, { $set: { active: false }, $inc: { __v: 1 } }, { session });
    }
    await row.save({ session }); await audit(request, `seller.affiliate_campaign_${input.action}`, context, row, session); return dto(row);
  });
  clearSponsoredOfferCache(request.store.country); return result;
}
export async function decideSellerAffiliateApplication(request, id, raw) {
  const input = z.object({ decision: z.enum(['approve', 'reject', 'revoke']), reason: z.string().trim().min(3).max(500), version: z.coerce.number().int().nonnegative() }).parse(raw);
  return sellerTransaction(async session => {
    const context = await sellerOperationsAccess(request, 'growth', { session, write: true });
    const application = await CampaignApplication.findOne({ publicId: id, country: context.store.country }).session(session);
    const campaign = application && await Campaign.findOne({ _id: application.campaignId, publicId: application.campaignPublicId, storeId: context.store._id, ownerUserId: context.store.ownerUserId, country: context.store.country, scope: 'seller', systemManaged: false }).session(session);
    if (!campaign) throw new AppError('Application not found.', 404, 'CAMPAIGN_APPLICATION_NOT_FOUND');
    sellerVersion(application, input.version);
    if (input.decision === 'approve' && (context.store.status !== 'verified' || campaign.status !== 'active' || !campaign.reviewedByUserId || !campaign.reviewedAt || campaign.startsAt && campaign.startsAt > new Date() || campaign.endsAt && campaign.endsAt <= new Date()
      || [campaign.ownerUserId, campaign.createdByUserId, campaign.submittedByUserId].some(value => value && sameSellerId(value, campaign.reviewedByUserId)))
      || (input.decision === 'revoke' ? application.status !== 'approved' : application.status !== 'pending')) throw new AppError('This application decision is unavailable.', 409, 'CAMPAIGN_APPLICATION_STATE');
    const promoter = await User.findOne({ _id: application.promoterUserId, role: 'promoter', status: 'active', country: context.store.country, emailVerifiedAt: { $type: 'date' }, onboardingCompletedAt: { $type: 'date' }, platformAccessManagedAt: null }).session(session);
    const verification = promoter && await PromoterVerification.findOne({ userId: promoter._id, country: context.store.country, status: 'verified' }).session(session);
    if (input.decision === 'approve' && (!promoter || !verification || sameSellerId(promoter._id, context.store.ownerUserId) || await StoreMember.exists({ storeId: context.store._id, userId: promoter._id, status: 'active' }).session(session))) throw new AppError('An independent verified promoter is required.', 409, 'PROMOTER_UNAVAILABLE');
    if (input.decision === 'approve') await validateProducts(context.store, campaign.productPublicIds, session);
    for (const [Model, record] of [[Campaign, campaign], ...(input.decision === 'approve' ? [[User, promoter], [PromoterVerification, verification]] : [])]) {
      const result = await Model.updateOne({ _id: record._id, __v: record.__v || 0 }, { $inc: { __v: 1 } }, { session }); if (result.modifiedCount !== 1) throw sellerConflict();
    }
    application.status = ({ approve: 'approved', reject: 'rejected', revoke: 'revoked' })[input.decision]; application.reason = input.reason; application.reviewedByUserId = context.actor._id; application.reviewedAt = new Date(); await application.save({ session });
    if (input.decision !== 'approve') await PromoterLink.updateMany({ campaignId: campaign._id, promoterUserId: application.promoterUserId, active: true }, { $set: { active: false }, $inc: { __v: 1 } }, { session });
    await audit(request, 'seller.affiliate_application_decided', context, campaign, session, { applicationPublicId: application.publicId, decision: input.decision });
    return { publicId: application.publicId, campaignPublicId: campaign.publicId, status: application.status, reason: application.reason, version: application.__v || 0 };
  });
}
export async function sellerAffiliatePage(request) {
  const context = await sellerOperationsAccess(request, 'growth');
  const scope = { storeId: context.store._id, ownerUserId: context.store.ownerUserId, country: context.store.country, scope: 'seller', systemManaged: false };
  const [rows, total, products] = await Promise.all([Campaign.find(cursorScope(scope, request.query?.after)).sort(cursorSort()).limit(26).lean(), Campaign.countDocuments(scope), Product.find({ storeId: context.store._id, status: { $in: ['approved', 'published'] }, countries: context.store.country }).select('publicId title').sort({ title: 1 }).limit(200).lean()]);
  const campaigns = pageResult(rows, { limit: 25, total });
  // Application history is independently paginated across all owned campaigns.
  const ids = await Campaign.find(scope).distinct('_id');
  const applicationScope = { campaignId: { $in: ids }, country: context.store.country };
  const [applications, applicationTotal] = await Promise.all([CampaignApplication.find(cursorScope(applicationScope, request.query?.applicationsAfter)).sort(cursorSort()).limit(26).lean(), CampaignApplication.countDocuments(applicationScope)]);
  const applicationPage = pageResult(applications, { limit: 25, total: applicationTotal });
  return { kind: 'affiliate', baseHref: '/seller/affiliate', products, campaigns: campaigns.items.map(dto), applications: applicationPage.items.map(row => ({ publicId: row.publicId, campaignPublicId: row.campaignPublicId, note: row.note, status: row.status, reason: row.reason, version: row.__v || 0 })), applicationsPage: applicationPage.page, page: campaigns.page,
    columns: ['Campaign', 'Commission', 'Status'], rows: campaigns.items.map(row => ({ id: row.publicId, cells: [row.name, `${row.commissionBps / 100}%`, row.status], href: `#campaign-${row.publicId}` })), metrics: [{ label: 'Campaigns', value: total }, { label: 'Applications', value: applicationTotal }, { label: 'Store', value: context.store.name }, { label: 'Country', value: context.store.country }], insights: ['Country Admin independently approves submitted campaigns before promoters can apply.', 'Only independently verified promoters can receive usable links.'], health: { label: 'Campaign controls', rows: [{ label: 'Publication', value: 'Independent review' }] }, workflow: [{ title: 'Draft', text: 'Select products, factual claims and disclosure.' }, { title: 'Review', text: 'Submit for independent Country Admin approval.' }, { title: 'Promote', text: 'Review verified promoter applications before links are usable.' }] };
}

import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { Brand, Campaign, CampaignApplication, Category, CommissionEntry, Order, Product, ProductVariant, PromoterLink, Store, StoreMember, User } from '../models/index.js';
import { promoterAccess } from './promoter-workspace-access.js';
import { loadPromoterFinancePage, promoterReportingWindow } from './promoter-finance-pages.js';
import { formatMinorUnits } from './catalogue.js';

const integer = value => {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number)) throw new AppError('Promoter overview totals are invalid.', 500, 'PROMOTER_OVERVIEW_INVALID');
  return number;
};

// Count the whole eligible programme, rather than a limited marketplace page.
// Accepted campaigns become actionable only while their merchant and every
// selected product offer remain approved in the pinned programme market.
function activeCampaignStages(actor, market, country, now) {
  return [{ $match: { promoterUserId: actor._id, country: market.country, status: 'approved' } },
    { $lookup: { from: Campaign.collection.name, localField: 'campaignId', foreignField: '_id', as: 'campaign' } }, { $unwind: '$campaign' },
    { $match: { 'campaign.country': market.country, 'campaign.status': 'active', $expr: { $eq: ['$campaignPublicId', '$campaign.publicId'] }, $and: [
      { $or: [{ 'campaign.startsAt': null }, { 'campaign.startsAt': { $lte: now } }] },
      { $or: [{ 'campaign.endsAt': null }, { 'campaign.endsAt': { $gt: now } }] },
    ] } },
    { $lookup: { from: Store.collection.name, localField: 'campaign.storeId', foreignField: '_id', as: 'store', let: { ownerId: '$campaign.ownerUserId' }, pipeline: [
      { $match: { status: 'verified', country: market.country, currency: market.currency, $expr: { $eq: ['$ownerUserId', '$$ownerId'] } } },
      { $project: { ownerUserId: 1 } },
    ] } },
    { $set: { store: { $first: '$store' } } },
    { $lookup: { from: User.collection.name, localField: 'store.ownerUserId', foreignField: '_id', as: 'owner', pipeline: [
      { $match: { status: 'active', role: 'seller', emailVerifiedAt: { $type: 'date' }, onboardingCompletedAt: { $type: 'date' } } }, { $project: { _id: 1 } },
    ] } },
    { $lookup: { from: StoreMember.collection.name, localField: 'campaign.storeId', foreignField: 'storeId', as: 'selfMembership', pipeline: [
      { $match: { userId: actor._id, status: 'active' } }, { $limit: 1 }, { $project: { _id: 1 } },
    ] } },
    { $lookup: { from: Product.collection.name, let: { ids: { $ifNull: ['$campaign.productPublicIds', []] }, storeId: '$campaign.storeId', ownerId: '$store.ownerUserId' }, as: 'products', pipeline: [
      { $match: { status: 'published', countries: market.country, $expr: { $and: [
        { $in: ['$publicId', '$$ids'] }, { $eq: ['$storeId', '$$storeId'] }, { $eq: ['$ownerUserId', '$$ownerId'] },
      ] } } },
      { $lookup: { from: Category.collection.name, localField: 'categoryId', foreignField: '_id', as: 'category', pipeline: [{ $match: { active: true, $or: [{ countries: { $size: 0 } }, { countries: market.country }] } }] } },
      { $unwind: '$category' },
      { $lookup: { from: Brand.collection.name, localField: 'brandId', foreignField: '_id', as: 'brand', pipeline: [{ $match: { status: 'approved' } }, { $project: { _id: 1 } }] } },
      { $match: { $or: [{ brandId: null }, { 'brand.0': { $exists: true } }] } },
      { $match: { $expr: { $or: [
        { $and: [{ $ne: ['$category.restricted', true] }, { $ne: ['$moderation.riskLevel', 'high'] }, { $ne: ['$moderation.secondReviewRequired', true] }] },
        { $and: [
          { $eq: ['$moderation.secondReviewRequired', false] },
          { $ne: [{ $ifNull: ['$moderation.firstApprovalByUserId', null] }, null] },
          { $ne: [{ $ifNull: ['$moderation.reviewedByUserId', null] }, null] },
          { $ne: ['$moderation.firstApprovalByUserId', '$moderation.reviewedByUserId'] },
          { $ne: ['$moderation.firstApprovalByUserId', '$ownerUserId'] }, { $ne: ['$moderation.reviewedByUserId', '$ownerUserId'] },
          { $ne: ['$moderation.firstApprovalByUserId', '$$ownerId'] }, { $ne: ['$moderation.reviewedByUserId', '$$ownerId'] },
        ] },
      ] } } },
      { $lookup: { from: ProductVariant.collection.name, let: { productId: '$_id', storeId: '$storeId' }, as: 'variant', pipeline: [
        { $match: { active: true, currency: market.currency, priceMinor: { $gt: 0, $lte: Number.MAX_SAFE_INTEGER }, $expr: { $and: [
          { $eq: ['$productId', '$$productId'] }, { $eq: ['$storeId', '$$storeId'] }, { $eq: [{ $mod: ['$priceMinor', 1] }, 0] },
        ] } } }, { $limit: 1 }, { $project: { _id: 1 } },
      ] } },
      { $match: { 'variant.0': { $exists: true } } }, { $project: { _id: 0, publicId: 1 } },
    ] } },
    { $match: { $expr: { $or: [
      { $and: [{ $eq: ['$campaign.scope', 'marketplace'] }, { $eq: ['$campaign.systemManaged', true] },
        { $gt: [Number(country.growth?.promoterCommissionBps || 0), 0] }, { $eq: ['$campaign.commissionBps', Number(country.growth?.promoterCommissionBps || 0)] }] },
      { $and: [{ $eq: ['$campaign.scope', 'seller'] }, { $gt: [{ $size: '$owner' }, 0] }, { $eq: [{ $size: '$selfMembership' }, 0] },
        { $ne: ['$campaign.ownerUserId', actor._id] }, { $gt: [{ $size: '$products' }, 0] },
        { $setEquals: ['$products.publicId', { $ifNull: ['$campaign.productPublicIds', []] }] }] },
    ] } } }];
}

/** Receives a fresh authorized promoterAccess context; performs only scoped reads. */
export async function loadPromoterSidebar(context, { now = new Date() } = {}) {
  const { actor, verification, market, country } = context;
  if (!actor?._id || !market?.country || country?.code !== market.country || country.currency !== market.currency || country.timeZone !== market.timeZone) {
    throw new AppError('The Promoter market is unavailable.', 409, 'PROMOTER_MARKET_UNAVAILABLE');
  }
  const monthStart = promoterReportingWindow('7months', market.timeZone, now).buckets.at(-1).start;
  const [campaignRows, monthlyRows] = await Promise.all([
    verification?.status === 'verified' ? CampaignApplication.aggregate([...activeCampaignStages(actor, market, country, now),
      { $facet: { count: [{ $count: 'total' }], names: [{ $sort: { createdAt: -1, _id: -1 } }, { $limit: 4 }, { $project: { _id: 0, name: '$campaign.name' } }] } }]) : Promise.resolve([]),
    CommissionEntry.aggregate([{ $match: { promoterUserId: actor._id, currency: market.currency, createdAt: { $gte: monthStart, $lt: now } } },
      { $lookup: { from: Order.collection.name, localField: 'orderId', foreignField: '_id', as: 'order', pipeline: [{ $project: { publicId: 1, country: 1, 'totals.currency': 1 } }] } }, { $unwind: '$order' },
      { $match: { 'order.country': market.country, 'order.totals.currency': market.currency, $expr: { $eq: ['$orderPublicId', '$order.publicId'] } } },
      { $lookup: { from: Campaign.collection.name, localField: 'campaignId', foreignField: '_id', as: 'campaign', pipeline: [{ $match: { country: market.country } }, { $project: { _id: 1 } }] } }, { $unwind: '$campaign' },
      { $group: { _id: null, netMinor: { $sum: { $max: [0, { $subtract: ['$amountMinor', { $ifNull: ['$reversedAmountMinor', 0] }] }] } } } }]),
  ]);
  return { activeCampaigns: integer(campaignRows[0]?.count?.[0]?.total), monthEarnedMinor: integer(monthlyRows[0]?.netMinor),
    campaignPeople: campaignRows[0]?.names || [] };
}

export async function loadPromoterOverview(request, { now = new Date() } = {}) {
  const context = await promoterAccess(request), { actor, verification, market } = context;
  const period = z.enum(['30days', '7months', 'year']).parse(request.query?.period ?? '30days');
  const scopedRequest = query => { const copy = Object.create(request); Object.defineProperty(copy, 'query', { value: query }); return copy; };
  const [performance, wallet, sidebar, links] = await Promise.all([
    loadPromoterFinancePage(scopedRequest({ period }), 'promoter-analytics', { now }),
    loadPromoterFinancePage(scopedRequest({}), 'promoter-wallet', { now }),
    loadPromoterSidebar(context, { now }),
    PromoterLink.aggregate([{ $match: { promoterUserId: actor._id } }, { $lookup: { from: Campaign.collection.name, localField: 'campaignId', foreignField: '_id', as: 'campaign' } }, { $unwind: '$campaign' },
      { $match: { 'campaign.country': market.country } }, { $sort: { createdAt: -1, _id: -1 } }, { $limit: 4 }, { $project: { _id: 0, publicId: 1, createdAt: 1, active: 1, campaignName: '$campaign.name' } }]),
  ]);
  const { activeCampaigns, monthEarnedMinor } = sidebar;
  const money = value => formatMinorUnits(value, market.currency, actor.locale);
  const priorities = [];
  if (verification?.status !== 'verified') priorities.push({ text: 'Complete Promoter verification before applying to campaigns or creating links.', href: '/promoter/profile?section=business' });
  if (!activeCampaigns) priorities.push({ text: 'Discover approved campaigns available in your programme market.', href: '/promoter/marketplace' });
  if (wallet.finance.estimatedMinor) priorities.push({ text: money(wallet.finance.estimatedMinor) + ' commission remains estimated; review the underlying order payment states.', href: '/promoter/commissions' });
  if (wallet.finance.unknownPayoutCount) priorities.push({ text: `${wallet.finance.unknownPayoutCount} payouts await reconciliation.`, href: '/promoter/payouts' });
  if (wallet.availableMinor > 0) priorities.push({ text: money(wallet.availableMinor) + ' is available in your payable ledger.', href: '/promoter/payouts' });
  return { kind: 'overview', market, currency: market.currency, timeZone: market.timeZone, period,
    analytics: performance.analytics, finance: wallet.finance, availableMinor: wallet.availableMinor, activeCampaigns, monthEarnedMinor,
    verification: { label: 'Verification', value: verification?.status === 'verified' ? 'Verified' : '—', detail: verification?.status || 'Not submitted' },
    metrics: [{ label: 'Eligible visits', value: performance.analytics.eligibleVisits, detail: 'Recorded visits in the selected period' },
      { label: 'Paid attributed orders', value: performance.analytics.paidConversions, detail: 'Attributed orders with a matching verified payment record' },
      { label: 'Available balance', value: money(wallet.availableMinor), detail: 'Actual payable ledger after payout holds' },
      { label: 'Active campaigns', value: activeCampaigns, detail: 'Live accepted campaigns with current Promoter verification' }],
    trend: performance.trend, trendLabel: performance.trendLabel, trendDescription: performance.trendDescription, trendSummary: money(performance.analytics.commissionMinor), periodOptions: performance.periodOptions,
    priorities, priorityHref: priorities[0]?.href || '/promoter/campaigns', create: { href: '/promoter/links', label: 'Create Link' }, exportHref: `/promoter/overview/summary.csv?period=${period}`,
    activity: links.map(row => ({ text: `${row.active ? 'Created' : 'Inactive'} tracking link for ${row.campaignName}`, at: row.createdAt, href: '/promoter/links?link=' + encodeURIComponent(row.publicId), icon: 'i-arrow-right' })),
    activityHref: '/promoter/links', coverage: { title: 'Campaign relationships', description: 'Your accepted campaigns with current programme eligibility.', people: sidebar.campaignPeople,
      total: activeCampaigns, stats: [{ label: 'Active campaigns', value: activeCampaigns }, { label: 'Programme market', value: market.country + ' · ' + market.currency }], href: '/promoter/campaigns', label: 'View campaigns' },
  };
}

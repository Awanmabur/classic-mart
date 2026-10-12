import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { env } from '../config/env.js';
import { Campaign, CampaignApplication, Store, StoreMember, CountrySetting, User, PromoterVerification, PromoterContactRequest,
  MarketplaceConversation, Referral, ReferralInvite, PromoterBrandFollow, LoyaltyEntry, Notification } from '../models/index.js';
import { promoterAccess } from './promoter-workspace-access.js';
import { ensureReferralCode } from './stage9.js';
import { cursorScope, cursorSort, pageResult, decodeCursor } from './pagination.js';
import { writeAudit } from './audit.js';
import { hydratePlatformAuthorization } from './platform-grants.js';
import { primaryWorkspaceFor } from '../dashboard/access.js';

const idInput = z.string().trim().regex(/^[a-z][a-z0-9_-]{4,119}$/, 'Choose a valid record.');
const versionInput = z.union([z.number(), z.string().regex(/^\d+$/)]).pipe(z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER));
const human = value => String(value || '').replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase());
const escaped = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const same = (a, b) => String(a) === String(b);
const date = (value, timeZone) => value ? new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone }) : '—';
const path = (base, values = {}) => { const params = new URLSearchParams(Object.entries(values).filter(([, value]) => value && value !== 'all')); return base + (params.size ? '?' + params : ''); };
const relationshipContext = context => ({ ...context, country: context.market.country });

function filters(request, statuses) {
  if (request.query?.after && !decodeCursor(request.query.after)) throw new AppError('Choose a valid page cursor.', 422, 'PAGINATION_INVALID');
  const raw = String(request.query?.status || 'all');
  return { search: String(request.query?.search || request.query?.q || '').trim().slice(0, 100),
    status: statuses.includes(raw) ? raw : 'all', after: String(request.query?.after || ''),
    statuses: ['all', ...statuses].map(value => ({ value, label: value === 'all' ? 'All statuses' : human(value) })) };
}
function filterStage(filter, fields) {
  const scope = {};
  if (filter.status !== 'all') scope.status = filter.status;
  if (filter.search) scope.$or = fields.map(field => ({ [field]: new RegExp(escaped(filter.search), 'i') }));
  return Object.keys(scope).length ? [{ $match: scope }] : [];
}
async function page(Model, pipeline, request, field = 'createdAt') {
  const limit = Math.max(1, Math.min(50, Number(request.query?.limit) || 25));
  const [result] = await Model.aggregate([...pipeline, { $facet: {
    items: [{ $match: cursorScope({}, request.query?.after, { field }) }, { $sort: cursorSort(field) }, { $limit: limit + 1 }],
    count: [{ $count: 'total' }],
  } }]);
  return pageResult(result?.items || [], { field, limit, total: result?.count?.[0]?.total || 0 });
}
function frame(kind, context, filter, paging) {
  return { kind: 'relationships', relationshipKind: kind, country: context.country, currency: context.market.currency,
    timeZone: context.market.timeZone, editable: context.verification?.status === 'verified', filters: filter, page: paging,
    metrics: [], columns: [], rows: [], insights: [], health: { value: null, label: 'Relationship health', rows: [] }, workflow: [] };
}
function checkVersion(row, version) {
  if (Number(row.__v || 0) !== version) throw new AppError('This record changed. Reload the page before saving.', 409, 'RELATIONSHIP_VERSION_CONFLICT');
}
async function transaction(request, operation) {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => operation(relationshipContext(await promoterAccess(request, { session, write: true })), session));
  } catch (error) {
    if (error.name === 'VersionError') throw new AppError('This record changed. Reload the page before saving.', 409, 'RELATIONSHIP_VERSION_CONFLICT');
    throw error;
  } finally { await session.endSession(); }
}
async function notification(request, context, session, recipient, title, body, href) {
  // Conversation preferences affect only these ordinary in-app messages.
  if (recipient.role === 'promoter' && recipient.preferences?.promoterMessages === false) return;
  await Notification.create([{ publicId: publicId('ntf'), userId: recipient._id, country: context.country,
    type: 'promoter_relationship', title, body: body.slice(0, 1500), href }], { session });
}
function requireVerified(context) {
  if (context.verification?.status !== 'verified') throw new AppError('Complete promoter verification before managing relationships.', 409, 'PROMOTER_VERIFICATION_REQUIRED');
}

function referralDto(row) {
  return { publicId: row.publicId, invitationCode: row.invitationCode || row.code, status: row.status,
    acceptedAt: row.acceptedAt, qualifiedAt: row.qualifiedAt, rewardedAt: row.rewardedAt,
    qualifiedOrderPublicId: row.qualifiedOrderPublicId || '', referrerRewardPoints: Number(row.referrerRewardPoints || 0) };
}
async function referrals(request, context) {
  const filter = filters(request, ['pending', 'qualified', 'rewarded', 'rejected']);
  const scope = { referrerUserId: context.actor._id, country: context.country, referredUserId: { $type: 'objectId' } };
  const pipeline = [{ $match: scope }];
  const [result, summary, invite, rewards] = await Promise.all([
    page(Referral, [...pipeline, ...filterStage(filter, ['publicId', 'invitationCode', 'qualifiedOrderPublicId'])], request),
    Referral.aggregate([...pipeline, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    ReferralInvite.findOne({ referrerUserId: context.actor._id, country: context.country }).select('publicId code').lean(),
    LoyaltyEntry.aggregate([{ $match: { userId: context.actor._id, country: context.country, type: 'referral_earn', referenceType: 'referral' } },
      { $lookup: { from: Referral.collection.name, localField: 'referencePublicId', foreignField: 'publicId', as: 'referral' } },
      { $match: { 'referral.referrerUserId': context.actor._id, 'referral.country': context.country } },
      { $group: { _id: null, points: { $sum: '$pointsDelta' } } }]),
  ]);
  const counts = Object.fromEntries(summary.map(row => [row._id, row.count]));
  const total = summary.reduce((sum, row) => sum + row.count, 0), qualified = (counts.qualified || 0) + (counts.rewarded || 0);
  const flow = frame('referrals', context, filter, result.page);
  flow.invite = invite ? { publicId: invite.publicId, code: invite.code, signupHref: path('/signup', { ref: invite.code, role: 'promoter' }) } : null;
  flow.records = result.items.map(referralDto);
  if (request.query?.referral) {
    const selected = await Referral.findOne({ ...scope, publicId: idInput.parse(request.query.referral) }).lean();
    if (!selected) throw new AppError('Referral not found.', 404, 'REFERRAL_NOT_FOUND');
    flow.selected = referralDto(selected);
  }
  flow.metrics = [{ label: 'Referred signups', value: total, detail: 'Accepted signup referrals in your market' },
    { label: 'Pending qualification', value: counts.pending || 0, detail: 'Awaiting a first qualifying paid purchase' },
    { label: 'Qualified referrals', value: qualified, detail: 'Recorded qualification and reward history' },
    { label: 'Referral points', value: Number(rewards[0]?.points || 0), detail: 'Loyalty points recorded in your ledger' }];
  flow.columns = ['Referral', 'Joined', 'Qualified', 'Points', 'Status'];
  flow.rows = flow.records.map(row => ({ id: row.publicId, cells: [row.publicId, date(row.acceptedAt, context.market.timeZone),
    date(row.qualifiedAt, context.market.timeZone), String(row.referrerRewardPoints), human(row.status)], href: path('/promoter/referrals', { referral: row.publicId }) }));
  flow.tableTitle = 'Referral history'; flow.tableDescription = 'Each signup qualifies independently through its first paid purchase.';
  flow.create = { label: invite ? 'Share Referral' : 'Generate Referral Code', href: '#referral-invite' };
  flow.insights = [`${counts.pending || 0} referrals are awaiting purchase qualification.`, 'Referral rewards are loyalty points. Signup alone does not earn a reward.',
    invite ? 'Your invitation can be used by multiple people in the same market.' : 'Generate your reusable invitation before sharing it.'];
  flow.health = { label: 'Referral qualification', value: total ? qualified / total * 100 : null,
    rows: [{ label: 'Qualified', value: qualified }, { label: 'Pending', value: counts.pending || 0 }, { label: 'Rewarded', value: counts.rewarded || 0 }] };
  flow.workflow = [{ title: 'Share your invitation', text: 'Use the signup link with your reusable referral code.', href: '#referral-invite' },
    { title: 'First paid purchase', text: 'The marketplace validates a first qualifying purchase under its referral policy.' },
    { title: 'Recorded loyalty reward', text: 'Qualified rewards appear in your referral history and loyalty ledger.' }];
  return flow;
}
export async function generatePromoterReferral(request) {
  return transaction(request, async (context, session) => {
    requireVerified(context);
    const prior = await ReferralInvite.exists({ referrerUserId: context.actor._id, country: context.country }).session(session);
    const invite = await ensureReferralCode(context.actor, { session, country: context.country });
    if (!prior) await writeAudit(request, 'promoter.referral_invite_created', { actor: context.actor, session,
      targetType: 'referral_invite', targetPublicId: invite.publicId, country: context.country });
    return { publicId: invite.publicId, code: invite.code };
  });
}

function activeCampaignScope(country) {
  const now = new Date();
  return { country, scope: 'seller', status: 'active', $and: [{ $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
    { $or: [{ endsAt: null }, { endsAt: { $gt: now } }] }] };
}
function campaignRelationships(context, visibility = true) {
  return [{ $match: activeCampaignScope(context.country) },
    { $lookup: { from: Store.collection.name, localField: 'storeId', foreignField: '_id', as: 'store' } }, { $unwind: '$store' },
    { $match: { 'store.country': context.country, 'store.status': 'verified', 'store.currency': context.market.currency,
      $expr: { $eq: ['$ownerUserId', '$store.ownerUserId'] } } },
    { $lookup: { from: User.collection.name, localField: 'ownerUserId', foreignField: '_id', as: 'owner' } }, { $unwind: '$owner' },
    { $match: { 'owner.role': 'seller', 'owner.status': 'active', 'owner.country': context.country } },
    { $lookup: { from: CampaignApplication.collection.name, let: { campaign: '$_id' }, pipeline: [{ $match: {
      promoterUserId: context.actor._id, country: context.country, $expr: { $eq: ['$campaignId', '$$campaign'] } } }], as: 'application' } },
    ...(visibility ? [{ $match: { $or: [{ visibility: 'public' }, { 'application.status': 'approved' }] } }] : []),
  ];
}
function brandPipeline(context) {
  return [...campaignRelationships(context), { $group: { _id: '$store._id', publicId: { $first: '$store.publicId' }, name: { $first: '$store.name' },
    slug: { $first: '$store.slug' }, description: { $first: '$store.description' }, createdAt: { $first: '$store.createdAt' },
    campaignCount: { $sum: 1 }, approvedCount: { $sum: { $cond: [{ $in: ['approved', '$application.status'] }, 1, 0] } } } },
    { $lookup: { from: PromoterBrandFollow.collection.name, let: { store: '$_id' }, pipeline: [{ $match: { promoterUserId: context.actor._id,
      country: context.country, $expr: { $eq: ['$storeId', '$$store'] } } }], as: 'follow' } },
    { $set: { status: { $cond: [{ $in: ['followed', '$follow.status'] }, 'followed', 'available'] } } },
  ];
}
function brandDto(row) {
  return { publicId: row.publicId, name: row.name, slug: row.slug, description: row.description,
    campaignCount: row.campaignCount, approvedCount: row.approvedCount, status: row.status, version: Number(row.follow?.[0]?.__v || 0),
    storeHref: '/sellers/' + encodeURIComponent(row.slug), marketplaceHref: path('/promoter/marketplace', { brand: row.publicId }) };
}
async function brands(request, context) {
  const filter = filters(request, ['followed', 'available']);
  const pipeline = brandPipeline(context);
  const [result, summary] = await Promise.all([page(Campaign, [...pipeline, ...filterStage(filter, ['publicId', 'name'])], request),
    Campaign.aggregate([...pipeline, { $group: { _id: null, brands: { $sum: 1 }, campaigns: { $sum: '$campaignCount' },
      partnerships: { $sum: { $cond: [{ $gt: ['$approvedCount', 0] }, 1, 0] } }, followed: { $sum: { $cond: [{ $eq: ['$status', 'followed'] }, 1, 0] } } } }])]);
  const totals = summary[0] || { brands: 0, campaigns: 0, partnerships: 0, followed: 0 };
  const flow = frame('brands', context, filter, result.page); flow.records = result.items.map(brandDto);
  if (request.query?.brand) {
    const [selected] = await Campaign.aggregate([...pipeline, { $match: { publicId: idInput.parse(request.query.brand) } }]);
    if (!selected) throw new AppError('Seller relationship not found.', 404, 'BRAND_NOT_FOUND');
    flow.selected = brandDto(selected);
    flow.selected.campaigns = (await Campaign.aggregate([...campaignRelationships(context), { $match: { 'store.publicId': selected.publicId } },
      { $sort: { createdAt: -1, _id: -1 } }, { $limit: 50 }])).map(row => ({ publicId: row.publicId, name: row.name,
      applicationStatus: row.application[0]?.status || 'not_applied', href: path('/promoter/marketplace', { campaign: row.publicId, brand: selected.publicId }) }));
  }
  flow.metrics = [{ label: 'Available brands', value: totals.brands, detail: 'Verified sellers with accessible active campaigns' },
    { label: 'Followed brands', value: totals.followed, detail: 'Your saved seller follows in this market' },
    { label: 'Active campaigns', value: totals.campaigns, detail: 'Current campaigns across these sellers' },
    { label: 'Approved partnerships', value: totals.partnerships, detail: 'Sellers with an approved campaign membership' }];
  flow.columns = ['Seller & brand', 'Active campaigns', 'Approved campaigns', 'Status'];
  flow.rows = flow.records.map(row => ({ id: row.publicId, cells: [row.name, String(row.campaignCount), String(row.approvedCount), human(row.status)],
    href: path('/promoter/brands', { brand: row.publicId }) }));
  flow.tableTitle = 'Seller relationships'; flow.create = { label: 'Discover Campaigns', href: '/promoter/marketplace' };
  flow.insights = [`${totals.partnerships} sellers have approved you for a current campaign.`, `${totals.followed} eligible brands are saved in your follow list.`,
    'Only verified sellers and current campaign permissions appear here.'];
  flow.health = { value: totals.brands ? totals.partnerships / totals.brands * 100 : null, label: 'Approved partnerships',
    rows: [{ label: 'Eligible brands', value: totals.brands }, { label: 'Followed', value: totals.followed }, { label: 'Approved', value: totals.partnerships }] };
  flow.workflow = [{ title: 'Discover a seller', text: 'Review verified public seller profiles and their available campaigns.', href: '/promoter/marketplace' },
    { title: 'Save the relationship', text: 'Follow a seller to keep a personal record of the brands you want to work with.' },
    { title: 'Apply for a campaign', text: 'Campaign approval controls access to collaboration and messaging.', href: '/promoter/campaigns' }];
  return flow;
}
export async function followPromoterBrand(request, followed = true) {
  const storePublicId = idInput.parse(request.params.publicId), version = versionInput.parse(request.body.version);
  return transaction(request, async (context, session) => {
    requireVerified(context);
    const [eligible] = await Campaign.aggregate([...brandPipeline(context), { $match: { publicId: storePublicId } }]).session(session);
    if (!eligible) throw new AppError('Seller relationship not found.', 404, 'BRAND_NOT_FOUND');
    const store = await Store.findById(eligible._id).session(session);
    const owner = await User.findById(store.ownerUserId).session(session);
    // Fence owner/store state as well as the promoter against concurrent revocation.
    const ownerWrite = await User.updateOne({ _id: owner._id, role: 'seller', status: 'active', country: context.country }, { $inc: { __v: 1 } }, { session });
    const storeWrite = await Store.updateOne({ _id: store._id, status: 'verified', country: context.country, currency: context.market.currency, ownerUserId: owner._id }, { $inc: { __v: 1 } }, { session });
    if (!ownerWrite.matchedCount || !storeWrite.matchedCount) throw new AppError('This seller is unavailable.', 409, 'BRAND_UNAVAILABLE');
    let row = await PromoterBrandFollow.findOne({ promoterUserId: context.actor._id, storeId: store._id, country: context.country }).session(session);
    if (row) { checkVersion(row, version); row.status = followed ? 'followed' : 'unfollowed'; await row.save({ session }); }
    else {
      if (version !== 0 || !followed) throw new AppError('This follow changed. Reload the page.', 409, 'RELATIONSHIP_VERSION_CONFLICT');
      [row] = await PromoterBrandFollow.create([{ publicId: publicId('pbrand'), promoterUserId: context.actor._id,
        storeId: store._id, country: context.country, status: 'followed' }], { session });
    }
    await writeAudit(request, followed ? 'promoter.brand_followed' : 'promoter.brand_unfollowed', { session, actor: context.actor,
      targetType: 'store', targetPublicId: store.publicId, country: context.country });
    return { publicId: store.publicId, version: row.__v };
  });
}

function contactPipeline(context) {
  if (!context.verification) return [{ $match: { _id: null } }];
  return [{ $match: { promoterUserId: context.actor._id, country: context.country, promoterVerificationId: context.verification._id } },
    { $lookup: { from: User.collection.name, localField: 'customerUserId', foreignField: '_id', as: 'customer' } }, { $unwind: '$customer' },
    { $match: { 'customer.role': 'customer', 'customer.status': 'active', 'customer.country': context.country } }];
}
function conversationPipeline(context) {
  if (context.verification?.status !== 'verified') return [{ $match: { _id: null } }];
  return [{ $match: { country: context.country, contextType: 'campaign', participantUserIds: { $all: [context.actor._id], $size: 2 } } },
    { $lookup: { from: Campaign.collection.name, localField: 'contextPublicId', foreignField: 'publicId', as: 'campaign' } }, { $unwind: '$campaign' },
    { $match: { 'campaign.country': context.country, 'campaign.scope': 'seller', 'campaign.status': 'active' } },
    { $lookup: { from: Store.collection.name, localField: 'campaign.storeId', foreignField: '_id', as: 'store' } }, { $unwind: '$store' },
    { $match: { 'store.country': context.country, 'store.status': 'verified', 'store.currency': context.market.currency,
      $expr: { $and: [{ $eq: ['$campaign.ownerUserId', '$store.ownerUserId'] }, { $in: ['$store.ownerUserId', '$participantUserIds'] },
        { $ne: ['$store.ownerUserId', context.actor._id] }, { $or: [{ $eq: [{ $ifNull: ['$campaign.startsAt', null] }, null] }, { $lte: ['$campaign.startsAt', new Date()] }] },
        { $or: [{ $eq: [{ $ifNull: ['$campaign.endsAt', null] }, null] }, { $gt: ['$campaign.endsAt', new Date()] }] }] } } },
    { $lookup: { from: User.collection.name, localField: 'store.ownerUserId', foreignField: '_id', as: 'seller' } }, { $unwind: '$seller' },
    { $match: { 'seller.role': 'seller', 'seller.status': 'active', 'seller.country': context.country } },
    { $lookup: { from: CampaignApplication.collection.name, let: { campaign: '$campaign._id' }, pipeline: [{ $match: { promoterUserId: context.actor._id,
      country: context.country, status: 'approved', $expr: { $eq: ['$campaignId', '$$campaign'] } } }], as: 'application' } },
    { $match: { 'application.0': { $exists: true } } },
  ];
}
function contactDto(row) {
  return { publicId: row.publicId, subject: row.subject, status: row.status, message: row.message, version: Number(row.__v || 0),
    lastMessageAt: row.lastMessageAt, counterpart: row.customer?.name || 'Customer', replies: (row.replies || []).map(reply => ({ sender: reply.sender, body: reply.body, at: reply.at })) };
}
function conversationDto(row, actorId) {
  return { publicId: row.publicId, subject: row.subject || row.campaign.name, status: row.status, version: Number(row.__v || 0),
    lastMessageAt: row.lastMessageAt, counterpart: row.store.name, campaignPublicId: row.campaign.publicId, campaignName: row.campaign.name,
    unread: (row.messages || []).filter(message => !same(message.senderUserId, actorId) && !(message.readByUserIds || []).some(id => same(id, actorId))).length,
    messages: (row.messages || []).map(message => ({ publicId: message.publicId, sender: same(message.senderUserId, actorId) ? 'You' : row.store.name,
      body: message.body, sentAt: message.sentAt, read: (message.readByUserIds || []).some(id => !same(id, message.senderUserId)) })) };
}
async function messages(request, context) {
  const tab = request.query?.tab === 'campaigns' ? 'campaigns' : 'customers', campaignTab = tab === 'campaigns';
  const filter = filters(request, campaignTab ? ['open', 'archived', 'closed'] : ['new', 'read', 'resolved']); filter.params = { tab };
  const Model = campaignTab ? MarketplaceConversation : PromoterContactRequest;
  const pipeline = campaignTab ? conversationPipeline(context) : contactPipeline(context);
  const [result, summary, choices] = await Promise.all([page(Model, [...pipeline, ...filterStage(filter, ['publicId', 'subject'])], request, 'lastMessageAt'),
    Model.aggregate([...pipeline, { $group: { _id: '$status', count: { $sum: 1 }, replies: { $sum: { $size: campaignTab ? '$messages' : '$replies' } } } }]),
    context.verification?.status === 'verified'
      ? Campaign.aggregate([...campaignRelationships(context), { $match: { 'application.status': 'approved' } }, { $sort: { name: 1 } }, { $limit: 100 }])
      : [],
  ]);
  const counts = Object.fromEntries(summary.map(row => [row._id, row.count])), total = summary.reduce((sum, row) => sum + row.count, 0);
  const flow = frame('messages', context, filter, result.page); flow.tab = tab;
  flow.campaignChoices = choices.map(row => ({ publicId: row.publicId, name: row.name, storeName: row.store.name }));
  flow.records = result.items.map(row => campaignTab ? conversationDto(row, context.actor._id) : contactDto(row));
  if (request.query?.thread) {
    const [selected] = await Model.aggregate([...pipeline, { $match: { publicId: idInput.parse(request.query.thread) } }]);
    if (!selected) throw new AppError('Conversation not found.', 404, 'CONTACT_NOT_FOUND');
    flow.selected = campaignTab ? conversationDto(selected, context.actor._id) : contactDto(selected);
  }
  const open = campaignTab ? counts.open || 0 : (counts.new || 0) + (counts.read || 0);
  flow.metrics = [{ label: 'Conversations', value: total, detail: campaignTab ? 'Authorized campaign partnerships' : 'Customer requests to your profile' },
    { label: 'Open conversations', value: open, detail: 'Current threads available for follow-up' },
    { label: campaignTab ? 'Closed conversations' : 'New requests', value: campaignTab ? counts.closed || 0 : counts.new || 0, detail: campaignTab ? 'Resolved collaboration history' : 'Requests awaiting your attention' },
    { label: 'Recorded replies', value: summary.reduce((sum, row) => sum + row.replies, 0), detail: 'Saved messages across this entire view' }];
  flow.columns = ['Conversation', 'Contact', 'Last message', 'Status'];
  flow.rows = flow.records.map(row => ({ id: row.publicId, cells: [row.subject, row.counterpart, date(row.lastMessageAt, context.market.timeZone), human(row.status)],
    href: path('/promoter/messages', { tab, thread: row.publicId }) }));
  flow.tableTitle = campaignTab ? 'Campaign conversations' : 'Customer conversations';
  flow.create = { label: 'Contact a Campaign Seller', href: '#campaign-message' };
  flow.insights = [`${open} conversations are open in this view.`, 'Replies and conversation changes are saved with an audit record.',
    'Campaign messaging requires a verified seller and an approved campaign membership.'];
  flow.health = { label: 'Conversation completion', value: total ? ((campaignTab ? counts.closed || 0 : counts.resolved || 0) / total * 100) : null,
    rows: [{ label: 'Open', value: open }, { label: 'Total', value: total }, { label: 'Closed', value: campaignTab ? counts.closed || 0 : counts.resolved || 0 }] };
  flow.workflow = [{ title: 'Review a request', text: 'Open a scoped conversation and record when you have read it.' },
    { title: 'Reply in the workspace', text: 'Replies are stored and the authorized recipient receives an account notification.' },
    { title: 'Resolve the conversation', text: 'Close the thread after the request has been handled.' }];
  return flow;
}

export async function promoterRelationshipPage(request, pageId) {
  const context = relationshipContext(await promoterAccess(request));
  if (pageId === 'promoter-referrals') return referrals(request, context);
  if (pageId === 'promoter-brands') return brands(request, context);
  if (pageId === 'promoter-messages') return messages(request, context);
  throw new AppError('Promoter page not found.', 404, 'PROMOTER_PAGE_NOT_FOUND');
}

async function authorizedContact(context, id, session) {
  const [scoped] = await PromoterContactRequest.aggregate([...contactPipeline(context), { $match: { publicId: id } }]).session(session);
  if (!scoped) throw new AppError('Conversation not found.', 404, 'CONTACT_NOT_FOUND');
  const thread = await PromoterContactRequest.findById(scoped._id).session(session);
  const recipient = await User.findById(thread.customerUserId).session(session);
  const write = await User.updateOne({ _id: recipient._id, role: 'customer', status: 'active', country: context.country }, { $inc: { __v: 1 } }, { session });
  if (!write.matchedCount) throw new AppError('The conversation recipient is unavailable.', 409, 'CONTACT_UNAVAILABLE');
  return { thread, recipient };
}
async function authorizedConversation(context, id, session) {
  const [scoped] = await MarketplaceConversation.aggregate([...conversationPipeline(context), { $match: { publicId: id } }]).session(session);
  if (!scoped) throw new AppError('Conversation not found.', 404, 'CONTACT_NOT_FOUND');
  const thread = await MarketplaceConversation.findById(scoped._id).session(session);
  const recipient = await User.findById(scoped.seller._id).session(session);
  for (const [Model, scope] of [[User, { _id: recipient._id, role: 'seller', status: 'active', country: context.country }],
    [Store, { _id: scoped.store._id, ownerUserId: recipient._id, status: 'verified', country: context.country, currency: context.market.currency }],
    [Campaign, { ...activeCampaignScope(context.country), _id: scoped.campaign._id, ownerUserId: recipient._id }],
    [CampaignApplication, { _id: scoped.application[0]._id, status: 'approved', promoterUserId: context.actor._id, country: context.country }]]) {
    const write = await Model.updateOne(scope, { $inc: { __v: 1 } }, { session });
    if (!write.matchedCount) throw new AppError('The campaign relationship is unavailable.', 409, 'CONTACT_UNAVAILABLE');
  }
  return { thread, recipient };
}
export async function updatePromoterConversation(request, action = 'reply', campaign = false) {
  const id = idInput.parse(request.params.publicId), version = versionInput.parse(request.body.version);
  const body = action === 'reply' ? z.string().trim().min(2).max(campaign ? 4000 : 2000).parse(request.body.message) : '';
  if (!['reply', 'read', 'resolve'].includes(action)) throw new AppError('Choose a valid conversation action.', 422, 'MESSAGE_INVALID');
  return transaction(request, async (context, session) => {
    requireVerified(context);
    const { thread, recipient } = campaign ? await authorizedConversation(context, id, session) : await authorizedContact(context, id, session);
    checkVersion(thread, version);
    if (['resolved', 'closed', 'archived'].includes(thread.status)) throw new AppError('This conversation is closed.', 409, 'CONTACT_CLOSED');
    if (campaign) {
      if (action === 'reply') {
        if (thread.messages.length >= 500) throw new AppError('This conversation has reached its message limit.', 409, 'MESSAGE_LIMIT');
        thread.messages.push({ publicId: publicId('msg'), senderUserId: context.actor._id, body, sentAt: new Date(), readByUserIds: [context.actor._id] });
        thread.lastMessageAt = new Date();
      } else if (action === 'read') {
        for (const message of thread.messages) if (!message.readByUserIds.some(userId => same(userId, context.actor._id))) message.readByUserIds.push(context.actor._id);
      } else thread.status = 'closed';
    } else {
      if (action === 'reply') {
        if (thread.replies.length >= 500) throw new AppError('This conversation has reached its message limit.', 409, 'MESSAGE_LIMIT');
        thread.replies.push({ sender: 'promoter', senderUserId: context.actor._id, body, at: new Date() });
        thread.lastMessageAt = new Date(); thread.status = 'read';
      } else if (action === 'read') thread.status = 'read';
      else { thread.status = 'resolved'; thread.resolvedAt = new Date(); }
    }
    // Persist a version change for read receipts even if every message was already read.
    thread.markModified(campaign ? 'messages' : 'replies');
    await thread.save({ session });
    await writeAudit(request, `promoter.conversation_${action}`, { session, actor: context.actor, targetType: campaign ? 'marketplace_conversation' : 'promoter_contact',
      targetPublicId: thread.publicId, country: context.country });
    const href = campaign ? '/seller/promoter-messages/' + encodeURIComponent(thread.publicId) : '/account/messages';
    await notification(request, context, session, recipient, action === 'reply' ? 'Promoter replied' : action === 'read' ? 'Promoter read your conversation' : 'Promoter resolved your conversation',
      action === 'reply' ? body : thread.subject, href);
    return { publicId: thread.publicId, version: thread.__v };
  });
}

export async function createPromoterCampaignConversation(request) {
  const input = z.object({ campaignId: idInput, subject: z.string().trim().min(2).max(180), message: z.string().trim().min(2).max(4000) }).parse(request.body);
  return transaction(request, async (context, session) => {
    requireVerified(context);
    const [scoped] = await Campaign.aggregate([...campaignRelationships(context), { $match: { publicId: input.campaignId, 'application.status': 'approved' } }]).session(session);
    if (!scoped) throw new AppError('An approved seller campaign is required.', 404, 'CAMPAIGN_NOT_FOUND');
    const existing = await MarketplaceConversation.findOne({ contextType: 'campaign', contextPublicId: scoped.publicId,
      country: context.country, participantUserIds: { $all: [context.actor._id, scoped.ownerUserId], $size: 2 } }).session(session);
    if (existing) throw new AppError('A conversation already exists for this partnership. Open it to reply.', 409, 'CONTACT_EXISTS');
    const recipient = await User.findById(scoped.ownerUserId).session(session);
    for (const [Model, scope] of [[User, { _id: recipient._id, role: 'seller', status: 'active', country: context.country }],
      [Store, { _id: scoped.store._id, ownerUserId: recipient._id, status: 'verified', country: context.country, currency: context.market.currency }],
      [Campaign, { ...activeCampaignScope(context.country), _id: scoped._id, ownerUserId: recipient._id }],
      [CampaignApplication, { _id: scoped.application[0]._id, status: 'approved', promoterUserId: context.actor._id, country: context.country }]]) {
      const write = await Model.updateOne(scope, { $inc: { __v: 1 } }, { session });
      if (!write.matchedCount) throw new AppError('The campaign relationship is unavailable.', 409, 'CONTACT_UNAVAILABLE');
    }
    const [thread] = await MarketplaceConversation.create([{ publicId: publicId('conv'), participantUserIds: [context.actor._id, recipient._id],
      country: context.country, contextType: 'campaign', contextPublicId: scoped.publicId, subject: input.subject, status: 'open', lastMessageAt: new Date(),
      messages: [{ publicId: publicId('msg'), senderUserId: context.actor._id, body: input.message, sentAt: new Date(), readByUserIds: [context.actor._id] }] }], { session });
    await writeAudit(request, 'promoter.campaign_conversation_created', { session, actor: context.actor, targetType: 'marketplace_conversation',
      targetPublicId: thread.publicId, country: context.country });
    await notification(request, context, session, recipient, 'New promoter campaign message', input.message, '/seller/promoter-messages/' + encodeURIComponent(thread.publicId));
    return { publicId: thread.publicId, version: thread.__v };
  });
}

async function sellerConversationAccess(request, session = null, write = false) {
  if (!request.user?._id || !request.store?._id) throw new AppError('Seller authentication is required.', 401, 'UNAUTHENTICATED');
  const actor = await User.findById(request.user._id).session(session);
  const store = await Store.findById(request.store._id).session(session);
  const member = await StoreMember.findOne({ userId: request.user._id, storeId: request.store._id, status: 'active', role: 'owner' }).session(session);
  if (actor) await hydratePlatformAuthorization(actor);
  if (!actor || actor.role !== 'seller' || primaryWorkspaceFor(actor) !== 'seller' || actor.status !== 'active' || actor.security.tokenVersion !== request.user.security?.tokenVersion ||
      (request.session?.tokenVersion !== undefined && request.session.tokenVersion !== actor.security.tokenVersion)) {
    throw new AppError('Your seller account or session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
  }
  if (!env.auth.simpleLogin && (!actor.emailVerifiedAt || !actor.onboardingCompletedAt)) throw new AppError('Complete account verification first.', 403, 'ACCOUNT_UNAVAILABLE');
  if (!env.auth.simpleLogin && env.security.privilegedMfaRequired && !actor.security.mfaEnabled) throw new AppError('Authenticator enrollment is required.', 403, 'MFA_ENROLLMENT_REQUIRED');
  if (!store || store.status !== 'verified' || !same(store.ownerUserId, actor._id) || !member) {
    throw new AppError('Only the verified store owner can manage promoter conversations.', 403, 'SELLER_CONVERSATION_OWNER_REQUIRED');
  }
  const market = await CountrySetting.findOne({ code: store.country, active: true, currency: store.currency }).session(session).lean();
  if (!market) throw new AppError('The store market is unavailable.', 409, 'SELLER_COUNTRY_UNAVAILABLE');
  if (write) {
    if (!session?.inTransaction()) throw new AppError('Conversation changes require a transaction.', 500, 'RELATIONSHIP_TRANSACTION_REQUIRED');
    for (const [Model, scope] of [[User, { _id: actor._id, role: 'seller', status: 'active', 'security.tokenVersion': actor.security.tokenVersion }],
      [Store, { _id: store._id, status: 'verified', ownerUserId: actor._id, country: market.code, currency: market.currency }],
      [StoreMember, { _id: member._id, status: 'active', role: 'owner' }]]) {
      const update = await Model.updateOne(scope, { $inc: { __v: 1 } }, { session });
      if (!update.matchedCount) throw new AppError('Seller conversation access changed.', 403, 'SELLER_CONVERSATION_OWNER_REQUIRED');
    }
  }
  return { actor, store, member, country: market.code, market: { country: market.code, currency: market.currency, timeZone: market.timeZone } };
}
function sellerConversationPipeline(context) {
  const now = new Date();
  return [{ $match: { country: context.country, contextType: 'campaign', participantUserIds: { $all: [context.actor._id], $size: 2 } } },
    { $lookup: { from: Campaign.collection.name, localField: 'contextPublicId', foreignField: 'publicId', as: 'campaign' } }, { $unwind: '$campaign' },
    { $match: { 'campaign.storeId': context.store._id, 'campaign.ownerUserId': context.actor._id, 'campaign.country': context.country,
      'campaign.status': 'active', 'campaign.scope': 'seller', $and: [{ $or: [{ 'campaign.startsAt': null }, { 'campaign.startsAt': { $lte: now } }] },
        { $or: [{ 'campaign.endsAt': null }, { 'campaign.endsAt': { $gt: now } }] }] } },
    { $set: { promoterId: { $arrayElemAt: [{ $filter: { input: '$participantUserIds', as: 'participant', cond: { $ne: ['$$participant', context.actor._id] } } }, 0] } } },
    { $lookup: { from: User.collection.name, localField: 'promoterId', foreignField: '_id', as: 'promoter' } }, { $unwind: '$promoter' },
    { $match: { 'promoter.role': 'promoter', 'promoter.status': 'active' } },
    { $lookup: { from: PromoterVerification.collection.name, localField: 'promoterId', foreignField: 'userId', as: 'verification' } }, { $unwind: '$verification' },
    { $match: { 'verification.country': context.country, 'verification.status': 'verified' } },
    { $lookup: { from: CampaignApplication.collection.name, let: { campaign: '$campaign._id', promoter: '$promoterId' }, pipeline: [{ $match: {
      status: 'approved', country: context.country, $expr: { $and: [{ $eq: ['$campaignId', '$$campaign'] }, { $eq: ['$promoterUserId', '$$promoter'] }] } } }], as: 'application' } },
    { $match: { 'application.0': { $exists: true } } }];
}
function sellerConversationDto(row, actorId) {
  return { publicId: row.publicId, subject: row.subject || row.campaign.name, status: row.status, version: Number(row.__v || 0),
    lastMessageAt: row.lastMessageAt, counterpart: row.promoter.roleProfile?.publicName || row.promoter.name, campaignName: row.campaign.name,
    campaignPublicId: row.campaign.publicId,
    messages: (row.messages || []).map(message => ({ publicId: message.publicId, sender: same(message.senderUserId, actorId) ? 'You' : row.promoter.roleProfile?.publicName || row.promoter.name,
      body: message.body, sentAt: message.sentAt, read: (message.readByUserIds || []).some(userId => !same(userId, message.senderUserId)) })) };
}
export async function sellerPromoterConversationsPage(request) {
  const context = await sellerConversationAccess(request), filter = filters(request, ['open', 'closed', 'archived']);
  const pipeline = sellerConversationPipeline(context);
  const [result, totals] = await Promise.all([page(MarketplaceConversation, [...pipeline, ...filterStage(filter, ['publicId', 'subject', 'promoter.name', 'campaign.name'])], request, 'lastMessageAt'),
    MarketplaceConversation.aggregate([...pipeline, { $group: { _id: '$status', count: { $sum: 1 }, messages: { $sum: { $size: '$messages' } } } }])]);
  const counts = Object.fromEntries(totals.map(row => [row._id, row.count])), total = totals.reduce((sum, row) => sum + row.count, 0);
  const flow = { kind: 'promoter-conversation', editable: true, filters: filter, page: result.page, country: context.country,
    currency: context.market.currency, timeZone: context.market.timeZone, records: result.items.map(row => sellerConversationDto(row, context.actor._id)),
    metrics: [{ label: 'Promoter conversations', value: total, detail: 'Approved partnerships owned by your store' },
      { label: 'Open conversations', value: counts.open || 0, detail: 'Threads available for follow-up' },
      { label: 'Closed conversations', value: counts.closed || 0, detail: 'Resolved collaboration history' },
      { label: 'Recorded messages', value: totals.reduce((sum, row) => sum + row.messages, 0), detail: 'Saved messages across all eligible threads' }],
    columns: ['Conversation', 'Promoter', 'Campaign', 'Status'], tableTitle: 'Promoter campaign conversations',
    insights: [`${counts.open || 0} campaign conversations are open.`, 'Only the verified store owner and approved promoter participate in these conversations.',
      'Replies and state changes notify the promoter in their account.'],
    health: { label: 'Conversation completion', value: total ? (counts.closed || 0) / total * 100 : null,
      rows: [{ label: 'Open', value: counts.open || 0 }, { label: 'Closed', value: counts.closed || 0 }, { label: 'Total', value: total }] },
    workflow: [{ title: 'Review promoter messages', text: 'Check messages for your approved active seller campaigns.' },
      { title: 'Reply to the promoter', text: 'Keep collaboration messages in the private shared conversation.' },
      { title: 'Resolve completed conversations', text: 'Close the thread after its campaign question is handled.' }],
  };
  flow.rows = flow.records.map(row => ({ id: row.publicId, cells: [row.subject, row.counterpart, row.campaignName, human(row.status)],
    href: '/seller/promoter-messages/' + encodeURIComponent(row.publicId) }));
  const selectedId = request.params?.publicId || request.query?.thread;
  if (selectedId) {
    const [row] = await MarketplaceConversation.aggregate([...pipeline, { $match: { publicId: idInput.parse(selectedId) } }]);
    if (!row) throw new AppError('Promoter conversation not found.', 404, 'CONTACT_NOT_FOUND');
    flow.selected = sellerConversationDto(row, context.actor._id);
  }
  // The shared seller frame uses sellerPage.href for status/search/pagination links.
  flow.baseHref = '/seller/promoter-messages';
  return flow;
}
export async function updateSellerPromoterConversation(request, action = 'reply') {
  const id = idInput.parse(request.params.publicId), version = versionInput.parse(request.body.version);
  const body = action === 'reply' ? z.string().trim().min(2).max(4000).parse(request.body.message) : '';
  if (!['reply', 'read', 'resolve'].includes(action)) throw new AppError('Choose a valid conversation action.', 422, 'MESSAGE_INVALID');
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const context = await sellerConversationAccess(request, session, true);
      const [scoped] = await MarketplaceConversation.aggregate([...sellerConversationPipeline(context), { $match: { publicId: id } }]).session(session);
      if (!scoped) throw new AppError('Promoter conversation not found.', 404, 'CONTACT_NOT_FOUND');
      for (const [Model, scope] of [[User, { _id: scoped.promoter._id, role: 'promoter', status: 'active' }],
        [PromoterVerification, { _id: scoped.verification._id, country: context.country, status: 'verified' }],
        [Campaign, { ...activeCampaignScope(context.country), _id: scoped.campaign._id, ownerUserId: context.actor._id }],
        [CampaignApplication, { _id: scoped.application[0]._id, promoterUserId: scoped.promoter._id, country: context.country, status: 'approved' }]]) {
        const write = await Model.updateOne(scope, { $inc: { __v: 1 } }, { session });
        if (!write.matchedCount) throw new AppError('The campaign relationship changed.', 409, 'CONTACT_UNAVAILABLE');
      }
      const thread = await MarketplaceConversation.findById(scoped._id).session(session); checkVersion(thread, version);
      if (thread.status !== 'open') throw new AppError('This conversation is closed.', 409, 'CONTACT_CLOSED');
      if (action === 'reply') {
        if (thread.messages.length >= 500) throw new AppError('This conversation has reached its message limit.', 409, 'MESSAGE_LIMIT');
        thread.messages.push({ publicId: publicId('msg'), senderUserId: context.actor._id, body, sentAt: new Date(), readByUserIds: [context.actor._id] });
        thread.lastMessageAt = new Date();
      } else if (action === 'read') {
        for (const message of thread.messages) if (!message.readByUserIds.some(userId => same(userId, context.actor._id))) message.readByUserIds.push(context.actor._id);
      } else thread.status = 'closed';
      thread.markModified('messages'); await thread.save({ session });
      await writeAudit(request, `seller.promoter_conversation_${action}`, { session, actor: context.actor,
        targetType: 'marketplace_conversation', targetPublicId: thread.publicId, country: context.country });
      await notification(request, context, session, scoped.promoter, action === 'reply' ? 'Campaign seller replied' : action === 'read' ? 'Campaign seller read your conversation' : 'Campaign seller resolved your conversation',
        action === 'reply' ? body : thread.subject, path('/promoter/messages', { tab: 'campaigns', thread: thread.publicId }));
      return { publicId: thread.publicId, version: thread.__v };
    });
  } catch (error) {
    if (error.name === 'VersionError') throw new AppError('This conversation changed. Reload before saving.', 409, 'RELATIONSHIP_VERSION_CONFLICT');
    throw error;
  } finally { await session.endSession(); }
}

import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { ApprovalRequest, AuditLog, Brand, BusinessMember, BusinessOrganization, Campaign, Category, CmsContent, CountrySetting, Coupon, EvidenceDocument, LedgerAccount, LedgerTransaction, MarketingCampaign, Order, PaymentIntent, PlatformGrant, PlatformStaffInvitation, Product, PromoterVerification, ProviderEvent, ReconciliationRun, Refund, ReturnRequest, Review, SellerReturnCase, SellerVerification, Store, StoreMember, SupportTicket, User, VerificationDocument } from '../models/index.js';
import { countryAdminAccess, assertCountryAdminReadAccess, countryAdminPublicContext } from './country-admin-workspace-access.js';
import { sellerOverviewWindow } from './seller-overview.js';
import { cursorScope, cursorSort, decodeCursor, pageResult } from './pagination.js';
import { writeAudit } from './audit.js';
import { moderationReviewPipeline } from './moderation-trust-pages.js';

const SIZE = 25;
const REPORTS = ['summary', 'operational', 'audit'];
const ACTIVE_TICKETS = ['open', 'in_progress', 'waiting_customer', 'escalated'];
const PAYMENT_EXCEPTIONS = ['created', 'requires_action', 'pending', 'failed', 'pending_collection'];
const REFUND_BACKLOG = ['pending', 'processing', 'failed'];
const OPERATIONAL_STATUSES = ['all', 'submitted', 'appealed', ...PAYMENT_EXCEPTIONS, 'processing', ...ACTIVE_TICKETS];
const PERIODS = ['30days', '7months', 'year'];
const COUNT_FIELDS = ['customerCount', 'sellerCount', 'productCount', 'promoterCount', 'orderCount', 'orderSourceCount', 'paymentCount', 'refundCount', 'supportCount', 'sellerVerificationCount', 'productReviewCount', 'promoterVerificationCount', 'paymentExceptionCount', 'refundBacklogCount', 'openTicketCount', 'overdueTicketCount', 'supportSlaObservedCount', 'supportSlaWithinCount'];
const int = value => { const n = Number(value ?? 0); if (!Number.isSafeInteger(n) || n < 0) throw new AppError('Country reporting data needs review.', 503, 'COUNTRY_ADMIN_REPORT_INVALID'); return n; };
const label = value => String(value || '').replaceAll('_', ' ');
const ratio = (a, b) => b > 0 ? Math.round(a / b * 1000) / 10 : null;
const iso = value => value ? new Date(value).toISOString() : '';
const regex = value => new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const count = condition => ({ $sum: { $cond: [condition, 1, 0] } });
const validMinor = value => ({ $and: [{ $isNumber: value }, { $gte: [value, 0] }, { $lte: [value, Number.MAX_SAFE_INTEGER] }, { $eq: [value, { $trunc: { $cond: [{ $isNumber: value }, value, -1] } }] }] });
const periodMatch = window => ({ createdAt: { $gte: window.start, $lt: window.end } });
const availableCountries = context => context.countries.filter(row => !context.country || row.code === context.country);

export const countryAdminReportingWindow = (period = '30days', timeZone = 'UTC', now = new Date()) => sellerOverviewWindow(period, timeZone, now);

function filters(request, actor, pageId) {
  const preferred = actor.preferences?.countryAdminReportingPeriod;
  const query = z.object({ country: z.string().trim().max(2).optional(), period: z.enum(PERIODS).default(PERIODS.includes(preferred) ? preferred : '30days'), report: z.enum(REPORTS).default('summary'), search: z.string().trim().max(100).default(''), q: z.string().trim().max(100).optional(), status: z.string().max(32).default('all'), after: z.string().max(512).default('') }).parse(request.query || {});
  if (pageId === 'admin-overview') query.report = 'summary';
  if (query.after && !decodeCursor(query.after)) throw new AppError('The Country Admin report cursor is invalid.', 422, 'COUNTRY_ADMIN_FILTER_INVALID');
  const statuses = query.report === 'audit' ? ['all', 'success', 'denied', 'failure'] : query.report === 'operational' ? OPERATIONAL_STATUSES : ['all'];
  if (!statuses.includes(query.status) || (query.report === 'summary' && query.after)) throw new AppError('Select valid filters for this report.', 422, 'COUNTRY_ADMIN_FILTER_INVALID');
  return { ...query, search: query.q ?? query.search, statuses: [...new Set(statuses)] };
}

// Catalogue jurisdiction comes from the current source Store, never Product.countries.
export function countryAdminStoreSource(scope, { verification = false, reviewQueue = false, catalogue = false } = {}) {
  const storeScope = { ...scope, ...(reviewQueue ? { status: 'pending_verification' } : catalogue ? { status: { $in: ['pending_verification', 'verified', 'suspended'] } } : {}) };
  return [{ $lookup: { from: Store.collection.name, localField: 'storeId', foreignField: '_id', as: 'sourceStore', pipeline: [{ $match: storeScope }, { $project: { publicId: 1, country: 1, currency: 1, ownerUserId: 1 } }] } }, { $unwind: '$sourceStore' },
    { $match: { $expr: { $eq: [verification ? '$userId' : '$ownerUserId', '$sourceStore.ownerUserId'] } } }, { $set: { country: '$sourceStore.country', currency: '$sourceStore.currency' } }];
}

// Use the same identity boundaries as the actual Customer and Promoter queues.
// A stored shopping role does not make a platform or merchant identity personal.
function personalIdentityExclusions(localField = '_id') {
  const definitions = [[PlatformGrant, 'userId', 'platformGrants', {}], [PlatformStaffInvitation, 'acceptedByUserId', 'staffInvitations', {}],
    [Store, 'ownerUserId', 'ownedStores', {}], [StoreMember, 'userId', 'storeMemberships', { status: { $in: ['active', 'invited'] } }],
    [BusinessOrganization, 'ownerUserId', 'ownedBusinesses', {}], [BusinessMember, 'userId', 'businessMemberships', { status: { $in: ['active', 'invited'] } }]];
  return [...definitions.map(([Model, foreignField, as, match]) => ({ $lookup: { from: Model.collection.name, localField, foreignField, as,
    pipeline: [{ $match: match }, { $limit: 1 }, { $project: { _id: 1 } }] } })),
  { $match: Object.fromEntries(definitions.map(([, , as]) => [as + '.0', { $exists: false }])) }];
}

function customerSource(scope) {
  return [{ $match: { ...scope, role: 'customer', platformAccessManagedAt: null, status: { $in: ['active', 'suspended'] } } }, ...personalIdentityExclusions()];
}

export function countryAdminPromoterSource(scope) {
  return [{ $match: { ...scope, status: { $in: ['submitted', 'appealed', 'verified', 'rejected'] } } },
    { $lookup: { from: User.collection.name, localField: 'userId', foreignField: '_id', as: 'sourceUser', pipeline: [{ $match: { role: 'promoter', platformAccessManagedAt: null, status: 'active', emailVerifiedAt: { $type: 'date' }, onboardingCompletedAt: { $type: 'date' } } }, { $project: { publicId: 1 } }] } }, { $unwind: '$sourceUser' },
    ...personalIdentityExclusions('sourceUser._id')];
}

// Payment declarations must agree with a real source order's public reference,
// market and currency. Refunds independently verify that same payment/order chain.
export function countryAdminPaymentSource(scope) {
  return [{ $match: scope }, { $lookup: { from: Order.collection.name, localField: 'orderId', foreignField: '_id', as: 'sourceOrder', pipeline: [{ $match: scope }, { $project: { publicId: 1, country: 1, totals: 1 } }] } }, { $unwind: '$sourceOrder' },
    { $match: { $expr: { $and: [{ $eq: ['$orderPublicId', '$sourceOrder.publicId'] }, { $eq: ['$country', '$sourceOrder.country'] }, { $eq: ['$currency', '$sourceOrder.totals.currency'] }, validMinor('$amountMinor'), validMinor('$sourceOrder.totals.totalMinor'), { $lte: ['$amountMinor', '$sourceOrder.totals.totalMinor'] }] } } }];
}

export function countryAdminRefundSource(scope) {
  return [{ $lookup: { from: PaymentIntent.collection.name, localField: 'paymentIntentId', foreignField: '_id', as: 'sourcePayment', pipeline: [...countryAdminPaymentSource(scope), { $project: { publicId: 1, orderId: 1, country: 1, currency: 1, amountMinor: 1, sourceOrder: 1 } }] } }, { $unwind: '$sourcePayment' },
    { $match: { $expr: { $and: [{ $eq: ['$orderId', '$sourcePayment.orderId'] }, { $eq: ['$currency', '$sourcePayment.currency'] }, validMinor('$amountMinor'), { $gt: ['$amountMinor', 0] }, { $lte: ['$amountMinor', '$sourcePayment.amountMinor'] }] } } }, { $set: { country: '$sourcePayment.country', orderPublicId: '$sourcePayment.sourceOrder.publicId' } }];
}

// A settlement amount requires balanced immutable ledger evidence and matching
// account IDs/public references in the same country and currency.
function settlementEvidence(referenceType) {
  return [{ $lookup: { from: LedgerTransaction.collection.name, let: { reference: '$publicId', country: '$country', currency: '$currency', amount: '$amountMinor' }, as: 'sourceLedger', pipeline: [
    { $match: { referenceType, $expr: { $and: [{ $eq: ['$referencePublicId', '$$reference'] }, { $eq: ['$country', '$$country'] }, { $eq: ['$currency', '$$currency'] }] } } },
    { $set: { debitMinor: { $sum: '$entries.debitMinor' }, creditMinor: { $sum: '$entries.creditMinor' } } },
    { $match: { $expr: { $and: [{ $gte: [{ $size: '$entries' }, 2] }, { $gte: [{ $size: { $setUnion: ['$entries.accountId', []] } }, 2] }, { $eq: ['$debitMinor', '$$amount'] }, { $eq: ['$creditMinor', '$$amount'] }, { $gt: ['$debitMinor', 0] }, { $allElementsTrue: [{ $map: { input: '$entries', as: 'entry', in: { $and: [validMinor('$$entry.debitMinor'), validMinor('$$entry.creditMinor'), { $ne: [{ $eq: ['$$entry.debitMinor', 0] }, { $eq: ['$$entry.creditMinor', 0] }] }] } } }] }] } } },
    { $lookup: { from: LedgerAccount.collection.name, localField: 'entries.accountId', foreignField: '_id', as: 'sourceAccounts' } },
    { $match: { $expr: { $allElementsTrue: [{ $map: { input: '$entries', as: 'entry', in: { $anyElementTrue: [{ $map: { input: '$sourceAccounts', as: 'account', in: { $and: [{ $eq: ['$$entry.accountId', '$$account._id'] }, { $eq: ['$$entry.accountPublicId', '$$account.publicId'] }, { $eq: ['$$account.country', '$$country'] }, { $eq: ['$$account.currency', '$$currency'] }] } } }] } } }] } } }, { $limit: 1 }, { $project: { publicId: 1 } },
  ] } }, { $set: { settlementVerified: { $gt: [{ $size: '$sourceLedger' }, 0] } } }];
}

function supportSource(scope, now) {
  return [{ $match: { ...scope, mergedIntoPublicId: { $in: ['', null] }, createdAt: { $type: 'date' } } }, { $set: {
    validSla: { $and: [{ $eq: [{ $type: '$slaDueAt' }, 'date'] }, { $gte: ['$slaDueAt', '$createdAt'] }] },
    firstResponseAt: { $min: { $map: { input: { $filter: { input: { $slice: [{ $ifNull: ['$notes', []] }, 1, 2147483647] }, as: 'note', cond: { $and: [{ $ne: ['$$note.internal', true] }, { $eq: [{ $type: '$$note.actorUserId' }, 'objectId'] }, { $ne: ['$$note.actorUserId', { $ifNull: ['$userId', null] }] }, { $eq: [{ $type: '$$note.at' }, 'date'] }, { $gte: ['$$note.at', '$createdAt'] }, { $lte: ['$$note.at', now] }] } } }, as: 'note', in: '$$note.at' } } },
  } }];
}

async function queries(tasks, session) { if (!session) return Promise.all(tasks.map(task => task())); const values = []; for (const task of tasks) values.push(await task()); return values; }

export async function countryAdminReportSummary(context, window, now = new Date()) {
  const scope = context.countryScope, aggregate = (Model, pipeline) => Model.aggregate(pipeline).session(context.session || null);
  const grouping = fields => ({ $group: { _id: '$country', ...fields } });
  const active = { $in: ['$status', ACTIVE_TICKETS] }, responded = { $eq: [{ $type: '$firstResponseAt' }, 'date'] };
  const [customers, sellers, verifications, products, promoters, orders, payments, refunds, support] = await queries([
    () => aggregate(User, [...customerSource(scope), grouping({ customerCount: { $sum: 1 } })]),
    () => aggregate(Store, [{ $match: scope }, grouping({ sellerCount: { $sum: 1 } })]),
    () => aggregate(SellerVerification, [{ $match: { status: { $in: ['submitted', 'appealed'] } } }, ...countryAdminStoreSource(scope, { verification: true, reviewQueue: true }), grouping({ sellerVerificationCount: { $sum: 1 } })]),
    () => aggregate(Product, [...countryAdminStoreSource(scope, { catalogue: true }), grouping({ productCount: { $sum: 1 }, productReviewCount: count({ $eq: ['$status', 'submitted'] }) })]),
    () => aggregate(PromoterVerification, [...countryAdminPromoterSource(scope), grouping({ promoterCount: { $sum: 1 }, promoterVerificationCount: count({ $in: ['$status', ['submitted', 'appealed']] }) })]),
    () => aggregate(Order, [{ $match: scope }, { $match: { $expr: { $and: [validMinor('$totals.totalMinor'), { $regexMatch: { input: { $ifNull: ['$totals.currency', ''] }, regex: '^[A-Z]{3}$' } }] } } }, { $group: { _id: { country: '$country', currency: '$totals.currency' }, orderSourceCount: { $sum: 1 }, orderCount: count({ $and: [{ $gte: ['$createdAt', window.start] }, { $lt: ['$createdAt', window.end] }] }), orderTotalMinor: { $sum: { $cond: [{ $and: [{ $gte: ['$createdAt', window.start] }, { $lt: ['$createdAt', window.end] }] }, '$totals.totalMinor', 0] } } } }]),
    () => aggregate(PaymentIntent, [...countryAdminPaymentSource(scope), ...settlementEvidence('payment'), { $group: { _id: { country: '$country', currency: '$currency' }, paymentCount: { $sum: 1 }, paymentExceptionCount: count({ $in: ['$status', PAYMENT_EXCEPTIONS] }), settledPaymentCount: count({ $and: ['$settlementVerified', { $in: ['$status', ['succeeded', 'partially_refunded', 'refunded']] }, { $gte: ['$paidAt', window.start] }, { $lt: ['$paidAt', window.end] }] }), settledPaymentMinor: { $sum: { $cond: [{ $and: ['$settlementVerified', { $in: ['$status', ['succeeded', 'partially_refunded', 'refunded']] }, { $gte: ['$paidAt', window.start] }, { $lt: ['$paidAt', window.end] }] }, '$amountMinor', 0] } } } }]),
    () => aggregate(Refund, [...countryAdminRefundSource(scope), ...settlementEvidence('refund'), { $group: { _id: { country: '$country', currency: '$currency' }, refundCount: { $sum: 1 }, refundBacklogCount: count({ $in: ['$status', REFUND_BACKLOG] }), completedRefundCount: count({ $and: ['$settlementVerified', { $eq: ['$status', 'completed'] }, { $gte: ['$completedAt', window.start] }, { $lt: ['$completedAt', window.end] }] }), completedRefundMinor: { $sum: { $cond: [{ $and: ['$settlementVerified', { $eq: ['$status', 'completed'] }, { $gte: ['$completedAt', window.start] }, { $lt: ['$completedAt', window.end] }] }, '$amountMinor', 0] } } } }]),
    () => aggregate(SupportTicket, [...supportSource(scope, now), grouping({ supportCount: { $sum: 1 }, openTicketCount: count(active), overdueTicketCount: count({ $and: [active, '$validSla', { $lt: ['$slaDueAt', now] }] }), supportSlaObservedCount: count({ $and: ['$validSla', { $or: [responded, active] }] }), supportSlaWithinCount: count({ $and: ['$validSla', { $or: [{ $and: [responded, { $lte: ['$firstResponseAt', '$slaDueAt'] }] }, { $and: [{ $not: [responded] }, active, { $gte: ['$slaDueAt', now] }] }] }] }) })]),
  ], context.session);
  const groups = new Map(availableCountries(context).map(row => [row.code, { country: row.code, countryName: row.name, currency: row.currency, ...Object.fromEntries(COUNT_FIELDS.map(field => [field, 0])) }]));
  for (const row of [...customers, ...sellers, ...verifications, ...products, ...promoters, ...support]) { const group = groups.get(row._id); if (group) for (const field of COUNT_FIELDS) if (row[field] !== undefined) group[field] += int(row[field]); }
  const financial = new Map();
  const moneyFields = ['orderCount', 'orderSourceCount', 'orderTotalMinor', 'paymentCount', 'paymentExceptionCount', 'settledPaymentCount', 'settledPaymentMinor', 'refundCount', 'refundBacklogCount', 'completedRefundCount', 'completedRefundMinor'];
  for (const row of [...orders, ...payments, ...refunds]) {
    const country = row._id.country, currency = row._id.currency, countryGroup = groups.get(country); if (!countryGroup) continue;
    const key = country + ':' + currency, group = financial.get(key) || { country, currency, ...Object.fromEntries(moneyFields.map(field => [field, 0])) };
    for (const field of moneyFields) if (row[field] !== undefined) { group[field] += int(row[field]); if (COUNT_FIELDS.includes(field)) countryGroup[field] += int(row[field]); }
    financial.set(key, group);
  }
  const derive = group => ({ ...group, supportServiceLevel: ratio(group.supportSlaWithinCount, group.supportSlaObservedCount), backlogCount: group.sellerVerificationCount + group.productReviewCount + group.promoterVerificationCount + group.paymentExceptionCount + group.refundBacklogCount + group.openTicketCount });
  const countries = [...groups.values()].map(derive).sort((a, b) => a.country.localeCompare(b.country));
  const totals = derive(Object.fromEntries(COUNT_FIELDS.map(field => [field, int(countries.reduce((sum, row) => sum + row[field], 0))])));
  return { groups: countries, countrySummary: countries, totals, financialGroups: [...financial.values()].sort((a, b) => (a.country + a.currency).localeCompare(b.country + b.currency)) };
}

function sidebarSummary(summary) {
  const totals = summary.totals;
  return { ...totals, sourceCounts: { customers: totals.customerCount, sellers: totals.sellerCount, promoters: totals.promoterCount, products: totals.productCount, orders: totals.orderSourceCount, payments: totals.paymentCount, refunds: totals.refundCount, tickets: totals.supportCount },
    backlog: { sellerVerifications: totals.sellerVerificationCount, productReviews: totals.productReviewCount, promoterVerifications: totals.promoterVerificationCount, paymentExceptions: totals.paymentExceptionCount, refunds: totals.refundBacklogCount, supportTickets: totals.openTicketCount, overdueTickets: totals.overdueTicketCount }, countrySummary: summary.groups, groups: summary.groups, financialGroups: summary.financialGroups };
}

export async function loadCountryAdminSidebar(context, { now = new Date() } = {}) {
  const preferred = context.actor.preferences?.countryAdminReportingPeriod;
  return sidebarSummary(await countryAdminReportSummary(context, countryAdminReportingWindow(PERIODS.includes(preferred) ? preferred : '30days', context.timeZone, now), now));
}

const PRODUCT_ACTIONS = ['catalogue.product_claim', 'catalogue.product_release', 'catalogue.product_first_approval', 'catalogue.product_first_approval_recorded', 'catalogue.product_approve', 'catalogue.product_approved', 'catalogue.product_changes', 'catalogue.product_changes_requested', 'catalogue.product_reject', 'catalogue.product_rejected'];
const SELLER_ACTIONS = ['seller.verification_claim', 'seller.verification_release', 'seller.verification_claimed', 'seller.verification_released', 'seller.verification_approved', 'seller.verification_rejected'];
const PERSONAL_ACTIONS = ['country_admin.preferences_saved', 'country_admin.preferences_updated', 'country_admin.profile_saved', 'country_admin.profile_updated', 'country_admin.communication_saved', 'country_admin.communication_updated'];
const TARGET_ACTIONS = {
  product: PRODUCT_ACTIONS, seller_verification: SELLER_ACTIONS,
  promoter_verification: ['country_admin.promoter_claim', 'country_admin.promoter_release', 'country_admin.promoter_approve', 'country_admin.promoter_reject'],
  user: ['country_admin.customer_suspend', 'country_admin.customer_reactivate'],
  category: ['country_admin.category_updated'],
  brand: ['country_admin.brand_updated'],
  verification_document: ['country_admin.seller_document_viewed'],
  payment: ['admin.payment_verification_requested', 'finance.payment_provider_verified'],
  refund: ['admin.refund_provider_submission_recorded', 'admin.refund_evidence_added', 'finance.refund_reserved', 'finance.refund_submission_failed', 'finance.refund_completed'],
  return: ['admin.return_finance_referred', 'finance.return_refund_completed', 'support.return_approved', 'support.return_rejected', 'support.return_received', 'support.return_inspected', 'support.return_exchanged'],
  evidence: ['admin.commerce_evidence_opened'],
  provider_event: ['finance.provider_event_requeued'],
  reconciliation_run: ['finance.reconciliation_started'],
  coupon: ['country_admin.coupon_created', 'country_admin.coupon_updated', 'country_admin.coupon_status_changed'],
  review: ['review.moderated', 'review.claimed', 'review.released', 'review.public_reply', 'trust.public_reply'],
  support_ticket: ['support.ticket_claim', 'support.ticket_release', 'support.ticket_transfer', 'support.ticket_update', 'support.ticket_reply', 'support.ticket_status', 'support.ticket_reopen'],
  campaign: ['country_admin.affiliate_campaign_decided'],
  marketing_campaign: ['country_admin.campaign_created', 'country_admin.campaign_updated', 'country_admin.campaign_queued', 'country_admin.campaign_cancelled'],
  cms: ['country_admin.cms_revision_created', 'country_admin.cms_approval_decided'],
  approval: ['country_admin.cms_publication_requested', 'country_admin.cms_approval_decided', 'country_admin.settings_approval_decided'],
  country_setting: ['country_admin.country_settings_requested', 'country_admin.country_settings_updated'],
};
const EXPORT_ACTIONS = ['country_admin.report_exported', 'country_admin.catalogue_exported', 'country_admin.growth_exported', 'admin.commerce_exported', 'country_admin.settings_exported', 'country_admin.support_exported'];

function commerceEvidenceSource(scope, returnSource) {
  return [{ $match: { ...scope, status: 'ready', contextType: { $in: ['return', 'seller_return'] } } },
    { $lookup: { from: ReturnRequest.collection.name, let: { reference: '$contextPublicId', evidenceId: '$_id' }, as: 'directReturn', pipeline: [
      { $match: { $expr: { $and: [{ $eq: ['$publicId', '$$reference'] }, { $in: ['$$evidenceId', { $ifNull: ['$evidenceDocumentIds', []] }] }] } } }, ...returnSource,
    ] } },
    { $lookup: { from: SellerReturnCase.collection.name, let: { reference: '$contextPublicId', evidenceId: '$_id' }, as: 'sellerReturn', pipeline: [
      { $match: { ...scope, $expr: { $and: [{ $eq: ['$publicId', '$$reference'] }, { $in: ['$$evidenceId', { $ifNull: ['$evidenceDocumentIds', []] }] }] } } },
      { $lookup: { from: ReturnRequest.collection.name, localField: 'returnRequestId', foreignField: '_id', as: 'sourceReturn', pipeline: returnSource } }, { $unwind: '$sourceReturn' },
      { $match: { $expr: { $and: [{ $eq: ['$returnPublicId', '$sourceReturn.publicId'] }, { $eq: ['$orderPublicId', '$sourceReturn.orderPublicId'] }, { $eq: ['$country', '$sourceReturn.country'] }] } } },
    ] } },
    { $set: { sourceReturn: { $cond: [{ $eq: ['$contextType', 'return'] }, { $arrayElemAt: ['$directReturn', 0] }, { $arrayElemAt: ['$sellerReturn.sourceReturn', 0] }] } } },
    { $match: { $expr: { $eq: ['$country', '$sourceReturn.country'] } } },
    // Reports identify the return, without exposing private evidence identifiers.
    { $set: { publicId: '$sourceReturn.publicId' } },
  ];
}

function providerEventSource(scope) {
  return [{ $match: { ...scope, provider: 'pesapal', verifiedAt: { $type: 'date' } } },
    { $lookup: { from: PaymentIntent.collection.name, localField: 'merchantReference', foreignField: 'providerReference', as: 'sourcePayment', pipeline: countryAdminPaymentSource(scope) } }, { $unwind: '$sourcePayment' },
    { $match: { $expr: { $and: [{ $eq: ['$provider', '$sourcePayment.provider'] }, { $ne: ['$providerTrackingId', ''] }, { $eq: ['$providerTrackingId', '$sourcePayment.providerTrackingId'] }, { $eq: ['$country', '$sourcePayment.country'] },
      { $or: [{ $eq: [{ $ifNull: ['$paymentIntentPublicId', ''] }, ''] }, { $eq: ['$paymentIntentPublicId', '$sourcePayment.publicId'] }] },
      { $or: [{ $eq: [{ $ifNull: ['$orderPublicId', ''] }, ''] }, { $eq: ['$orderPublicId', '$sourcePayment.orderPublicId'] }] },
    ] } } },
  ];
}

function affiliateCampaignSource(scope) {
  return [{ $match: { ...scope, scope: 'seller' } }, { $set: { declaredCountry: '$country' } }, ...countryAdminStoreSource(scope),
    { $match: { $expr: { $eq: ['$declaredCountry', '$sourceStore.country'] } } },
  ];
}

export function countryAdminAuditPipeline(context, window, query = {}) {
  const match = { ...context.countryScope, action: { $in: [...Object.values(TARGET_ACTIONS).flat(), ...PERSONAL_ACTIONS, ...EXPORT_ACTIONS] }, createdAt: { $gte: window.start, $lt: window.end } };
  if (query.status && query.status !== 'all') match.result = query.status;
  if (query.search) match.$or = ['action', 'targetPublicId', 'actorPublicId', 'requestId'].map(field => ({ [field]: regex(query.search) }));
  const source = (Model, type, pipeline, foreignField = 'publicId') => ({ $lookup: { from: Model.collection.name, localField: 'targetPublicId', foreignField, as: 'target_' + type, pipeline: [...pipeline, { $project: { publicId: 1, country: 1, countries: 1, code: 1 } }] } });
  const returnSource = [{ $match: context.countryScope }, { $lookup: { from: Order.collection.name, localField: 'orderId', foreignField: '_id', as: 'sourceOrder', pipeline: [{ $match: context.countryScope }, { $project: { publicId: 1, country: 1, userId: 1 } }] } }, { $unwind: '$sourceOrder' }, { $match: { $expr: { $and: [{ $eq: ['$orderPublicId', '$sourceOrder.publicId'] }, { $eq: ['$country', '$sourceOrder.country'] }, { $eq: ['$userId', '$sourceOrder.userId'] }] } } }];
  const approvalSource = [{ $match: { ...context.countryScope, type: { $in: ['cms_publish', 'cms_rollback', 'country_settings'] } } }, { $lookup: { from: CmsContent.collection.name, localField: 'targetPublicId', foreignField: 'publicId', as: 'sourceCms' } }, { $lookup: { from: CountrySetting.collection.name, localField: 'targetPublicId', foreignField: 'code', as: 'sourceSetting' } }, { $match: { $expr: { $or: [{ $and: [{ $in: ['$type', ['cms_publish', 'cms_rollback']] }, { $eq: ['$country', { $arrayElemAt: ['$sourceCms.country', 0] }] }] }, { $and: [{ $eq: ['$type', 'country_settings'] }, { $eq: ['$country', { $arrayElemAt: ['$sourceSetting.code', 0] }] }] }] } } }];
  const joins = [source(Product, 'product', countryAdminStoreSource(context.countryScope)), source(SellerVerification, 'seller_verification', countryAdminStoreSource(context.countryScope, { verification: true })), source(PromoterVerification, 'promoter_verification', countryAdminPromoterSource(context.countryScope)), source(User, 'user', customerSource(context.countryScope)), source(Category, 'category', []), source(Brand, 'brand', [{ $lookup: { from: Store.collection.name, localField: 'requestedByStoreId', foreignField: '_id', as: 'sourceStore', pipeline: [{ $match: context.countryScope }] } }, { $unwind: '$sourceStore' }, { $set: { country: '$sourceStore.country' } }]), source(VerificationDocument, 'verification_document', [{ $lookup: { from: SellerVerification.collection.name, localField: 'verificationId', foreignField: '_id', as: 'sourceVerification', pipeline: countryAdminStoreSource(context.countryScope, { verification: true }) } }, { $unwind: '$sourceVerification' }, { $match: { $expr: { $and: [{ $eq: ['$storeId', '$sourceVerification.storeId'] }, { $eq: ['$userId', '$sourceVerification.userId'] }] } } }, { $set: { country: '$sourceVerification.country', publicId: '$sourceVerification.publicId' } }]), source(PaymentIntent, 'payment', countryAdminPaymentSource(context.countryScope)), source(Refund, 'refund', countryAdminRefundSource(context.countryScope)), source(ReturnRequest, 'return', returnSource), source(EvidenceDocument, 'evidence', commerceEvidenceSource(context.countryScope, returnSource)), source(ProviderEvent, 'provider_event', providerEventSource(context.countryScope)), source(ReconciliationRun, 'reconciliation_run', [{ $match: { ...context.countryScope, provider: 'pesapal' } }]), source(Coupon, 'coupon', [{ $match: { ...context.countryScope, scope: 'platform' } }]), source(Review, 'review', [...moderationReviewPipeline(context), { $match: { 'sourceStore.country': context.countryScope.country, $expr: { $eq: ['$sourceProduct.ownerUserId', '$sourceStore.ownerUserId'] } } }]), source(SupportTicket, 'support_ticket', supportSource(context.countryScope, new Date())), source(Campaign, 'campaign', affiliateCampaignSource(context.countryScope)), source(MarketingCampaign, 'marketing_campaign', [{ $match: context.countryScope }]), source(CmsContent, 'cms', [{ $match: context.countryScope }]), source(ApprovalRequest, 'approval', approvalSource), source(CountrySetting, 'country_setting', [{ $match: { active: true } }, { $set: { country: '$code' } }], 'code')];
  const branches = Object.entries(TARGET_ACTIONS).map(([type, actions]) => ({ $and: [{ $eq: ['$targetType', type] }, { $in: ['$action', actions] }, type === 'category' ? { $in: ['$country', { $ifNull: [{ $arrayElemAt: ['$target_category.countries', 0] }, []] }] } : { $eq: ['$country', { $arrayElemAt: ['$target_' + type + '.country', 0] }] }] }));
  return [{ $match: match }, ...joins, { $lookup: { from: User.collection.name, localField: 'actorId', foreignField: '_id', as: 'auditActor', pipeline: [{ $project: { publicId: 1 } }] } }, { $match: { $expr: { $and: [{ $eq: ['$actorPublicId', { $arrayElemAt: ['$auditActor.publicId', 0] }] }, { $or: [...branches,
    { $and: [{ $eq: ['$targetType', 'user'] }, { $eq: ['$targetPublicId', '$actorPublicId'] }, { $in: ['$action', PERSONAL_ACTIONS] }] },
    { $and: [{ $eq: ['$action', 'country_admin.report_exported'] }, { $eq: ['$targetType', 'country_admin_report'] }, { $in: ['$targetPublicId', REPORTS] }] },
    { $and: [{ $eq: ['$action', 'country_admin.catalogue_exported'] }, { $eq: ['$targetType', 'country_admin_export'] }, { $in: ['$metadata.pageId', ['admin-seller-approvals', 'admin-promoter-approvals', 'admin-customers', 'admin-products', 'admin-categories', 'admin-reviews']] }] },
    { $and: [{ $eq: ['$action', 'admin.commerce_exported'] }, { $eq: ['$targetType', 'admin_export'] }, { $in: ['$metadata.pageId', ['admin-orders', 'admin-payments', 'admin-returns']] }] },
    { $and: [{ $eq: ['$action', 'country_admin.growth_exported'] }, { $eq: ['$targetType', 'growth_export'] }, { $in: [{ $ifNull: ['$metadata.pageId', '$metadata.domain'] }, ['admin-coupons', 'admin-campaigns', 'admin-content']] }] },
    { $and: [{ $eq: ['$action', 'country_admin.support_exported'] }, { $eq: ['$targetType', 'support_export'] }] },
  ] }] } } }, { $project: { requestId: 1, actorPublicId: 1, action: 1, targetType: { $switch: { branches: [{ case: { $eq: ['$targetType', 'verification_document'] }, then: 'seller_verification' }, { case: { $eq: ['$targetType', 'evidence'] }, then: 'return' }], default: '$targetType' } }, targetPublicId: { $switch: { branches: [{ case: { $eq: ['$targetType', 'verification_document'] }, then: { $arrayElemAt: ['$target_verification_document.publicId', 0] } }, { case: { $eq: ['$targetType', 'evidence'] }, then: { $arrayElemAt: ['$target_evidence.publicId', 0] } }], default: { $ifNull: ['$targetPublicId', '$metadata.pageId'] } } }, country: 1, result: 1, createdAt: 1 } }];
}

const auditDTO = row => ({ requestId: row.requestId, actorPublicId: row.actorPublicId || '', action: row.action, targetType: row.targetType, targetPublicId: row.targetPublicId || '', country: row.country, result: row.result, createdAt: row.createdAt });

function operationalSource(context, query, now) {
  const scope = context.countryScope;
  const project = type => ({ $project: { publicId: 1, country: 1, currency: 1, status: 1, createdAt: 1, type: { $literal: type } } });
  const sources = [
    { Model: Product, pipeline: [{ $match: { status: 'submitted' } }, ...countryAdminStoreSource(scope, { catalogue: true }), project('product')] },
    { Model: SellerVerification, pipeline: [{ $match: { status: { $in: ['submitted', 'appealed'] } } }, ...countryAdminStoreSource(scope, { verification: true, reviewQueue: true }), project('seller_verification')] },
    { Model: PromoterVerification, pipeline: [...countryAdminPromoterSource(scope), { $match: { status: { $in: ['submitted', 'appealed'] } } }, project('promoter_verification')] },
    { Model: PaymentIntent, pipeline: [{ $match: { status: { $in: PAYMENT_EXCEPTIONS } } }, ...countryAdminPaymentSource(scope), project('payment')] },
    { Model: Refund, pipeline: [{ $match: { status: { $in: REFUND_BACKLOG } } }, ...countryAdminRefundSource(scope), project('refund')] },
    { Model: SupportTicket, pipeline: [...supportSource(scope, now), { $match: { status: { $in: ACTIVE_TICKETS } } }, { $project: { publicId: 1, country: 1, status: 1, createdAt: 1, type: { $literal: 'support_ticket' }, slaState: { $cond: ['$validSla', { $cond: [{ $lt: ['$slaDueAt', now] }, 'overdue', 'within deadline'] }, 'unknown'] } } }] },
  ];
  const first = sources[0], pipeline = [...first.pipeline, ...sources.slice(1).map(source => ({ $unionWith: { coll: source.Model.collection.name, pipeline: source.pipeline } })), { $match: { createdAt: { $type: 'date' } } }];
  if (query.status !== 'all') pipeline.push({ $match: { status: query.status } });
  if (query.search) pipeline.push({ $match: { $or: ['publicId', 'country', 'type', 'status'].map(field => ({ [field]: regex(query.search) })) } });
  return { Model: first.Model, pipeline, verify: async row => { const definition = sources.find(source => source.pipeline.at(-1).$project.type.$literal === row.type); const [current] = await definition.Model.aggregate([{ $match: { _id: row._id } }, ...definition.pipeline]); return current || null; }, columns: ['Record', 'Source', 'Country', 'Currency', 'Status', 'SLA'], map: row => ({ publicId: row.publicId, type: row.type, country: row.country, currency: row.currency || '', status: row.status, slaState: row.slaState || '', createdAt: row.createdAt }), cells: row => [row.publicId, label(row.type), row.country, row.currency || '—', label(row.status), row.slaState || '—'], headers: ['Record', 'Source', 'Country', 'Currency', 'Status', 'SLA state', 'Created'], csv: row => [row.publicId, row.type, row.country, row.currency, row.status, row.slaState, iso(row.createdAt)] };
}

function recordSource(context, window, query, now) {
  if (query.report === 'operational') return operationalSource(context, query, now);
  return { Model: AuditLog, pipeline: countryAdminAuditPipeline(context, window, query), verify: async row => { const [current] = await AuditLog.aggregate([{ $match: { _id: row._id } }, ...countryAdminAuditPipeline(context, window, query)]); return current || null; }, columns: ['Action', 'Target', 'Country', 'Operator', 'Result', 'Recorded'], map: auditDTO, cells: row => [label(row.action), row.targetPublicId || '—', row.country, row.actorPublicId, label(row.result), iso(row.createdAt)], headers: ['Request', 'Action', 'Target type', 'Target', 'Country', 'Operator', 'Result', 'Recorded'], csv: row => [row.requestId, row.action, row.targetType, row.targetPublicId, row.country, row.actorPublicId, row.result, iso(row.createdAt)] };
}

const sourceHref = row => ({ product: '/admin/products', seller_verification: '/admin/seller-approvals', promoter_verification: '/admin/promoter-approvals', payment: '/admin/payments', refund: '/admin/payments', support_ticket: '/admin/support' })[row.type];

export async function loadCountryAdminReportPage(request, pageId, { now = new Date() } = {}) {
  if (!['admin-overview', 'admin-reports'].includes(pageId)) throw new AppError('Country Admin report not found.', 404, 'COUNTRY_ADMIN_PAGE_NOT_FOUND');
  const context = await countryAdminAccess(request), query = filters(request, context.actor, pageId), window = countryAdminReportingWindow(query.period, context.timeZone, now), summary = await countryAdminReportSummary(context, window, now), totals = summary.totals;
  let items, rows, page, columns;
  if (query.report === 'summary') {
    items = summary.groups.filter(row => !query.search || `${row.country} ${row.countryName}`.toLowerCase().includes(query.search.toLowerCase())); columns = ['Country', 'Customers', 'Sellers', 'Products', 'Orders', 'Backlog', 'Support SLA']; rows = items.map(row => ({ id: row.country, href: '/admin/reports?' + new URLSearchParams({ country: row.country, period: query.period, report: 'operational' }), cells: [row.country, row.customerCount, row.sellerCount, row.productCount, row.orderCount, row.backlogCount, row.supportServiceLevel === null ? 'No observations' : row.supportServiceLevel + '%'] })); page = { total: items.length, count: items.length, hasMore: false, next: '' };
  } else {
    const source = recordSource(context, window, query, now);
    const [result] = await source.Model.aggregate([...source.pipeline, { $facet: { items: [{ $match: cursorScope({}, query.after) }, { $sort: cursorSort() }, { $limit: SIZE + 1 }], total: [{ $count: 'count' }] } }]);
    const records = pageResult(result?.items || [], { limit: SIZE, total: int(result?.total?.[0]?.count) }); page = records.page; items = records.items.map(source.map); columns = source.columns;
    rows = items.map(row => ({ id: row.publicId || row.requestId, ...(sourceHref(row) ? { href: sourceHref(row) + '?' + new URLSearchParams({ country: row.country, record: row.publicId, ...(row.type === 'refund' ? { view: 'refunds' } : {}) }) } : {}), cells: source.cells(row) }));
  }
  const scopedHref = (path, extra = {}) => path + '?' + new URLSearchParams({ ...(context.country ? { country: context.country } : {}), ...extra });
  const priorities = [{ count: totals.productReviewCount, text: 'products await catalogue review', href: scopedHref('/admin/products', { status: 'submitted' }) }, { count: totals.sellerVerificationCount, text: 'seller verifications await review', href: scopedHref('/admin/seller-approvals', { status: 'submitted' }) }, { count: totals.overdueTicketCount, text: 'support tickets have passed their recorded deadline', href: scopedHref('/admin/support', { overdue: '1' }) }, { count: totals.paymentExceptionCount, text: 'payments need an operational review', href: scopedHref('/admin/payments') }].filter(row => row.count).map(row => ({ ...row, text: row.count + ' ' + row.text }));
  const recent = await AuditLog.aggregate([...countryAdminAuditPipeline(context, window), { $sort: cursorSort() }, { $limit: 4 }]);
  const flow = { kind: 'reports', pageId, country: context.country, context: countryAdminPublicContext(context), period: query.period, report: query.report, timeZone: window.timeZone, window: { start: window.start, end: window.end, timeZone: window.timeZone }, range: { start: window.start, end: window.end },
    periodOptions: [{ value: '30days', label: 'Last 30 days' }, { value: '7months', label: 'Last 7 months' }, { value: 'year', label: 'This year' }], reportOptions: [{ value: 'summary', label: 'Market summary' }, { value: 'operational', label: 'Operational queues' }, { value: 'audit', label: 'Administrative audit' }],
    metrics: [{ label: 'Customers', value: String(totals.customerCount), detail: 'Registered customers in assigned markets' }, { label: 'Orders', value: String(totals.orderCount), detail: 'Source orders in this reporting period' }, { label: 'Operational backlog', value: String(totals.backlogCount), detail: 'Complete current source queues' }, { label: 'Support service level', value: totals.supportServiceLevel === null ? '—' : totals.supportServiceLevel + '%', detail: totals.supportSlaObservedCount ? `${totals.supportSlaObservedCount} recorded deadlines and response states` : 'No observations' }],
    summary: totals, totals, groups: summary.groups, countrySummary: summary.groups, financialGroups: summary.financialGroups, sidebar: sidebarSummary(summary), items, rows, columns, page,
    filters: { search: query.search, status: query.status, after: query.after, statuses: query.report === 'summary' ? [] : query.statuses.map(value => ({ value, label: label(value) })), params: { country: context.country, period: query.period, report: query.report } },
    priorities, insights: priorities, priorityHref: priorities[0]?.href || scopedHref('/admin/reports', { report: 'operational' }),
    health: { label: 'Support service level', value: totals.supportServiceLevel, rows: [{ label: 'Observed deadlines', value: String(totals.supportSlaObservedCount) }, { label: 'Within deadline', value: String(totals.supportSlaWithinCount) }, { label: 'Overdue tickets', value: String(totals.overdueTicketCount) }], note: 'Public staff responses and active tickets are compared with valid recorded SLA deadlines.' },
    verification: { label: 'Support service level', value: totals.supportServiceLevel === null ? '—' : totals.supportServiceLevel + '%', detail: totals.supportSlaObservedCount ? 'Recorded deadlines and replies' : 'No observations' },
    workflow: [{ title: 'Review catalogue work', text: 'Review source products and seller verification queues.', href: scopedHref('/admin/products') }, { title: 'Review commerce work', text: 'Inspect scoped source orders, payments and refunds.', href: scopedHref('/admin/orders') }, { title: 'Review administrative evidence', text: 'Trace allowed administrative actions to their current source records.', href: scopedHref('/admin/reports', { report: 'audit' }) }],
    activity: recent.map(row => ({ text: label(row.action), at: row.createdAt, href: '/admin/reports?' + new URLSearchParams({ country: row.country, report: 'audit', period: query.period, search: row.requestId }), icon: 'i-shield' })), activityHref: scopedHref('/admin/reports', { report: 'audit' }),
    coverage: { title: 'Assigned market coverage', description: 'Live source records in your current administrative scope.', people: [], stats: [{ label: 'Markets', value: String(summary.groups.length) }, { label: 'Sellers', value: String(totals.sellerCount) }], note: 'Financial amounts are grouped by source country and currency.', href: scopedHref('/admin/reports'), label: 'Open reports' },
    tableTitle: query.report === 'audit' ? 'Administrative audit' : query.report === 'operational' ? 'Current operational queues' : 'Country summary', tableDescription: query.report === 'operational' ? 'Current queues include matching source records of every age. Counts cover all records; this page shows up to 25.' : 'Counts cover all scoped records. Financial amounts remain grouped by country and currency.', emptyText: 'No source records match this view.',
    exportHref: (pageId === 'admin-overview' ? '/admin/overview' : '/admin/reports') + '/export.csv?' + new URLSearchParams({ country: context.country, period: query.period, report: query.report, search: query.search, status: query.status }) };
  if (pageId === 'admin-overview') {
    const trend = await Order.aggregate([{ $match: { ...context.countryScope, ...periodMatch(window) } }, { $match: { $expr: { $and: [validMinor('$totals.totalMinor'), { $regexMatch: { input: { $ifNull: ['$totals.currency', ''] }, regex: '^[A-Z]{3}$' } }] } } }, { $group: { _id: { $dateToString: { date: '$createdAt', format: window.monthly ? '%Y-%m' : '%Y-%m-%d', timezone: window.timeZone } }, count: { $sum: 1 } } }]);
    flow.trend = window.buckets.map(bucket => ({ key: bucket.key, label: bucket.label, value: int(trend.filter(row => bucket.keys.includes(row._id)).reduce((sum, row) => sum + int(row.count), 0)) })); flow.trendLabel = 'Source orders'; flow.trendDescription = `Orders placed in the ${window.timeZone} reporting calendar.`;
  }
  await assertCountryAdminReadAccess(request, context); return flow;
}

export function countryAdminCsvCell(value) { const text = String(value ?? ''); return '"' + (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) ? "'" + text : text).replaceAll('"', '""') + '"'; }
const closed = () => new AppError('Export connection closed.', 499, 'EXPORT_CLOSED');
function waitForDrain(response) { return new Promise((resolve, reject) => { const clean = () => { response.off('drain', drain); response.off('close', close); response.off('error', error); }; const drain = () => { clean(); resolve(); }, close = () => { clean(); reject(closed()); }, error = cause => { clean(); reject(cause); }; response.once('drain', drain); response.once('close', close); response.once('error', error); if (response.destroyed) close(); }); }

async function auditExport(request, context, query, response) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (response.destroyed) throw closed();
      const current = await countryAdminAccess(request, { session, write: true });
      if (current.country !== context.country || JSON.stringify(availableCountries(current).map(row => row.code).sort()) !== JSON.stringify(availableCountries(context).map(row => row.code).sort()) || String(current.grant?._id || '') !== String(context.grant?._id || '')) throw new AppError('Country Admin export scope changed.', 403, 'COUNTRY_ADMIN_SCOPE_CHANGED');
      await writeAudit(request, 'country_admin.report_exported', { actor: current.actor, targetType: 'country_admin_report', targetPublicId: query.report, country: current.country || current.countries[0].code, metadata: { pageId: query.pageId, report: query.report, period: query.period, countryScope: availableCountries(current).map(row => row.code) }, session });
      if (response.destroyed) throw closed();
    });
  } finally { await session.endSession(); }
}

export async function streamCountryAdminReportCsv(request, response, pageId, { now = new Date() } = {}) {
  if (!['admin-overview', 'admin-reports'].includes(pageId)) throw new AppError('Country Admin report not found.', 404, 'COUNTRY_ADMIN_PAGE_NOT_FOUND');
  if (response.destroyed) throw closed();
  const context = await countryAdminAccess(request), query = { ...filters(request, context.actor, pageId), pageId }, window = countryAdminReportingWindow(query.period, context.timeZone, now);
  let summary, cursor, first, source;
  try {
    // Resolve source joins before auditing or writing response headers. A source
    // query failure cannot create a successful export audit entry.
    if (query.report === 'summary') summary = await countryAdminReportSummary(context, window, now);
    else { source = recordSource(context, window, query, now); cursor = source.Model.aggregate([...source.pipeline, { $sort: cursorSort() }]).cursor({ batchSize: 100 }); first = await cursor.next(); }
    await assertCountryAdminReadAccess(request, context); await auditExport(request, context, query, response); await assertCountryAdminReadAccess(request, context);
    response.set('Content-Type', 'text/csv; charset=utf-8'); response.set('Content-Disposition', `attachment; filename="classic-mart-country-admin-${query.report}.csv"`); response.set('Cache-Control', 'private, no-store'); response.set('X-Robots-Tag', 'noindex, nofollow');
    const line = async values => { if (response.destroyed) throw closed(); if (!response.write(values.map(countryAdminCsvCell).join(',') + '\r\n')) await waitForDrain(response); };
    if (summary) {
      await line(['Country', 'Currency', 'Customers', 'Sellers', 'Products', 'Promoters', 'Orders', 'Order total minor', 'Settled payments', 'Settled payment minor', 'Completed refunds', 'Completed refund minor', 'Operational backlog', 'Open support tickets', 'Overdue support tickets', 'Observed SLA deadlines', 'Support service level percent']);
      for (const group of summary.groups) {
        if (query.search && !`${group.country} ${group.countryName}`.toLowerCase().includes(query.search.toLowerCase())) continue;
        const financial = summary.financialGroups.filter(row => row.country === group.country);
        for (const money of financial.length ? financial : [{ country: group.country, currency: group.currency }]) { await assertCountryAdminReadAccess(request, context); await line([group.country, money.currency, group.customerCount, group.sellerCount, group.productCount, group.promoterCount, money.orderCount || 0, money.orderTotalMinor || 0, money.settledPaymentCount || 0, money.settledPaymentMinor || 0, money.completedRefundCount || 0, money.completedRefundMinor || 0, group.backlogCount, group.openTicketCount, group.overdueTicketCount, group.supportSlaObservedCount, group.supportServiceLevel]); }
      }
    } else {
      await line(source.headers);
      const emit = async record => { await assertCountryAdminReadAccess(request, context); const current = await source.verify(record); await assertCountryAdminReadAccess(request, context); if (current) await line(source.csv(source.map(current))); };
      if (first) await emit(first);
      for await (const record of cursor) await emit(record);
    }
    await assertCountryAdminReadAccess(request, context); if (response.destroyed) throw closed(); response.end();
  } finally { if (cursor) await cursor.close(); }
}

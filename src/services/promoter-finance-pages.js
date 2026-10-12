import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { AttributionTouch, Campaign, CommissionEntry, LedgerAccount, LedgerTransaction, Order, PaymentIntent, Payout, PayoutAccount, PromoterLink } from '../models/index.js';
import { promoterAccess } from './promoter-workspace-access.js';
import { accountBalanceMinor } from './money.js';
import { requestPayout, savePayoutAccount } from './payments.js';
import { sellerOverviewWindow } from './seller-overview.js';
import { sellerPayoutAmount } from './seller-finance-pages.js';
import { cursorScope, cursorSort, decodeCursor, pageResult } from './pagination.js';
import { formatMinorUnits } from './catalogue.js';
import { writeAudit } from './audit.js';

const SIZE = 25;
const MAX_EXPORT_ROWS = 10000;
const PAYOUT_STATUSES = ['requested', 'approved', 'submitting', 'submitted', 'unknown', 'paid', 'failed', 'rejected'];
const COMMISSION_STATUSES = ['pending', 'payable', 'partially_reversed', 'paid', 'reversed'];
const PAYMENT_STATES = ['unpaid', 'pending', 'authorized', 'paid', 'credit_due', 'partially_refunded', 'refunded', 'failed'];
const IN_FLIGHT = ['requested', 'approved', 'submitting', 'submitted', 'unknown'];
const label = value => String(value || '').replaceAll('_', ' ');
const escaped = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const integer = value => { const number = Number(value || 0); if (!Number.isSafeInteger(number)) throw new AppError('Promoter finance data is invalid.', 500, 'PROMOTER_FINANCE_INVALID'); return number; };
const publicAccount = row => ({ publicId: row.publicId, label: row.label, method: row.method, status: row.status, country: row.country, currency: row.currency, createdAt: row.createdAt });
const publicPayout = row => ({ publicId: row.publicId, amountMinor: integer(row.amountMinor), currency: row.currency, status: row.status, requestedAt: row.requestedAt, createdAt: row.createdAt, completedAt: row.completedAt });

export function promoterReportingWindow(period = '30days', timeZone = 'UTC', now = new Date()) {
  return sellerOverviewWindow(period, timeZone, now);
}

function filters(request, pageId) {
  const statuses = pageId === 'promoter-payouts' ? PAYOUT_STATUSES : pageId === 'promoter-commissions' ? COMMISSION_STATUSES
    : pageId === 'promoter-traffic' ? ['valid', 'blocked', 'converted'] : pageId === 'promoter-conversions' ? PAYMENT_STATES : [];
  const input = z.object({ q: z.string().trim().max(100).optional(), search: z.string().trim().max(100).default(''),
    status: z.enum(['all', ...statuses]).default('all'), after: z.string().max(512).default(''),
    period: z.enum(['30days', '7months', 'year']).default('30days') }).parse(request.query || {});
  if (input.after && pageId !== 'promoter-analytics' && !decodeCursor(input.after)) throw new AppError('The report cursor is invalid.', 422, 'PROMOTER_FILTER_INVALID');
  return { ...input, search: input.q ?? input.search, statuses };
}

// An order join verifies the market and exposes only marketplace references and states.
// Buyer identity, contact, full order value and unrelated order lines never enter a DTO.
function commissionPipeline(actor, market) {
  return [
    { $match: { promoterUserId: actor._id, currency: market.currency } },
    { $lookup: { from: Order.collection.name, localField: 'orderId', foreignField: '_id', as: 'order', pipeline: [
      { $project: { publicId: 1, country: 1, 'totals.currency': 1, paymentState: 1, fulfillmentState: 1, refundState: 1, status: 1, createdAt: 1 } },
    ] } },
    { $unwind: '$order' },
    { $match: { 'order.country': market.country, 'order.totals.currency': market.currency, $expr: { $eq: ['$orderPublicId', '$order.publicId'] } } },
    { $lookup: { from: Campaign.collection.name, localField: 'campaignId', foreignField: '_id', as: 'campaign', pipeline: [{ $match: { country: market.country } }, { $project: { publicId: 1, name: 1, country: 1 } }] } },
    { $unwind: '$campaign' },
    { $set: { netMinor: { $max: [0, { $subtract: ['$amountMinor', { $ifNull: ['$reversedAmountMinor', 0] }] }] } } },
    { $set: { paidMinor: { $min: ['$netMinor', { $ifNull: ['$paidAmountMinor', 0] }] }, outstandingMinor: { $max: [0, { $subtract: ['$netMinor', { $ifNull: ['$paidAmountMinor', 0] }] }] } } },
  ];
}

function commissionDto(row) {
  return { publicId: row.publicId, orderPublicId: row.orderPublicId, campaignPublicId: row.campaign?.publicId || '', campaignName: row.campaign?.name || '',
    productPublicId: row.productPublicId, storePublicId: row.storePublicId, amountMinor: integer(row.amountMinor), reversedAmountMinor: integer(row.reversedAmountMinor),
    netMinor: integer(row.netMinor), paidMinor: integer(row.paidMinor), outstandingMinor: integer(row.outstandingMinor), currency: row.currency,
    status: row.status, createdAt: row.createdAt, payableAt: row.payableAt, paidAt: row.paidAt, reversalReason: row.reversalReason || '',
    appeal: { status: row.appeal?.status || 'none', message: row.appeal?.message || '', decision: row.appeal?.decision || '' },
    order: { paymentState: row.order?.paymentState || 'unpaid', fulfillmentState: row.order?.fulfillmentState || 'unfulfilled', refundState: row.order?.refundState || 'none', status: row.order?.status || '' } };
}

async function aggregatePage(Model, pipeline, after, map = row => row) {
  const [result] = await Model.aggregate([...pipeline, { $facet: {
    rows: [{ $match: cursorScope({}, after) }, { $sort: cursorSort() }, { $limit: SIZE + 1 }], total: [{ $count: 'count' }],
  } }]);
  const page = pageResult(result?.rows || [], { limit: SIZE, total: result?.total?.[0]?.count || 0 });
  return { items: page.items.map(map), page: page.page };
}

async function financeState(actor, market) {
  const [payable, accounts, commissionRows] = await Promise.all([
    LedgerAccount.findOne({ code: 'promoter_payable', ownerType: 'promoter', ownerPublicId: String(actor._id), country: market.country, currency: market.currency, active: true }).select('_id type').lean(),
    PayoutAccount.find({ ownerUserId: actor._id, ownerType: 'promoter', country: market.country, currency: market.currency }).select('publicId label method status country currency createdAt').sort(cursorSort()).lean(),
    CommissionEntry.aggregate([...commissionPipeline(actor, market), { $group: { _id: '$status', count: { $sum: 1 }, netMinor: { $sum: '$netMinor' }, paidMinor: { $sum: '$paidMinor' }, reversedMinor: { $sum: { $ifNull: ['$reversedAmountMinor', 0] } },
      estimatedMinor: { $sum: { $cond: [{ $or: [{ $eq: ['$status', 'pending'] }, { $and: [{ $eq: ['$status', 'partially_reversed'] }, { $eq: [{ $ifNull: ['$payableAt', null] }, null] }] }] }, '$netMinor', 0] } } } }]),
  ]);
  const payoutScope = { ownerUserId: actor._id, ownerStoreId: { $exists: false }, payoutAccountId: { $in: accounts.map(row => row._id) }, currency: market.currency };
  const [availableMinor, payoutRows] = await Promise.all([
    payable ? accountBalanceMinor(payable._id, null, payable.type) : 0,
    Payout.aggregate([{ $match: payoutScope }, { $group: { _id: '$status', count: { $sum: 1 }, amountMinor: { $sum: '$amountMinor' } } }]),
  ]);
  const commissionsByStatus = Object.fromEntries(commissionRows.map(row => [row._id, { count: integer(row.count), netMinor: integer(row.netMinor), paidMinor: integer(row.paidMinor), reversedMinor: integer(row.reversedMinor) }]));
  const payoutsByStatus = Object.fromEntries(payoutRows.map(row => [row._id, { count: integer(row.count), amountMinor: integer(row.amountMinor) }]));
  return { payable, payoutScope, payoutAccounts: accounts.map(publicAccount), availableMinor: integer(availableMinor),
    finance: { commissionsByStatus, payoutsByStatus, estimatedMinor: integer(commissionRows.reduce((sum, row) => sum + (row.estimatedMinor || 0), 0)),
      earnedMinor: integer(commissionRows.reduce((sum, row) => sum + row.netMinor, 0)), paidCommissionMinor: integer(commissionRows.reduce((sum, row) => sum + row.paidMinor, 0)),
      reversedMinor: integer(commissionRows.reduce((sum, row) => sum + row.reversedMinor, 0)),
      inFlightPayoutMinor: integer(IN_FLIGHT.reduce((sum, status) => sum + (payoutsByStatus[status]?.amountMinor || 0), 0)),
      paidPayoutMinor: integer(payoutsByStatus.paid?.amountMinor), unknownPayoutCount: integer(payoutsByStatus.unknown?.count) } };
}

function ledgerScope(state, market, search = '') {
  const scope = state.payable ? { country: market.country, currency: market.currency, 'entries.accountId': state.payable._id } : { _id: null };
  if (search) { const pattern = new RegExp(escaped(search), 'i'); scope.$or = [{ publicId: pattern }, { referencePublicId: pattern }, { description: pattern }]; }
  return scope;
}
function ledgerDto(row, state) {
  const deltaMinor = (row.entries || []).filter(entry => String(entry.accountId) === String(state.payable?._id)).reduce((sum, entry) => sum + integer(entry.creditMinor) - integer(entry.debitMinor), 0);
  return { publicId: row.publicId, createdAt: row.createdAt, referenceType: row.referenceType, referencePublicId: row.referencePublicId, description: row.description, currency: row.currency, deltaMinor: integer(deltaMinor) };
}

function commissionFilters(query) {
  const scope = {};
  if (query.status !== 'all') scope.status = query.status;
  if (query.search) { const pattern = new RegExp(escaped(query.search), 'i'); scope.$or = ['publicId', 'orderPublicId', 'productPublicId', 'storePublicId', 'campaign.name'].map(field => ({ [field]: pattern })); }
  return scope;
}
function conversionPipeline(actor, market, window, query) {
  const pipeline = [...commissionPipeline(actor, market), { $match: { 'order.createdAt': { $gte: window.start, $lt: window.end } } },
    { $group: { _id: '$orderId', publicId: { $first: '$orderPublicId' }, createdAt: { $first: '$order.createdAt' }, paymentState: { $first: '$order.paymentState' },
      fulfillmentState: { $first: '$order.fulfillmentState' }, refundState: { $first: '$order.refundState' }, currency: { $first: '$currency' }, commissionMinor: { $sum: '$netMinor' }, commissionCount: { $sum: 1 } } },
    { $lookup: { from: PaymentIntent.collection.name, localField: '_id', foreignField: 'orderId', as: 'payment', let: { orderPublicId: '$publicId' }, pipeline: [
      { $match: { country: market.country, currency: market.currency, purpose: { $in: ['order_payment', 'business_invoice'] }, status: { $in: ['succeeded', 'partially_refunded', 'refunded'] }, paidAt: { $type: 'date' }, $expr: { $eq: ['$orderPublicId', '$$orderPublicId'] } } },
      { $sort: { paidAt: 1, _id: 1 } }, { $limit: 1 }, { $project: { _id: 0, paidAt: 1 } },
    ] } },
    { $set: { paymentVerified: { $gt: [{ $size: '$payment' }, 0] }, paymentVerifiedAt: { $first: '$payment.paidAt' } } },
    { $unset: 'payment' }];
  const match = {};
  if (query.status !== 'all') match.paymentState = query.status;
  if (query.search) match.publicId = new RegExp(escaped(query.search), 'i');
  return [...pipeline, { $match: match }];
}
function touchPipeline(actor, market, window, query) {
  const scope = { promoterUserId: actor._id, country: market.country, landedAt: { $gte: window.start, $lt: window.end } };
  if (query.status !== 'all') scope.status = query.status;
  const pipeline = [{ $match: scope },
    { $lookup: { from: PromoterLink.collection.name, localField: 'linkId', foreignField: '_id', as: 'link', let: { campaignId: '$campaignId' }, pipeline: [{ $match: { promoterUserId: actor._id, $expr: { $eq: ['$campaignId', '$$campaignId'] } } }, { $project: { publicId: 1, channel: 1 } }] } },
    { $unwind: '$link' },
    { $lookup: { from: Campaign.collection.name, localField: 'campaignId', foreignField: '_id', as: 'campaign', pipeline: [{ $match: { country: market.country } }, { $project: { publicId: 1, name: 1 } }] } },
    { $unwind: '$campaign' }];
  if (query.search) { const pattern = new RegExp(escaped(query.search), 'i'); pipeline.push({ $match: { $or: [{ publicId: pattern }, { 'link.publicId': pattern }, { 'link.channel': pattern }, { 'campaign.name': pattern }] } }); }
  return pipeline;
}
function touchDto(row) { return { publicId: row.publicId, linkPublicId: row.link?.publicId || '', channel: row.link?.channel || 'direct', campaignPublicId: row.campaign?.publicId || '', campaignName: row.campaign?.name || '', country: row.country, status: row.status, landedAt: row.landedAt, createdAt: row.createdAt, blockReason: row.blockReason || '' }; }

async function performance(actor, market, window) {
  const dateGroup = date => ({ $dateToString: { date, format: window.monthly ? '%Y-%m' : '%Y-%m-%d', timezone: market.timeZone } });
  const unfiltered = { status: 'all', search: '' };
  const [touchRows, commissionRows, orderRows] = await Promise.all([
    AttributionTouch.aggregate([...touchPipeline(actor, market, window, unfiltered), { $facet: {
      totals: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
      channels: [{ $group: { _id: { $ifNull: ['$link.channel', 'direct'] }, visits: { $sum: 1 }, eligibleVisits: { $sum: { $cond: [{ $ne: ['$status', 'blocked'] }, 1, 0] } } } }, { $sort: { visits: -1, _id: 1 } }, { $limit: MAX_EXPORT_ROWS + 1 }],
      dates: [{ $group: { _id: dateGroup('$landedAt'), visits: { $sum: { $cond: [{ $ne: ['$status', 'blocked'] }, 1, 0] } } } }],
    } }]),
    CommissionEntry.aggregate([...commissionPipeline(actor, market), { $match: { createdAt: { $gte: window.start, $lt: window.end } } },
      { $lookup: { from: AttributionTouch.collection.name, localField: 'touchId', foreignField: '_id', as: 'touch', pipeline: [{ $match: { promoterUserId: actor._id, country: market.country } }, { $project: { linkId: 1 } }] } },
      { $set: { touch: { $first: '$touch' } } },
      { $lookup: { from: PromoterLink.collection.name, localField: 'touch.linkId', foreignField: '_id', as: 'link', pipeline: [{ $match: { promoterUserId: actor._id } }, { $project: { channel: 1, publicId: 1 } }] } },
      { $set: { link: { $first: '$link' } } },
      { $facet: {
        totals: [{ $group: { _id: null, netMinor: { $sum: '$netMinor' }, reversedMinor: { $sum: { $ifNull: ['$reversedAmountMinor', 0] } } } }],
        channels: [{ $group: { _id: { $ifNull: ['$link.channel', 'direct'] }, commissionMinor: { $sum: '$netMinor' }, orderIds: { $addToSet: '$orderId' } } }, { $project: { commissionMinor: 1, conversions: { $size: '$orderIds' } } }, { $sort: { commissionMinor: -1, _id: 1 } }, { $limit: MAX_EXPORT_ROWS + 1 }],
        dates: [{ $group: { _id: dateGroup('$createdAt'), commissionMinor: { $sum: '$netMinor' } } }],
      } },
    ]),
    CommissionEntry.aggregate([...conversionPipeline(actor, market, window, unfiltered), { $group: { _id: '$paymentState', count: { $sum: 1 }, verifiedPaidCount: { $sum: { $cond: ['$paymentVerified', 1, 0] } } } }]),
  ]);
  const touches = touchRows[0] || {}, commissions = commissionRows[0] || {};
  if ((touches.channels || []).length > MAX_EXPORT_ROWS || (commissions.channels || []).length > MAX_EXPORT_ROWS) throw new AppError('Use a shorter period for this channel report.', 422, 'PROMOTER_EXPORT_TOO_LARGE');
  const statuses = Object.fromEntries((touches.totals || []).map(row => [row._id, integer(row.count)]));
  const payments = Object.fromEntries(orderRows.map(row => [row._id || 'unpaid', integer(row.count)]));
  const channelMap = new Map((touches.channels || []).map(row => [row._id || 'direct', { key: row._id || 'direct', visits: integer(row.visits), eligibleVisits: integer(row.eligibleVisits), conversions: 0, commissionMinor: 0 }]));
  for (const row of commissions.channels || []) { const key = row._id || 'direct'; const value = channelMap.get(key) || { key, visits: 0, eligibleVisits: 0, conversions: 0, commissionMinor: 0 }; value.conversions = integer(row.conversions); value.commissionMinor = integer(row.commissionMinor); channelMap.set(key, value); }
  const visitsByDate = new Map((touches.dates || []).map(row => [row._id, integer(row.visits)]));
  const moneyByDate = new Map((commissions.dates || []).map(row => [row._id, integer(row.commissionMinor)]));
  const trend = window.buckets.map(bucket => ({ key: bucket.key, label: bucket.label,
    visits: integer(bucket.keys.reduce((sum, key) => sum + (visitsByDate.get(key) || 0), 0)),
    commissionMinor: integer(bucket.keys.reduce((sum, key) => sum + (moneyByDate.get(key) || 0), 0)) }));
  return { statuses, payments, visits: integer(Object.values(statuses).reduce((sum, count) => sum + count, 0)), eligibleVisits: integer((statuses.valid || 0) + (statuses.converted || 0)),
    blockedVisits: integer(statuses.blocked), conversions: integer(Object.values(payments).reduce((sum, count) => sum + count, 0)),
    paidConversions: integer(orderRows.reduce((sum, row) => sum + integer(row.verifiedPaidCount), 0)),
    commissionMinor: integer(commissions.totals?.[0]?.netMinor), reversedMinor: integer(commissions.totals?.[0]?.reversedMinor), byChannel: [...channelMap.values()], trend };
}

export async function loadPromoterFinancePage(request, pageId, { now = new Date() } = {}) {
  const { actor, market } = await promoterAccess(request);
  const query = filters(request, pageId), window = promoterReportingWindow(query.period, market.timeZone, now);
  const state = await financeState(actor, market);
  const money = value => formatMinorUnits(integer(value), market.currency, actor.locale || 'en');
  const date = value => value ? new Intl.DateTimeFormat(actor.locale || 'en', { timeZone: market.timeZone, dateStyle: 'medium' }).format(new Date(value)) : '—';
  let result = { items: [], page: { count: 0, total: 0, hasMore: false, next: '' } }, columns, rows;
  if (pageId === 'promoter-wallet') {
    const scope = ledgerScope(state, market, query.search);
    const [documents, total] = await Promise.all([LedgerTransaction.find(cursorScope(scope, query.after)).sort(cursorSort()).limit(SIZE + 1).lean(), LedgerTransaction.countDocuments(scope)]);
    const paged = pageResult(documents, { limit: SIZE, total }); result = { items: paged.items.map(row => ledgerDto(row, state)), page: paged.page };
    columns = ['Transaction', 'Recorded', 'Reference', 'Balance change', 'Currency']; rows = result.items.map(row => ({ id: row.publicId, cells: [row.publicId, date(row.createdAt), row.referencePublicId, money(row.deltaMinor), row.currency] }));
  } else if (pageId === 'promoter-payouts') {
    const scope = { ...state.payoutScope }; if (query.status !== 'all') scope.status = query.status; if (query.search) scope.publicId = new RegExp(escaped(query.search), 'i');
    const [documents, total] = await Promise.all([Payout.find(cursorScope(scope, query.after)).select('publicId amountMinor currency status requestedAt createdAt completedAt').sort(cursorSort()).limit(SIZE + 1).lean(), Payout.countDocuments(scope)]);
    const paged = pageResult(documents, { limit: SIZE, total }); result = { items: paged.items.map(publicPayout), page: paged.page };
    columns = ['Payout', 'Requested', 'Amount', 'Currency', 'Status']; rows = result.items.map(row => ({ id: row.publicId, cells: [row.publicId, date(row.requestedAt || row.createdAt), money(row.amountMinor), row.currency, label(row.status)] }));
  } else if (pageId === 'promoter-commissions') {
    result = await aggregatePage(CommissionEntry, [...commissionPipeline(actor, market), { $match: commissionFilters(query) }], query.after, commissionDto);
    columns = ['Commission', 'Order', 'Campaign', 'Net commission', 'Payment', 'Commission status']; rows = result.items.map(row => ({ id: row.publicId, cells: [row.publicId, row.orderPublicId, row.campaignName || row.campaignPublicId, money(row.netMinor), label(row.order.paymentState), label(row.status)] }));
  } else if (pageId === 'promoter-conversions') {
    result = await aggregatePage(CommissionEntry, conversionPipeline(actor, market, window, query), query.after, row => ({ publicId: row.publicId, createdAt: row.createdAt, paymentState: row.paymentState || 'unpaid', paymentVerified: row.paymentVerified === true, paymentVerifiedAt: row.paymentVerifiedAt || null, fulfillmentState: row.fulfillmentState || 'unfulfilled', refundState: row.refundState || 'none', currency: row.currency, commissionMinor: integer(row.commissionMinor), commissionCount: integer(row.commissionCount) }));
    columns = ['Order', 'Created', 'Payment', 'Verified payment', 'Fulfillment', 'Refund', 'Net commission']; rows = result.items.map(row => ({ id: row.publicId, cells: [row.publicId, date(row.createdAt), label(row.paymentState), row.paymentVerified ? date(row.paymentVerifiedAt) : 'Not recorded', label(row.fulfillmentState), label(row.refundState), money(row.commissionMinor)] }));
  } else if (pageId === 'promoter-traffic') {
    result = await aggregatePage(AttributionTouch, touchPipeline(actor, market, window, query), query.after, touchDto);
    columns = ['Visit', 'Recorded', 'Link', 'Channel', 'Campaign', 'Status']; rows = result.items.map(row => ({ id: row.publicId, cells: [row.publicId, date(row.landedAt), row.linkPublicId, row.channel, row.campaignName, label(row.status)] }));
  }
  const performancePage = ['promoter-traffic', 'promoter-conversions', 'promoter-analytics'].includes(pageId);
  const analytics = performancePage ? await performance(actor, market, window) : null;
  if (pageId === 'promoter-analytics') {
    const channels = analytics.byChannel.filter(row => !query.search || row.key.toLowerCase().includes(query.search.toLowerCase()));
    const decoded = query.after ? Buffer.from(query.after, 'base64url').toString() : '0', offset = Number(decoded);
    if ((query.after && (!/^[A-Za-z0-9_-]+$/.test(query.after) || Buffer.from(decoded).toString('base64url') !== query.after)) || !/^(0|[1-9]\d*)$/.test(decoded) || !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_EXPORT_ROWS) throw new AppError('Analytics page is unavailable.', 422, 'PROMOTER_FILTER_INVALID');
    const items = channels.slice(offset, offset + SIZE), hasMore = offset + SIZE < channels.length;
    result = { items, page: { count: items.length, total: channels.length, hasMore, next: hasMore ? Buffer.from(String(offset + SIZE)).toString('base64url') : '' } };
    columns = ['Channel', 'Recorded visits', 'Eligible visits', 'Attributed orders', 'Net commission']; rows = items.map(row => ({ id: row.key, cells: [row.key, String(row.visits), String(row.eligibleVisits), String(row.conversions), money(row.commissionMinor)] }));
  }
  const base = '/promoter/' + pageId.replace('promoter-', '');
  const metrics = performancePage ? [
    { label: 'Eligible visits', value: analytics.eligibleVisits, detail: 'Recorded visits after blocking rules in this period' },
    { label: 'Attributed orders', value: analytics.conversions, detail: 'Qualifying checkouts; payment status is shown separately' },
    { label: 'Verified paid orders', value: analytics.paidConversions, detail: 'Attributed orders with matching paid payment records, including refunds' },
    { label: 'Net commission', value: money(analytics.commissionMinor), detail: 'Commission estimates and earnings after reversals in this period' },
  ] : [
    { label: 'Available balance', value: money(state.availableMinor), detail: 'Promoter payable ledger after payout reservations' },
    { label: 'Estimated commission', value: money(state.finance.estimatedMinor), detail: 'Pending commissions are not available for withdrawal' },
    { label: 'Payouts in progress', value: money(state.finance.inFlightPayoutMinor), detail: 'Requested, approved, submitting, submitted and unknown payouts' },
    { label: pageId === 'promoter-commissions' ? 'Reversed commission' : 'Completed payouts', value: money(pageId === 'promoter-commissions' ? state.finance.reversedMinor : state.finance.paidPayoutMinor), detail: 'Recorded amounts in your programme currency' },
  ];
  const nextQuery = new URLSearchParams({ search: query.search, status: query.status, period: query.period, after: result.page.next });
  return { kind: 'finance', pageId, market, currency: market.currency, timeZone: market.timeZone, availableMinor: state.availableMinor, finance: state.finance,
    payoutAccounts: state.payoutAccounts, payouts: pageId === 'promoter-payouts' ? result.items : [], commissions: pageId === 'promoter-commissions' ? result.items : [],
    activity: pageId === 'promoter-wallet' ? result.items : [], conversions: pageId === 'promoter-conversions' ? result.items : [], traffic: pageId === 'promoter-traffic' ? result.items : [],
    idempotencyKey: pageId === 'promoter-payouts' ? randomUUID() : '', period: query.period, range: { start: window.start, end: window.end }, analytics,
    ...(performancePage ? { trend: analytics.trend.map(row => ({ ...row, value: pageId === 'promoter-traffic' ? row.visits : row.commissionMinor,
      display: pageId === 'promoter-traffic' ? String(row.visits) : money(row.commissionMinor) })),
      trendLabel: pageId === 'promoter-traffic' ? 'Eligible visits' : 'Net commission', trendDescription: 'Recorded results in the ' + market.timeZone + ' calendar.',
      periodOptions: [{ value: '30days', label: 'Last 30 days' }, { value: '7months', label: 'Last 7 months' }, { value: 'year', label: 'This year' }] } : {}), metrics, columns, rows,
    insights: [{ text: state.finance.unknownPayoutCount ? `${state.finance.unknownPayoutCount} payouts await reconciliation.` : 'Available funds use your programme ledger, after reservations and reversals.', href: '/promoter/payouts', label: 'Review payouts' },
      { text: 'Attributed checkouts and verified payments are tracked separately. Buyer contact details remain private.', href: '/promoter/conversions', label: 'Review attributed orders' }],
    health: { value: null, label: 'Programme finance', rows: [{ label: 'Country', value: market.country }, { label: 'Currency', value: market.currency }, { label: 'Unknown payouts', value: String(state.finance.unknownPayoutCount) }] },
    workflow: [{ title: 'Review recorded earnings', text: 'Download your scoped commission or ledger records.', href: base + '/export.csv', label: 'Download report' },
      { title: 'Request earned funds', text: 'Use a verified destination and an amount within your available ledger balance.', href: '/promoter/payouts#promoter-payout-request', label: 'Manage payouts' }],
    create: { label: pageId === 'promoter-payouts' ? 'Add payout destination' : 'Download report', href: pageId === 'promoter-payouts' ? '#promoter-payout-destination' : base + '/export.csv' },
    exportHref: base + '/export.csv?' + new URLSearchParams({ search: query.search, status: query.status, period: query.period }),
    filters: { search: query.search, status: query.status, after: query.after, period: query.period, params: { period: query.period }, statuses: query.statuses.length ? [{ value: 'all', label: 'All statuses' }, ...query.statuses.map(value => ({ value, label: label(value) }))] : [] },
    pagination: { ...result.page, nextHref: result.page.hasMore ? base + '?' + nextQuery : '' }, page: result.page };
}

export async function createPromoterPayoutDestination(request, body) {
  await promoterAccess(request);
  const input = z.object({ method: z.enum(['mobile_money', 'bank']), label: z.string().trim().min(2).max(100), beneficiary_name: z.string().trim().min(2).max(120),
    network: z.string().trim().max(40).default(''), phone: z.string().trim().max(32).default(''), account_bank: z.string().trim().max(40).default(''), account_number: z.string().trim().max(80).default('') }).parse(body);
  if (input.method === 'bank' && (input.account_bank.length < 2 || input.account_number.length < 4)) throw new AppError('Bank and account number are required.', 422, 'PAYOUT_DESTINATION_INVALID');
  if (input.method === 'mobile_money' && (input.network.length < 2 || input.phone.length < 7)) throw new AppError('Network and phone are required.', 422, 'PAYOUT_DESTINATION_INVALID');
  const destination = input.method === 'bank' ? { beneficiary_name: input.beneficiary_name, account_bank: input.account_bank, account_number: input.account_number }
    : { beneficiary_name: input.beneficiary_name, network: input.network, phone: input.phone };
  const personalRequest = Object.assign(Object.create(request), { store: undefined });
  return publicAccount(await savePayoutAccount(personalRequest, { method: input.method, label: input.label, destination }));
}
export async function requestPromoterPayout(request, body) {
  const { market } = await promoterAccess(request);
  const input = z.object({ payoutAccountId: z.string().trim().min(4).max(100), amount: z.string().trim().min(1).max(30), idempotencyKey: z.string().trim().min(8).max(120) }).parse(body);
  const personalRequest = Object.assign(Object.create(request), { store: undefined });
  return publicPayout(await requestPayout(personalRequest, { payoutAccountId: input.payoutAccountId, amountMinor: sellerPayoutAmount(input.amount, market.currency), idempotencyKey: input.idempotencyKey }));
}
export async function appealPromoterCommission(request, publicId, body) {
  const input = z.object({ message: z.string().trim().min(10).max(1200) }).parse(body);
  const session = await mongoose.startSession(); let result;
  try { await session.withTransaction(async () => {
    const { actor, market } = await promoterAccess(request, { session, write: true });
    const row = await CommissionEntry.findOne({ publicId, promoterUserId: actor._id, currency: market.currency, status: { $in: ['reversed', 'partially_reversed'] } }).session(session);
    const order = row ? await Order.findOne({ _id: row.orderId, publicId: row.orderPublicId, country: market.country, 'totals.currency': market.currency }).select('_id').session(session).lean() : null;
    const campaign = row ? await Campaign.findOne({ _id: row.campaignId, country: market.country }).select('_id').session(session).lean() : null;
    if (!row || !order || !campaign) throw new AppError('Reversed commission not found.', 404, 'COMMISSION_NOT_FOUND');
    if (row.appeal?.status === 'pending') throw new AppError('This appeal is already pending.', 409, 'COMMISSION_APPEAL_PENDING');
    row.appeal = { status: 'pending', message: input.message, decision: '', submittedAt: new Date() }; await row.save({ session });
    await writeAudit(request, 'promoter.commission_appealed', { targetType: 'commission', targetPublicId: row.publicId, country: market.country, session });
    result = { publicId: row.publicId, appeal: { status: 'pending', message: input.message } };
  }); } finally { await session.endSession(); }
  return result;
}

const csvCell = value => { let text = String(value ?? ''); if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text)) text = "'" + text; return '"' + text.replaceAll('"', '""') + '"'; };
async function writeCsv(response, values) {
  if (response.destroyed) return false;
  if (response.write(values.map(csvCell).join(',') + '\r\n')) return true;
  return new Promise((resolve, reject) => {
    const cleanup = () => { response.off('drain', drain); response.off('close', close); response.off('error', error); };
    const drain = () => { cleanup(); resolve(true); }, close = () => { cleanup(); resolve(false); }, error = err => { cleanup(); reject(err); };
    response.once('drain', drain); response.once('close', close); response.once('error', error);
  });
}

export async function streamPromoterFinanceCsv(request, response, pageId) {
  const { actor, market } = await promoterAccess(request), query = filters(request, pageId), window = promoterReportingWindow(query.period, market.timeZone);
  const state = await financeState(actor, market);
  let cursor, headers, values, count;
  if (pageId === 'promoter-analytics') {
    const report = await performance(actor, market, window);
    response.type('text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="classic-mart-promoter-analytics.csv"');
    await writeCsv(response, ['Country', 'Currency', 'Time zone', 'Period start', 'Period end']);
    await writeCsv(response, [market.country, market.currency, market.timeZone, window.start.toISOString(), window.end.toISOString()]);
    await writeCsv(response, ['Channel', 'Recorded visits', 'Eligible visits', 'Attributed orders', 'Net commission minor']);
    for (const row of report.byChannel.filter(row => !query.search || row.key.toLowerCase().includes(query.search.toLowerCase()))) if (!await writeCsv(response, [row.key, row.visits, row.eligibleVisits, row.conversions, row.commissionMinor])) return;
    await writeCsv(response, ['Period', 'Eligible visits', 'Net commission minor']);
    for (const row of report.trend) if (!await writeCsv(response, [row.key, row.visits, row.commissionMinor])) return;
    return response.end();
  }
  if (pageId === 'promoter-wallet') {
    const scope = ledgerScope(state, market, query.search); count = await LedgerTransaction.countDocuments(scope); cursor = LedgerTransaction.find(scope).sort({ createdAt: 1, _id: 1 }).limit(MAX_EXPORT_ROWS).lean().cursor({ batchSize: 100 });
    headers = ['Transaction', 'Recorded', 'Reference', 'Description', 'Currency', 'Balance change minor']; values = row => { const dto = ledgerDto(row, state); return [dto.publicId, dto.createdAt?.toISOString(), dto.referencePublicId, dto.description, dto.currency, dto.deltaMinor]; };
  } else if (pageId === 'promoter-payouts') {
    const scope = { ...state.payoutScope }; if (query.status !== 'all') scope.status = query.status; if (query.search) scope.publicId = new RegExp(escaped(query.search), 'i');
    count = await Payout.countDocuments(scope); cursor = Payout.find(scope).select('publicId amountMinor currency status requestedAt').sort({ createdAt: 1, _id: 1 }).limit(MAX_EXPORT_ROWS).lean().cursor({ batchSize: 100 });
    headers = ['Payout', 'Requested', 'Amount minor', 'Currency', 'Status']; values = row => [row.publicId, row.requestedAt?.toISOString(), row.amountMinor, row.currency, row.status];
  } else {
    const Model = pageId === 'promoter-traffic' ? AttributionTouch : CommissionEntry;
    const pipeline = pageId === 'promoter-traffic' ? touchPipeline(actor, market, window, query) : pageId === 'promoter-conversions' ? conversionPipeline(actor, market, window, query) : [...commissionPipeline(actor, market), { $match: commissionFilters(query) }];
    const total = await Model.aggregate([...pipeline, { $count: 'count' }]); count = total[0]?.count || 0;
    cursor = Model.aggregate([...pipeline, { $sort: { createdAt: 1, _id: 1 } }, { $limit: MAX_EXPORT_ROWS }]).cursor({ batchSize: 100 });
    if (pageId === 'promoter-traffic') { headers = ['Visit', 'Recorded', 'Link', 'Channel', 'Campaign', 'Status']; values = row => { const dto = touchDto(row); return [dto.publicId, dto.landedAt?.toISOString(), dto.linkPublicId, dto.channel, dto.campaignName, dto.status]; }; }
    else if (pageId === 'promoter-conversions') { headers = ['Order', 'Created', 'Payment', 'Payment verified', 'Verified payment date', 'Fulfillment', 'Refund', 'Currency', 'Net commission minor']; values = row => [row.publicId, row.createdAt?.toISOString(), row.paymentState, row.paymentVerified, row.paymentVerifiedAt?.toISOString(), row.fulfillmentState, row.refundState, row.currency, row.commissionMinor]; }
    else { headers = ['Commission', 'Order', 'Campaign', 'Product', 'Currency', 'Status', 'Gross minor', 'Reversed minor', 'Net minor', 'Paid minor', 'Appeal status']; values = row => { const dto = commissionDto(row); return [dto.publicId, dto.orderPublicId, dto.campaignName, dto.productPublicId, dto.currency, dto.status, dto.amountMinor, dto.reversedAmountMinor, dto.netMinor, dto.paidMinor, dto.appeal.status]; }; }
  }
  try {
    if (count > MAX_EXPORT_ROWS) throw new AppError('This report exceeds 10,000 records. Use a narrower search, status or reporting period.', 422, 'PROMOTER_EXPORT_TOO_LARGE');
    response.type('text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="classic-mart-' + pageId + '.csv"');
    if (!await writeCsv(response, headers)) return;
    for await (const row of cursor) if (!await writeCsv(response, values(row))) return;
    response.end();
  } finally { await cursor?.close(); }
}

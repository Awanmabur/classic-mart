import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { AuditLog, Chargeback, LedgerAccount, LedgerTransaction, Order, PaymentIntent, Payout, PayoutAccount, ProviderEvent, ReconciliationRun, Refund, Shipment } from '../models/index.js';
import { assertFinanceExportAccess, financeAccess } from './finance-workspace-access.js';
import { sellerOverviewWindow } from './seller-overview.js';
import { cursorScope, cursorSort, decodeCursor, pageResult } from './pagination.js';
import { formatMinorUnits } from './catalogue.js';
import { writeAudit } from './audit.js';

const SIZE = 25;
const REPORTS = ['summary', 'payments', 'refunds', 'payouts', 'ledger', 'reconciliation'];
const RESULTS = ['all', 'success', 'denied', 'failure'];
const VERIFIED_PAYMENT_STATES = ['succeeded', 'partially_refunded', 'refunded', 'reversed'];
const int = value => { const number = Number(value || 0); if (!Number.isSafeInteger(number)) throw new AppError('Financial report amounts need review.', 503, 'FINANCE_REPORT_INVALID'); return number; };
const label = value => String(value || '').replaceAll('_', ' ');
const regex = value => new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const money = (value, currency, locale) => formatMinorUnits(int(value), currency, locale || 'en');

export function financeReportingWindow(period = '30days', timeZone = 'UTC', now = new Date()) {
  return sellerOverviewWindow(period, timeZone, now);
}

function reportFilters(request, actor, pageId) {
  const preferred = actor.preferences?.financeReportingPeriod || '30days';
  const input = z.object({ country: z.string().trim().max(2).default(''), period: z.enum(['30days', '7months', 'year']).default(['30days', '7months', 'year'].includes(preferred) ? preferred : '30days'),
    report: z.enum(REPORTS).default('summary'), search: z.string().trim().max(100).default(''), q: z.string().trim().max(100).optional(),
    status: z.enum(RESULTS).default('all'), after: z.string().max(512).default('') }).parse(request.query || {});
  if (input.after && !decodeCursor(input.after)) throw new AppError('The financial report cursor is invalid.', 422, 'FINANCE_FILTER_INVALID');
  if (pageId !== 'finance-audit' && input.status !== 'all') throw new AppError('This report does not support an audit result filter.', 422, 'FINANCE_FILTER_INVALID');
  return { ...input, search: input.q ?? input.search };
}

function orderJoin() {
  return [{ $lookup: { from: Order.collection.name, localField: 'orderId', foreignField: '_id', as: 'order', pipeline: [{ $project: { publicId: 1, country: 1, 'totals.currency': 1 } }] } },
    { $unwind: '$order' }, { $match: { $expr: { $and: [{ $eq: ['$country', '$order.country'] }, { $eq: ['$currency', '$order.totals.currency'] }, { $eq: ['$orderPublicId', '$order.publicId'] }] } } }];
}

function paymentPipeline(scope, window, { captured = false, search = '', where = {} } = {}) {
  const match = { ...scope, ...(captured ? { status: { $in: VERIFIED_PAYMENT_STATES }, paidAt: { $gte: window.start, $lt: window.end } } : { createdAt: { $gte: window.start, $lt: window.end } }), ...where };
  if (search) { const pattern = regex(search); match.$or = [{ publicId: pattern }, { orderPublicId: pattern }, { country: pattern }, { currency: pattern }]; }
  return [{ $match: match }, ...orderJoin()];
}

function refundPipeline(scope, window, { completed = false, search = '', where = {} } = {}) {
  const match = { ...(completed ? { status: 'completed', completedAt: { $gte: window.start, $lt: window.end } } : { createdAt: { $gte: window.start, $lt: window.end } }), ...where };
  if (search) match.publicId = regex(search);
  return [{ $match: match }, { $lookup: { from: PaymentIntent.collection.name, localField: 'paymentIntentId', foreignField: '_id', as: 'payment', pipeline: [{ $match: { ...scope, status: { $in: VERIFIED_PAYMENT_STATES }, paidAt: { $type: 'date' } } }, { $project: { orderId: 1, orderPublicId: 1, country: 1, currency: 1 } }] } },
    { $unwind: '$payment' }, { $match: { $expr: { $and: [{ $eq: ['$orderId', '$payment.orderId'] }, { $eq: ['$currency', '$payment.currency'] }] } } },
    { $set: { country: '$payment.country', orderPublicId: '$payment.orderPublicId' } }, ...orderJoin()];
}

function payoutPipeline(scope, window, { paid = false, search = '', where = {} } = {}) {
  const match = { ...(paid ? { status: 'paid', completedAt: { $gte: window.start, $lt: window.end } } : { createdAt: { $gte: window.start, $lt: window.end } }), ...where };
  if (search) match.$or = [{ publicId: regex(search) }, { ownerStorePublicId: regex(search) }];
  return [{ $match: match }, { $lookup: { from: PayoutAccount.collection.name, localField: 'payoutAccountId', foreignField: '_id', as: 'account', pipeline: [{ $match: scope }, { $project: { publicId: 1, country: 1, currency: 1, ownerUserId: 1, ownerStoreId: 1, ownerStorePublicId: 1, ownerType: 1 } }] } },
    { $unwind: '$account' }, { $match: { $expr: { $and: [{ $eq: ['$currency', '$account.currency'] }, { $eq: ['$ownerUserId', '$account.ownerUserId'] },
      { $eq: [{ $ifNull: ['$ownerStoreId', null] }, { $ifNull: ['$account.ownerStoreId', null] }] }, { $eq: [{ $ifNull: ['$ownerStorePublicId', ''] }, { $ifNull: ['$account.ownerStorePublicId', ''] }] }] } } }, { $set: { country: '$account.country' } }];
}

function ledgerPipeline(scope, window, search = '') {
  const match = { ...scope, postedAt: { $gte: window.start, $lt: window.end } };
  if (search) match.$or = [{ publicId: regex(search) }, { referencePublicId: regex(search) }, { description: regex(search) }];
  return [{ $match: match }, { $lookup: { from: LedgerAccount.collection.name, localField: 'entries.accountId', foreignField: '_id', as: 'accounts', pipeline: [{ $match: scope }, { $project: { publicId: 1, country: 1, currency: 1 } }] } },
    { $set: { debitMinor: { $sum: '$entries.debitMinor' }, creditMinor: { $sum: '$entries.creditMinor' }, validEntries: { $filter: { input: '$entries', as: 'entry', cond: { $and: [
      { $gt: [{ $size: { $filter: { input: '$accounts', as: 'account', cond: { $and: [{ $eq: ['$$account._id', '$$entry.accountId'] }, { $eq: ['$$account.publicId', '$$entry.accountPublicId'] }, { $eq: ['$$account.country', '$country'] }, { $eq: ['$$account.currency', '$currency'] }] } } } }, 0] },
      { $gte: ['$$entry.debitMinor', 0] }, { $gte: ['$$entry.creditMinor', 0] }, { $ne: [{ $eq: ['$$entry.debitMinor', 0] }, { $eq: ['$$entry.creditMinor', 0] }] }] } } } } },
    { $match: { $expr: { $and: [{ $gte: [{ $size: '$entries' }, 2] }, { $eq: [{ $size: '$validEntries' }, { $size: '$entries' }] }, { $eq: ['$debitMinor', '$creditMinor'] }, { $gt: ['$debitMinor', 0] }] } } }];
}

function reconciliationPipeline(scope, window, search = '') {
  const match = { ...scope, createdAt: { $gte: window.start, $lt: window.end } };
  if (search) match.$or = [{ publicId: regex(search) }, { provider: regex(search) }, { country: regex(search) }];
  return [{ $match: match }];
}

async function reportQueries(tasks, session) {
  if (!session) return Promise.all(tasks.map(task => task()));
  const results = [];
  for (const task of tasks) results.push(await task());
  return results;
}

async function exceptionCounts(scope, now, session = null) {
  const allTime = { start: new Date(0), end: new Date(now.getTime() + 1) };
  const [provider, refunds, payouts, chargebacks, reconciliations, cod, failedPayments] = await reportQueries([
    () => ProviderEvent.aggregate([{ $match: { ...scope, status: { $in: ['failed', 'dead'] }, verifiedAt: { $type: 'date' } } }, { $group: { _id: '$country', count: { $sum: 1 } } }]).session(session),
    () => Refund.aggregate([...refundPipeline(scope, allTime, { where: { status: 'processing', updatedAt: { $lt: new Date(now.getTime() - 2 * 60 * 60 * 1000) } } }), { $group: { _id: { country: '$country', currency: '$currency' }, count: { $sum: 1 } } }]).session(session),
    () => Payout.aggregate([...payoutPipeline(scope, allTime, { where: { status: 'unknown' } }), { $group: { _id: { country: '$country', currency: '$currency' }, count: { $sum: 1 } } }]).session(session),
    () => Chargeback.aggregate([{ $match: { ...scope, status: { $in: ['open', 'reviewing'] } } }, { $lookup: { from: PaymentIntent.collection.name, localField: 'paymentIntentId', foreignField: '_id', as: 'payment', pipeline: [{ $match: scope }, { $project: { publicId: 1, country: 1, currency: 1, orderId: 1, orderPublicId: 1 } }] } }, { $unwind: '$payment' },
      { $match: { $expr: { $and: [{ $eq: ['$paymentIntentPublicId', '$payment.publicId'] }, { $eq: ['$country', '$payment.country'] }, { $eq: ['$currency', '$payment.currency'] }, { $eq: ['$orderId', '$payment.orderId'] }, { $eq: ['$orderPublicId', '$payment.orderPublicId'] }] } } }, ...orderJoin(), { $group: { _id: { country: '$country', currency: '$currency' }, count: { $sum: 1 } } }]).session(session),
    () => ReconciliationRun.aggregate([{ $match: { ...scope, $or: [{ status: 'failed' }, { failed: { $gt: 0 } }] } }, { $group: { _id: { country: '$country', currency: { $ifNull: ['$currency', ''] } }, count: { $sum: 1 } } }]).session(session),
    () => Shipment.aggregate([{ $match: { ...scope, kind: 'outbound', status: 'delivered', 'cod.required': true, 'cod.reconciledAt': null } }, { $set: { currency: '$cod.currency' } }, ...orderJoin(), { $group: { _id: { country: '$country', currency: '$currency' }, count: { $sum: 1 } } }]).session(session),
    () => PaymentIntent.aggregate([...paymentPipeline(scope, allTime, { where: { status: 'failed' } }), { $group: { _id: { country: '$country', currency: '$currency' }, count: { $sum: 1 } } }]).session(session),
  ], session);
  const total = rows => int(rows.reduce((sum, row) => sum + int(row.count), 0));
  return { provider, refunds, payouts, chargebacks, reconciliations, cod, failedPayments,
    counts: { providerEvents: total(provider), staleRefunds: total(refunds), unknownPayouts: total(payouts), openDisputes: total(chargebacks), reconciliationRuns: total(reconciliations), pendingCod: total(cod), failedPayments: total(failedPayments) },
    total: int(total(provider) + total(refunds) + total(payouts) + total(chargebacks) + total(reconciliations) + total(cod)) };
}

export async function financeReportSummary(context, window, now = new Date()) {
  const scope = context.countryScope, group = extra => ({ $group: { _id: { country: '$country', currency: '$currency' }, count: { $sum: 1 }, ...extra } });
  const [payments, refunds, payouts, ledger, exceptions] = await reportQueries([
    () => PaymentIntent.aggregate([...paymentPipeline(scope, window, { captured: true }), group({ amountMinor: { $sum: '$amountMinor' }, refundedMinor: { $sum: '$refundedMinor' } })]).session(context.session || null),
    () => Refund.aggregate([...refundPipeline(scope, window, { completed: true }), group({ amountMinor: { $sum: '$amountMinor' } })]).session(context.session || null),
    () => Payout.aggregate([...payoutPipeline(scope, window, { paid: true }), group({ amountMinor: { $sum: '$amountMinor' } })]).session(context.session || null),
    () => LedgerTransaction.aggregate([...ledgerPipeline(scope, window), group({ debitMinor: { $sum: '$debitMinor' }, creditMinor: { $sum: '$creditMinor' } })]).session(context.session || null),
    () => exceptionCounts(scope, now, context.session || null),
  ], context.session);
  const groups = new Map();
  const marketFor = country => context.countries.find(row => row.code === country);
  const ensure = (country, currency) => { const key = country + ':' + currency; if (!groups.has(key)) groups.set(key, { country, currency, capturedMinor: 0, capturedCount: 0, refundedMinor: 0, refundCount: 0, payoutMinor: 0, payoutCount: 0, ledgerDebitMinor: 0, ledgerCreditMinor: 0, ledgerCount: 0, exceptions: 0 }); return groups.get(key); };
  for (const market of context.countries.filter(row => !context.country || row.code === context.country)) ensure(market.code, market.currency);
  for (const row of payments) Object.assign(ensure(row._id.country, row._id.currency), { capturedMinor: int(row.amountMinor), capturedCount: int(row.count) });
  for (const row of refunds) Object.assign(ensure(row._id.country, row._id.currency), { refundedMinor: int(row.amountMinor), refundCount: int(row.count) });
  for (const row of payouts) Object.assign(ensure(row._id.country, row._id.currency), { payoutMinor: int(row.amountMinor), payoutCount: int(row.count) });
  for (const row of ledger) Object.assign(ensure(row._id.country, row._id.currency), { ledgerDebitMinor: int(row.debitMinor), ledgerCreditMinor: int(row.creditMinor), ledgerCount: int(row.count) });
  for (const [kind, rows] of Object.entries(exceptions)) if (Array.isArray(rows) && kind !== 'failedPayments') for (const row of rows) {
    const country = typeof row._id === 'string' ? row._id : row._id.country;
    const currency = typeof row._id === 'string' ? marketFor(country)?.currency : row._id.currency || marketFor(country)?.currency;
    if (currency) ensure(country, currency).exceptions += int(row.count);
  }
  return { groups: [...groups.values()].sort((a, b) => a.country.localeCompare(b.country) || a.currency.localeCompare(b.currency)), exceptions: exceptions.counts, exceptionCount: exceptions.total };
}

const AUDIT_FIELDS = { publicId: 1, requestId: 1, actorPublicId: 1, action: 1, targetType: 1, targetPublicId: 1, country: 1, result: 1, createdAt: 1 };
function auditPipeline(scope, window, query) {
  const match = { ...scope, action: /^finance\./, createdAt: { $gte: window.start, $lt: window.end } };
  if (query.status !== 'all') match.result = query.status;
  if (query.search) match.$or = ['action', 'targetPublicId', 'targetType', 'actorPublicId', 'requestId'].map(field => ({ [field]: regex(query.search) }));
  return [{ $match: match }, { $project: AUDIT_FIELDS }];
}

function reportSource(report, context, window, query) {
  const scope = context.countryScope, search = query.search;
  if (report === 'payments') return { Model: PaymentIntent, pipeline: paymentPipeline(scope, window, { search }), projection: { publicId: 1, country: 1, currency: 1, orderPublicId: 1, provider: 1, status: 1, amountMinor: 1, refundedMinor: 1, createdAt: 1, paidAt: 1 }, columns: ['Payment', 'Country', 'Currency', 'Order', 'Provider', 'Amount', 'Status'],
    map: row => ({ publicId: row.publicId, country: row.country, currency: row.currency, orderPublicId: row.orderPublicId, provider: row.provider, status: row.status, amountMinor: int(row.amountMinor), refundedMinor: int(row.refundedMinor), createdAt: row.createdAt, paidAt: row.paidAt }), cells: row => [row.publicId, row.country, row.currency, row.orderPublicId, row.provider, money(row.amountMinor, row.currency), label(row.status)],
    headers: ['Payment', 'Country', 'Currency', 'Order', 'Provider', 'Status', 'Amount minor', 'Refunded minor', 'Created', 'Paid'], csv: row => [row.publicId, row.country, row.currency, row.orderPublicId, row.provider, row.status, int(row.amountMinor), int(row.refundedMinor), iso(row.createdAt), iso(row.paidAt)] };
  if (report === 'refunds') return { Model: Refund, pipeline: refundPipeline(scope, window, { search }), projection: { publicId: 1, country: 1, currency: 1, orderPublicId: 1, provider: 1, status: 1, amountMinor: 1, createdAt: 1, completedAt: 1 }, columns: ['Refund', 'Country', 'Currency', 'Order', 'Provider', 'Amount', 'Status'],
    map: row => ({ publicId: row.publicId, country: row.country, currency: row.currency, orderPublicId: row.orderPublicId, provider: row.provider, status: row.status, amountMinor: int(row.amountMinor), createdAt: row.createdAt, completedAt: row.completedAt }), cells: row => [row.publicId, row.country, row.currency, row.orderPublicId, row.provider, money(row.amountMinor, row.currency), label(row.status)],
    headers: ['Refund', 'Country', 'Currency', 'Order', 'Provider', 'Status', 'Amount minor', 'Created', 'Completed'], csv: row => [row.publicId, row.country, row.currency, row.orderPublicId, row.provider, row.status, int(row.amountMinor), iso(row.createdAt), iso(row.completedAt)] };
  if (report === 'payouts') return { Model: Payout, pipeline: payoutPipeline(scope, window, { search }), projection: { publicId: 1, country: 1, currency: 1, ownerStorePublicId: 1, 'account.ownerType': 1, status: 1, amountMinor: 1, createdAt: 1, completedAt: 1 }, columns: ['Payout', 'Country', 'Currency', 'Owner type', 'Store', 'Amount', 'Status'],
    map: row => ({ publicId: row.publicId, country: row.country, currency: row.currency, ownerStorePublicId: row.ownerStorePublicId || '', ownerType: row.account?.ownerType || '', status: row.status, amountMinor: int(row.amountMinor), createdAt: row.createdAt, completedAt: row.completedAt }), cells: row => [row.publicId, row.country, row.currency, row.ownerType, row.ownerStorePublicId || '—', money(row.amountMinor, row.currency), label(row.status)],
    headers: ['Payout', 'Country', 'Currency', 'Owner type', 'Store', 'Status', 'Amount minor', 'Created', 'Completed'], csv: row => [row.publicId, row.country, row.currency, row.account?.ownerType || '', row.ownerStorePublicId || '', row.status, int(row.amountMinor), iso(row.createdAt), iso(row.completedAt)] };
  if (report === 'ledger') return { Model: LedgerTransaction, pipeline: ledgerPipeline(scope, window, search), projection: { publicId: 1, country: 1, currency: 1, referenceType: 1, referencePublicId: 1, description: 1, debitMinor: 1, creditMinor: 1, postedAt: 1, createdAt: 1 }, columns: ['Transaction', 'Country', 'Currency', 'Reference', 'Debit', 'Credit', 'Recorded'],
    map: row => ({ publicId: row.publicId, country: row.country, currency: row.currency, referenceType: row.referenceType, referencePublicId: row.referencePublicId, description: row.description, debitMinor: int(row.debitMinor), creditMinor: int(row.creditMinor), postedAt: row.postedAt, createdAt: row.createdAt }), cells: row => [row.publicId, row.country, row.currency, row.referencePublicId, money(row.debitMinor, row.currency), money(row.creditMinor, row.currency), iso(row.postedAt)],
    headers: ['Transaction', 'Country', 'Currency', 'Reference type', 'Reference', 'Description', 'Debit minor', 'Credit minor', 'Posted'], csv: row => [row.publicId, row.country, row.currency, row.referenceType, row.referencePublicId, row.description, int(row.debitMinor), int(row.creditMinor), iso(row.postedAt)] };
  if (report === 'reconciliation') return { Model: ReconciliationRun, pipeline: reconciliationPipeline(scope, window, search), projection: { publicId: 1, country: 1, currency: 1, provider: 1, status: 1, checked: 1, matched: 1, updated: 1, failed: 1, expectedAmountMinor: 1, declaredAmountMinor: 1, businessDate: 1, createdAt: 1, completedAt: 1 }, columns: ['Run', 'Country', 'Currency', 'Provider', 'Checked', 'Matched', 'Exceptions', 'Status'],
    map: row => ({ publicId: row.publicId, country: row.country, currency: row.currency || '', provider: row.provider, status: row.status, checked: int(row.checked), matched: int(row.matched), updated: int(row.updated), failed: int(row.failed), ...(row.currency ? { expectedAmountMinor: row.expectedAmountMinor === undefined ? null : int(row.expectedAmountMinor), declaredAmountMinor: row.declaredAmountMinor === undefined ? null : int(row.declaredAmountMinor) } : {}), businessDate: row.businessDate || '', createdAt: row.createdAt, completedAt: row.completedAt }), cells: row => [row.publicId, row.country, row.currency || '—', row.provider, row.checked, row.matched, row.failed, label(row.status)],
    headers: ['Run', 'Country', 'Currency', 'Provider', 'Status', 'Checked', 'Matched', 'Updated', 'Failed', 'Expected minor', 'Declared minor', 'Business date', 'Created', 'Completed'], csv: row => [row.publicId, row.country, row.currency || '', row.provider, row.status, int(row.checked), int(row.matched), int(row.updated), int(row.failed), row.currency && row.expectedAmountMinor !== undefined ? int(row.expectedAmountMinor) : '', row.currency && row.declaredAmountMinor !== undefined ? int(row.declaredAmountMinor) : '', row.businessDate || '', iso(row.createdAt), iso(row.completedAt)] };
  return null;
}

const iso = value => value ? new Date(value).toISOString() : '';
export function financeCsvCell(value) { let text = String(value ?? ''); if (/^[\s\uFEFF]*[=+\-@]/u.test(text)) text = "'" + text; return '"' + text.replaceAll('"', '""') + '"'; }
function summaryCells(row) { return [row.country, row.currency, money(row.capturedMinor, row.currency), money(row.refundedMinor, row.currency), money(row.payoutMinor, row.currency), money(row.ledgerDebitMinor, row.currency), money(row.ledgerCreditMinor, row.currency), row.exceptions]; }
const summaryColumns = ['Country', 'Currency', 'Verified captured', 'Completed refunds', 'Paid payouts', 'Ledger debits', 'Ledger credits', 'Exceptions'];

async function reportPage(source, after) {
  const [result] = await source.Model.aggregate([...source.pipeline, { $project: source.projection }, { $facet: { items: [{ $match: cursorScope({}, after) }, { $sort: cursorSort() }, { $limit: SIZE + 1 }], total: [{ $count: 'count' }] } }]);
  const page = pageResult(result?.items || [], { limit: SIZE, total: result?.total?.[0]?.count || 0 });
  return { items: page.items.map(source.map), page: page.page };
}

async function overviewTrend(context, window) {
  const dateGroup = { $dateToString: { date: '$paidAt', format: window.monthly ? '%Y-%m' : '%Y-%m-%d', timezone: window.timeZone } };
  const records = await PaymentIntent.aggregate([...paymentPipeline(context.countryScope, window, { captured: true }), { $group: { _id: { key: dateGroup, currency: '$currency' }, count: { $sum: 1 }, amountMinor: { $sum: '$amountMinor' } } }]);
  // The all-market chart counts payments. Currency values remain in separate report groups.
  const valueFor = bucket => records.filter(row => bucket.keys.includes(row._id.key)).reduce((sum, row) => sum + int(row.count), 0);
  return window.buckets.map(bucket => ({ key: bucket.key, label: bucket.label, value: int(valueFor(bucket)), display: String(int(valueFor(bucket))) }));
}

export async function loadFinanceReportPage(request, pageId, { now = new Date() } = {}) {
  if (!['finance-overview', 'finance-reports', 'finance-audit'].includes(pageId)) throw new AppError('Financial report is unavailable.', 404, 'FINANCE_PAGE_NOT_FOUND');
  const access = await financeAccess(request), query = reportFilters(request, access.actor, pageId), timeZone = access.market?.timeZone || 'UTC';
  const window = financeReportingWindow(query.period, timeZone, now), context = { ...access, countryScope: access.countryScope };
  const summary = await financeReportSummary(context, window, now), groups = summary.groups;
  let items = [], rows = [], columns = summaryColumns, page = { count: 0, total: 0, hasMore: false, next: '' };
  if (pageId === 'finance-audit') {
    const source = { Model: AuditLog, pipeline: auditPipeline(access.countryScope, window, query), projection: AUDIT_FIELDS,
      map: row => ({ requestId: row.requestId, actorPublicId: row.actorPublicId || '', action: row.action, targetType: row.targetType || '', targetPublicId: row.targetPublicId || '', country: row.country || '', result: row.result, createdAt: row.createdAt }) };
    ({ items, page } = await reportPage(source, query.after)); columns = ['Recorded', 'Country', 'Action', 'Target', 'Actor', 'Result'];
    rows = items.map(row => ({ id: row.requestId, cells: [iso(row.createdAt), row.country, row.action, row.targetPublicId || row.targetType, row.actorPublicId || 'System', row.result] }));
  } else if (pageId === 'finance-reports' && query.report !== 'summary') {
    const source = reportSource(query.report, context, window, query); ({ items, page } = await reportPage(source, query.after)); columns = source.columns;
    rows = items.map(row => ({ id: row.publicId, cells: source.cells(row) }));
  } else {
    const filtered = groups.filter(row => !query.search || `${row.country} ${row.currency}`.toLowerCase().includes(query.search.toLowerCase()));
    rows = filtered.map(row => ({ id: row.country + ':' + row.currency, cells: summaryCells(row) })); page = { ...page, count: rows.length, total: rows.length };
  }
  const sumCount = field => int(groups.reduce((total, row) => total + row[field], 0));
  const totals = { capturedCount: sumCount('capturedCount'), refundCount: sumCount('refundCount'), payoutCount: sumCount('payoutCount'), ledgerCount: sumCount('ledgerCount') };
  const priorities = [
    { count: summary.exceptions.unknownPayouts, text: 'payout submissions need settlement evidence', href: '/finance/payouts?status=unknown' },
    { count: summary.exceptions.staleRefunds, text: 'refunds have been processing for over two hours', href: '/finance/refunds?status=processing' },
    { count: summary.exceptions.providerEvents + summary.exceptions.reconciliationRuns + summary.exceptions.pendingCod, text: 'provider, reconciliation or cash collection exceptions need review', href: '/finance/reconciliation' },
    { count: summary.exceptions.openDisputes, text: 'financial disputes need review', href: '/finance/disputes' },
  ].filter(row => row.count).map(row => ({ text: `${row.count} ${row.text}`, href: row.href + (access.country ? (row.href.includes('?') ? '&' : '?') + 'country=' + access.country : '') }));
  const recent = await AuditLog.find({ ...access.countryScope, action: /^finance\./ }).select('action targetPublicId country result createdAt -_id').sort(cursorSort()).limit(4).lean();
  const flow = { kind: 'reports', pageId, country: access.country, countries: access.countries.map(row => ({ code: row.code, name: row.name })), context: { country: access.country, countries: access.countries.map(row => ({ code: row.code, name: row.name })) },
    timeZone, period: query.period, report: query.report, periodOptions: [{ value: '30days', label: 'Last 30 days' }, { value: '7months', label: 'Last 7 months' }, { value: 'year', label: 'This year' }], reportOptions: REPORTS.map(value => ({ value, label: label(value) })),
    metrics: [{ label: 'Verified captured payments', value: String(totals.capturedCount), detail: 'Confirmed payments in this period' }, { label: 'Completed refunds', value: String(totals.refundCount), detail: 'Completed money returns in this period' }, { label: 'Paid payouts', value: String(totals.payoutCount), detail: 'Settlements completed in this period' }, { label: 'Open financial exceptions', value: String(summary.exceptionCount), detail: 'Current scoped operational exceptions' }],
    groups, totals, exceptions: summary.exceptions, exceptionCount: summary.exceptionCount, columns, rows, items, page,
    filters: { search: query.search, status: query.status, after: query.after, statuses: pageId === 'finance-audit' ? RESULTS.map(value => ({ value, label: label(value) })) : [], params: { country: access.country, period: query.period, ...(pageId === 'finance-reports' ? { report: query.report } : {}) } },
    insights: priorities, priorities, workflow: [{ title: 'Verify provider truth', text: 'Review unresolved provider and cash reconciliation exceptions.', href: '/finance/reconciliation' }, { title: 'Review controlled money movement', text: 'Use approvals and settlement evidence for refunds and payouts.', href: '/finance/payouts' }, { title: 'Export scoped records', text: 'Amounts stay separated by country and currency.', href: '/finance/reports' }],
    health: { label: 'Financial controls', rows: [{ label: 'Open exceptions', value: String(summary.exceptionCount) }, { label: 'Verified ledger entries', value: String(totals.ledgerCount) }], note: 'Counts reflect recorded events; they are not a security or reconciliation score.' },
    verification: { label: 'Exceptions', value: `${summary.exceptionCount} open`, detail: summary.exceptionCount ? 'Awaiting review' : 'None recorded' },
    activity: recent.map(row => ({ text: `${label(row.action.replace(/^finance\./, ''))} · ${row.result}`, at: row.createdAt, href: '/finance/audit' + (row.country ? '?country=' + row.country : ''), icon: 'i-wallet' })), activityHref: '/finance/audit',
    coverage: { title: 'Market coverage', description: 'Authorized countries and separate settlement currencies.', people: [], stats: [{ label: 'Countries', value: String(new Set(groups.map(row => row.country)).size) }, { label: 'Currency groups', value: String(groups.length) }], note: 'Cross-currency totals are not combined.', href: '/finance/reports', label: 'Open financial reports' },
    tableTitle: pageId === 'finance-audit' ? 'Finance audit records' : query.report === 'summary' ? 'Settlement summary by market' : label(query.report) + ' records',
    tableDescription: 'Only records within your current finance permissions are shown.', emptyText: 'No financial records match this view.',
    exportHref: (pageId === 'finance-audit' ? '/finance/audit/export.csv' : '/finance/reports/export.csv') + '?' + new URLSearchParams({ country: access.country, period: query.period, report: query.report, search: query.search, ...(pageId === 'finance-audit' ? { status: query.status } : {}) }) };
  flow.sidebar = await loadFinanceSidebar(access, { now, exceptionCount: summary.exceptionCount });
  if (pageId === 'finance-overview') { flow.trend = await overviewTrend(context, window); flow.trendLabel = 'Verified captured payments'; flow.trendDescription = 'Confirmed payment counts in the selected reporting calendar.'; flow.priorityHref = priorities[0]?.href || '/finance/reconciliation'; }
  await assertFinanceExportAccess(request, access);
  return flow;
}

export async function streamFinanceReportCsv(request, response, pageId, { now = new Date() } = {}) {
  const context = await financeAccess(request), query = reportFilters(request, context.actor, pageId), window = financeReportingWindow(query.period, context.market?.timeZone || 'UTC', now);
  const report = pageId === 'finance-audit' ? 'audit' : query.report;
  await writeAudit(request, 'finance.report_exported', { targetType: 'financial_report', targetPublicId: report, country: context.country || context.countries[0].code, metadata: { report, period: query.period, countryScope: context.country || context.countries.map(row => row.code) } });
  await assertFinanceExportAccess(request, context);
  response.set('Content-Type', 'text/csv; charset=utf-8'); response.set('Content-Disposition', `attachment; filename="classic-mart-finance-${report}.csv"`);
  response.set('Cache-Control', 'private, no-store'); response.set('X-Robots-Tag', 'noindex, nofollow');
  const line = async values => { if (response.destroyed) throw new AppError('Export connection closed.', 499, 'EXPORT_CLOSED'); if (!response.write(values.map(financeCsvCell).join(',') + '\r\n')) await waitForDrain(response); };
  if (report === 'summary') {
    const summary = await financeReportSummary(context, window, now);
    await assertFinanceExportAccess(request, context);
    await line(['Country', 'Currency', 'Captured payments', 'Captured minor', 'Completed refunds', 'Refunded minor', 'Paid payouts', 'Paid payout minor', 'Ledger transactions', 'Ledger debit minor', 'Ledger credit minor', 'Open exceptions']);
    for (const row of summary.groups) if (!query.search || `${row.country} ${row.currency}`.toLowerCase().includes(query.search.toLowerCase())) { await assertFinanceExportAccess(request, context); await line([row.country, row.currency, row.capturedCount, row.capturedMinor, row.refundCount, row.refundedMinor, row.payoutCount, row.payoutMinor, row.ledgerCount, row.ledgerDebitMinor, row.ledgerCreditMinor, row.exceptions]); }
  } else {
    const source = report === 'audit' ? { Model: AuditLog, pipeline: auditPipeline(context.countryScope, window, query), projection: AUDIT_FIELDS, headers: ['Recorded', 'Country', 'Action', 'Target type', 'Target', 'Actor', 'Result', 'Request'], csv: row => [iso(row.createdAt), row.country || '', row.action, row.targetType || '', row.targetPublicId || '', row.actorPublicId || '', row.result, row.requestId] } : reportSource(report, context, window, query);
    const cursor = source.Model.aggregate([...source.pipeline, { $project: source.projection }, { $sort: cursorSort() }]).cursor({ batchSize: 100 });
    try { await assertFinanceExportAccess(request, context); await line(source.headers); for await (const row of cursor) { await assertFinanceExportAccess(request, context); await line(source.csv(row)); } } finally { await cursor.close(); }
  }
  response.end();
}

function waitForDrain(response) {
  return new Promise((resolve, reject) => {
    const clean = () => { response.off('drain', drain); response.off('close', close); response.off('error', error); };
    const drain = () => { clean(); resolve(); }, close = () => { clean(); reject(new AppError('Export connection closed.', 499, 'EXPORT_CLOSED')); }, error = cause => { clean(); reject(cause); };
    response.once('drain', drain); response.once('close', close); response.once('error', error);
    if (response.destroyed) close();
  });
}

export async function loadFinanceSidebar(context, { now = new Date(), exceptionCount } = {}) {
  const [exceptions, counts] = await Promise.all([
    Number.isSafeInteger(exceptionCount) ? { total: exceptionCount } : exceptionCounts(context.countryScope, now),
    ReconciliationRun.aggregate([{ $match: { ...context.countryScope, status: 'completed' } }, { $group: { _id: null, checked: { $sum: '$checked' }, matched: { $sum: '$matched' } } }]),
  ]);
  const checked = int(counts[0]?.checked), matched = int(counts[0]?.matched);
  return { matchingRate: checked > 0 && matched <= checked ? Math.round(matched / checked * 1000) / 10 : null,
    exceptionCount: exceptions.total, checked, matched };
}

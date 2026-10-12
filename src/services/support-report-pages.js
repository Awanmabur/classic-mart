import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { AuditLog, SatisfactionSurvey, SupportTicket } from '../models/index.js';
import { assertSupportReadAccess, supportAccess } from './support-workspace-access.js';
import { sellerOverviewWindow } from './seller-overview.js';
import { cursorScope, cursorSort, decodeCursor, pageResult } from './pagination.js';
import { writeAudit } from './audit.js';

const SIZE = 25;
const ACTIVE = ['open', 'in_progress', 'waiting_customer', 'escalated'];
const STATUSES = ['all', ...ACTIVE, 'resolved', 'closed'];
const REPORTS = ['summary', 'tickets', 'queues', 'csat'];
const integer = value => { const number = Number(value || 0); if (!Number.isSafeInteger(number) || number < 0) throw new AppError('Support reporting counts need review.', 503, 'SUPPORT_REPORT_INVALID'); return number; };
const label = value => String(value || '').replaceAll('_', ' ');
const regex = value => new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const iso = value => value ? new Date(value).toISOString() : '';
const round = value => Math.round(value * 10) / 10;
const ratio = (numerator, denominator) => denominator > 0 ? round(numerator / denominator * 100) : null;
const minutes = (milliseconds, count) => count > 0 ? round(milliseconds / count / 60000) : null;
const ticketScope = scope => ({ ...scope, mergedIntoPublicId: { $in: ['', null] }, createdAt: { $type: 'date' } });

export function supportReportingWindow(period = '30days', timeZone = 'UTC', now = new Date()) {
  return sellerOverviewWindow(period, timeZone, now);
}

function filters(request, actor) {
  const preferred = actor.preferences?.supportReportingPeriod;
  const input = z.object({ country: z.string().trim().max(2).default(''), period: z.enum(['30days', '7months', 'year']).default(['30days', '7months', 'year'].includes(preferred) ? preferred : '30days'),
    report: z.enum(REPORTS).default('summary'), search: z.string().trim().max(100).default(''), q: z.string().trim().max(100).optional(), status: z.enum(STATUSES).default('all'), after: z.string().max(512).default('') }).parse(request.query || {});
  if (input.after && !decodeCursor(input.after)) throw new AppError('The Support report cursor is invalid.', 422, 'SUPPORT_FILTER_INVALID');
  if (['summary', 'queues'].includes(input.report) && input.after) throw new AppError('This grouped report does not use a record cursor.', 422, 'SUPPORT_FILTER_INVALID');
  if (input.report !== 'tickets' && input.status !== 'all') throw new AppError('Only the ticket report supports a ticket status filter.', 422, 'SUPPORT_FILTER_INVALID');
  return { ...input, search: input.q ?? input.search };
}

// Only a public reply by an identified person other than the requester is a response.
// Intake/customer/internal notes and malformed or future timestamps cannot improve SLA data.
function ticketTiming(now) {
  return [{ $set: { firstResponseAt: { $min: { $map: { input: { $filter: { input: { $slice: [{ $ifNull: ['$notes', []] }, 1, 2147483647] }, as: 'note', cond: { $and: [
    { $ne: ['$$note.internal', true] }, { $eq: [{ $type: '$$note.actorUserId' }, 'objectId'] }, { $ne: ['$$note.actorUserId', { $ifNull: ['$userId', null] }] },
    { $eq: [{ $type: '$$note.at' }, 'date'] }, { $gte: ['$$note.at', '$createdAt'] }, { $lte: ['$$note.at', now] },
  ] } } }, as: 'note', in: '$$note.at' } } },
    validResolution: { $and: [{ $in: ['$status', ['resolved', 'closed']] }, { $eq: [{ $type: '$resolvedAt' }, 'date'] }, { $gte: ['$resolvedAt', '$createdAt'] }, { $lte: ['$resolvedAt', now] }] },
    validSla: { $and: [{ $eq: [{ $type: '$slaDueAt' }, 'date'] }, { $gte: ['$slaDueAt', '$createdAt'] }] },
  } }];
}

function surveyPipeline(scope, window, search = '') {
  const match = { ...scope, createdAt: { $gte: window.start, $lt: window.end }, rating: { $gte: 1, $lte: 5 } };
  if (search) match.ticketPublicId = regex(search);
  return [{ $match: match }, { $lookup: { from: SupportTicket.collection.name, localField: 'ticketId', foreignField: '_id', as: 'ticket', pipeline: [{ $match: ticketScope(scope) }, { $project: { publicId: 1, country: 1, userId: 1 } }] } }, { $unwind: '$ticket' },
    { $match: { $expr: { $and: [{ $eq: ['$ticketPublicId', '$ticket.publicId'] }, { $eq: ['$country', '$ticket.country'] }, { $eq: ['$userId', '$ticket.userId'] }, { $eq: ['$rating', { $floor: '$rating' }] }] } } }];
}

async function queries(tasks, session) {
  if (!session) return Promise.all(tasks.map(task => task()));
  const results = []; for (const task of tasks) results.push(await task()); return results;
}

export async function supportReportSummary(context, window, now = new Date()) {
  const inWindow = date => ({ $and: [{ $gte: [date, window.start] }, { $lt: [date, window.end] }] });
  const response = { $and: [{ $eq: [{ $type: '$firstResponseAt' }, 'date'] }, inWindow('$firstResponseAt')] };
  const resolved = { $and: ['$validResolution', inWindow('$resolvedAt')] };
  const active = { $in: ['$status', ACTIVE] };
  const count = condition => ({ $sum: { $cond: [condition, 1, 0] } });
  const [tickets, surveys, queues] = await queries([
    () => SupportTicket.aggregate([{ $match: { ...ticketScope(context.countryScope), $or: [{ status: { $in: ACTIVE } }, { createdAt: { $gte: window.start, $lt: window.end } }, { resolvedAt: { $gte: window.start, $lt: window.end } }, { 'notes.at': { $gte: window.start, $lt: window.end } }, { 'assignmentHistory.at': { $gte: window.start, $lt: window.end } }] } }, ...ticketTiming(now), { $group: { _id: '$country',
      createdCount: count(inWindow('$createdAt')), resolvedCount: count(resolved), openCount: count(active), mineCount: count({ $and: [active, { $eq: ['$assignedUserId', context.actor._id] }] }),
      overdueCount: count({ $and: [active, '$validSla', { $lt: ['$slaDueAt', now] }] }), slaObservedCount: count({ $and: [active, '$validSla'] }), slaWithinCount: count({ $and: [active, '$validSla', { $gte: ['$slaDueAt', now] }] }),
      escalatedCount: count({ $eq: ['$status', 'escalated'] }), waitingCount: count({ $eq: ['$status', 'waiting_customer'] }),
      responseCount: count(response), responseMilliseconds: { $sum: { $cond: [response, { $subtract: ['$firstResponseAt', '$createdAt'] }, 0] } },
      resolutionMilliseconds: { $sum: { $cond: [resolved, { $subtract: ['$resolvedAt', '$createdAt'] }, 0] } },
      transferCount: { $sum: { $size: { $filter: { input: { $ifNull: ['$assignmentHistory', []] }, as: 'entry', cond: { $and: [{ $eq: ['$$entry.action', 'transfer'] }, { $eq: [{ $type: '$$entry.at' }, 'date'] }, { $gte: ['$$entry.at', window.start] }, { $lt: ['$$entry.at', window.end] }] } } } } },
    } }]).session(context.session || null),
    () => SatisfactionSurvey.aggregate([...surveyPipeline(context.countryScope, window), { $group: { _id: '$country', surveyCount: { $sum: 1 }, ratingSum: { $sum: '$rating' }, satisfiedCount: { $sum: { $cond: [{ $gte: ['$rating', 4] }, 1, 0] } } } }]).session(context.session || null),
    () => SupportTicket.aggregate([{ $match: { ...ticketScope(context.countryScope), status: { $in: ACTIVE } } }, { $group: { _id: { country: '$country', queue: '$queue' }, count: { $sum: 1 }, overdue: { $sum: { $cond: [{ $and: [{ $eq: [{ $type: '$slaDueAt' }, 'date'] }, { $gte: ['$slaDueAt', '$createdAt'] }, { $lt: ['$slaDueAt', now] }] }, 1, 0] } }, unassigned: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$assignedUserId', null] }, null] }, 1, 0] } } } }, { $sort: { '_id.country': 1, '_id.queue': 1 } }]).session(context.session || null),
  ], context.session);
  const fields = ['createdCount', 'resolvedCount', 'openCount', 'mineCount', 'overdueCount', 'slaObservedCount', 'slaWithinCount', 'escalatedCount', 'waitingCount', 'responseCount', 'responseMilliseconds', 'resolutionMilliseconds', 'transferCount', 'surveyCount', 'ratingSum', 'satisfiedCount'];
  const groups = new Map(context.countries.filter(row => !context.country || row.code === context.country).map(row => [row.code, { country: row.code, ...Object.fromEntries(fields.map(field => [field, 0])) }]));
  for (const row of [...tickets, ...surveys]) {
    const group = groups.get(row._id); if (!group) continue;
    for (const field of fields) if (row[field] !== undefined) group[field] = integer(row[field]);
  }
  const totals = Object.fromEntries(fields.map(field => [field, integer([...groups.values()].reduce((sum, row) => sum + row[field], 0))]));
  const derived = row => ({ ...row, slaCompliance: ratio(row.slaWithinCount, row.slaObservedCount), averageResponseMinutes: minutes(row.responseMilliseconds, row.responseCount), averageResolutionMinutes: minutes(row.resolutionMilliseconds, row.resolvedCount), csatAverage: row.surveyCount ? round(row.ratingSum / row.surveyCount) : null, csatPercent: ratio(row.satisfiedCount, row.surveyCount) });
  return { groups: [...groups.values()].map(derived).sort((a, b) => a.country.localeCompare(b.country)), totals: derived(totals), queues: queues.map(row => ({ country: row._id.country, queue: row._id.queue || 'general', count: integer(row.count), overdue: integer(row.overdue), unassigned: integer(row.unassigned) })) };
}

export async function loadSupportSidebar(context, { now = new Date() } = {}) {
  const summary = await supportReportSummary(context, { start: new Date(now.getTime() - 30 * 86400000), end: now }, now);
  return { ...summary.totals, queueCounts: summary.queues };
}

async function overviewTrend(context, window) {
  const dateGroup = date => ({ $dateToString: { date, format: window.monthly ? '%Y-%m' : '%Y-%m-%d', timezone: window.timeZone } });
  const [created, resolved] = await Promise.all([
    SupportTicket.aggregate([{ $match: { ...ticketScope(context.countryScope), createdAt: { $gte: window.start, $lt: window.end } } }, { $group: { _id: dateGroup('$createdAt'), count: { $sum: 1 } } }]),
    SupportTicket.aggregate([{ $match: { ...ticketScope(context.countryScope), status: { $in: ['resolved', 'closed'] }, resolvedAt: { $gte: window.start, $lt: window.end } } }, { $match: { $expr: { $gte: ['$resolvedAt', '$createdAt'] } } }, { $group: { _id: dateGroup('$resolvedAt'), count: { $sum: 1 } } }]),
  ]);
  const createdMap = new Map(created.map(row => [row._id, integer(row.count)])), resolvedMap = new Map(resolved.map(row => [row._id, integer(row.count)]));
  return window.buckets.map(bucket => { const incoming = integer(bucket.keys.reduce((sum, key) => sum + (createdMap.get(key) || 0), 0)); return { key: bucket.key, label: bucket.label, value: incoming, created: incoming, resolved: integer(bucket.keys.reduce((sum, key) => sum + (resolvedMap.get(key) || 0), 0)) }; });
}

function ticketPipeline(context, window, query, now) {
  const match = { ...ticketScope(context.countryScope), createdAt: { $gte: window.start, $lt: window.end } };
  if (query.status !== 'all') match.status = query.status;
  if (query.search) match.$or = ['publicId', 'category', 'queue', 'priority', 'status'].map(field => ({ [field]: regex(query.search) }));
  return [{ $match: match }, ...ticketTiming(now), { $project: { publicId: 1, country: 1, category: 1, queue: 1, priority: 1, status: 1, createdAt: 1, resolvedAt: 1, firstResponseAt: 1, validResolution: 1, validSla: 1, slaDueAt: 1,
    assignment: { $cond: [{ $eq: ['$assignedUserId', context.actor._id] }, 'mine', { $cond: [{ $eq: [{ $ifNull: ['$assignedUserId', null] }, null] }, 'unassigned', 'assigned'] }] } } }];
}
const ticketDTO = (row, now) => ({ publicId: row.publicId, country: row.country, category: row.category, queue: row.queue, priority: row.priority, status: row.status, assignment: row.assignment, createdAt: row.createdAt,
  firstResponseAt: row.firstResponseAt || null, resolvedAt: row.validResolution ? row.resolvedAt : null,
  responseMinutes: row.firstResponseAt ? round((new Date(row.firstResponseAt).getTime() - new Date(row.createdAt).getTime()) / 60000) : null,
  resolutionMinutes: row.validResolution ? round((new Date(row.resolvedAt).getTime() - new Date(row.createdAt).getTime()) / 60000) : null,
  slaStatus: ACTIVE.includes(row.status) ? !row.validSla ? 'unknown' : new Date(row.slaDueAt) < now ? 'overdue' : 'within deadline' : 'resolved or closed' });
const surveyProjection = { publicId: 1, ticketPublicId: 1, country: 1, rating: 1, createdAt: 1 };

export async function loadSupportReportPage(request, pageId, { now = new Date() } = {}) {
  if (!['support-overview', 'support-reports'].includes(pageId)) throw new AppError('Support report not found.', 404, 'SUPPORT_PAGE_NOT_FOUND');
  const context = await supportAccess(request), query = filters(request, context.actor), window = supportReportingWindow(query.period, context.timeZone, now);
  const summary = await supportReportSummary(context, window, now); const totals = summary.totals;
  let columns, rows, items, page;
  if (query.report === 'tickets' || query.report === 'csat') {
    const isTickets = query.report === 'tickets', Model = isTickets ? SupportTicket : SatisfactionSurvey;
    const pipeline = isTickets ? ticketPipeline(context, window, query, now) : [...surveyPipeline(context.countryScope, window, query.search), { $project: surveyProjection }];
    const [records, count] = await Promise.all([Model.aggregate([...pipeline, { $match: cursorScope({}, query.after) }, { $sort: cursorSort() }, { $limit: SIZE + 1 }]), Model.aggregate([...pipeline, { $count: 'total' }])]);
    const result = pageResult(records, { limit: SIZE, total: integer(count[0]?.total) }); page = result.page;
    items = result.items.map(row => isTickets ? ticketDTO(row, now) : { publicId: row.publicId, ticketPublicId: row.ticketPublicId, country: row.country, rating: row.rating, createdAt: row.createdAt });
    columns = isTickets ? ['Ticket', 'Country', 'Queue', 'Priority', 'Assigned', 'SLA', 'Status'] : ['Survey', 'Ticket', 'Country', 'Rating', 'Submitted'];
    rows = items.map(row => ({ cells: isTickets ? [row.publicId, row.country, label(row.queue), label(row.priority), label(row.assignment), row.slaStatus, label(row.status)] : [row.publicId, row.ticketPublicId, row.country, row.rating + ' / 5', iso(row.createdAt)], ...(isTickets ? { href: '/support/queue?country=' + row.country + '&record=' + encodeURIComponent(row.publicId) } : {}) }));
  } else if (query.report === 'queues') {
    items = summary.queues.filter(row => !query.search || `${row.country} ${row.queue}`.toLowerCase().includes(query.search.toLowerCase()));
    columns = ['Country', 'Queue', 'Open', 'Overdue', 'Unassigned']; rows = items.map(row => ({ cells: [row.country, label(row.queue), row.count, row.overdue, row.unassigned] })); page = { count: rows.length, total: rows.length, hasMore: false, next: '' };
  } else {
    items = summary.groups.filter(row => !query.search || row.country.toLowerCase().includes(query.search.toLowerCase()));
    columns = ['Country', 'Created', 'Resolved', 'Open', 'Overdue', 'CSAT', 'SLA']; rows = items.map(row => ({ cells: [row.country, row.createdCount, row.resolvedCount, row.openCount, row.overdueCount, row.csatAverage === null ? 'No ratings' : row.csatAverage + ' / 5', row.slaCompliance === null ? 'No observations' : row.slaCompliance + '%'] })); page = { count: rows.length, total: rows.length, hasMore: false, next: '' };
  }
  const suffix = context.country ? '&country=' + context.country : '';
  const priorities = [{ count: totals.overdueCount, text: 'active tickets have passed their SLA deadline', href: '/support/queue?overdue=1' }, { count: totals.escalatedCount, text: 'escalated tickets need a review', href: '/support/queue?status=escalated' }, { count: totals.waitingCount, text: 'tickets are waiting for a customer reply', href: '/support/queue?status=waiting_customer' }].filter(row => row.count).map(row => ({ text: `${row.count} ${row.text}`, href: row.href + suffix }));
  const recent = await AuditLog.find({ ...context.countryScope, action: /^support\./ }).select('action country createdAt -_id').sort(cursorSort()).limit(4).lean();
  const flow = { kind: 'reports', pageId, country: context.country, context: { country: context.country, countries: context.countries.map(({ code, name }) => ({ code, name })) }, timeZone: window.timeZone, period: query.period, report: query.report,
    range: { start: window.start, end: window.end }, periodOptions: [{ value: '30days', label: 'Last 30 days' }, { value: '7months', label: 'Last 7 months' }, { value: 'year', label: 'This year' }], reportOptions: REPORTS.map(value => ({ value, label: label(value) })),
    metrics: [{ label: 'Open tickets', value: String(totals.openCount), detail: 'Current scoped backlog' }, { label: 'Resolved tickets', value: String(totals.resolvedCount), detail: 'Resolved in this reporting period' }, { label: 'Customer satisfaction', value: totals.csatAverage === null ? '—' : totals.csatAverage + ' / 5', detail: `${totals.surveyCount} verified ticket ratings in this period` }, { label: 'SLA within deadline', value: totals.slaCompliance === null ? '—' : totals.slaCompliance + '%', detail: `${totals.slaObservedCount} active tickets with recorded deadlines` }],
    groups: summary.groups, summary: totals, totals, queues: summary.queues, items, columns, rows, page,
    filters: { search: query.search, status: query.status, after: query.after, statuses: query.report === 'tickets' ? STATUSES.map(value => ({ value, label: label(value) })) : [], params: { country: context.country, period: query.period, report: query.report } },
    priorities, insights: priorities, priorityHref: priorities[0]?.href || '/support/queue', workflow: [{ title: 'Resolve assigned requests', text: 'Respond to customers and finish the ticket workflow.', href: '/support/queue?assignment=mine' }, { title: 'Review overdue work', text: 'Check recorded deadlines and escalations.', href: '/support/queue?overdue=1' }, { title: 'Review support reports', text: 'Use complete scoped counts and anonymous survey ratings.', href: '/support/reports' }],
    health: { label: 'Support workload', rows: [{ label: 'Assigned to you', value: String(totals.mineCount) }, { label: 'Overdue', value: String(totals.overdueCount) }, { label: 'Average first response', value: totals.averageResponseMinutes === null ? 'No responses' : totals.averageResponseMinutes + ' min' }], note: 'Response times use public replies; counts cover the complete authorized scope.' },
    verification: { label: 'SLA', value: totals.slaCompliance === null ? '—' : totals.slaCompliance + '%', detail: totals.slaObservedCount ? 'Active deadlines' : 'No observations' },
    activity: recent.map(row => ({ text: label(row.action.replace(/^support\./, '')), at: row.createdAt, href: '/support/queue?country=' + row.country, icon: 'i-headset' })), activityHref: '/support/queue',
    coverage: { title: 'Support coverage', description: 'Authorized markets and live support queues.', people: [], stats: [{ label: 'Countries', value: String(summary.groups.length) }, { label: 'Open queues', value: String(summary.queues.length) }], note: 'Contact information and private notes stay outside reports.', href: '/support/reports', label: 'Open support reports' },
    tableTitle: query.report === 'summary' ? 'Support summary by market' : label(query.report) + ' records', tableDescription: query.report === 'queues' ? 'Current active backlog by country and queue, across all matching tickets.' : 'Complete scoped reporting counts; record tables use cursor pagination.', emptyText: 'No support records match this view.',
    exportHref: '/support/reports/export.csv?' + new URLSearchParams({ country: context.country, period: query.period, report: query.report, search: query.search, status: query.status }) };
  flow.sidebar = { ...totals, queueCounts: summary.queues };
  if (pageId === 'support-overview') { flow.trend = await overviewTrend(context, window); flow.trendLabel = 'Incoming support tickets'; flow.trendDescription = `Created and resolved tickets in the ${window.timeZone} reporting calendar.`; }
  await assertSupportReadAccess(request, context); return flow;
}

export function supportCsvCell(value) { const text = String(value ?? ''); return '"' + (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) ? "'" + text : text).replaceAll('"', '""') + '"'; }
function waitForDrain(response) {
  return new Promise((resolve, reject) => { const clean = () => { response.off('drain', drain); response.off('close', close); response.off('error', error); }; const drain = () => { clean(); resolve(); }, close = () => { clean(); reject(new AppError('Export connection closed.', 499, 'EXPORT_CLOSED')); }, error = cause => { clean(); reject(cause); }; response.once('drain', drain); response.once('close', close); response.once('error', error); if (response.destroyed) close(); });
}

export async function streamSupportReportCsv(request, response, pageId, { now = new Date() } = {}) {
  if (!['support-overview', 'support-reports'].includes(pageId)) throw new AppError('Support report not found.', 404, 'SUPPORT_PAGE_NOT_FOUND');
  const context = await supportAccess(request), query = filters(request, context.actor), window = supportReportingWindow(query.period, context.timeZone, now);
  await writeAudit(request, 'support.report_exported', { actor: context.actor, targetType: 'support_report', targetPublicId: query.report, country: context.country || context.countries[0].code, metadata: { report: query.report, period: query.period, countryScope: context.country || context.countries.map(row => row.code) } });
  await assertSupportReadAccess(request, context);
  response.set('Content-Type', 'text/csv; charset=utf-8'); response.set('Content-Disposition', `attachment; filename="classic-mart-support-${query.report}.csv"`); response.set('Cache-Control', 'private, no-store'); response.set('X-Robots-Tag', 'noindex, nofollow');
  const line = async values => { if (response.destroyed) throw new AppError('Export connection closed.', 499, 'EXPORT_CLOSED'); if (!response.write(values.map(supportCsvCell).join(',') + '\r\n')) await waitForDrain(response); };
  if (['summary', 'queues'].includes(query.report)) {
    const summary = await supportReportSummary(context, window, now); await assertSupportReadAccess(request, context);
    const rows = query.report === 'summary' ? summary.groups : summary.queues;
    await line(query.report === 'summary' ? ['Country', 'Created', 'Resolved', 'Open', 'Assigned to you', 'Overdue', 'Escalated', 'Waiting customer', 'Transfers', 'Response observations', 'Average first response minutes', 'Average resolution minutes', 'Survey count', 'CSAT average', 'Satisfied percent', 'SLA observations', 'Within SLA percent'] : ['Country', 'Queue', 'Open', 'Overdue', 'Unassigned']);
    for (const row of rows) { if (query.search && !`${row.country} ${row.queue || ''}`.toLowerCase().includes(query.search.toLowerCase())) continue; await assertSupportReadAccess(request, context); await line(query.report === 'summary' ? [row.country, row.createdCount, row.resolvedCount, row.openCount, row.mineCount, row.overdueCount, row.escalatedCount, row.waitingCount, row.transferCount, row.responseCount, row.averageResponseMinutes, row.averageResolutionMinutes, row.surveyCount, row.csatAverage, row.csatPercent, row.slaObservedCount, row.slaCompliance] : [row.country, row.queue, row.count, row.overdue, row.unassigned]); }
  } else {
    const isTickets = query.report === 'tickets', Model = isTickets ? SupportTicket : SatisfactionSurvey;
    const pipeline = isTickets ? ticketPipeline(context, window, query, now) : [...surveyPipeline(context.countryScope, window, query.search), { $project: surveyProjection }];
    const cursor = Model.aggregate([...pipeline, { $sort: cursorSort() }]).cursor({ batchSize: 100 });
    try {
      await assertSupportReadAccess(request, context); await line(isTickets ? ['Ticket', 'Country', 'Category', 'Queue', 'Priority', 'Status', 'Assignment', 'SLA', 'Created', 'First response', 'Resolved', 'First response minutes', 'Resolution minutes'] : ['Survey', 'Ticket', 'Country', 'Rating', 'Submitted']);
      for await (const raw of cursor) { await assertSupportReadAccess(request, context); const row = isTickets ? ticketDTO(raw, now) : raw; await line(isTickets ? [row.publicId, row.country, row.category, row.queue, row.priority, row.status, row.assignment, row.slaStatus, iso(row.createdAt), iso(row.firstResponseAt), iso(row.resolvedAt), row.responseMinutes, row.resolutionMinutes] : [row.publicId, row.ticketPublicId, row.country, row.rating, iso(row.createdAt)]); }
    } finally { await cursor.close(); }
  }
  response.end();
}

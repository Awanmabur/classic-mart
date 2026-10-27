import { strongMfaFence } from './mfa-policy.js';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { env } from '../config/env.js';
import { Order, OutboxEvent, PlatformGrant, SupportTicket, User } from '../models/index.js';
import { countryAdminAccess, countryAdminPublicContext, assertCountryAdminReadAccess, fenceCountryAdminAccess } from './country-admin-workspace-access.js';
import { supportAccess } from './support-workspace-access.js';
import { mutateSupportTicket, SUPPORT_QUEUES, SUPPORT_TICKET_STATUSES, supportCsvCell } from './support-ticket-pages.js';
import { cursorScope, cursorSort, decodeCursor, pageResult } from './pagination.js';
import { writeAudit } from './audit.js';

const SIZE = 25, BASE = '/admin/support';
const ACTIVE = ['open', 'in_progress', 'waiting_customer', 'escalated'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const identifier = z.string().regex(/^[a-z][a-z0-9_-]{4,99}$/);
const version = z.union([z.number(), z.string().regex(/^\d+$/)]).pipe(z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const same = (a, b) => String(a || '') === String(b || '');
const label = value => String(value || '').replaceAll('_', ' ');
const escaped = value => new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const maskEmail = value => { const [local, domain] = String(value || '').split('@'); return domain ? `${local.slice(0, 1)}***@${domain}` : ''; };
const assignment = (row, actor) => row.assignedUserId ? same(row.assignedUserId, actor._id) ? 'mine' : 'other' : 'unassigned';
function trust(value) {
  if (Array.isArray(value)) return value.map(trust);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, trust(item)]));
    return Object.keys(result).some(key => key.startsWith('$')) ? mongoose.trusted(result) : result;
  }
  return value;
}
function input(request) {
  const params = new URL(request.originalUrl || BASE, 'http://localhost').searchParams;
  for (const name of params.keys()) if (params.getAll(name).length > 1 || /[.\[\]]/.test(name)) throw new AppError('Provide one value for each support filter.', 422, 'COUNTRY_ADMIN_FILTER_INVALID');
  const parsed = z.object({ country: z.string().regex(/^$|^[A-Z]{2}$/).optional(), search: z.string().trim().max(100).default(''), q: z.string().trim().max(100).optional(),
    status: z.enum(['all', ...SUPPORT_TICKET_STATUSES]).default('all'), queue: z.enum(['all', ...SUPPORT_QUEUES]).default('all'),
    priority: z.enum(['all', ...PRIORITIES]).default('all'), assignment: z.enum(['all', 'mine', 'unassigned']).default('all'),
    overdue: z.enum(['', '1']).default(''), after: z.string().max(512).default(''), record: identifier.optional() }).parse(request.query || {});
  if (parsed.after && !decodeCursor(parsed.after)) throw new AppError('Reload support with a valid page cursor.', 422, 'COUNTRY_ADMIN_SUPPORT_CURSOR_INVALID');
  return { ...parsed, search: parsed.q ?? parsed.search };
}
function scopeFor(context, filter) {
  const clauses = [context.countryScope];
  if (filter.status !== 'all') clauses.push({ status: filter.status });
  if (filter.queue !== 'all') clauses.push({ queue: filter.queue });
  if (filter.priority !== 'all') clauses.push({ priority: filter.priority });
  if (filter.assignment === 'mine') clauses.push({ assignedUserId: context.actor._id });
  if (filter.assignment === 'unassigned') clauses.push({ assignedUserId: null });
  if (filter.overdue) clauses.push({ status: { $in: ACTIVE }, slaDueAt: { $lt: new Date() } });
  if (filter.search) clauses.push({ $or: ['publicId', 'subject', 'orderPublicId', 'requesterName'].map(field => ({ [field]: escaped(filter.search) })) });
  return trust({ $and: clauses });
}
function href(filter, changes = {}) {
  const query = new URLSearchParams({ ...filter, ...changes });
  for (const [key, value] of [...query]) if (!value || value === 'all') query.delete(key);
  return BASE + (query.size ? '?' + query : '');
}
async function scopedTicket(context, id, session = null) {
  const ticket = await SupportTicket.findOne({ publicId: id, ...context.countryScope }).session(session);
  if (!ticket) throw new AppError('Support ticket not found in this country.', 404, 'COUNTRY_ADMIN_SUPPORT_NOT_FOUND');
  return ticket;
}
async function boundOrder(ticket, session = null, { strict = false } = {}) {
  if (!ticket.orderId && !ticket.orderPublicId) return null;
  const order = ticket.orderId && ticket.orderPublicId ? await Order.findOne({ _id: ticket.orderId, publicId: ticket.orderPublicId,
    country: ticket.country, ...(ticket.userId ? { userId: ticket.userId } : {}) }).session(session) : null;
  if (!order && strict) throw new AppError('This ticket no longer matches its original order.', 409, 'COUNTRY_ADMIN_SUPPORT_ORDER_MISMATCH');
  return order;
}
function assertIndependent(actor, ticket) {
  if (same(actor._id, ticket.userId) || same(actor._id, ticket.createdByUserId)) throw new AppError('A different administrator must handle their own support request.', 403, 'COUNTRY_ADMIN_SUPPORT_CONFLICT_OF_INTEREST');
}
async function ticketDTO(ticket, context, detail = false, relations = null) {
  const requester = ticket.userId ? relations?.get(String(ticket.userId)) || await User.findById(ticket.userId).select('publicId name email').lean() : null;
  const owner = ticket.assignedUserId ? relations?.get(String(ticket.assignedUserId)) || await User.findById(ticket.assignedUserId).select('publicId name').lean() : null;
  const ownRequest = same(context.actor._id, ticket.userId) || same(context.actor._id, ticket.createdByUserId);
  const result = { publicId: ticket.publicId, country: ticket.country, subject: ticket.subject, category: ticket.category, priority: ticket.priority,
    queue: ticket.queue, status: ticket.status, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt, slaDueAt: ticket.slaDueAt,
    resolvedAt: ticket.resolvedAt || null, reopenedAt: ticket.reopenedAt || null, version: ticket.__v || 0,
    requester: { publicId: requester?.publicId || '', name: requester?.name || ticket.requesterName || 'Guest requester', emailMasked: ticket.requesterEmailMasked || maskEmail(requester?.email) },
    owner: owner ? { publicId: owner.publicId, name: owner.name } : null, assignment: assignment(ticket, context.actor),
    ownedByActor: same(ticket.assignedUserId, context.actor._id), canClaim: !ownRequest && !ticket.assignedUserId && !ticket.mergedIntoPublicId,
    canAct: !ownRequest && !ticket.mergedIntoPublicId, independenceReason: ownRequest ? 'A different administrator must handle this request.' : '', mergedIntoPublicId: ticket.mergedIntoPublicId || '' };
  if (detail) {
    const order = await boundOrder(ticket);
    result.order = order ? { publicId: order.publicId, country: order.country, status: order.status, paymentState: order.paymentState,
      fulfillmentState: order.fulfillmentState, currency: order.totals.currency, amountMinor: order.totals.totalMinor } : null;
    if ((ticket.orderId || ticket.orderPublicId) && !order) { result.canAct = false; result.canClaim = false; result.sourceError = 'The saved original order relation is unavailable.'; }
    result.notes = (ticket.notes || []).slice(-1000).map(note => ({ message: note.message, internal: note.internal === true, at: note.at,
      author: same(note.actorUserId, ticket.userId) ? 'Requester' : same(note.actorUserId, context.actor._id) ? 'You' : 'Staff' }));
    result.history = (ticket.workflowHistory || []).slice(-100).map(entry => ({ action: entry.action, fromStatus: entry.fromStatus, toStatus: entry.toStatus, note: entry.note, at: entry.at }));
    result.assignments = (ticket.assignmentHistory || []).slice(-100).map(entry => ({ action: entry.action, at: entry.at }));
    result.delivery = await OutboxEvent.find({ aggregatePublicId: ticket.publicId, type: 'support.ticket_reply', 'payload.country': ticket.country })
      .select('status attempts processedAt payload.noteIndex payload.deliveryStatus').sort({ createdAt: -1 }).limit(10).lean()
      .then(rows => rows.map(row => ({ status: row.payload?.deliveryStatus || row.status, attempts: row.attempts, noteIndex: row.payload?.noteIndex, processedAt: row.processedAt || null })));
  }
  return result;
}
async function transferCandidates(ticket, actor) {
  const now = new Date(), grants = await PlatformGrant.find(trust({ role: 'support', status: 'active', operationalCountries: ticket.country,
    startsAt: { $lte: now }, expiresAt: { $gt: now } })).select('userId').lean();
  const users = await User.find(trust({ status: 'active', emailVerifiedAt: { $ne: null }, onboardingCompletedAt: { $ne: null },
    ...(env.security.privilegedMfaRequired && !env.auth.simpleLogin ? { $and: [strongMfaFence()] } : {}),
    $or: [{ _id: { $in: grants.map(row => row.userId) } }, { role: 'support', platformAccessManagedAt: null }] }))
    .select('publicId name role country +operationalCountries platformAccessManagedAt security.tokenVersion emailVerifiedAt onboardingCompletedAt security.mfaEnabled').sort({ name: 1, publicId: 1 }).limit(100);
  const result = [];
  for (const user of users) {
    if (same(user._id, actor._id) || same(user._id, ticket.userId) || same(user._id, ticket.createdByUserId)) continue;
    try {
      await supportAccess({ user, session: { tokenVersion: user.security.tokenVersion }, query: {} }, { country: ticket.country });
      result.push({ publicId: user.publicId, name: user.name });
      if (result.length === 50) break;
    } catch (error) { if (!error.status || error.status >= 500) throw error; }
  }
  return result;
}

export async function loadCountryAdminSupportPage(request) {
  const filter = input(request), context = await countryAdminAccess(request), scope = scopeFor(context, filter), now = new Date();
  const [rows, total, statistics] = await Promise.all([
    SupportTicket.find(trust(cursorScope(scope, filter.after))).sort(cursorSort()).limit(SIZE + 1).lean(),
    SupportTicket.countDocuments(scope),
    SupportTicket.aggregate([{ $match: context.countryScope }, { $group: { _id: null,
      open: { $sum: { $cond: [{ $in: ['$status', ACTIVE] }, 1, 0] } }, waiting: { $sum: { $cond: [{ $eq: ['$status', 'waiting_customer'] }, 1, 0] } },
      escalated: { $sum: { $cond: [{ $eq: ['$status', 'escalated'] }, 1, 0] } },
      overdue: { $sum: { $cond: [{ $and: [{ $in: ['$status', ACTIVE] }, { $lt: ['$slaDueAt', now] }] }, 1, 0] } } } }]),
  ]);
  const paged = pageResult(rows, { limit: SIZE, total }), userIds = [...new Set(paged.items.flatMap(row => [row.userId, row.assignedUserId]).filter(Boolean).map(String))];
  const relations = new Map((await User.find({ _id: mongoose.trusted({ $in: userIds }) }).select('publicId name email').lean()).map(row => [String(row._id), row]));
  const items = await Promise.all(paged.items.map(row => ticketDTO(row, context, false, relations)));
  const id = request.params?.publicId || filter.record;
  const selected = id ? await ticketDTO(await scopedTicket(context, identifier.parse(id)), context, true) : null;
  const candidates = selected ? await transferCandidates(await scopedTicket(context, selected.publicId), context.actor) : [];
  await assertCountryAdminReadAccess(request, context);
  const stats = statistics[0] || { open: 0, waiting: 0, escalated: 0, overdue: 0 };
  const params = { country: context.country, search: filter.search, status: filter.status, queue: filter.queue,
    priority: filter.priority, assignment: filter.assignment, overdue: filter.overdue };
  return { kind: 'support', pageId: 'admin-support', context: countryAdminPublicContext(context), country: context.country,
    items, selected, transferCandidates: candidates, page: paged.page, columns: ['Ticket', 'Requester', 'Subject', 'Country', 'Owner', 'Status'],
    rows: items.map(row => ({ id: row.publicId, href: BASE + '/' + encodeURIComponent(row.publicId) + '?' + new URLSearchParams(params),
      cells: [row.publicId, row.requester.name, row.subject, row.country, row.owner?.name || 'Unassigned', label(row.status)] })),
    filters: { ...filter, country: context.country, params, statuses: ['all', ...SUPPORT_TICKET_STATUSES].map(value => ({ value, label: label(value) })),
      queues: ['all', ...SUPPORT_QUEUES].map(value => ({ value, label: label(value) })), priorities: ['all', ...PRIORITIES].map(value => ({ value, label: label(value) })),
      assignments: [{ value: 'all', label: 'All ownership' }, { value: 'mine', label: 'Assigned to you' }, { value: 'unassigned', label: 'Unassigned' }] },
    metrics: [{ label: 'Open tickets', value: stats.open, detail: 'All active conversations in the authorized scope' },
      { label: 'Waiting for requester', value: stats.waiting, detail: 'Saved conversations awaiting a customer reply' },
      { label: 'Escalations', value: stats.escalated, detail: 'Cases recorded for specialist attention' },
      { label: 'Overdue tickets', value: stats.overdue, detail: 'Active cases beyond their recorded SLA' }],
    tableTitle: 'Support conversations', tableDescription: 'Saved customer requests in the currently authorized countries.', emptyText: 'No support requests match this view.',
    pagination: { ...paged.page, nextHref: paged.page.hasMore ? href(params, { after: paged.page.next }) : '' }, exportHref: BASE + '/export.csv?' + new URLSearchParams(params),
    insights: [{ text: stats.waiting + ' conversations are waiting for a requester reply.', href: href(params, { status: 'waiting_customer' }), label: 'Review waiting requests' }],
    workflow: [{ title: 'Claim the conversation', text: 'An independent operator owns the request before replying or updating its workflow.' },
      { title: 'Save a public next step', text: 'The customer sees public replies in their saved support conversation. Internal notes stay with authorized staff.' },
      { title: 'Resolve or reopen with a reason', text: 'Every change and its audit record are saved together.' }], activityHref: '/admin/reports' };
}

export async function countryAdminSupportAction(request, action = request.body?.action) {
  const context = await countryAdminAccess(request), id = identifier.parse(request.params?.publicId), ticket = await scopedTicket(context, id);
  if (request.query?.country && request.query.country !== ticket.country) throw new AppError('Support ticket not found in this country.', 404, 'COUNTRY_ADMIN_SUPPORT_NOT_FOUND');
  const parsedVersion = version.parse(request.body?.version);
  const mode = z.enum(['claim', 'release', 'transfer', 'update', 'reply', 'status', 'resolve', 'reopen']).parse(action);
  const body = { ...(request.body || {}), action: mode === 'resolve' ? 'status' : mode, version: parsedVersion,
    ...(mode === 'resolve' ? { status: 'resolved' } : {}) };
  // The marker and source callback are server-owned; request body fields cannot choose authority.
  const guarded = Object.create(request);
  Object.defineProperty(guarded, 'requiredOperationalWorkspace', { value: 'admin' });
  return mutateSupportTicket(guarded, id, body, { workspace: false, assertSource: async (supportContext, current, session) => {
    const admin = await countryAdminAccess(guarded, { session, country: current.country });
    if (!same(admin.actor._id, supportContext.actor._id) || !same(admin.grant?._id, supportContext.grant?._id)) throw new AppError('Country Admin access changed.', 403, 'COUNTRY_ADMIN_ACCESS_CHANGED');
    if (request.query?.country && request.query.country !== current.country) throw new AppError('This request moved outside the selected country.', 409, 'COUNTRY_ADMIN_SUPPORT_SOURCE_CHANGED');
    assertIndependent(admin.actor, current);
    if (mode === 'transfer') {
      const recipient = await User.findOne({ publicId: body.recipient }).session(session).select('_id');
      if (recipient && (same(recipient._id, current.userId) || same(recipient._id, current.createdByUserId))) throw new AppError('Transfer this request to an independent Support operator.', 403, 'COUNTRY_ADMIN_SUPPORT_CONFLICT_OF_INTEREST');
    }
    const original = await boundOrder(current, session, { strict: true });
    if (original) {
      if (original.totals.currency !== admin.currency) throw new AppError('This request no longer matches its original market currency.', 409, 'COUNTRY_ADMIN_SUPPORT_ORDER_MISMATCH');
      const result = await Order.updateOne({ _id: original._id, publicId: current.orderPublicId, country: current.country,
        ...(current.userId ? { userId: current.userId } : {}), __v: original.__v || 0 }, { $inc: { __v: 1 } }, { session });
      if (result.modifiedCount !== 1) throw new AppError('The original order changed. Reload this support request.', 409, 'COUNTRY_ADMIN_SUPPORT_SOURCE_CHANGED');
    }
  } });
}

async function csvWrite(response, values) {
  if (response.destroyed || response.writableEnded) return false;
  if (response.write(values.map(supportCsvCell).join(',') + '\r\n')) return true;
  return new Promise((resolve, reject) => {
    const cleanup = () => { response.off('drain', drained); response.off('close', closed); response.off('error', failed); };
    const drained = () => { cleanup(); resolve(true); }, closed = () => { cleanup(); resolve(false); }, failed = error => { cleanup(); reject(error); };
    response.once('drain', drained); response.once('close', closed); response.once('error', failed);
    if (response.destroyed || response.writableEnded) closed();
  });
}
export async function streamCountryAdminSupportCsv(request, response) {
  const filter = input(request), context = await countryAdminAccess(request), session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const current = await countryAdminAccess(request, { session }); await fenceCountryAdminAccess(current, session, { allMarkets: true });
      for (const market of current.countries.filter(row => !current.country || row.code === current.country)) {
        await writeAudit(request, 'country_admin.support_exported', { actor: current.actor, session, country: market.code,
          targetType: 'support_export', metadata: { status: filter.status, queue: filter.queue, priority: filter.priority } });
      }
    });
  } finally { await session.endSession(); }
  await assertCountryAdminReadAccess(request, context);
  response.type('text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="country-admin-support.csv"');
  if (!await csvWrite(response, ['Ticket', 'Country', 'Subject', 'Category', 'Priority', 'Queue', 'Status', 'Created at', 'SLA due'])) return;
  const cursor = SupportTicket.find(scopeFor(context, filter)).select('publicId country subject category priority queue status createdAt slaDueAt').sort(cursorSort()).lean().cursor({ batchSize: 100 });
  try {
    for await (const row of cursor) {
      await assertCountryAdminReadAccess(request, context);
      if (!await csvWrite(response, [row.publicId, row.country, row.subject, row.category, row.priority, row.queue, row.status,
        row.createdAt?.toISOString(), row.slaDueAt?.toISOString()])) break;
    }
  } finally { await cursor.close(); }
  if (!response.destroyed && !response.writableEnded) response.end();
}

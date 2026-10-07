import {
  Dispute,
  Order,
  ReturnRequest,
  Review,
  SatisfactionSurvey,
  SupportMacro,
  SupportTicket,
  User,
} from '../models/index.js';
import { hasPermission } from '../core/roles.js';
import { operationalCountriesFor } from './authorization.js';
import { supportScope } from './trust.js';

const ACTIVE_TICKET_STATUSES = ['open', 'in_progress', 'waiting_customer', 'escalated'];
const TICKET_STATUSES = [...ACTIVE_TICKET_STATUSES, 'resolved', 'closed'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const CATEGORIES = ['order', 'payment', 'delivery', 'return', 'refund', 'account', 'product', 'seller', 'other'];
const QUEUES = ['general', 'orders', 'payments', 'delivery', 'returns', 'accounts', 'seller'];

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function asFilter(value, allowed) {
  const text = String(value || '').trim();
  return allowed.includes(text) ? text : '';
}

function ticketFilters(query = {}) {
  return {
    search: String(query.ticketSearch || '').trim().slice(0, 80),
    status: asFilter(query.ticketStatus, TICKET_STATUSES),
    priority: asFilter(query.ticketPriority, PRIORITIES),
    category: asFilter(query.ticketCategory, CATEGORIES),
    queue: asFilter(query.ticketQueue, QUEUES),
    assignment: ['mine', 'unassigned'].includes(String(query.ticketAssignment || '')) ? String(query.ticketAssignment) : '',
    overdue: String(query.ticketOverdue || '') === '1',
  };
}

function filteredTicketScope(user, query = {}) {
  const scope = supportScope(user);
  const filters = ticketFilters(query);
  const clauses = [scope];
  if (filters.status) clauses.push({ status: filters.status });
  if (filters.priority) clauses.push({ priority: filters.priority });
  if (filters.category) clauses.push({ category: filters.category });
  if (filters.queue) clauses.push({ queue: filters.queue });
  if (filters.assignment === 'mine') clauses.push({ assignedUserId: user._id });
  if (filters.assignment === 'unassigned') clauses.push({ $or: [{ assignedUserId: null }, { assignedUserId: { $exists: false } }] });
  if (filters.overdue) clauses.push({ status: { $nin: ['resolved', 'closed'] }, slaDueAt: { $lt: new Date() } });
  if (filters.search) {
    const pattern = new RegExp(escapeRegex(filters.search), 'i');
    clauses.push({ $or: [{ publicId: pattern }, { subject: pattern }, { orderPublicId: pattern }, { requesterName: pattern }] });
  }
  return { filters, scope: clauses.length === 1 ? scope : { $and: clauses } };
}

function rowsToCounts(rows = []) {
  return Object.fromEntries(rows.map((row) => [String(row._id || 'unknown'), Number(row.count || 0)]));
}

async function customerLookup(user, query = {}) {
  const search = String(query.customerSearch || '').trim().slice(0, 100);
  if (search.length < 2) return [];
  const pattern = new RegExp(escapeRegex(search), 'i');
  const countryScope = supportScope(user);
  const users = await User.find({
    ...countryScope,
    role: 'customer',
    status: { $ne: 'deleted' },
    $or: [{ publicId: pattern }, { name: pattern }, { email: pattern }, { phone: pattern }],
  }).select('publicId name email phone country status createdAt').sort({ createdAt: -1 }).limit(20).lean();
  if (!users.length) return [];
  const ids = users.map((row) => row._id);
  const [orders, tickets] = await Promise.all([
    Order.aggregate([{ $match: { userId: { $in: ids } } }, { $group: { _id: '$userId', count: { $sum: 1 }, spendMinor: { $sum: '$totals.totalMinor' } } }]),
    SupportTicket.aggregate([{ $match: { userId: { $in: ids } } }, { $group: { _id: '$userId', count: { $sum: 1 }, open: { $sum: { $cond: [{ $in: ['$status', ACTIVE_TICKET_STATUSES] }, 1, 0] } } } }]),
  ]);
  const orderMap = new Map(orders.map((row) => [String(row._id), row]));
  const ticketMap = new Map(tickets.map((row) => [String(row._id), row]));
  return users.map((row) => ({ ...row, orderSummary: orderMap.get(String(row._id)) || { count: 0, spendMinor: 0 }, ticketSummary: ticketMap.get(String(row._id)) || { count: 0, open: 0 } }));
}

async function orderLookup(user, query = {}) {
  const search = String(query.orderSearch || '').trim().slice(0, 100);
  const countryScope = supportScope(user);
  const base = { ...countryScope };
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    base.$or = [{ publicId: pattern }, { 'contact.fullName': pattern }, { 'contact.email': pattern }, { 'contact.phone': pattern }];
  }
  return Order.find(base)
    .select('publicId userId country status paymentState fulfillmentState cancellationState returnState refundState contact totals createdAt updatedAt')
    .sort({ createdAt: -1 }).limit(search ? 40 : 25).lean();
}

export async function loadSupportDashboard(request) {
  const user = request.user;
  const scope = supportScope(user);
  const { filters, scope: filteredTickets } = filteredTicketScope(user, request.query || {});
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
  const canTrust = hasPermission(user, 'trust:manage') || hasPermission(user, 'catalogue:moderate') || user?.role === 'super_admin';

  const [
    tickets,
    ticketTotal,
    openCount,
    mineCount,
    overdueCount,
    escalatedCount,
    waitingCount,
    returns,
    disputes,
    reviews,
    macros,
    surveys,
    customerResults,
    orders,
    statusCounts,
    queueCounts,
    categoryCounts,
    priorityCounts,
    csatSummary,
    created30d,
    resolved30d,
  ] = await Promise.all([
    SupportTicket.find(filteredTickets).select('publicId userId requesterName requesterEmailMasked orderPublicId country category subject status priority queue slaDueAt assignedUserId createdAt updatedAt').populate('assignedUserId', 'publicId name email').sort({ slaDueAt: 1 }).limit(60).lean(),
    SupportTicket.countDocuments(filteredTickets),
    SupportTicket.countDocuments({ ...scope, status: { $in: ACTIVE_TICKET_STATUSES } }),
    SupportTicket.countDocuments({ ...scope, status: { $in: ACTIVE_TICKET_STATUSES }, assignedUserId: user._id }),
    SupportTicket.countDocuments({ ...scope, status: { $in: ACTIVE_TICKET_STATUSES }, slaDueAt: { $lt: now } }),
    SupportTicket.countDocuments({ ...scope, status: 'escalated' }),
    SupportTicket.countDocuments({ ...scope, status: 'waiting_customer' }),
    ReturnRequest.find(scope).select('publicId orderPublicId userId country status reason resolution returnMethod eligibleUntil inspection refundPublicId replacementOrderPublicId items createdAt updatedAt').sort({ createdAt: -1 }).limit(50).lean(),
    Dispute.find(scope).select('publicId userId orderPublicId country category status subject priority assignedUserId resolvedAt createdAt updatedAt').sort({ createdAt: -1 }).limit(50).lean(),
    Review.find({ ...scope, status: { $in: ['pending', 'disputed'] } }).select('publicId orderPublicId productPublicId country rating title body status disputeReason moderationReason createdAt disputedAt').sort({ createdAt: -1 }).limit(50).lean(),
    SupportMacro.find({ ...scope, active: true }).select('publicId country title body category updatedAt').sort({ updatedAt: -1 }).limit(50).lean(),
    SatisfactionSurvey.find(scope).select('publicId ticketPublicId country rating comment createdAt').sort({ createdAt: -1 }).limit(50).lean(),
    customerLookup(user, request.query || {}),
    orderLookup(user, request.query || {}),
    SupportTicket.aggregate([{ $match: scope }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    SupportTicket.aggregate([{ $match: scope }, { $group: { _id: '$queue', count: { $sum: 1 } } }]),
    SupportTicket.aggregate([{ $match: scope }, { $group: { _id: '$category', count: { $sum: 1 } } }]),
    SupportTicket.aggregate([{ $match: scope }, { $group: { _id: '$priority', count: { $sum: 1 } } }]),
    SatisfactionSurvey.aggregate([{ $match: scope }, { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } }]),
    SupportTicket.countDocuments({ ...scope, createdAt: { $gte: thirtyDaysAgo } }),
    SupportTicket.countDocuments({ ...scope, resolvedAt: { $gte: thirtyDaysAgo } }),
  ]);

  const returnOrderIds = [...new Set(returns.map((row) => String(row.orderPublicId || '').trim()).filter(Boolean))];
  const returnOrderRows = returnOrderIds.length
    ? await Order.find({ ...scope, publicId: { $in: returnOrderIds } }).select('publicId totals.currency').lean()
    : [];
  const returnCurrencyByOrder = new Map(returnOrderRows.map((row) => [String(row.publicId), String(row.totals?.currency || '')]));
  const returnRows = returns.map((row) => ({ ...row, currency:returnCurrencyByOrder.get(String(row.orderPublicId)) || '' }));

  const csat = csatSummary[0] || { average: 0, count: 0 };
  const resolvedOrClosed = tickets.filter((ticket) => ['resolved', 'closed'].includes(ticket.status)).length;
  const activeWithSla = tickets.filter((ticket) => ACTIVE_TICKET_STATUSES.includes(ticket.status));
  const withinSla = activeWithSla.filter((ticket) => new Date(ticket.slaDueAt).getTime() >= now.getTime()).length;
  const slaCompliance = activeWithSla.length ? Math.round((withinSla / activeWithSla.length) * 100) : 100;

  return {
    user: { publicId: user.publicId, name: user.name, email: user.email, role: user.role, country: user.country, preferences: user.preferences?.dashboard || {} },
    operationalCountries: operationalCountriesFor(user),
    filters,
    lookups: { customerSearch: String(request.query?.customerSearch || '').trim().slice(0, 100), orderSearch: String(request.query?.orderSearch || '').trim().slice(0, 100) },
    summary: {
      openCount,
      mineCount,
      overdueCount,
      escalatedCount,
      waitingCount,
      ticketTotal,
      csatAverage: Number(csat.average || 0),
      csatCount: Number(csat.count || 0),
      created30d,
      resolved30d,
      resolvedVisible: resolvedOrClosed,
      slaCompliance,
    },
    tickets,
    returns,
    disputes,
    reviews,
    macros,
    surveys,
    customers: customerResults,
    orders,
    reports: {
      statusCounts: rowsToCounts(statusCounts),
      queueCounts: rowsToCounts(queueCounts),
      categoryCounts: rowsToCounts(categoryCounts),
      priorityCounts: rowsToCounts(priorityCounts),
    },
    can: { canTrust },
  };
}

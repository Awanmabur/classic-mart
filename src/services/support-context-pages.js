import { strongMfaFence } from './mfa-policy.js';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { formatMinorUnits } from './catalogue.js';
import { writeAudit } from './audit.js';
import { queueSupportAlert } from './support-notifications.js';
import { cursorScope, cursorSort, decodeCursor, pageResult } from './pagination.js';
import { assertSupportReadAccess, fenceSupportAccess, supportAccess, supportPublicContext } from './support-workspace-access.js';
import { env } from '../config/env.js';
import { Notification, Order, PaymentIntent, PlatformGrant, Refund, ReturnRequest, Review, Shipment, SupportTicket, TrustCase, User } from '../models/index.js';

const SIZE = 25;
const ACTIVE_CASES = ['open', 'in_progress', 'waiting_customer', 'escalated'];
const PAGE_PATHS = { 'support-customers': '/support/customers', 'support-orders': '/support/orders', 'support-reviews': '/support/reviews' };
const REVIEW_STATES = ['all', 'pending', 'published', 'rejected', 'disputed'];
const ORDER_STATES = ['all', 'pending_payment', 'payment_failed', 'confirmed', 'paid', 'cancellation_pending', 'cancelled', 'expired', 'partially_refunded', 'refunded'];
const recordId = z.string().trim().min(4).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const version = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const iso = value => value ? new Date(value).toISOString() : '';
const label = value => String(value || '').replaceAll('_', ' ');
const regex = value => new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const marketCodes = context => context.country ? [context.country] : context.countries.map(row => row.code);
const money = (value, currency) => formatMinorUnits(value || 0, currency || 'UGX', 'en');

export function supportMaskedEmail(value = '') {
  const [local, domain] = String(value).trim().split('@');
  return local && domain ? local.slice(0, 1) + '***@' + domain : '';
}
export function supportMaskedPhone(value = '') {
  const phone = String(value);
  return phone ? '•••• ' + phone.slice(-3) : '';
}

function filters(request, pageId) {
  const values = z.object({ country: z.string().max(2).optional(), search: z.string().trim().max(100).default(''), q: z.string().trim().max(100).optional(),
    status: z.string().max(40).default('all'), record: recordId.optional(), after: z.string().max(512).default('') }).parse(request.query || {});
  values.search = values.q ?? values.search;
  const states = pageId === 'support-reviews' ? REVIEW_STATES : pageId === 'support-orders' ? ORDER_STATES : ['all', 'active', 'suspended', 'pending_deletion', 'deleted'];
  if (!states.includes(values.status)) throw new AppError('Select a supported record status.', 422, 'SUPPORT_FILTER_INVALID');
  if (values.after && !decodeCursor(values.after)) throw new AppError('The support record cursor is invalid.', 422, 'SUPPORT_FILTER_INVALID');
  if (pageId === 'support-customers' && values.search && values.search.length < 3) throw new AppError('Enter at least three characters to find a customer.', 422, 'SUPPORT_LOOKUP_TOO_SHORT');
  return { ...values, states };
}

function customerPipeline(context, query) {
  if (!query.search && !query.record) return [{ $match: { _id: null } }];
  const where = {};
  if (query.record) where.publicId = query.record;
  if (query.status !== 'all') where.status = query.status;
  if (query.search) {
    // Exact contact and public ID lookups use existing unique indexes. Name
    // matching remains a deliberate, minimum-three-character masked lookup.
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query.search)) where.emailNormalized = query.search.toLowerCase();
    else if (/^\+[1-9]\d{7,14}$/.test(query.search)) where.phoneNormalized = query.search;
    else if (/^usr_[a-zA-Z0-9_-]+$/.test(query.search)) where.publicId = query.search;
    else where.$or = [{ publicId: regex(query.search) }, { name: regex(query.search) }];
  }
  const countryCodes = marketCodes(context);
  return [{ $match: where },
    { $lookup: { from: Order.collection.name, localField: '_id', foreignField: 'userId', as: 'scopedOrders', pipeline: [{ $match: { country: { $in: countryCodes } } }, { $count: 'count' }] } },
    { $lookup: { from: SupportTicket.collection.name, localField: '_id', foreignField: 'userId', as: 'scopedTickets', pipeline: [{ $match: { country: { $in: countryCodes } } }, { $count: 'count' }] } },
    { $match: { $or: [{ country: { $in: countryCodes } }, { 'scopedOrders.0': { $exists: true } }, { 'scopedTickets.0': { $exists: true } }] } },
    { $project: { publicId: 1, name: 1, status: 1, email: 1, phone: 1, createdAt: 1, orderCount: { $ifNull: [{ $first: '$scopedOrders.count' }, 0] }, ticketCount: { $ifNull: [{ $first: '$scopedTickets.count' }, 0] } } }];
}

function orderPipeline(context, query) {
  const where = { ...context.countryScope };
  if (query.record) where.publicId = query.record;
  if (query.status !== 'all') where.status = query.status;
  if (query.search) where.$or = [{ publicId: regex(query.search) }, { 'items.title': regex(query.search) }];
  return [{ $match: where }, { $project: { publicId: 1, country: 1, status: 1, paymentState: 1, fulfillmentState: 1, cancellationState: 1, returnState: 1,
    refundState: 1, paymentMethod: 1, deliveryMethod: 1, totals: 1, createdAt: 1, updatedAt: 1, __v: 1 } }];
}
function reviewPipeline(context, query) {
  const where = { ...context.countryScope };
  if (query.record) where.publicId = query.record;
  if (query.status !== 'all') where.status = query.status;
  if (query.search) where.$or = ['publicId', 'orderPublicId', 'productPublicId', 'title', 'body'].map(field => ({ [field]: regex(query.search) }));
  return [{ $match: where }, { $lookup: { from: Order.collection.name, localField: 'orderId', foreignField: '_id', as: 'linkedOrder',
    pipeline: [{ $match: context.countryScope }, { $project: { publicId: 1, country: 1, userId: 1 } }] } }, { $unwind: '$linkedOrder' },
    { $match: { $expr: { $and: [{ $eq: ['$orderPublicId', '$linkedOrder.publicId'] }, { $eq: ['$country', '$linkedOrder.country'] }, { $eq: ['$userId', '$linkedOrder.userId'] }] } } },
    { $project: { publicId: 1, country: 1, orderPublicId: 1, productPublicId: 1, rating: 1, title: 1, body: 1, verifiedPurchase: 1,
    status: 1, disputeReason: 1, moderationReason: 1, publishedAt: 1, createdAt: 1, updatedAt: 1, __v: 1, orderId: 1 } }];
}
function sourceFor(pageId, context, query) {
  if (pageId === 'support-customers') return { Model: User, pipeline: customerPipeline(context, query), columns: ['Customer', 'Name', 'Contact', 'Account', 'Scoped orders', 'Scoped cases'],
    map: row => ({ publicId: row.publicId, name: row.name, status: row.status, emailMasked: supportMaskedEmail(row.email), phoneMasked: supportMaskedPhone(row.phone),
      orderCount: row.orderCount, ticketCount: row.ticketCount, createdAt: row.createdAt }), cells: row => [row.publicId, row.name, row.emailMasked + (row.phoneMasked ? ' · ' + row.phoneMasked : ''), label(row.status), row.orderCount, row.ticketCount],
    headers: ['Customer', 'Name', 'Masked email', 'Masked phone', 'Account status', 'Scoped orders', 'Scoped cases', 'Registered'],
    csv: row => [row.publicId, row.name, supportMaskedEmail(row.email), supportMaskedPhone(row.phone), row.status, row.orderCount, row.ticketCount, iso(row.createdAt)] };
  if (pageId === 'support-orders') return { Model: Order, pipeline: orderPipeline(context, query), columns: ['Order', 'Country', 'Total', 'Payment', 'Fulfilment', 'Status'],
    map: row => ({ publicId: row.publicId, country: row.country, currency: row.totals.currency, totalMinor: row.totals.totalMinor, status: row.status, paymentState: row.paymentState,
      fulfillmentState: row.fulfillmentState, cancellationState: row.cancellationState, returnState: row.returnState, refundState: row.refundState, paymentMethod: row.paymentMethod,
      deliveryMethod: row.deliveryMethod, createdAt: row.createdAt, updatedAt: row.updatedAt, version: row.__v || 0 }),
    cells: row => [row.publicId, row.country, money(row.totalMinor, row.currency), label(row.paymentState), label(row.fulfillmentState), label(row.status)],
    headers: ['Order', 'Country', 'Currency', 'Total minor', 'Payment', 'Fulfilment', 'Cancellation', 'Return', 'Refund', 'Status', 'Created'],
    csv: row => [row.publicId, row.country, row.totals.currency, row.totals.totalMinor, row.paymentState, row.fulfillmentState, row.cancellationState, row.returnState, row.refundState, row.status, iso(row.createdAt)] };
  return { Model: Review, pipeline: reviewPipeline(context, query), columns: ['Review', 'Order', 'Country', 'Rating', 'Product', 'Moderation'],
    map: row => ({ publicId: row.publicId, country: row.country, orderPublicId: row.orderPublicId, productPublicId: row.productPublicId, rating: row.rating,
      title: row.title, body: row.body, verifiedPurchase: row.verifiedPurchase, status: row.status, disputeReason: row.disputeReason, moderationReason: row.moderationReason,
      publishedAt: row.publishedAt, createdAt: row.createdAt, updatedAt: row.updatedAt, version: row.__v || 0 }),
    cells: row => [row.publicId, row.orderPublicId, row.country, row.rating + '/5', row.productPublicId, label(row.status)],
    headers: ['Review', 'Country', 'Order', 'Product', 'Rating', 'Verified purchase', 'Moderation status', 'Created'],
    csv: row => [row.publicId, row.country, row.orderPublicId, row.productPublicId, row.rating, row.verifiedPurchase, row.status, iso(row.createdAt)] };
}

async function selectedCustomer(request, context, id) {
  const source = sourceFor('support-customers', context, { record: id, search: '', status: 'all' });
  const [record] = await User.aggregate(source.pipeline);
  if (!record) throw new AppError('Customer not found within your Support scope.', 404, 'SUPPORT_CUSTOMER_NOT_FOUND');
  const [orders, cases] = await Promise.all([
    Order.find({ userId: record._id, ...context.countryScope }).select('publicId country status paymentState fulfillmentState totals.currency totals.totalMinor createdAt').sort(cursorSort()).limit(10).lean(),
    SupportTicket.find({ userId: record._id, ...context.countryScope }).select('publicId country orderPublicId status subject category assignedUserId __v createdAt').sort(cursorSort()).limit(10).lean(),
  ]);
  return { ...source.map(record), orders: orders.map(row => ({ publicId: row.publicId, country: row.country, status: row.status, paymentState: row.paymentState,
    fulfillmentState: row.fulfillmentState, currency: row.totals.currency, totalMinor: row.totals.totalMinor, createdAt: row.createdAt })),
    cases: cases.map(row => ({ publicId: row.publicId, country: row.country, orderPublicId: row.orderPublicId || '', status: row.status, subject: row.subject,
      category: row.category, version: row.__v || 0, canRevealContact: ACTIVE_CASES.includes(row.status) && String(row.assignedUserId || '') === String(context.actor._id) })) };
}
async function selectedOrder(context, id) {
  const order = await Order.findOne({ publicId: id, ...context.countryScope }).select('publicId userId country status paymentState fulfillmentState cancellationState returnState refundState paymentMethod deliveryMethod totals items.linePublicId items.title items.quantity items.deliveredQuantity items.returnedQuantity items.refundedQuantity items.currency items.lineTotalMinor createdAt updatedAt __v').lean();
  if (!order) throw new AppError('Order not found within your Support scope.', 404, 'ORDER_NOT_FOUND');
  const [payments, shipments, returns, refunds, cases] = await Promise.all([
    PaymentIntent.find({ orderId: order._id, orderPublicId: order.publicId, country: order.country, currency: order.totals.currency }).select('publicId provider status amountMinor refundedMinor currency paidAt lastVerifiedAt __v').sort(cursorSort()).limit(20).lean(),
    Shipment.find({ orderId: order._id, orderPublicId: order.publicId, country: order.country }).select('publicId kind status mode assignedAt pickedUpAt deliveredAt slaDueAt createdAt __v').sort(cursorSort()).limit(20).lean(),
    ReturnRequest.find({ orderId: order._id, orderPublicId: order.publicId, userId: order.userId, country: order.country }).select('publicId status reason resolution refundPublicId createdAt __v').sort(cursorSort()).limit(20).lean(),
    Refund.find({ orderId: order._id, currency: order.totals.currency }).select('publicId paymentIntentId status amountMinor currency completedAt createdAt __v').sort(cursorSort()).limit(20).lean(),
    SupportTicket.find({ orderId: order._id, orderPublicId: order.publicId, country: order.country }).select('publicId status subject category createdAt __v').sort(cursorSort()).limit(10).lean(),
  ]);
  const paymentIds = new Set(payments.map(row => String(row._id)));
  return { ...sourceFor('support-orders', context, {}).map(order), customerPublicId: order.userId ? (await User.findById(order.userId).select('publicId').lean())?.publicId || '' : '',
    canCreateCase: Boolean(order.userId), items: order.items.map(row => ({ linePublicId: row.linePublicId, title: row.title, quantity: row.quantity, deliveredQuantity: row.deliveredQuantity,
      returnedQuantity: row.returnedQuantity, refundedQuantity: row.refundedQuantity, currency: row.currency, lineTotalMinor: row.lineTotalMinor })),
    payments: payments.map(row => ({ publicId: row.publicId, provider: row.provider, status: row.status, amountMinor: row.amountMinor, refundedMinor: row.refundedMinor, currency: row.currency,
      paidAt: row.paidAt, lastVerifiedAt: row.lastVerifiedAt, version: row.__v || 0 })),
    shipments: shipments.map(row => ({ publicId: row.publicId, kind: row.kind, status: row.status, mode: row.mode, assignedAt: row.assignedAt, pickedUpAt: row.pickedUpAt,
      deliveredAt: row.deliveredAt, slaDueAt: row.slaDueAt, version: row.__v || 0 })),
    returns: returns.map(row => ({ publicId: row.publicId, status: row.status, reason: row.reason, resolution: row.resolution, refundPublicId: row.refundPublicId || '', version: row.__v || 0 })),
    refunds: refunds.filter(row => paymentIds.has(String(row.paymentIntentId))).map(row => ({ publicId: row.publicId, status: row.status, amountMinor: row.amountMinor, currency: row.currency, completedAt: row.completedAt, version: row.__v || 0 })),
    cases: cases.map(row => ({ publicId: row.publicId, subject: row.subject, status: row.status, category: row.category, version: row.__v || 0 })) };
}
async function selectedReview(context, id) {
  const [review] = await Review.aggregate(reviewPipeline(context, { record: id, status: 'all', search: '' }));
  if (!review) throw new AppError('Review not found within your Support scope.', 404, 'REVIEW_NOT_FOUND');
  const linked = await TrustCase.findOne({ reviewId: review._id, reviewPublicId: review.publicId, country: review.country }).select('publicId status description supportTicketPublicId decision createdAt updatedAt').lean();
  const cases = await SupportTicket.find({ orderId: review.orderId, orderPublicId: review.orderPublicId, country: review.country, assignedUserId: context.actor._id,
    status: mongoose.trusted({ $in: ACTIVE_CASES }) }).select('publicId subject status __v').sort(cursorSort()).limit(20).lean();
  return { ...sourceFor('support-reviews', context, {}).map(review), issue: linked ? { publicId: linked.publicId, status: linked.status, description: linked.description,
    ticketPublicId: linked.supportTicketPublicId || '', decision: linked.decision || '', createdAt: linked.createdAt, updatedAt: linked.updatedAt } : null,
    cases: cases.map(row => ({ publicId: row.publicId, subject: row.subject, status: row.status, version: row.__v || 0 })) };
}

export async function loadSupportContextPage(request, pageId) {
  if (!PAGE_PATHS[pageId]) throw new AppError('Support context page not found.', 404, 'SUPPORT_PAGE_NOT_FOUND');
  const context = await supportAccess(request), query = filters(request, pageId), source = sourceFor(pageId, context, { ...query, record: undefined });
  const [result] = await source.Model.aggregate([...source.pipeline, { $facet: { items: [{ $match: cursorScope({}, query.after) }, { $sort: cursorSort() }, { $limit: SIZE + 1 }], total: [{ $count: 'count' }] } }]);
  const paged = pageResult(result?.items || [], { limit: SIZE, total: result?.total?.[0]?.count || 0 }), items = paged.items.map(source.map);
  const [openCases, overdueCases, issueCount, selected] = await Promise.all([
    SupportTicket.countDocuments({ ...context.countryScope, status: mongoose.trusted({ $in: ACTIVE_CASES }) }),
    SupportTicket.countDocuments({ ...context.countryScope, status: mongoose.trusted({ $in: ACTIVE_CASES }), slaDueAt: mongoose.trusted({ $lt: new Date() }) }),
    TrustCase.countDocuments({ ...context.countryScope, reviewId: mongoose.trusted({ $exists: true }), status: mongoose.trusted({ $in: ['open', 'investigating', 'appealed'] }) }),
    query.record ? pageId === 'support-customers' ? selectedCustomer(request, context, query.record) : pageId === 'support-orders' ? selectedOrder(context, query.record) : selectedReview(context, query.record) : null,
  ]);
  const base = PAGE_PATHS[pageId], selectedKey = pageId === 'support-customers' ? 'selectedCustomer' : pageId === 'support-orders' ? 'selectedOrder' : 'selectedReview';
  await assertSupportReadAccess(request, context);
  return { kind: 'context', pageId, context: supportPublicContext(context), country: context.country, columns: source.columns, items,
    rows: items.map(row => ({ id: row.publicId, href: base + '?' + new URLSearchParams({ record: row.publicId, country: context.country }), cells: source.cells(row) })),
    page: paged.page, [selectedKey]: selected, selected, lookupRequired: pageId === 'support-customers' && !query.search,
    metrics: [{ label: pageId === 'support-customers' ? 'Matching customers' : pageId === 'support-orders' ? 'Matching orders' : 'Matching reviews', value: String(paged.page.total), detail: 'Full count for this scope and filter' },
      { label: 'Active support cases', value: String(openCases), detail: 'Open cases in your current scope' },
      { label: 'Overdue cases', value: String(overdueCases), detail: 'Active cases past their recorded SLA' },
      { label: 'Review escalations', value: String(issueCount), detail: 'Open recorded moderation cases' }],
    filters: { search: query.search, status: query.status, after: query.after, statuses: query.states.map(value => ({ value, label: label(value) })), params: { country: context.country } },
    tableTitle: pageId === 'support-customers' ? 'Customer lookup results' : pageId === 'support-orders' ? 'Order support records' : 'Review issues',
    tableDescription: pageId === 'support-customers' ? 'Search at least three characters. Contact details remain masked until a linked assigned case authorizes disclosure.' : 'Current records within your assigned Support countries.',
    emptyText: pageId === 'support-customers' && !query.search ? 'Enter a customer name, customer ID, exact email or full phone number to search.' : 'No records match this view.',
    insights: [{ text: 'Customer information is limited to the case and countries you currently handle.', href: '/support/queue', label: 'Open ticket queue' }],
    workflow: [{ title: 'Review order context', text: 'Investigate recorded payment and fulfilment states before responding.', href: '/support/orders', label: 'Order help' },
      { title: 'Handle customer support', text: 'Create a staff initiated case for an actual order owner; use the queue for case communication.', href: '/support/queue', label: 'Ticket queue' },
      { title: 'Escalate review concerns', text: 'Send documented concerns to moderation while keeping its decisions separate.', href: '/support/reviews', label: 'Review issues' }],
    exportHref: base + '/export.csv?' + new URLSearchParams({ country: context.country, search: query.search, status: query.status }) };
}

async function transaction(work) {
  const session = await mongoose.startSession();
  try { let result; await session.withTransaction(async () => { result = await work(session); }); return result; }
  finally { await session.endSession(); }
}
const conflict = () => new AppError('This record changed. Reload before continuing.', 409, 'SUPPORT_CONTEXT_VERSION_CONFLICT');

/** Contact access is tied to its active case, requester and optional recorded order. */
export async function assertSupportContactDisclosure(request, originalContext, disclosure) {
  const context = await assertSupportReadAccess(request, originalContext);
  if (!disclosure || !recordId.safeParse(disclosure.customerPublicId).success
    || !recordId.safeParse(disclosure.ticketPublicId).success || !Number.isSafeInteger(disclosure.ticketVersion)) {
    throw new AppError('The case contact authorization changed. Reload before continuing.', 409, 'SUPPORT_CONTACT_CASE_CHANGED');
  }
  const [retained] = await SupportTicket.aggregate([
    { $match: { publicId: disclosure.ticketPublicId, ...context.countryScope, assignedUserId: context.actor._id,
      status: { $in: ACTIVE_CASES }, __v: disclosure.ticketVersion } },
    { $lookup: { from: User.collection.name, localField: 'userId', foreignField: '_id', as: 'requester', pipeline: [
      { $match: { publicId: disclosure.customerPublicId, status: 'active', email: disclosure.email, phone: disclosure.phone } },
      { $project: { _id: 1 } },
    ] } },
    { $match: { 'requester.0': { $exists: true } } },
    { $lookup: { from: Order.collection.name, localField: 'orderId', foreignField: '_id', as: 'linkedOrder', pipeline: [
      { $project: { publicId: 1, country: 1, userId: 1 } },
    ] } },
    { $match: { $expr: { $cond: [
      { $eq: [{ $ifNull: ['$orderId', null] }, null] },
      { $in: [{ $ifNull: ['$orderPublicId', ''] }, ['', null]] },
      { $and: [{ $eq: [{ $size: '$linkedOrder' }, 1] },
        { $eq: ['$orderPublicId', { $first: '$linkedOrder.publicId' }] },
        { $eq: ['$country', { $first: '$linkedOrder.country' }] },
        { $eq: ['$userId', { $first: '$linkedOrder.userId' }] }] },
    ] } } },
    { $project: { _id: 1 } }, { $limit: 1 },
  ]);
  if (!retained) throw new AppError('The case contact authorization changed. Reload before continuing.', 409, 'SUPPORT_CONTACT_CASE_CHANGED');
}

export async function revealSupportCustomerContact(request, customerId, input) {
  recordId.parse(customerId);
  const values = z.object({ ticketId: recordId, version, reason: z.string().trim().min(10).max(500) }).parse(input);
  let originalContext;
  const result = await transaction(async session => {
    const context = await supportAccess(request, { session });
    originalContext = context;
    const customer = await User.findOne({ publicId: customerId }).select('publicId name email phone status __v').session(session);
    if (!customer) throw new AppError('Customer not found.', 404, 'SUPPORT_CUSTOMER_NOT_FOUND');
    if (customer.status !== 'active') throw new AppError('The customer account is unavailable for contact access.', 409, 'SUPPORT_CUSTOMER_UNAVAILABLE');
    const ticket = await SupportTicket.findOne({ publicId: values.ticketId, userId: customer._id, ...context.countryScope, status: mongoose.trusted({ $in: ACTIVE_CASES }), assignedUserId: context.actor._id }).session(session);
    if (!ticket) throw new AppError('An active case assigned to you and linked to this customer is required.', 403, 'SUPPORT_CONTACT_CASE_REQUIRED');
    if ((ticket.__v || 0) !== values.version) throw conflict();
    const order = ticket.orderId ? await Order.findOne({ _id: ticket.orderId, publicId: ticket.orderPublicId, userId: customer._id, country: ticket.country })
      .select('publicId userId country __v').session(session) : null;
    if ((ticket.orderId && !order) || (!ticket.orderId && ticket.orderPublicId)) {
      throw new AppError('The case requester and order linkage changed. Reload before continuing.', 409, 'SUPPORT_CONTACT_CASE_CHANGED');
    }
    await fenceSupportAccess(context, session);
    const customerVersion = String(customer._id) === String(context.actor._id) ? context.actorVersion : customer.__v || 0;
    const customerFenced = await User.updateOne({ _id: customer._id, status: 'active', email: customer.email, phone: customer.phone, __v: customerVersion }, { $inc: { __v: 1 } }, { session });
    if (customerFenced.modifiedCount !== 1) throw new AppError('The customer account changed. Reload before contact access.', 409, 'SUPPORT_CUSTOMER_UNAVAILABLE');
    if (order) {
      const orderFenced = await Order.updateOne({ _id: order._id, publicId: ticket.orderPublicId, userId: customer._id, country: ticket.country, __v: order.__v || 0 }, { $inc: { __v: 1 } }, { session });
      if (orderFenced.modifiedCount !== 1) throw new AppError('The case requester and order linkage changed. Reload before continuing.', 409, 'SUPPORT_CONTACT_CASE_CHANGED');
    }
    const fenced = await SupportTicket.updateOne({ _id: ticket._id, userId: customer._id, country: ticket.country, assignedUserId: context.actor._id, status: ticket.status, __v: values.version }, { $inc: { __v: 1 } }, { session });
    if (fenced.modifiedCount !== 1) throw conflict();
    await writeAudit(request, 'support.customer_contact_disclosed', { session, actor: context.actor, targetType: 'support_ticket', targetPublicId: ticket.publicId, country: ticket.country,
      metadata: { customerPublicId: customer.publicId, purpose: values.reason, disclosedFields: ['email', 'phone'] } });
    return { customerPublicId: customer.publicId, ticketPublicId: ticket.publicId, email: customer.email, phone: customer.phone, ticketVersion: values.version + 1 };
  });
  await assertSupportContactDisclosure(request, originalContext, result);
  return result;
}

export async function createSupportOrderCase(request, orderId, input) {
  recordId.parse(orderId);
  const values = z.object({ version, subject: z.string().trim().min(3).max(180), message: z.string().trim().min(10).max(2000),
    category: z.enum(['order', 'payment', 'delivery', 'return', 'refund', 'other']), priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal') }).parse(input);
  return transaction(async session => {
    const context = await supportAccess(request, { session });
    const order = await Order.findOne({ publicId: orderId, ...context.countryScope }).session(session);
    if (!order) throw new AppError('Order not found within your Support scope.', 404, 'ORDER_NOT_FOUND');
    if (!order.userId) throw new AppError('Use the guest customer intake flow to verify a guest requester.', 409, 'SUPPORT_GUEST_IDENTITY_REQUIRED');
    if ((order.__v || 0) !== values.version) throw conflict();
    const owner = await User.findById(order.userId).select('publicId name status __v').session(session);
    if (!owner || owner.status !== 'active') throw new AppError('The order owner is unavailable for a new case.', 409, 'SUPPORT_CUSTOMER_UNAVAILABLE');
    const duplicate = await SupportTicket.findOne({ orderId: order._id, userId: owner._id, country: order.country, category: values.category, status: mongoose.trusted({ $in: ACTIVE_CASES }) }).session(session).lean();
    if (duplicate) throw new AppError(`Use the active case ${duplicate.publicId} for this order and category.`, 409, 'SUPPORT_DUPLICATE');
    await fenceSupportAccess(context, session);
    const locked = await Order.updateOne({ _id: order._id, userId: owner._id, country: order.country, __v: values.version }, { $inc: { __v: 1 } }, { session });
    if (locked.modifiedCount !== 1) throw conflict();
    const customerLocked = await User.updateOne({ _id: owner._id, status: 'active', __v: owner.__v || 0 }, { $inc: { __v: 1 } }, { session });
    if (customerLocked.modifiedCount !== 1) throw new AppError('The order owner changed. Reload before opening a case.', 409, 'SUPPORT_CUSTOMER_UNAVAILABLE');
    const hours = values.priority === 'urgent' ? 4 : values.priority === 'high' ? 12 : 48;
    const queues = { order: 'orders', payment: 'payments', refund: 'payments', delivery: 'delivery', return: 'returns', other: 'general' };
    const [ticket] = await SupportTicket.create([{ publicId: publicId('tkt'), userId: owner._id, orderId: order._id, orderPublicId: order.publicId, country: order.country,
      createdByUserId: context.actor._id, source: 'staff', category: values.category, subject: values.subject, priority: values.priority, queue: queues[values.category],
      slaDueAt: new Date(Date.now() + hours * 3600_000), assignedUserId: context.actor._id, assignedAt: new Date(),
      notes: [{ message: values.message, actorUserId: context.actor._id, internal: true }],
      assignmentHistory: [{ action: 'claim', actorUserId: context.actor._id, assignedUserId: context.actor._id }],
      workflowHistory: [{ action: 'created', actorUserId: context.actor._id, toStatus: 'open', note: 'Staff initiated support case for the recorded order owner.' }] }], { session });
    await Notification.create([{ publicId: publicId('ntf'), userId: owner._id, country: order.country, type: 'support_case_created', title: 'Support case opened for your order',
      body: `Our support team opened case ${ticket.publicId} for order ${order.publicId}. Open your support page to follow the case.`, href: '/support', importance: 'normal' }], { session });
    await writeAudit(request, 'support.order_case_created', { session, actor: context.actor, targetType: 'support_ticket', targetPublicId: ticket.publicId, country: order.country,
      metadata: { orderPublicId: order.publicId, requesterPublicId: owner.publicId, category: ticket.category, staffInitiated: true } });
    await queueSupportAlert({ country: order.country, kind: 'priority', href: '/support/queue?record=' + ticket.publicId }, session);
    return { publicId: ticket.publicId, orderPublicId: order.publicId, status: ticket.status, country: ticket.country, version: ticket.__v || 0 };
  });
}

export async function escalateSupportReview(request, reviewId, input) {
  recordId.parse(reviewId);
  const values = z.object({ version, description: z.string().trim().min(10).max(2000), ticketId: recordId }).parse(input);
  return transaction(async session => {
    const context = await supportAccess(request, { session });
    const review = await Review.findOne({ publicId: reviewId, ...context.countryScope }).session(session);
    if (!review) throw new AppError('Review not found within your Support scope.', 404, 'REVIEW_NOT_FOUND');
    if ((review.__v || 0) !== values.version) throw conflict();
    const order = await Order.findOne({ _id: review.orderId, publicId: review.orderPublicId, userId: review.userId, country: review.country }).select('publicId').session(session);
    if (!order) throw new AppError('The review order linkage needs moderation review.', 409, 'SUPPORT_REVIEW_LINKAGE_INVALID');
    const ticket = await SupportTicket.findOne({ publicId: values.ticketId, orderId: review.orderId, orderPublicId: review.orderPublicId, country: review.country,
      assignedUserId: context.actor._id, status: mongoose.trusted({ $in: ACTIVE_CASES }) }).session(session);
    if (!ticket) throw new AppError('An active case assigned to you and linked to the review order is required.', 403, 'SUPPORT_REVIEW_CASE_REQUIRED');
    const existing = await TrustCase.findOne({ reviewId: review._id }).session(session).lean();
    if (existing) throw new AppError(`This review is already linked to moderation case ${existing.publicId}.`, 409, 'SUPPORT_REVIEW_ALREADY_ESCALATED');
    await fenceSupportAccess(context, session);
    const locked = await Review.updateOne({ _id: review._id, country: review.country, status: review.status, __v: values.version }, { $inc: { __v: 1 } }, { session });
    if (locked.modifiedCount !== 1) throw conflict();
    const ticketLocked = await SupportTicket.updateOne({ _id: ticket._id, country: review.country, assignedUserId: context.actor._id, status: ticket.status, __v: ticket.__v || 0 }, { $inc: { __v: 1 } }, { session });
    if (ticketLocked.modifiedCount !== 1) throw conflict();
    const [issue] = await TrustCase.create([{ publicId: publicId('trc'), reporterUserId: context.actor._id, country: review.country, type: 'review_manipulation',
      productId: review.productId, productPublicId: review.productPublicId, reviewId: review._id, reviewPublicId: review.publicId, supportTicketId: ticket._id,
      supportTicketPublicId: ticket.publicId, reviewStatusSnapshot: review.status, reviewVersionSnapshot: values.version,
      description: `Review ${review.publicId}; order ${review.orderPublicId}; support case ${ticket.publicId}.\n${values.description}`.slice(0, 2500),
      evidenceDocumentIds: ticket.evidenceDocumentIds || [], status: 'open' }], { session });
    await SupportTicket.updateOne({ _id: ticket._id, __v: (ticket.__v || 0) + 1 }, { $push: { notes: { message: `Review ${review.publicId} referred to moderation case ${issue.publicId}.`, actorUserId: context.actor._id, internal: true } } }, { session });
    await writeAudit(request, 'support.review_escalated', { session, actor: context.actor, targetType: 'trust_case', targetPublicId: issue.publicId, country: review.country,
      metadata: { reviewPublicId: review.publicId, ticketPublicId: ticket.publicId, moderationStatus: review.status, evidenceCount: issue.evidenceDocumentIds.length } });
    await queueReviewModerationAlert(review.country, session);
    return { publicId: issue.publicId, status: issue.status, reviewPublicId: review.publicId, ticketPublicId: ticket.publicId, moderationStatus: review.status };
  });
}

async function queueReviewModerationAlert(country, session) {
  const now = new Date();
  const recipients = await User.aggregate([
    { $match: { status: 'active', emailVerifiedAt: { $type: 'date' }, onboardingCompletedAt: { $type: 'date' },
      ...(env.security.privilegedMfaRequired ? { $and: [strongMfaFence()] } : {}),
      $or: [{ role: { $in: ['moderator', 'country_admin', 'super_admin'] } }, { platformAccessManagedAt: { $type: 'date' } }] } },
    { $lookup: { from: PlatformGrant.collection.name, localField: '_id', foreignField: 'userId', as: 'currentGrants', pipeline: [
      { $match: { status: 'active', startsAt: { $lte: now }, expiresAt: { $gt: now } } }, { $project: { role: 1, operationalCountries: 1 } }] } },
    { $match: { $expr: { $cond: [{ $ne: [{ $ifNull: ['$platformAccessManagedAt', null] }, null] },
      { $and: [{ $eq: [{ $size: '$currentGrants' }, 1] }, { $in: [{ $first: '$currentGrants.role' }, ['moderator', 'country_admin', 'super_admin']] },
        { $or: [{ $in: [country, { $ifNull: [{ $first: '$currentGrants.operationalCountries' }, []] }] },
          { $and: [{ $eq: [{ $first: '$currentGrants.role' }, 'super_admin'] }, { $in: ['*', { $ifNull: [{ $first: '$currentGrants.operationalCountries' }, []] }] }] }] }] },
      { $or: [{ $eq: ['$role', 'super_admin'] }, { $and: [{ $in: ['$role', ['moderator', 'country_admin']] },
        { $in: [country, { $cond: [{ $gt: [{ $size: { $ifNull: ['$operationalCountries', []] } }, 0] }, '$operationalCountries', ['$country']] }] }] }] }] } } },
    { $project: { _id: 1 } },
  ]).session(session);
  if (recipients.length) await Notification.create(recipients.map(row => ({ publicId: publicId('ntf'), userId: row._id, country, type: 'support_review_escalated',
    title: 'Review concern referred to moderation', body: 'A scoped support case includes a documented review concern. Review the moderation queue for its evidence and decision history.',
    href: '/moderation', importance: 'high' })), { session });
}

export function supportContextCsvCell(value) {
  let text = String(value ?? '');
  if (/^[\s\uFEFF]*[=+\-@]/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export async function streamSupportContextCsv(request, response, pageId) {
  if (!PAGE_PATHS[pageId]) throw new AppError('Support export not found.', 404, 'SUPPORT_PAGE_NOT_FOUND');
  const context = await supportAccess(request), query = filters(request, pageId), source = sourceFor(pageId, context, { ...query, record: undefined });
  await writeAudit(request, 'support.context_exported', { actor: context.actor, targetType: 'support_context', targetPublicId: pageId, country: context.country || context.countries[0].code,
    metadata: { countries: marketCodes(context), recordType: pageId.replace('support-', '') } });
  await assertSupportReadAccess(request, context);
  response.set('Content-Type', 'text/csv; charset=utf-8'); response.set('Content-Disposition', `attachment; filename="classic-mart-${pageId}.csv"`);
  response.set('Cache-Control', 'private, no-store'); response.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  const line = async cells => { if (response.destroyed) throw new AppError('Export connection closed.', 499, 'EXPORT_CLOSED'); if (!response.write(cells.map(supportContextCsvCell).join(',') + '\r\n')) await waitForDrain(response); };
  const cursor = source.Model.aggregate([...source.pipeline, { $sort: cursorSort() }]).cursor({ batchSize: 100 });
  try { await line(source.headers); for await (const row of cursor) { await assertSupportReadAccess(request, context); await line(source.csv(row)); } }
  finally { await cursor.close(); }
  response.end();
}
function waitForDrain(response) {
  return new Promise((resolve, reject) => {
    const clean = () => { response.off('drain', drain); response.off('close', close); response.off('error', error); };
    const drain = () => { clean(); resolve(); }, close = () => { clean(); reject(new AppError('Export connection closed.', 499, 'EXPORT_CLOSED')); }, error = cause => { clean(); reject(cause); };
    response.once('drain', drain); response.once('close', close); response.once('error', error); if (response.destroyed) close();
  });
}

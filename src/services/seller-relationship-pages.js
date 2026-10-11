import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { env } from '../config/env.js';
import { User, Store, StoreMember, SellerOrder, Order, SellerReturnCase, ReturnRequest, Review, Product,
  SellerContactRequest, ProductQuestion, EvidenceDocument, Notification, CountrySetting } from '../models/index.js';
import { storeCapabilities } from './store.js';
import { cursorScope, cursorSort, pageResult } from './pagination.js';
import { formatMinorUnits } from './catalogue.js';
import { writeAudit } from './audit.js';
import { addOutboxEvent } from './outbox.js';
import { sanitizeAndStoreEvidenceImage } from './media.js';

const idInput = z.string().trim().regex(/^[a-z][a-z0-9_-]{4,99}$/, 'Choose a valid record.');
const versionInput = z.union([z.number(), z.string().regex(/^\d+$/)]).pipe(z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER));
const same = (a, b) => String(a) === String(b);
const human = value => String(value || '').replaceAll('_', ' ').replace(/\b\w/g, value => value.toUpperCase());
const escaped = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const localDate = (value, timeZone) => value ? new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone }) : '—';
const money = (value, store, request) => formatMinorUnits(value, store.currency, request.user.locale);
const purchaseStatuses = ['confirmed', 'processing', 'ready', 'fulfilled', 'partially_refunded', 'refunded'];

// Check live authorization for every service entry point, including direct callers.
async function access(request, session = null, mutation = false) {
  if (!request.user?._id || !request.store?._id) throw new AppError('Seller authentication is required.', 401, 'UNAUTHENTICATED');
  const queries = [() => User.findById(request.user._id).select('publicId status security.tokenVersion security.mfaEnabled emailVerifiedAt onboardingCompletedAt').session(session),
    () => Store.findById(request.store._id).session(session),
    () => StoreMember.findOne({ storeId: request.store._id, userId: request.user._id, status: 'active' }).session(session)];
  const [actor, store, member] = session ? [await queries[0](), await queries[1](), await queries[2]()] : await Promise.all(queries.map(query => query()));
  if (!actor || actor.status !== 'active' || actor.security.tokenVersion !== request.user.security?.tokenVersion ||
      (request.session?.tokenVersion !== undefined && request.session.tokenVersion !== actor.security.tokenVersion)) {
    throw new AppError('Your account or session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
  }
  if (!env.auth.simpleLogin && (!actor.emailVerifiedAt || !actor.onboardingCompletedAt)) throw new AppError('Complete account verification and onboarding first.', 403, 'ACCOUNT_UNAVAILABLE');
  if (!env.auth.simpleLogin && env.security.privilegedMfaRequired && !actor.security.mfaEnabled) throw new AppError('Authenticator enrollment is required for store operations.', 403, 'MFA_ENROLLMENT_REQUIRED');
  const capabilities = storeCapabilities(member?.role);
  if (!member || (!capabilities.has('*') && !capabilities.has('support'))) throw new AppError('Your store role cannot manage customer support.', 403, 'STORE_PERMISSION_DENIED');
  if (!store || !['pending_verification', 'verified'].includes(store.status)) throw new AppError('This store is unavailable for customer support.', 409, 'STORE_LOCKED');
  const country = await CountrySetting.findOne({ code: store.country, active: true }).select('currency timeZone').session(session).lean();
  if (!country || country.currency !== store.currency) throw new AppError('The store country and currency need configuration.', 409, 'SELLER_COUNTRY_UNAVAILABLE');
  if (mutation) {
    if (store.status !== 'verified') throw new AppError('Verify this store before contacting customers or changing support records.', 409, 'STORE_LOCKED');
    await User.updateOne({ _id: actor._id, status: 'active', 'security.tokenVersion': actor.security.tokenVersion }, { $inc: { __v: 1 } }, { session });
    await StoreMember.updateOne({ _id: member._id, status: 'active', role: member.role }, { $inc: { __v: 1 } }, { session });
    await Store.updateOne({ _id: store._id, status: 'verified', country: store.country, currency: store.currency }, { $inc: { __v: 1 } }, { session });
  }
  return { actor, store, member, country };
}

async function transaction(request, operation) {
  const session = await mongoose.startSession();
  let result;
  try { await session.withTransaction(async () => { const context = await access(request, session, true); result = await operation(context, session); }); }
  catch (error) {
    if (error.name === 'VersionError') throw new AppError('This record changed. Reload the page before saving.', 409, 'RELATIONSHIP_VERSION_CONFLICT');
    throw error;
  } finally { await session.endSession(); }
  return result;
}

function checkVersion(row, version) {
  if (Number(row.__v || 0) !== version) throw new AppError('This record changed. Reload the page before saving.', 409, 'RELATIONSHIP_VERSION_CONFLICT');
}

function filters(request, values) {
  const search = String(request.query?.search || request.query?.q || '').trim().slice(0, 100);
  const raw = String(request.query?.status || 'all');
  const status = values.includes(raw) ? raw : 'all';
  return { search, status, statuses: ['all', ...values].map(value => ({ value, label: value === 'all' ? 'All statuses' : human(value) })) };
}

function filterStages(filter, fields) {
  const match = {};
  if (filter.status !== 'all') match.status = filter.status;
  if (filter.search) match.$or = fields.map(field => ({ [field]: new RegExp(escaped(filter.search), 'i') }));
  return Object.keys(match).length ? [{ $match: match }] : [];
}

async function aggregatePage(Model, pipeline, request, { field = 'createdAt', limit = 25, after = request.query?.after } = {}) {
  const bounded = Math.max(1, Math.min(50, Number(limit) || 25));
  const [result] = await Model.aggregate([...pipeline, { $facet: {
    items: [{ $match: cursorScope({}, after, { field }) }, { $sort: cursorSort(field) }, { $limit: bounded + 1 }],
    count: [{ $count: 'total' }],
  } }]);
  return pageResult(result?.items || [], { field, limit: bounded, total: result?.count?.[0]?.total || 0 });
}

function pathWith(base, query) {
  const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== '' && value !== 'all'));
  return base + (params.size ? '?' + params : '');
}

function frame(kind, store, filter, page) {
  return { kind: 'relationships', relationshipKind: kind, filters: filter, page, records: [], selected: null,
    country: store.country, currency: store.currency, editable: store.status === 'verified',
    metrics: [], columns: [], rows: [], insights: [], workflow: [],
    health: { value: null, label: 'No records yet', rows: [] }, create: null,
    nextHref: page.hasMore ? pathWith('/seller/' + kind, { search: filter.search, status: filter.status, after: page.next }) : '' };
}

function returnPipeline(store) {
  return [{ $match: { storeId: store._id, storePublicId: store.publicId, country: store.country } },
    { $lookup: { from: SellerOrder.collection.name, let: { order: '$orderPublicId' }, pipeline: [
      { $match: { storeId: store._id, storePublicId: store.publicId, country: store.country, currency: store.currency, $expr: { $eq: ['$orderPublicId', '$$order'] } } },
      { $project: { publicId: 1, items: 1 } },
    ], as: 'sellerOrder' } }, { $match: { 'sellerOrder.0': { $exists: true } } },
    { $lookup: { from: Order.collection.name, let: { order: '$orderPublicId' }, pipeline: [
      { $match: { country: store.country, 'totals.currency': store.currency, $expr: { $eq: ['$publicId', '$$order'] } } }, { $project: { _id: 1 } },
    ], as: 'rootOrder' } }, { $match: { 'rootOrder.0': { $exists: true } } }];
}

function returnDto(row, store) {
  const ownLines = new Set((row.sellerOrder?.[0]?.items || []).map(item => item.orderLineId));
  return { publicId: row.publicId, version: Number(row.__v || 0), returnPublicId: row.returnPublicId,
    orderPublicId: row.orderPublicId, sellerOrderPublicId: row.sellerOrder?.[0]?.publicId || '', status: row.status,
    responseMessage: row.responseMessage || '', respondedAt: row.respondedAt || null, slaDueAt: row.slaDueAt || null,
    overdue: row.status !== 'resolved' && !row.respondedAt && row.slaDueAt && new Date(row.slaDueAt) < new Date(),
    items: (row.items || []).filter(item => ownLines.has(item.orderLineId)).map(item => ({ orderLineId: item.orderLineId, title: item.title,
      sku: item.sku, quantity: item.quantity, requestedRefundMinor: item.requestedRefundMinor })),
    currency: store.currency, createdAt: row.createdAt };
}

async function returnsPage(request, store, country) {
  const filter = filters(request, ['pending', 'acknowledged', 'contested', 'escalated', 'resolved']);
  const pipeline = returnPipeline(store);
  const [page, summary] = await Promise.all([
    aggregatePage(SellerReturnCase, [...pipeline, ...filterStages(filter, ['publicId', 'returnPublicId', 'orderPublicId', 'items.title', 'items.sku'])], request),
    SellerReturnCase.aggregate([...pipeline, { $group: { _id: null, total: { $sum: 1 }, open: { $sum: { $cond: [{ $ne: ['$status', 'resolved'] }, 1, 0] } },
      pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
      overdue: { $sum: { $cond: [{ $and: [{ $ne: ['$status', 'resolved'] }, { $eq: [{ $ifNull: ['$respondedAt', null] }, null] }, { $lt: ['$slaDueAt', new Date()] }] }, 1, 0] } } } }]),
  ]);
  const totals = summary[0] || { total: 0, open: 0, pending: 0, overdue: 0 };
  const flow = frame('returns', store, filter, page.page);
  flow.records = page.items.map(row => returnDto(row, store));
  if (request.query?.case) {
    const id = idInput.parse(request.query.case);
    const [row] = await SellerReturnCase.aggregate([...pipeline, { $match: { publicId: id } }, { $limit: 1 }]);
    if (!row) throw new AppError('Seller return case not found.', 404, 'SELLER_RETURN_NOT_FOUND');
    flow.selected = returnDto(row, store);
    const ret = await ReturnRequest.findOne({ _id: row.returnRequestId, country: store.country, orderPublicId: row.orderPublicId })
      .select('status reason resolution items').lean();
    const lineMap = new Map((ret?.items || []).map(item => [item.orderLineId, item]));
    flow.selected.returnStatus = ret?.status || 'unavailable';
    flow.selected.reason = ret?.reason || '';
    flow.selected.resolution = ret?.resolution || '';
    flow.selected.items = flow.selected.items.map(item => ({ ...item,
      inspectionStatus: lineMap.get(item.orderLineId)?.warehouseInspectionStatus || 'pending',
      stockDisposition: lineMap.get(item.orderLineId)?.stockDisposition || '', inspectedQuantity: lineMap.get(item.orderLineId)?.inspectedQuantity || 0 }));
    flow.selected.evidence = await EvidenceDocument.find({ _id: { $in: row.evidenceDocumentIds || [] }, country: store.country,
      contextType: 'seller_return', contextPublicId: row.publicId, status: 'ready' }).select('publicId description createdAt -_id').lean();
  }
  flow.metrics = [{ label: 'Return cases', value: totals.total, detail: 'All store return cases' }, { label: 'Awaiting response', value: totals.pending, detail: 'Seller response required' },
    { label: 'Open cases', value: totals.open, detail: 'Marketplace resolution pending' }, { label: 'Overdue responses', value: totals.overdue, detail: 'Past the response deadline' }];
  flow.columns = ['Case', 'Order', 'Items', 'Response due', 'Status'];
  flow.rows = flow.records.map(row => ({ id: row.publicId, cells: [row.publicId, row.orderPublicId,
    row.items.map(item => `${item.title} × ${item.quantity}`).join(', '), localDate(row.slaDueAt, country.timeZone), row.overdue ? 'Overdue' : human(row.status)], href: pathWith('/seller/returns', { case: row.publicId }) }));
  flow.health = { value: totals.total ? Math.round(100 * (totals.total - totals.overdue) / totals.total) : null, label: totals.total ? 'Response deadlines met' : 'No return cases yet',
    rows: [{ label: 'Awaiting seller response', value: totals.pending }, { label: 'Overdue', value: totals.overdue }] };
  flow.insights = [{ text: `${totals.overdue} return response${totals.overdue === 1 ? '' : 's'} overdue.`, href: '/seller/returns?status=pending', label: 'Review pending cases' }];
  flow.workflow = [{ title: 'Respond to a case', text: 'Open a case, acknowledge it, contest it with an explanation, or escalate it to marketplace support.', href: '/seller/returns?status=pending', label: 'View pending returns' },
    { title: 'Attach evidence', text: 'Upload a private image from the selected case. Marketplace support decides refunds and exchanges.', href: '/seller/returns', label: 'Review return cases' }];
  return flow;
}

function customerPipeline(store) {
  return [{ $match: { storeId: store._id, storePublicId: store.publicId, country: store.country, currency: store.currency, status: { $in: purchaseStatuses } } },
    { $lookup: { from: Order.collection.name, localField: 'orderId', foreignField: '_id', as: 'root' } }, { $unwind: '$root' },
    { $match: { 'root.country': store.country, 'root.totals.currency': store.currency, 'root.items': { $elemMatch: { storeId: store._id, storePublicId: store.publicId, currency: store.currency } } } },
    { $set: { customerKey: { $cond: [{ $ifNull: ['$root.userId', false] }, { $concat: ['user:', { $toString: '$root.userId' }] },
      { $concat: ['guest:', { $toLower: '$root.contact.email' }] }] },
    valueMinor: { $max: [0, { $subtract: [{ $add: ['$subtotalMinor', '$shippingMinor', '$taxMinor'] }, '$discountMinor'] }] } } }];
}

const customerGroup = [{ $sort: { createdAt: -1, _id: -1 } }, { $group: { _id: '$customerKey', lastId: { $first: '$_id' },
  publicId: { $first: '$publicId' }, contact: { $first: '$root.contact' }, userId: { $first: '$root.userId' },
  createdAt: { $first: '$createdAt' }, orderCount: { $sum: 1 }, orderValueMinor: { $sum: '$valueMinor' } } }, { $set: { customerKey: '$_id', _id: '$lastId' } }];
function customerDto(row) {
  return { publicId: row.publicId, name: row.contact.fullName, email: row.contact.email, phone: row.contact.phone,
    registered: Boolean(row.userId), orderCount: row.orderCount, orderValueMinor: row.orderValueMinor, lastOrderAt: row.createdAt };
}

async function customersPage(request, store, country) {
  const filter = filters(request, ['repeat', 'first_order']);
  const pipeline = customerPipeline(store), match = {};
  if (filter.search) match.$or = ['contact.fullName', 'contact.email', 'publicId'].map(field => ({ [field]: new RegExp(escaped(filter.search), 'i') }));
  if (filter.status === 'repeat') match.orderCount = { $gt: 1 };
  if (filter.status === 'first_order') match.orderCount = 1;
  const [page, summary] = await Promise.all([
    aggregatePage(SellerOrder, [...pipeline, ...customerGroup, { $match: match }], request),
    SellerOrder.aggregate([...pipeline, ...customerGroup, { $group: { _id: null, customers: { $sum: 1 }, orders: { $sum: '$orderCount' }, value: { $sum: '$orderValueMinor' }, repeat: { $sum: { $cond: [{ $gt: ['$orderCount', 1] }, 1, 0] } } } }]),
  ]);
  const totals = summary[0] || { customers: 0, orders: 0, value: 0, repeat: 0 }, flow = frame('customers', store, filter, page.page);
  flow.records = page.items.map(customerDto);
  if (request.query?.customer) {
    const id = idInput.parse(request.query.customer);
    const [anchor] = await SellerOrder.aggregate([...pipeline, { $match: { publicId: id } }, { $limit: 1 }]);
    if (!anchor) throw new AppError('Store customer not found.', 404, 'CUSTOMER_NOT_FOUND');
    const [row] = await SellerOrder.aggregate([...pipeline, { $match: { customerKey: anchor.customerKey } }, ...customerGroup]);
    flow.selected = customerDto(row);
    flow.selected.contactOrderId = anchor.publicId;
    flow.selected.contactEmail = anchor.root.contact.email;
    flow.selected.orders = (await SellerOrder.aggregate([...pipeline, { $match: { customerKey: anchor.customerKey } },
      { $sort: { createdAt: -1, _id: -1 } }, { $limit: 10 }, { $project: { publicId: 1, orderPublicId: 1, status: 1, valueMinor: 1, createdAt: 1 } }]))
      .map(order => ({ publicId: order.publicId, orderPublicId: order.orderPublicId, status: order.status, value: money(order.valueMinor, store, request), createdAt: order.createdAt }));
  }
  flow.metrics = [{ label: 'Customers', value: totals.customers, detail: 'Customers who ordered from this store' }, { label: 'Repeat customers', value: totals.repeat, detail: 'More than one store order' },
    { label: 'Store orders', value: totals.orders, detail: 'Confirmed and fulfilled purchases' }, { label: 'Order value', value: money(totals.value, store, request), detail: 'Store order value before refund adjustments' }];
  flow.columns = ['Customer', 'Orders', 'Order value', 'Last purchase', 'Status'];
  flow.rows = flow.records.map(row => ({ id: row.publicId, cells: [row.name, String(row.orderCount), money(row.orderValueMinor, store, request), localDate(row.lastOrderAt, country.timeZone), row.orderCount > 1 ? 'Repeat customer' : 'First order'], href: pathWith('/seller/customers', { customer: row.publicId }) }));
  flow.health = { value: totals.customers ? Math.round(100 * totals.repeat / totals.customers) : null, label: totals.customers ? 'Repeat purchase rate' : 'No customers yet', rows: [{ label: 'First purchase', value: totals.customers - totals.repeat }, { label: 'Repeat purchase', value: totals.repeat }] };
  flow.insights = [{ text: `${totals.repeat} customers have ordered more than once.`, href: '/seller/customers?status=repeat', label: 'View repeat customers' }];
  flow.workflow = [{ title: 'Review customer orders', text: 'Select a customer to review purchases and contact details recorded on this store’s orders.', href: '/seller/customers', label: 'View customers' },
    { title: 'Send order support', text: 'Send an order-related message from the selected customer. Email delivery is queued and registered buyers receive an account notification.', href: '/seller/messages', label: 'Open customer conversations' }];
  return flow;
}

function reviewPipeline(store) {
  return [{ $match: { country: store.country } }, { $lookup: { from: Product.collection.name, let: { product: '$productId' }, pipeline: [
    { $match: { storeId: store._id, $expr: { $eq: ['$_id', '$$product'] } } }, { $project: { title: 1, publicId: 1 } },
  ], as: 'product' } }, { $match: { 'product.0': { $exists: true } } }];
}
function reviewDto(row) {
  return { publicId: row.publicId, version: Number(row.__v || 0), productTitle: row.product[0].title, productPublicId: row.product[0].publicId,
    rating: row.rating, title: row.title || '', body: row.body, verifiedPurchase: row.verifiedPurchase, status: row.status,
    disputeReason: row.disputeReason || '', moderationReason: row.moderationReason || '', createdAt: row.createdAt };
}

async function reviewsPage(request, store, country) {
  const filter = filters(request, ['pending', 'published', 'disputed', 'rejected']), pipeline = reviewPipeline(store);
  const [page, summary] = await Promise.all([
    aggregatePage(Review, [...pipeline, ...filterStages(filter, ['publicId', 'title', 'body', 'product.title'])], request),
    Review.aggregate([...pipeline, { $group: { _id: null, total: { $sum: 1 }, published: { $sum: { $cond: [{ $eq: ['$status', 'published'] }, 1, 0] } },
      disputed: { $sum: { $cond: [{ $eq: ['$status', 'disputed'] }, 1, 0] } }, ratings: { $sum: { $cond: [{ $eq: ['$status', 'published'] }, '$rating', 0] } } } }]),
  ]);
  const totals = summary[0] || { total: 0, published: 0, disputed: 0, ratings: 0 }, flow = frame('reviews', store, filter, page.page);
  flow.records = page.items.map(reviewDto);
  if (request.query?.review) {
    const [row] = await Review.aggregate([...pipeline, { $match: { publicId: idInput.parse(request.query.review) } }, { $limit: 1 }]);
    if (!row) throw new AppError('Store review not found.', 404, 'REVIEW_NOT_FOUND');
    flow.selected = reviewDto(row);
  }
  const average = totals.published ? (totals.ratings / totals.published).toFixed(1) : '—';
  flow.metrics = [{ label: 'Product reviews', value: totals.total, detail: 'Reviews for this store’s products' }, { label: 'Published reviews', value: totals.published, detail: 'Visible on product pages' },
    { label: 'Average rating', value: average, detail: 'Published reviews, out of five' }, { label: 'Disputed reviews', value: totals.disputed, detail: 'Awaiting marketplace moderation' }];
  flow.columns = ['Product', 'Review', 'Rating', 'Submitted', 'Status'];
  flow.rows = flow.records.map(row => ({ id: row.publicId, cells: [row.productTitle, row.title || row.body.slice(0, 90), `${row.rating}/5`, localDate(row.createdAt, country.timeZone), human(row.status)], href: pathWith('/seller/reviews', { review: row.publicId }) }));
  flow.health = { value: totals.published ? Math.round(totals.ratings / totals.published * 20) : null, label: totals.published ? 'Published review rating' : 'No published reviews yet', rows: [{ label: 'Published', value: totals.published }, { label: 'Disputed', value: totals.disputed }] };
  flow.insights = [{ text: `${totals.disputed} reviews await dispute moderation.`, href: '/seller/reviews?status=disputed', label: 'View disputed reviews' }];
  flow.workflow = [{ title: 'Read customer feedback', text: 'Select a review to read feedback and its moderation state.', href: '/seller/reviews', label: 'View product reviews' },
    { title: 'Dispute a published review', text: 'Submit a specific reason for marketplace moderation from the selected published review.', href: '/seller/reviews?status=published', label: 'View published reviews' }];
  return flow;
}

function messageDto(row) {
  return { publicId: row.publicId, version: Number(row.__v || 0), subject: row.subject, message: row.message, status: row.status,
    replies: (row.replies || []).map(reply => ({ sender: reply.sender, body: reply.body, at: reply.at })), lastMessageAt: row.lastMessageAt, createdAt: row.createdAt };
}
function questionDto(row) {
  return { publicId: row.publicId, version: Number(row.__v || 0), productPublicId: row.productPublicId, question: row.question,
    answer: row.answer?.body || '', status: row.status, createdAt: row.createdAt };
}

async function messagesPage(request, store, country) {
  const tab = request.query?.tab === 'questions' ? 'questions' : 'conversations';
  const questions = tab === 'questions', Model = questions ? ProductQuestion : SellerContactRequest;
  const filter = filters(request, questions ? ['open', 'answered'] : ['new', 'read', 'resolved']);
  const base = { storeId: store._id, country: store.country };
  if (questions) base.status = { $in: ['open', 'answered'] };
  const questionScope = [{ $lookup: { from: Product.collection.name, let: { product: '$productId' }, pipeline: [
    { $match: { storeId: store._id, $expr: { $eq: ['$_id', '$$product'] } } }, { $project: { _id: 1 } },
  ], as: 'ownedProduct' } }, { $match: { 'ownedProduct.0': { $exists: true } } }];
  const [page, conversationCounts, questionCounts] = await Promise.all([
    aggregatePage(Model, [{ $match: base }, ...(questions ? questionScope : []), ...filterStages(filter, questions ? ['publicId', 'question', 'productPublicId'] : ['publicId', 'subject', 'message'])], request, { field: questions ? 'createdAt' : 'lastMessageAt' }),
    SellerContactRequest.aggregate([{ $match: { storeId: store._id, country: store.country } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    ProductQuestion.aggregate([{ $match: { storeId: store._id, country: store.country, status: { $in: ['open', 'answered'] } } }, ...questionScope, { $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  const totals = Object.fromEntries(conversationCounts.map(row => [row._id, row.count])), qt = Object.fromEntries(questionCounts.map(row => [row._id, row.count]));
  const all = (totals.new || 0) + (totals.read || 0) + (totals.resolved || 0), flow = frame('messages', store, filter, page.page);
  flow.tab = tab;
  flow.records = page.items.map(questions ? questionDto : messageDto);
  const selectedId = request.query?.[questions ? 'question' : 'thread'];
  if (selectedId) {
    const row = questions ? (await Model.aggregate([{ $match: { ...base, publicId: idInput.parse(selectedId) } }, ...questionScope]))[0] :
      await Model.findOne({ ...base, publicId: idInput.parse(selectedId) }).lean();
    if (!row) throw new AppError('Conversation or product question not found.', 404, 'CONTACT_NOT_FOUND');
    flow.selected = questions ? questionDto(row) : messageDto(row);
  }
  flow.nextHref = page.page.hasMore ? pathWith('/seller/messages', { tab: questions ? 'questions' : '', search: filter.search, status: filter.status, after: page.page.next }) : '';
  flow.metrics = [{ label: 'Conversations', value: all, detail: 'Direct customer conversations' }, { label: 'New messages', value: totals.new || 0, detail: 'Awaiting a seller reply' },
    { label: 'Resolved', value: totals.resolved || 0, detail: 'Closed conversations' }, { label: 'Open questions', value: qt.open || 0, detail: 'Product questions awaiting answers' }];
  flow.columns = questions ? ['Question', 'Product', 'Answer', 'Submitted', 'Status'] : ['Conversation', 'Subject', 'Replies', 'Last activity', 'Status'];
  flow.rows = flow.records.map(row => ({ id: row.publicId, cells: questions ? [row.question.slice(0, 100), row.productPublicId, row.answer ? 'Published answer' : 'Awaiting answer', localDate(row.createdAt, country.timeZone), human(row.status)] :
    [row.publicId, row.subject, String(row.replies.length), localDate(row.lastMessageAt, country.timeZone), human(row.status)], href: pathWith('/seller/messages', questions ? { tab: 'questions', question: row.publicId } : { thread: row.publicId }) }));
  flow.health = { value: all ? Math.round(100 * (totals.resolved || 0) / all) : null, label: all ? 'Conversations resolved' : 'No conversations yet', rows: [{ label: 'New messages', value: totals.new || 0 }, { label: 'Open product questions', value: qt.open || 0 }] };
  flow.insights = [{ text: `${totals.new || 0} new conversations await a reply.`, href: '/seller/messages?status=new', label: 'View new messages' }, { text: `${qt.open || 0} product questions await an answer.`, href: '/seller/messages?tab=questions&status=open', label: 'Answer product questions' }];
  flow.workflow = [{ title: 'Reply to a customer', text: 'Select an open conversation to send a saved reply and an account notification.', href: '/seller/messages', label: 'Open conversations' },
    { title: 'Answer product questions', text: 'Publish an answer to an open product question.', href: '/seller/messages?tab=questions', label: 'Open product questions' }];
  return flow;
}

export async function sellerRelationshipPage(request, pageId) {
  const { store, member, country } = await access(request);
  const kind = String(pageId).replace(/^seller-/, '');
  const loader = { returns: returnsPage, customers: customersPage, reviews: reviewsPage, messages: messagesPage }[kind];
  if (!loader) throw new AppError('Seller page not found.', 404, 'SELLER_PAGE_NOT_FOUND');
  const flow = await loader(request, store, country);
  flow.timeZone = country.timeZone;
  const capabilities = storeCapabilities(member.role);
  flow.canViewOrders = capabilities.has('*') || capabilities.has('fulfilment');
  flow.filters.after = String(request.query?.after || '').slice(0, 512);
  flow.filters.params = flow.relationshipKind === 'messages' && flow.tab === 'questions' ? { tab: 'questions' } : {};
  flow.pagination = { nextHref: flow.nextHref };
  return flow;
}

async function ownedReturn(store, id, session) {
  const row = await SellerReturnCase.findOne({ publicId: id, storeId: store._id, storePublicId: store.publicId, country: store.country }).session(session);
  const order = row ? await SellerOrder.findOne({ orderPublicId: row.orderPublicId, storeId: store._id, country: store.country, currency: store.currency }).session(session) : null;
  const root = order ? await Order.exists({ _id: order.orderId, publicId: row.orderPublicId, country: store.country, 'totals.currency': store.currency }).session(session) : null;
  if (!row || !order || !root) throw new AppError('Seller return case not found.', 404, 'SELLER_RETURN_NOT_FOUND');
  return row;
}

export async function respondSellerReturn(request) {
  const input = z.object({ version: versionInput, action: z.enum(['acknowledged', 'contested', 'escalated']), message: z.string().trim().max(2000).default('') })
    .refine(value => value.action === 'acknowledged' || value.message.length >= 10, { message: 'Explain the response in at least 10 characters.', path: ['message'] }).parse(request.body);
  const id = idInput.parse(request.params.publicId);
  return transaction(request, async ({ store }, session) => {
    const row = await ownedReturn(store, id, session); checkVersion(row, input.version);
    if (row.status === 'resolved') throw new AppError('This return case is resolved.', 409, 'SELLER_RETURN_RESOLVED');
    row.status = input.action; row.responseMessage = input.message; row.respondedByUserId = request.user._id; row.respondedAt = new Date();
    row.timeline.push({ type: `seller_return.${input.action}`, message: (input.message || `Seller marked the return ${input.action}.`).slice(0, 1000), actorUserId: request.user._id });
    row.increment(); await row.save({ session });
    await writeAudit(request, `seller.return_${input.action}`, { targetType: 'seller_return_case', targetPublicId: row.publicId, country: store.country, session });
    return { publicId: row.publicId };
  });
}

export async function attachSellerReturnEvidence(request) {
  const id = idInput.parse(request.params.publicId), version = versionInput.parse(request.body.version);
  const description = z.string().trim().max(300).default('Seller return evidence').parse(request.body.description);
  const { store } = await access(request);
  const initial = await ownedReturn(store, id, null); checkVersion(initial, version);
  if (initial.status === 'resolved') throw new AppError('This return case is resolved.', 409, 'SELLER_RETURN_RESOLVED');
  const evidence = await sanitizeAndStoreEvidenceImage({ file: request.file, user: request.user, country: store.country,
    contextType: 'seller_return', contextPublicId: id, description });
  try {
    return await transaction(request, async ({ store: freshStore }, session) => {
      const row = await ownedReturn(freshStore, id, session); checkVersion(row, version);
      if (row.status === 'resolved') throw new AppError('This return case is resolved.', 409, 'SELLER_RETURN_RESOLVED');
      row.evidenceDocumentIds.push(evidence._id); row.timeline.push({ type: 'seller_return.evidence_added', message: 'Seller added private evidence for support review.', actorUserId: request.user._id });
      row.increment(); await row.save({ session });
      await writeAudit(request, 'seller.return_evidence_added', { targetType: 'seller_return_case', targetPublicId: id, country: freshStore.country, metadata: { evidencePublicId: evidence.publicId }, session });
      return { publicId: id };
    });
  } catch (error) {
    // A failed attachment must not remain readable as accepted case evidence.
    await EvidenceDocument.updateOne({ _id: evidence._id }, { $set: { status: 'rejected' } });
    throw error;
  }
}

export async function disputeSellerReview(request) {
  const input = z.object({ version: versionInput, reason: z.string().trim().min(10).max(1000) }).parse(request.body), id = idInput.parse(request.params.publicId);
  return transaction(request, async ({ store }, session) => {
    const row = await Review.findOne({ publicId: id, country: store.country }).session(session);
    const product = row ? await Product.findOne({ _id: row.productId, storeId: store._id }).session(session) : null;
    if (!row || !product) throw new AppError('Store review not found.', 404, 'REVIEW_NOT_FOUND');
    checkVersion(row, input.version);
    if (row.status !== 'published') throw new AppError('Only a published review can be disputed.', 409, 'REVIEW_STATE');
    row.status = 'disputed'; row.disputeReason = input.reason; row.disputedByUserId = request.user._id; row.disputedAt = new Date();
    row.increment(); await row.save({ session });
    await writeAudit(request, 'seller.review_disputed', { targetType: 'review', targetPublicId: id, country: store.country, session });
    return { publicId: id };
  });
}

export async function replySellerConversation(request, resolve = false) {
  const version = versionInput.parse(request.body.version), id = idInput.parse(request.params.publicId);
  const message = resolve ? '' : z.string().trim().min(2).max(2000).parse(request.body.message);
  return transaction(request, async ({ store }, session) => {
    const row = await SellerContactRequest.findOne({ publicId: id, storeId: store._id, country: store.country }).session(session);
    if (!row) throw new AppError('Conversation not found.', 404, 'CONTACT_NOT_FOUND');
    checkVersion(row, version);
    if (row.status === 'resolved') throw new AppError('This conversation is resolved.', 409, 'CONTACT_RESOLVED');
    if (resolve) { row.status = 'resolved'; row.resolvedAt = new Date(); }
    else {
      row.replies.push({ sender: 'seller', senderUserId: request.user._id, body: message, at: new Date() }); row.status = 'read';
      await Notification.create([{ publicId: publicId('ntf'), userId: row.customerUserId, country: store.country, type: 'seller.contact_reply',
        title: `Reply from ${store.name}`.slice(0, 180), body: message.slice(0, 1500), href: '/account/messages' }], { session });
    }
    row.lastMessageAt = new Date(); row.increment(); await row.save({ session });
    await writeAudit(request, resolve ? 'seller_contact.resolved' : 'seller_contact.seller_reply', { targetType: 'seller_contact', targetPublicId: id, country: store.country, session });
    return { publicId: id };
  });
}

export async function answerSellerQuestion(request) {
  const input = z.object({ version: versionInput, answer: z.string().trim().min(2).max(2000) }).parse(request.body), id = idInput.parse(request.params.publicId);
  return transaction(request, async ({ store }, session) => {
    const row = await ProductQuestion.findOne({ publicId: id, storeId: store._id, country: store.country }).session(session);
    const product = row ? await Product.findOne({ _id: row.productId, storeId: store._id }).session(session) : null;
    if (!row || !product) throw new AppError('Product question not found.', 404, 'QUESTION_NOT_FOUND');
    checkVersion(row, input.version);
    if (row.status !== 'open') throw new AppError('Only an open product question can be answered.', 409, 'QUESTION_STATE');
    row.answer = { body: input.answer, sellerUserId: request.user._id, answeredAt: new Date() }; row.status = 'answered'; row.increment(); await row.save({ session });
    await writeAudit(request, 'product_question.answered', { targetType: 'product_question', targetPublicId: id, country: store.country, session });
    return { publicId: id };
  });
}

export async function contactSellerCustomer(request) {
  const input = z.object({ subject: z.string().trim().min(2).max(160), message: z.string().trim().min(10).max(2000) }).parse(request.body), id = idInput.parse(request.params.publicId);
  return transaction(request, async ({ store }, session) => {
    const own = await SellerOrder.findOne({ publicId: id, storeId: store._id, storePublicId: store.publicId, country: store.country, currency: store.currency, status: { $in: purchaseStatuses } }).session(session);
    const root = own ? await Order.findOne({ _id: own.orderId, country: store.country, 'totals.currency': store.currency,
      items: { $elemMatch: { storeId: store._id, storePublicId: store.publicId, currency: store.currency } } }).select('publicId userId contact.email').session(session) : null;
    if (!own || !root) throw new AppError('Store customer order not found.', 404, 'CUSTOMER_NOT_FOUND');
    const email = z.email().max(254).parse(root.contact.email);
    await addOutboxEvent({ type: 'seller.order_notification', aggregateType: 'seller_order', aggregatePublicId: own.publicId,
      payload: { email, subject: `${store.name}: ${input.subject}`.slice(0, 180), body: `About order ${root.publicId}\n\n${input.message}` } }, session);
    if (root.userId) await Notification.create([{ publicId: publicId('ntf'), userId: root.userId, country: store.country, type: 'seller.order_message',
      title: `${store.name}: ${input.subject}`.slice(0, 180), body: input.message.slice(0, 1500), href: '/orders' }], { session });
    await writeAudit(request, 'seller.customer_contact_queued', { targetType: 'seller_order', targetPublicId: own.publicId, country: store.country, session });
    return { publicId: own.publicId };
  });
}

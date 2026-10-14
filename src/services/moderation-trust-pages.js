import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { env } from '../config/env.js';
import { Review, TrustCase, RiskSignal, Order, Product, Store, StoreMember, User, AuditLog, Notification, EvidenceDocument, ModerationQaReview, SellerVerification, SupportTicket } from '../models/index.js';
import { writeAudit } from './audit.js';
import { authorizeCustomerCaseActor, fenceCustomerCaseMarket } from './customer-dispute-pages.js';
import { moderationAccess, fenceModerationAccess, assertModerationReadAccess, moderationPublicContext } from './moderation-workspace-access.js';
import { cursorScope, cursorSort, decodeCursor, pageResult } from './pagination.js';
import { queueModerationAlert } from './moderation-notifications.js';
import { queueCountryAdminAlert } from './country-admin-notifications.js';

const SIZE = 25;
const idValue = z.string().trim().min(4).max(100).regex(/^[A-Za-z0-9_-]+$/);
const versionValue = z.union([z.number(), z.string().regex(/^\d+$/)]).pipe(z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const text = (value, limit = 1000) => z.string().trim().min(3).max(limit).parse(value);
const same = (a, b) => String(a || '') === String(b || '');
const label = value => String(value || '').replaceAll('_', ' ');
const escaped = value => new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const now = () => new Date();
const conflict = () => new AppError('This record changed. Reload before continuing.', 409, 'MODERATION_VERSION_CONFLICT');
const scopeCountries = context => context.country ? [context.country] : context.countries.map(row => row.code);
const asArray = value => Array.isArray(value) ? value : [];

async function transaction(work) {
  const session = await mongoose.startSession();
  let result;
  try { await session.withTransaction(async () => { result = await work(session); }); return result; }
  finally { await session.endSession(); }
}

function versionCheck(record, expected) {
  if (expected !== undefined && Number(record.__v || 0) !== Number(expected)) throw conflict();
}

function filterScope(context, filters = {}, fields = []) {
  const match = { ...context.countryScope };
  if (filters.status && filters.status !== 'all') match.status = filters.status;
  if (filters.record) match.publicId = filters.record;
  if (filters.search) match.$or = fields.map(field => ({ [field]: escaped(filters.search) }));
  if (filters.assignment === 'mine') match.assignedUserId = context.actor._id;
  if (filters.assignment === 'unassigned') match.assignedUserId = null;
  return match;
}

/** A review is eligible only when its immutable buyer, order, delivered line and product agree. */
export function moderationReviewPipeline(context, filters = {}) {
  return [{ $match: { ...filterScope(context, filters, ['publicId', 'orderPublicId', 'productPublicId', 'title', 'body']), verifiedPurchase: true } },
    { $lookup: { from: Order.collection.name, localField: 'orderId', foreignField: '_id', as: 'sourceOrder', pipeline: [{ $match: { country: { $in: scopeCountries(context) } } }, { $project: { publicId: 1, userId: 1, country: 1, fulfillmentState: 1, items: 1 } }] } },
    { $unwind: '$sourceOrder' },
    { $match: { $expr: { $and: [{ $eq: ['$orderPublicId', '$sourceOrder.publicId'] }, { $eq: ['$userId', '$sourceOrder.userId'] }, { $eq: ['$country', '$sourceOrder.country'] }, { $eq: ['$sourceOrder.fulfillmentState', 'delivered'] },
      { $gt: [{ $size: { $filter: { input: '$sourceOrder.items', as: 'line', cond: { $and: [{ $eq: ['$$line.productId', '$productId'] }, { $eq: ['$$line.productPublicId', '$productPublicId'] }, { $gt: ['$$line.deliveredQuantity', 0] }, { $or: [{ $eq: [{ $ifNull: ['$orderLinePublicId', ''] }, ''] }, { $eq: ['$orderLinePublicId', '$$line.linePublicId'] }] }] } } } }, 0] }] } } },
    { $lookup: { from: Product.collection.name, localField: 'productId', foreignField: '_id', as: 'sourceProduct', pipeline: [{ $project: { publicId: 1, title: 1, storeId: 1, ownerUserId: 1, countries: 1, status: 1 } }] } },
    { $unwind: '$sourceProduct' }, { $match: { $expr: { $eq: ['$productPublicId', '$sourceProduct.publicId'] } } },
    { $lookup: { from: Store.collection.name, localField: 'sourceProduct.storeId', foreignField: '_id', as: 'sourceStore', pipeline: [{ $project: { publicId: 1, name: 1, ownerUserId: 1, country: 1, status: 1 } }] } }, { $unwind: '$sourceStore' },
    { $match: { $expr: { $gt: [{ $size: { $filter: { input: '$sourceOrder.items', as: 'line', cond: { $and: [{ $eq: ['$$line.productId', '$productId'] }, { $eq: ['$$line.productPublicId', '$productPublicId'] }, { $eq: ['$$line.storeId', '$sourceStore._id'] }, { $eq: ['$$line.storePublicId', '$sourceStore.publicId'] }, { $gt: ['$$line.deliveredQuantity', 0] }, { $or: [{ $eq: [{ $ifNull: ['$orderLinePublicId', ''] }, ''] }, { $eq: ['$orderLinePublicId', '$$line.linePublicId'] }] }] } } } }, 0] } } }];
}

/** Case subject references are checked together, so a local label cannot expose a foreign subject. */
export function moderationTrustCasePipeline(context, filters = {}) {
  return [{ $match: filterScope(context, filters, ['publicId', 'productPublicId', 'storePublicId', 'description']) },
    { $lookup: { from: Product.collection.name, localField: 'productId', foreignField: '_id', as: 'sourceProduct', pipeline: [{ $project: { publicId: 1, title: 1, storeId: 1, ownerUserId: 1, countries: 1, status: 1 } }] } },
    { $lookup: { from: Store.collection.name, localField: 'storeId', foreignField: '_id', as: 'sourceStore', pipeline: [{ $project: { publicId: 1, name: 1, ownerUserId: 1, country: 1, status: 1 } }] } },
    { $set: { sourceProduct: { $first: '$sourceProduct' }, sourceStore: { $first: '$sourceStore' } } },
    { $match: { $expr: { $and: [
      { $or: [{ $eq: [{ $ifNull: ['$productId', null] }, null] }, { $and: [{ $eq: ['$productPublicId', '$sourceProduct.publicId'] }, { $in: ['$country', { $ifNull: ['$sourceProduct.countries', []] }] }] }] },
      { $or: [{ $eq: [{ $ifNull: ['$storeId', null] }, null] }, { $and: [{ $eq: ['$storePublicId', '$sourceStore.publicId'] }, { $or: [{ $eq: ['$sourceStore.country', '$country'] }, { $eq: ['$sourceProduct.storeId', '$sourceStore._id'] }] }] }] },
      { $or: [{ $ne: [{ $ifNull: ['$productId', null] }, null] }, { $ne: [{ $ifNull: ['$storeId', null] }, null] }] },
      { $or: [{ $eq: [{ $ifNull: ['$productId', null] }, null] }, { $eq: [{ $ifNull: ['$storeId', null] }, null] }, { $eq: ['$sourceProduct.storeId', '$sourceStore._id'] }] },
    ] } } },
    { $lookup: { from: Review.collection.name, localField: 'reviewId', foreignField: '_id', as: 'sourceReview', pipeline: [{ $project: { publicId: 1, productId: 1, productPublicId: 1, country: 1, userId: 1, orderId: 1 } }] } },
    { $set: { sourceReview: { $first: '$sourceReview' } } },
    { $match: { $expr: { $or: [{ $eq: [{ $ifNull: ['$reviewId', null] }, null] }, { $and: [{ $eq: ['$reviewPublicId', '$sourceReview.publicId'] }, { $eq: ['$country', '$sourceReview.country'] }, { $eq: ['$productId', '$sourceReview.productId'] }, { $eq: ['$productPublicId', '$sourceReview.productPublicId'] }] }] } } },
    { $lookup: { from: ModerationQaReview.collection.name, localField: 'qaReviewId', foreignField: '_id', as: 'sourceQa', pipeline: [
      { $lookup: { from: AuditLog.collection.name, let: { id: '$publicId', country: '$country', reviewer: '$qaReviewerUserId', caseId: '$escalationCasePublicId' }, as: 'sourceAudit', pipeline: [
        { $match: { action: 'moderation.qa_reviewed', result: 'success', targetType: 'moderation_qa', 'metadata.outcome': 'escalated', $expr: { $and: [{ $eq: ['$targetPublicId', '$$id'] }, { $eq: ['$country', '$$country'] }, { $eq: ['$actorId', '$$reviewer'] }, { $eq: ['$metadata.escalationCasePublicId', '$$caseId'] }] } } }, { $limit: 1 }, { $project: { _id: 1 } },
      ] } }, { $match: { 'sourceAudit.0': { $exists: true } } },
      { $project: { publicId: 1, country: 1, status: 1, outcome: 1, escalationCaseId: 1, escalationCasePublicId: 1, targetObjectId: 1, targetPublicId: 1, targetType: 1, originalReviewerUserId: 1, qaReviewerUserId: 1 } },
    ] } },
    { $set: { sourceQa: { $first: '$sourceQa' } } },
    { $lookup: { from: SellerVerification.collection.name, localField: 'sourceQa.targetObjectId', foreignField: '_id', as: 'sourceQaVerification', pipeline: [{ $project: { publicId: 1, storeId: 1 } }] } },
    { $set: { sourceQaVerification: { $first: '$sourceQaVerification' } } },
    { $match: { $expr: { $or: [{ $and: [{ $ne: ['$type', 'moderation_quality'] }, { $eq: [{ $ifNull: ['$qaReviewId', null] }, null] }] }, { $and: [{ $eq: ['$type', 'moderation_quality'] }, { $eq: ['$qaReviewPublicId', '$sourceQa.publicId'] }, { $eq: ['$reporterUserId', '$sourceQa.qaReviewerUserId'] }, { $eq: ['$country', '$sourceQa.country'] }, { $eq: ['$sourceQa.status', 'completed'] }, { $eq: ['$sourceQa.outcome', 'escalated'] }, { $eq: ['$sourceQa.escalationCaseId', '$_id'] }, { $eq: ['$sourceQa.escalationCasePublicId', '$publicId'] }, { $or: [
      { $and: [{ $eq: ['$sourceQa.targetType', 'product'] }, { $eq: ['$sourceQa.targetObjectId', '$productId'] }, { $eq: ['$sourceQa.targetPublicId', '$productPublicId'] }] },
      { $and: [{ $eq: ['$sourceQa.targetType', 'seller_verification'] }, { $eq: ['$sourceQaVerification.storeId', '$storeId'] }, { $eq: ['$sourceQaVerification.publicId', '$sourceQa.targetPublicId'] }] },
    ] }] }] } } }];
}

export function moderationRiskSignalPipeline(context, filters = {}) {
  return [{ $match: filterScope(context, filters, ['publicId', 'subjectPublicId', 'type']) },
    { $lookup: { from: Product.collection.name, localField: 'subjectPublicId', foreignField: 'publicId', as: 'subjectProduct', pipeline: [{ $project: { publicId: 1, title: 1, countries: 1, storeId: 1, ownerUserId: 1 } }] } },
    { $lookup: { from: Store.collection.name, localField: 'subjectPublicId', foreignField: 'publicId', as: 'subjectStore', pipeline: [{ $project: { publicId: 1, name: 1, country: 1, ownerUserId: 1 } }] } },
    { $lookup: { from: Order.collection.name, localField: 'subjectPublicId', foreignField: 'publicId', as: 'subjectOrder', pipeline: [{ $project: { publicId: 1, country: 1, userId: 1 } }] } },
    { $lookup: { from: User.collection.name, localField: 'subjectPublicId', foreignField: 'publicId', as: 'subjectUser', pipeline: [{ $project: { publicId: 1, country: 1 } }] } },
    { $set: { sourceProduct: { $first: '$subjectProduct' }, sourceStore: { $first: '$subjectStore' }, sourceOrder: { $first: '$subjectOrder' }, sourceUser: { $first: '$subjectUser' } } },
    { $match: { $expr: { $switch: { branches: [
      { case: { $eq: ['$subjectType', 'product'] }, then: { $in: ['$country', { $ifNull: ['$sourceProduct.countries', []] }] } },
      { case: { $eq: ['$subjectType', 'store'] }, then: { $eq: ['$country', '$sourceStore.country'] } },
      { case: { $eq: ['$subjectType', 'order'] }, then: { $eq: ['$country', '$sourceOrder.country'] } },
      { case: { $in: ['$subjectType', ['user', 'promoter', 'delivery']] }, then: { $eq: ['$country', '$sourceUser.country'] } },
    ], default: false } } } }];
}

async function notifyUser(userId, country, title, body, href, session) {
  if (!userId) return;
  const exists = await User.exists({ _id: userId, status: 'active' }).session(session);
  if (!exists) return;
  await Notification.create([{ publicId: publicId('ntf'), userId, country, type: 'moderation_case', title, body, href }], { session });
}

export async function queueTrustModerationAlert({ country, href }, session) {
  return queueModerationAlert({ country, kind: 'escalation', href }, session);
}

export function customerReviewDto(document) {
  const row = document?.toObject ? document.toObject() : document;
  return row ? { publicId: row.publicId, orderPublicId: row.orderPublicId, productPublicId: row.productPublicId, country: row.country, rating: row.rating, title: row.title, body: row.body, status: row.status, verifiedPurchase: row.verifiedPurchase, publishedAt: row.publishedAt || null, createdAt: row.createdAt, version: Number(row.__v || 0), moderationReason: row.moderationReason || '', publicMessages: asArray(row.publicMessages).map(message => ({ author: message.author, message: message.message, at: message.at })) } : null;
}

export function customerTrustCaseDto(document) {
  const row = document?.toObject ? document.toObject() : document;
  return row ? { publicId: row.publicId, country: row.country, type: row.type, productPublicId: row.productPublicId || '', storePublicId: row.storePublicId || '', description: row.description, status: row.status, decision: row.decision || '', createdAt: row.createdAt, updatedAt: row.updatedAt, resolvedAt: row.resolvedAt || null, version: Number(row.__v || 0), canAppeal: row.type !== 'moderation_quality' && ['actioned', 'dismissed', 'closed'].includes(row.status) && Number(row.appealCount || 0) < 1, publicMessages: asArray(row.publicMessages).map(message => ({ author: message.author, message: message.message, at: message.at })) } : null;
}

async function affectedStore(product, doc, session) {
  const store = await Store.findOne(product ? { _id: product.storeId } : { _id: doc.storeId, publicId: doc.storePublicId }).session(session);
  if (!store) throw new AppError('The affected store linkage needs investigation.', 409, 'MODERATION_SUBJECT_LINKAGE_INVALID');
  return store;
}

async function noConflict(actor, { product, store, reporter, buyer, disputer }, session) {
  if ([reporter, buyer, disputer, product?.ownerUserId, store?.ownerUserId].some(value => value && same(value, actor._id))) throw new AppError('An independent reviewer must handle this record.', 403, 'MODERATION_CONFLICT_OF_INTEREST');
  const storeId = store?._id || product?.storeId;
  if (storeId && await StoreMember.exists({ storeId, userId: actor._id, status: mongoose.trusted({ $in: ['active', 'invited'] }) }).session(session)) throw new AppError('A current or invited member of the affected store cannot review this record.', 403, 'MODERATION_CONFLICT_OF_INTEREST');
}

async function checkedReview(review, session) {
  const order = await Order.findOne({ _id: review.orderId, publicId: review.orderPublicId, userId: review.userId, country: review.country, fulfillmentState: 'delivered' }).session(session);
  const line = order?.items.find(item => same(item.productId, review.productId) && item.productPublicId === review.productPublicId && Number(item.deliveredQuantity) > 0 && (!review.orderLinePublicId || item.linePublicId === review.orderLinePublicId));
  if (!order || !line || !review.verifiedPurchase) throw new AppError('Review purchase linkage needs investigation.', 409, 'REVIEW_LINKAGE_INVALID');
  const product = await Product.findOne({ _id: review.productId, publicId: review.productPublicId }).session(session);
  if (!product || !same(product.storeId, line.storeId)) throw new AppError('Review product linkage needs investigation.', 409, 'REVIEW_LINKAGE_INVALID');
  const store = await affectedStore(product, review, session);
  if (store.publicId !== line.storePublicId) throw new AppError('Review store linkage needs investigation.', 409, 'REVIEW_LINKAGE_INVALID');
  return { order, line, product, store };
}

async function checkedCase(doc, session) {
  const product = doc.productId ? await Product.findOne({ _id: doc.productId, publicId: doc.productPublicId, countries: doc.country }).session(session) : null;
  if (doc.productId && !product || !doc.productId && doc.productPublicId) throw new AppError('The trust case product linkage needs investigation.', 409, 'TRUST_CASE_LINKAGE_INVALID');
  const store = await affectedStore(product, doc, session);
  if (doc.storeId && (!same(doc.storeId, store._id) || doc.storePublicId !== store.publicId) || !product && store.country !== doc.country) throw new AppError('The trust case store linkage needs investigation.', 409, 'TRUST_CASE_LINKAGE_INVALID');
  if (doc.reviewId) {
    const review = await Review.findOne({ _id: doc.reviewId, publicId: doc.reviewPublicId, productId: doc.productId, productPublicId: doc.productPublicId, country: doc.country }).session(session);
    if (!review) throw new AppError('The referred review linkage needs investigation.', 409, 'TRUST_CASE_LINKAGE_INVALID');
    if (doc.qaReviewId || doc.type === 'moderation_quality') throw new AppError('This case has conflicting source references.', 409, 'TRUST_CASE_LINKAGE_INVALID');
    const source = await checkedReview(review, session);
    const ticket = doc.supportTicketId ? await SupportTicket.findOne({ _id: doc.supportTicketId, publicId: doc.supportTicketPublicId, country: doc.country, orderId: source.order._id, orderPublicId: source.order.publicId }).session(session) : null;
    if (doc.supportTicketId && !ticket || ticket && ticket.userId && !same(ticket.userId, review.userId)) throw new AppError('The Support referral source does not match this review.', 409, 'TRUST_CASE_LINKAGE_INVALID');
    return { product, store, review, order: source.order, ticket, buyer: review.userId, disputer: review.disputedByUserId };
  }
  if (doc.type === 'moderation_quality' && !doc.qaReviewId || doc.qaReviewId && doc.type !== 'moderation_quality') throw new AppError('The quality referral reference is missing or mismatched.', 409, 'TRUST_CASE_LINKAGE_INVALID');
  if (doc.qaReviewId) {
    const qa = await ModerationQaReview.findOne({ _id: doc.qaReviewId, publicId: doc.qaReviewPublicId, country: doc.country, status: 'completed', outcome: 'escalated', escalationCaseId: doc._id, escalationCasePublicId: doc.publicId }).session(session);
    if (!qa || !same(doc.reporterUserId, qa.qaReviewerUserId)) throw new AppError('The quality referral linkage needs investigation.', 409, 'TRUST_CASE_LINKAGE_INVALID');
    const audit = await AuditLog.exists({ action: 'moderation.qa_reviewed', result: 'success', targetType: 'moderation_qa', targetPublicId: qa.publicId, country: qa.country,
      actorId: qa.qaReviewerUserId, 'metadata.outcome': 'escalated', 'metadata.escalationCasePublicId': doc.publicId }).session(session);
    if (!audit) throw new AppError('The quality finding has no matching recorded decision.', 409, 'TRUST_CASE_LINKAGE_INVALID');
    const target = qa.targetType === 'product' ? product : await SellerVerification.findOne({ _id: qa.targetObjectId, publicId: qa.targetPublicId, storeId: store._id }).session(session);
    if (!target || !same(target._id, qa.targetObjectId) || target.publicId !== qa.targetPublicId) throw new AppError('The quality referral subject is unavailable.', 409, 'TRUST_CASE_LINKAGE_INVALID');
    return { product, store, qa, buyer: qa.originalReviewerUserId, disputer: qa.qaReviewerUserId };
  }
  return { product, store };
}

async function checkedSignal(doc, session) {
  let product = null, store = null, buyer = null, order = null;
  if (doc.subjectType === 'product') {
    product = await Product.findOne({ publicId: doc.subjectPublicId, countries: doc.country }).session(session);
    if (!product) throw new AppError('The signal product linkage needs investigation.', 409, 'RISK_LINKAGE_INVALID');
    store = await affectedStore(product, doc, session);
  } else if (doc.subjectType === 'store') {
    store = await Store.findOne({ publicId: doc.subjectPublicId, country: doc.country }).session(session);
    if (!store) throw new AppError('The signal store linkage needs investigation.', 409, 'RISK_LINKAGE_INVALID');
  } else if (doc.subjectType === 'order') {
    order = await Order.findOne({ publicId: doc.subjectPublicId, country: doc.country }).session(session);
    if (!order) throw new AppError('The signal order linkage needs investigation.', 409, 'RISK_LINKAGE_INVALID');
    buyer = order.userId;
  } else if (['user', 'promoter', 'delivery'].includes(doc.subjectType)) {
    const subject = await User.findOne({ publicId: doc.subjectPublicId, country: doc.country }).session(session);
    if (!subject) throw new AppError('The signal account linkage needs investigation.', 409, 'RISK_LINKAGE_INVALID');
    buyer = subject._id;
  } else throw new AppError('The signal subject type is invalid.', 409, 'RISK_LINKAGE_INVALID');
  const relatedStores = order ? await Store.find({ _id: mongoose.trusted({ $in: order.items.map(item => item.storeId) }) }).session(session) : [];
  const relatedCases = doc.evidence?.length ? await TrustCase.find({ publicId: mongoose.trusted({ $in: doc.evidence }), country: doc.country, ...(product ? { productId: product._id, productPublicId: product.publicId } : store ? { storeId: store._id, storePublicId: store.publicId } : {}) }).session(session) : [];
  return { product, store, buyer, order, relatedStores, relatedCases, reporter: doc.reporterUserId };
}

function assignedToActor(doc, actor, required = false) {
  if (doc.assignedUserId && !same(doc.assignedUserId, actor._id) || required && !same(doc.assignedUserId, actor._id)) throw new AppError('Claim this record before deciding. Another reviewer owns an existing claim.', 409, 'MODERATION_CLAIM_REQUIRED');
}

export async function createOwnedVerifiedReview(request, body) {
  const input = z.object({ productId: idValue, orderId: idValue.optional(), orderLineId: idValue.optional(), rating: z.coerce.number().int().min(1).max(5), title: z.string().trim().max(140).default(''), body: z.string().trim().min(10).max(2500) }).parse(body);
  try { return await transaction(async session => {
    const actor = await authorizeCustomerCaseActor(request, session);
    const where = { userId: actor._id, fulfillmentState: 'delivered', 'items.productPublicId': input.productId, ...(input.orderLineId ? { 'items.linePublicId': input.orderLineId } : {}), ...(input.orderId ? { publicId: input.orderId } : {}) };
    const order = await Order.findOne(where).sort({ createdAt: -1, _id: -1 }).session(session);
    const item = order?.items.find(row => row.productPublicId === input.productId && Number(row.deliveredQuantity) > 0 && (!input.orderLineId || row.linePublicId === input.orderLineId));
    if (!item) throw new AppError('A delivered verified purchase is required to review this product.', 403, 'VERIFIED_PURCHASE_REQUIRED');
    await fenceCustomerCaseMarket(order.country, session, order.totals.currency);
    const product = await Product.findOne({ _id: item.productId, publicId: item.productPublicId }).session(session);
    if (!product || !same(product.storeId, item.storeId)) throw new AppError('The purchased product linkage is unavailable.', 409, 'REVIEW_LINKAGE_INVALID');
    const store = await affectedStore(product, {}, session);
    if (store.publicId !== item.storePublicId) throw new AppError('The purchased store linkage is unavailable.', 409, 'REVIEW_LINKAGE_INVALID');
    await noConflict(actor, { product, store }, session);
    const orderFence = await Order.updateOne({ _id: order._id, userId: actor._id, country: order.country, fulfillmentState: 'delivered', __v: order.__v || 0 }, { $inc: { __v: 1 } }, { session });
    if (orderFence.modifiedCount !== 1) throw conflict();
    const [review] = await Review.create([{ publicId: publicId('rev'), userId: actor._id, orderId: order._id, orderPublicId: order.publicId, orderLinePublicId: item.linePublicId, productId: product._id, productPublicId: product.publicId, country: order.country, rating: input.rating, title: input.title, body: input.body, verifiedPurchase: true, status: 'pending' }], { session });
    const recent = await Review.countDocuments({ userId: actor._id, createdAt: mongoose.trusted({ $gte: new Date(Date.now() - 86400_000) }) }).session(session);
    if (recent > 5) await RiskSignal.create([{ publicId: publicId('rsk'), country: actor.country, subjectType: 'user', subjectPublicId: actor.publicId, reporterUserId: actor._id, type: 'review_velocity', severity: 'medium', score: 55, evidence: [review.publicId], createdBy: 'system' }], { session });
    await queueTrustModerationAlert({ country: order.country, href: '/moderation/reviews?record=' + review.publicId }, session);
    await writeAudit(request, 'review.created', { session, actor, targetType: 'review', targetPublicId: review.publicId, country: order.country, metadata: { orderPublicId: order.publicId, orderLinePublicId: item.linePublicId } });
    return review;
  }); } catch (error) { if (error.code === 11000) throw new AppError('You already reviewed this product from this order.', 409, 'REVIEW_EXISTS'); throw error; }
}

export async function disputeOwnedReview(request, reviewId, reasonOrInput, { sellerWorkspace = false } = {}) {
  const id = idValue.parse(reviewId), input = z.object({ reason: z.string().trim().min(10).max(1000), version: versionValue.optional() }).parse(typeof reasonOrInput === 'string' ? { reason: reasonOrInput } : reasonOrInput);
  return transaction(async session => {
    const actor = await authorizeCustomerCaseActor(request, session);
    const review = await Review.findOne({ publicId: id, status: 'published' }).session(session);
    if (!review) throw new AppError('Published review not found.', 404, 'REVIEW_NOT_FOUND');
    versionCheck(review, input.version);
    const subject = await checkedReview(review, session);
    if (sellerWorkspace) {
      if (!request.store?._id) throw new AppError('Seller authentication is required.', 401, 'UNAUTHENTICATED');
      if (!same(request.store._id, subject.store._id)) throw new AppError('Store review not found.', 404, 'REVIEW_NOT_FOUND');
      if (!env.auth.simpleLogin && env.security.privilegedMfaRequired && !actor.security.mfaEnabled) throw new AppError('Authenticator enrollment is required for store operations.', 403, 'MFA_ENROLLMENT_REQUIRED');
      if (subject.store.status !== 'verified') throw new AppError('Verify this store before changing support records.', 409, 'STORE_LOCKED');
      if (subject.store.country !== review.country) await fenceCustomerCaseMarket(subject.store.country, session, subject.store.currency);
    }
    await fenceCustomerCaseMarket(review.country, session);
    const member = await StoreMember.findOne({ storeId: subject.store._id, userId: actor._id, status: 'active', role: mongoose.trusted({ $in: ['owner', 'admin', 'support'] }) }).session(session);
    if (sellerWorkspace && !member) throw new AppError('Your store role cannot manage customer support.', 403, 'STORE_PERMISSION_DENIED');
    if (!same(subject.store.ownerUserId, actor._id) && !member) throw new AppError('Published review not found for this store.', 404, 'REVIEW_NOT_FOUND');
    if (member) { const locked = await StoreMember.updateOne({ _id: member._id, status: 'active', __v: member.__v || 0 }, { $inc: { __v: 1 } }, { session }); if (locked.modifiedCount !== 1) throw conflict(); }
    const locked = await Store.updateOne({ _id: subject.store._id, ownerUserId: subject.store.ownerUserId, __v: subject.store.__v || 0, status: mongoose.trusted({ $ne: 'closed' }) }, { $inc: { __v: 1 } }, { session });
    if (locked.modifiedCount !== 1) throw new AppError('The affected store changed.', 409, 'STORE_ACCESS_CHANGED');
    review.status = 'disputed'; review.disputeReason = input.reason; review.disputedByUserId = actor._id; review.disputedAt = now(); review.assignedUserId = undefined; review.assignedAt = undefined;
    review.publicMessages.push({ author: 'seller', message: input.reason, actorUserId: actor._id }); await review.save({ session });
    await queueTrustModerationAlert({ country: review.country, href: '/moderation/reviews?record=' + review.publicId }, session);
    await writeAudit(request, 'review.disputed', { session, actor, targetType: 'review', targetPublicId: review.publicId, country: review.country, metadata: { storePublicId: subject.store.publicId } });
    await queueCountryAdminAlert({country:review.country,kind:'escalation',sourceType:'review',sourcePublicId:review.publicId},session);
    return review;
  });
}

export async function createOwnedTrustIssue(request, body) {
  const input = z.object({ type: z.enum(['counterfeit', 'prohibited_product', 'unsafe_product', 'review_manipulation', 'seller_conduct']), productId: idValue.optional(), storeId: idValue.optional(), country: z.string().regex(/^[A-Z]{2}$/).optional(), description: z.string().trim().min(10).max(2500) }).refine(row => row.productId || row.storeId, { message: 'Choose the actual product or store being reported.' }).parse(body);
  return transaction(async session => {
    const actor = await authorizeCustomerCaseActor(request, session);
    const product = input.productId ? await Product.findOne({ publicId: input.productId }).session(session) : null;
    if (input.productId && !product) throw new AppError('Product not found.', 404, 'PRODUCT_NOT_FOUND');
    const store = await Store.findOne(input.storeId ? { publicId: input.storeId } : { _id: product.storeId }).session(session);
    if (!store || product && !same(product.storeId, store._id)) throw new AppError('The selected store does not operate this product.', 422, 'TRUST_SUBJECT_MISMATCH');
    const country = input.country || request.country?.code || request.user.shoppingCountry || actor.country;
    if (!/^[A-Z]{2}$/.test(country) || product && !product.countries.includes(country) || !product && country !== store.country) throw new AppError('Choose the actual country where the subject is available.', 422, 'TRUST_COUNTRY_INVALID');
    await fenceCustomerCaseMarket(country, session);
    await noConflict(actor, { product, store }, session);
    const duplicate = await TrustCase.exists({ reporterUserId: actor._id, country, ...(product ? { productId: product._id } : { storeId: store._id }), type: input.type, status: mongoose.trusted({ $in: ['open', 'investigating', 'appealed'] }) }).session(session);
    if (duplicate) throw new AppError('You already have an active report for this concern.', 409, 'TRUST_REPORT_ALREADY_OPEN');
    const [doc] = await TrustCase.create([{ publicId: publicId('case'), reporterUserId: actor._id, country, type: input.type, productId: product?._id, productPublicId: product?.publicId, storeId: store._id, storePublicId: store.publicId, description: input.description }], { session });
    const severity = ['counterfeit', 'unsafe_product', 'prohibited_product'].includes(input.type) ? 'high' : 'medium';
    await RiskSignal.create([{ publicId: publicId('rsk'), country, subjectType: product ? 'product' : 'store', subjectPublicId: product?.publicId || store.publicId, reporterUserId: actor._id, type: 'trust_' + input.type, severity, score: severity === 'high' ? 80 : 55, evidence: [doc.publicId], createdBy: 'user' }], { session });
    await queueTrustModerationAlert({ country, href: '/moderation/risk-cases?record=' + doc.publicId }, session);
    await writeAudit(request, 'trust.report_created', { session, actor, targetType: 'trust_case', targetPublicId: doc.publicId, country, metadata: { type: doc.type, productPublicId: product?.publicId || '', storePublicId: store.publicId } });
    return doc;
  });
}

export async function appealOwnedTrustCase(request, caseId, body) {
  const id = idValue.parse(caseId), input = z.object({ version: versionValue, message: z.string().trim().min(10).max(1000) }).parse(body);
  return transaction(async session => {
    const actor = await authorizeCustomerCaseActor(request, session), doc = await TrustCase.findOne({ publicId: id, reporterUserId: actor._id }).session(session);
    if (!doc) throw new AppError('Trust case not found.', 404, 'TRUST_CASE_NOT_FOUND');
    if (doc.type === 'moderation_quality') throw new AppError('Quality findings must be reviewed in the Moderation workspace.', 403, 'TRUST_CASE_CUSTOMER_ACTION_FORBIDDEN');
    versionCheck(doc, input.version);
    if (!['actioned', 'dismissed', 'closed'].includes(doc.status) || Number(doc.appealCount || 0) >= 1) throw new AppError('This report is not eligible for another appeal.', 409, 'TRUST_APPEAL_STATE');
    await checkedCase(doc, session); await fenceCustomerCaseMarket(doc.country, session);
    doc.appealOriginalDecisionByUserId = doc.decisionByUserId || doc.assignedUserId; doc.appealMessage = input.message; doc.appealCount = Number(doc.appealCount || 0) + 1;
    doc.status = 'appealed'; doc.assignedUserId = undefined; doc.assignedAt = undefined; doc.resolvedAt = undefined;
    doc.publicMessages.push({ author: 'customer', message: input.message, actorUserId: actor._id }); await doc.save({ session });
    await queueTrustModerationAlert({ country: doc.country, href: '/moderation/risk-cases?record=' + doc.publicId }, session);
    await writeAudit(request, 'trust.case_appealed', { session, actor, targetType: 'trust_case', targetPublicId: doc.publicId, country: doc.country, metadata: { independentReviewRequired: true } });
    return doc;
  });
}

export async function customerReplyTrustCase(request, caseId, body) {
  const id = idValue.parse(caseId), input = z.object({ version: versionValue, message: z.string().trim().min(3).max(1000) }).parse(body);
  return transaction(async session => {
    const actor = await authorizeCustomerCaseActor(request, session), doc = await TrustCase.findOne({ publicId: id, reporterUserId: actor._id }).session(session);
    if (!doc) throw new AppError('Trust case not found.', 404, 'TRUST_CASE_NOT_FOUND');
    if (doc.type === 'moderation_quality') throw new AppError('Quality findings must be reviewed in the Moderation workspace.', 403, 'TRUST_CASE_CUSTOMER_ACTION_FORBIDDEN');
    versionCheck(doc, input.version); if (!['open', 'investigating', 'appealed'].includes(doc.status)) throw new AppError('Use an eligible appeal for a completed report.', 409, 'TRUST_CASE_STATE');
    await checkedCase(doc, session); await fenceCustomerCaseMarket(doc.country, session);
    if (doc.publicMessages.length >= 200) throw new AppError('This conversation has reached its message limit.', 409, 'TRUST_MESSAGE_LIMIT');
    doc.publicMessages.push({ author: 'customer', message: input.message, actorUserId: actor._id }); await doc.save({ session });
    await queueTrustModerationAlert({ country: doc.country, href: '/moderation/risk-cases?record=' + doc.publicId }, session);
    await writeAudit(request, 'trust.customer_reply', { session, actor, targetType: 'trust_case', targetPublicId: doc.publicId, country: doc.country, metadata: { visibility: 'customer' } });
    return doc;
  });
}

const KINDS = { reviews: { Model: Review, pipeline: moderationReviewPipeline, target: 'review', path: '/moderation/reviews', active: ['pending', 'disputed'] },
  cases: { Model: TrustCase, pipeline: moderationTrustCasePipeline, target: 'trust_case', path: '/moderation/risk-cases', active: ['open', 'investigating', 'appealed'] },
  signals: { Model: RiskSignal, pipeline: moderationRiskSignalPipeline, target: 'risk_signal', path: '/moderation/risk-cases', active: ['open'] } };
const ACTIONS = { reviews: ['claim', 'release', 'publish', 'reject', 'reply'], cases: ['claim', 'release', 'investigate', 'action', 'dismiss', 'close', 'reply'], signals: ['claim', 'release', 'review', 'dismiss', 'action'] };
const enforcementValue = z.enum(['none', 'suspend_product', 'restore_product', 'suspend_store', 'restore_store']);

async function sourceFor(kind, doc, session) {
  const source = kind === 'reviews' ? await checkedReview(doc, session) : kind === 'cases' ? await checkedCase(doc, session) : await checkedSignal(doc, session);
  return { ...source, reporter: kind === 'cases' ? doc.reporterUserId : source.reporter,
    buyer: kind === 'reviews' ? doc.userId : source.buyer, disputer: kind === 'reviews' ? doc.disputedByUserId : source.disputer };
}
async function independent(context, doc, source, session) {
  await noConflict(context.actor, source, session);
  if (doc.status === 'appealed' && same(doc.appealOriginalDecisionByUserId || doc.decisionByUserId || doc.assignedUserId, context.actor._id)) throw new AppError('A different reviewer must decide this appeal.', 403, 'TRUST_APPEAL_FOUR_EYES');
  for (const store of source.relatedStores || []) await noConflict(context.actor, { store }, session);
  for (const related of source.relatedCases || []) await noConflict(context.actor, { reporter: related.reporterUserId }, session);
}
async function lockSource(source, session, { readOnly = false } = {}) {
  const records = [[Order, source.order], [Product, source.product], [Store, source.store], [Review, source.review], [SupportTicket, source.ticket], [ModerationQaReview, source.qa],
    ...asArray(source.relatedStores).map(row => [Store, row])];
  const locked = new Set();
  for (const [Model, row] of records) {
    const key = row && Model.modelName + ':' + String(row._id);
    if (!row || locked.has(key)) continue;
    locked.add(key);
    // Read fences still acquire a write conflict on the exact source, while leaving its
    // saved business version and last-updated time unchanged for already-rendered forms.
    const result = await Model.updateOne({ _id: row._id, publicId: row.publicId, __v: row.__v || 0 },
      { $inc: { [readOnly ? 'moderationEvidenceReadRevision' : '__v']: 1 } }, { session, ...(readOnly ? { timestamps: false } : {}) });
    if (result.modifiedCount !== 1) throw new AppError('The underlying source changed. Reload before continuing.', 409, 'MODERATION_SOURCE_CHANGED');
    if (!readOnly) row.__v = (row.__v || 0) + 1;
  }
}
function assertGlobalScope(context, countries) {
  const codes = [...new Set(countries)];
  if (!codes.length || codes.some(code => !context.countries.some(row => row.code === code))) {
    throw new AppError('Global enforcement requires current authority over every affected selling country.', 403, 'TRUST_ENFORCEMENT_COUNTRY_FORBIDDEN');
  }
}
async function enforceSubject(request, context, doc, source, enforcement, reason, session) {
  if (enforcement === 'none') return;
  const { product, store } = source;
  if (enforcement.endsWith('_product') && !product) throw new AppError('This case has no verified product subject.', 409, 'TRUST_ENFORCEMENT_SUBJECT');
  if (enforcement.endsWith('_store') && !store) throw new AppError('This case has no verified store subject.', 409, 'TRUST_ENFORCEMENT_SUBJECT');
  const products = enforcement.endsWith('_store') ? await Product.find({ storeId: store._id }).session(session) : [product];
  assertGlobalScope(context, [...(enforcement.endsWith('_store') ? [store.country] : []), ...products.flatMap(row => row.countries)]);
  // The same transaction fences every affected market, including markets outside the selected filter.
  await fenceModerationAccess(context, session, { allMarkets: true });
  for (const row of products) {
    if (product && same(row._id, product._id)) continue;
    await noConflict(context.actor, { product: row, store }, session);
    const changed = await Product.updateOne({ _id: row._id, storeId: store._id, __v: row.__v || 0 }, { $inc: { __v: 1 } }, { session });
    if (changed.modifiedCount !== 1) throw conflict();
  }
  if (enforcement === 'suspend_product') {
    if (product.status === 'suspended') throw new AppError('This product is already suspended.', 409, 'PRODUCT_STATE');
    product.suspension = { previousStatus: product.status, reason, suspendedAt: now(), suspendedByUserId: context.actor._id };
    product.status = 'suspended'; await product.save({ session });
  } else if (enforcement === 'restore_product') {
    const previous = product.suspension?.previousStatus;
    if (product.status !== 'suspended' || !product.suspension?.suspendedAt || !product.suspension?.suspendedByUserId || !['draft', 'submitted', 'changes_requested', 'approved', 'published', 'rejected', 'archived'].includes(previous)) throw new AppError('A saved previous product state is required for restoration.', 409, 'PRODUCT_RESTORE_STATE');
    const prior = await AuditLog.findOne({ action: 'trust.product_suspended', targetType: 'product', targetPublicId: product.publicId, result: 'success', 'metadata.previousStatus': previous,
      'metadata.suspendedAt': product.suspension.suspendedAt.toISOString(), actorId: product.suspension.suspendedByUserId }).session(session);
    if (!prior) throw new AppError('The current product suspension has no matching recorded source decision.', 409, 'PRODUCT_RESTORE_STATE');
    product.status = previous; product.suspension = { previousStatus: '', reason: '' }; await product.save({ session });
  } else if (enforcement === 'suspend_store') {
    if (!['pending_verification', 'verified'].includes(store.status)) throw new AppError('Only an operating store can be suspended.', 409, 'STORE_STATE');
    const previousStatus = store.status; store.status = 'suspended'; store.suspendedAt = now(); store.suspensionReason = reason; store.suspendedByUserId = context.actor._id;
    await store.save({ session });
    await writeAudit(request, 'trust.store_suspended', { session, actor: context.actor, targetType: 'store', targetPublicId: store.publicId, country: store.country,
      metadata: { previousStatus, suspendedAt: store.suspendedAt.toISOString(), sourceCasePublicId: doc.publicId } });
    return;
  } else {
    const prior = store.suspendedAt && store.suspendedByUserId ? await AuditLog.findOne({ action: 'trust.store_suspended', targetType: 'store', targetPublicId: store.publicId, country: store.country, result: 'success',
      actorId: store.suspendedByUserId, 'metadata.suspendedAt': store.suspendedAt.toISOString() }).sort({ createdAt: -1, _id: -1 }).session(session) : null;
    if (store.status !== 'suspended' || !['pending_verification', 'verified'].includes(prior?.metadata?.previousStatus)) throw new AppError('A matching saved previous store state is required for restoration.', 409, 'STORE_RESTORE_STATE');
    store.status = prior.metadata.previousStatus; store.suspendedAt = undefined; store.suspendedByUserId = undefined; store.suspensionReason = ''; await store.save({ session });
  }
  await writeAudit(request, 'trust.' + enforcement.replace(/^(suspend|restore)_(product|store)$/, (_whole, operation, subject) => subject + '_' + (operation === 'suspend' ? 'suspended' : 'restored')),
    { session, actor: context.actor, targetType: enforcement.endsWith('_product') ? 'product' : 'store', targetPublicId: enforcement.endsWith('_product') ? product.publicId : store.publicId,
      country: doc.country, metadata: { sourceCasePublicId: doc.publicId, ...(enforcement === 'suspend_product' ? { previousStatus: product.suspension.previousStatus, suspendedAt: product.suspension.suspendedAt.toISOString() } : {}) } });
}
async function noticeParticipants(kind, doc, source, reason, session) {
  const customer = kind === 'reviews' ? doc.userId : kind === 'cases' ? doc.reporterUserId : doc.reporterUserId || source.buyer;
  await notifyUser(customer, doc.country, 'Moderation update', `${doc.publicId}: ${reason}`.slice(0, 1500), '/returns', session);
  const stores = [source.store, ...asArray(source.relatedStores)].filter(Boolean);
  const recipients = new Set();
  for (const store of stores) {
    const members = await StoreMember.find({ storeId: store._id, status: 'active', role: mongoose.trusted({ $in: ['owner', 'admin', 'support'] }) }).select('userId').session(session);
    for (const userId of [store.ownerUserId, ...members.map(row => row.userId)]) {
      if (!userId || recipients.has(String(userId)) || same(userId, customer)) continue;
      recipients.add(String(userId));
      await notifyUser(userId, doc.country, 'Store moderation update', `${doc.publicId}: ${reason}`.slice(0, 1500), kind === 'reviews' ? '/seller/reviews' : '/seller/settings', session);
    }
  }
}

/** All page actions require the saved version and an independently owned claim. */
export async function moderationTrustAction(request, kind, recordId, body, { workspace = true, requireClaim = true } = {}) {
  const config = KINDS[kind];
  if (!config) throw new AppError('Moderation record type not found.', 404, 'MODERATION_RECORD_NOT_FOUND');
  const id = idValue.parse(recordId), input = z.object({ action: z.enum(ACTIONS[kind]), version: requireClaim ? versionValue : versionValue.optional(),
    reason: z.string().trim().max(kind === 'reviews' ? 500 : 1000).optional(), message: z.string().trim().max(1000).optional(), enforcement: enforcementValue.default('none') }).parse(body);
  if (input.enforcement !== 'none' && (kind !== 'cases' || input.action !== 'action')) throw new AppError('Enforcement requires an actioned trust case.', 422, 'TRUST_ENFORCEMENT_STATE');
  return transaction(async session => {
    const context = await moderationAccess(request, { session, workspace }), doc = await config.Model.findOne(mongoose.trusted({ $and: [context.countryScope, { publicId: id }] })).session(session);
    if (!doc) throw new AppError('Moderation record not found.', 404, 'MODERATION_RECORD_NOT_FOUND');
    versionCheck(doc, input.version);
    const source = await sourceFor(kind, doc, session);
    if (request.requiredOperationalWorkspace === 'admin' && source.store
      && !context.countries.some(market => market.code === source.store.country)) {
      throw new AppError('The current source store is outside your country administration scope.', 403, 'COUNTRY_ADMIN_SOURCE_COUNTRY_FORBIDDEN');
    }
    await independent(context, doc, source, session);
    if (!config.active.includes(doc.status)) throw new AppError('This record already has a recorded outcome.', 409, kind === 'reviews' ? 'REVIEW_STATE' : kind === 'cases' ? 'TRUST_CASE_STATE' : 'RISK_STATE');
    assignedToActor(doc, context.actor, !['claim', 'release'].includes(input.action) && requireClaim);
    if (input.action === 'release' && !same(doc.assignedUserId, context.actor._id)) throw new AppError('Only the current reviewer can release this claim.', 409, 'MODERATION_CLAIM_REQUIRED');
    if (input.action === 'claim' && doc.assignedUserId) throw new AppError('This record already has a reviewer claim.', 409, 'MODERATION_CLAIM_REQUIRED');
    if (doc.assignmentHistory.length >= 1000 || doc.decisionHistory.length >= 1000) throw new AppError('This case has reached its action history limit.', 409, 'MODERATION_HISTORY_LIMIT');
    const reason = ['claim', 'release'].includes(input.action) ? '' : text(input.action === 'reply' ? input.message : input.reason, input.action === 'reply' ? 1000 : kind === 'reviews' ? 500 : 1000);
    await fenceModerationAccess(context, session); await lockSource(source, session);
    let auditAction;
    if (input.action === 'claim' || input.action === 'release') {
      doc.assignedUserId = input.action === 'claim' ? context.actor._id : undefined; doc.assignedAt = input.action === 'claim' ? now() : undefined;
      doc.assignmentHistory.push({ action: input.action, actorUserId: context.actor._id });
      auditAction = kind === 'reviews' ? 'review.' + (input.action === 'claim' ? 'claimed' : 'released') : 'trust.' + (kind === 'cases' ? 'case_' : 'risk_signal_') + (input.action === 'claim' ? 'claimed' : 'released');
    } else {
      if (!doc.assignedUserId) { doc.assignedUserId = context.actor._id; doc.assignedAt = now(); doc.assignmentHistory.push({ action: 'claim', actorUserId: context.actor._id }); }
      if (input.action === 'reply') {
        if (doc.publicMessages.length >= 200) throw new AppError('This conversation has reached its message limit.', 409, 'TRUST_MESSAGE_LIMIT');
        doc.publicMessages.push({ author: 'moderation', message: reason, actorUserId: context.actor._id });
        auditAction = kind === 'reviews' ? 'review.public_reply' : 'trust.public_reply';
      } else if (kind === 'reviews') {
        doc.status = input.action === 'publish' ? 'published' : 'rejected'; doc.moderationReason = reason; doc.moderatedByUserId = context.actor._id; doc.moderatedAt = now();
        doc.publishedAt = doc.status === 'published' ? now() : undefined;
        doc.publicMessages.push({ author: 'moderation', message: reason, actorUserId: context.actor._id }); auditAction = 'review.moderated';
      } else if (kind === 'cases') {
        await enforceSubject(request, context, doc, source, input.enforcement, reason, session);
        doc.status = { investigate: 'investigating', action: 'actioned', dismiss: 'dismissed', close: 'closed' }[input.action]; doc.decision = reason;
        doc.decisionByUserId = context.actor._id; doc.decisionAt = now(); doc.resolvedAt = ['actioned', 'dismissed', 'closed'].includes(doc.status) ? now() : undefined;
        doc.publicMessages.push({ author: 'moderation', message: reason, actorUserId: context.actor._id }); auditAction = 'trust.case_reviewed';
      } else {
        doc.status = { review: 'reviewed', dismiss: 'dismissed', action: 'actioned' }[input.action]; doc.decision = reason;
        doc.reviewedByUserId = context.actor._id; doc.reviewedAt = now(); auditAction = 'trust.risk_signal_reviewed';
      }
      if (input.action !== 'reply') doc.decisionHistory.push({ action: input.action, status: doc.status, actorUserId: context.actor._id, reason });
      await noticeParticipants(kind, doc, source, reason, session);
    }
    await doc.save({ session });
    await writeAudit(request, auditAction, { session, actor: context.actor, targetType: config.target, targetPublicId: doc.publicId, country: doc.country,
      metadata: { status: doc.status, action: input.action, ...(kind === 'reviews' && ['publish', 'reject'].includes(input.action) ? { decision: input.action } : {}),
        version: doc.__v, enforcement: input.enforcement, ...(reason ? { reason } : {}), appealReview: Boolean(doc.appealCount) } });
    return doc;
  });
}

async function sourceCountryRequest(request, kind, rawId) {
  const id = idValue.parse(rawId), row = await KINDS[kind].Model.findOne({ publicId: id }).select('country').lean();
  if (!row) throw new AppError('Moderation record not found.', 404, 'MODERATION_RECORD_NOT_FOUND');
  const scoped = Object.create(request);
  Object.defineProperty(scoped, 'query', { value: { ...request.query, country: row.country }, enumerable: true, configurable: true, writable: true });
  return scoped;
}
export async function moderateVerifiedReview(request, id, input) {
  const scoped = await sourceCountryRequest(request, 'reviews', id);
  return moderationTrustAction(scoped, 'reviews', id, { action: input.decision, reason: input.reason, version: input.version }, { workspace: false, requireClaim: false });
}
export async function moderateTrustCase(request, doc, input) {
  const id = doc?.publicId || doc, scoped = await sourceCountryRequest(request, 'cases', id);
  return moderationTrustAction(scoped, 'cases', id, { action: { investigating: 'investigate', actioned: 'action', dismissed: 'dismiss', closed: 'close' }[input.status], reason: input.decision, enforcement: input.enforcement || 'none', version: input.version ?? doc?.__v }, { workspace: false, requireClaim: false });
}
export async function moderateRiskSignal(request, doc, input) {
  const id = doc?.publicId || doc, scoped = await sourceCountryRequest(request, 'signals', id);
  return moderationTrustAction(scoped, 'signals', id, { action: { reviewed: 'review', dismissed: 'dismiss', actioned: 'action' }[input.status], reason: input.decision, version: input.version ?? doc?.__v }, { workspace: false, requireClaim: false });
}

function moderatorDto(row, actor) {
  const assignment = !row.assignedUserId ? 'Unassigned' : same(row.assignedUserId, actor._id) ? 'Assigned to you' : 'Assigned to another reviewer';
  const history = entries => asArray(entries).map(entry => ({ action: entry.action, status: entry.status, reason: entry.reason || '', at: entry.at,
    actor: same(entry.actorUserId, actor._id) ? 'You' : 'Another reviewer' }));
  return { publicId: row.publicId, country: row.country, status: row.status, version: Number(row.__v || 0), assignment,
    assignedToMe: Boolean(row.assignedUserId && same(row.assignedUserId, actor._id)), assigned: Boolean(row.assignedUserId),
    productPublicId: row.productPublicId || '', storePublicId: row.storePublicId || '', orderPublicId: row.orderPublicId || '',
    rating: row.rating, title: row.title || '', body: row.body || '', type: row.type || '', description: row.description || '',
    subjectType: row.subjectType || '', subjectPublicId: row.subjectPublicId || '', severity: row.severity || '', score: row.score,
    verifiedPurchase: Boolean(row.verifiedPurchase), decision: row.decision || '', moderationReason: row.moderationReason || '', disputeReason: row.disputeReason || '',
    createdAt: row.createdAt, updatedAt: row.updatedAt, resolvedAt: row.resolvedAt || null, publishedAt: row.publishedAt || null,
    appealMessage: row.appealMessage || '', appealCount: Number(row.appealCount || 0), qaReviewPublicId: row.qaReviewPublicId || '', reviewPublicId: row.reviewPublicId || '',
    assignmentHistory: history(row.assignmentHistory), decisionHistory: history(row.decisionHistory),
    publicMessages: asArray(row.publicMessages).map(message => ({ author: message.author, message: message.message, at: message.at })) };
}
async function caseEvidence(doc, session = null) {
  const clauses = [{ ownerUserId: doc.reporterUserId, contextType: 'trust_case', contextPublicId: doc.publicId }];
  if (doc.supportTicketId) {
    const ticket = await SupportTicket.findOne({ _id: doc.supportTicketId, publicId: doc.supportTicketPublicId, country: doc.country }).session(session);
    if (ticket?.userId) clauses.push({ ownerUserId: ticket.userId, contextType: 'support', contextPublicId: ticket.publicId, _id: mongoose.trusted({ $in: ticket.evidenceDocumentIds || [] }) });
  }
  return EvidenceDocument.find(mongoose.trusted({ $and: [{ _id: { $in: doc.evidenceDocumentIds || [] }, country: doc.country, status: 'ready' }, { $or: clauses }] }))
    .select('publicId description mimeType createdAt').sort({ createdAt: 1, _id: 1 }).session(session).lean();
}
async function selectedTrustRecord(request, context, kind, id) {
  const config = KINDS[kind], [valid] = await config.Model.aggregate([...config.pipeline(context, { record: id }), { $limit: 1 }]);
  if (!valid) throw new AppError('Moderation record not found.', 404, 'MODERATION_RECORD_NOT_FOUND');
  const doc = await config.Model.findById(valid._id), source = await sourceFor(kind, doc, null);
  let independenceReason = '';
  try { await independent(context, doc, source, null); }
  catch (error) { if (!['MODERATION_CONFLICT_OF_INTEREST', 'TRUST_APPEAL_FOUR_EYES'].includes(error.code)) throw error; independenceReason = error.message; }
  const product = source.product ? { publicId: source.product.publicId, title: source.product.title, countries: [...source.product.countries], status: source.product.status } : null;
  const store = source.store ? { publicId: source.store.publicId, name: source.store.name, country: source.store.country, status: source.store.status } : null;
  const allProducts = store ? await Product.find({ storeId: source.store._id }).select('countries ownerUserId').lean() : [];
  const countries = new Set(context.countries.map(row => row.code));
  return { kind, record: moderatorDto(doc.toObject(), context.actor), product, store,
    order: source.order ? { publicId: source.order.publicId, fulfillmentState: source.order.fulfillmentState } : null,
    sourceReview: source.review ? customerReviewDto(source.review) : null,
    qa: source.qa ? { publicId: source.qa.publicId, targetType: source.qa.targetType, targetPublicId: source.qa.targetPublicId, decision: source.qa.decision, decisionReason: source.qa.decisionReason, outcome: source.qa.outcome, note: source.qa.note } : null,
    relatedConcerns: asArray(source.relatedCases).map(row => ({ publicId: row.publicId, type: row.type, status: row.status })),
    evidence: kind === 'cases' ? await caseEvidence(doc) : [],
    canAct: !independenceReason && config.active.includes(doc.status), independenceReason,
    canEnforceProduct: !independenceReason && Boolean(product && product.countries.every(code => countries.has(code))),
    canEnforceStore: !independenceReason && Boolean(store && countries.has(store.country) && allProducts.every(row => row.countries.every(code => countries.has(code)) && !same(row.ownerUserId, context.actor._id))) };
}
function trustQuery(request, pageId) {
  const query = z.object({ kind: z.enum(['cases', 'signals']).default('cases'), search: z.string().trim().max(100).default(''),
    status: z.string().max(30).default('all'), assignment: z.enum(['all', 'mine', 'unassigned']).default('all'),
    after: z.string().max(512).default(''), record: idValue.optional() }).parse(request.query || {});
  const kind = pageId === 'moderator-reviews' ? 'reviews' : query.kind;
  const statuses = kind === 'reviews' ? ['all', 'pending', 'disputed', 'published', 'rejected'] : kind === 'cases' ? ['all', 'open', 'investigating', 'appealed', 'actioned', 'dismissed', 'closed'] : ['all', 'open', 'reviewed', 'dismissed', 'actioned'];
  if (!statuses.includes(query.status) || query.after && !decodeCursor(query.after)) throw new AppError('Select a valid record status or page cursor.', 422, 'MODERATION_FILTER_INVALID');
  return { ...query, kind, statuses };
}

export async function loadModerationTrustPage(request, pageId) {
  if (!['moderator-reviews', 'moderator-disputes'].includes(pageId)) throw new AppError('Moderation page not found.', 404, 'MODERATION_PAGE_NOT_FOUND');
  const context = await moderationAccess(request), query = trustQuery(request, pageId), config = KINDS[query.kind];
  const listFilters = { ...query }; delete listFilters.record;
  const pipeline = config.pipeline(context, listFilters);
  const [result] = await config.Model.aggregate([...pipeline, { $facet: {
    records: [{ $match: cursorScope({}, query.after) }, { $sort: cursorSort() }, { $limit: SIZE + 1 }],
    counts: [{ $group: { _id: null, total: { $sum: 1 }, active: { $sum: { $cond: [{ $in: ['$status', config.active] }, 1, 0] } },
      unassigned: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$assignedUserId', null] }, null] }, 1, 0] } },
      mine: { $sum: { $cond: [{ $eq: ['$assignedUserId', context.actor._id] }, 1, 0] } } } }],
  } }]);
  const stats = result.counts[0] || { total: 0, active: 0, unassigned: 0, mine: 0 }, paged = pageResult(result.records, { limit: SIZE, total: stats.total });
  const params = { country: context.country, ...(query.kind === 'reviews' ? {} : { kind: query.kind }), assignment: query.assignment, status: query.status, search: query.search };
  const link = extra => config.path + '?' + new URLSearchParams({ ...params, ...extra });
  const columns = query.kind === 'reviews' ? ['Review', 'Product', 'Rating', 'Country', 'Assignment', 'Status'] : query.kind === 'cases' ? ['Case', 'Concern', 'Subject', 'Country', 'Assignment', 'Status'] : ['Signal', 'Risk', 'Subject', 'Country', 'Assignment', 'Status'];
  const rows = paged.items.map(row => { const record = moderatorDto(row, context.actor); return { id: record.publicId, record,
    cells: query.kind === 'reviews' ? [record.publicId, row.sourceProduct.title, String(record.rating) + '/5', record.country, record.assignment, label(record.status)]
      : query.kind === 'cases' ? [record.publicId, label(record.type), row.sourceProduct?.title || row.sourceStore?.name || '', record.country, record.assignment, label(record.status)]
        : [record.publicId, label(record.severity) + ' · ' + record.score, record.subjectPublicId, record.country, record.assignment, label(record.status)], href: link({ record: record.publicId }) }; });
  const selected = query.record ? await selectedTrustRecord(request, context, query.kind, query.record) : null;
  await assertModerationReadAccess(request, context);
  return { kind: 'trust', recordKind: query.kind, context: moderationPublicContext(context), country: context.country, selected, rows, columns,
    records: rows.map(row => row.record), page: paged.page, filters: { ...query, statuses: query.statuses.map(value => ({ value, label: label(value) })), params },
    kindLinks: query.kind === 'reviews' ? [] : ['cases', 'signals'].map(kind => ({ kind, label: kind === 'cases' ? 'Customer concerns' : 'Risk signals', href: config.path + '?' + new URLSearchParams({ country: context.country, kind }) })),
    metrics: [{ label: 'Matching records', value: stats.total, detail: 'Verified current source links' }, { label: 'Awaiting review', value: stats.active, detail: 'Active records in this view' },
      { label: 'Unassigned', value: stats.unassigned, detail: 'Ready for an independent claim' }, { label: 'Assigned to you', value: stats.mine, detail: 'Current saved claims' }],
    tableTitle: query.kind === 'reviews' ? 'Verified purchase review queue' : query.kind === 'cases' ? 'Customer trust concerns' : 'Recorded risk signals',
    tableDescription: 'Current records with verified subject links within your assigned countries.', exportHref: config.path + '/export.csv?' + new URLSearchParams(params),
    emptyText: 'No verified records match this view.', insights: [{ text: stats.unassigned + ' matching records have no reviewer.', href: link({ assignment: 'unassigned' }), label: 'Review unassigned records' }],
    health: { label: 'Review queue', value: null, rows: [{ label: 'Awaiting review', value: stats.active }, { label: 'Assigned to you', value: stats.mine }], note: 'Counts use current record status and saved ownership.' },
    workflow: [{ title: 'Check source evidence', text: 'Verify the original purchase or actual product and store.' }, { title: 'Claim independently', text: 'Affected buyers, reporters and store staff cannot own a decision.' },
      { title: 'Record the outcome', text: 'The decision, public explanation, participant notices and audit save together.' }], activityHref: '/moderation/audit' };
}

/** Private evidence must remain attached to a source-verified case in the current scope. */
export async function authorizeModerationTrustEvidence(request, evidenceId, { session = null, write = false, expectedStorageKey } = {}) {
  const context = await moderationAccess(request, { session }), id = idValue.parse(evidenceId);
  const evidence = await EvidenceDocument.findOne({ publicId: id, status: 'ready', contextType: mongoose.trusted({ $in: ['trust_case', 'support'] }), ...context.countryScope }).select('+storageKey').session(session);
  if (!evidence) throw new AppError('Evidence not found.', 404, 'EVIDENCE_NOT_FOUND');
  if (expectedStorageKey !== undefined && evidence.storageKey !== expectedStorageKey) throw new AppError('Evidence changed while loading. Reload this document.', 409, 'MODERATION_EVIDENCE_CHANGED');
  const doc = await TrustCase.findOne({ country: evidence.country, evidenceDocumentIds: evidence._id, ...(evidence.contextType === 'trust_case'
    ? { publicId: evidence.contextPublicId, reporterUserId: evidence.ownerUserId } : { supportTicketPublicId: evidence.contextPublicId }) }).session(session);
  if (!doc) throw new AppError('Evidence not found.', 404, 'EVIDENCE_NOT_FOUND');
  const source = await sourceFor('cases', doc, session);
  if (evidence.contextType === 'support' && (!source.ticket || !same(source.ticket.userId, evidence.ownerUserId) || !source.ticket.evidenceDocumentIds.some(value => same(value, evidence._id)))) throw new AppError('Evidence not found.', 404, 'EVIDENCE_NOT_FOUND');
  await independent(context, doc, source, session);
  if (write) {
    await fenceModerationAccess(context, session); await lockSource(source, session, { readOnly: true });
    const lockedCase = await TrustCase.updateOne({ _id: doc._id, publicId: doc.publicId, country: evidence.country, evidenceDocumentIds: evidence._id, __v: doc.__v || 0 }, { $inc: { moderationEvidenceReadRevision: 1 } }, { session, timestamps: false });
    const lockedEvidence = await EvidenceDocument.updateOne({ _id: evidence._id, status: 'ready', country: evidence.country, contextType: evidence.contextType,
      contextPublicId: evidence.contextPublicId, ownerUserId: evidence.ownerUserId, storageKey: evidence.storageKey, __v: evidence.__v || 0 }, { $inc: { moderationEvidenceReadRevision: 1 } }, { session, timestamps: false });
    if (lockedCase.modifiedCount !== 1 || lockedEvidence.modifiedCount !== 1) throw new AppError('The attached evidence changed while loading.', 409, 'MODERATION_EVIDENCE_CHANGED');
    await writeAudit(request, 'moderation.trust_evidence_accessed', { session, actor: context.actor, targetType: 'trust_case', targetPublicId: doc.publicId, country: doc.country, metadata: { evidencePublicId: evidence.publicId } });
  } else await assertModerationReadAccess(request, context);
  return evidence;
}
export const recordModerationTrustEvidenceAccess = (request, evidenceId, expectedStorageKey) => transaction(session => authorizeModerationTrustEvidence(request, evidenceId, { session, write: true, expectedStorageKey }));
const csvCell = value => { let cell = String(value ?? ''); if (/^[\s\u0000-\u001f]*[=+@-]/.test(cell)) cell = "'" + cell; return '"' + cell.replaceAll('"', '""') + '"'; };
async function streamChunk(response, content) {
  if (response.destroyed || response.writableEnded) return false;
  if (!content || response.write(content)) return true;
  return new Promise((resolve, reject) => {
    const cleanup = () => { response.off('drain', drained); response.off('close', closed); response.off('error', failed); };
    const drained = () => { cleanup(); resolve(true); }, closed = () => { cleanup(); resolve(false); }, failed = error => { cleanup(); reject(error); };
    response.once('drain', drained); response.once('close', closed); response.once('error', failed);
    if (response.destroyed || response.writableEnded) closed();
  });
}
export async function streamModerationTrustCsv(request, response, pageId) {
  const context = await moderationAccess(request), pageRequest = { ...request, query: { ...request.query, after: '', record: undefined } };
  let flow = await loadModerationTrustPage(pageRequest, pageId);
  await transaction(async session => {
    const current = await moderationAccess(request, { session, country: context.country }); await fenceModerationAccess(current, session);
    await writeAudit(request, 'moderation.report_exported', { session, actor: current.actor, targetType: 'moderation_report', country: current.country || current.countries[0].code, metadata: { report: flow.recordKind } });
  });
  await assertModerationReadAccess(request, context);
  response.type('text/csv').set('Content-Disposition', 'attachment; filename="classic-mart-moderation-trust.csv"');
  if (!await streamChunk(response, flow.columns.map(csvCell).join(',') + '\r\n')) return;
  while (!response.destroyed && !response.writableEnded) {
    for (const row of flow.rows) {
      await assertModerationReadAccess(request, context);
      if (!await streamChunk(response, row.cells.map(csvCell).join(',') + '\r\n')) return;
    }
    if (!flow.page.hasMore) break;
    pageRequest.query.after = flow.page.next; flow = await loadModerationTrustPage(pageRequest, pageId);
  }
  if (!response.destroyed && !response.writableEnded) response.end();
}

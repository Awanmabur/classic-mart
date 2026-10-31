import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { CountrySetting, Dispute, Order, SatisfactionSurvey, SupportTicket } from '../models/index.js';
import { writeAudit } from './audit.js';
import { queueSupportAlert } from './support-notifications.js';
import { currentCustomerAccess } from './customer-access.js';

const terminal = ['resolved', 'rejected', 'closed'];
const recordId = z.string().trim().min(4).max(100);
const version = z.union([z.number(), z.string().regex(/^\d+$/)])
  .pipe(z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const categories = ['payment', 'delivery', 'item_missing', 'wrong_item', 'damaged', 'counterfeit', 'refund', 'seller_conduct', 'other'];

/** Explicit customer projection: internal events and staff identities never leave the service. */
export function customerDisputeDto(document) {
  const row = document?.toObject ? document.toObject() : document;
  if (!row) return null;
  return {
    publicId: row.publicId, orderPublicId: row.orderPublicId, country: row.country,
    category: row.category, status: row.status, subject: row.subject,
    description: row.description, priority: row.priority,
    createdAt: row.createdAt, updatedAt: row.updatedAt, resolvedAt: row.resolvedAt || null,
    version: Number(row.__v ?? row.version ?? 0),
    events: (row.events || []).filter(event => event.visibility !== 'internal').map(event => ({
      type: event.type, message: event.message, at: event.at, visibility: 'customer',
      author: String(event.actorUserId || '') === String(row.userId || '') ? 'You' : 'Support',
    })),
    resolution: row.resolution?.decision ? {
      decision: row.resolution.decision, summary: row.resolution.summary || '',
      resolvedAt: row.resolution.resolvedAt || row.resolvedAt || null,
    } : null,
  };
}

export function customerSatisfactionDto(document) {
  const row = document?.toObject ? document.toObject() : document;
  if (!row) return null;
  return { publicId: row.publicId, ticketPublicId: row.ticketPublicId, country: row.country,
    rating: row.rating, comment: row.comment || '', createdAt: row.createdAt, updatedAt: row.updatedAt };
}

async function transaction(work) {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => { result = await work(session); });
    return result;
  } finally { await session.endSession(); }
}

async function currentOwner(request, session) {
  return currentCustomerAccess(request, { session, write: true });
}

async function fenceMarket(country, session, currency) {
  const market = await CountrySetting.findOne({ code: country, active: true }).session(session);
  if (!market || currency && market.currency !== currency) {
    throw new AppError('The source support market is unavailable.', 409, 'CUSTOMER_SUPPORT_MARKET_UNAVAILABLE');
  }
  const fenced = await CountrySetting.updateOne({ _id: market._id, active: true, __v: market.__v || 0,
    currency: market.currency, timeZone: market.timeZone }, { $inc: { __v: 1 } }, { session });
  if (fenced.modifiedCount !== 1) throw new AppError('The support market changed. Reload before continuing.', 409, 'CUSTOMER_SUPPORT_MARKET_CHANGED');
}
export { currentOwner as authorizeCustomerCaseActor, fenceMarket as fenceCustomerCaseMarket };

async function ownerOrder(actor, query, session) {
  const order = await Order.findOne({ ...query, userId: actor._id }).session(session);
  if (!order) throw new AppError('Order not found.', 404, 'ORDER_NOT_FOUND');
  await fenceMarket(order.country, session, order.totals.currency);
  const fenced = await Order.updateOne({ _id: order._id, publicId: order.publicId, userId: actor._id,
    country: order.country, __v: order.__v || 0 }, { $inc: { __v: 1 } }, { session });
  if (fenced.modifiedCount !== 1) throw new AppError('The original order changed. Reload before continuing.', 409, 'CUSTOMER_SUPPORT_ORDER_CHANGED');
  return order;
}

export async function createOwnedDispute(request, body) {
  const input = z.object({ orderId: recordId, category: z.enum(categories),
    subject: z.string().trim().min(4).max(180), description: z.string().trim().min(10).max(3000) }).parse(body);
  return transaction(async session => {
    const actor = await currentOwner(request, session);
    const order = await ownerOrder(actor, { publicId: input.orderId }, session);
    const existing = await Dispute.exists({ orderId: order._id, orderPublicId: order.publicId,
      userId: actor._id, country: order.country, category: input.category,
      status: mongoose.trusted({ $nin: terminal }) }).session(session);
    if (existing) throw new AppError('A similar dispute is already open for this order.', 409, 'DISPUTE_ALREADY_OPEN');
    const [dispute] = await Dispute.create([{ publicId: publicId('dsp'), userId: actor._id,
      orderId: order._id, orderPublicId: order.publicId, country: order.country,
      category: input.category, subject: input.subject, description: input.description,
      priority: ['counterfeit', 'payment'].includes(input.category) ? 'high' : 'normal',
      events: [{ type: 'dispute.opened', message: input.description.slice(0, 1000), visibility: 'customer', actorUserId: actor._id }],
    }], { session });
    await queueSupportAlert({ country: order.country, kind: 'priority',
      href: '/support/escalations?record=' + encodeURIComponent(dispute.publicId) }, session);
    await writeAudit(request, 'customer.dispute_created', { actor, targetType: 'dispute',
      targetPublicId: dispute.publicId, country: order.country, metadata: { category: input.category }, session });
    return dispute;
  });
}

export async function appealOwnedDispute(request, disputeId, body) {
  const id = recordId.parse(disputeId);
  const input = z.object({ version, message: z.string().trim().min(10).max(1000) }).parse(body);
  return transaction(async session => {
    const actor = await currentOwner(request, session);
    const dispute = await Dispute.findOne({ publicId: id, userId: actor._id }).session(session);
    if (!dispute) throw new AppError('Dispute not found.', 404, 'DISPUTE_NOT_FOUND');
    if (Number(dispute.__v || 0) !== input.version) throw new AppError('This dispute changed. Reload its latest decision.', 409, 'CUSTOMER_DISPUTE_VERSION_CONFLICT');
    if (!terminal.includes(dispute.status)) throw new AppError('This dispute already has an active investigation.', 409, 'DISPUTE_STATE');
    if (dispute.events.length >= 1000) throw new AppError('This case has reached its message limit. Contact Support for its next step.', 409, 'DISPUTE_THREAD_LIMIT');
    await ownerOrder(actor, { _id: dispute.orderId, publicId: dispute.orderPublicId, country: dispute.country }, session);
    const activeSibling = await Dispute.exists({ _id: mongoose.trusted({ $ne: dispute._id }),
      orderId: dispute.orderId, orderPublicId: dispute.orderPublicId, userId: actor._id,
      country: dispute.country, category: dispute.category, status: mongoose.trusted({ $nin: terminal }) }).session(session);
    if (activeSibling) throw new AppError('A similar dispute already has an active investigation.', 409, 'DISPUTE_ALREADY_OPEN');
    dispute.status = 'appealed';
    dispute.resolvedAt = undefined;
    // Release the former reviewer so the appeal can receive independent review.
    dispute.assignedUserId = undefined;
    dispute.review = undefined;
    dispute.escalation = undefined;
    dispute.events.push({ type: 'dispute.appealed', message: input.message, actorUserId: actor._id, visibility: 'customer' });
    dispute.increment();
    await dispute.save({ session });
    await queueSupportAlert({ country: dispute.country, kind: 'escalation',
      href: '/support/escalations?record=' + encodeURIComponent(dispute.publicId) }, session);
    await writeAudit(request, 'customer.dispute_appealed', { actor, targetType: 'dispute',
      targetPublicId: dispute.publicId, country: dispute.country, metadata: { version: dispute.__v }, session });
    return customerDisputeDto(dispute);
  });
}

export async function submitOwnedSatisfaction(request, ticketPublicId, body) {
  const id = recordId.parse(ticketPublicId);
  const input = z.object({ rating: z.coerce.number().int().min(1).max(5),
    comment: z.string().trim().max(1000).default('') }).parse(body);
  return transaction(async session => {
    const actor = await currentOwner(request, session);
    const ticket = await SupportTicket.findOne({ publicId: id, userId: actor._id,
      status: mongoose.trusted({ $in: ['resolved', 'closed'] }) }).session(session);
    if (!ticket) throw new AppError('Resolved support ticket not found.', 404, 'TICKET_NOT_FOUND');
    if (ticket.orderId || ticket.orderPublicId) {
      if (!ticket.orderId || !ticket.orderPublicId) throw new AppError('The ticket does not match its original order.', 409, 'SATISFACTION_TICKET_MISMATCH');
      await ownerOrder(actor, { _id: ticket.orderId, publicId: ticket.orderPublicId, country: ticket.country }, session);
    } else await fenceMarket(ticket.country, session);
    const fenced = await SupportTicket.updateOne({ _id: ticket._id, publicId: ticket.publicId, userId: actor._id,
      country: ticket.country, status: ticket.status, __v: ticket.__v || 0 }, { $inc: { __v: 1 } }, { session });
    if (fenced.modifiedCount !== 1) throw new AppError('The conversation changed. Reload before rating it.', 409, 'SATISFACTION_TICKET_CHANGED');
    let survey = await SatisfactionSurvey.findOne({ ticketId: ticket._id, userId: actor._id }).session(session);
    if (survey) {
      if (survey.ticketPublicId !== ticket.publicId || survey.country !== ticket.country) {
        throw new AppError('The saved rating does not match this conversation.', 409, 'SATISFACTION_TICKET_MISMATCH');
      }
      survey.rating = input.rating;
      survey.comment = input.comment;
      await survey.save({ session });
    } else {
      [survey] = await SatisfactionSurvey.create([{ publicId: publicId('sat'), ticketId: ticket._id,
        ticketPublicId: ticket.publicId, country: ticket.country, userId: actor._id,
        rating: input.rating, comment: input.comment }], { session });
    }
    await writeAudit(request, 'customer.support_satisfaction_submitted', { actor, targetType: 'support_ticket',
      targetPublicId: ticket.publicId, country: ticket.country, metadata: { rating: input.rating }, session });
    return survey;
  });
}

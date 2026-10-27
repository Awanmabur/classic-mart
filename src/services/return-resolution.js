import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { Notification, Order, Refund, ReturnRequest } from '../models/index.js';
import { currentCustomerAccess } from './customer-access.js';
import { fenceCustomerCaseMarket } from './customer-dispute-pages.js';
import { supportAccess, fenceSupportAccess } from './support-workspace-access.js';
import { returnFinancialAllocations } from './support-case-pages.js';
import { refreshOrderLifecycle } from './order-state.js';
import { queueSupportAlert } from './support-notifications.js';
import { writeAudit } from './audit.js';
import { assertAftersalesMfa } from './aftersales-access.js';
import { returnResolutionSource } from './return-resolution-source.js';

const version = z.union([z.number(), z.string().regex(/^\d+$/)]).pipe(z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const id = z.string().regex(/^[a-z][a-z0-9_-]{4,99}$/);
const equal = (a, b) => String(a || '') === String(b || '');
const changed = () => new AppError('This return changed. Reload its latest details.', 409, 'RETURN_RESOLUTION_CHANGED');

async function transaction(work) {
  const session = await mongoose.startSession();
  try { return await session.withTransaction(() => work(session)); }
  catch (error) { if (error.name === 'VersionError') throw changed(); throw error; }
  finally { await session.endSession(); }
}

async function refundSource(row, order, session) {
  if (row.resolution !== 'exchange' || row.status !== 'exchange_pending' || row.replacementOrderPublicId || row.refundPublicId || row.financeReferral?.requestedAt) {
    throw new AppError('Only an inspected exchange without a replacement or refund can be changed.', 409, 'RETURN_RESOLUTION_STATE');
  }
  // Reuse the Finance receipt/inspection validation without changing the saved
  // exchange. Consent, rather than a speculative status write, changes it.
  const snapshot = { ...row.toObject(), resolution: 'refund', status: 'refund_pending' };
  const financial = await returnFinancialAllocations({ returnRequest: snapshot, order, session, requireReferral: false });
  const { intent, hash } = await returnResolutionSource(row, order, financial, { session, fence: true });
  if (!['succeeded', 'partially_refunded'].includes(intent.status) || !['paid', 'partially_refunded'].includes(order.paymentState)) throw new AppError('The original payment must be verified before offering a refund.', 409, 'RETURN_RESOLUTION_PAYMENT_REQUIRED');
  const refunds = await Refund.find({ paymentIntentId: intent._id, orderId: order._id, status: { $in: ['pending', 'processing', 'completed'] } }).select('amountMinor allocations currency status').session(session).lean();
  if (refunds.some(refund => refund.currency !== order.totals.currency) || refunds.reduce((sum, refund) => sum + refund.amountMinor, 0) + financial.amountMinor > intent.amountMinor) {
    throw new AppError('The original payment no longer has that refundable amount.', 409, 'RETURN_RESOLUTION_PAYMENT_CHANGED');
  }
  for (const allocation of financial.allocations) {
    const sameLine = line => line.orderLineId === allocation.orderLineId && line.storePublicId === allocation.storePublicId;
    const consumed = refunds.filter(refund => refund.status === 'completed').reduce((sum, refund) => sum + (refund.allocations || []).filter(sameLine).reduce((amount, line) => amount + line.grossMinor, 0), 0);
    const originalOffset = row.items.find(item => item.orderLineId === allocation.orderLineId)?.financeAllocation?.sourceCashOffsetMinor;
    if (refunds.some(refund => refund.status !== 'completed' && refund.allocations?.some(sameLine)) || Number(originalOffset ?? 0) !== consumed) {
      throw new AppError('Another refund already uses a returned order line.', 409, 'RETURN_RESOLUTION_LINE_IN_USE');
    }
  }
  return { intent, financial, hash };
}

export async function proposeReturnRefund(request, returnId, raw) {
  const input = z.object({ version, reason: z.string().trim().min(20).max(1000) }).parse(raw);
  return transaction(async session => {
    await assertAftersalesMfa(request);
    const scopedRequest = Object.assign(Object.create(request), { requiredOperationalWorkspace: 'support' });
    const context = await supportAccess(scopedRequest, { session, country: '' });
    const row = await ReturnRequest.findOne(mongoose.trusted({ $and: [context.countryScope, { publicId: id.parse(returnId) }] })).session(session);
    if (!row) throw new AppError('Return not found.', 404, 'RETURN_NOT_FOUND');
    if (Number(row.__v || 0) !== input.version) throw changed();
    if (equal(row.userId, context.actor._id)) throw new AppError('Your own return requires an independent Support reviewer.', 403, 'RETURN_RESOLUTION_INDEPENDENT_REVIEW');
    if (row.resolutionChange?.publicId) throw new AppError('This return already has a recorded refund proposal. Preserve the buyer’s decision and continue its current resolution.', 409, 'RETURN_RESOLUTION_ALREADY_PROPOSED');
    if (row.timeline.length >= 999) throw new AppError('This return reached its history limit.', 409, 'RETURN_RESOLUTION_HISTORY_LIMIT');
    const order = await Order.findOne({ _id: row.orderId, publicId: row.orderPublicId, country: row.country, userId: row.userId }).session(session);
    if (!order || context.countries.find(market => market.code === row.country)?.currency !== order.totals.currency) throw changed();
    const { intent, financial, hash } = await refundSource(row, order, session);
    await fenceSupportAccess(context, session);
    const orderFence = await Order.updateOne({ _id: order._id, __v: order.__v || 0, userId: row.userId, country: row.country }, { $inc: { __v: 1 } }, { session });
    if (orderFence.modifiedCount !== 1) throw changed();
    row.resolutionChange = { publicId: publicId('rpr'), status: 'proposed', reason: input.reason, amountMinor: financial.amountMinor,
      currency: order.totals.currency, sourceHash: hash, paymentIntentPublicId: intent.publicId,
      proposedByUserId: context.actor._id, proposedAt: new Date(), expiresAt: new Date(Date.now() + 7 * 86_400_000) };
    row.timeline.push({ type: 'return.refund_proposed', message: 'Support offered an original-payment refund instead of an exchange. Your explicit decision is required.', actorUserId: context.actor._id });
    row.increment(); await row.save({ session });
    await Notification.create([{ publicId: publicId('ntf'), userId: row.userId, country: row.country, type: 'return_update',
      title: 'Choose how to resolve your inspected return', body: `${row.publicId}: A refund alternative is available for your review. No refund or replacement has been created.`, href: '/account/returns' }], { session });
    await writeAudit(request, 'support.exchange_refund_proposed', { actor: context.actor, targetType: 'return', targetPublicId: row.publicId,
      country: row.country, metadata: { proposalPublicId: row.resolutionChange.publicId, amountMinor: financial.amountMinor, currency: order.totals.currency }, session });
    return { publicId: row.publicId, status: row.status, version: row.__v, proposalPublicId: row.resolutionChange.publicId };
  });
}

export async function answerReturnRefundProposal(request, returnId, raw) {
  const input = z.object({ version, proposalPublicId: id, decision: z.enum(['accept', 'decline']) }).parse(raw);
  return transaction(async session => {
    const actor = await currentCustomerAccess(request, { session, write: true });
    const row = await ReturnRequest.findOne({ publicId: id.parse(returnId), userId: actor._id }).session(session);
    if (!row) throw new AppError('Return not found.', 404, 'RETURN_NOT_FOUND');
    if (Number(row.__v || 0) !== input.version || row.resolutionChange?.publicId !== input.proposalPublicId) throw changed();
    const proposal = row.resolutionChange;
    if (proposal.status !== 'proposed' || !(proposal.expiresAt > new Date()) || equal(proposal.proposedByUserId, actor._id)) {
      throw new AppError('This refund proposal is no longer available.', 409, 'RETURN_RESOLUTION_PROPOSAL_UNAVAILABLE');
    }
    const order = await Order.findOne({ _id: row.orderId, publicId: row.orderPublicId, userId: actor._id, country: row.country }).session(session);
    if (!order) throw changed();
    if (row.timeline.length >= 999) throw new AppError('This return reached its history limit.', 409, 'RETURN_RESOLUTION_HISTORY_LIMIT');
    await fenceCustomerCaseMarket(row.country, session, order.totals.currency);
    if (input.decision === 'accept') {
      const source = await refundSource(row, order, session);
      if (source.hash !== proposal.sourceHash || source.intent.publicId !== proposal.paymentIntentPublicId || source.financial.amountMinor !== proposal.amountMinor || order.totals.currency !== proposal.currency) throw changed();
    } else if (row.resolution !== 'exchange' || row.status !== 'exchange_pending' || row.replacementOrderPublicId || row.refundPublicId) throw changed();
    const orderFence = await Order.updateOne({ _id: order._id, __v: order.__v || 0, userId: actor._id, country: row.country }, { $inc: { __v: 1 } }, { session });
    if (orderFence.modifiedCount !== 1) throw changed();
    proposal.status = input.decision === 'accept' ? 'accepted' : 'declined';
    proposal.respondedByUserId = actor._id; proposal.respondedAt = new Date();
    if (input.decision === 'accept') { row.resolution = 'refund'; row.status = 'refund_pending'; }
    row.timeline.push({ type: input.decision === 'accept' ? 'return.refund_accepted' : 'return.refund_declined',
      message: input.decision === 'accept' ? 'You accepted the original-payment refund alternative. Finance must review and verify any actual payment.' : 'You declined the refund alternative. The exchange remains pending.', actorUserId: actor._id });
    row.increment(); await row.save({ session });
    await refreshOrderLifecycle(order._id, { session });
    await queueSupportAlert({ country: row.country, kind: 'priority', href: '/support/returns?record=' + encodeURIComponent(row.publicId) }, session);
    await writeAudit(request, 'customer.exchange_refund_' + (input.decision === 'accept' ? 'accepted' : 'declined'), { actor,
      targetType: 'return', targetPublicId: row.publicId, country: row.country, metadata: { proposalPublicId: proposal.publicId, amountMinor: proposal.amountMinor, currency: proposal.currency }, session });
    return { publicId: row.publicId, status: row.status, resolution: row.resolution, version: row.__v };
  });
}

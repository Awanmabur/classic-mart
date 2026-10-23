import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { env } from '../config/env.js';
import { publicId } from '../core/ids.js';
import { SpecialistReferral } from '../models/SpecialistReferral.js';
import { Dispute, EvidenceDocument, Notification, Order, PlatformGrant, Store, StoreMember, SupportTicket, User } from '../models/index.js';
import { financeAccess, fenceFinanceAccess, financePublicContext, assertFinanceExportAccess } from './finance-workspace-access.js';
import { moderationAccess, fenceModerationAccess, moderationPublicContext, assertModerationReadAccess } from './moderation-workspace-access.js';
import { countryAdminAccess, fenceCountryAdminAccess, countryAdminPublicContext, assertCountryAdminReadAccess } from './country-admin-workspace-access.js';
import { sellerOperationsAccess } from './seller-operations-access.js';
import { writeAudit } from './audit.js';
import { queueSupportAlert } from './support-notifications.js';
import { cursorScope, cursorSort, pageResult, decodeCursor } from './pagination.js';
import { sanitizeAndStoreEvidenceImage } from './media.js';
import { supportAccess, fenceSupportAccess, assertSupportReadAccess } from './support-workspace-access.js';
import { assertAftersalesMfa } from './aftersales-access.js';

import { SPECIALIST_CASE_PAGES, SPECIALIST_CASE_ROUTES } from '../dashboard/specialist-routes.js';
export { SPECIALIST_CASE_PAGES, SPECIALIST_CASE_ROUTES };
const id = z.string().trim().regex(/^[a-z][a-z0-9_-]{4,99}$/);
const version = z.union([z.number(), z.string().regex(/^\d+$/)]).pipe(z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const same = (a, b) => String(a || '') === String(b || '');
const human = value => String(value || '').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
const changed = () => new AppError('This referral changed. Reload before continuing.', 409, 'SPECIALIST_REFERRAL_CHANGED');
const and = (...clauses) => mongoose.trusted({ $and: clauses });
const localRequest = (request, workspace) => Object.assign(Object.create(request), { requiredOperationalWorkspace: workspace });

async function transaction(work) {
  const session = await mongoose.startSession();
  try { return await session.withTransaction(() => work(session)); }
  catch (error) { if (error.name === 'VersionError') throw changed(); throw error; }
  finally { await session.endSession(); }
}
async function access(request, workspace, { session = null, write = false, country } = {}) {
  if (!SPECIALIST_CASE_ROUTES[workspace]) throw new AppError('Order case workspace not found.', 404, 'SPECIALIST_WORKSPACE_NOT_FOUND');
  assertAftersalesMfa(request);
  if (workspace === 'seller') {
    const context = await sellerOperationsAccess(request, 'support', { session, write, allowSuspended: true });
    return { ...context, countries: [context.country], market: context.country, country: context.store.country,
      countryScope: { country: context.store.country }, currency: context.store.currency, timeZone: context.country.timeZone };
  }
  const scoped = localRequest(request, workspace), context = await ({ finance: financeAccess, moderator: moderationAccess, admin: countryAdminAccess })[workspace](scoped, { session, country });
  if (write) await ({ finance: fenceFinanceAccess, moderator: fenceModerationAccess, admin: fenceCountryAdminAccess })[workspace](context, session);
  return context;
}
function scope(context, workspace) {
  return and({ receivingWorkspace: workspace }, context.countryScope,
    ...(workspace === 'seller' ? [{ storeId: context.store._id, storePublicId: context.store.publicId, currency: context.store.currency }] : []));
}
function publicContext(context, workspace) {
  return workspace === 'seller' ? { country: context.country, currency: context.currency, timeZone: context.timeZone,
    countries: context.countries.map(row => ({ code: row.code, name: row.name, currency: row.currency, timeZone: row.timeZone })) }
    : ({ finance: financePublicContext, moderator: moderationPublicContext, admin: countryAdminPublicContext })[workspace](context);
}
async function assertRead(request, context, workspace) {
  assertAftersalesMfa(request);
  if (workspace !== 'seller') return ({ finance: assertFinanceExportAccess, moderator: assertModerationReadAccess, admin: assertCountryAdminReadAccess })[workspace](localRequest(request, workspace), context);
  const current = await access(request, workspace);
  if (!same(current.member._id, context.member._id) || current.member.role !== context.member.role || current.store.country !== context.store.country || current.store.currency !== context.store.currency) throw changed();
  return current;
}
async function source(row, context, workspace, session = null, { active = false } = {}) {
  const order = await Order.findOne({ _id: row.orderId, publicId: row.orderPublicId, userId: row.userId,
    country: row.country, 'totals.currency': row.currency }).session(session);
  const dispute = await Dispute.findOne({ _id: row.disputeId, publicId: row.disputePublicId,
    orderId: row.orderId, orderPublicId: row.orderPublicId, userId: row.userId, country: row.country }).session(session);
  const ticket = await SupportTicket.findOne({ _id: row.ticketId, publicId: row.ticketPublicId, source: 'staff',
    orderId: row.orderId, orderPublicId: row.orderPublicId, userId: row.userId, country: row.country,
    createdByUserId: row.requestedByUserId }).session(session);
  if (!order || !dispute || !ticket || context.countries.find(market => market.code === row.country)?.currency !== row.currency
    || workspace === 'seller' && !order.items.some(line => same(line.storeId, context.store._id) && line.storePublicId === context.store.publicId)) {
    throw new AppError('This referral does not match its original scoped order case.', 409, 'SPECIALIST_SOURCE_MISMATCH');
  }
  if (active && (['resolved', 'rejected', 'closed'].includes(dispute.status) || ticket.mergedIntoPublicId || ['resolved', 'closed'].includes(ticket.status)
    || dispute.escalation?.specialistReferralPublicId !== row.publicId || dispute.escalation?.referralTicketPublicId !== row.ticketPublicId
    || dispute.escalation?.department !== row.department || !same(dispute.escalation.escalatedByUserId, row.requestedByUserId))) throw changed();
  return { order, dispute, ticket };
}

async function fenceSource(original, session, { read = false } = {}) {
  for (const [Model, record] of [[Order, original.order], [Dispute, original.dispute], [SupportTicket, original.ticket]]) {
    const updated = await Model.updateOne({ _id: record._id, __v: record.__v || 0 },
      { $inc: { [read ? 'moderationEvidenceReadRevision' : '__v']: 1 } }, { session, ...(read ? { timestamps: false } : {}) });
    if (updated.modifiedCount !== 1) throw changed();
    if (!read) record.__v = Number(record.__v || 0) + 1;
  }
}

async function referralEvidence(row, dispute, workspace, session = null) {
  return EvidenceDocument.find({ country: row.country, status: 'ready', $or: [
    { _id: mongoose.trusted({ $in: row.evidenceDocumentIds }), contextType: 'specialist_referral', contextPublicId: row.publicId, documentType: 'specialist_response' },
    ...(workspace === 'seller' ? [] : [{ _id: mongoose.trusted({ $in: row.sourceEvidenceDocumentIds.filter(value => dispute.evidenceDocumentIds.some(attached => same(attached, value))) }),
      ownerUserId: row.userId, contextType: 'dispute', contextPublicId: dispute.publicId }]),
  ] }).select('publicId description documentType').session(session).lean();
}

/** Invoked in the same transaction that saves Support's departmental handoff. */
export async function createSpecialistReferral(request, context, dispute, order, ticket, input, session) {
  if (!session?.inTransaction()) throw new AppError('A referral requires the Support transaction.', 500, 'SPECIALIST_TRANSACTION_REQUIRED');
  assertAftersalesMfa(request);
  const workspace = input.department === 'finance' ? 'finance' : input.department === 'moderation' ? 'moderator' : input.department === 'seller' ? 'seller' : 'admin';
  if (await SpecialistReferral.exists({ disputeId: dispute._id, status: { $in: ['pending', 'claimed'] } }).session(session)) throw new AppError('A specialist is already investigating this case. Read that response before referring it again.', 409, 'SPECIALIST_REFERRAL_ALREADY_ACTIVE');
  let store = null;
  if (workspace === 'seller') {
    const storePublicId = id.parse(input.storePublicId), storeIds = order.items.filter(line => line.storePublicId === storePublicId).map(line => line.storeId);
    if (!storeIds.length || new Set(storeIds.map(String)).size !== 1) throw new AppError('Select a store from the actual order lines.', 422, 'SPECIALIST_SELLER_SOURCE_INVALID');
    store = await Store.findOne({ _id: storeIds[0], publicId: storePublicId, country: order.country, currency: order.totals.currency,
      status: { $in: ['verified', 'suspended'] } }).session(session);
    if (!store || !input.sellerMessage || input.sellerMessage.trim().length < 20) throw new AppError('Enter a separate message for the selected seller. Private Support notes are never sent.', 422, 'SPECIALIST_SELLER_MESSAGE_REQUIRED');
  }
  const [row] = await SpecialistReferral.create([{ publicId: publicId('spr'), activeKey: String(dispute._id), disputeId: dispute._id,
    disputePublicId: dispute.publicId, orderId: order._id, orderPublicId: order.publicId, userId: dispute.userId,
    country: dispute.country, currency: order.totals.currency, department: input.department, receivingWorkspace: workspace,
    ...(store ? { storeId: store._id, storePublicId: store.publicId } : {}), ticketId: ticket._id, ticketPublicId: ticket.publicId,
    requestedByUserId: context.actor._id, reason: input.reason, recipientMessage: store ? input.sellerMessage : '',
    sourceEvidenceDocumentIds: store ? [] : [...(dispute.evidenceDocumentIds || [])] }], { session });
  dispute.escalation.specialistReferralPublicId = row.publicId;
  if (store) dispute.status = 'awaiting_seller';
  await notifyRecipients(row, session);
  await writeAudit(request, 'support.specialist_referral_created', { actor: context.actor, targetType: 'specialist_referral',
    targetPublicId: row.publicId, country: row.country, metadata: { disputePublicId: row.disputePublicId, workspace, storePublicId: row.storePublicId }, session });
  return row;
}
function dto(row, context, workspace) {
  return { publicId: row.publicId, disputePublicId: row.disputePublicId, orderPublicId: row.orderPublicId,
    country: row.country, currency: row.currency, department: row.department, status: row.status, createdAt: row.createdAt,
    version: Number(row.__v || 0), assignedToMe: same(row.assignedUserId, context.actor._id), assigned: Boolean(row.assignedUserId),
    reason: workspace === 'seller' ? row.recipientMessage : row.reason,
    response: row.response?.respondedAt ? { finding: row.response.finding, summary: row.response.summary, respondedAt: row.response.respondedAt } : null };
}

export async function loadSpecialistOrderCases(request, workspace) {
  const filter = z.object({ country: z.string().regex(/^$|^[A-Z]{2}$/).optional(), search: z.string().trim().max(100).default(''),
    status: z.enum(['all', 'pending', 'claimed', 'responded']).default('all'), after: z.string().max(512).default(''), record: id.optional() }).parse(request.query || {});
  if (filter.after && !decodeCursor(filter.after)) throw new AppError('The referral page cursor is invalid.', 422, 'SPECIALIST_CURSOR_INVALID');
  const context = await access(request, workspace, { country: filter.country }), base = SPECIALIST_CASE_ROUTES[workspace], baseScope = scope(context, workspace);
  const filtered = and(baseScope, filter.status !== 'all' ? { status: filter.status } : {}, filter.search ? {
    $or: ['publicId', 'disputePublicId', 'orderPublicId'].map(field => ({ [field]: new RegExp(filter.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })) } : {});
  const [records, total, counts] = await Promise.all([SpecialistReferral.find(cursorScope(filtered, filter.after)).sort(cursorSort()).limit(26).lean(),
    SpecialistReferral.countDocuments(filtered), SpecialistReferral.aggregate([{ $match: baseScope }, { $group: { _id: '$status', count: { $sum: 1 } } }])]);
  const paged = pageResult(records, { limit: 25, total }), query = { country: context.country || '', search: filter.search, status: filter.status };
  const href = changes => base + '?' + new URLSearchParams({ ...query, ...changes });
  const valid = [];
  for (const record of paged.items) { await source(record, context, workspace); valid.push(dto(record, context, workspace)); }
  let selected = null;
  if (filter.record) {
    const row = await SpecialistReferral.findOne(and(baseScope, { publicId: filter.record }));
    if (!row) throw new AppError('Order referral not found.', 404, 'SPECIALIST_REFERRAL_NOT_FOUND');
    const original = await source(row, context, workspace);
    const evidence = await referralEvidence(row, original.dispute, workspace);
    selected = { ...dto(row, context, workspace), subject: workspace === 'seller' ? 'Support order request' : original.dispute.subject,
      description: workspace === 'seller' ? '' : original.dispute.description,
      items: original.order.items.filter(line => workspace !== 'seller' || same(line.storeId, context.store._id)).map(line => ({ title: line.title, variant: line.variantTitle, quantity: line.quantity })),
      evidence: evidence.map(entry => ({ publicId: entry.publicId, description: entry.description, href: base + '/evidence/' + encodeURIComponent(entry.publicId) })),
      sourceHref: workspace === 'finance' ? '/finance/payments?country=' + row.country + '&search=' + row.orderPublicId
        : workspace === 'admin' ? '/admin/orders?country=' + row.country + '&record=' + row.orderPublicId
          : workspace === 'moderator' ? '/moderation/risk-cases?country=' + row.country + '&search=' + row.orderPublicId : '/seller/orders?order=' + row.orderPublicId };
  }
  await assertRead(request, context, workspace);
  const count = status => counts.find(row => row._id === status)?.count || 0, all = counts.reduce((sum, row) => sum + row.count, 0);
  return { kind: 'specialist', baseHref: base, context: publicContext(context, workspace), country: context.country, selected, items: valid,
    filters: { ...filter, country: context.country, statuses: ['all', 'pending', 'claimed', 'responded'].map(value => ({ value, label: human(value) })) },
    columns: ['Referral', 'Order', 'Market', 'Department', 'Status'], rows: valid.map(row => ({ id: row.publicId,
      cells: [row.publicId, row.orderPublicId, row.country, human(row.department), human(row.status)], href: href({ record: row.publicId }) })),
    page: paged.page, pagination: { ...paged.page, nextHref: paged.page.hasMore ? href({ after: paged.page.next }) : '' },
    metrics: [{ label: 'Order referrals', value: String(all), detail: 'Saved cases in this workspace and market scope' },
      { label: 'Awaiting owner', value: String(count('pending')), detail: 'Not yet claimed for investigation' },
      { label: 'In investigation', value: String(count('claimed')), detail: 'Claimed by an authorized specialist' },
      { label: 'Responses returned', value: String(count('responded')), detail: 'Recorded findings sent to Support' }],
    insights: [{ text: 'An assessment returns evidence to Support. Refunds and delivery outcomes still require their actual verified records.', href: href({ status: 'pending' }), label: 'Review pending referrals' }],
    health: { label: 'Recorded response coverage', value: all ? Math.round(100 * count('responded') / all) : null,
      rows: [{ label: 'Awaiting response', value: String(count('pending') + count('claimed')) }, { label: 'Completed assessments', value: String(count('responded')) }] },
    workflow: [{ title: 'Claim the referral', text: 'Take ownership of a saved case within your current authority.' },
      { title: 'Check its actual sources', text: 'Review the scoped order and evidence before recording a finding.' },
      { title: 'Return your assessment', text: 'Support reviews your response and records the customer resolution separately.' }] };
}

export async function mutateSpecialistOrderCase(request, workspace, referralId, action, raw) {
  const input = z.object({ version, finding: z.enum(['recommendation', 'further_action', 'no_action']).optional(), summary: z.string().trim().min(20).max(2000).optional() }).parse(raw);
  if (!['claim', 'respond'].includes(action) || action === 'respond' && (!input.finding || !input.summary)) throw new AppError('Enter the required referral response.', 422, 'SPECIALIST_RESPONSE_REQUIRED');
  return transaction(async session => {
    const context = await access(request, workspace, { session, write: true, country: '' });
    const row = await SpecialistReferral.findOne(and(scope(context, workspace), { publicId: id.parse(referralId) })).session(session);
    if (!row) throw new AppError('Order referral not found.', 404, 'SPECIALIST_REFERRAL_NOT_FOUND');
    if (Number(row.__v || 0) !== input.version) throw changed();
    if (same(row.requestedByUserId, context.actor._id) || same(row.userId, context.actor._id)) throw new AppError('This case requires an independent specialist.', 403, 'SPECIALIST_INDEPENDENT_REVIEW_REQUIRED');
    const original = await source(row, context, workspace, session, { active: true });
    await fenceSource(original, session);
    if (action === 'claim') {
      if (row.status !== 'pending' || row.assignedUserId) throw new AppError('This referral is already claimed.', 409, 'SPECIALIST_ALREADY_CLAIMED');
      row.status = 'claimed'; row.assignedUserId = context.actor._id; row.assignedAt = new Date();
    } else {
      if (row.status !== 'claimed' || !same(row.assignedUserId, context.actor._id)) throw new AppError('Claim this referral before returning an assessment.', 403, 'SPECIALIST_ASSIGNMENT_REQUIRED');
      if (original.dispute.events.length >= 999 || original.ticket.notes.length >= 999) throw new AppError('This case has reached its conversation limit.', 409, 'SPECIALIST_THREAD_LIMIT');
      row.status = 'responded'; row.activeKey = undefined;
      row.response = { finding: input.finding, summary: input.summary, respondedByUserId: context.actor._id, respondedAt: new Date() };
      original.dispute.events.push({ type: 'dispute.specialist_responded', message: `${row.department} assessment ${row.publicId}: ${input.summary}`.slice(0, 1000), visibility: 'internal', actorUserId: context.actor._id });
      original.dispute.status = 'investigating'; original.dispute.increment(); await original.dispute.save({ session });
      original.ticket.notes.push({ message: input.summary, internal: true, actorUserId: context.actor._id });
      original.ticket.status = 'in_progress'; original.ticket.increment(); await original.ticket.save({ session });
      await queueSupportAlert({ country: row.country, kind: 'escalation', href: '/support/escalations?record=' + row.disputePublicId }, session);
    }
    row.increment(); await row.save({ session });
    await writeAudit(request, 'specialist.order_case_' + (action === 'claim' ? 'claimed' : 'responded'), { actor: context.actor,
      targetType: 'specialist_referral', targetPublicId: row.publicId, country: row.country,
      metadata: { disputePublicId: row.disputePublicId, workspace, finding: input.finding }, session });
    return dto(row, context, workspace);
  });
}

export async function attachSpecialistOrderEvidence(request, workspace, referralId, raw, file) {
  const input = z.object({ version, description: z.string().trim().min(3).max(300) }).parse(raw);
  const context = await access(request, workspace), row = await SpecialistReferral.findOne(and(scope(context, workspace), { publicId: id.parse(referralId) }));
  if (!row || row.status !== 'claimed' || !same(row.assignedUserId, context.actor._id) || Number(row.__v || 0) !== input.version) throw changed();
  await source(row, context, workspace, null, { active: true });
  const evidence = await sanitizeAndStoreEvidenceImage({ file, user: context.actor, country: row.country,
    contextType: 'specialist_referral', contextPublicId: row.publicId, documentType: 'specialist_response', description: input.description });
  try {
    return await transaction(async session => {
      const current = await access(request, workspace, { session, write: true, country: '' });
      const fresh = await SpecialistReferral.findOne(and(scope(current, workspace), { _id: row._id })).session(session);
      if (!fresh || fresh.status !== 'claimed' || !same(fresh.assignedUserId, current.actor._id) || Number(fresh.__v || 0) !== input.version || fresh.evidenceDocumentIds.length >= 30) throw changed();
      const original = await source(fresh, current, workspace, session, { active: true });
      if (same(fresh.requestedByUserId, current.actor._id) || same(fresh.userId, current.actor._id)) throw new AppError('This case requires an independent specialist.', 403, 'SPECIALIST_INDEPENDENT_REVIEW_REQUIRED');
      await fenceSource(original, session);
      const proof = await EvidenceDocument.updateOne({ _id: evidence._id, ownerUserId: current.actor._id, country: fresh.country,
        contextType: 'specialist_referral', contextPublicId: fresh.publicId, documentType: 'specialist_response', status: 'ready' }, { $inc: { __v: 1 } }, { session });
      if (proof.modifiedCount !== 1) throw changed();
      fresh.evidenceDocumentIds.push(evidence._id); fresh.increment(); await fresh.save({ session });
      await writeAudit(request, 'specialist.order_case_evidence_added', { actor: current.actor, targetType: 'specialist_referral',
        targetPublicId: fresh.publicId, country: fresh.country, metadata: { evidencePublicId: evidence.publicId, workspace }, session });
      return dto(fresh, current, workspace);
    });
  } catch (error) {
    if (!await SpecialistReferral.exists({ _id: row._id, evidenceDocumentIds: evidence._id })) await EvidenceDocument.updateOne({ _id: evidence._id }, { $set: { status: 'rejected' } });
    throw error;
  }
}

export async function specialistOrderEvidence(request, workspace, evidenceId, { session = null, write = false, expectedStorageKey } = {}) {
  const context = await access(request, workspace, { session, write }), evidence = await EvidenceDocument.findOne({ publicId: id.parse(evidenceId), status: 'ready' }).select('+storageKey').session(session);
  if (!evidence) throw new AppError('Evidence not found.', 404, 'EVIDENCE_NOT_FOUND');
  const row = await SpecialistReferral.findOne(and(scope(context, workspace), { country: evidence.country,
    $or: [{ evidenceDocumentIds: evidence._id }, ...(workspace === 'seller' ? [] : [{ sourceEvidenceDocumentIds: evidence._id }])] })).session(session);
  if (!row) throw new AppError('Evidence not found.', 404, 'EVIDENCE_NOT_FOUND');
  const original = await source(row, context, workspace, session);
  if (row.evidenceDocumentIds.some(value => same(value, evidence._id))) {
    if (evidence.contextType !== 'specialist_referral' || evidence.contextPublicId !== row.publicId || evidence.documentType !== 'specialist_response') throw changed();
  } else if (evidence.contextType !== 'dispute' || evidence.contextPublicId !== original.dispute.publicId
    || !same(evidence.ownerUserId, row.userId) || !original.dispute.evidenceDocumentIds.some(value => same(value, evidence._id))) throw changed();
  if (expectedStorageKey !== undefined && expectedStorageKey !== evidence.storageKey) throw changed();
  if (write) {
    await fenceSource(original, session, { read: true });
    const proof = await EvidenceDocument.updateOne({ _id: evidence._id, __v: evidence.__v || 0, status: 'ready',
      contextType: evidence.contextType, contextPublicId: evidence.contextPublicId, country: row.country, storageKey: evidence.storageKey }, { $inc: { moderationEvidenceReadRevision: 1 } }, { session, timestamps: false });
    if (proof.modifiedCount !== 1) throw changed();
    const fenced = await SpecialistReferral.updateOne({ _id: row._id, __v: row.__v || 0 }, { $inc: { evidenceReadRevision: 1 } }, { session, timestamps: false });
    if (fenced.modifiedCount !== 1) throw changed();
    await writeAudit(request, 'specialist.order_case_evidence_read', { actor: context.actor, targetType: 'specialist_referral', targetPublicId: row.publicId,
      country: row.country, metadata: { evidencePublicId: evidence.publicId, workspace }, session });
  } else await assertRead(request, context, workspace);
  return evidence;
}

export const specialistEvidenceTransaction = transaction;

async function notifyRecipients(row, session) {
  const now = new Date();
  let candidates;
  if (row.receivingWorkspace === 'seller') {
    const members = await StoreMember.find({ storeId: row.storeId, status: 'active', $or: [
      { role: 'owner' }, { role: { $in: ['admin', 'support'] }, acceptedAt: { $type: 'date' } },
    ] }).select('userId').session(session).lean();
    candidates = await User.find({ _id: { $in: members.map(member => member.userId) }, status: 'active',
      role: { $in: ['seller', 'customer'] }, platformAccessManagedAt: null, emailVerifiedAt: { $type: 'date' },
      onboardingCompletedAt: { $type: 'date' }, ...(env.security.privilegedMfaRequired ? { 'security.mfaEnabled': true } : {}) }).select('_id').session(session).lean();
    const grants = await PlatformGrant.find({ userId: { $in: candidates.map(actor => actor._id) } }).select('userId').session(session).lean();
    candidates = candidates.filter(actor => !grants.some(grant => same(grant.userId, actor._id)));
  } else {
    const role = ({ finance: 'finance', moderator: 'moderator', admin: 'country_admin' })[row.receivingWorkspace];
    candidates = await User.aggregate([
      { $match: { status: 'active', emailVerifiedAt: { $type: 'date' }, onboardingCompletedAt: { $type: 'date' },
        ...(env.security.privilegedMfaRequired ? { 'security.mfaEnabled': true } : {}),
        $or: [{ role }, { platformAccessManagedAt: { $type: 'date' } }] } },
      { $lookup: { from: PlatformGrant.collection.name, localField: '_id', foreignField: 'userId', as: 'grants', pipeline: [
        { $match: { status: 'active', startsAt: { $lte: now }, expiresAt: { $gt: now } } },
      ] } },
      { $match: { $expr: { $cond: [{ $ne: [{ $ifNull: ['$platformAccessManagedAt', null] }, null] },
        { $and: [{ $eq: [{ $size: '$grants' }, 1] }, { $eq: [{ $first: '$grants.role' }, role] }, { $in: [row.country, { $ifNull: [{ $first: '$grants.operationalCountries' }, []] }] }] },
        { $and: [{ $eq: ['$role', role] }, { $in: [row.country, { $cond: [{ $gt: [{ $size: { $ifNull: ['$operationalCountries', []] } }, 0] }, '$operationalCountries', ['$country']] }] }] },
      ] } } }, { $project: { _id: 1 } },
    ]).session(session);
  }
  const recipients = candidates.filter(actor => !same(actor._id, row.requestedByUserId) && !same(actor._id, row.userId));
  if (recipients.length) await Notification.create(recipients.map(actor => ({ publicId: publicId('ntf'), userId: actor._id,
    country: row.country, type: 'specialist_order_case', title: 'Order case awaiting your review',
    body: 'A saved Support request is available within your authorized workspace.',
    href: SPECIALIST_CASE_ROUTES[row.receivingWorkspace] + '?' + new URLSearchParams({ record: row.publicId,
      ...(row.receivingWorkspace === 'seller' ? {} : { country: row.country }) }) })), { session });
}

/** Support alone sees private assessments; the buyer projection omits these. */
export async function supportSpecialistHistory(dispute) {
  const rows = await SpecialistReferral.find({ disputeId: dispute._id, disputePublicId: dispute.publicId, orderId: dispute.orderId,
    orderPublicId: dispute.orderPublicId, userId: dispute.userId, country: dispute.country }).sort({ createdAt: 1, _id: 1 }).limit(100).lean();
  const evidence = await EvidenceDocument.find({ _id: { $in: rows.flatMap(row => row.evidenceDocumentIds) },
    country: dispute.country, contextType: 'specialist_referral', documentType: 'specialist_response', status: 'ready' }).select('publicId contextPublicId description').lean();
  return rows.map(row => ({ publicId: row.publicId, department: row.department, status: row.status,
    requestedAt: row.requestedAt, reason: row.reason, storePublicId: row.storePublicId,
    response: row.response?.respondedAt ? { finding: row.response.finding, summary: row.response.summary, respondedAt: row.response.respondedAt } : null,
    evidence: evidence.filter(item => item.contextPublicId === row.publicId).map(item => ({ publicId: item.publicId,
      description: item.description, href: '/support/order-case-evidence/' + item.publicId })) }));
}

export async function supportSpecialistEvidence(request, evidenceId, { session = null, write = false, expectedStorageKey } = {}) {
  const scoped = localRequest(request, 'support'), context = await supportAccess(scoped, { session, country: '' });
  const evidence = await EvidenceDocument.findOne({ publicId: id.parse(evidenceId), contextType: 'specialist_referral',
    documentType: 'specialist_response', status: 'ready' }).select('+storageKey').session(session);
  if (!evidence) throw new AppError('Evidence not found.', 404, 'EVIDENCE_NOT_FOUND');
  const row = await SpecialistReferral.findOne(and(context.countryScope, { publicId: evidence.contextPublicId,
    country: evidence.country, evidenceDocumentIds: evidence._id })).session(session);
  if (!row) throw new AppError('Evidence not found.', 404, 'EVIDENCE_NOT_FOUND');
  assertAftersalesMfa(request);
  const original = await source(row, context, 'support', session);
  if (expectedStorageKey !== undefined && expectedStorageKey !== evidence.storageKey) throw changed();
  if (write) {
    await fenceSupportAccess(context, session);
    await fenceSource(original, session, { read: true });
    const proof = await EvidenceDocument.updateOne({ _id: evidence._id, __v: evidence.__v || 0, status: 'ready',
      contextType: 'specialist_referral', contextPublicId: row.publicId, documentType: 'specialist_response', country: row.country,
      storageKey: evidence.storageKey }, { $inc: { moderationEvidenceReadRevision: 1 } }, { session, timestamps: false });
    if (proof.modifiedCount !== 1) throw changed();
    const fenced = await SpecialistReferral.updateOne({ _id: row._id, __v: row.__v || 0, evidenceDocumentIds: evidence._id },
      { $inc: { evidenceReadRevision: 1 } }, { session, timestamps: false });
    if (fenced.modifiedCount !== 1) throw changed();
    await writeAudit(request, 'support.specialist_evidence_read', { actor: context.actor, targetType: 'specialist_referral',
      targetPublicId: row.publicId, country: row.country, metadata: { evidencePublicId: evidence.publicId }, session });
  } else await assertSupportReadAccess(scoped, context);
  return evidence;
}

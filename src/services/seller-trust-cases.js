import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { TrustCase, Product, CountrySetting, EvidenceDocument } from '../models/index.js';
import { sellerOperationsAccess, sellerTransaction, sellerVersion, sameSellerId, sellerConflict } from './seller-operations-access.js';
import { sanitizeAndStoreEvidenceImage } from './media.js';
import { writeAudit } from './audit.js';
import { queueTrustModerationAlert } from './moderation-trust-pages.js';
import { cursorScope, cursorSort, pageResult } from './pagination.js';
const version = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
async function access(request, session = null, write = false) {
  return sellerOperationsAccess(request, 'support', { session, write, allowSuspended: true });
}
async function ownedCase(context, id, session = null) {
  const row = await TrustCase.findOne({ publicId: id, storeId: context.store._id, storePublicId: context.store.publicId }).session(session);
  if (!row) throw new AppError('Policy case not found.', 404, 'SELLER_CASE_NOT_FOUND');
  if (!await CountrySetting.exists({ code: row.country, active: true }).session(session)) throw new AppError('The case market is unavailable.', 409, 'SELLER_CASE_MARKET_UNAVAILABLE');
  if (row.productId) {
    if (!await Product.exists({ _id: row.productId, publicId: row.productPublicId, storeId: context.store._id, ownerUserId: context.store.ownerUserId, countries: row.country }).session(session)) throw new AppError('The case source needs investigation.', 409, 'SELLER_CASE_LINKAGE_INVALID');
  } else if (row.productPublicId || row.country !== context.store.country) throw new AppError('The case source needs investigation.', 409, 'SELLER_CASE_LINKAGE_INVALID');
  return row;
}
function dto(row) { return { publicId: row.publicId, country: row.country, type: row.type, productPublicId: row.productPublicId || '', status: row.status, decision: row.decision || '', createdAt: row.createdAt, version: row.__v || 0, canRespond: ['open', 'investigating', 'appealed'].includes(row.status), canAppeal: ['actioned', 'dismissed', 'closed'].includes(row.status) && !row.sellerAppealCount, responses: (row.sellerResponses || []).map(entry => ({ action: entry.action, message: entry.message, at: entry.at })), publicMessages: (row.publicMessages || []).filter(entry => entry.author === 'moderation').map(entry => ({ author: entry.author, message: entry.message, at: entry.at })) }; }
export async function sellerTrustCasesPage(request) {
  const context = await access(request), scope = { storeId: context.store._id, storePublicId: context.store.publicId };
  const [rows, total] = await Promise.all([TrustCase.find(cursorScope(scope, request.query?.after)).sort(cursorSort()).limit(26).lean(), TrustCase.countDocuments(scope)]);
  const paged = pageResult(rows, { limit: 25, total });
  let selected = null;
  if (typeof request.query?.record === 'string' && request.query.record.length <= 100) {
    const row = await ownedCase(context, request.query.record);
    const evidence = await EvidenceDocument.find({ _id: { $in: row.sellerEvidenceDocumentIds || [] }, country: row.country, contextType: 'trust_case', contextPublicId: row.publicId, documentType: 'seller_policy_response', status: 'ready' }).select('publicId description createdAt').sort({ createdAt: 1, _id: 1 }).lean();
    selected = { ...dto(row), description: row.description, evidence };
  }
  return { kind: 'policy-cases', baseHref: '/seller/trust-cases', cases: paged.items.map(dto), selected, page: paged.page,
    columns: ['Case', 'Concern', 'Market', 'Status'], rows: paged.items.map(row => ({ id: row.publicId, cells: [row.publicId, row.type.replaceAll('_', ' '), row.country, row.status], href: '/seller/trust-cases?record=' + encodeURIComponent(row.publicId) })),
    metrics: [{ label: 'Policy cases', value: total }, { label: 'Store status', value: context.store.status }, { label: 'Workspace', value: context.store.name }, { label: 'Access', value: 'Private review' }], insights: ['Policy case access remains available while a store is suspended.', 'Responses and evidence are private to your store team and authorized independent reviewers.'], health: { label: 'Policy workflow', rows: [{ label: 'Trading access', value: context.store.status === 'suspended' ? 'Blocked' : 'Current store controls' }] }, workflow: [{ title: 'Read the case', text: 'Review the actual concern and Moderation decision.' }, { title: 'Respond or correct', text: 'Explain your correction and attach private evidence.' }, { title: 'Appeal independently', text: 'An eligible completed case can be appealed to a different reviewer.' }] };
}
export async function respondSellerTrustCase(request, id, raw) {
  const input = z.object({ action: z.enum(['response', 'correction', 'appeal']), message: z.string().trim().min(10).max(2000), version }).parse(raw);
  return sellerTransaction(async session => {
    const context = await access(request, session, true), row = await ownedCase(context, id, session); sellerVersion(row, input.version);
    if (row.sellerResponses.length >= 200) throw new AppError('This case has reached its response limit.', 409, 'SELLER_CASE_RESPONSE_LIMIT');
    if (input.action === 'appeal') {
      if (!['actioned', 'dismissed', 'closed'].includes(row.status) || row.sellerAppealCount) throw new AppError('This case is not eligible for another Seller appeal.', 409, 'SELLER_CASE_APPEAL_STATE');
      const original = row.decisionByUserId || row.assignedUserId;
      if (!original || sameSellerId(original, context.actor._id)) throw new AppError('An independently recorded decision is required before appeal.', 409, 'SELLER_CASE_APPEAL_STATE');
      row.sellerAppealCount += 1; row.sellerAppealedAt = new Date(); row.appealOriginalDecisionByUserId = original;
      row.status = 'appealed'; row.assignedUserId = undefined; row.assignedAt = undefined; row.resolvedAt = undefined;
    } else if (!['open', 'investigating', 'appealed'].includes(row.status)) throw new AppError('Use an eligible appeal for a completed case.', 409, 'SELLER_CASE_RESPONSE_STATE');
    row.sellerResponses.push({ action: input.action, message: input.message, actorUserId: context.actor._id }); await row.save({ session });
    await queueTrustModerationAlert({ country: row.country, href: '/moderation/risk-cases?record=' + row.publicId + '&country=' + row.country }, session);
    await writeAudit(request, `seller.policy_case_${input.action}`, { actor: context.actor, session, targetType: 'trust_case', targetPublicId: row.publicId, country: row.country, metadata: { storePublicId: context.store.publicId, independentReviewRequired: input.action === 'appeal' } }); return dto(row);
  });
}
export async function attachSellerTrustCaseEvidence(request, id, raw) {
  const input = z.object({ version, description: z.string().trim().min(3).max(300) }).parse(raw);
  const context = await access(request), initial = await ownedCase(context, id); sellerVersion(initial, input.version);
  if (!['open', 'investigating', 'appealed'].includes(initial.status)) throw new AppError('Appeal a completed case before adding new evidence.', 409, 'SELLER_CASE_RESPONSE_STATE');
  const evidence = await sanitizeAndStoreEvidenceImage({ file: request.file, user: context.actor, country: initial.country, contextType: 'trust_case', contextPublicId: initial.publicId, documentType: 'seller_policy_response', description: input.description });
  try {
    return await sellerTransaction(async session => {
      const current = await access(request, session, true), row = await ownedCase(current, id, session); sellerVersion(row, input.version);
      if (!['open', 'investigating', 'appealed'].includes(row.status) || row.sellerEvidenceDocumentIds.length >= 30 || row.sellerResponses.length >= 200) throw new AppError('Evidence cannot be added in this case state.', 409, 'SELLER_CASE_RESPONSE_STATE');
      const accepted = await EvidenceDocument.updateOne({ _id: evidence._id, ownerUserId: current.actor._id, status: 'ready', contextType: 'trust_case', contextPublicId: row.publicId, country: row.country }, { $inc: { __v: 1 } }, { session }); if (accepted.modifiedCount !== 1) throw sellerConflict();
      row.sellerEvidenceDocumentIds.push(evidence._id); row.sellerResponses.push({ action: 'evidence', message: input.description, actorUserId: current.actor._id, evidenceDocumentIds: [evidence._id] }); await row.save({ session });
      await queueTrustModerationAlert({ country: row.country, href: '/moderation/risk-cases?record=' + row.publicId + '&country=' + row.country }, session);
      await writeAudit(request, 'seller.policy_case_evidence_added', { actor: current.actor, session, targetType: 'trust_case', targetPublicId: row.publicId, country: row.country, metadata: { evidencePublicId: evidence.publicId, storePublicId: current.store.publicId } }); return dto(row);
    });
  } catch (error) {
    // Preserve objects on an ambiguous commit; only unattached uploads become rejected.
    if (!await TrustCase.exists({ publicId: id, sellerEvidenceDocumentIds: evidence._id })) await EvidenceDocument.updateOne({ _id: evidence._id }, { $set: { status: 'rejected' } });
    throw error;
  }
}
export async function authorizeSellerPolicyEvidence(request, id, { session = null, write = false, expectedStorageKey } = {}) {
  const context = await access(request, session, write);
  const evidence = await EvidenceDocument.findOne({ publicId: id, status: 'ready', contextType: 'trust_case', documentType: 'seller_policy_response' }).select('+storageKey').session(session);
  if (!evidence) throw new AppError('Evidence not found.', 404, 'EVIDENCE_NOT_FOUND');
  const row = await ownedCase(context, evidence.contextPublicId, session);
  if (!row.sellerEvidenceDocumentIds.some(value => sameSellerId(value, evidence._id)) || !row.sellerResponses.some(entry => sameSellerId(entry.actorUserId, evidence.ownerUserId) && entry.evidenceDocumentIds.some(value => sameSellerId(value, evidence._id))) || row.country !== evidence.country) throw new AppError('Evidence not found.', 404, 'EVIDENCE_NOT_FOUND');
  if (expectedStorageKey !== undefined && expectedStorageKey !== evidence.storageKey) throw sellerConflict();
  if (write) {
    const fence = await TrustCase.updateOne({ _id: row._id, __v: row.__v || 0, sellerEvidenceDocumentIds: evidence._id }, { $inc: { moderationEvidenceReadRevision: 1 } }, { session, timestamps: false });
    if (fence.modifiedCount !== 1) throw sellerConflict();
    await writeAudit(request, 'seller.policy_case_evidence_read', { actor: context.actor, session, targetType: 'trust_case', targetPublicId: row.publicId, country: row.country, metadata: { evidencePublicId: evidence.publicId } });
  }
  return evidence;
}

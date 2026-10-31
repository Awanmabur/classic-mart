import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { AuditLog, ModerationQaReview, Product, SellerVerification, Store, StoreMember, TrustCase, VerificationDocument } from '../models/index.js';
import { publicId } from '../core/ids.js';
import { moderationAccess, fenceModerationAccess, assertModerationReadAccess, moderationPublicContext } from './moderation-workspace-access.js';
import { moderationReviewPipeline, moderationTrustCasePipeline, moderationRiskSignalPipeline } from './moderation-trust-pages.js';
import { sellerOverviewWindow } from './seller-overview.js';
import { cursorScope, cursorSort, decodeCursor, pageResult } from './pagination.js';
import { writeAudit } from './audit.js';
import { queueModerationAlert } from './moderation-notifications.js';

const SIZE = 25;
const REPORTS = ['summary', 'decisions', 'qa'];
const PERSONAL_AUDIT_ACTIONS = ['moderation.settings_updated', 'moderation.preferences_updated', 'moderation.profile_updated', 'moderation.communication_updated', 'moderation.preferences_saved', 'moderation.profile_saved', 'moderation.communication_saved', 'moderation.settings_exported'];
const FINAL_DECISIONS = ['catalogue.product_approve', 'catalogue.product_approved', 'catalogue.product_changes', 'catalogue.product_changes_requested', 'catalogue.product_reject', 'catalogue.product_rejected', 'seller.verification_approved', 'seller.verification_rejected', 'review.moderated', 'trust.case_reviewed', 'trust.risk_signal_reviewed'];
const AUDIT_ACTIONS = [...FINAL_DECISIONS, ...PERSONAL_AUDIT_ACTIONS, 'catalogue.product_claim', 'catalogue.product_release', 'catalogue.product_escalate', 'catalogue.product_first_approval', 'catalogue.product_first_approval_recorded', 'catalogue.product_moderation_claimed', 'catalogue.product_moderation_released', 'catalogue.product_moderation_escalated', 'seller.verification_claim', 'seller.verification_release', 'seller.verification_claimed', 'seller.verification_released', 'seller.verification_escalated', 'seller.verification_document_viewed', 'review.claimed', 'review.released', 'review.public_reply', 'trust.public_reply', 'trust.case_claimed', 'trust.case_released', 'trust.case_escalated', 'trust.case_appealed', 'trust.risk_signal_claimed', 'trust.risk_signal_released', 'trust.product_suspended', 'trust.product_restored', 'trust.store_suspended', 'trust.store_restored', 'moderation.qa_claimed', 'moderation.qa_released', 'moderation.qa_reviewed', 'moderation.report_exported', 'moderation.catalogue_exported', 'moderation.trust_evidence_accessed', 'moderation.verification_document_accessed'];
const labels = value => String(value || '').replaceAll('_', ' ');
const int = value => { const number = Number(value || 0); if (!Number.isSafeInteger(number) || number < 0) throw new AppError('Moderation reporting data needs review.', 503, 'MODERATION_REPORT_INVALID'); return number; };
const ratio = (a, b) => b ? Math.round(a / b * 1000) / 10 : null;
const iso = value => value ? new Date(value).toISOString() : '';
const regex = value => new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

export const moderationReportingWindow = (period = '30days', timeZone = 'UTC', now = new Date()) => sellerOverviewWindow(period, timeZone, now);

function filters(request, actor, pageId) {
  const preferred = actor.preferences?.moderationReportingPeriod;
  const input = z.object({ country: z.string().trim().max(2).optional(), period: z.enum(['30days', '7months', 'year']).default(['30days', '7months', 'year'].includes(preferred) ? preferred : '30days'), report: z.enum(REPORTS).default('summary'),
    search: z.string().trim().max(100).default(''), q: z.string().trim().max(100).optional(), status: z.enum(['all', 'success', 'denied', 'failure', 'pending', 'completed', 'upheld', 'coaching', 'escalated']).default('all'), after: z.string().max(512).default(''), record: z.string().trim().max(100).default('') }).parse(request.query || {});
  if (input.after && !decodeCursor(input.after)) throw new AppError('The Moderation report cursor is invalid.', 422, 'MODERATION_FILTER_INVALID');
  const report = pageId === 'moderator-audit' ? 'audit' : input.report;
  if (report === 'summary' && (input.after || input.status !== 'all')) throw new AppError('Grouped reports do not support a record cursor or status.', 422, 'MODERATION_FILTER_INVALID');
  if (['audit', 'decisions'].includes(report) && !['all', 'success', 'denied', 'failure'].includes(input.status)) throw new AppError('Select a valid audit result.', 422, 'MODERATION_FILTER_INVALID');
  if (report === 'qa' && ['success', 'denied', 'failure'].includes(input.status)) throw new AppError('Select a valid QA status or outcome.', 422, 'MODERATION_FILTER_INVALID');
  if (input.record && report !== 'qa') throw new AppError('Only a QA report can select a QA review.', 422, 'MODERATION_FILTER_INVALID');
  return { ...input, report, search: input.q ?? input.search };
}

function storeJoin(scope, { owner = false } = {}) {
  return [{ $lookup: { from: Store.collection.name, localField: 'storeId', foreignField: '_id', as: 'sourceStore', pipeline: [{ $match: scope }, { $project: { publicId: 1, country: 1, name: 1, status: 1, ownerUserId: 1 } }] } }, { $unwind: '$sourceStore' },
    { $match: { $expr: { $eq: [owner ? '$userId' : '$ownerUserId', '$sourceStore.ownerUserId'] } } }, { $set: { country: '$sourceStore.country' } }];
}

export function moderationQaPipeline(context, where = {}) {
  const scope = context.countryScope;
  return [{ $match: { ...scope, ...where } },
    { $lookup: { from: Product.collection.name, localField: 'targetObjectId', foreignField: '_id', as: 'qaProduct', pipeline: [...storeJoin(scope), { $project: { publicId: 1, country: 1, storeId: 1, ownerUserId: 1, title: 1, status: 1, moderation: 1, __v: 1, sourceStore: 1 } }] } },
    { $lookup: { from: SellerVerification.collection.name, localField: 'targetObjectId', foreignField: '_id', as: 'qaVerification', pipeline: [...storeJoin(scope, { owner: true }), { $project: { publicId: 1, country: 1, storeId: 1, userId: 1, status: 1, reviewedAt: 1, reviewedByUserId: 1, reviewReason: 1, reviewHistory: 1, __v: 1, sourceStore: 1 } }] } },
    { $set: { sourceTarget: { $cond: [{ $eq: ['$targetType', 'product'] }, { $arrayElemAt: ['$qaProduct', 0] }, { $arrayElemAt: ['$qaVerification', 0] }] } } },
    { $match: { $expr: { $and: [{ $eq: ['$targetPublicId', '$sourceTarget.publicId'] }, { $eq: ['$country', '$sourceTarget.country'] }, { $in: ['$targetType', ['product', 'seller_verification']] }] } } },
    { $set: { qaSourceDecision: { $cond: [{ $eq: ['$targetType', 'product'] }, '$sourceTarget.moderation', '$sourceTarget'] },
      qaDecisionAction: { $switch: { branches: [{ case: { $eq: ['$decision', 'approved'] }, then: 'approve' }, { case: { $eq: ['$decision', 'changes_requested'] }, then: 'changes' }], default: 'reject' } } } },
    { $set: { qaProvenanceVerified: { $and: [{ $isNumber: '$decisionVersionSnapshot' }, { $gte: ['$decisionVersionSnapshot', 0] }, { $lte: ['$decisionVersionSnapshot', Number.MAX_SAFE_INTEGER] }, { $eq: ['$decisionVersionSnapshot', { $cond: [{ $isNumber: '$decisionVersionSnapshot' }, { $trunc: '$decisionVersionSnapshot' }, -1] }] }, { $gte: [{ $ifNull: ['$sourceTarget.__v', 0] }, '$decisionVersionSnapshot'] },
      { $eq: [{ $type: '$decisionEventAt' }, 'date'] }, { $eq: [{ $type: '$originalReviewerUserId' }, 'objectId'] }, { $lte: ['$decisionEventAt', '$sampledAt'] }, { $lte: ['$sampledAt', new Date()] },
      { $or: [
        { $and: [{ $eq: ['$qaSourceDecision.reviewedByUserId', '$originalReviewerUserId'] }, { $eq: ['$qaSourceDecision.reviewedAt', '$decisionEventAt'] },
          { $eq: [{ $cond: [{ $eq: ['$targetType', 'product'] }, { $ifNull: ['$qaSourceDecision.reason', ''] }, { $ifNull: ['$qaSourceDecision.reviewReason', ''] }] }, '$decisionReason'] },
          { $or: [{ $eq: ['$sourceTarget.status', '$decision'] }, { $and: [{ $eq: ['$targetType', 'product'] }, { $eq: ['$sourceTarget.status', 'published'] }, { $eq: ['$decision', 'approved'] }] }] }] },
        { $anyElementTrue: [{ $map: { input: { $ifNull: ['$qaSourceDecision.reviewHistory', []] }, as: 'event', in: { $and: [{ $eq: ['$$event.action', '$qaDecisionAction'] }, { $eq: ['$$event.actorUserId', '$originalReviewerUserId'] }, { $eq: ['$$event.at', '$decisionEventAt'] }, { $eq: [{ $ifNull: ['$$event.reason', ''] }, '$decisionReason'] }] } } }] },
      ] }] } } },
    { $match: { qaProvenanceVerified: true } },
    { $lookup: { from: TrustCase.collection.name, localField: 'escalationCaseId', foreignField: '_id', as: 'qaEscalation', pipeline: [{ $project: { publicId: 1, qaReviewId: 1, qaReviewPublicId: 1, country: 1, type: 1, productId: 1, productPublicId: 1, storeId: 1, storePublicId: 1 } }] } },
    { $set: { qaEscalation: { $arrayElemAt: ['$qaEscalation', 0] } } },
    { $lookup: { from: AuditLog.collection.name, let: { qaId: '$publicId', qaCountry: '$country', reviewer: '$qaReviewerUserId', outcome: '$outcome', reviewedAt: '$reviewedAt' }, as: 'qaOutcomeAudit', pipeline: [{ $match: { action: 'moderation.qa_reviewed', targetType: 'moderation_qa', result: 'success', $expr: { $and: [{ $eq: ['$targetPublicId', '$$qaId'] }, { $eq: ['$country', '$$qaCountry'] }, { $eq: ['$actorId', '$$reviewer'] }, { $eq: ['$metadata.outcome', '$$outcome'] }, { $gte: ['$createdAt', '$$reviewedAt'] }, { $lt: ['$createdAt', { $add: ['$$reviewedAt', 60000] }] }] } } }, { $limit: 1 }, { $project: { _id: 1 } }] } },
    { $set: { qaOutcomeVerified: { $and: [{ $eq: ['$status', 'completed'] }, { $eq: [{ $type: '$qaReviewerUserId' }, 'objectId'] }, { $ne: ['$qaReviewerUserId', '$originalReviewerUserId'] }, { $ne: ['$qaReviewerUserId', '$sourceTarget.sourceStore.ownerUserId'] },
      { $eq: [{ $type: '$reviewedAt' }, 'date'] }, { $gte: ['$reviewedAt', '$sampledAt'] }, { $lte: ['$reviewedAt', new Date()] }, { $gt: [{ $size: '$qaOutcomeAudit' }, 0] },
      { $or: [{ $in: ['$outcome', ['upheld', 'coaching']] }, { $and: [{ $eq: ['$outcome', 'escalated'] }, { $eq: ['$qaEscalation.publicId', '$escalationCasePublicId'] }, { $eq: ['$qaEscalation.qaReviewId', '$_id'] }, { $eq: ['$qaEscalation.qaReviewPublicId', '$publicId'] },
        { $eq: ['$qaEscalation.country', '$country'] }, { $eq: ['$qaEscalation.type', 'moderation_quality'] }, { $eq: ['$qaEscalation.storeId', '$sourceTarget.storeId'] }, { $eq: ['$qaEscalation.storePublicId', '$sourceTarget.sourceStore.publicId'] },
        { $or: [{ $eq: ['$targetType', 'seller_verification'] }, { $and: [{ $eq: ['$qaEscalation.productId', '$targetObjectId'] }, { $eq: ['$qaEscalation.productPublicId', '$targetPublicId'] }] }] }] }] }] } } }];
}

// Every audit target must still have an authoritative source in the authorized market.
// Metadata is not a country boundary: a forged row cannot borrow another market's target.
function auditPipeline(context, window, query = {}, decisionsOnly = false) {
  const match = { ...context.countryScope, action: { $in: decisionsOnly ? FINAL_DECISIONS : AUDIT_ACTIONS }, createdAt: { $gte: window.start, $lt: window.end } };
  if (query.status && query.status !== 'all') match.result = query.status;
  if (query.search) match.$or = ['action', 'targetPublicId', 'actorPublicId', 'requestId'].map(field => ({ [field]: regex(query.search) }));
  const source = (Model, field, pipeline) => ({ $lookup: { from: Model.collection.name, localField: 'targetPublicId', foreignField: 'publicId', as: field, pipeline: [...pipeline, { $project: { publicId: 1, country: 1 } }] } });
  const documentSource = [{ $lookup: { from: SellerVerification.collection.name, localField: 'verificationId', foreignField: '_id', as: 'verifiedSource', pipeline: [...storeJoin(context.countryScope, { owner: true }), { $project: { publicId: 1, country: 1, storeId: 1, userId: 1 } }] } },
    { $unwind: '$verifiedSource' }, { $match: { $expr: { $and: [{ $eq: ['$storeId', '$verifiedSource.storeId'] }, { $eq: ['$userId', '$verifiedSource.userId'] }] } } }, { $set: { country: '$verifiedSource.country', publicId: '$verifiedSource.publicId' } }];
  return [{ $match: match }, source(Product, 'auditProduct', storeJoin(context.countryScope)), source(SellerVerification, 'auditVerification', storeJoin(context.countryScope, { owner: true })), source(VerificationDocument, 'auditDocument', documentSource),
    source(Store, 'auditStore', [{ $match: context.countryScope }]), source(ModerationQaReview, 'auditQa', moderationQaPipeline(context)),
    { $lookup: { from: 'reviews', localField: 'targetPublicId', foreignField: 'publicId', as: 'auditReview', pipeline: [...moderationReviewPipeline(context), { $project: { publicId: 1, country: 1 } }] } },
    { $lookup: { from: TrustCase.collection.name, localField: 'targetPublicId', foreignField: 'publicId', as: 'auditCase', pipeline: [...moderationTrustCasePipeline(context), { $project: { publicId: 1, country: 1 } }] } },
    { $lookup: { from: 'risksignals', localField: 'targetPublicId', foreignField: 'publicId', as: 'auditRisk', pipeline: [...moderationRiskSignalPipeline(context), { $project: { publicId: 1, country: 1 } }] } },
    { $set: { auditTarget: { $switch: { branches: [
      ['product', 'auditProduct'], ['seller_verification', 'auditVerification'], ['verification_document', 'auditDocument'], ['store', 'auditStore'], ['review', 'auditReview'], ['trust_case', 'auditCase'], ['risk_signal', 'auditRisk'], ['moderation_qa', 'auditQa'],
    ].map(([type, field]) => ({ case: { $eq: ['$targetType', type] }, then: { $arrayElemAt: ['$' + field, 0] } })), default: null } } } },
    { $match: { $expr: { $or: [{ $eq: ['$country', '$auditTarget.country'] }, { $and: [{ $eq: ['$targetType', 'moderation_report'] }, { $eq: ['$action', 'moderation.report_exported'] }, { $or: [{ $in: ['$targetPublicId', [...REPORTS, 'audit']] }, { $and: [{ $eq: [{ $ifNull: ['$targetPublicId', ''] }, ''] }, { $in: ['$metadata.report', ['reviews', 'cases', 'signals']] }] }] }] },
      { $and: [{ $eq: ['$targetType', 'moderation_export'] }, { $eq: ['$action', 'moderation.catalogue_exported'] }, { $in: ['$metadata.pageId', ['moderator-products', 'moderator-verifications']] }] },
      { $and: [{ $eq: ['$targetType', 'moderation_report'] }, { $eq: ['$action', 'moderation.settings_exported'] }] },
      { $and: [{ $eq: ['$targetType', 'user'] }, { $eq: ['$targetPublicId', '$actorPublicId'] }, { $in: ['$action', PERSONAL_AUDIT_ACTIONS] }] }] } } },
    { $project: { requestId: 1, actorPublicId: 1, action: 1, targetType: { $cond: [{ $eq: ['$targetType', 'verification_document'] }, 'seller_verification', '$targetType'] },
      targetPublicId: { $switch: { branches: [{ case: { $eq: ['$targetType', 'verification_document'] }, then: '$auditTarget.publicId' }, { case: { $eq: ['$action', 'moderation.catalogue_exported'] }, then: '$metadata.pageId' }, { case: { $eq: ['$action', 'moderation.settings_exported'] }, then: 'settings' }], default: { $ifNull: ['$targetPublicId', '$metadata.report'] } } }, country: 1, result: 1, createdAt: 1,
      'metadata.decision': 1, 'metadata.status': 1, 'metadata.enforcement': 1, 'metadata.appealReview': 1, 'metadata.outcome': 1, 'metadata.restricted': 1, 'metadata.secondReviewRequired': 1 } }];
}

function safeAudit(row) {
  const source = row.metadata || {}, metadata = {};
  for (const [key, values] of Object.entries({ decision: ['approve', 'reject', 'changes', 'publish'], status: ['approved', 'rejected', 'changes_requested', 'published', 'investigating', 'actioned', 'dismissed', 'closed', 'reviewed'], enforcement: ['none', 'suspend_product', 'restore_product', 'suspend_store', 'restore_store'], outcome: ['upheld', 'coaching', 'escalated'] })) if (values.includes(source[key])) metadata[key] = source[key];
  for (const key of ['appealReview', 'restricted', 'secondReviewRequired']) if (typeof source[key] === 'boolean') metadata[key] = source[key];
  return { requestId: row.requestId, actorPublicId: row.actorPublicId || '', action: row.action, targetType: row.targetType || '', targetPublicId: row.targetPublicId || '', country: row.country, result: row.result, createdAt: row.createdAt, metadata };
}

async function queries(tasks, session) { if (!session) return Promise.all(tasks.map(task => task())); const values = []; for (const task of tasks) values.push(await task()); return values; }
const group = (extra = {}) => ({ $group: { _id: '$country', count: { $sum: 1 }, ...extra } });

export async function moderationReportSummary(context, window, now = new Date()) {
  const scope = context.countryScope, aggregate = (Model, pipeline) => Model.aggregate(pipeline).session(context.session || null);
  const [products, verifications, reviews, cases, risks, qa, decisions, publications, appeals] = await queries([
    () => aggregate(Product, [{ $match: { status: 'submitted' } }, ...storeJoin(scope), group({ high: { $sum: { $cond: [{ $or: [{ $eq: ['$moderation.riskLevel', 'high'] }, { $eq: ['$moderation.secondReviewRequired', true] }] }, 1, 0] } }, oldest: { $min: '$moderation.submittedAt' } })]),
    () => aggregate(SellerVerification, [{ $match: { status: { $in: ['submitted', 'appealed'] } } }, ...storeJoin(scope, { owner: true }), group({ high: { $sum: { $cond: [{ $eq: ['$sellerType', 'business'] }, 1, 0] } }, appeals: { $sum: { $cond: [{ $eq: ['$status', 'appealed'] }, 1, 0] } }, oldest: { $min: '$submittedAt' } })]),
    () => aggregate(mongoose.models.Review, [...moderationReviewPipeline(context, { status: 'all' }), { $match: { status: { $in: ['pending', 'disputed'] } } }, group({ appeals: { $sum: { $cond: [{ $eq: ['$status', 'disputed'] }, 1, 0] } }, oldest: { $min: '$createdAt' } })]),
    () => aggregate(TrustCase, [...moderationTrustCasePipeline(context, { status: 'all' }), { $match: { status: { $in: ['open', 'investigating', 'appealed'] } } }, group({ high: { $sum: { $cond: [{ $in: ['$type', ['counterfeit', 'unsafe_product', 'prohibited_product']] }, 1, 0] } }, appeals: { $sum: { $cond: [{ $eq: ['$status', 'appealed'] }, 1, 0] } }, oldest: { $min: '$createdAt' } })]),
    () => aggregate(mongoose.models.RiskSignal, [...moderationRiskSignalPipeline(context, { status: 'all' }), { $match: { status: 'open' } }, group({ high: { $sum: { $cond: [{ $in: ['$severity', ['high', 'critical']] }, 1, 0] } }, oldest: { $min: '$createdAt' } })]),
    () => aggregate(ModerationQaReview, [...moderationQaPipeline(context), { $group: { _id: '$country', pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
      completed: { $sum: { $cond: [{ $and: ['$qaOutcomeVerified', { $gte: ['$reviewedAt', window.start] }, { $lt: ['$reviewedAt', window.end] }, { $in: ['$outcome', ['upheld', 'coaching', 'escalated']] }] }, 1, 0] } },
      upheld: { $sum: { $cond: [{ $and: ['$qaOutcomeVerified', { $gte: ['$reviewedAt', window.start] }, { $lt: ['$reviewedAt', window.end] }, { $eq: ['$outcome', 'upheld'] }] }, 1, 0] } },
      coaching: { $sum: { $cond: [{ $and: ['$qaOutcomeVerified', { $gte: ['$reviewedAt', window.start] }, { $lt: ['$reviewedAt', window.end] }, { $eq: ['$outcome', 'coaching'] }] }, 1, 0] } },
      escalated: { $sum: { $cond: [{ $and: ['$qaOutcomeVerified', { $gte: ['$reviewedAt', window.start] }, { $lt: ['$reviewedAt', window.end] }, { $eq: ['$outcome', 'escalated'] }] }, 1, 0] } } } }]),
    () => aggregate(AuditLog, [...auditPipeline(context, window, { status: 'success' }, true), group({ appeals: { $sum: { $cond: [{ $eq: ['$metadata.appealReview', true] }, 1, 0] } }, reviewerIds: { $addToSet: '$actorPublicId' } })]),
    () => aggregate(Product, [{ $match: { publishedAt: { $gte: window.start, $lt: window.end } } }, ...storeJoin(scope), group()]),
    () => aggregate(SellerVerification, [{ $match: { 'appeal.submittedAt': { $gte: window.start, $lt: window.end } } }, ...storeJoin(scope, { owner: true }), group()]),
  ], context.session);
  const fields = ['openCount', 'highRiskCount', 'appealCount', 'pendingQaCount', 'completedQaCount', 'upheldQaCount', 'coachingQaCount', 'escalatedQaCount', 'decisionCount', 'appealDecisionCount', 'publishedCount', 'appealSubmissionCount'];
  const groups = new Map(context.countries.filter(row => !context.country || row.code === context.country).map(row => [row.code, { country: row.code, ...Object.fromEntries(fields.map(field => [field, 0])), reviewers: new Set() }]));
  const queues = [];
  for (const [key, label, href, records] of [['products', 'Products', '/moderation/products', products], ['verifications', 'Seller verifications', '/moderation/verifications', verifications], ['reviews', 'Reviews', '/moderation/reviews', reviews], ['cases', 'Trust cases', '/moderation/risk-cases', cases], ['risks', 'Risk signals', '/moderation/risk-cases?kind=signals', risks]]) {
    for (const row of records) { const market = groups.get(row._id); if (!market) continue; market.openCount += int(row.count); market.highRiskCount += int(row.high); market.appealCount += int(row.appeals); queues.push({ country: row._id, queue: key, label, count: int(row.count), highRiskCount: int(row.high), appealCount: int(row.appeals), oldestAt: row.oldest || null, href: href + (href.includes('?') ? '&' : '?') + 'country=' + row._id }); }
  }
  for (const row of qa) { const market = groups.get(row._id); if (market) Object.assign(market, { pendingQaCount: int(row.pending), completedQaCount: int(row.completed), upheldQaCount: int(row.upheld), coachingQaCount: int(row.coaching), escalatedQaCount: int(row.escalated) }); }
  for (const row of decisions) { const market = groups.get(row._id); if (market) { market.decisionCount = int(row.count); market.appealDecisionCount = int(row.appeals); for (const id of row.reviewerIds || []) if (id) market.reviewers.add(id); } }
  for (const row of publications) if (groups.has(row._id)) groups.get(row._id).publishedCount = int(row.count);
  for (const row of appeals) if (groups.has(row._id)) groups.get(row._id).appealSubmissionCount = int(row.count);
  const totals = Object.fromEntries(fields.map(field => [field, int([...groups.values()].reduce((sum, row) => sum + row[field], 0))]));
  totals.reviewerCount = new Set([...groups.values()].flatMap(row => [...row.reviewers])).size;
  const derived = row => ({ ...Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'reviewers')), reviewerCount: row.reviewers?.size ?? row.reviewerCount, decisionQuality: ratio(row.upheldQaCount, row.completedQaCount) });
  return { groups: [...groups.values()].map(derived), totals: derived(totals), queues: queues.sort((a, b) => a.country.localeCompare(b.country) || a.queue.localeCompare(b.queue)), observedAt: now };
}

export async function loadModerationSidebar(context, { now = new Date() } = {}) {
  const preferred = context.actor.preferences?.moderationReportingPeriod, period = ['30days', '7months', 'year'].includes(preferred) ? preferred : '30days';
  const summary = await moderationReportSummary(context, moderationReportingWindow(period, context.timeZone, now), now);
  return { ...summary.totals, queueCounts: summary.queues };
}

export function moderationQaDto(row, actor) {
  const target = row.sourceTarget || {}, moderation = row.targetType === 'product' ? target.moderation : target;
  const expectedAction = row.decision === 'approved' ? 'approve' : row.decision === 'changes_requested' ? 'changes' : 'reject';
  const history = row.targetType === 'product' ? target.moderation?.reviewHistory : target.reviewHistory;
  const historic = (history || []).find(entry => entry.action === expectedAction && String(entry.actorUserId) === String(row.originalReviewerUserId) && entry.reason === row.decisionReason && row.decisionEventAt && iso(entry.at) === iso(row.decisionEventAt));
  const current = String(moderation?.reviewedByUserId || '') === String(row.originalReviewerUserId) && (target.status === row.decision || (row.targetType === 'product' && target.status === 'published' && row.decision === 'approved')) && Boolean(moderation?.reviewedAt) && (moderation.reason ?? moderation.reviewReason ?? '') === row.decisionReason && row.decisionEventAt && iso(moderation.reviewedAt) === iso(row.decisionEventAt);
  const provenanceVerified = Boolean(historic || current) && Number.isSafeInteger(row.decisionVersionSnapshot) && row.decisionVersionSnapshot >= 0 && (target.__v || 0) >= row.decisionVersionSnapshot && new Date(row.decisionEventAt) <= new Date(row.sampledAt) && new Date(row.sampledAt) <= new Date();
  return { publicId: row.publicId, targetType: row.targetType, targetPublicId: row.targetPublicId, country: row.country, riskLevel: row.riskLevel, decision: row.decision, decisionReason: row.decisionReason, decisionAt: row.decisionEventAt || moderation?.reviewedAt || null,
    sampledAt: row.sampledAt, createdAt: row.createdAt, status: row.status, outcome: row.outcome || '', outcomeVerified: Boolean(row.qaOutcomeVerified), reviewedAt: row.reviewedAt || null, note: row.note || '', version: row.__v || 0,
    assigned: Boolean(row.assignedUserId), assignedToYou: String(row.assignedUserId || '') === String(actor._id), originalReviewerIsYou: String(row.originalReviewerUserId) === String(actor._id), provenanceVerified,
    storeConflict: [target.ownerUserId, target.userId, target.sourceStore?.ownerUserId].some(id => id && String(id) === String(actor._id)),
    targetTitle: target.title || target.sourceStore?.name || row.targetPublicId, storePublicId: target.sourceStore?.publicId || '', escalationCasePublicId: row.escalationCasePublicId || '' };
}

const qaVersion = z.union([z.number(), z.string().regex(/^\d+$/)]).pipe(z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const qaId = z.string().trim().min(4).max(100).regex(/^[A-Za-z0-9_-]+$/);
const qaConflict = () => new AppError('This quality review changed. Reload before continuing.', 409, 'MODERATION_QA_VERSION_CONFLICT');

/** QA ownership, live authorization, source decision and outcome audit commit together. */
export async function actModerationQa(request, reviewId, body, { workspace = true } = {}) {
  const id = qaId.parse(reviewId), input = z.object({ action: z.enum(['claim', 'release', 'complete']), version: qaVersion,
    outcome: z.enum(['upheld', 'coaching', 'escalated']).optional(), note: z.string().trim().max(1000).optional() }).parse(body || {});
  if (input.action === 'complete' && (!input.outcome || !input.note || input.note.length < 10)) throw new AppError('Select a QA outcome and record a reason of 10 to 1000 characters.', 422, 'MODERATION_QA_OUTCOME_INVALID');
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const context = await moderationAccess(request, { session, workspace });
      const sample = await ModerationQaReview.findOne({ publicId: id, ...context.countryScope }).session(session);
      if (!sample) throw new AppError('Quality review not found.', 404, 'MODERATION_QA_NOT_FOUND');
      if (Number(sample.__v || 0) !== input.version) throw qaConflict();
      if (sample.status !== 'pending') throw new AppError('This quality review is already completed.', 409, 'MODERATION_QA_STATE');
      if (String(sample.originalReviewerUserId) === String(context.actor._id)) throw new AppError('An independent reviewer must QA this decision.', 403, 'MODERATION_QA_FOUR_EYES');
      const Model = sample.targetType === 'product' ? Product : SellerVerification;
      const target = await Model.findOne({ _id: sample.targetObjectId, publicId: sample.targetPublicId }).session(session);
      const store = target && await Store.findOne({ _id: target.storeId, country: sample.country }).session(session);
      if (!target || !store || !context.countries.some(row => row.code === store.country)
        || String(sample.targetType === 'product' ? target.ownerUserId : target.userId) !== String(store.ownerUserId)) throw new AppError('Quality review source not found in this country.', 404, 'MODERATION_QA_NOT_FOUND');
      const sourceTarget = { ...target.toObject(), sourceStore: store.toObject() };
      const dto = moderationQaDto({ ...sample.toObject(), sourceTarget }, context.actor);
      if (!dto.provenanceVerified) throw new AppError('The saved decision evidence needs investigation before quality review.', 409, 'MODERATION_QA_PROVENANCE_INVALID');
      if (dto.storeConflict || await StoreMember.exists({ storeId: store._id, userId: context.actor._id, status: mongoose.trusted({ $in: ['active', 'invited'] }) }).session(session)) throw new AppError('A reviewer who is independent of this store must handle quality review.', 403, 'MODERATION_QA_CONFLICT_OF_INTEREST');
      const assigned = sample.assignedUserId && String(sample.assignedUserId) === String(context.actor._id);
      if (input.action === 'claim' && sample.assignedUserId) throw new AppError('This quality review has already been claimed.', 409, 'MODERATION_QA_ALREADY_CLAIMED');
      if (input.action !== 'claim' && !assigned) throw new AppError('Claim this quality review before acting on it.', 409, 'MODERATION_QA_CLAIM_REQUIRED');
      await fenceModerationAccess(context, session);
      const storeFence = await Store.updateOne({ _id: store._id, country: store.country, ownerUserId: store.ownerUserId, status: store.status, __v: store.__v || 0 }, { $inc: { __v: 1 } }, { session });
      const targetFence = await Model.updateOne({ _id: target._id, publicId: target.publicId, storeId: store._id, __v: target.__v || 0 }, { $inc: { __v: 1 } }, { session });
      if (storeFence.modifiedCount !== 1 || targetFence.modifiedCount !== 1) throw qaConflict();
      const at = new Date();
      if (input.action === 'claim') { sample.assignedUserId = context.actor._id; sample.assignedAt = at; }
      else if (input.action === 'release') { sample.assignedUserId = null; sample.assignedAt = null; }
      else {
        sample.status = 'completed'; sample.qaReviewerUserId = context.actor._id; sample.reviewedAt = at; sample.outcome = input.outcome; sample.note = input.note;
        sample.assignedUserId = null; sample.assignedAt = null;
        if (input.outcome === 'escalated') {
          const [referral] = await TrustCase.create([{ publicId: publicId('tc'), type: 'moderation_quality', status: 'open', country: store.country,
            reporterUserId: context.actor._id, storeId: store._id, storePublicId: store.publicId,
            ...(sample.targetType === 'product' ? { productId: target._id, productPublicId: target.publicId } : {}),
            qaReviewId: sample._id, qaReviewPublicId: sample.publicId,
            description: `Quality review ${sample.publicId} referred decision ${sample.decision} on ${sample.targetPublicId} for independent investigation. ${input.note}` }], { session });
          sample.escalationCaseId = referral._id; sample.escalationCasePublicId = referral.publicId;
        }
      }
      sample.increment(); await sample.save({ session });
      const action = input.action === 'complete' ? 'moderation.qa_reviewed' : input.action === 'claim' ? 'moderation.qa_claimed' : 'moderation.qa_released';
      if (input.action === 'complete' && sample.outcome === 'escalated') {
        await queueModerationAlert({ country: store.country, kind: 'escalation', href: '/moderation/risk-cases?record=' + sample.escalationCasePublicId + '&country=' + store.country }, session);
      }
      await writeAudit(request, action, { actor: context.actor, session, targetType: 'moderation_qa', targetPublicId: sample.publicId, country: store.country,
        metadata: input.action === 'complete' ? { outcome: sample.outcome, escalationCasePublicId: sample.escalationCasePublicId || undefined } : undefined });
      result = moderationQaDto({ ...sample.toObject(), sourceTarget, qaOutcomeVerified: input.action === 'complete' }, context.actor);
    });
    return result;
  } finally { await session.endSession(); }
}

function reportSource(context, window, query) {
  if (query.report === 'qa') {
    const completed = { status: 'completed', reviewedAt: { $gte: window.start, $lt: window.end } }, clauses = [];
    if (query.status === 'pending') clauses.push({ status: 'pending' });
    else if (query.status === 'completed') clauses.push(completed);
    else if (['upheld', 'coaching', 'escalated'].includes(query.status)) clauses.push({ ...completed, outcome: query.status });
    else clauses.push({ $or: [{ status: 'pending' }, completed] });
    if (query.search) clauses.push({ $or: ['publicId', 'targetPublicId'].map(field => ({ [field]: regex(query.search) })) });
    const pipeline = moderationQaPipeline(context, { $and: clauses });
    if (['upheld', 'coaching', 'escalated'].includes(query.status)) pipeline.push({ $match: { qaOutcomeVerified: true } });
    return { Model: ModerationQaReview, pipeline, columns: ['QA review', 'Target', 'Country', 'Decision', 'Risk', 'Status', 'Outcome'], map: row => moderationQaDto(row, context.actor), cells: row => [row.publicId, row.targetPublicId, row.country, labels(row.decision), labels(row.riskLevel), labels(row.status), row.status === 'pending' ? 'Pending' : row.outcomeVerified ? labels(row.outcome) : 'Needs audit verification'],
      headers: ['QA review', 'Target type', 'Target', 'Country', 'Decision', 'Risk', 'Status', 'Outcome', 'Sampled', 'Reviewed', 'Escalation case'], csv: row => [row.publicId, row.targetType, row.targetPublicId, row.country, row.decision, row.riskLevel, row.status, row.outcomeVerified ? row.outcome : '', iso(row.sampledAt), iso(row.reviewedAt), row.outcomeVerified ? row.escalationCasePublicId : ''] };
  }
  return { Model: AuditLog, pipeline: auditPipeline(context, window, query, query.report === 'decisions'), columns: ['Action', 'Target', 'Country', 'Reviewer', 'Result', 'Recorded'], map: safeAudit,
    cells: row => [labels(row.action), row.targetPublicId || '—', row.country, row.actorPublicId || 'System', labels(row.result), iso(row.createdAt)], headers: ['Request', 'Action', 'Target type', 'Target', 'Country', 'Reviewer', 'Result', 'Decision', 'Status', 'Enforcement', 'Appeal review', 'Recorded'],
    csv: row => [row.requestId, row.action, row.targetType, row.targetPublicId, row.country, row.actorPublicId, row.result, row.metadata.decision || '', row.metadata.status || '', row.metadata.enforcement || '', row.metadata.appealReview === undefined ? '' : row.metadata.appealReview, iso(row.createdAt)] };
}

async function recordPage(source, after) {
  const [result] = await source.Model.aggregate([...source.pipeline, { $facet: { items: [{ $match: cursorScope({}, after) }, { $sort: cursorSort() }, { $limit: SIZE + 1 }], total: [{ $count: 'count' }] } }]);
  const page = pageResult(result?.items || [], { limit: SIZE, total: result?.total?.[0]?.count || 0 });
  return { items: page.items.map(source.map), page: page.page };
}

export async function loadModerationReportPage(request, pageId, { now = new Date() } = {}) {
  if (!['moderator-overview', 'moderator-audit', 'moderator-reports'].includes(pageId)) throw new AppError('Moderation reporting page not found.', 404, 'MODERATION_PAGE_NOT_FOUND');
  const context = await moderationAccess(request), query = filters(request, context.actor, pageId), window = moderationReportingWindow(query.period, context.timeZone, now), summary = await moderationReportSummary(context, window, now), totals = summary.totals;
  let items, page, columns, rows;
  if (query.report === 'summary') { items = summary.groups.filter(row => !query.search || row.country.toLowerCase().includes(query.search.toLowerCase())); columns = ['Country', 'Open', 'High risk', 'Appeals', 'Decisions', 'QA completed', 'Decision quality']; rows = items.map(row => ({ cells: [row.country, row.openCount, row.highRiskCount, row.appealCount, row.decisionCount, row.completedQaCount, row.decisionQuality === null ? 'No observations' : row.decisionQuality + '%'] })); page = { count: items.length, total: items.length, hasMore: false, next: '' }; }
  else { const source = reportSource(context, window, query), result = await recordPage(source, query.after); items = result.items; page = result.page; columns = source.columns; rows = items.map(row => ({ cells: source.cells(row), ...(query.report === 'qa' ? { href: '/moderation/reports?' + new URLSearchParams({ report: 'qa', country: row.country, period: query.period, record: row.publicId }) } : {}) })); }
  let selectedQa = null;
  if (query.record) {
    const [row] = await ModerationQaReview.aggregate(moderationQaPipeline(context, { publicId: query.record }));
    if (!row) throw new AppError('QA review not found.', 404, 'MODERATION_QA_NOT_FOUND');
    selectedQa = moderationQaDto(row, context.actor);
    selectedQa.storeConflict ||= Boolean(await StoreMember.exists({ storeId: row.sourceTarget.storeId, userId: context.actor._id, status: mongoose.trusted({ $in: ['active', 'invited'] }) }));
  }
  const suffix = context.country ? '&country=' + context.country : '', priorities = [{ count: totals.highRiskCount, text: 'high risk records need review', href: '/moderation/products?risk=high' }, { count: totals.appealCount, text: 'appeals need independent review', href: '/moderation/risk-cases?status=appealed' }, { count: totals.pendingQaCount, text: 'completed decisions await quality review', href: '/moderation/reports?report=qa&status=pending' }].filter(row => row.count).map(row => ({ text: row.count + ' ' + row.text, href: row.href + suffix }));
  const recent = await AuditLog.aggregate([...auditPipeline(context, window), { $sort: cursorSort() }, { $limit: 4 }]);
  const flow = { kind: 'reports', pageId, country: context.country, context: moderationPublicContext(context), timeZone: window.timeZone, period: query.period, report: query.report, range: { start: window.start, end: window.end },
    reportOptions: REPORTS.map(value => ({ value, label: value === 'qa' ? 'Decision quality reviews' : labels(value) })), periodOptions: [{ value: '30days', label: 'Last 30 days' }, { value: '7months', label: 'Last 7 months' }, { value: 'year', label: 'This year' }],
    metrics: [{ label: 'Open reviews', value: String(totals.openCount), detail: 'Complete scoped review queues' }, { label: 'High risk', value: String(totals.highRiskCount), detail: 'Current high risk and restricted records' }, { label: 'Appeals', value: String(totals.appealCount), detail: 'Current independent review backlog' }, { label: 'Decision quality', value: totals.decisionQuality === null ? '—' : totals.decisionQuality + '%', detail: `${totals.completedQaCount} independent QA outcomes in this period` }],
    summary: totals, totals, groups: summary.groups, queues: summary.queues, queueBreakdown: ['products', 'verifications', 'reviews', 'cases', 'risks'].map(key => ({ label: ({ products: 'Products', verifications: 'Seller verifications', reviews: 'Reviews', cases: 'Trust cases', risks: 'Risk signals' })[key], value: summary.queues.filter(row => row.queue === key).reduce((sum, row) => sum + row.count, 0), href: summary.queues.find(row => row.queue === key)?.href || '/moderation/products' })),
    items, rows, columns, page, selectedQa, priorities, insights: priorities, priorityHref: priorities[0]?.href || '/moderation/products',
    filters: { search: query.search, status: query.status, after: query.after, statuses: query.report === 'summary' ? [] : (query.report === 'qa' ? ['all', 'pending', 'completed', 'upheld', 'coaching', 'escalated'] : ['all', 'success', 'denied', 'failure']).map(value => ({ value, label: labels(value) })), params: { country: context.country, period: query.period, ...(query.report === 'audit' ? {} : { report: query.report }) } },
    workflow: [{ title: 'Review catalogue queues', text: 'Claim source records and complete an independent decision.', href: '/moderation/products' }, { title: 'Review quality samples', text: 'Re-review completed decisions without changing their original evidence.', href: '/moderation/reports?report=qa' }, { title: 'Review recorded actions', text: 'Trace real decisions and appeals in the authorized countries.', href: '/moderation/audit' }],
    health: { label: 'Decision quality', value: totals.decisionQuality, rows: [{ label: 'QA completed', value: String(totals.completedQaCount) }, { label: 'QA upheld', value: String(totals.upheldQaCount) }, { label: 'QA escalations', value: String(totals.escalatedQaCount) }], note: 'Quality is upheld outcomes divided by completed independent quality reviews.' },
    verification: { label: 'Decision quality', value: totals.decisionQuality === null ? '—' : totals.decisionQuality + '%', detail: totals.completedQaCount ? 'Independent QA outcomes' : 'No observations' },
    activity: recent.map(row => ({ text: labels(row.action), at: row.createdAt, href: '/moderation/audit?country=' + row.country, icon: 'i-shield' })), activityHref: '/moderation/audit',
    coverage: { title: 'Moderation coverage', description: 'Authoritative source markets and recorded independent review work.', people: [], stats: [{ label: 'Countries', value: String(summary.groups.length) }, { label: 'Reviewers', value: String(totals.reviewerCount) }], note: 'Reports exclude message contents, identity documents and customer contacts.', href: '/moderation/reports', label: 'Open trust reports' },
    tableTitle: query.report === 'audit' ? 'Moderation audit' : query.report === 'qa' ? 'Decision quality reviews' : query.report === 'decisions' ? 'Recorded decisions and appeals' : 'Trust summary by market', tableDescription: 'Counts cover all matching source records. Record tables use cursor pagination.', emptyText: 'No moderation records match this view.',
    exportHref: (pageId === 'moderator-audit' ? '/moderation/audit' : '/moderation/reports') + '/export.csv?' + new URLSearchParams({ country: context.country, period: query.period, ...(query.report === 'audit' ? {} : { report: query.report }), search: query.search, status: query.status }) };
  flow.sidebar = { ...totals, queueCounts: summary.queues };
  if (pageId === 'moderator-overview') {
    const records = await AuditLog.aggregate([...auditPipeline(context, window, { status: 'success' }, true), { $group: { _id: { $dateToString: { date: '$createdAt', format: window.monthly ? '%Y-%m' : '%Y-%m-%d', timezone: window.timeZone } }, count: { $sum: 1 } } }]);
    flow.trend = window.buckets.map(bucket => { const value = records.filter(row => bucket.keys.includes(row._id)).reduce((sum, row) => sum + int(row.count), 0); return { key: bucket.key, label: bucket.label, value, display: String(value) }; });
    flow.trendLabel = 'Recorded moderation decisions'; flow.trendDescription = `Recorded decisions in the ${window.timeZone} reporting calendar.`;
  }
  await assertModerationReadAccess(request, context); return flow;
}

export function moderationCsvCell(value) { const text = String(value ?? ''); return '"' + (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) ? "'" + text : text).replaceAll('"', '""') + '"'; }
function waitForDrain(response) { return new Promise((resolve, reject) => { const clean = () => { response.off('drain', drain); response.off('close', close); response.off('error', error); }; const drain = () => { clean(); resolve(); }, close = () => { clean(); reject(new AppError('Export connection closed.', 499, 'EXPORT_CLOSED')); }, error = cause => { clean(); reject(cause); }; response.once('drain', drain); response.once('close', close); response.once('error', error); if (response.destroyed) close(); }); }

export async function streamModerationReportCsv(request, response, pageId, { now = new Date() } = {}) {
  if (!['moderator-overview', 'moderator-audit', 'moderator-reports'].includes(pageId)) throw new AppError('Moderation report not found.', 404, 'MODERATION_PAGE_NOT_FOUND');
  const context = await moderationAccess(request), query = filters(request, context.actor, pageId), window = moderationReportingWindow(query.period, context.timeZone, now);
  await writeAudit(request, 'moderation.report_exported', { actor: context.actor, targetType: 'moderation_report', targetPublicId: query.report, country: context.country || context.countries[0].code, metadata: { report: query.report, period: query.period, countryScope: context.country || context.countries.map(row => row.code) } });
  await assertModerationReadAccess(request, context); response.set('Content-Type', 'text/csv; charset=utf-8'); response.set('Content-Disposition', `attachment; filename="classic-mart-moderation-${query.report}.csv"`); response.set('Cache-Control', 'private, no-store'); response.set('X-Robots-Tag', 'noindex, nofollow');
  const line = async values => { if (response.destroyed) throw new AppError('Export connection closed.', 499, 'EXPORT_CLOSED'); if (!response.write(values.map(moderationCsvCell).join(',') + '\r\n')) await waitForDrain(response); };
  if (query.report === 'summary') {
    const summary = await moderationReportSummary(context, window, now); await assertModerationReadAccess(request, context);
    await line(['Country', 'Open reviews', 'High risk', 'Appeals', 'Recorded decisions', 'Publications', 'Appeal submissions', 'Appeal decisions', 'QA pending', 'QA completed', 'QA upheld', 'QA coaching', 'QA escalated', 'Decision quality percent', 'Reviewers']);
    for (const row of summary.groups) { if (query.search && !row.country.toLowerCase().includes(query.search.toLowerCase())) continue; await assertModerationReadAccess(request, context); await line([row.country, row.openCount, row.highRiskCount, row.appealCount, row.decisionCount, row.publishedCount, row.appealSubmissionCount, row.appealDecisionCount, row.pendingQaCount, row.completedQaCount, row.upheldQaCount, row.coachingQaCount, row.escalatedQaCount, row.decisionQuality, row.reviewerCount]); }
  } else {
    const source = reportSource(context, window, query), cursor = source.Model.aggregate([...source.pipeline, { $sort: cursorSort() }]).cursor({ batchSize: 100 });
    try { await assertModerationReadAccess(request, context); await line(source.headers); for await (const record of cursor) { await assertModerationReadAccess(request, context); await line(source.csv(source.map(record))); } } finally { await cursor.close(); }
  }
  await assertModerationReadAccess(request, context); response.end();
}

import mongoose from 'mongoose';
import { z } from 'zod';
import { SellerVerification, Store, StoreMember, VerificationDocument, User, Notification, ModerationQaReview } from '../models/index.js';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { encryptSensitive, decryptSensitive } from '../core/sensitive.js';
import { hasPermission } from '../core/roles.js';
import { env } from '../config/env.js';
import { storeCapabilities } from './store.js';
import { assertOperationalCountry, operationalCountryScope } from './authorization.js';
import { writeAudit } from './audit.js';
import { addOutboxEvent } from './outbox.js';
import { prepareVerificationDocument } from './media.js';
import { deleteMediaObject } from './object-storage.js';
import { clearStorefrontCache } from './storefront.js';
import { verificationSchema, verificationAppealSchema, verificationDecisionSchema } from '../validation/catalogue.js';
import { cursorScope, pageResult } from './pagination.js';

const revision = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const documentType = z.enum(['identity', 'registration', 'tax', 'address']);
const editable = new Set(['draft', 'rejected']);
const reviewable = new Set(['submitted', 'appealed']);

async function sellerAccess(request, session = null) {
  const member = await StoreMember.findOne({ storeId: request.store._id, userId: request.user._id, status: 'active' }).session(session);
  const capabilities = storeCapabilities(member?.role);
  if (!capabilities.has('*') && !capabilities.has('staff')) throw new AppError('Your store role cannot manage verification.', 403, 'STORE_PERMISSION_DENIED');
  const store = await Store.findById(request.store._id).session(session);
  if (!store || !['pending_verification', 'verified'].includes(store.status)) throw new AppError('This store is locked.', 409, 'STORE_LOCKED');
  return store;
}

export async function sellerVerificationRecord(request) {
  const store = await sellerAccess(request);
  const existing = await SellerVerification.findOne({ storeId: store._id });
  if (existing) return existing;
  if (store.status !== 'pending_verification') throw new AppError('The verified store has no verification record. Contact support for a record review.', 409, 'VERIFICATION_RECORD_MISSING');
  try {
    return await SellerVerification.findOneAndUpdate({ storeId: store._id }, { $setOnInsert: {
      publicId: publicId('kyc'), userId: store.ownerUserId, sellerType: 'individual', legalName: store.name,
    } }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true });
  } catch (error) {
    if (error.code !== 11000) throw error;
    const winner = await SellerVerification.findOne({ storeId: store._id });
    if (!winner) throw error;
    return winner;
  }
}

function assertRevision(record, version) {
  if (record.__v !== version) throw new AppError('Verification changed. Reload the page before continuing.', 409, 'VERIFICATION_VERSION_CONFLICT');
}

async function transaction(work) {
  const session = await mongoose.startSession();
  let result;
  try { await session.withTransaction(async () => { result = await work(session); }); return result; }
  finally { await session.endSession(); }
}

async function sellerRecordInTransaction(request, version, states, session) {
  const store = await sellerAccess(request, session);
  if (store.status !== 'pending_verification') throw new AppError('This store is already verified.', 409, 'VERIFICATION_LOCKED');
  const record = await SellerVerification.findOne({ storeId: request.store._id }).session(session);
  if (!record || !states.has(record.status)) throw new AppError('Verification cannot be changed in its current state.', 409, 'VERIFICATION_LOCKED');
  assertRevision(record, version);
  return record;
}

export async function uploadSellerVerificationDocument(request) {
  const type = documentType.parse(request.body.documentType), version = revision.parse(request.body.version);
  const initial = await sellerVerificationRecord(request);
  assertRevision(initial, version);
  if (!editable.has(initial.status)) throw new AppError('Documents cannot be changed during review.', 409, 'VERIFICATION_LOCKED');
  const prepared = await prepareVerificationDocument(request.file, initial.publicId);
  const documentPublicId = publicId('doc');
  try {
    return await transaction(async session => {
      const record = await sellerRecordInTransaction(request, version, editable, session);
      const previous = record.documents.filter(row => row.type === type).map(row => row.mediaPublicId);
      await VerificationDocument.updateMany({ verificationId: record._id, publicId: { $in: previous } }, { $set: { status: 'superseded', supersededAt: new Date() } }, { session });
      const [document] = await VerificationDocument.create([{ publicId: documentPublicId, verificationId: record._id,
        storeId: request.store._id, userId: request.user._id, documentType: type, ...prepared }], { session });
      record.documents = [...record.documents.filter(row => row.type !== type), { type, mediaPublicId: document.publicId }];
      record.status = 'draft'; record.increment(); await record.save({ session });
      await writeAudit(request, 'seller.verification_document_uploaded', { session, targetType: 'seller_verification', targetPublicId: record.publicId, metadata: { documentType: type } });
      return document;
    });
  } catch (error) {
    // Do not delete evidence if an uncertain commit cannot be checked.
    const persisted = await VerificationDocument.exists({ publicId: documentPublicId }).catch(() => true);
    if (!persisted) await deleteMediaObject(prepared.storageKey).catch(() => {});
    throw error;
  }
}

async function notifyOwner(store, record, session) {
  const title = `Seller verification ${record.status}`;
  await Notification.create([{ publicId: publicId('ntf'), userId: store.ownerUserId, country: store.country,
    type: 'seller.verification', title, body: `Your verification for ${store.name} is ${record.status}. Open verification to see its status and next steps.`,
    href: '/seller/verification', importance: 'high' }], { session });
  const owner = await User.findById(store.ownerUserId).select('email emailVerifiedAt').session(session);
  if (owner?.emailVerifiedAt) await addOutboxEvent({ type: 'seller.verification_notification', aggregateType: 'seller_verification',
    aggregatePublicId: record.publicId, payload: { email: owner.email, subject: title, body: `Your seller verification is ${record.status}. Sign in to Classic Mart to view details. No documents or sensitive identifiers are included in this email.` } }, session);
}

export async function submitSellerVerification(request) {
  const input = verificationSchema.parse(request.body), version = revision.parse(request.body.version);
  return transaction(async session => {
    const record = await sellerRecordInTransaction(request, version, editable, session);
    const required = input.sellerType === 'business' ? ['identity', 'registration'] : ['identity'];
    const documents = await VerificationDocument.find({ verificationId: record._id, storeId: request.store._id,
      publicId: { $in: record.documents.map(row => row.mediaPublicId) }, status: 'ready' }).session(session).select('documentType').lean();
    const available = new Set(documents.map(row => row.documentType));
    const missing = required.filter(type => !available.has(type));
    if (missing.length) throw new AppError(`Upload a current ${missing.join(' and ')} document before submitting.`, 422, 'DOCUMENT_REQUIRED');
    record.sellerType = input.sellerType; record.legalName = input.legalName;
    record.registrationNumber = encryptSensitive(input.registrationNumber); record.taxNumber = encryptSensitive(input.taxNumber);
    record.status = 'submitted'; record.declarationAcceptedAt = new Date(); record.submittedAt = new Date();
    record.reviewReason = ''; record.assignedUserId = null; record.assignedAt = null; record.escalatedAt = null; record.escalationReason = ''; record.appeal = undefined;
    record.increment(); await record.save({ session });
    await writeAudit(request, 'seller.verification_submitted', { session, targetType: 'seller_verification', targetPublicId: record.publicId });
    await notifyOwner(request.store, record, session);
    return record;
  });
}

export async function appealSellerVerification(request) {
  const input = verificationAppealSchema.parse(request.body), version = revision.parse(request.body.version);
  return transaction(async session => {
    const record = await sellerRecordInTransaction(request, version, new Set(['rejected']), session);
    record.status = 'appealed'; record.appeal = { message: input.message, submittedAt: new Date() };
    record.assignedUserId = null; record.assignedAt = null; record.escalatedAt = null; record.escalationReason = '';
    record.increment(); await record.save({ session });
    await writeAudit(request, 'seller.verification_appealed', { session, targetType: 'seller_verification', targetPublicId: record.publicId });
    await notifyOwner(request.store, record, session);
    return record;
  });
}

export async function reviewerVerificationRecord(user, id, session = null) {
  if (!hasPermission(user, 'catalogue:moderate')) throw new AppError('Review permission is required.', 403, 'FORBIDDEN');
  const record = await SellerVerification.findOne({ publicId: id }).session(session);
  if (!record) throw new AppError('Verification not found.', 404, 'VERIFICATION_NOT_FOUND');
  const store = await Store.findById(record.storeId).session(session);
  if (!store) throw new AppError('Verification not found.', 404, 'VERIFICATION_NOT_FOUND');
  assertOperationalCountry(user, store.country, 'Verification is outside your assigned countries.');
  return { record, store };
}

async function assertIndependentReviewer(user, record, store, session) {
  if (String(store.ownerUserId) === String(user._id) || String(record.userId) === String(user._id) ||
    await StoreMember.exists({ storeId: store._id, userId: user._id, status: { $in: ['active', 'invited'] } }).session(session)) {
    throw new AppError('A reviewer who is independent of this store must handle verification.', 403, 'REVIEW_CONFLICT_OF_INTEREST');
  }
}

export async function reviewSellerVerification(request, action) {
  const version = revision.parse(request.body.version);
  const input = action === 'decision' ? verificationDecisionSchema.parse(request.body) : null;
  const reviewed = await transaction(async session => {
    const { record, store } = await reviewerVerificationRecord(request.user, request.params.publicId, session);
    assertRevision(record, version);
    if (!reviewable.has(record.status) || store.status !== 'pending_verification') throw new AppError('This verification is not reviewable.', 409, 'VERIFICATION_LOCKED');
    await assertIndependentReviewer(request.user, record, store, session);
    const assigned = record.assignedUserId && String(record.assignedUserId) === String(request.user._id);
    const now = new Date();
    if (action === 'claim') {
      if (record.assignedUserId && !assigned) throw new AppError('Another reviewer has claimed this verification.', 409, 'MODERATION_ALREADY_CLAIMED');
      record.assignedUserId = request.user._id; record.assignedAt = now;
    } else {
      if (!assigned) throw new AppError('Claim this verification before acting on it.', 409, 'MODERATION_CLAIM_REQUIRED');
      if (action === 'release') { record.assignedUserId = null; record.assignedAt = null; }
      else if (action === 'decision') {
        const currentIds = record.documents.map(row => row.mediaPublicId);
        const statuses = record.status === 'appealed' ? ['ready', 'rejected'] : ['ready'];
        const documents = await VerificationDocument.find({ verificationId: record._id, storeId: store._id, publicId: { $in: currentIds }, status: { $in: statuses } }).session(session).select('documentType').lean();
        const types = new Set(documents.map(row => row.documentType));
        if (input.decision === 'approve' && (!types.has('identity') || (record.sellerType === 'business' && !types.has('registration')))) throw new AppError('Current required documents are missing.', 409, 'DOCUMENT_REQUIRED');
        record.status = input.decision === 'approve' ? 'approved' : 'rejected'; record.reviewedAt = now;
        record.reviewedByUserId = request.user._id; record.reviewReason = input.reason; record.assignedUserId = null; record.assignedAt = null;
        store.status = input.decision === 'approve' ? 'verified' : 'pending_verification'; store.verifiedAt = input.decision === 'approve' ? now : undefined;
        await store.save({ session });
        await VerificationDocument.updateMany({ verificationId: record._id, publicId: { $in: currentIds }, status: { $in: statuses } }, { $set: { status: input.decision === 'approve' ? 'approved' : 'rejected', reviewedAt: now, reviewedByUserId: request.user._id } }, { session });
        await ModerationQaReview.create([{ publicId: publicId('mqa'), targetType: 'seller_verification', targetObjectId: record._id, targetPublicId: record.publicId, country: store.country,
          riskLevel: record.sellerType === 'business' ? 'high' : 'standard', decision: record.status, decisionReason: input.reason, originalReviewerUserId: request.user._id }], { session });
        await notifyOwner(store, record, session);
      } else throw new AppError('Review action is invalid.', 422, 'REVIEW_ACTION_INVALID');
    }
    record.reviewHistory.push({ action: action === 'decision' ? input.decision : action, actorUserId: request.user._id, reason: input?.reason || '', at: now });
    record.reviewHistory = record.reviewHistory.slice(-200);
    record.increment(); await record.save({ session });
    await writeAudit(request, `seller.verification_${action === 'decision' ? record.status : action}`, { session, targetType: 'seller_verification', targetPublicId: record.publicId, country: store.country });
    return record;
  });
  if (action === 'decision') clearStorefrontCache();
  return reviewed;
}

export async function sellerVerificationQueue(user, after = '') {
  if (!hasPermission(user, 'catalogue:moderate')) throw new AppError('Review permission is required.', 403, 'FORBIDDEN');
  const rows = await SellerVerification.aggregate([
    { $match: cursorScope({ status: { $in: ['submitted', 'appealed'] } }, after, { field: 'submittedAt', direction: 1 }) },
    { $sort: { submittedAt: 1, _id: 1 } },
    { $lookup: { from: Store.collection.name, localField: 'storeId', foreignField: '_id', as: 'store' } }, { $unwind: '$store' },
    { $match: { ...operationalCountryScope(user, 'store.country'), 'store.status': 'pending_verification' } }, { $limit: 51 },
    { $project: { publicId: 1, sellerType: 1, legalName: 1, status: 1, submittedAt: 1, assignedUserId: 1, __v: 1, 'store.name': 1, 'store.country': 1 } },
  ]);
  return pageResult(rows, { field: 'submittedAt', direction: 1, limit: 50 });
}

export async function readableVerificationDocument(user, id) {
  if (!user) throw new AppError('Authentication required.', 401, 'UNAUTHENTICATED');
  if (env.security.privilegedMfaRequired && !user.security?.mfaEnabled) throw new AppError('Authenticator enrollment is required to view verification documents.', 403, 'MFA_ENROLLMENT_REQUIRED');
  const document = await VerificationDocument.findOne({ publicId: id }).select('+storageKey');
  if (!document) throw new AppError('Document not found.', 404, 'DOCUMENT_NOT_FOUND');
  const store = await Store.findById(document.storeId).select('country status');
  if (!store) throw new AppError('Document not found.', 404, 'DOCUMENT_NOT_FOUND');
  if (hasPermission(user, 'catalogue:moderate')) assertOperationalCountry(user, store.country, 'Document not found.');
  else {
    const member = await StoreMember.findOne({ storeId: document.storeId, userId: user._id, status: 'active', role: { $in: ['owner', 'admin'] } });
    if (!member) throw new AppError('Document not found.', 404, 'DOCUMENT_NOT_FOUND');
  }
  return document;
}

export async function verificationDetail(record, { revealIdentifiers = false } = {}) {
  const documents = await VerificationDocument.find({ verificationId: record._id,
    publicId: { $in: record.documents.map(row => row.mediaPublicId) } }).select('publicId documentType status width height createdAt').lean();
  const data = record.toObject();
  if (revealIdentifiers) {
    const sensitive = await SellerVerification.findById(record._id).select('+registrationNumber +taxNumber').lean();
    data.registrationNumber = decryptSensitive(sensitive.registrationNumber); data.taxNumber = decryptSensitive(sensitive.taxNumber);
  }
  return { record: data, documents };
}

import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { PrivacyRequest, User } from '../models/index.js';

/** A restriction controls optional profiling and outreach. Transactional order,
 * security and legally required processing continues through its own authority. */
export async function optionalProcessingUser(userId, { session = null, marketing = false } = {}) {
  if (!userId || !mongoose.isValidObjectId(userId)) return null;
  const user = await User.findOne({ _id: userId, status: 'active', ...(marketing ? { 'consents.marketing': true } : {}) })
    .select('publicId email name country role consents preferences security.tokenVersion __v').session(session).lean();
  if (!user) return null;
  // Only an explicit reviewed release clears the restriction. Changing a queue
  // label (for example cancelling a blocked request) cannot restore processing.
  const restricted = await PrivacyRequest.exists({ userId: user._id, type: 'restriction', restrictionActive: true }).session(session);
  return restricted ? null : user;
}

export async function assertOptionalProcessing(userId, options) {
  const user = await optionalProcessingUser(userId, options);
  if (!user) throw new AppError('Optional processing is unavailable for this account. Review your privacy settings.', 403, 'PRIVACY_PROCESSING_RESTRICTED');
  return user;
}

/** Serialize newly persisted optional data with restriction and deletion. */
export async function fenceOptionalProcessing(userId, { session, marketing = false } = {}) {
  if (!session?.inTransaction()) throw new AppError('Optional processing changes require a transaction.', 500, 'PRIVACY_TRANSACTION_REQUIRED');
  const user = await assertOptionalProcessing(userId, { session, marketing });
  const updated = await User.updateOne({ _id: user._id, status: 'active', __v: user.__v || 0,
    'security.tokenVersion': user.security.tokenVersion }, { $inc: { __v: 1 } }, { session });
  if (updated.modifiedCount !== 1) throw new AppError('The account changed. Reload before continuing.', 409, 'ACCOUNT_ACCESS_CHANGED');
  user.__v = (user.__v || 0) + 1;
  return user;
}

/** Use in audience queries as well as dispatch; dispatch always rechecks. */
export async function restrictedOptionalUserIds({ session = null, country } = {}) {
  return PrivacyRequest.distinct('userId', { ...(country ? { country } : {}), type: 'restriction', restrictionActive: true }).session(session);
}

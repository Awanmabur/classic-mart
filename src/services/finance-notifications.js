import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { env } from '../config/env.js';
import { Notification, PlatformGrant, User } from '../models/index.js';

/** Ordinary Finance work alerts contain no beneficiary details or payment credentials. */
export async function queueFinanceAlert({ country, kind = 'priority', href }, session) {
  if (!session?.inTransaction()) throw new AppError('Finance alerts must accompany their recorded transition.', 500, 'FINANCE_TRANSACTION_REQUIRED');
  if (!/^[A-Z]{2}$/.test(country || '') || !['priority', 'escalation'].includes(kind) || !/^\/finance\/(?:payouts|refunds|reconciliation|disputes)(?:\?[A-Za-z0-9_=.%&-]*)?$/.test(href || '')) throw new AppError('Finance alert context is invalid.', 500, 'FINANCE_ALERT_INVALID');
  const now = new Date(), preference = kind === 'priority' ? 'preferences.financePriorityAlerts' : 'preferences.financeEscalationAlerts';
  const recipients = await User.aggregate([
    { $match: { status: 'active', emailVerifiedAt: { $type: 'date' }, onboardingCompletedAt: { $type: 'date' }, [preference]: { $ne: false },
      $or: [{ role: 'finance' }, { platformAccessManagedAt: { $type: 'date' } }],
      ...(env.security.privilegedMfaRequired ? { 'security.mfaEnabled': true } : {}) } },
    { $lookup: { from: PlatformGrant.collection.name, localField: '_id', foreignField: 'userId', as: 'grant', pipeline: [
      { $match: { status: 'active', startsAt: { $lte: now }, expiresAt: { $gt: now } } }, { $project: { role: 1, operationalCountries: 1 } },
    ] } },
    { $match: { $expr: { $cond: [{ $ne: [{ $ifNull: ['$platformAccessManagedAt', null] }, null] },
      { $and: [{ $eq: [{ $size: '$grant' }, 1] }, { $eq: [{ $first: '$grant.role' }, 'finance'] }, { $in: [country, { $ifNull: [{ $first: '$grant.operationalCountries' }, []] }] }] },
      { $and: [{ $eq: ['$role', 'finance'] }, { $in: [country, { $cond: [{ $gt: [{ $size: { $ifNull: ['$operationalCountries', []] } }, 0] }, '$operationalCountries', ['$country']] }] }] },
    ] } } },
    { $project: { _id: 1 } },
  ]).session(session);
  if (!recipients.length) return 0;
  await Notification.create(recipients.map(actor => ({ publicId: publicId('ntf'), userId: actor._id, country,
    type: 'finance_work', title: kind === 'priority' ? 'Finance work awaiting review' : 'Finance exception awaiting review',
    body: kind === 'priority' ? 'Recorded Finance work is ready for independent review.' : 'A recorded Finance exception needs review and supporting evidence.', href })), { session, ordered: true });
  return recipients.length;
}

import { strongMfaFence } from './mfa-policy.js';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { env } from '../config/env.js';
import { Notification, PlatformGrant, User } from '../models/index.js';

/** Ordinary Support work alerts contain no beneficiary details or payment credentials. */
export async function queueSupportAlert({ country, kind = 'priority', href }, session) {
  if (!session?.inTransaction()) throw new AppError('Support alerts must accompany their recorded transition.', 500, 'SUPPORT_TRANSACTION_REQUIRED');
  if (!/^[A-Z]{2}$/.test(country || '') || !['priority', 'escalation'].includes(kind) || !/^\/support\/(?:overview|queue|customers|orders|returns|escalations|reviews|reports|settings)(?:\?[A-Za-z0-9_=.%&-]*)?$/.test(href || '')) throw new AppError('Support alert context is invalid.', 500, 'SUPPORT_ALERT_INVALID');
  const now = new Date(), preference = kind === 'priority' ? 'preferences.supportPriorityAlerts' : 'preferences.supportEscalationAlerts';
  const recipients = await User.aggregate([
    { $match: { status: 'active', emailVerifiedAt: { $type: 'date' }, onboardingCompletedAt: { $type: 'date' }, [preference]: { $ne: false },
      $or: [{ role: 'support' }, { platformAccessManagedAt: { $type: 'date' } }],
      ...(env.security.privilegedMfaRequired ? { $and: [strongMfaFence()] } : {}) } },
    { $lookup: { from: PlatformGrant.collection.name, localField: '_id', foreignField: 'userId', as: 'grant', pipeline: [
      { $match: { status: 'active', startsAt: { $lte: now }, expiresAt: { $gt: now } } }, { $project: { role: 1, operationalCountries: 1 } },
    ] } },
    { $match: { $expr: { $cond: [{ $ne: [{ $ifNull: ['$platformAccessManagedAt', null] }, null] },
      { $and: [{ $eq: [{ $size: '$grant' }, 1] }, { $eq: [{ $first: '$grant.role' }, 'support'] }, { $in: [country, { $ifNull: [{ $first: '$grant.operationalCountries' }, []] }] }] },
      { $and: [{ $eq: ['$role', 'support'] }, { $in: [country, { $cond: [{ $gt: [{ $size: { $ifNull: ['$operationalCountries', []] } }, 0] }, '$operationalCountries', ['$country']] }] }] },
    ] } } },
    { $project: { _id: 1 } },
  ]).session(session);
  if (!recipients.length) return 0;
  await Notification.create(recipients.map(actor => ({ publicId: publicId('ntf'), userId: actor._id, country,
    type: 'support_work', title: kind === 'priority' ? 'Support work awaiting review' : 'Support exception awaiting review',
    body: kind === 'priority' ? 'Recorded Support work is ready for independent review.' : 'A recorded Support exception needs review and supporting evidence.', href })), { session, ordered: true });
  return recipients.length;
}

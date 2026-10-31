import { strongMfaFence } from './mfa-policy.js';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { env } from '../config/env.js';
import { CountrySetting, Notification, PlatformGrant, User } from '../models/index.js';
import { MODERATION_LIVE_ROUTES } from '../dashboard/moderation-routes.js';

function validDestination(href, country) {
  if (typeof href !== 'string' || href.length > 500 || !href.startsWith('/moderation/') || /[\\\u0000-\u001f\u007f]/.test(href)) return false;
  const destination = new URL(href, 'https://classicmart.invalid');
  if (destination.origin !== 'https://classicmart.invalid' || destination.hash || !Object.values(MODERATION_LIVE_ROUTES).includes(destination.pathname)) return false;
  for (const [key, value] of destination.searchParams) {
    if (destination.searchParams.getAll(key).length !== 1 || !/^(?:country|search|record|view|status|priority|after|period|report|section|queue)$/.test(key)
      || value.length > 160 || !/^[A-Za-z0-9_.:-]*$/.test(value) || (key === 'country' && value !== country)) return false;
  }
  return true;
}

/** In-app work alerts contain public record references, never customer contact details or private evidence. */
export async function queueModerationAlert({ country, kind = 'priority', href }, session) {
  if (!session?.inTransaction()) throw new AppError('Moderation alerts must accompany their recorded transition.', 500, 'MODERATION_TRANSACTION_REQUIRED');
  if (!/^[A-Z]{2}$/.test(country || '') || !['priority', 'escalation'].includes(kind) || !validDestination(href, country)) {
    throw new AppError('Moderation alert context is invalid.', 500, 'MODERATION_ALERT_INVALID');
  }
  const market = await CountrySetting.findOne({ code: country, active: true }).select('_id').session(session).lean();
  if (!market) throw new AppError('This Moderation country is unavailable.', 409, 'MODERATION_MARKET_UNAVAILABLE');
  const now = new Date(), preference = kind === 'priority' ? 'preferences.moderationHighRiskAlerts' : 'preferences.moderationEscalationAlerts';
  const recipients = await User.aggregate([
    { $match: { status: 'active', emailVerifiedAt: { $type: 'date' }, onboardingCompletedAt: { $type: 'date' }, [preference]: { $ne: false },
      $or: [{ role: 'moderator' }, { platformAccessManagedAt: { $type: 'date' } }],
      ...(env.security.privilegedMfaRequired ? { $and: [strongMfaFence()] } : {}) } },
    { $lookup: { from: PlatformGrant.collection.name, localField: '_id', foreignField: 'userId', as: 'grant', pipeline: [
      { $match: { status: 'active', startsAt: { $lte: now }, expiresAt: { $gt: now } } }, { $project: { role: 1, operationalCountries: 1 } },
    ] } },
    { $match: { $expr: { $cond: [{ $ne: [{ $ifNull: ['$platformAccessManagedAt', null] }, null] },
      { $and: [{ $eq: [{ $size: '$grant' }, 1] }, { $eq: [{ $first: '$grant.role' }, 'moderator'] }, { $in: [country, { $ifNull: [{ $first: '$grant.operationalCountries' }, []] }] }] },
      { $and: [{ $eq: ['$role', 'moderator'] }, { $in: [country, { $cond: [{ $gt: [{ $size: { $ifNull: ['$operationalCountries', []] } }, 0] }, '$operationalCountries', ['$country']] }] }] },
    ] } } },
    { $project: { _id: 1 } },
  ]).session(session);
  if (!recipients.length) return 0;
  await Notification.create(recipients.map(actor => ({ publicId: publicId('ntf'), userId: actor._id, country,
    type: 'moderation_work', title: kind === 'priority' ? 'High risk work awaiting review' : 'Moderation escalation awaiting review',
    body: kind === 'priority' ? 'Recorded Moderation work is ready for independent review.' : 'A recorded Moderation escalation needs review and supporting evidence.',
    importance: kind === 'priority' ? 'high' : 'normal', href })), { session, ordered: true });
  return recipients.length;
}

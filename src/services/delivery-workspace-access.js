import { AppError } from '../core/errors.js';
import { env } from '../config/env.js';
import { CountrySetting, DeliveryProfile, Device, User } from '../models/index.js';
import { currentRequestDevice } from './country-admin-workspace-access.js';
import { strongMfaFence } from './mfa-policy.js';
import { hasCurrentStrongSessionMfa } from './mfa-assurance.js';

const unavailable = () => new AppError('Your delivery account or session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');

/** Read identity, device and market in the same snapshot as every custody write. */
export async function deliveryAccess(request, { session = null, write = false, approved = false, available = false } = {}) {
  if (!request.user?._id) throw new AppError('Sign in to your delivery account.', 401, 'UNAUTHENTICATED');
  const actor = await User.findById(request.user._id).session(session);
  if (!actor || actor.status !== 'active' || actor.role !== 'delivery' || actor.platformAccessManagedAt ||
    actor.security.tokenVersion !== request.user.security?.tokenVersion ||
    (request.session?.tokenVersion !== undefined && actor.security.tokenVersion !== request.session.tokenVersion)) throw unavailable();
  const device = await currentRequestDevice(request, { userId: actor._id, session });
  if (!env.auth.simpleLogin && (!actor.emailVerifiedAt || !actor.onboardingCompletedAt)) throw unavailable();
  if (!env.auth.simpleLogin && env.security.privilegedMfaRequired && !await hasCurrentStrongSessionMfa(request, actor, { session })) {
    throw new AppError('Enable a passkey or authenticator before managing delivery custody or earnings.', 403, 'MFA_ENROLLMENT_REQUIRED');
  }
  const market = await CountrySetting.findOne({ code: actor.country, active: true, currency: actor.currency }).session(session).lean();
  if (!market?.timeZone || !market?.currency) throw new AppError('Your delivery market is unavailable.', 409, 'DELIVERY_MARKET_UNAVAILABLE');
  const profile = await DeliveryProfile.findOne({ userId: actor._id, country: market.code }).session(session);
  if (approved && profile?.verificationStatus !== 'approved') throw new AppError('Independent delivery verification is required.', 403, 'DELIVERY_NOT_APPROVED');
  if (available && !profile?.available) throw new AppError('Set your approved delivery profile to available before accepting offers.', 409, 'DELIVERY_NOT_AVAILABLE');
  const access = { actor, device, market, profile };
  if (write) await fenceDeliveryAccess(access, session);
  return access;
}

export async function fenceDeliveryAccess({ actor, device, market, profile }, session) {
  if (!session?.inTransaction()) throw new AppError('Delivery changes require a transaction.', 500, 'DELIVERY_TRANSACTION_REQUIRED');
  const result = await User.updateOne({ _id: actor._id, __v: actor.__v || 0, status: 'active', role: 'delivery',
    country: market.code, currency: market.currency, 'security.tokenVersion': actor.security.tokenVersion,
    ...(!env.auth.simpleLogin && env.security.privilegedMfaRequired ? { $and: [strongMfaFence()] } : {}) }, { $inc: { __v: 1 } }, { session });
  if (result.modifiedCount !== 1) throw unavailable();
  if (device) {
    const fenced = await Device.updateOne({ _id: device._id, userId: actor._id, revokedAt: null, sessionHash: device.sessionHash,
      __v: device.__v || 0 }, { $inc: { __v: 1 } }, { session });
    if (fenced.modifiedCount !== 1) throw unavailable();
  }
  const country = await CountrySetting.updateOne({ _id: market._id, __v: market.__v || 0, active: true,
    code: market.code, currency: market.currency, timeZone: market.timeZone }, { $inc: { __v: 1 } }, { session });
  if (country.modifiedCount !== 1) throw new AppError('The delivery market changed. Reload and retry.', 409, 'DELIVERY_MARKET_CHANGED');
  if (profile) {
    const fenced = await DeliveryProfile.updateOne({ _id: profile._id, __v: profile.__v || 0, country: market.code,
      userId: actor._id, verificationStatus: profile.verificationStatus, available: profile.available }, { $inc: { __v: 1 } }, { session });
    if (fenced.modifiedCount !== 1) throw new AppError('Your delivery verification changed. Reload and retry.', 409, 'DELIVERY_PROFILE_CHANGED');
    profile.__v = Number(profile.__v || 0) + 1;
  }
}

export function deliveryVersion(value, record) {
  if (value === undefined || value === null || value === '') throw new AppError('Reload the delivery form before continuing.', 428, 'DELIVERY_VERSION_REQUIRED');
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new AppError('Invalid delivery record version.', 422, 'DELIVERY_VERSION_INVALID');
  if (Number(value) !== Number(record?.__v || 0)) throw new AppError('This delivery record changed. Reload and retry.', 409, 'DELIVERY_VERSION_CONFLICT');
}

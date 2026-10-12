import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { hasPermission } from '../core/roles.js';
import { env } from '../config/env.js';
import { CountrySetting, PlatformGrant, User } from '../models/index.js';

/** Core moderation decisions must authorize the actor in the transaction that saves the outcome. */
export async function moderationReviewAccess(request, session, country) {
  if (!session?.inTransaction()) throw new AppError('Moderation changes require a transaction.', 500, 'MODERATION_TRANSACTION_REQUIRED');
  if (!request.user?._id) throw new AppError('Moderation authentication is required.', 401, 'UNAUTHENTICATED');
  const actor = await User.findById(request.user._id).select('+operationalCountries').session(session);
  if (!actor || actor.status !== 'active' || actor.security.tokenVersion !== request.user.security?.tokenVersion
    || (request.session?.tokenVersion !== undefined && actor.security.tokenVersion !== request.session.tokenVersion)) {
    throw new AppError('Your moderation account or session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
  }
  const storedRole = actor.role, now = new Date();
  let grant = null;
  if (actor.platformAccessManagedAt) {
    const grants = await PlatformGrant.find({ userId: actor._id, status: 'active', startsAt: mongoose.trusted({ $lte: now }), expiresAt: mongoose.trusted({ $gt: now }) }).limit(2).session(session).lean();
    if (grants.length !== 1) throw new AppError('Current moderation authorization is unavailable.', 403, 'MODERATION_GRANT_UNAVAILABLE');
    grant = grants[0];
    Object.defineProperty(actor, 'authorizationContext', { value: { platformManaged: true, activePlatformGrants: [grant] }, configurable: true });
    actor.role = grant.role; actor.operationalCountries = [...grant.operationalCountries];
  }
  if (!hasPermission(actor, 'catalogue:moderate') && !hasPermission(actor, 'trust:manage')) throw new AppError('Moderation permission is required.', 403, 'MODERATION_FORBIDDEN');
  if (!env.auth.simpleLogin && (!actor.emailVerifiedAt || !actor.onboardingCompletedAt)) throw new AppError('Complete identity verification and onboarding first.', 403, 'ACCOUNT_UNAVAILABLE');
  if (!env.auth.simpleLogin && env.security.privilegedMfaRequired && !actor.security.mfaEnabled) throw new AppError('Authenticator enrollment is required for moderation.', 403, 'MFA_ENROLLMENT_REQUIRED');
  const scopes = grant ? [...grant.operationalCountries] : actor.role === 'super_admin' ? ['*'] : [...new Set(actor.operationalCountries?.length ? actor.operationalCountries : [actor.country])];
  if (!/^[A-Z]{2}$/.test(country || '') || (!scopes.includes('*') && !scopes.includes(country))
    || (scopes.includes('*') && actor.role !== 'super_admin')) throw new AppError('This country is outside your current moderation scope.', 403, 'MODERATION_COUNTRY_FORBIDDEN');
  const market = await CountrySetting.findOne({ code: country, active: true }).select('code active __v').session(session).lean();
  if (!market) throw new AppError('This moderation country is unavailable.', 409, 'MODERATION_MARKET_UNAVAILABLE');
  return { actor, storedRole, grant, scopes, market, actorVersion: actor.__v || 0 };
}

export async function fenceModerationReviewAccess(context, session) {
  const { actor, storedRole, grant, market } = context;
  const changed = () => new AppError('Moderation access changed. Reload before continuing.', 409, 'MODERATION_ACCESS_CHANGED');
  const fenced = await User.updateOne({ _id: actor._id, role: storedRole, status: 'active', __v: context.actorVersion, 'security.tokenVersion': actor.security.tokenVersion }, { $inc: { __v: 1 } }, { session });
  if (fenced.modifiedCount !== 1) throw changed();
  if (grant) {
    const now = new Date();
    const claimed = await PlatformGrant.updateOne({ _id: grant._id, role: grant.role, status: 'active', startsAt: mongoose.trusted({ $lte: now }), expiresAt: mongoose.trusted({ $gt: now }), __v: grant.__v || 0 }, { $inc: { __v: 1 } }, { session });
    if (claimed.modifiedCount !== 1) throw changed();
  }
  const claimed = await CountrySetting.updateOne({ _id: market._id, code: market.code, active: true, __v: market.__v || 0 }, { $inc: { __v: 1 } }, { session });
  if (claimed.modifiedCount !== 1) throw changed();
}

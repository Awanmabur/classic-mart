import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { hasPermission } from '../core/roles.js';
import { env } from '../config/env.js';
import { hashToken } from '../core/crypto.js';
import { CountrySetting, Device, PlatformGrant, User } from '../models/index.js';
import { primaryWorkspaceFor } from '../dashboard/access.js';
import { countryAdminAccess } from './country-admin-workspace-access.js';

const scopeError = () => new AppError('This country is outside your current Moderation scope.', 403, 'MODERATION_COUNTRY_FORBIDDEN');
const changed = () => new AppError('Moderation access changed. Reload before continuing.', 409, 'MODERATION_ACCESS_CHANGED');

/** Real web sessions retain their current Device boundary through asynchronous work. */
export async function currentRequestDevice(request, { userId = request.user?._id, session = null } = {}) {
  if (request.sessionID === undefined && !request.device?._id) return null;
  if (!userId || typeof request.sessionID !== 'string' || !request.sessionID
    || (request.session?.userId !== undefined && String(request.session.userId) !== String(userId))) {
    throw new AppError('Your Moderation account or session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
  }
  const device = await Device.findOne({ userId, sessionHash: hashToken(request.sessionID), revokedAt: null,
    ...(request.device?._id ? { _id: request.device._id } : {}) }).select('+sessionHash').session(session).lean();
  if (!device) throw new AppError('Your Moderation account or session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
  return device;
}

/** Transaction-aware authorization reads the authoritative grants in the same snapshot. */
export async function moderationAccess(request, { session = null, write = false, workspace = true, country } = {}) {
  if (request.requiredOperationalWorkspace === 'admin') return countryAdminAccess(request, { session, write, country });
  if (!request.user?._id) throw new AppError('Moderation authentication is required.', 401, 'UNAUTHENTICATED');
  const actor = await User.findById(request.user._id).select('+operationalCountries').session(session);
  if (!actor || actor.status !== 'active' || actor.security.tokenVersion !== request.user.security?.tokenVersion
    || (request.session?.tokenVersion !== undefined && actor.security.tokenVersion !== request.session.tokenVersion)) {
    throw new AppError('Your Moderation account or session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
  }
  const device = await currentRequestDevice(request, { userId: actor._id, session });
  const storedRole = actor.role, now = new Date();
  let grant = null;
  if (actor.platformAccessManagedAt) {
    const grants = await PlatformGrant.find({ userId: actor._id, status: 'active', startsAt: mongoose.trusted({ $lte: now }), expiresAt: mongoose.trusted({ $gt: now }) })
      .sort({ createdAt: -1 }).limit(2).session(session).lean();
    if (grants.length !== 1) throw new AppError('Current Moderation authorization is unavailable.', 403, 'MODERATION_GRANT_UNAVAILABLE');
    grant = grants[0];
    Object.defineProperty(actor, 'authorizationContext', { value: { platformManaged: true, activePlatformGrants: [grant] }, configurable: true });
    actor.role = grant.role; actor.operationalCountries = [...grant.operationalCountries];
  }
  if (!hasPermission(actor, 'catalogue:moderate') && !hasPermission(actor, 'trust:manage')) throw new AppError('Moderation permission is required.', 403, 'MODERATION_FORBIDDEN');
  if (request.requiredOperationalWorkspace && primaryWorkspaceFor(actor) !== request.requiredOperationalWorkspace) throw new AppError('Your operational workspace changed. Reload before continuing.', 403, 'OPERATIONAL_WORKSPACE_CHANGED');
  if (workspace && primaryWorkspaceFor(actor) !== 'moderator') throw new AppError('A Moderation account is required for this workspace.', 403, 'MODERATION_WORKSPACE_FORBIDDEN');
  if (!env.auth.simpleLogin) {
    if (!actor.emailVerifiedAt || !actor.onboardingCompletedAt) throw new AppError('Complete identity verification and onboarding first.', 403, 'ACCOUNT_UNAVAILABLE');
    if (env.security.privilegedMfaRequired && !actor.security.mfaEnabled) throw new AppError('Authenticator enrollment is required for Moderation operations.', 403, 'MFA_ENROLLMENT_REQUIRED');
  }
  const scopes = grant ? [...grant.operationalCountries] : actor.role === 'super_admin' ? ['*']
    : [...new Set((actor.operationalCountries?.length ? actor.operationalCountries : [actor.country]).map(value => String(value).toUpperCase()))];
  if (!scopes.length || scopes.some(value => value !== '*' && !/^[A-Z]{2}$/.test(value))) throw scopeError();
  if (scopes.includes('*') && actor.role !== 'super_admin') throw scopeError();
  const countries = await CountrySetting.find({ active: true, ...(scopes.includes('*') ? {} : { code: mongoose.trusted({ $in: scopes }) }) })
    .select('code name currency timeZone locale active __v').sort({ name: 1, code: 1 }).session(session).lean();
  if (!countries.length || countries.some(row => !row.currency || !row.timeZone)) throw new AppError('The Moderation market configuration is unavailable.', 409, 'MODERATION_MARKET_UNAVAILABLE');
  let requested = country !== undefined ? country : request.query?.country;
  if (requested !== undefined && (typeof requested !== 'string' || (requested !== '' && !/^[A-Z]{2}$/.test(requested)))) throw new AppError('Select one valid Moderation country.', 422, 'MODERATION_COUNTRY_INVALID');
  if (requested === undefined) {
    const preferred = actor.preferences?.moderationDefaultCountry;
    requested = countries.some(row => row.code === preferred) ? preferred : countries.length === 1 ? countries[0].code : '';
  }
  const market = requested ? countries.find(row => row.code === requested) : null;
  if (requested && !market) throw scopeError();
  const codes = market ? [market.code] : countries.map(row => row.code);
  const context = { actor, storedRole, grant, device, scopes, countries, country: requested,
    countryScope: codes.length === 1 ? { country: codes[0] } : { country: mongoose.trusted({ $in: codes }) },
    market, currency: market?.currency || null, timeZone: market?.timeZone || 'UTC', actorVersion: actor.__v || 0 };
  if (write) await fenceModerationAccess(context, session);
  return context;
}

export async function fenceModerationAccess(context, session, { allMarkets = false } = {}) {
  if (!session?.inTransaction()) throw new AppError('Moderation changes require a transaction.', 500, 'MODERATION_TRANSACTION_REQUIRED');
  const { actor, storedRole, grant, device, countries, country } = context;
  const result = await User.updateOne({ _id: actor._id, role: storedRole, status: 'active', __v: context.actorVersion,
    'security.tokenVersion': actor.security.tokenVersion }, { $inc: { __v: 1 } }, { session });
  if (result.modifiedCount !== 1) throw changed();
  context.actorVersion += 1; actor.__v = context.actorVersion;
  if (device) {
    const claimed = await Device.updateOne({ _id: device._id, userId: actor._id, sessionHash: device.sessionHash,
      revokedAt: null, __v: device.__v || 0 }, { $inc: { __v: 1 } }, { session });
    if (claimed.modifiedCount !== 1) throw changed();
    device.__v = (device.__v || 0) + 1;
  }
  if (grant) {
    const now = new Date();
    const claimed = await PlatformGrant.updateOne({ _id: grant._id, status: 'active', role: grant.role,
      startsAt: mongoose.trusted({ $lte: now }), expiresAt: mongoose.trusted({ $gt: now }), __v: grant.__v || 0 }, { $inc: { __v: 1 } }, { session });
    if (claimed.modifiedCount !== 1) throw changed();
    grant.__v = (grant.__v || 0) + 1;
  }
  for (const row of countries.filter(row => allMarkets || !country || row.code === country)) {
    const claimed = await CountrySetting.updateOne({ _id: row._id, active: true, currency: row.currency, timeZone: row.timeZone, __v: row.__v || 0 }, { $inc: { __v: 1 } }, { session });
    if (claimed.modifiedCount !== 1) throw changed();
    row.__v = (row.__v || 0) + 1;
  }
}

export function moderationPublicContext(context) {
  return { country: context.country, currency: context.currency, timeZone: context.timeZone,
    countries: context.countries.map(({ code, name, currency, timeZone, locale }) => ({ code, name, currency, timeZone, locale })) };
}

/** Reads and long exports must stop when their original authorization or market changes. */
export async function assertModerationReadAccess(request, original, { workspace = true } = {}) {
  const current = await moderationAccess(request, { workspace });
  const marketKeys = context => (context.country ? context.countries.filter(row => row.code === context.country) : context.countries)
    .map(row => row.code + ':' + row.currency + ':' + row.timeZone).sort();
  if (current.country !== original.country || current.actor.security.tokenVersion !== original.actor.security.tokenVersion
    || String(current.grant?._id || '') !== String(original.grant?._id || '')
    || JSON.stringify(marketKeys(current)) !== JSON.stringify(marketKeys(original))) {
    throw new AppError('Your Moderation authorization changed during export.', 403, 'MODERATION_SCOPE_CHANGED');
  }
  return current;
}

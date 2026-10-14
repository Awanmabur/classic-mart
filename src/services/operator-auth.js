/** CLI-only step-up authentication. No sessions/routes, password resets, or privilege provisioning. */
import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { hashToken, safeEqual, verifyPassword } from '../core/crypto.js';
import { decryptSensitive } from '../core/sensitive.js';
import { PlatformGrant, User } from '../models/index.js';
import { totpCode } from './mfa.js';

const authSchema = z.object({
  actorPublicId: z.string().regex(/^usr_[A-Za-z0-9_-]{1,140}$/),
  password: z.string().min(1).max(1024),
  code: z.string().trim().min(6).max(32),
}).strict();
const denied = () => new AppError('Current operator credentials, active authority and MFA are required.', 403, 'OPERATOR_AUTH_FAILED');

async function currentOperator(publicId, roles, session = null) {
  const actor = await User.findOne({ publicId }).select('+passwordHash +operationalCountries +security.mfaSecretEncrypted +security.mfaRecoveryCodeHashes +security.mfaLastCounter').session(session);
  const now = new Date();
  if (!actor || actor.status !== 'active' || !actor.emailVerifiedAt || !actor.phoneVerifiedAt || !actor.onboardingCompletedAt || !actor.platformAccessManagedAt || !actor.security?.mfaEnabled || !actor.security.mfaSecretEncrypted
    || (actor.security.lockedUntil && actor.security.lockedUntil > now)) throw denied();
  const grants = await PlatformGrant.find({ userId: actor._id, status: 'active', startsAt: mongoose.trusted({ $lte: now }), expiresAt: mongoose.trusted({ $gt: now }) }).limit(2).session(session).lean();
  if (grants.length !== 1) throw denied();
  const grant = grants[0];
  const role = grant.role;
  if (!roles.includes(role)) throw denied();
  const scopes = [...grant.operationalCountries];
  if (!scopes.length || scopes.some((scope) => scope !== '*' && !/^[A-Z]{2}$/.test(scope)) || (role === 'super_admin' && !scopes.includes('*')) || (role !== 'super_admin' && scopes.includes('*'))) throw denied();
  return { actor, grant, role, scopes, roles: [...roles], actorVersion: actor.__v || 0 };
}

function mfaMutation(actor, supplied, now) {
  const clean = String(supplied).replace(/\s+/g, '').trim();
  if (/^\d{6}$/.test(clean)) {
    const secret = decryptSensitive(actor.security.mfaSecretEncrypted);
    for (const offset of [-1, 0, 1]) {
      const time = now.getTime() + offset * 30_000;
      const counter = Math.floor(time / 30_000);
      if (counter >= 0 && safeEqual(totpCode(secret, { time }), clean)) {
        if (counter <= (actor.security.mfaLastCounter ?? -1)) throw new AppError('This authenticator code has already been used.', 422, 'MFA_REPLAY');
        return { method: 'totp', filter: { 'security.mfaLastCounter': actor.security.mfaLastCounter ?? mongoose.trusted({ $exists: false }) }, update: { $set: { 'security.mfaLastCounter': counter } } };
      }
    }
  }
  const hashed = hashToken(`mfa-recovery:${clean.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`);
  if (!actor.security.mfaRecoveryCodeHashes?.includes(hashed)) throw denied();
  return { method: 'recovery', filter: { 'security.mfaRecoveryCodeHashes': hashed }, update: { $pull: { 'security.mfaRecoveryCodeHashes': hashed } } };
}

/** Reads only. Checks the supplied current password and unused current MFA proof without consuming it. */
export async function authenticateOperator(credentials, { roles = ['super_admin'] } = {}) {
  const parsed = authSchema.safeParse(credentials);
  if (!parsed.success || !Array.isArray(roles) || !roles.length) throw denied();
  const context = await currentOperator(parsed.data.actorPublicId, roles);
  if (!(await verifyPassword(context.actor.passwordHash, parsed.data.password))) throw denied();
  const proof = mfaMutation(context.actor, parsed.data.code, new Date());
  return { ...context, authenticationMethod: proof.method };
}

/** Reloads current authority in the caller's transaction. Do not use baseline role mirrors for authorization. */
export async function authorizeOperator(baseline, { session } = {}) {
  if (!session?.inTransaction()) throw new AppError('Operator changes require a transaction.', 500, 'OPERATOR_TRANSACTION_REQUIRED');
  const current = await currentOperator(baseline.actor.publicId, baseline.roles, session);
  if (String(current.actor._id) !== String(baseline.actor._id) || current.actor.security.tokenVersion !== baseline.actor.security.tokenVersion
    || current.actor.passwordHash !== baseline.actor.passwordHash || current.actor.security.mfaSecretEncrypted !== baseline.actor.security.mfaSecretEncrypted
    || String(current.grant?._id || '') !== String(baseline.grant?._id || '') || current.role !== baseline.role
    || JSON.stringify([...current.scopes].sort()) !== JSON.stringify([...baseline.scopes].sort())) throw denied();
  return current;
}

/** Transactional single-use MFA plus current actor/grant fences; caller must audit and commit its own operation. */
export async function fenceOperatorAuthentication(context, { session, code } = {}) {
  if (!session?.inTransaction()) throw new AppError('Operator changes require a transaction.', 500, 'OPERATOR_TRANSACTION_REQUIRED');
  const { actor, grant } = context;
  const now = new Date();
  const proof = mfaMutation(actor, code, now);
  const fence = await User.updateOne({ _id: actor._id, role: actor.role, status: 'active', __v: context.actorVersion,
    platformAccessManagedAt: actor.platformAccessManagedAt || null,
    passwordHash: actor.passwordHash, 'security.tokenVersion': actor.security.tokenVersion,
    'security.mfaEnabled': true, 'security.mfaSecretEncrypted': actor.security.mfaSecretEncrypted, ...proof.filter },
  { ...proof.update, $inc: { __v: 1 } }, { session });
  if (fence.modifiedCount !== 1) throw denied();
  context.actorVersion += 1;
  actor.__v = context.actorVersion;
  if (grant) {
    const fencedGrant = await PlatformGrant.updateOne({ _id: grant._id, userId: actor._id, role: context.role, status: 'active',
      operationalCountries: grant.operationalCountries, startsAt: mongoose.trusted({ $lte: now }), expiresAt: mongoose.trusted({ $gt: now }), __v: grant.__v || 0 }, { $inc: { __v: 1 } }, { session });
    if (fencedGrant.modifiedCount !== 1) throw denied();
    grant.__v = (grant.__v || 0) + 1;
  }
  return { method: proof.method };
}

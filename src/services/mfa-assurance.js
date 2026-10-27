import { PasskeyCredential, User } from '../models/index.js';
import { strongMfaFence } from './mfa-policy.js';

// A request-local, bounded authorization read cache never stores credentials or
// survives another HTTP request. Mutations independently fence current factors
// inside their own transaction, even after a cached read.
const requestProofs = new WeakMap();
const STRONG_SESSION_METHODS = new Set(['totp', 'passkey', 'recovery']);

export function strongSessionMethod(request) {
  const method = request?.session?.mfaVerifiedMethod;
  if (request?.session?.mfaVerifiedStrong === false) return false;
  // Previously published sessions had no method marker and could only have
  // completed the authenticator/recovery flow. New recovery proofs carry their
  // enrollment assurance explicitly: SMS-issued backups are never staff proof.
  if (method === 'recovery') return request.session.mfaVerifiedStrong === true;
  return method === undefined || STRONG_SESSION_METHODS.has(method);
}

export async function hasCurrentStrongMfa(actor, { session = null, request = null, fresh = false } = {}) {
  if (!actor?._id || actor.status !== 'active' || !actor.security?.mfaEnabled
    || !Number.isSafeInteger(actor.security.tokenVersion) || actor.security.tokenVersion < 0) return false;
  const read = async () => {
    // Project only factor presence inside MongoDB: no encrypted TOTP secret or
    // credential bytes leave this authorization query. An orphaned passkey
    // count alone must not turn an account into a staff-capable identity.
    const methods = { $cond: [{ $isArray: '$security.mfaMethods' }, '$security.mfaMethods', []] };
    const rows = await User.aggregate([
      { $match: { _id: actor._id, status: 'active', 'security.tokenVersion': actor.security.tokenVersion,
        $and: [strongMfaFence()] } },
      { $project: { _id: 1, totp: { $and: [
        { $eq: [{ $type: '$security.mfaSecretEncrypted' }, 'string'] },
        { $ne: ['$security.mfaSecretEncrypted', ''] },
        { $or: [{ $eq: [{ $type: '$security.mfaMethods' }, 'missing'] }, { $in: ['totp', methods] }] },
      ] } } },
      { $lookup: { from: PasskeyCredential.collection.name, let: { owner: '$_id', needsPasskey: { $not: ['$totp'] } },
        pipeline: [
          { $match: { revokedAt: null, credentialId: { $type: 'string', $ne: '' }, publicKey: { $type: 'binData' },
            $expr: { $and: ['$$needsPasskey', { $eq: ['$userId', '$$owner'] }] } } },
          { $limit: 1 }, { $project: { _id: 1 } },
        ], as: 'passkeys' } },
      { $match: { $or: [{ totp: true }, { 'passkeys.0': { $exists: true } }] } },
      { $limit: 1 }, { $project: { _id: 1 } },
    ]).session(session);
    return rows.length === 1;
  };
  if (session || !request || fresh) return read();
  let proofs = requestProofs.get(request);
  if (!proofs) { proofs = new Map(); requestProofs.set(request, proofs); }
  const key = JSON.stringify([String(actor._id), actor.security.tokenVersion, actor.__v,
    actor.security.mfaMethods, actor.security.mfaPasskeyCount,
    request.session?.mfaVerifiedMethod, request.session?.mfaVerifiedStrong]);
  if (proofs.has(key)) return proofs.get(key);
  if (proofs.size >= 8) proofs.clear();
  const pending = read().catch(error => { proofs.delete(key); throw error; });
  proofs.set(key, pending);
  return pending;
}

export async function hasCurrentStrongSessionMfa(request, actor = request?.user, options = {}) {
  if (!strongSessionMethod(request)) return false;
  return hasCurrentStrongMfa(actor, { ...options, request });
}

export function clearRequestMfaAssurance(request) {
  if (request && typeof request === 'object') requestProofs.delete(request);
}

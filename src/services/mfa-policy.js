import mongoose from 'mongoose';

const STRONG_METHODS = Object.freeze(['totp', 'passkey']);
export function strongMfaFence() {
  return { 'security.mfaEnabled': true, $or: [
    { 'security.mfaMethods': mongoose.trusted({ $exists: false }), 'security.mfaSecretEncrypted': mongoose.trusted({ $type: 'string', $ne: '' }) },
    { $and: [{ 'security.mfaMethods': mongoose.trusted({ $type: 'array' }) }, { 'security.mfaMethods': 'totp' }], 'security.mfaSecretEncrypted': mongoose.trusted({ $type: 'string', $ne: '' }) },
    { $and: [{ 'security.mfaMethods': mongoose.trusted({ $type: 'array' }) }, { 'security.mfaMethods': 'passkey' }], 'security.mfaPasskeyCount': mongoose.trusted({ $type: 'number', $gte: 1, $lte: 10 }) },
  ] };
}

export function smsMfaAllowed(user) {
  return Boolean(user && ['customer', 'seller', 'promoter'].includes(user.role) && !user.platformAccessManagedAt);
}

export function enabledMfaMethods(user) {
  if (!user?.security?.mfaEnabled) return [];
  const configured = Array.isArray(user.security.mfaMethods) ? user.security.mfaMethods : user.security.mfaMethods === undefined ? ['totp'] : [];
  return [...new Set(configured.filter(method => STRONG_METHODS.includes(method) || method === 'sms' && smsMfaAllowed(user)))];
}

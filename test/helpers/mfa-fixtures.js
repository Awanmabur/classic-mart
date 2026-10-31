import crypto from 'node:crypto';

// Background/domain fixtures do not sign in, but must still represent an
// actual persisted authenticator rather than merely toggling mfaEnabled.
// Import sensitive configuration only after the calling test sets its env.
export async function fixtureTotpSecurity() {
  const { encryptSensitive } = await import('../../src/core/sensitive.js');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const secret = [...crypto.randomBytes(32)].map(byte => alphabet[byte & 31]).join('');
  return { mfaEnabled: true, mfaMethods: ['totp'], mfaSecretEncrypted: encryptSensitive(secret),
    mfaLastCounter: -1, mfaRecoveryStrong: true, mfaEnrolledAt: new Date() };
}

export async function enrollFixtureTotp(user, password) {
  const { beginMfaEnrollment, confirmMfaEnrollment, totpCode } = await import('../../src/services/mfa.js');
  const enrollment = await beginMfaEnrollment(user._id, password);
  const result = await confirmMfaEnrollment(user._id, totpCode(enrollment.secret, { time: Date.now() - 30_000 }));
  return { ...result, secret: enrollment.secret };
}

import { AppError } from '../core/errors.js';
import { env } from '../config/env.js';

export function assertAftersalesMfa(request) {
  if (env.auth.simpleLogin || !env.security.privilegedMfaRequired) return;
  const verifiedAt = Number(request.session?.mfaVerifiedAt || 0), age = Date.now() - verifiedAt;
  if (!Number.isFinite(verifiedAt) || verifiedAt <= 0 || age < 0 || age > 12 * 60 * 60_000) {
    throw new AppError('Verify your authenticator again before handling order cases.', 403, 'MFA_VERIFICATION_REQUIRED');
  }
}

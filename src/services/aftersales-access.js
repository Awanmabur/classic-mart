import { AppError } from '../core/errors.js';
import { env } from '../config/env.js';
import { smsMfaAllowed } from './mfa-policy.js';
import { hasCurrentStrongSessionMfa } from './mfa-assurance.js';

export async function assertAftersalesMfa(request) {
  if (env.auth.simpleLogin || !env.security.privilegedMfaRequired) return;
  const verifiedAt = Number(request.session?.mfaVerifiedAt || 0), age = Date.now() - verifiedAt;
  const actor = request.authActor || request.user;
  if ((!smsMfaAllowed(actor) && !await hasCurrentStrongSessionMfa(request, actor))
    || !Number.isFinite(verifiedAt) || verifiedAt <= 0 || age < 0 || age > 12 * 60 * 60_000) {
    throw new AppError('Verify an eligible MFA method again before handling order cases.', 403, 'MFA_VERIFICATION_REQUIRED');
  }
}

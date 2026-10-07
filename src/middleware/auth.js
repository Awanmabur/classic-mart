import { Device, User } from '../models/index.js';
import { hashToken } from '../core/crypto.js';
import { AppError } from '../core/errors.js';
import { hasPermission } from '../core/roles.js';
import { env } from '../config/env.js';
import { mfaRequiredForUser } from '../services/mfa.js';
import { hydratePlatformAuthorization } from '../services/platform-grants.js';
import { requiresPrivilegedMfaForRequest } from './privileged-mfa-paths.js';

export async function loadUser(request, response, next) {
  try {
    if (!request.session?.userId) {
      response.locals.user = null;
      return next();
    }

    const sessionHash = hashToken(request.sessionID);
    const [actor, device] = await Promise.all([
      User.findById(request.session.userId).select('+operationalCountries'),
      Device.findOne({ userId: request.session.userId, sessionHash, revokedAt: null }),
    ]);
    if (actor) await hydratePlatformAuthorization(actor);
    if (
      !actor ||
      actor.status !== 'active' ||
      request.session.tokenVersion !== actor.security.tokenVersion
    ) {
      request.session.destroy(() => {});
      response.locals.user = null;
      return next();
    }

    if (!device) {
      request.session.destroy(() => {});
      response.locals.user = null;
      return next();
    }

    if (
      !request.session.deviceTouchedAt ||
      Date.now() - request.session.deviceTouchedAt > 5 * 60_000
    ) {
      device.lastSeenAt = new Date();
      await device.save();
      request.session.deviceTouchedAt = Date.now();
    }

    request.authActor = actor;
    const user = actor;
    request.user = user;
    request.device = device;
    response.locals.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

function wantsJson(request) {
  return request.path.startsWith('/api/') || request.accepts(['html', 'json']) === 'json';
}

export function requireAuth(request, response, next) {
  if (request.user) return next();
  if (wantsJson(request)) {
    return next(new AppError('Authentication required.', 401, 'UNAUTHENTICATED'));
  }
  const nextPath = encodeURIComponent(request.originalUrl);
  return response.redirect(`/login?next=${nextPath}`);
}

export function requireVerified(request, response, next) {
  if (env.auth.simpleLogin) return next();
  if (!request.user?.emailVerifiedAt) {
    if (wantsJson(request)) return next(new AppError('Verify your email to continue.', 403, 'EMAIL_UNVERIFIED'));
    return response.redirect('/verify-email');
  }
  return next();
}

export function requireOnboarding(request, response, next) {
  if (env.auth.simpleLogin) return next();
  if (request.user?.onboardingCompletedAt) return next();
  if (wantsJson(request)) {
    return next(
      new AppError('Complete onboarding to continue.', 403, 'ONBOARDING_REQUIRED'),
    );
  }
  return response.redirect('/onboarding');
}

export function requirePermission(permission) {
  return function permissionMiddleware(request, _response, next) {
    if (hasPermission(request.user, permission)) return next();
    return next(new AppError('You do not have permission to do that.', 403, 'FORBIDDEN'));
  };
}


export function enforcePrivilegedMfaEnrollment(request, response, next) {
  if (env.auth.simpleLogin) return next();
  const actor = request.authActor || request.user;
  if (!actor || !env.security.privilegedMfaRequired || !mfaRequiredForUser(actor, true) || actor.security?.mfaEnabled) return next();

  // MFA is a step-up boundary for privileged operational surfaces, not a global
  // browsing lock. Privileged users may still use the marketplace and their
  // customer/account pages before enrollment, while protected operations fail
  // closed until MFA is configured.
  const gateRequest = { path: request.path, query: request.query, user: actor };
  if (!requiresPrivilegedMfaForRequest(gateRequest)) return next();

  if (request.path.startsWith('/api/') || request.accepts(['html','json']) === 'json') {
    return next(new AppError('Multi-factor authentication enrollment is required for this privileged operation.', 403, 'MFA_ENROLLMENT_REQUIRED'));
  }
  const nextPath = encodeURIComponent(request.originalUrl || request.url || '/');
  return response.redirect(`/account/security?next=${nextPath}`);
}

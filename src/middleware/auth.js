import { Device, User } from '../models/index.js';
import { hashToken } from '../core/crypto.js';
import { AppError } from '../core/errors.js';
import { hasPermission } from '../core/roles.js';
import { env } from '../config/env.js';
import { mfaRequiredForUser } from '../services/mfa.js';

export async function loadUser(request, response, next) {
  try {
    if (!request.session?.userId) {
      response.locals.user = null;
      return next();
    }

    const actor = await User.findById(request.session.userId);
    if (
      !actor ||
      actor.status !== 'active' ||
      request.session.tokenVersion !== actor.security.tokenVersion
    ) {
      request.session.destroy(() => {});
      response.locals.user = null;
      return next();
    }

    const sessionHash = hashToken(request.sessionID);
    const device = await Device.findOne({
      userId: actor._id,
      sessionHash,
      revokedAt: null,
    });
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
    let user = actor;
    if (request.session.impersonation?.targetUserId) {
      const startedAt = Number(request.session.impersonation.startedAt || 0);
      if (!startedAt || Date.now() - startedAt > 30 * 60_000) {
        delete request.session.impersonation;
      }
    }
    if (request.session.impersonation?.targetUserId) {
      if (!['country_admin', 'super_admin'].includes(actor.role)) {
        delete request.session.impersonation;
      } else {
        const target = await User.findById(request.session.impersonation.targetUserId);
        if (!target || target.status !== 'active' || (actor.role === 'country_admin' && target.country !== actor.country) || target.role === 'super_admin') {
          delete request.session.impersonation;
        } else {
          request.adminActor = actor;
          user = target;
          response.locals.impersonation = {
            actor: { publicId: actor.publicId, name: actor.name, role: actor.role },
            target: { publicId: target.publicId, name: target.name, role: target.role, country: target.country },
            approvalPublicId: request.session.impersonation.approvalPublicId,
            readOnly: true,
          };
        }
      }
    }
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
  if (!request.user?.emailVerifiedAt) {
    if (wantsJson(request)) return next(new AppError('Verify your email to continue.', 403, 'EMAIL_UNVERIFIED'));
    return response.redirect('/verify-email');
  }
  if (!request.user?.phoneVerifiedAt) {
    if (wantsJson(request)) return next(new AppError('Verify your phone to continue.', 403, 'PHONE_UNVERIFIED'));
    return response.redirect('/verify-phone');
  }
  return next();
}

export function requireOnboarding(request, response, next) {
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
  const actor = request.authActor || request.user;
  if (!actor || !env.security.privilegedMfaRequired || !mfaRequiredForUser(actor, true) || actor.security?.mfaEnabled) return next();
  const allowed = request.path === '/logout' || request.path === '/account/security' || request.path.startsWith('/account/mfa/');
  if (allowed) return next();
  if (request.path.startsWith('/api/') || request.accepts(['html','json']) === 'json') {
    return next(new AppError('Multi-factor authentication enrollment is required for this role.', 403, 'MFA_ENROLLMENT_REQUIRED'));
  }
  return response.redirect('/account/security');
}

import { randomToken, safeEqual } from '../core/crypto.js';
import { AppError } from '../core/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const FORM_PATHS = new Set(['/login','/signup','/verify-email','/forgot-password','/reset-password','/verify-phone','/onboarding','/dashboard','/account/profile','/account/security','/help','/contact','/track-order','/ask-classic']);

function invalidCsrf() {
  return new AppError('Your form expired. Refresh the page and try again.', 403, 'CSRF_INVALID');
}

export function verifyDeferredCsrf(request) {
  if (!request.csrfDeferred) return;
  const supplied = request.body?._csrf || request.get('x-csrf-token');
  if (!request.session.csrfToken || !supplied || !safeEqual(supplied, request.session.csrfToken)) throw invalidCsrf();
  request.csrfDeferred = false;
}

export function csrfProtection(request, response, next) {
  // Bearer-authenticated mobile/seller APIs are not authorized by ambient browser cookies, so CSRF does not apply.
  if (request.path.startsWith('/webhooks/') || request.path.startsWith('/api/v1/mobile/') || request.path.startsWith('/api/v1/seller/')) return next();
  if (SAFE_METHODS.has(request.method)) {
    if (FORM_PATHS.has(request.path) || request.session.userId) {
      if (!request.session.csrfToken) request.session.csrfToken = randomToken();
      response.locals.csrfToken = request.session.csrfToken;
    }
    return next();
  }

  // Multipart fields do not exist until Multer parses them. Defer verification,
  // but require the upload route wrapper to call verifyDeferredCsrf immediately
  // after parsing and before any file is persisted or business state changes.
  if (request.is('multipart/form-data')) {
    if (!request.session.csrfToken) return next(invalidCsrf());
    request.csrfDeferred = true;
    response.locals.csrfToken = request.session.csrfToken;
    return next();
  }

  const supplied = request.body?._csrf || request.get('x-csrf-token');
  if (!request.session.csrfToken || !supplied || !safeEqual(supplied, request.session.csrfToken)) return next(invalidCsrf());
  response.locals.csrfToken = request.session.csrfToken;
  return next();
}

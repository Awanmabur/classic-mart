import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler, AppError } from '../core/errors.js';
import { randomToken } from '../core/crypto.js';
import { Device, Order, User } from '../models/index.js';
import {
  authenticate,
  createDevice,
  registerUser,
  requestPasswordReset,
  resendPhoneVerification,
  resendVerification,
  resetPassword,
  verifyEmail,
  verifyPhone,
} from '../services/auth.js';
import { writeAudit } from '../services/audit.js';
import {
  codeSchema,
  forgotSchema,
  loginSchema,
  resetSchema,
  signUpSchema,
} from '../validation/identity.js';
import { noStore } from '../middleware/request.js';
import { requireAuth } from '../middleware/auth.js';
import { setFlash } from '../middleware/view.js';
import { getCountries } from '../services/country.js';
import { acceptReferralCode } from '../services/stage9.js';
import { verifyMfa } from '../services/mfa.js';
import { writeSecurityEvent } from '../services/security.js';

const router = Router();
router.use(noStore);

const authenticationLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: 'Too many attempts. Try again later.',
});

function regenerate(request) {
  return new Promise((resolve, reject) => {
    request.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

function saveSession(request) {
  return new Promise((resolve, reject) => {
    request.session.save((error) => (error ? reject(error) : resolve()));
  });
}

function safeNext(value) {
  return typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//')
    ? value
    : '/dashboard';
}


async function beginMfaChallenge(request, user, remember, nextPath) {
  const continuity = {
    cartKey: typeof request.session.cartKey === 'string' ? request.session.cartKey : '',
    catalogueKey: typeof request.session.catalogueKey === 'string' ? request.session.catalogueKey : '',
    promoterTouchId: typeof request.session.promoterTouchId === 'string' ? request.session.promoterTouchId : '',
  };
  await regenerate(request);
  if (continuity.cartKey) request.session.cartKey = continuity.cartKey;
  if (continuity.catalogueKey) request.session.catalogueKey = continuity.catalogueKey;
  if (continuity.promoterTouchId) request.session.promoterTouchId = continuity.promoterTouchId;
  request.session.mfaChallenge = { userId: user._id.toString(), remember: Boolean(remember), next: safeNext(nextPath), issuedAt: Date.now() };
  request.session.cookie.maxAge = 10 * 60_000;
  await saveSession(request);
}

async function establishSession(request, user, remember) {
  // Session regeneration prevents fixation, but explicitly preserve only
  // non-authentication shopping continuity needed to merge a guest journey.
  const continuity = {
    cartKey: typeof request.session.cartKey === 'string' ? request.session.cartKey : '',
    catalogueKey: typeof request.session.catalogueKey === 'string' ? request.session.catalogueKey : '',
    promoterTouchId: typeof request.session.promoterTouchId === 'string' ? request.session.promoterTouchId : '',
  };
  await regenerate(request);
  request.session.userId = user._id.toString();
  request.session.tokenVersion = user.security.tokenVersion;
  if (continuity.cartKey) request.session.cartKey = continuity.cartKey;
  if (continuity.catalogueKey) request.session.catalogueKey = continuity.catalogueKey;
  if (continuity.promoterTouchId) request.session.promoterTouchId = continuity.promoterTouchId;
  request.session.cookie.maxAge = remember
    ? 30 * 24 * 60 * 60_000
    : 8 * 60 * 60_000;
  await createDevice(user, request);
  if (continuity.cartKey) {
    await Order.updateMany(
      { sessionKey: continuity.cartKey, userId: null },
      { $set: { userId: user._id } },
    );
  }
  await saveSession(request);
}

router.get('/login', (request, response) => {
  if (request.user) return response.redirect('/dashboard');
  return response.render('login', {
    pageError: null,
    values: { identity: '' },
    next: safeNext(request.query.next),
  });
});

router.post(
  '/login',
  authenticationLimit,
  asyncHandler(async (request, response) => {
    try {
      const input = loginSchema.parse(request.body);
      const user = await authenticate(input.identity, input.password, request);
      if (user.security?.mfaEnabled) {
        await beginMfaChallenge(request, user, Boolean(input.remember), input.next);
        await writeSecurityEvent(request, 'mfa.challenge_started', { actor: user, category: 'mfa', severity: 'low', result: 'success' });
        return response.redirect('/mfa');
      }
      await establishSession(request, user, Boolean(input.remember));
      await writeAudit(request, 'identity.login', {
        actor: user,
        targetType: 'user',
        targetPublicId: user.publicId,
      });
      if (!user.emailVerifiedAt) return response.redirect('/verify-email');
      if (!user.phoneVerifiedAt) return response.redirect('/verify-phone');
      if (!user.onboardingCompletedAt) return response.redirect('/onboarding');
      return response.redirect(safeNext(input.next));
    } catch (error) {
      await writeAudit(request, 'identity.login', {
        result: 'failure',
        metadata: { code: error.code || 'LOGIN_FAILED' },
      });
      return response.status(error.status || 422).render('login', {
        pageError: error.message,
        values: { identity: request.body.identity || '' },
        next: safeNext(request.body.next),
      });
    }
  }),
);



router.get('/mfa', asyncHandler(async (request, response) => {
  if (request.user) return response.redirect('/dashboard');
  const challenge = request.session?.mfaChallenge;
  if (!challenge?.userId || !challenge.issuedAt || Date.now() - Number(challenge.issuedAt) > 10 * 60_000) {
    delete request.session.mfaChallenge;
    return response.redirect('/login');
  }
  const user = await User.findById(challenge.userId).select('publicId email security.mfaEnabled status');
  if (!user || user.status !== 'active' || !user.security.mfaEnabled) {
    delete request.session.mfaChallenge;
    return response.redirect('/login');
  }
  return response.render('mfa', { pageError: null, recovery: false });
}));

router.post('/mfa', authenticationLimit, asyncHandler(async (request, response) => {
  const challenge = request.session?.mfaChallenge;
  try {
    if (!challenge?.userId || !challenge.issuedAt || Date.now() - Number(challenge.issuedAt) > 10 * 60_000) throw new AppError('The MFA challenge expired. Sign in again.', 401, 'MFA_CHALLENGE_EXPIRED');
    const result = await verifyMfa(challenge.userId, request.body.code);
    const user = await User.findById(challenge.userId);
    if (!user || user.status !== 'active') throw new AppError('This account is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
    const nextPath = safeNext(challenge.next);
    const remember = Boolean(challenge.remember);
    delete request.session.mfaChallenge;
    await establishSession(request, user, remember);
    await writeAudit(request, 'identity.login', { actor: user, targetType: 'user', targetPublicId: user.publicId, metadata: { mfa: result.method } });
    await writeSecurityEvent(request, 'mfa.challenge_succeeded', { actor: user, category: 'mfa', severity: 'low', result: 'success', metadata: { method: result.method } });
    if (!user.emailVerifiedAt) return response.redirect('/verify-email');
    if (!user.phoneVerifiedAt) return response.redirect('/verify-phone');
    if (!user.onboardingCompletedAt) return response.redirect('/onboarding');
    return response.redirect(nextPath);
  } catch (error) {
    await writeSecurityEvent(request, 'mfa.challenge_failed', { category: 'mfa', severity: 'medium', result: 'failure', metadata: { code: error.code || 'MFA_FAILED' } });
    return response.status(error.status || 422).render('mfa', { pageError: error.message, recovery: true });
  }
}));

router.get('/signup', (request, response) => {
  if (request.user) return response.redirect('/dashboard');
  return response.render('signup', { pageError: null, values: { referralCode: String(request.query.ref || '').trim().slice(0,24) } });
});

router.post(
  '/signup',
  authenticationLimit,
  asyncHandler(async (request, response) => {
    try {
      const input = signUpSchema.parse(request.body);
      const { user, developmentCode } = await registerUser(input, request);
      if (input.referralCode) {
        try { await acceptReferralCode(input.referralCode, user); }
        catch (referralError) { await writeAudit(request, 'growth.referral_rejected', { actor: user, targetType: 'referral', result: 'failure', metadata: { code: referralError.code || 'REFERRAL_INVALID' } }); }
      }
      await establishSession(request, user, false);
      setFlash(
        request,
        'success',
        'Your account was created. Enter the six-digit email code.',
        developmentCode
          ? `Development verification code: ${developmentCode}`
          : undefined,
      );
      await writeAudit(request, 'identity.signup', {
        actor: user,
        targetType: 'user',
        targetPublicId: user.publicId,
      });
      return response.redirect('/verify-email');
    } catch (error) {
      await writeAudit(request, 'identity.signup', {
        result: 'failure',
        metadata: { code: error.code || 'SIGNUP_FAILED' },
      });
      return response.status(error.status || 422).render('signup', {
        pageError: error.message,
        values: {
          name: request.body.name || '',
          email: request.body.email || '',
          phone: request.body.phone || '',
          referralCode: request.body.referralCode || '',
        },
      });
    }
  }),
);

router.get('/verify-email', requireAuth, (request, response) => {
  if (request.user.emailVerifiedAt) {
    if (!request.user.phoneVerifiedAt) return response.redirect('/verify-phone');
    return response.redirect(request.user.onboardingCompletedAt ? '/dashboard' : '/onboarding');
  }
  return response.render('verify-email', { pageError: null });
});

router.post(
  '/verify-email',
  requireAuth,
  authenticationLimit,
  asyncHandler(async (request, response) => {
    try {
      const input = codeSchema.parse(request.body);
      await verifyEmail(request.user, input.code);
      setFlash(request, 'success', 'Your email address is verified.');
      await writeAudit(request, 'identity.email_verified', {
        targetType: 'user',
        targetPublicId: request.user.publicId,
      });
      return response.redirect(request.user.phoneVerifiedAt ? '/onboarding' : '/verify-phone');
    } catch (error) {
      return response.status(error.status || 422).render('verify-email', {
        pageError: error.message,
      });
    }
  }),
);

router.post(
  '/verify-email/resend',
  requireAuth,
  authenticationLimit,
  asyncHandler(async (request, response) => {
    const developmentCode = await resendVerification(request.user, request);
    setFlash(
      request,
      'success',
      'A new verification code was prepared.',
      developmentCode
        ? `Development verification code: ${developmentCode}`
        : undefined,
    );
    await writeAudit(request, 'identity.email_code_resent', {
      targetType: 'user',
      targetPublicId: request.user.publicId,
    });
    response.redirect('/verify-email');
  }),
);

router.get('/verify-phone', requireAuth, (request, response) => {
  if (!request.user.emailVerifiedAt) return response.redirect('/verify-email');
  if (request.user.phoneVerifiedAt) return response.redirect(request.user.onboardingCompletedAt ? '/dashboard' : '/onboarding');
  return response.render('verify-phone', { pageError: null });
});

router.post('/verify-phone/send', requireAuth, authenticationLimit, asyncHandler(async (request, response) => {
  try {
    const developmentCode = await resendPhoneVerification(request.user, request);
    setFlash(request, 'success', 'A phone verification code was sent.', developmentCode ? `Development phone verification code: ${developmentCode}` : undefined);
    await writeAudit(request, 'identity.phone_code_sent', { targetType: 'user', targetPublicId: request.user.publicId });
    return response.redirect('/verify-phone');
  } catch (error) {
    return response.status(error.status || 422).render('verify-phone', { pageError: error.message });
  }
}));

router.post('/verify-phone', requireAuth, authenticationLimit, asyncHandler(async (request, response) => {
  try {
    const input = codeSchema.parse(request.body);
    await verifyPhone(request.user, input.code);
    setFlash(request, 'success', 'Your phone number is verified.');
    await writeAudit(request, 'identity.phone_verified', { targetType: 'user', targetPublicId: request.user.publicId });
    return response.redirect(request.user.onboardingCompletedAt ? '/dashboard' : '/onboarding');
  } catch (error) {
    return response.status(error.status || 422).render('verify-phone', { pageError: error.message });
  }
}));

router.get('/forgot-password', (request, response) => {
  response.render('forgot-password', { pageError: null });
});

router.post(
  '/forgot-password',
  authenticationLimit,
  asyncHandler(async (request, response) => {
    const input = forgotSchema.parse(request.body);
    const result = await requestPasswordReset(input.identity, request);
    request.session.resetUserPublicId =
      result.publicId || `invalid_${Date.now()}`;
    setFlash(
      request,
      'success',
      'If that account exists, a reset code has been sent.',
      result.developmentCode
        ? `Development reset code: ${result.developmentCode}`
        : result.maskedEmail
          ? `Code sent to ${result.maskedEmail}.`
          : undefined,
    );
    await writeAudit(request, 'identity.password_reset_requested', {
      result: 'success',
    });
    response.redirect('/reset-password');
  }),
);

router.get('/reset-password', (request, response) => {
  if (!request.session.resetUserPublicId) {
    return response.redirect('/forgot-password');
  }
  return response.render('reset-password', { pageError: null });
});

router.post(
  '/reset-password',
  authenticationLimit,
  asyncHandler(async (request, response) => {
    try {
      const input = resetSchema.parse({
        ...request.body,
        publicId: request.session.resetUserPublicId,
      });
      const user = await resetPassword(
        input.publicId,
        input.code,
        input.password,
      );
      delete request.session.resetUserPublicId;
      setFlash(
        request,
        'success',
        'Your password was changed. Sign in with the new password.',
      );
      await writeAudit(request, 'identity.password_reset_completed', {
        actor: user,
        targetType: 'user',
        targetPublicId: user.publicId,
      });
      return response.redirect('/login');
    } catch (error) {
      return response.status(error.status || 422).render('reset-password', {
        pageError: error.message,
      });
    }
  }),
);

router.post(
  '/logout',
  requireAuth,
  asyncHandler(async (request, response) => {
    await Device.updateOne(
      { _id: request.device._id },
      { $set: { revokedAt: new Date(), revokedReason: 'logout' } },
    );
    await writeAudit(request, 'identity.logout', {
      targetType: 'user',
      targetPublicId: request.user.publicId,
    });
    request.session.destroy(() => {
      response.clearCookie('cm.sid', { path: '/' });
      response.redirect('/login');
    });
  }),
);

router.get('/api/v1/country-options', asyncHandler(async (request, response) => {
  if (!request.session.csrfToken) request.session.csrfToken = randomToken();
  const countries = await getCountries();
  response.set('Cache-Control', 'private, no-store').json({
    csrfToken: request.session.csrfToken,
    current: request.country.code,
    countries: countries.map(({ code, name, currency, locale }) => ({ code, name, currency, locale })),
  });
}));

router.post(
  '/country',
  asyncHandler(async (request, response) => {
    const code = String(request.body.country || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) {
      throw new AppError('Choose a valid country.', 422, 'INVALID_COUNTRY');
    }
    const enabled = (await getCountries()).some((country) => country.code === code);
    if (!enabled) {
      throw new AppError(
        'That country is not currently available.',
        422,
        'COUNTRY_UNAVAILABLE',
      );
    }
    response.cookie('cm_country', code, {
      httpOnly: true,
      sameSite: 'lax',
      secure: request.secure,
      maxAge: 365 * 24 * 60 * 60_000,
    });
    if (request.user) {
      const updated = await User.findOneAndUpdate(
        { _id: request.user._id },
        { $set: { country: code } },
        { returnDocument: 'after' },
      );
      request.user = updated;
    }
    response.redirect(request.get('referer') || '/');
  }),
);

export default router;

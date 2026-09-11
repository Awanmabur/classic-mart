import crypto from 'node:crypto';
import { AppError } from '../core/errors.js';
import {
  hashPassword,
  hashToken,
  hashValue,
  normalizeEmail,
  normalizeIdentity,
  normalizePhone,
  randomCode,
  safeEqual,
  verifyPassword,
} from '../core/crypto.js';
import { Device, User, VerificationToken } from '../models/index.js';
import { sendVerificationCode } from './mail.js';
import { sendPhoneVerificationCode } from './sms.js';

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60_000;
const CODE_DURATION_MS = 10 * 60_000;

function publicId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function deviceLabel(userAgent) {
  const value = String(userAgent || '');
  const browser = /Edg\//.test(value)
    ? 'Edge'
    : /Chrome\//.test(value)
      ? 'Chrome'
      : /Firefox\//.test(value)
        ? 'Firefox'
        : /Safari\//.test(value)
          ? 'Safari'
          : 'Browser';
  const platform = /Windows/.test(value)
    ? 'Windows'
    : /Android/.test(value)
      ? 'Android'
      : /iPhone|iPad/.test(value)
        ? 'iOS'
        : /Mac OS/.test(value)
          ? 'macOS'
          : 'Device';
  return `${browser} on ${platform}`;
}

export function assertStrongPassword(password) {
  if (
    typeof password !== 'string' ||
    password.length < 12 ||
    password.length > 128 ||
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/\d/.test(password)
  ) {
    throw new AppError(
      'Use 12–128 characters with uppercase, lowercase and a number.',
      422,
      'WEAK_PASSWORD',
    );
  }
}

async function issueCode({ user, purpose, ip }) {
  const code = randomCode();
  await VerificationToken.updateMany(
    { userId: user._id, purpose, consumedAt: null },
    { $set: { consumedAt: new Date() } },
  );
  await VerificationToken.create({
    userId: user._id,
    purpose,
    tokenHash: hashToken(code),
    expiresAt: new Date(Date.now() + CODE_DURATION_MS),
    requestedIpHash: hashValue(ip || ''),
  });
  const delivery = purpose === 'verify_phone'
    ? await sendPhoneVerificationCode({ phone: user.phone, name: user.name, code })
    : await sendVerificationCode({ email: user.email, name: user.name, code, purpose });
  return delivery.developmentCode;
}

export async function registerUser(input, request) {
  assertStrongPassword(input.password);
  const emailNormalized = normalizeEmail(input.email);
  const phoneNormalized = normalizePhone(input.phone);
  if (!emailNormalized || !phoneNormalized) {
    throw new AppError(
      'Email and phone number are required.',
      422,
      'INVALID_IDENTITY',
    );
  }

  const existing = await User.exists({
    $or: [{ emailNormalized }, { phoneNormalized }],
  });
  if (existing) {
    throw new AppError(
      'An account already uses that email address or phone number.',
      409,
      'ACCOUNT_EXISTS',
    );
  }

  const passwordHash = await hashPassword(input.password);
  let user;
  try {
    user = await User.create({
      publicId: publicId('usr'),
      name: input.name,
      email: input.email.trim(),
      emailNormalized,
      phone: input.phone.trim(),
      phoneNormalized,
      passwordHash,
      role: 'customer',
      country: request.country.code,
      shoppingCountry: request.country.code,
      currency: request.country.currency,
      locale: request.country.locale,
      timeZone: request.country.timeZone,
      consents: {
        terms: true,
        privacy: true,
        marketing: Boolean(input.marketing),
        recordedAt: new Date(),
        policyVersion: '2026-07',
      },
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw new AppError(
        'An account already uses that email address or phone number.',
        409,
        'ACCOUNT_EXISTS',
      );
    }
    throw error;
  }

  const developmentCode = await issueCode({
    user,
    purpose: 'verify_email',
    ip: request.ip,
  });
  return { user, developmentCode };
}

export async function resendVerification(user, request) {
  if (user.emailVerifiedAt) return undefined;
  const recent = await VerificationToken.findOne({
    userId: user._id,
    purpose: 'verify_email',
    consumedAt: null,
    createdAt: { $gt: new Date(Date.now() - 60_000) },
  }).lean();
  if (recent) {
    throw new AppError(
      'Wait one minute before requesting another code.',
      429,
      'CODE_RATE_LIMITED',
    );
  }
  return issueCode({
    user,
    purpose: 'verify_email',
    ip: request.ip,
  });
}

export async function consumeCode(userId, purpose, code) {
  const token = await VerificationToken.findOne({
    userId,
    purpose,
    consumedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .select('+tokenHash');

  if (!token || token.attempts >= 5) {
    throw new AppError(
      'The verification code is invalid or expired.',
      422,
      'INVALID_CODE',
    );
  }

  const matches = safeEqual(hashToken(code), token.tokenHash);
  if (!matches) {
    token.attempts += 1;
    await token.save();
    throw new AppError(
      'The verification code is invalid or expired.',
      422,
      'INVALID_CODE',
    );
  }

  token.consumedAt = new Date();
  await token.save();
  return token;
}

export async function verifyEmail(user, code) {
  await consumeCode(user._id, 'verify_email', code);
  if (!user.emailVerifiedAt) {
    user.emailVerifiedAt = new Date();
    await user.save();
  }
  return user;
}

export async function resendPhoneVerification(user, request) {
  if (!user.emailVerifiedAt) throw new AppError('Verify your email before verifying your phone.', 409, 'EMAIL_UNVERIFIED');
  if (user.phoneVerifiedAt) return undefined;
  const recent = await VerificationToken.findOne({ userId: user._id, purpose: 'verify_phone', consumedAt: null, createdAt: { $gt: new Date(Date.now() - 60_000) } }).lean();
  if (recent) throw new AppError('Wait one minute before requesting another phone code.', 429, 'CODE_RATE_LIMITED');
  return issueCode({ user, purpose: 'verify_phone', ip: request.ip });
}

export async function verifyPhone(user, code) {
  if (!user.emailVerifiedAt) throw new AppError('Verify your email first.', 409, 'EMAIL_UNVERIFIED');
  await consumeCode(user._id, 'verify_phone', code);
  if (!user.phoneVerifiedAt) { user.phoneVerifiedAt = new Date(); await user.save(); }
  return user;
}

export async function authenticate(identity, password, request) {
  const user = await User.findOne(normalizeIdentity(identity)).select(
    '+passwordHash +security.lastLoginIpHash',
  );

  if (!user) {
    await hashPassword(password || 'invalid-password-equalization');
    throw new AppError(
      'The email, phone number or password is incorrect.',
      401,
      'INVALID_CREDENTIALS',
    );
  }

  if (user.security.lockedUntil > new Date()) {
    throw new AppError(
      'Sign-in is temporarily locked. Try again later or reset your password.',
      429,
      'ACCOUNT_LOCKED',
    );
  }

  const valid = await verifyPassword(user.passwordHash, password || '');
  if (!valid) {
    const failedLoginCount = user.security.failedLoginCount + 1;
    const update = { 'security.failedLoginCount': failedLoginCount };
    if (failedLoginCount >= MAX_LOGIN_ATTEMPTS) {
      update['security.lockedUntil'] = new Date(Date.now() + LOCK_DURATION_MS);
      update['security.failedLoginCount'] = 0;
    }
    await User.updateOne({ _id: user._id }, { $set: update });
    throw new AppError(
      'The email, phone number or password is incorrect.',
      401,
      'INVALID_CREDENTIALS',
    );
  }

  if (user.status !== 'active') {
    throw new AppError(
      'This account is not available. Contact support.',
      403,
      'ACCOUNT_UNAVAILABLE',
    );
  }

  user.security.failedLoginCount = 0;
  user.security.lockedUntil = undefined;
  user.security.lastLoginAt = new Date();
  user.security.lastLoginIpHash = hashValue(request.ip || '');
  await user.save();
  return user;
}

export async function createDevice(user, request) {
  const device = await Device.create({
    publicId: publicId('dev'),
    userId: user._id,
    sessionHash: hashToken(request.sessionID),
    label: deviceLabel(request.get('user-agent')),
    userAgent: request.get('user-agent') || 'Unknown',
    ipHash: hashValue(request.ip || ''),
    lastSeenAt: new Date(),
  });
  return device;
}

export async function requestPasswordReset(identity, request) {
  const user = await User.findOne(normalizeIdentity(identity));
  if (!user || user.status !== 'active') return {};
  const recent = await VerificationToken.findOne({
    userId: user._id,
    purpose: 'password_reset',
    consumedAt: null,
    createdAt: { $gt: new Date(Date.now() - 60_000) },
  }).lean();
  const maskedEmail = user.email.replace(
    /^(.{1,2}).*(@.*)$/,
    (_match, start, domain) => `${start}***${domain}`,
  );
  if (recent) {
    return { publicId: user.publicId, maskedEmail };
  }
  const developmentCode = await issueCode({
    user,
    purpose: 'password_reset',
    ip: request.ip,
  });
  return {
    publicId: user.publicId,
    maskedEmail,
    developmentCode,
  };
}

export async function resetPassword(publicIdValue, code, password) {
  assertStrongPassword(password);
  const user = await User.findOne({ publicId: publicIdValue }).select(
    '+passwordHash',
  );
  if (!user) {
    throw new AppError(
      'The reset request is invalid or expired.',
      422,
      'INVALID_RESET',
    );
  }
  await consumeCode(user._id, 'password_reset', code);
  user.passwordHash = await hashPassword(password);
  user.security.passwordChangedAt = new Date();
  user.security.tokenVersion += 1;
  user.security.failedLoginCount = 0;
  user.security.lockedUntil = undefined;
  await user.save();
  await Device.updateMany(
    { userId: user._id, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'password_reset' } },
  );
  return user;
}

export async function changePassword(userId, currentPassword, newPassword) {
  assertStrongPassword(newPassword);
  const user = await User.findById(userId).select('+passwordHash');
  if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) {
    throw new AppError(
      'The current password is incorrect.',
      422,
      'INVALID_CURRENT_PASSWORD',
    );
  }
  user.passwordHash = await hashPassword(newPassword);
  user.security.passwordChangedAt = new Date();
  user.security.tokenVersion += 1;
  await user.save();
  return user;
}

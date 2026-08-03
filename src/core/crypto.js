import crypto from 'node:crypto';
import argon2 from 'argon2';
import { env } from '../config/env.js';

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function normalizePhone(value) {
  return String(value || '').replace(/[^\d+]/g, '');
}

export function normalizeIdentity(value) {
  const identity = String(value || '').trim();
  return identity.includes('@')
    ? { emailNormalized: normalizeEmail(identity) }
    : { phoneNormalized: normalizePhone(identity) };
}

export function hashPassword(password) {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 3,
    parallelism: 1,
    hashLength: 32,
  });
}

export function verifyPassword(hash, password) {
  return argon2.verify(hash, password, { type: argon2.argon2id });
}

export function randomCode() {
  return crypto.randomInt(100_000, 1_000_000).toString();
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hashToken(token) {
  return crypto
    .createHmac('sha256', env.tokenPepper)
    .update(String(token))
    .digest('hex');
}

export function hashValue(value) {
  return crypto
    .createHmac('sha256', env.tokenPepper)
    .update(String(value))
    .digest('hex');
}

export function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

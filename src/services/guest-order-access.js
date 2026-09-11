import { normalizeEmail, normalizePhone, randomCode, hashToken, safeEqual } from '../core/crypto.js';
import { AppError } from '../core/errors.js';
import { Order } from '../models/index.js';
import { addOutboxEvent } from './outbox.js';
import { grantTrackedOrder } from './order-access.js';

const CHALLENGE_TTL_MS = 10 * 60_000;
const READ_GRANT_MS = 30 * 60_000;
const MUTATE_GRANT_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;

function challengeStore(request) {
  if (!request.session) throw new TypeError('A server session is required for guest order verification.');
  const now = Date.now();
  const current = request.session.orderAccessChallenges && typeof request.session.orderAccessChallenges === 'object'
    ? request.session.orderAccessChallenges
    : {};
  request.session.orderAccessChallenges = Object.fromEntries(
    Object.entries(current)
      .filter(([, row]) => Number(row?.expiresAt || 0) > now && Number(row?.attempts || 0) < MAX_ATTEMPTS)
      .slice(-10),
  );
  return request.session.orderAccessChallenges;
}

function identityMatches(order, supplied) {
  const value = String(supplied || '').trim();
  if (!value) return false;
  if (value.includes('@')) return normalizeEmail(value) === normalizeEmail(order.contact?.email || '');
  try { return normalizePhone(value) === normalizePhone(order.contact?.phone || ''); } catch { return false; }
}

function maskedEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!local || !domain) return 'the order email address';
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(2, local.length - visible.length))}@${domain}`;
}

export async function createGuestOrderChallenge(request, orderId, { identity, purpose = 'read' } = {}) {
  const cleanPurpose = purpose === 'mutate' ? 'mutate' : 'read';
  const order = await Order.findOne({ publicId: String(orderId || '').trim() }).select('publicId contact userId sessionKey status').lean();
  if (!order || !identityMatches(order, identity)) throw new AppError('Order not found or verification detail is incorrect.', 404, 'ORDER_NOT_FOUND');
  const code = randomCode();
  const store = challengeStore(request);
  store[order.publicId] = {
    codeHash: hashToken(`${order.publicId}:${cleanPurpose}:${code}`),
    purpose: cleanPurpose,
    attempts: 0,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  };
  const email = String(order.contact?.email || '').trim();
  if (!email) throw new AppError('This order has no verified email destination for secure tracking.', 409, 'ORDER_TRACKING_EMAIL_MISSING');
  await addOutboxEvent({
    type: 'guest.order_access_code',
    aggregateType: 'order',
    aggregatePublicId: order.publicId,
    payload: {
      email,
      subject: cleanPurpose === 'mutate' ? 'Classic Mart order action verification code' : 'Classic Mart order tracking code',
      body: cleanPurpose === 'mutate'
        ? `Your Classic Mart verification code is ${code}. It expires in 10 minutes and is required before sensitive order actions.`
        : `Your Classic Mart tracking code is ${code}. It expires in 10 minutes.`,
      purpose: cleanPurpose,
    },
  });
  return { orderId: order.publicId, purpose: cleanPurpose, destination: maskedEmail(email), expiresInSeconds: CHALLENGE_TTL_MS / 1000 };
}

export function verifyGuestOrderChallenge(request, orderId, { code, purpose = 'read' } = {}) {
  const cleanPurpose = purpose === 'mutate' ? 'mutate' : 'read';
  const store = challengeStore(request);
  const row = store[String(orderId || '')];
  if (!row || row.purpose !== cleanPurpose || Number(row.expiresAt || 0) <= Date.now()) throw new AppError('Tracking verification code expired. Request a new code.', 409, 'ORDER_TRACKING_CODE_EXPIRED');
  row.attempts = Number(row.attempts || 0) + 1;
  if (row.attempts > MAX_ATTEMPTS) {
    delete store[String(orderId || '')];
    throw new AppError('Too many incorrect verification attempts. Request a new code.', 429, 'ORDER_TRACKING_CODE_LOCKED');
  }
  const expected = hashToken(`${String(orderId || '')}:${cleanPurpose}:${String(code || '').trim()}`);
  if (!safeEqual(expected, row.codeHash)) {
    if (row.attempts >= MAX_ATTEMPTS) delete store[String(orderId || '')];
    throw new AppError('Verification code is incorrect.', 422, 'ORDER_TRACKING_CODE_INVALID');
  }
  delete store[String(orderId || '')];
  grantTrackedOrder(request, orderId, cleanPurpose === 'mutate' ? MUTATE_GRANT_MS : READ_GRANT_MS, cleanPurpose === 'mutate' ? 'mutate' : 'read');
  return { orderId: String(orderId || ''), access: cleanPurpose === 'mutate' ? 'mutate' : 'read', expiresInSeconds: (cleanPurpose === 'mutate' ? MUTATE_GRANT_MS : READ_GRANT_MS) / 1000 };
}

import { env } from '../config/env.js';
import { AppError } from '../core/errors.js';

const MAX_RESPONSE_BYTES = 16_384;
const ACCEPTED_SEND_STATUSES = new Set(['success', 'accepted', 'queued', 'ok']);

export async function sendPhoneVerificationCode({ phone, name, code }) {
  if (env.sms.mode === 'log') return { delivered: false, developmentCode: code };
  assertYoolaConfigured();
  if (typeof phone !== 'string' || phone !== phone.trim() || !/^\+[1-9]\d{7,14}$/.test(phone) ||
      typeof code !== 'string' || code !== code.trim() || !/^\d{6}$/.test(code)) {
    throw new AppError('Invalid verification recipient or code.', 400, 'SMS_INVALID_REQUEST');
  }
  const result = await yoolaRequest('send', {
    phone: phone.slice(1),
    message: `Classic Mart verification code: ${code}. It expires in 10 minutes. Do not share this code.`,
  });
  const providerId = result.message_id;
  if (!ACCEPTED_SEND_STATUSES.has(providerStatus(result)) || typeof providerId !== 'string' ||
      !providerId.trim() || providerId.length > 200 || /[\u0000-\u001f\u007f]/.test(providerId)) {
    throw smsFailure();
  }
  // API acceptance is not a handset delivery receipt.
  return { delivered: false, accepted: true, providerId, recipient: phone, name };
}

function assertYoolaConfigured() {
  if (env.sms.mode !== 'yoola' || !env.sms.yoolaApiKey) {
    throw new AppError('Yoola SMS delivery is not configured.', 503, 'SMS_NOT_CONFIGURED');
  }
}

function smsFailure(status) {
  if ([401, 403].includes(status)) return new AppError('Yoola authentication or permissions failed. Check the configured API key.', 502, 'SMS_AUTH_FAILED');
  if (status === 402) return new AppError('Yoola has insufficient SMS credit. Contact support.', 502, 'SMS_CREDIT_REQUIRED');
  if (status === 429) return new AppError('SMS sending is temporarily rate limited. Please try again later.', 429, 'SMS_PROVIDER_RATE_LIMITED');
  return new AppError('SMS provider could not accept the request. Please try again later.', 502, 'SMS_DELIVERY_FAILED');
}

function providerStatus(result) {
  return typeof result.status === 'string' ? result.status.toLowerCase() : '';
}

async function readProviderResponse(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw smsFailure();
  }
  if (!response.body) throw smsFailure();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw smsFailure();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const result = JSON.parse(new TextDecoder().decode(bytes));
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.error || result.success === false) throw smsFailure();
  return result;
}

// Matches this owner's existing Yoola integration, not an independently verified
// provider specification: Awanmabur/chariot-sms-test, commit e694237edf03c2445c722f1f4b3bf5801a2740d2.
// Fixed endpoints prevent credential forwarding. Never retry billed sends: a
// timeout or malformed response can follow provider acceptance.
async function yoolaRequest(endpoint, body = {}) {
  assertYoolaConfigured();
  if (!['send', 'balance'].includes(endpoint)) throw smsFailure();
  try {
    const response = await fetch(`https://yoolasms.com/api/v1/${endpoint}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: env.sms.yoolaApiKey, ...body }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw smsFailure(response.status);
    }
    return await readProviderResponse(response);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw smsFailure();
  }
}

export async function verifySmsConfiguration() {
  const result = await yoolaRequest('balance');
  if (!['success', 'ok'].includes(providerStatus(result))) throw smsFailure();
  // The reference integration does not establish a balance value/unit schema.
  return { authenticated: true, creditAvailable: null };
}

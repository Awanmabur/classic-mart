import { env } from '../config/env.js';
import { AppError } from '../core/errors.js';

export async function sendPhoneVerificationCode({ phone, name, code }) {
  if (env.sms.mode === 'log') return { delivered: false, developmentCode: code };
  if (env.sms.mode === 'esms') {
    if (!env.sms.esmsApiKey) throw new AppError('SMS delivery is not configured.', 503, 'SMS_NOT_CONFIGURED');
    if (!/^\+[1-9]\d{7,14}$/.test(phone) || !/^\d{6}$/.test(code)) {
      throw new AppError('Invalid verification recipient or code.', 400, 'SMS_INVALID_REQUEST');
    }
    const result = await esmsRequest('/messages/send', {
      to: phone,
      text: `Classic Mart verification code: ${code}. It expires in 10 minutes. Do not share this code.`,
      ...(env.sms.esmsSenderId ? { sender_id: env.sms.esmsSenderId } : {}),
    });
    if (typeof result.id !== 'string' || !result.id || !['queued', 'submitted', 'delivered'].includes(result.status)) {
      throw smsFailure();
    }
    return { delivered: result.status === 'delivered', accepted: true, providerId: result.id, recipient: phone, name };
  }
  throw new AppError('eSMS Africa delivery is not configured.', 503, 'SMS_NOT_CONFIGURED');
}

function smsFailure(status) {
  if ([401, 403].includes(status)) return new AppError('eSMS Africa authentication or permissions failed. Check the configured API key.', 502, 'SMS_AUTH_FAILED');
  if (status === 402) return new AppError('eSMS Africa has insufficient SMS credit. Contact support.', 502, 'SMS_CREDIT_REQUIRED');
  if (status === 429) return new AppError('SMS sending is temporarily rate limited. Please try again later.', 429, 'SMS_PROVIDER_RATE_LIMITED');

  return new AppError('SMS provider could not accept the verification code. Please try again later.', 502, 'SMS_DELIVERY_FAILED');
}

// Protocol documented by https://github.com/eSMS-Africa/esms-sdk-node.
// Never retry a send automatically: a timeout may follow an accepted, billed SMS.
async function esmsRequest(path, body) {
  try {
    const response = await fetch(`https://sms.esmsafrica.io/api${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${env.sms.esmsApiKey}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw smsFailure(response.status);
    const result = await response.json();
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw smsFailure();
    return result;
  } catch (error) { if (error instanceof AppError) throw error; throw smsFailure(); }
}

export async function verifySmsConfiguration() {
  if (env.sms.mode !== 'esms' || !env.sms.esmsApiKey) throw new AppError('eSMS Africa delivery is not configured.', 503, 'SMS_NOT_CONFIGURED');
  const result = await esmsRequest('/balance');
  const balance = typeof result.balance === 'number' ? result.balance : typeof result.balance === 'string' && /^\d+(?:\.\d+)?$/.test(result.balance) ? Number(result.balance) : NaN;
  if (!Number.isFinite(balance) || typeof result.currency !== 'string' || !result.currency) throw smsFailure();
  return { authenticated: true, creditAvailable: balance > 0 };
}

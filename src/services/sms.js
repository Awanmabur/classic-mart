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
  if (env.sms.mode !== 'twilio') throw new AppError('SMS delivery is not configured.', 503, 'SMS_NOT_CONFIGURED');
  const { accountSid, authToken, from } = env.sms;
  if (!accountSid || !authToken || !from) throw new AppError('SMS delivery is not configured.', 503, 'SMS_NOT_CONFIGURED');
  const body = new URLSearchParams({
    To: phone,
    From: from,
    Body: `Classic Mart verification code: ${code}. It expires in 10 minutes. Do not share this code.`,
  });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new AppError('SMS provider could not accept the verification code. Please try again later.', 502, 'SMS_DELIVERY_FAILED');
  }
  return { delivered: true, recipient: phone, name };
}

function smsFailure() {
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
    if (!response.ok) throw smsFailure();
    const result = await response.json();
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw smsFailure();
    return result;
  } catch { throw smsFailure(); }
}

export async function verifySmsConfiguration() {
  if (env.sms.mode !== 'esms' || !env.sms.esmsApiKey) throw new AppError('eSMS Africa delivery is not configured.', 503, 'SMS_NOT_CONFIGURED');
  const result = await esmsRequest('/balance');
  if (typeof result.balance !== 'number' || !Number.isFinite(result.balance) || typeof result.currency !== 'string' || !result.currency) throw smsFailure();
  return { authenticated: true, creditAvailable: result.balance > 0 };
}

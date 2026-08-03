import { env } from '../config/env.js';
import { AppError } from '../core/errors.js';

export async function sendPhoneVerificationCode({ phone, name, code }) {
  if (env.sms.mode === 'log') return { delivered: false, developmentCode: code };
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
    let detail = '';
    try { detail = String((await response.json())?.message || ''); } catch {}
    throw new AppError(detail ? `SMS provider rejected the verification message: ${detail.slice(0,160)}` : 'SMS provider could not deliver the verification code.', 502, 'SMS_DELIVERY_FAILED');
  }
  return { delivered: true, recipient: phone, name };
}

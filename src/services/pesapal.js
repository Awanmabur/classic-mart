import { env } from '../config/env.js';
import { AppError } from '../core/errors.js';
import { formatTraceparent, getTraceContext, withTraceSpan } from '../core/trace.js';
import { logger } from '../config/logger.js';

let cachedToken = '';
let cachedTokenExpiresAt = 0;

function endpoint(path) {
  return `${String(env.pesapal.baseUrl || '').replace(/\/$/, '')}${path}`;
}

async function parsePayload(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 400) }; }
}

async function request(path, { method = 'GET', body, auth = true, tolerateBusinessError = false } = {}) {
  return withTraceSpan('pesapal.request', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.pesapal.timeoutMs);
  try {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    const trace = getTraceContext();
    const traceparent = formatTraceparent(trace);
    if (traceparent) headers.traceparent = traceparent;
    if (trace?.traceId) headers['x-classic-mart-trace-id'] = trace.traceId;
    if (auth) headers.Authorization = `Bearer ${await pesapalToken()}`;
    const startedAt = Date.now();
    logger.debug({ span: 'pesapal.request', phase: 'start', provider: 'pesapal', method, path }, 'Pesapal request started');
    const response = await fetch(endpoint(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await parsePayload(response);
    logger.debug({ span: 'pesapal.request', phase: 'finish', provider: 'pesapal', method, path, statusCode: response.status, durationMs: Date.now() - startedAt }, 'Pesapal request completed');
    const providerError = payload?.error && (payload.error.message || payload.error.code || payload.error.type);
    const businessFailure = String(payload?.status || '') === '500' || Number(payload?.error) === 500;
    if (!response.ok || providerError || (!tolerateBusinessError && businessFailure)) {
      const error = new AppError(
        String(payload?.error?.message || payload?.message || 'Pesapal request failed.').slice(0, 300),
        502,
        'PESAPAL_REQUEST_FAILED',
      );
      error.providerPayload = payload;
      error.providerHttpStatus = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error instanceof AppError) throw error;
    const unavailable = new AppError('Pesapal is temporarily unavailable. The transaction will be reconciled before any money state is changed.', 502, 'PESAPAL_UNAVAILABLE');
    unavailable.ambiguous = true;
    unavailable.cause = error;
    throw unavailable;
  } finally {
    clearTimeout(timer);
  }
  });
}

export async function pesapalToken({ force = false } = {}) {
  if (!env.pesapal.consumerKey || !env.pesapal.consumerSecret) {
    throw new AppError('Pesapal is not configured.', 503, 'PAYMENT_PROVIDER_UNAVAILABLE');
  }
  if (!force && cachedToken && Date.now() < cachedTokenExpiresAt - 30_000) return cachedToken;
  const payload = await request('/api/Auth/RequestToken', {
    method: 'POST',
    auth: false,
    body: { consumer_key: env.pesapal.consumerKey, consumer_secret: env.pesapal.consumerSecret },
  });
  if (!payload?.token) throw new AppError('Pesapal did not return an access token.', 502, 'PESAPAL_TOKEN_INVALID');
  cachedToken = String(payload.token);
  const parsedExpiry = Date.parse(payload.expiryDate || '');
  cachedTokenExpiresAt = Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + 4 * 60_000;
  return cachedToken;
}

export async function registerPesapalIpn(url, method = 'POST') {
  if (!/^https:\/\//i.test(String(url || ''))) throw new AppError('Pesapal IPN URL must use HTTPS.', 422, 'PESAPAL_IPN_URL_INVALID');
  const payload = await request('/api/URLSetup/RegisterIPN', { method: 'POST', body: { url, ipn_notification_type: method.toUpperCase() === 'GET' ? 'GET' : 'POST' } });
  if (!payload?.ipn_id) throw new AppError('Pesapal did not return an IPN ID.', 502, 'PESAPAL_IPN_REGISTRATION_FAILED');
  return payload;
}

export async function submitPesapalOrder(payload) {
  if (!env.pesapal.notificationId) throw new AppError('Pesapal IPN ID is not configured.', 503, 'PESAPAL_IPN_NOT_CONFIGURED');
  return request('/api/Transactions/SubmitOrderRequest', { method: 'POST', body: { ...payload, notification_id: env.pesapal.notificationId } });
}

export async function getPesapalTransactionStatus(orderTrackingId) {
  if (!orderTrackingId) throw new AppError('Pesapal order tracking ID is required.', 422, 'PESAPAL_TRACKING_ID_REQUIRED');
  return request(`/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(orderTrackingId)}`);
}

export async function requestPesapalRefund({ confirmationCode, amount, username, remarks }) {
  if (!confirmationCode) throw new AppError('Pesapal confirmation code is required for a refund.', 409, 'PESAPAL_CONFIRMATION_REQUIRED');
  return request('/api/Transactions/RefundRequest', {
    method: 'POST',
    tolerateBusinessError: true,
    body: {
      confirmation_code: String(confirmationCode),
      amount: Number(amount),
      username: String(username || 'Classic Mart Finance').slice(0, 120),
      remarks: String(remarks || 'Classic Mart refund').slice(0, 240),
    },
  });
}

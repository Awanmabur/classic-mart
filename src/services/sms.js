import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../core/errors.js';

const MAX_RESPONSE_BYTES = 16_384;
const ACCEPTED_SEND_STATUSES = new Set(['success', 'accepted', 'queued', 'ok']);
const AUTH_CODES = new Set(['invalid_api_key', 'api_key_required', 'api_key_missing', 'missing_api_key', 'expired_api_key',
  'revoked_api_key', 'unauthorized', 'unauthorised', 'authentication_failed', 'authentication_error', 'invalid_credentials', 'access_denied', 'forbidden']);
const CREDIT_CODES = new Set(['insufficient_balance', 'insufficient_credit', 'insufficient_credits', 'insufficient_funds', 'low_balance', 'no_credit', 'no_credits']);
const SENDER_CODES = new Set(['invalid_sender', 'invalid_sender_id', 'sender_not_approved', 'sender_id_not_approved', 'unapproved_sender', 'sender_required']);
const RECIPIENT_CODES = new Set(['invalid_phone', 'invalid_phone_number', 'invalid_recipient', 'unsupported_country', 'unsupported_network', 'invalid_msisdn']);
const RATE_CODES = new Set(['rate_limit', 'rate_limited', 'rate_limit_exceeded', 'too_many_requests', 'throttled']);
const REPORT_FIELDS = new Set(['data', 'result', 'results', 'report', 'reports', 'response', 'payload', 'items', 'records',
  'messages', 'message', 'sms', 'delivery', 'delivery_report', 'deliveryReport', 'delivery_status', 'deliveryStatus',
  'delivery_state', 'message_status', 'messageStatus', 'message_state', 'sms_status', 'dlr_status', 'status', 'state',
  'status_name', 'status_code', 'message_id', 'messageId', 'id', 'reference', 'error', 'errors', 'error_code', 'reason', 'description',
  'delivered', 'delivery_confirmed', 'delivered_at', 'sent_at']);
const REPORT_STATUS_FIELDS = new Set(['delivery', 'delivery_status', 'deliveryStatus', 'delivery_state', 'message_status',
  'messageStatus', 'message_state', 'sms_status', 'dlr_status', 'status', 'state', 'status_name']);
const REPORT_STATUS_VALUES = new Set(['success', 'accepted', 'queued', 'ok', 'error', 'failed', 'failure', 'delivered',
  'undelivered', 'rejected', 'pending', 'sent', 'processing', 'unknown', 'expired', 'cancelled', 'scheduled', 'submitted',
  'buffered', 'enroute', 'delivrd', 'undeliv', 'acceptd', 'rejectd', 'deleted', 'not_found']);

function deliveryReportShape(result, secret) {
  const entries = [];
  let truncated = false;
  function visit(value, path, field, depth) {
    if (entries.length >= 60) { truncated = true; return; }
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const entry = { path, type };
    if (typeof value === 'string' && REPORT_STATUS_FIELDS.has(field)) {
      const status = value.trim().toLowerCase();
      if (REPORT_STATUS_VALUES.has(status) && status !== String(secret).trim().toLowerCase()) entry.recognizedStatus = status;
    }
    if (typeof value === 'boolean' && ['delivered', 'delivery_confirmed'].includes(field)) entry.reportedBoolean = value;
    entries.push(entry);
    if (!value || typeof value !== 'object') return;
    if (depth >= 4) { truncated = true; return; }
    if (Array.isArray(value)) {
      entry.items = value.length;
      value.slice(0, 3).forEach((item, index) => visit(item, `${path}[${index}]`, '', depth + 1));
      if (value.length > 3) truncated = true;
    } else {
      const keys = Object.keys(value);
      entry.otherFields = keys.filter(key => !REPORT_FIELDS.has(key)).length;
      for (const key of keys) if (REPORT_FIELDS.has(key)) visit(value[key], `${path}.${key}`, key, depth + 1);
    }
  }
  visit(result, '$', '', 0);
  return { entries, truncated };
}

const failures = Object.freeze({
  authentication: ['Yoola authentication or permissions failed. Check the configured API key.', 502, 'SMS_AUTH_FAILED'],
  credit: ['Yoola has insufficient SMS credit. Contact support.', 502, 'SMS_CREDIT_REQUIRED'],
  sender: ['Yoola rejected the SMS sender. Contact support to check the approved sender configuration.', 502, 'SMS_SENDER_REJECTED'],
  recipient: ['The SMS provider rejected this phone number or mobile network. Check the country code and number.', 422, 'SMS_RECIPIENT_REJECTED'],
  rate_limit: ['SMS sending is temporarily rate limited. Please try again later.', 429, 'SMS_PROVIDER_RATE_LIMITED'],
  timeout: ['The SMS request timed out. Delivery is uncertain; wait before requesting a new code.', 502, 'SMS_REQUEST_TIMEOUT'],
  network: ['The SMS service could not be reached. Please try again later.', 502, 'SMS_NETWORK_FAILED'],
  rejected: ['SMS provider could not accept the request. Please try again later.', 502, 'SMS_DELIVERY_FAILED'],
  malformed: ['SMS provider returned an unconfirmed response. Wait before requesting a new code.', 502, 'SMS_DELIVERY_FAILED'],
});

function providerStatus(result) {
  return typeof result.status === 'string' ? result.status.trim().toLowerCase() : '';
}

function hasExplicitRejection(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  return Boolean(result.error || (result.errors && (!Array.isArray(result.errors) || result.errors.length)) ||
    result.success === false || ['error', 'failed', 'failure', 'rejected', 'declined', 'denied', 'cancelled'].includes(providerStatus(result)));
}

// Interpret only known error categories. Provider text is inspected in memory,
// never returned, logged, or copied into an AppError/cause.
function providerFailureReason(result, httpStatus) {
  if ([401, 403].includes(httpStatus)) return 'authentication';
  if (httpStatus === 402) return 'credit';
  if (httpStatus === 429) return 'rate_limit';
  const fields = [result?.code, result?.error_code, result?.error?.code, result?.status];
  const codes = fields.filter(value => typeof value === 'string' && value.length <= 100)
    .map(value => value.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  for (const [set, reason] of [[CREDIT_CODES, 'credit'], [SENDER_CODES, 'sender'], [RECIPIENT_CODES, 'recipient'],
    [RATE_CODES, 'rate_limit'], [AUTH_CODES, 'authentication']]) {
    if (codes.some(code => set.has(code))) return reason;
  }
  const text = [result?.message, result?.error, result?.error?.message, result?.description]
    .filter(value => typeof value === 'string').map(value => value.slice(0, 2000).toLowerCase()).join(' ');
  if (/\b(?:insufficient|not enough|no available)\s+(?:sms\s+)?(?:balance|credits?|funds)\b|\b(?:balance|credits?)\s+(?:is\s+)?(?:insufficient|exhausted|empty|too low)\b/.test(text)) return 'credit';
  if (/\bsender(?:[ _-]?id)?\b.{0,60}\b(?:invalid|unapproved|not approved|required|not registered|rejected)\b|\b(?:invalid|unapproved)\s+sender\b/.test(text)) return 'sender';
  if (/\b(?:phone(?: number)?|recipient|msisdn|country|network)\b.{0,60}\b(?:invalid|unsupported|not supported|rejected)\b|\b(?:invalid|unsupported)\s+(?:phone|recipient|msisdn|country|network)\b/.test(text)) return 'recipient';
  if (/\brate\s*limit(?:ed| exceeded)?\b|\btoo many requests\b/.test(text)) return 'rate_limit';
  if (/\b(?:api[ _-]?key|credentials?|authentication|authorization|authorisation)\b.{0,60}\b(?:invalid|missing|expired|revoked|incorrect|required|failed|denied)\b|\b(?:invalid|missing|expired|revoked|incorrect)\s+(?:api[ _-]?key|credentials?)\b/.test(text)) return 'authentication';
  return 'rejected';
}

export function createSmsService({ configuration = env.sms, fetchImpl = (...args) => fetch(...args), log = logger } = {}) {
  function failure(reason, operation, httpStatus) {
    const [message, status, code] = failures[reason] || failures.rejected;
    // Fixed categories only: no number, key, OTP, provider message or request
    // body enters diagnostics. The error has no raw transport/provider cause.
    const details = { provider: 'yoola', operation, reason,
      ...(Number.isInteger(httpStatus) ? { httpStatus } : {}) };
    log.warn({ ...details, errorCode: code }, 'SMS provider request failed');
    return new AppError(message, status, code, details);
  }

  function assertYoolaConfigured() {
    if (configuration.mode !== 'yoola' || !configuration.yoolaApiKey) {
      throw new AppError('Yoola SMS delivery is not configured.', 503, 'SMS_NOT_CONFIGURED');
    }
    if (configuration.yoolaSenderId && !/^[A-Za-z0-9]{1,11}$/.test(configuration.yoolaSenderId)) {
      throw new AppError('The configured Yoola sender must use 1–11 letters or numbers.', 503, 'SMS_SENDER_NOT_CONFIGURED');
    }
  }

  async function readProviderResponse(response) {
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new Error('PROVIDER_RESPONSE_LIMIT');
    }
    if (!response.body) throw new Error('PROVIDER_RESPONSE_MISSING');
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
          throw new Error('PROVIDER_RESPONSE_LIMIT');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const result = JSON.parse(new TextDecoder().decode(bytes));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('PROVIDER_RESPONSE_INVALID');
    return result;
  }

  // Official examples: https://yoolasms.com/api-integration. JSON api_key is
  // present in every published code sample. Fixed HTTPS destinations prevent
  // credential forwarding; no send is retried after ambiguous acceptance.
  async function yoolaRequest(operation, body = {}) {
    assertYoolaConfigured();
    if (!['send', 'balance', 'delivery_report'].includes(operation)) throw failure('rejected', 'unknown');
    let httpStatus;
    try {
      const response = await fetchImpl(`https://yoolasms.com/api/v1/${operation}`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: configuration.yoolaApiKey, ...body }),
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
      });
      httpStatus = response.status;
      let result;
      try { result = await readProviderResponse(response); }
      catch (error) {
        // Known HTTP failures remain actionable even if the provider sends HTML.
        const reason = providerFailureReason(null, httpStatus);
        if (!response.ok && reason !== 'rejected') throw failure(reason, operation, httpStatus);
        throw error;
      }
      const rejection = providerFailureReason(result, httpStatus);
      const data = result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data : null;
      const dataRejection = providerFailureReason(data, httpStatus);
      if (!response.ok || hasExplicitRejection(result) || hasExplicitRejection(data) ||
          rejection !== 'rejected' || dataRejection !== 'rejected' || !ACCEPTED_SEND_STATUSES.has(providerStatus(result))) {
        throw failure(rejection !== 'rejected' ? rejection : dataRejection, operation, httpStatus);
      }
      return result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      const code = error?.cause?.code || error?.code;
      const reason = ['TimeoutError', 'AbortError'].includes(error?.name) || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)
        ? 'timeout' : ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(code)
          ? 'network' : error instanceof SyntaxError || /^PROVIDER_RESPONSE_/.test(error?.message || '') ? 'malformed' : 'rejected';
      throw failure(reason, operation, httpStatus);
    }
  }

  async function sendCode({ phone, name, code }, message) {
    if (typeof phone !== 'string' || phone !== phone.trim() || !/^\+[1-9]\d{7,14}$/.test(phone) ||
        typeof code !== 'string' || code !== code.trim() || !/^\d{6}$/.test(code)) {
      throw new AppError('Invalid verification recipient or code.', 400, 'SMS_INVALID_REQUEST');
    }
    if (configuration.mode === 'log') return { delivered: false, developmentCode: code };
    const result = await yoolaRequest('send', { phone: phone.slice(1), message,
      ...(configuration.yoolaSenderId ? { sender: configuration.yoolaSenderId } : {}) });
    // Acceptance is the explicit positive acknowledgement of this /send call.
    // A tracking ID is optional receipt metadata, not proof of phone ownership.
    // Requiring one invalidated usable OTPs when Yoola acknowledged the send
    // without returning a string identifier. Never invent a replacement ID.
    const receipt = result.message_id;
    const providerId = typeof receipt === 'number' && Number.isSafeInteger(receipt) && receipt >= 0
      ? String(receipt) : receipt;
    if (providerId !== undefined && providerId !== null && (typeof providerId !== 'string' ||
        !providerId.trim() || providerId.length > 200 || /[\u0000-\u001f\u007f]/.test(providerId))) {
      throw failure('malformed', 'send', 200);
    }
    // API acceptance is not a handset delivery receipt or successful MFA.
    // Only a bounded receipt reference enters the acknowledgement log. Never
    // copy a key, recipient, OTP, free-form provider text or response body.
    const privateValues = [configuration.yoolaApiKey, phone, phone.slice(1), code].filter(Boolean);
    const reference = typeof providerId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(providerId) &&
      !privateValues.some(value => providerId.includes(value)) ? providerId : undefined;
    log.info?.({ provider: 'yoola', operation: 'send', providerStatus: 'accepted', deliveryStatus: 'unconfirmed',
      receiptAvailable: providerId != null, ...(reference ? { providerMessageId: reference } : {}) },
    'SMS request accepted by provider; handset delivery is not confirmed');
    return { delivered: false, accepted: true,
      ...(providerId == null ? {} : { providerId }), recipient: phone, name };
  }

  return Object.freeze({
    sendPhoneVerificationCode(input) {
      return sendCode(input, `Classic Mart verification code: ${input.code}. It expires in 10 minutes. Do not share this code.`);
    },
    sendMfaVerificationCode(input) {
      const expires = input.expiresInMinutes ?? 5;
      if (!Number.isInteger(expires) || expires < 1 || expires > 10) {
        return Promise.reject(new AppError('Invalid security-code expiry.', 400, 'SMS_INVALID_REQUEST'));
      }
      return sendCode(input, `Classic Mart sign-in/security code: ${input.code}. It expires in ${expires} minutes. Do not share this code.`);
    },
    async verifySmsConfiguration() {
      const result = await yoolaRequest('balance');
      if (!['success', 'ok'].includes(providerStatus(result))) throw failure('rejected', 'balance', 200);
      // The public reference does not establish a balance value/unit schema.
      return { authenticated: true, creditAvailable: null };
    },
    async getSmsDeliveryReport(messageId, { inspect = false } = {}) {
      if (typeof messageId !== 'string' || messageId !== messageId.trim() || !messageId ||
          messageId.length > 200 || /[\u0000-\u001f\u007f]/.test(messageId)) {
        throw new AppError('Provide one valid Yoola message reference.', 400, 'SMS_INVALID_RECEIPT');
      }
      // The owner's reference uses this separate read-only endpoint. A positive
      // API status is not a delivery status. Unknown fields remain unknown.
      const result = await yoolaRequest('delivery_report', { message_id: messageId });
      const states = [result.delivery_status, result.delivery, result.message_status]
        .filter(value => value != null).map(value => {
          const status = typeof value === 'string' ? value.trim().toLowerCase() : '';
          return status === 'delivered' ? 'delivered'
            : ['failed', 'undelivered', 'rejected'].includes(status) ? 'failed'
              : ['pending', 'queued', 'sent', 'processing'].includes(status) ? 'pending' : 'unknown';
        });
      // Generic success and conflicting fields do not establish delivery.
      const state = states.length && states.every(value => value === states[0]) ? states[0] : 'unknown';
      return { state, delivered: state === 'delivered',
        ...(inspect === true ? { reportShape: deliveryReportShape(result, configuration.yoolaApiKey) } : {}) };
    },
  });
}

const sms = createSmsService();
export const sendPhoneVerificationCode = input => sms.sendPhoneVerificationCode(input);
export const sendMfaVerificationCode = input => sms.sendMfaVerificationCode(input);
export const verifySmsConfiguration = () => sms.verifySmsConfiguration();
export const getSmsDeliveryReport = (messageId, options) => sms.getSmsDeliveryReport(messageId, options);

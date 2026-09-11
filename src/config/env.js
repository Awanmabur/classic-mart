import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { projectMongoUri } from '../core/project-env.js';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

function integer(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolean(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}


function privateIp(value) {
  if (net.isIP(value) === 4) {
    const parts = value.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
  }
  if (net.isIP(value) === 6) return value === '::1' || /^f[cd]/i.test(value);
  return false;
}

function csv(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function secret(name, fallback) {
  const configured = process.env[name];
  if (
    process.env.NODE_ENV === 'production' &&
    (!configured || configured.length < 32)
  ) {
    throw new Error(
      `${name} must be explicitly set to at least 32 characters in production.`,
    );
  }
  return configured || fallback;
}

function validEncryptionKey(value) {
  if (/^[a-f0-9]{64}$/i.test(value || '')) return true;
  try {
    return Boolean(value) && Buffer.from(value, 'base64').length === 32;
  } catch {
    return false;
  }
}

const nodeEnv = process.env.NODE_ENV || 'development';
const mediaStorageDriver = String(process.env.MEDIA_STORAGE_DRIVER || (nodeEnv === 'production' ? '' : 'filesystem')).trim().toLowerCase();
const storagePersistence = String(process.env.STORAGE_PERSISTENCE || '').trim().toLowerCase();
const persistentStorageRoot = String(process.env.PERSISTENT_STORAGE_ROOT || '').trim();
const resolvedPersistentStorageRoot = persistentStorageRoot ? path.resolve(persistentStorageRoot) : '';
if (nodeEnv === 'production') {
  for (const required of ['MONGO_URI', 'DATA_ENCRYPTION_KEY', 'SECURITY_INTEGRITY_KEY']) {
    if (!process.env[required]) {
      throw new Error(`${required} must be explicitly set in production.`);
    }
  }
  if (process.env.MAIL_MODE !== 'smtp' || !process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASSWORD || !process.env.SMTP_FROM) {
    throw new Error(
      'Production requires SMTP_HOST, SMTP_USER, SMTP_PASSWORD and SMTP_FROM with MAIL_MODE=smtp.',
    );
  }
  if (process.env.SMS_MODE !== 'twilio' || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_FROM) {
    throw new Error('Production requires SMS_MODE=twilio with TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM for phone verification.');
  }
  if (!['clamd', 'clamscan'].includes(process.env.MALWARE_SCAN_MODE || '')) {
    throw new Error('Production requires MALWARE_SCAN_MODE=clamd or clamscan for untrusted uploads.');
  }
  if (process.env.SESSION_SECRET === process.env.TOKEN_PEPPER) {
    throw new Error('SESSION_SECRET and TOKEN_PEPPER must be different.');
  }
  if (!validEncryptionKey(process.env.DATA_ENCRYPTION_KEY)) {
    throw new Error(
      'DATA_ENCRYPTION_KEY must be 32 random bytes encoded as hex or base64.',
    );
  }
  if (
    process.env.DATA_ENCRYPTION_KEY === process.env.SESSION_SECRET ||
    process.env.DATA_ENCRYPTION_KEY === process.env.TOKEN_PEPPER
  ) {
    throw new Error(
      'DATA_ENCRYPTION_KEY must be independent from session and token secrets.',
    );
  }
  if (!String(process.env.BASE_URL || '').startsWith('https://')) {
    throw new Error('Production requires an HTTPS BASE_URL.');
  }
  if (integer(process.env.TRUST_PROXY, 0) < 1) {
    throw new Error('Production requires TRUST_PROXY to match the trusted reverse-proxy topology.');
  }
  if (process.env.SECURITY_INTEGRITY_KEY === process.env.SESSION_SECRET || process.env.SECURITY_INTEGRITY_KEY === process.env.TOKEN_PEPPER || process.env.SECURITY_INTEGRITY_KEY === process.env.DATA_ENCRYPTION_KEY) {
    throw new Error('SECURITY_INTEGRITY_KEY must be independent from all other application secrets.');
  }
  if (!boolean(process.env.PRIVILEGED_MFA_REQUIRED, true)) {
    throw new Error('Production requires PRIVILEGED_MFA_REQUIRED=true.');
  }
  if (!boolean(process.env.IDS_ENABLED, true) || !boolean(process.env.IPS_ENABLED, true)) {
    throw new Error('Production requires IDS_ENABLED=true and IPS_ENABLED=true.');
  }
  if (!['off','header'].includes(process.env.ORIGIN_GUARD_MODE || 'off')) {
    throw new Error('ORIGIN_GUARD_MODE must be off or header.');
  }
  if (!['http','udp'].includes(process.env.SIEM_MODE || '')) {
    throw new Error('Production requires SIEM_MODE=http or SIEM_MODE=udp.');
  }
  if ((process.env.SIEM_MODE || '') === 'http' && !String(process.env.SIEM_URL || '').startsWith('https://')) {
    throw new Error('Production HTTP SIEM export requires an HTTPS SIEM_URL.');
  }
  if ((process.env.SIEM_MODE || '') === 'udp' && !privateIp(String(process.env.SIEM_UDP_HOST || ''))) {
    throw new Error('Production UDP SIEM export is limited to an explicit private/loopback IP collector.');
  }
  if (!['json','cef'].includes(process.env.SIEM_FORMAT || 'json')) {
    throw new Error('SIEM_FORMAT must be json or cef.');
  }
  if ((process.env.ORIGIN_GUARD_MODE || 'off') === 'header' && String(process.env.ORIGIN_GUARD_SECRET || '').length < 32) {
    throw new Error('ORIGIN_GUARD_SECRET must be at least 32 characters when header mode is enabled.');
  }
  if (!csv(process.env.LAUNCH_COUNTRIES).length) {
    throw new Error('Production requires explicit LAUNCH_COUNTRIES.');
  }
  for (const required of ['DR_MAX_RPO_MINUTES','DR_MAX_RTO_MINUTES','DR_EVIDENCE_MAX_AGE_DAYS']) {
    if (integer(process.env[required], 0) <= 0) throw new Error(`Production requires explicit positive ${required}.`);
  }
  for (const required of ['PESAPAL_CONSUMER_KEY','PESAPAL_CONSUMER_SECRET']) {
    if (!process.env[required]) throw new Error(`${required} must be explicitly set in production.`);
  }
  if (!String(process.env.PESAPAL_BASE_URL || 'https://pay.pesapal.com/v3').startsWith('https://')) {
    throw new Error('Production Pesapal API base URL must use HTTPS.');
  }
  if (!process.env.REDIS_URL) {
    throw new Error('Production requires REDIS_URL for shared sessions, rate limits and worker coordination.');
  }
  if (boolean(process.env.PESAPAL_SANDBOX, true)) {
    throw new Error('Production requires PESAPAL_SANDBOX=false.');
  }
  if (String(process.env.PESAPAL_BASE_URL || '') !== 'https://pay.pesapal.com/v3') {
    throw new Error('Production requires the live Pesapal API 3.0 base URL https://pay.pesapal.com/v3.');
  }
  if (mediaStorageDriver !== 'r2') {
    throw new Error('Production requires MEDIA_STORAGE_DRIVER=r2 for uploaded media.');
  }
  for (const required of ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
    if (!String(process.env[required] || '').trim()) throw new Error(`Production requires ${required} for Cloudflare R2 media storage.`);
  }
  let r2Endpoint;
  try { r2Endpoint = new URL(process.env.R2_ENDPOINT); } catch { throw new Error('R2_ENDPOINT must be a valid HTTPS URL.'); }
  if (r2Endpoint.protocol !== 'https:' || !/\.r2\.cloudflarestorage\.com$/i.test(r2Endpoint.hostname)) {
    throw new Error('R2_ENDPOINT must use the Cloudflare R2 HTTPS S3 endpoint.');
  }
  if (storagePersistence !== 'mounted') {
    throw new Error('Production requires STORAGE_PERSISTENCE=mounted.');
  }
  if (!persistentStorageRoot || !path.isAbsolute(persistentStorageRoot)) {
    throw new Error('Production requires an absolute PERSISTENT_STORAGE_ROOT on durable mounted storage.');
  }
  if (resolvedPersistentStorageRoot === projectRoot || resolvedPersistentStorageRoot.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error('PERSISTENT_STORAGE_ROOT must be outside the application source tree in production.');
  }
}

function envStorageRoot() {
  if (nodeEnv === 'production') return resolvedPersistentStorageRoot;
  return path.resolve(projectRoot, 'storage');
}

export const env = Object.freeze({
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  port: integer(process.env.PORT, 3000),
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  buildSha: String(process.env.BUILD_SHA || process.env.RENDER_GIT_COMMIT || process.env.SOURCE_COMMIT || '').trim(),
  mongoUri: projectMongoUri(),
  redisUrl: process.env.REDIS_URL || '',
  sessionSecret: secret(
    'SESSION_SECRET',
    'development-only-session-secret-change-before-production',
  ),
  tokenPepper: secret(
    'TOKEN_PEPPER',
    'development-only-token-pepper-change-before-production',
  ),
  dataEncryptionKey:
    process.env.DATA_ENCRYPTION_KEY ||
    'development-only-sensitive-data-encryption-key',
  trustProxy: integer(process.env.TRUST_PROXY, 0),
  metricsToken: process.env.METRICS_TOKEN || '',
  disasterRecovery: Object.freeze({
    maxRpoMinutes: Math.max(1, integer(process.env.DR_MAX_RPO_MINUTES, 60)),
    maxRtoMinutes: Math.max(1, integer(process.env.DR_MAX_RTO_MINUTES, 240)),
    evidenceMaxAgeDays: Math.max(1, integer(process.env.DR_EVIDENCE_MAX_AGE_DAYS, 90)),
  }),
  storagePersistence,
  mediaStorageDriver,
  r2: Object.freeze({
    endpoint: String(process.env.R2_ENDPOINT || '').trim(),
    bucket: String(process.env.R2_BUCKET || '').trim(),
    accessKeyId: String(process.env.R2_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: String(process.env.R2_SECRET_ACCESS_KEY || '').trim(),
    region: String(process.env.R2_REGION || 'auto').trim() || 'auto',
    timeoutMs: Math.max(3000, integer(process.env.R2_TIMEOUT_MS, 10000)),
  }),
  persistentStorageRoot: envStorageRoot(),
  uploadDir: nodeEnv === 'production'
    ? path.join(resolvedPersistentStorageRoot, 'uploads')
    : path.resolve(projectRoot, process.env.UPLOAD_DIR || 'storage/uploads'),
  exportDir: nodeEnv === 'production'
    ? path.join(resolvedPersistentStorageRoot, 'exports')
    : path.resolve(projectRoot, 'storage/exports'),
  privacyExportDir: nodeEnv === 'production'
    ? path.join(resolvedPersistentStorageRoot, 'privacy')
    : path.resolve(projectRoot, 'storage/privacy'),
  mailMode: process.env.MAIL_MODE || 'log',
  malwareScanMode: process.env.MALWARE_SCAN_MODE || 'off',
  clamavPath: process.env.CLAMAV_PATH || 'clamscan',
  clamavHost: process.env.CLAMAV_HOST || '127.0.0.1',
  clamavPort: integer(process.env.CLAMAV_PORT, 3310),
  smtp: Object.freeze({
    host: process.env.SMTP_HOST || '',
    port: integer(process.env.SMTP_PORT, 587),
    secure: boolean(process.env.SMTP_SECURE),
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from:
      process.env.SMTP_FROM ||
      '',
  }),
  sms: Object.freeze({
    mode: process.env.SMS_MODE || 'log',
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    from: process.env.TWILIO_FROM || '',
  }),
  pesapal: Object.freeze({
    baseUrl: process.env.PESAPAL_BASE_URL || (boolean(process.env.PESAPAL_SANDBOX, true) ? 'https://cybqa.pesapal.com/pesapalv3' : 'https://pay.pesapal.com/v3'),
    consumerKey: process.env.PESAPAL_CONSUMER_KEY || '',
    consumerSecret: process.env.PESAPAL_CONSUMER_SECRET || '',
    notificationId: process.env.PESAPAL_IPN_ID || '',
    sandbox: boolean(process.env.PESAPAL_SANDBOX, true),
    timeoutMs: Math.max(3000, integer(process.env.PESAPAL_TIMEOUT_MS, 10000)),
  }),
  stage11: Object.freeze({
    pushGatewayUrl: process.env.PUSH_GATEWAY_URL || '',
    pushGatewaySecret: process.env.PUSH_GATEWAY_SECRET || '',
    androidPackage: process.env.ANDROID_APP_PACKAGE || '',
    androidSha256CertFingerprint: process.env.ANDROID_SHA256_CERT_FINGERPRINT || '',
    appleAppId: process.env.APPLE_APP_ID || '',
  }),
  ai: Object.freeze({
    provider: process.env.AI_PROVIDER || 'disabled',
    apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '',
    baseUrl: process.env.AI_BASE_URL || 'https://api.openai.com',
    chatModel: process.env.AI_CHAT_MODEL || '',
    embeddingModel: process.env.AI_EMBEDDING_MODEL || '',
    moderationModel: process.env.AI_MODERATION_MODEL || 'omni-moderation-latest',
    timeoutMs: integer(process.env.AI_TIMEOUT_MS, 12000),
    maxContextChars: integer(process.env.AI_MAX_CONTEXT_CHARS, 24000),
    dailyBudgetMicros: integer(process.env.AI_DAILY_BUDGET_MICROS, 5_000_000),
    perUserDailyRequests: integer(process.env.AI_USER_DAILY_REQUESTS, 80),
    workerBatch: integer(process.env.AI_WORKER_BATCH, 5),
  }),
  security: Object.freeze({
    idsEnabled: boolean(process.env.IDS_ENABLED, true),
    ipsEnabled: boolean(process.env.IPS_ENABLED, true),
    privilegedMfaRequired: boolean(process.env.PRIVILEGED_MFA_REQUIRED, nodeEnv === 'production'),
    integrityKey: secret('SECURITY_INTEGRITY_KEY', 'development-only-security-integrity-key-change-before-production'),
    eventRetentionDays: Math.max(30, integer(process.env.SECURITY_EVENT_RETENTION_DAYS, 180)),
    highEventRetentionDays: Math.max(180, integer(process.env.SECURITY_HIGH_EVENT_RETENTION_DAYS, 730)),
    launchCountries: Object.freeze(csv(process.env.LAUNCH_COUNTRIES).map((item) => item.toUpperCase())),
    originGuard: Object.freeze({
      mode: process.env.ORIGIN_GUARD_MODE || 'off',
      header: String(process.env.ORIGIN_GUARD_HEADER || 'x-classic-origin').toLowerCase(),
      secret: process.env.ORIGIN_GUARD_SECRET || '',
    }),
    siem: Object.freeze({
      mode: process.env.SIEM_MODE || 'off',
      format: process.env.SIEM_FORMAT || 'json',
      url: process.env.SIEM_URL || '',
      token: process.env.SIEM_TOKEN || '',
      udpHost: process.env.SIEM_UDP_HOST || '127.0.0.1',
      udpPort: integer(process.env.SIEM_UDP_PORT, 514),
      timeoutMs: integer(process.env.SIEM_TIMEOUT_MS, 5000),
    }),
  }),
  admin: Object.freeze({
    name: process.env.ADMIN_NAME || 'Classic Mart Super Admin',
    email: process.env.ADMIN_EMAIL || '',
    phone: process.env.ADMIN_PHONE || '',
    password: process.env.ADMIN_PASSWORD || '',
  }),
  adminReviewer: Object.freeze({
    name: process.env.ADMIN_REVIEWER_NAME || 'Classic Mart Approval Reviewer',
    email: process.env.ADMIN_REVIEWER_EMAIL || '',
    phone: process.env.ADMIN_REVIEWER_PHONE || '',
    password: process.env.ADMIN_REVIEWER_PASSWORD || '',
  }),
});

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { env } from '../config/env.js';
import { awsUriEncode, signAwsV4Request } from '../core/aws-sigv4.js';
import { AppError } from '../core/errors.js';

class MediaObjectNotFoundError extends Error {
  constructor() {
    super('Media object not found.');
    this.name = 'MediaObjectNotFoundError';
    this.code = 'MEDIA_OBJECT_NOT_FOUND';
  }
}

export function normalizeMediaStorageKey(value) {
  const key = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const segments = key.split('/');
  if (
    !key ||
    key.length > 500 ||
    segments.some((segment) => !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/.test(segment))
  ) {
    throw new Error('Invalid media storage key.');
  }
  return segments.join('/');
}

function filesystemPath(key) {
  const safeKey = normalizeMediaStorageKey(key);
  const base = path.resolve(env.uploadDir);
  const target = path.resolve(base, safeKey);
  if (!target.startsWith(`${base}${path.sep}`)) throw new Error('Invalid media storage path.');
  return target;
}

function r2ObjectUrl(key, configuration) {
  const endpoint = new URL(configuration.endpoint);
  const basePath = endpoint.pathname.replace(/\/$/, '');
  const objectPath = [configuration.bucket, ...normalizeMediaStorageKey(key).split('/')]
    .map(awsUriEncode)
    .join('/');
  endpoint.pathname = `${basePath}/${objectPath}`.replace(/\/+/g, '/');
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint;
}

const transientNetworkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
const transientHttpStatuses = new Set([408, 429, 500, 502, 503, 504]);

function storageFailure(message, code, retryable = false) {
  const error = new AppError(message, 503, code);
  error.retryable = retryable;
  return error;
}

/** Keep transport deadlines and startup retries independently testable. */
export function createR2Storage({ configuration = env.r2, fetchImpl = (...args) => fetch(...args), wait = delay } = {}) {
  async function r2Request(method, key, { body = Buffer.alloc(0), contentType = '', cacheControl = '',
    signal, timeoutMs = configuration.timeoutMs } = {}) {
    signal?.throwIfAborted();
    const url = r2ObjectUrl(key, configuration);
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
    const signed = signAwsV4Request({
      method,
      url: url.toString(),
      body: payload,
      accessKeyId: configuration.accessKeyId,
      secretAccessKey: configuration.secretAccessKey,
      region: configuration.region,
      service: 's3',
    });
    const headers = { ...signed };
    if (contentType) headers['content-type'] = contentType;
    if (cacheControl) headers['cache-control'] = cacheControl;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal.reason);
    let rejectAborted;
    const aborted = new Promise((_resolve, reject) => { rejectAborted = () => reject(controller.signal.reason); });
    controller.signal.addEventListener('abort', rejectAborted, { once: true });
    signal?.addEventListener('abort', forwardAbort, { once: true });
    if (signal?.aborted) forwardAbort();
    const timeout = setTimeout(() => controller.abort(storageFailure(
      `Cloudflare R2 ${method} timed out after ${timeoutMs} ms. Check the connection to R2 and try again.`,
      'MEDIA_STORAGE_TIMEOUT', true)), timeoutMs);
    timeout.unref?.();
    try {
      return await Promise.race([aborted, (async () => {
        const response = await fetchImpl(url, {
          method,
          headers,
          body: ['GET', 'HEAD', 'DELETE'].includes(method) ? undefined : payload,
          signal: controller.signal,
          redirect: 'error',
          cache: 'no-store',
        });
        try {
          // A transport must not start reading a response which arrived after
          // its caller already timed out or cancelled the operation.
          controller.signal.throwIfAborted();
          if (response.status === 404) throw new MediaObjectNotFoundError();
          if (!response.ok) {
            // Never include provider XML, signed headers or credentials in errors.
            throw storageFailure(`Cloudflare R2 ${method} failed with HTTP ${response.status}.`,
              [401, 403].includes(response.status) ? 'MEDIA_STORAGE_ACCESS_DENIED' : 'MEDIA_STORAGE_HTTP_ERROR',
              transientHttpStatuses.has(response.status));
          }
          // Keep the deadline through all bytes, including PUT/DELETE replies.
          const bytes = Buffer.from(await response.arrayBuffer());
          return { body: bytes, contentType: response.headers.get('content-type') || 'application/octet-stream',
            etag: response.headers.get('etag') || '' };
        } finally {
          // This also runs for a late response after Promise.race has settled.
          if (response.body && !response.bodyUsed) void response.body.cancel().catch(() => {});
        }
      })()]);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof AppError || isMediaObjectNotFound(error)) throw error;
      throw storageFailure(`Cloudflare R2 ${method} connection failed. Check the R2 endpoint and network connection.`,
        'MEDIA_STORAGE_UNAVAILABLE', transientNetworkCodes.has(error?.cause?.code || error?.code));
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', forwardAbort);
      controller.signal.removeEventListener('abort', rejectAborted);
    }
  }

  async function retryProbe(work, signal) {
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      try { return await work(); }
      catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (!error.retryable || attempt >= 3) throw error;
        try { await wait(attempt * 200, undefined, { signal }); }
        catch (error) { if (signal?.aborted) throw signal.reason; throw error; }
      }
    }
  }

  const put = (key, body, options = {}) => r2Request('PUT', key, { ...options, body });
  const read = (key, options = {}) => r2Request('GET', key, options);
  async function remove(key, options = {}) {
    try { await r2Request('DELETE', key, options); }
    catch (error) { if (!isMediaObjectNotFound(error)) throw error; }
  }

  async function ready({ signal } = {}) {
    signal?.throwIfAborted();
    const key = `system/health-${process.pid}-${crypto.randomUUID()}.txt`;
    const probe = Buffer.from('classic-mart-r2-ready\n');
    let failure;
    try {
      // Only the private, uniquely named readiness object is retried. Uploads and
      // other application mutations never gain automatic replay behavior.
      await retryProbe(() => put(key, probe, { contentType: 'text/plain', cacheControl: 'private, no-store', signal }), signal);
      const roundTrip = await retryProbe(() => read(key, { signal }), signal);
      if (!crypto.timingSafeEqual(sha256Buffer(roundTrip.body), sha256Buffer(probe))) {
        throw storageFailure('R2 readiness probe checksum mismatch.', 'MEDIA_STORAGE_INTEGRITY_FAILED');
      }
    } catch (error) { failure = error; }
    const cancelledBeforeCleanup = signal?.aborted;
    try {
      if (cancelledBeforeCleanup) await remove(key, { timeoutMs: Math.min(configuration.timeoutMs, 2_000) });
      else await retryProbe(() => remove(key, { signal }), signal);
    } catch (error) {
      if (!failure) failure = error;
      // Cancellation can happen during cleanup too. Try once independently so a
      // normal Ctrl+C does not retain a health object or wait for a full retry run.
      if (signal?.aborted && !cancelledBeforeCleanup) await remove(key, { timeoutMs: Math.min(configuration.timeoutMs, 2_000) }).catch(() => {});
    }
    signal?.throwIfAborted();
    if (failure) throw failure;
  }

  return Object.freeze({ put, read, remove, ready });
}

const r2 = createR2Storage();

export function isMediaObjectNotFound(error) {
  return error?.code === 'MEDIA_OBJECT_NOT_FOUND';
}

export async function putMediaObject(key, body, { contentType = 'application/octet-stream', cacheControl = 'private, no-store' } = {}) {
  const safeKey = normalizeMediaStorageKey(key);
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (env.mediaStorageDriver === 'r2') {
    await r2.put(safeKey, payload, { contentType, cacheControl });
    return safeKey;
  }
  const target = filesystemPath(safeKey);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
  await fs.writeFile(target, payload, { mode: 0o640, flag: 'wx' });
  return safeKey;
}

export async function readMediaObject(key) {
  const safeKey = normalizeMediaStorageKey(key);
  if (env.mediaStorageDriver === 'r2') {
    return r2.read(safeKey);
  }
  try {
    return { body: await fs.readFile(filesystemPath(safeKey)), contentType: 'application/octet-stream', etag: '' };
  } catch (error) {
    if (error?.code === 'ENOENT') throw new MediaObjectNotFoundError();
    throw error;
  }
}

export async function readMediaObjectBuffer(key) {
  return (await readMediaObject(key)).body;
}

export async function deleteMediaObject(key) {
  const safeKey = normalizeMediaStorageKey(key);
  if (env.mediaStorageDriver === 'r2') {
    await r2.remove(safeKey);
    return;
  }
  await fs.rm(filesystemPath(safeKey), { force: true });
}

export async function ensureMediaStorageReady({ signal } = {}) {
  signal?.throwIfAborted();
  if (env.mediaStorageDriver !== 'r2') {
    await fs.mkdir(env.uploadDir, { recursive: true });
    signal?.throwIfAborted();
    return;
  }
  await r2.ready({ signal });
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest();
}

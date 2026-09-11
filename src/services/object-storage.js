import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { awsUriEncode, signAwsV4Request } from '../core/aws-sigv4.js';

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

function r2ObjectUrl(key) {
  const endpoint = new URL(env.r2.endpoint);
  const basePath = endpoint.pathname.replace(/\/$/, '');
  const objectPath = [env.r2.bucket, ...normalizeMediaStorageKey(key).split('/')]
    .map(awsUriEncode)
    .join('/');
  endpoint.pathname = `${basePath}/${objectPath}`.replace(/\/+/g, '/');
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint;
}

async function r2Request(method, key, { body = Buffer.alloc(0), contentType = '', cacheControl = '' } = {}) {
  const url = r2ObjectUrl(key);
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  const signed = signAwsV4Request({
    method,
    url: url.toString(),
    body: payload,
    accessKeyId: env.r2.accessKeyId,
    secretAccessKey: env.r2.secretAccessKey,
    region: env.r2.region,
    service: 's3',
  });
  const headers = { ...signed };
  if (contentType) headers['content-type'] = contentType;
  if (cacheControl) headers['cache-control'] = cacheControl;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.r2.timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: ['GET', 'HEAD', 'DELETE'].includes(method) ? undefined : payload,
      signal: controller.signal,
    });
    if (response.status === 404) throw new MediaObjectNotFoundError(key);
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      throw new Error(`R2 ${method} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

export function isMediaObjectNotFound(error) {
  return error?.code === 'MEDIA_OBJECT_NOT_FOUND';
}

export async function putMediaObject(key, body, { contentType = 'application/octet-stream', cacheControl = 'private, no-store' } = {}) {
  const safeKey = normalizeMediaStorageKey(key);
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (env.mediaStorageDriver === 'r2') {
    await r2Request('PUT', safeKey, { body: payload, contentType, cacheControl });
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
    const response = await r2Request('GET', safeKey);
    return {
      body: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') || 'application/octet-stream',
      etag: response.headers.get('etag') || '',
    };
  }
  try {
    return { body: await fs.readFile(filesystemPath(safeKey)), contentType: 'application/octet-stream', etag: '' };
  } catch (error) {
    if (error?.code === 'ENOENT') throw new MediaObjectNotFoundError(safeKey);
    throw error;
  }
}

export async function readMediaObjectBuffer(key) {
  return (await readMediaObject(key)).body;
}

export async function deleteMediaObject(key) {
  const safeKey = normalizeMediaStorageKey(key);
  if (env.mediaStorageDriver === 'r2') {
    await r2Request('DELETE', safeKey).catch((error) => {
      if (!isMediaObjectNotFound(error)) throw error;
    });
    return;
  }
  await fs.rm(filesystemPath(safeKey), { force: true });
}

export async function ensureMediaStorageReady() {
  if (env.mediaStorageDriver !== 'r2') {
    await fs.mkdir(env.uploadDir, { recursive: true });
    return;
  }
  const key = `system/health-${process.pid}-${crypto.randomUUID()}.txt`;
  const probe = Buffer.from('classic-mart-r2-ready\n');
  try {
    await putMediaObject(key, probe, { contentType: 'text/plain', cacheControl: 'private, no-store' });
    const roundTrip = await readMediaObjectBuffer(key);
    if (!crypto.timingSafeEqual(sha256Buffer(roundTrip), sha256Buffer(probe))) {
      throw new Error('R2 readiness probe checksum mismatch.');
    }
  } finally {
    await deleteMediaObject(key).catch(() => {});
  }
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest();
}

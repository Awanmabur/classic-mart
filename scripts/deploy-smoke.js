import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const bounded = (value, fallback, min, max) => Math.max(min, Math.min(max, Number(value) || fallback));

export function readSmokeConfig(environment = process.env) {
  if (!environment.DEPLOY_BASE_URL) throw new Error('DEPLOY_BASE_URL is required.');
  const url = new URL(environment.DEPLOY_BASE_URL);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && environment.DEPLOY_SMOKE_ALLOW_HTTP === 'true')) {
    throw new Error('Deployment smoke requires HTTPS; explicit DEPLOY_SMOKE_ALLOW_HTTP=true permits HTTP tests.');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('DEPLOY_BASE_URL must be an origin without credentials, path, query or fragment.');
  }
  const expectedSha = String(environment.EXPECTED_BUILD_SHA || '').trim().toLowerCase();
  if (!FULL_SHA.test(expectedSha)) throw new Error('EXPECTED_BUILD_SHA must be a full 40- or 64-character hexadecimal commit SHA.');
  const expectedVersion = String(environment.EXPECTED_VERSION || pkg.version).trim();
  if (!expectedVersion) throw new Error('EXPECTED_VERSION must not be empty.');
  return {
    baseUrl: url.origin,
    expectedSha,
    expectedVersion,
    timeoutMs: bounded(environment.DEPLOY_SMOKE_TIMEOUT_MS, 15 * 60_000, 30_000, 30 * 60_000),
    pollMs: bounded(environment.DEPLOY_SMOKE_POLL_MS, 10_000, 2_000, 60_000),
    requestTimeoutMs: bounded(environment.DEPLOY_SMOKE_REQUEST_TIMEOUT_MS, 10_000, 500, 30_000),
    maxBodyBytes: bounded(environment.DEPLOY_SMOKE_MAX_BODY_BYTES, 512 * 1024, 1_024, 2 * 1024 * 1024),
  };
}

async function requestText(config, pathname, { fetchImpl, json = false }) {
  const controller = new AbortController();
  const limit = json ? Math.min(config.maxBodyBytes, 32 * 1024) : config.maxBodyBytes;
  let reader;
  let timer;
  let response;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`GET ${pathname} timed out after ${config.requestTimeoutMs} ms`));
    }, config.requestTimeoutMs);
  });
  const operation = (async () => {
    response = await fetchImpl(`${config.baseUrl}${pathname}`, {
      headers: { 'user-agent': 'Classic-Mart-Deploy-Smoke/2.13', accept: json ? 'application/json' : 'text/html' },
      signal: controller.signal, redirect: 'manual', cache: 'no-store',
    });
    if (response.status !== 200) {
      throw new Error(`GET ${pathname} returned HTTP ${response.status}${response.status >= 300 && response.status < 400 ? '; redirects are not allowed' : '; expected 200'}`);
    }
    const type = response.headers.get('content-type') || '';
    const expectedType = json ? /^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i : /^text\/html(?:\s*;|$)/i;
    if (!expectedType.test(type)) throw new Error(`GET ${pathname} has invalid content type; expected ${json ? 'JSON' : 'HTML'}`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > limit) throw new Error(`GET ${pathname} body exceeds ${limit} byte limit`);
    if (!response.body) throw new Error(`GET ${pathname} returned an empty body`);
    reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limit) throw new Error(`GET ${pathname} body exceeds ${limit} byte limit`);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  })();
  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    controller.abort();
    if (reader) reader.cancel().catch(() => {});
    else if (response?.body) response.body.cancel().catch(() => {});
    if (error?.name === 'AbortError') throw new Error(`GET ${pathname} timed out after ${config.requestTimeoutMs} ms`);
    if (String(error?.message || '').startsWith(`GET ${pathname} `)) throw error;
    throw new Error(`GET ${pathname} failed: ${error?.message || 'network error'}`);
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(config, pathname, options) {
  const text = await requestText(config, pathname, { ...options, json: true });
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`GET ${pathname} returned invalid JSON`); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`GET ${pathname} returned an invalid JSON object`);
  return body;
}

export async function probeDeployment(config, { fetchImpl = globalThis.fetch } = {}) {
  const [ready, version] = await Promise.all([
    requestJson(config, '/health/ready', { fetchImpl }),
    requestJson(config, '/health/version', { fetchImpl }),
  ]);
  if (ready.status !== 'ready') throw new Error('GET /health/ready did not report ready');
  for (const dependency of ['mongo', 'redis', 'worker']) {
    if (ready.checks?.[dependency] !== true) throw new Error(`GET /health/ready ${dependency} check is not healthy`);
  }
  if (version.status !== 'ok') throw new Error('GET /health/version did not report ok');
  if (String(version.version || '') !== config.expectedVersion) {
    throw new Error(`version mismatch ${version.version || 'missing'} != ${config.expectedVersion}`);
  }
  const actualSha = String(version.buildSha || '').trim().toLowerCase();
  if (!FULL_SHA.test(actualSha) || actualSha !== config.expectedSha) {
    throw new Error(`build SHA mismatch ${actualSha || 'missing'} != ${config.expectedSha}`);
  }
  const live = await requestJson(config, '/health/live', { fetchImpl });
  if (live.status !== 'ok') throw new Error('GET /health/live did not report ok');
  const products = await requestText(config, '/products', { fetchImpl });
  if (!/<html\b/i.test(products) || !/<main\b[^>]*\sid\s*=["']catalogMain["']/i.test(products)
    || !/<div\b[^>]*\sid\s*=["']catalogProductGrid["']/i.test(products)
    || !/<body\b[^>]*\sdata-page-mode\s*=["']products["']/i.test(products)) {
    throw new Error('GET /products is missing the expected catalogue HTML markers');
  }
  return { ok: true, version: version.version, buildSha: actualSha, checks: ready.checks };
}

export async function runDeploySmoke(config, {
  fetchImpl = globalThis.fetch,
  log = console.log,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
} = {}) {
  const started = now();
  let last = 'not checked';
  while (now() - started < config.timeoutMs) {
    try {
      const remaining = config.timeoutMs - (now() - started);
      const result = await probeDeployment({ ...config, requestTimeoutMs: Math.max(1, Math.min(config.requestTimeoutMs, Math.floor(remaining / 4))) }, { fetchImpl });
      const report = {
        status: 'pass', baseUrl: config.baseUrl, expectedVersion: config.expectedVersion,
        expectedBuildSha: config.expectedSha, actualBuildSha: result.buildSha,
        checks: result.checks, elapsedMs: now() - started,
      };
      log(JSON.stringify(report, null, 2));
      return report;
    } catch (error) {
      last = error?.message || 'deployment probe failed';
    }
    log(`Deployment not ready yet: ${last}`);
    const remaining = config.timeoutMs - (now() - started);
    if (remaining > 0) await sleep(Math.min(config.pollMs, remaining));
  }
  throw new Error(`Deployment smoke timed out after ${config.timeoutMs} ms: ${last}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runDeploySmoke(readSmokeConfig()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

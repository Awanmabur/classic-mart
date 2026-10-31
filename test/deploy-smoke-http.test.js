import test from 'node:test';
import assert from 'node:assert/strict';
import {
  probeDeployment, readSmokeConfig, runDeploySmoke,
} from '../scripts/deploy-smoke.js';

const baseUrl = 'https://deployment.example.test';
const expectedSha = '0123456789abcdef0123456789abcdef01234567';
const expectedVersion = '2.13.74';
const checks = { mongo: true, redis: true, worker: true };
const catalogueHtml = '<!doctype html><html><body data-page-mode="products"><main id="catalogMain"><div id="catalogProductGrid"></div></main></body></html>';
const encoder = new TextEncoder();

function config(overrides = {}) {
  return {
    baseUrl, expectedSha, expectedVersion,
    requestTimeoutMs: 1_000,
    timeoutMs: 1_000,
    pollMs: 10,
    maxBodyBytes: 512 * 1024,
    ...overrides,
  };
}

function environment(overrides = {}) {
  return {
    DEPLOY_BASE_URL: baseUrl,
    EXPECTED_BUILD_SHA: expectedSha,
    EXPECTED_VERSION: expectedVersion,
    ...overrides,
  };
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function htmlResponse(body = catalogueHtml, { status = 200, headers = {} } = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

function deploymentFetch(overrides = {}) {
  const calls = [];
  const routes = {
    '/health/ready': () => jsonResponse({ status: 'ready', checks }),
    '/health/version': () => jsonResponse({ status: 'ok', version: expectedVersion, buildSha: expectedSha }),
    '/health/live': () => jsonResponse({ status: 'ok' }),
    '/products': () => htmlResponse(),
    ...overrides,
  };
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url, options });
    assert.equal(url.origin, baseUrl);
    assert.equal(options.method || 'GET', 'GET');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    const route = routes[url.pathname];
    assert.equal(typeof route, 'function', `Unexpected deployment request: ${url.pathname}`);
    return route(options, url);
  };
  return { calls, fetchImpl };
}

test('deployment smoke configuration uses full normalized SHA and bounded defaults', () => {
  const result = readSmokeConfig(environment({
    DEPLOY_BASE_URL: `${baseUrl}/`,
    EXPECTED_BUILD_SHA: expectedSha.toUpperCase(),
  }));
  assert.equal(result.baseUrl, baseUrl);
  assert.equal(result.expectedSha, expectedSha);
  assert.equal(result.expectedVersion, expectedVersion);
  assert.equal(result.timeoutMs, 15 * 60_000);
  assert.equal(result.pollMs, 10_000);
  assert.equal(result.requestTimeoutMs, 10_000);
  assert.equal(result.maxBodyBytes, 512 * 1024);
  const sha256 = 'ABCDEF0123456789'.repeat(4);
  assert.equal(readSmokeConfig(environment({ EXPECTED_BUILD_SHA: sha256 })).expectedSha, sha256.toLowerCase());
});

test('deployment smoke configuration rejects non-origin destinations and implicit HTTP', () => {
  for (const input of [
    '', 'not a URL', 'http://deployment.example.test',
    'https://user:password@deployment.example.test',
    `${baseUrl}/products`, `${baseUrl}?next=/products`, `${baseUrl}#products`,
  ]) {
    assert.throws(() => readSmokeConfig(environment({ DEPLOY_BASE_URL: input })), Error, input);
  }
  const allowed = readSmokeConfig(environment({
    DEPLOY_BASE_URL: 'http://deployment.example.test',
    DEPLOY_SMOKE_ALLOW_HTTP: 'true',
  }));
  assert.equal(allowed.baseUrl, 'http://deployment.example.test');
  assert.throws(() => readSmokeConfig(environment({
    DEPLOY_BASE_URL: 'ftp://deployment.example.test',
    DEPLOY_SMOKE_ALLOW_HTTP: 'true',
  })), Error);
});

test('deployment smoke configuration rejects abbreviated and malformed commit identities', () => {
  for (const sha of ['', expectedSha.slice(0, 12), expectedSha.slice(0, 39), `${expectedSha}0`, 'g'.repeat(40), 'a'.repeat(63), 'a'.repeat(65)]) {
    assert.throws(() => readSmokeConfig(environment({ EXPECTED_BUILD_SHA: sha })), /SHA|commit|hex/i, sha);
  }
});

test('deployment smoke accepts healthy exact build identity and the products catalogue', async () => {
  const { fetchImpl, calls } = deploymentFetch();
  const result = await probeDeployment(config(), { fetchImpl });
  assert.deepEqual(result, { ok: true, version: expectedVersion, buildSha: expectedSha, checks });
  assert.deepEqual(calls.slice(0, 2).map(({ url }) => url.pathname).sort(), ['/health/ready', '/health/version']);
  assert.deepEqual(calls.slice(2).map(({ url }) => url.pathname), ['/health/live', '/products']);
});

test('deployment smoke rejects products redirects and error pages without following them', async (t) => {
  for (const status of [302, 403, 404]) {
    await t.test(`HTTP ${status}`, async () => {
      const { fetchImpl, calls } = deploymentFetch({
        '/products': () => htmlResponse(catalogueHtml, { status, headers: { location: '/login' } }),
      });
      await assert.rejects(probeDeployment(config(), { fetchImpl }), new RegExp(`products.*${status}|${status}.*products`, 'i'));
      assert.deepEqual(calls.filter(({ url }) => url.pathname === '/products').map(({ options }) => options.redirect), ['manual']);
      assert.equal(calls.some(({ url }) => url.pathname === '/login'), false);
    });
  }
});

test('deployment smoke rejects a products response without HTML content type', async () => {
  const { fetchImpl } = deploymentFetch({
    '/products': () => htmlResponse(catalogueHtml, { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(probeDeployment(config(), { fetchImpl }), /products.*(?:content.type|text\/html|HTML)|(?:content.type|text\/html|HTML).*products/i);
});

test('deployment smoke rejects generic and incomplete HTML instead of accepting any successful page', async (t) => {
  const invalidPages = [
    ['generic login page', '<html><body><form action="/login">Sign in</form></body></html>'],
    ['missing html document', '<main id="catalogMain" data-page-mode="products"><div id="catalogProductGrid"></div></main>'],
    ['missing catalogue main', catalogueHtml.replace('id="catalogMain"', 'id="otherMain"')],
    ['missing product grid', catalogueHtml.replace('id="catalogProductGrid"', 'id="otherGrid"')],
    ['wrong page mode', catalogueHtml.replace('data-page-mode="products"', 'data-page-mode="home"')],
    ['data-id is not the catalogue main ID', catalogueHtml.replace('id="catalogMain"', 'data-id="catalogMain"')],
    ['data-id is not the product grid ID', catalogueHtml.replace('id="catalogProductGrid"', 'data-id="catalogProductGrid"')],
    ['a prefixed data attribute is not the page mode', catalogueHtml.replace('data-page-mode="products"', 'data-data-page-mode="products"')],
  ];
  for (const [name, html] of invalidPages) {
    await t.test(name, async () => {
      const { fetchImpl } = deploymentFetch({ '/products': () => htmlResponse(html) });
      await assert.rejects(probeDeployment(config(), { fetchImpl }), /products|catalog|HTML/i);
    });
  }
});

test('deployment smoke rejects wrong version and missing, wrong, or abbreviated build SHA', async (t) => {
  const identities = [
    ['wrong version', { version: '0.0.0', buildSha: expectedSha }, /version.*mismatch|mismatch.*version/i],
    ['missing version', { buildSha: expectedSha }, /version|missing/i],
    ['wrong SHA', { version: expectedVersion, buildSha: 'f'.repeat(40) }, /SHA.*mismatch|mismatch.*SHA/i],
    ['missing SHA', { version: expectedVersion }, /SHA|build.*identity/i],
    ['abbreviated SHA', { version: expectedVersion, buildSha: expectedSha.slice(0, 12) }, /SHA|build.*identity/i],
    ['extended SHA', { version: expectedVersion, buildSha: `${expectedSha}${'a'.repeat(24)}` }, /SHA|build.*identity/i],
  ];
  for (const [name, identity, errorPattern] of identities) {
    await t.test(name, async () => {
      const { fetchImpl, calls } = deploymentFetch({
        '/health/version': () => jsonResponse({ status: 'ok', ...identity }),
      });
      await assert.rejects(probeDeployment(config(), { fetchImpl }), errorPattern);
      assert.equal(calls.some(({ url }) => url.pathname === '/products'), false);
    });
  }
});

test('deployment smoke requires every readiness dependency to be explicitly true', async (t) => {
  for (const dependency of ['mongo', 'redis', 'worker']) {
    for (const value of [false, undefined, 'true']) {
      await t.test(`${dependency}=${String(value)}`, async () => {
        const dependencyChecks = { ...checks, [dependency]: value };
        const { fetchImpl, calls } = deploymentFetch({
          '/health/ready': () => jsonResponse({ status: 'ready', checks: dependencyChecks }),
        });
        await assert.rejects(probeDeployment(config(), { fetchImpl }), /ready|readiness|mongo|redis|worker/i);
        assert.equal(calls.some(({ url }) => url.pathname === '/health/live' || url.pathname === '/products'), false);
      });
    }
  }
});

test('deployment smoke requires exact HTTP 200, JSON type, and status from each health endpoint', async (t) => {
  const endpoints = [
    ['/health/ready', { status: 'ready', checks }],
    ['/health/version', { status: 'ok', version: expectedVersion, buildSha: expectedSha }],
    ['/health/live', { status: 'ok' }],
  ];
  for (const [path, body] of endpoints) {
    for (const [name, response] of [
      ['HTTP 201', () => jsonResponse(body, { status: 201 })],
      ['wrong content type', () => jsonResponse(body, { headers: { 'content-type': 'text/html' } })],
      ['invalid JSON media subtype', () => jsonResponse(body, { headers: { 'content-type': 'application/json-invalid' } })],
      ['wrong health status', () => jsonResponse({ ...body, status: 'starting' })],
    ]) {
      await t.test(`${path}: ${name}`, async () => {
        const { fetchImpl } = deploymentFetch({ [path]: response });
        await assert.rejects(probeDeployment(config(), { fetchImpl }), /health|ready|version|live|JSON|content.type|status|201/i);
      });
    }
  }
});

test('deployment smoke reports malformed JSON from health endpoints', async (t) => {
  for (const path of ['/health/ready', '/health/version', '/health/live']) {
    await t.test(path, async () => {
      const { fetchImpl } = deploymentFetch({
        [path]: () => new Response('{"status":', { headers: { 'content-type': 'application/json' } }),
      });
      await assert.rejects(probeDeployment(config(), { fetchImpl }), /JSON|parse|invalid/i);
    });
  }
});

test('deployment smoke rejects an oversized declared response before accepting its body', async () => {
  const { fetchImpl } = deploymentFetch({
    '/products': () => htmlResponse(catalogueHtml, { headers: { 'content-length': '257' } }),
  });
  await assert.rejects(probeDeployment(config({ maxBodyBytes: 256 }), { fetchImpl }), /body|bytes|large|limit|size/i);
});

test('deployment smoke bounds streamed response bytes and cancels an oversized body', async () => {
  let chunksRead = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      chunksRead += 1;
      controller.enqueue(encoder.encode('é'.repeat(64)));
      if (chunksRead === 20) controller.close();
    },
    cancel() { cancelled = true; },
  });
  const { fetchImpl } = deploymentFetch({
    '/products': () => htmlResponse(stream),
  });
  await assert.rejects(probeDeployment(config({ maxBodyBytes: 256 }), { fetchImpl }), /body|bytes|large|limit|size/i);
  assert.equal(cancelled, true);
  assert.ok(chunksRead < 20, 'The oversized body must be stopped before the whole stream is consumed');
});

test('deployment smoke request timeout remains active while a response body stalls', { timeout: 1_000 }, async () => {
  let requestSignal;
  const { fetchImpl } = deploymentFetch({
    '/products': ({ signal }) => {
      requestSignal = signal;
      const stream = new ReadableStream({
        start(controller) {
          signal.addEventListener('abort', () => {
            controller.error(new DOMException('Response body was aborted', 'AbortError'));
          }, { once: true });
        },
      });
      return htmlResponse(stream);
    },
  });
  await assert.rejects(probeDeployment(config({ requestTimeoutMs: 20 }), { fetchImpl }), /timeout|timed out|abort/i);
  assert.equal(requestSignal.aborted, true);
});

test('deployment smoke polling preserves the final readiness failure with a fake clock', async () => {
  let clock = 0;
  const sleeps = [];
  const messages = [];
  const { fetchImpl } = deploymentFetch({
    '/health/ready': () => jsonResponse({ status: 'ready', checks: { ...checks, worker: false } }),
  });
  await assert.rejects(runDeploySmoke(config({ timeoutMs: 25, pollMs: 10 }), {
    fetchImpl,
    now: () => clock,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; },
    log: (message) => messages.push(message),
  }), /timed out.*worker/i);
  assert.ok(sleeps.length > 0);
  assert.ok(messages.length > 0);
});

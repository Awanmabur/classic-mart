import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

process.env.NODE_ENV = 'test';
const { createR2Storage, isMediaObjectNotFound } = await import('../src/services/object-storage.js');
const configuration = { endpoint: 'https://fixture.r2.cloudflarestorage.com', bucket: 'private-fixture',
  accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'fixture-secret-not-a-credential', region: 'auto', timeoutMs: 20 };

function fixture(t, intercept = async () => null, extra = {}) {
  const objects = new Map(), calls = [], waits = [], responses = [];
  // A fake stalled response has no operating-system socket to keep Node alive.
  // Hold only the test fixture open while exercising actual deadline timers.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const client = createR2Storage({ configuration, wait: async ms => { waits.push(ms); },
    fetchImpl: async (url, options) => {
      const call = { url: new URL(url), ...options };
      calls.push(call);
      const overridden = await intercept(call, { objects, calls });
      let response = overridden;
      if (!response) {
        const key = call.url.pathname;
        if (call.method === 'PUT') { objects.set(key, Buffer.from(call.body)); response = new Response(''); }
        else if (call.method === 'DELETE') { objects.delete(key); response = new Response(null, { status: 204 }); }
        else response = objects.has(key)
          ? new Response(objects.get(key), { headers: { 'content-type': 'text/plain', etag: 'fixture-etag' } })
          : new Response('SECRET_PROVIDER_BODY', { status: 404 });
      }
      responses.push(response);
      return response;
    }, ...extra });
  return { client, objects, calls, waits, responses };
}

function stalledBody(signal) {
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([1]));
    signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
  } }));
}

test('R2 readiness signs a private unique round trip, consumes replies and verifies deletion', async t => {
  const f = fixture(t);
  await f.client.ready();
  assert.deepEqual(f.calls.map(c => c.method), ['PUT', 'GET', 'DELETE']);
  assert.equal(new Set(f.calls.map(c => c.url.href)).size, 1);
  assert.match(f.calls[0].url.pathname, /^\/private-fixture\/system\/health-\d+-[a-f0-9-]+\.txt$/);
  for (const call of f.calls) {
    assert.equal(call.url.protocol, 'https:');
    assert.equal(call.redirect, 'error');
    assert.equal(call.cache, 'no-store');
    assert.match(call.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
  }
  assert.equal(f.calls[0].headers['cache-control'], 'private, no-store');
  assert.ok(f.responses.filter(r => r.body).every(r => r.bodyUsed));
  assert.equal(f.objects.size, 0);
});

test('startup retries a transient GET header timeout without replaying the successful PUT', async t => {
  let reads = 0;
  const f = fixture(t, async call => {
    if (call.method === 'GET' && ++reads === 1) return new Promise((_resolve, reject) => {
      call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true });
    });
  });
  await f.client.ready();
  assert.deepEqual(f.calls.map(c => c.method), ['PUT', 'GET', 'GET', 'DELETE']);
  assert.deepEqual(f.waits, [200]);
  assert.equal(f.objects.size, 0);
});

test('the deadline remains active through GET response bytes and a healthy retry can start', async t => {
  let reads = 0;
  const f = fixture(t, async call => call.method === 'GET' && ++reads === 1 ? stalledBody(call.signal) : null);
  await f.client.ready();
  assert.equal(reads, 2);
  assert.equal(f.calls.find(c => c.method === 'GET').signal.aborted, true);
  assert.equal(f.objects.size, 0);
});

test('permanent GET stalls exhaust three bounded attempts, clean up and return a typed timeout', async t => {
  const f = fixture(t, async call => call.method === 'GET' ? stalledBody(call.signal) : null);
  await assert.rejects(f.client.ready(), error => error.code === 'MEDIA_STORAGE_TIMEOUT'
    && error.status === 503 && /R2 GET timed out after 20 ms/.test(error.message));
  assert.equal(f.calls.filter(c => c.method === 'GET').length, 3);
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
  assert.equal(f.calls.at(-1).method, 'DELETE');
  assert.equal(f.objects.size, 0);
});

test('a deadline also bounds a fetch implementation that ignores the abort signal', async t => {
  const f = fixture(t, async call => call.method === 'GET' ? new Promise(() => {}) : null);
  await assert.rejects(f.client.read('products/image.webp'), { code: 'MEDIA_STORAGE_TIMEOUT' });
  assert.equal(f.calls.length, 1, 'ordinary media reads do not gain automatic retries');
});

test('late responses are cancelled without reading their body after the request deadline', async t => {
  let resolveFetch, cancelled = false;
  const f = fixture(t, async () => new Promise(resolve => { resolveFetch = resolve; }));
  await assert.rejects(f.client.read('products/late.webp'), { code: 'MEDIA_STORAGE_TIMEOUT' });
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  resolveFetch(response);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test('PUT replies also stay inside the body deadline without replaying application uploads', async t => {
  const f = fixture(t, async call => stalledBody(call.signal));
  await assert.rejects(f.client.put('products/image.webp', Buffer.from('image')), { code: 'MEDIA_STORAGE_TIMEOUT' });
  assert.equal(f.calls.length, 1);
});

test('a lost probe PUT response retries exactly the same private key and bytes', async t => {
  let puts = 0;
  const f = fixture(t, async (call, { objects }) => {
    if (call.method === 'PUT' && ++puts === 1) {
      objects.set(call.url.pathname, Buffer.from(call.body));
      throw new TypeError('SECRET_NETWORK_DETAIL', { cause: { code: 'ECONNRESET' } });
    }
  });
  await f.client.ready();
  assert.equal(puts, 2);
  assert.equal(f.calls[0].url.href, f.calls[1].url.href);
  assert.deepEqual(f.calls[0].body, f.calls[1].body);
  assert.equal(f.objects.size, 0);
});

test('ordinary upload failures are sanitized and are never automatically replayed', async t => {
  const f = fixture(t, async () => { throw new TypeError('SECRET_NETWORK_DETAIL', { cause: { code: 'ECONNRESET' } }); });
  await assert.rejects(f.client.put('products/image.webp', Buffer.from('image')), error =>
    error.code === 'MEDIA_STORAGE_UNAVAILABLE' && !error.message.includes('SECRET_NETWORK_DETAIL'));
  assert.equal(f.calls.length, 1);
});

test('temporary provider errors can recover, while permission errors fail immediately without provider XML', async t => {
  let reads = 0;
  const recover = fixture(t, async call => call.method === 'GET' && ++reads === 1
    ? new Response('SECRET_PROVIDER_BODY', { status: 503 }) : null);
  await recover.client.ready();
  assert.equal(reads, 2);
  const denied = fixture(t, async () => new Response('SECRET_PROVIDER_BODY', { status: 403 }));
  await assert.rejects(denied.client.ready(), error => error.code === 'MEDIA_STORAGE_ACCESS_DENIED'
    && !error.message.includes('SECRET_PROVIDER_BODY'));
  assert.deepEqual(denied.calls.map(c => c.method), ['PUT', 'DELETE']);
  assert.equal(denied.waits.length, 0);
});

test('delete permission is required; a successful PUT and GET cannot hide failed cleanup', async t => {
  const f = fixture(t, async call => call.method === 'DELETE' ? new Response('SECRET', { status: 403 }) : null);
  await assert.rejects(f.client.ready(), { code: 'MEDIA_STORAGE_ACCESS_DENIED' });
  assert.deepEqual(f.calls.map(c => c.method), ['PUT', 'GET', 'DELETE']);
});

test('temporary probe deletion failure is retried and completed before readiness succeeds', async t => {
  let deletes = 0;
  const f = fixture(t, async call => call.method === 'DELETE' && ++deletes === 1
    ? new Response('SECRET', { status: 503 }) : null);
  await f.client.ready();
  assert.equal(deletes, 2);
  assert.equal(f.objects.size, 0);
});

test('checksum failures clean up and missing objects retain their existing classification', async t => {
  const f = fixture(t, async call => call.method === 'GET' ? new Response('different bytes') : null);
  await assert.rejects(f.client.ready(), { code: 'MEDIA_STORAGE_INTEGRITY_FAILED' });
  assert.equal(f.objects.size, 0);
  const missing = fixture(t);
  await assert.rejects(missing.client.read('products/missing.webp'), isMediaObjectNotFound);
  await missing.client.remove('products/missing.webp');
});

test('shutdown cancellation stops a current GET, preserves its reason and independently removes the probe', async t => {
  const controller = new AbortController(), reason = new Error('Intentional test shutdown');
  const f = fixture(t, async call => {
    if (call.method === 'GET') {
      queueMicrotask(() => controller.abort(reason));
      return new Promise((_resolve, reject) => call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true }));
    }
  });
  await assert.rejects(f.client.ready({ signal: controller.signal }), error => error === reason);
  assert.deepEqual(f.calls.map(c => c.method), ['PUT', 'GET', 'DELETE']);
  assert.equal(f.calls.at(-1).signal.aborted, false);
  assert.equal(f.objects.size, 0);
});

test('shutdown during retry backoff does not issue another GET', async t => {
  const controller = new AbortController(), reason = new Error('Stop during retry');
  const f = fixture(t, async call => call.method === 'GET' ? new Response('', { status: 503 }) : null, {
    wait: async () => { controller.abort(reason); throw new DOMException('Aborted', 'AbortError'); },
  });
  await assert.rejects(f.client.ready({ signal: controller.signal }), error => error === reason);
  assert.deepEqual(f.calls.map(c => c.method), ['PUT', 'GET', 'DELETE']);
  assert.equal(f.objects.size, 0);
});

test('already cancelled startup never sends a request and redirects are refused', async t => {
  const controller = new AbortController(); controller.abort();
  const f = fixture(t);
  await assert.rejects(f.client.ready({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.calls.length, 0);
  const redirect = fixture(t, async () => new Response('SECRET', { status: 302, headers: { location: 'https://example.test/steal' } }));
  await assert.rejects(redirect.client.read('products/image.webp'), { code: 'MEDIA_STORAGE_HTTP_ERROR' });
  assert.equal(redirect.calls.length, 1);
  assert.equal(redirect.calls[0].redirect, 'error');
});

test('ordinary object bytes and metadata remain intact and simultaneous probes use separate keys', async t => {
  const f = fixture(t);
  await f.client.put('products/image.webp', Buffer.from('image'));
  assert.deepEqual(await f.client.read('products/image.webp'), { body: Buffer.from('image'), contentType: 'text/plain', etag: 'fixture-etag' });
  await f.client.remove('products/image.webp');
  await Promise.all([f.client.ready(), f.client.ready()]);
  const probes = f.calls.filter(c => c.method === 'PUT' && c.url.pathname.includes('/system/'));
  assert.equal(new Set(probes.map(c => c.url.href)).size, 2);
  assert.equal(f.objects.size, 0);
});

test('configured R2 timeouts are bounded to prevent timer overflow and excessive startup hangs', () => {
  for (const [value, expected] of [['0', 3000], ['10000', 10000], ['4294967296', 60000]]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      'const { env } = await import(process.argv[1]); console.log(env.r2.timeoutMs);',
      new URL('../src/config/env.js', import.meta.url).href],
    { env: { ...process.env, NODE_ENV: 'test', R2_TIMEOUT_MS: value }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Number(result.stdout.trim()), expected);
  }
});

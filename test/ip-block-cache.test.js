import test from 'node:test';
import assert from 'node:assert/strict';
import { createIpBlockCache } from '../src/core/ip-block-cache.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('a cold concurrent asset burst shares one security lookup per IP hash', async () => {
  const read = deferred();
  const keys = [];
  const cache = createIpBlockCache({ load: key => { keys.push(key); return read.promise; } });
  const requests = Array.from({ length: 64 }, () => cache.get('same-hash'));
  assert.deepEqual(keys, ['same-hash']);
  read.resolve(null);
  assert.deepEqual(await Promise.all(requests), Array(64).fill(null));
  await cache.get('same-hash');
  assert.equal(keys.length, 1);
  await cache.get('another-hash');
  assert.deepEqual(keys, ['same-hash', 'another-hash']);
});

test('a block applied during an older clear lookup is returned to every waiting request', async () => {
  const read = deferred();
  let calls = 0;
  const cache = createIpBlockCache({ load: () => { calls++; return read.promise; } });
  const requests = [cache.get('ip'), cache.get('ip')];
  const block = { publicId: 'blocked', expiresAt: new Date(Date.now() + 60_000) };
  cache.set('ip', block);
  read.resolve(null);
  assert.deepEqual(await Promise.all(requests), [block, block]);
  assert.equal(await cache.get('ip'), block);
  assert.equal(calls, 1, 'The stale clear result must not overwrite a newly applied block.');
});

test('revocation while a block lookup is pending forces a fresh result for all waiters', async () => {
  const read = deferred();
  let calls = 0;
  const cache = createIpBlockCache({ load: () => ++calls === 1 ? read.promise : null });
  const requests = [cache.get('ip'), cache.get('ip')];
  cache.invalidate('ip');
  read.resolve({ expiresAt: new Date(Date.now() + 60_000) });
  assert.deepEqual(await Promise.all(requests), [null, null]);
  assert.equal(calls, 2);
});

test('an invalidated lookup failure cannot override a newly installed block', async () => {
  const read = deferred();
  const cache = createIpBlockCache({ load: () => read.promise });
  const requests = [cache.get('ip'), cache.get('ip')];
  const block = { publicId: 'current-block', expiresAt: new Date(Date.now() + 60_000) };
  cache.set('ip', block);
  read.reject(new Error('Old read failed'));
  assert.deepEqual(await Promise.all(requests), [block, block]);
});

test('failed security lookups reject all waiters and can be retried without caching an allow result', async () => {
  const read = deferred();
  let calls = 0;
  const cache = createIpBlockCache({ load: () => ++calls === 1 ? read.promise : null });
  const first = cache.get('ip'), second = cache.get('ip');
  const failed = Promise.allSettled([first, second]);
  read.reject(new Error('Database unavailable'));
  const results = await failed;
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.message === 'Database unavailable'));
  assert.equal(await cache.get('ip'), null);
  assert.equal(calls, 2);
});

test('cached blocks expire at their actual expiry and clear entries keep the original bounded lifetime', async () => {
  let time = 1_000, calls = 0;
  const block = { expiresAt: new Date(1_050) };
  const cache = createIpBlockCache({ now: () => time, ttlMs: 100, load: () => ++calls === 1 ? block : null });
  assert.equal(await cache.get('ip'), block);
  time = 1_049;
  assert.equal(await cache.get('ip'), block);
  time = 1_050;
  assert.equal(await cache.get('ip'), null);
  time = 1_149;
  await cache.get('ip');
  assert.equal(calls, 2);
  time = 1_150;
  await cache.get('ip');
  assert.equal(calls, 3);
});

test('bounded cache eviction and saturated in-flight reads preserve invalidation', async () => {
  const reads = [], calls = [];
  const cache = createIpBlockCache({ limit: 1, load: key => {
    calls.push(key);
    const read = deferred(); reads.push(read); return read.promise;
  } });
  const first = cache.get('a'), overflow = cache.get('b');
  cache.invalidate('b');
  reads[1].resolve(null);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(calls, ['a', 'b', 'b']);
  reads[2].resolve(null);
  assert.equal(await overflow, null);
  reads[0].resolve(null);
  assert.equal(await first, null);
  const evicted = cache.get('b');
  assert.deepEqual(calls, ['a', 'b', 'b', 'b']);
  reads[3].resolve(null);
  assert.equal(await evicted, null);
});

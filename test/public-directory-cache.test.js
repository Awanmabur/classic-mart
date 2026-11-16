import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundedPublicDirectoryCache } from '../src/services/public-directory-cache.js';

test('simultaneous identical directory requests share a single DB read', async () => {
  const cache = createBoundedPublicDirectoryCache();
  let loads = 0;
  let resolve;
  const loading = new Promise(done => { resolve = done; });
  const loader = async () => { loads += 1; await loading; return { items: ['seller-1'] }; };
  const requests = [cache.get('UG:UGX:first', loader), cache.get('UG:UGX:first', loader)];
  resolve();
  const [one, two] = await Promise.all(requests);
  assert.equal(loads, 1);
  assert.strictEqual(one, two);
  assert.strictEqual(await cache.get('UG:UGX:first', loader), one);
  assert.equal(loads, 1);
});

test('TTL expiry refreshes the public directory without extending stale entries', async () => {
  let current = 1000, runs = 0;
  const cache = createBoundedPublicDirectoryCache({ ttlMs: 10_000, now: () => current });
  const loader = () => ({ generation: ++runs });
  assert.deepEqual(await cache.get('UG', loader), { generation: 1 });
  current += 9999;
  assert.deepEqual(await cache.get('UG', loader), { generation: 1 });
  current += 1;
  assert.deepEqual(await cache.get('UG', loader), { generation: 2 });
  assert.equal(runs, 2);
});

test('invalidation prevents older in-flight reads from being re-cached', async () => {
  const cache = createBoundedPublicDirectoryCache();
  let resolve;
  const older = cache.get('UG', () => new Promise(done => { resolve = done; }));
  await Promise.resolve();
  cache.clear();
  assert.deepEqual(await cache.get('UG', () => ({ version: 'fresh' })), { version: 'fresh' });
  resolve({ version: 'old' });
  assert.deepEqual(await older, { version: 'old' });
  assert.deepEqual(await cache.get('UG', () => ({ version: 'wrong' })), { version: 'fresh' });
});

test('rejected query is evicted so a transient database outage can recover', async () => {
  const cache = createBoundedPublicDirectoryCache();
  await assert.rejects(cache.get('UG', () => { throw new Error('database unavailable'); }), /database unavailable/);
  assert.deepEqual(await cache.get('UG', () => ({ ok: true })), { ok: true });
});

test('bounded cache evicts old keys without cross-market result leakage', async () => {
  const cache = createBoundedPublicDirectoryCache({ maxEntries: 2 });
  await cache.get('UG:UGX:1', () => ({ market: 'UG' }));
  await cache.get('KE:KES:1', () => ({ market: 'KE' }));
  await cache.get('TZ:TZS:1', () => ({ market: 'TZ' }));
  assert.deepEqual(await cache.get('KE:KES:1', () => ({ market: 'wrong' })), { market: 'KE' });
  assert.deepEqual(await cache.get('UG:UGX:1', () => ({ market: 'UG-reloaded' })), { market: 'UG-reloaded' });
  assert.deepEqual(await cache.get('TZ:TZS:1', () => ({ market: 'TZ-reloaded' })), { market: 'TZ-reloaded' });
});

test('invalid cache parameters fail instead of creating unbounded retention', () => {
  assert.throws(() => createBoundedPublicDirectoryCache({ maxEntries: 0 }), RangeError);
  assert.throws(() => createBoundedPublicDirectoryCache({ ttlMs: 0 }), RangeError);
});

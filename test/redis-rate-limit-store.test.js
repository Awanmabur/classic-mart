import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import request from 'supertest';
import { createClient } from 'redis';
import { RedisRateLimitStore } from '../src/core/redis-rate-limit-store.js';

test('shared limiter requires an explicit stable namespace and valid window', () => {
  assert.throws(() => new RedisRateLimitStore({ scope: '../auth' }), /scope/);
  const store = new RedisRateLimitStore({ scope: 'test:auth' });
  assert.throws(() => store.init({ windowMs: 0 }), /window/);
  assert.notEqual(store.key('client1'), store.key('client2'));
  assert.ok(!store.key('private-client-address').includes('private-client-address'));
});

test('shared limiter fails closed when its client is unavailable', async () => {
  for (const getClient of [async () => null, async () => ({ isReady: false }), async () => { throw new Error('Unavailable'); }]) {
    const store = new RedisRateLimitStore({ scope: 'test:offline', getClient });
    store.init({ windowMs: 1000 });
    await assert.rejects(store.increment('client'));
    await assert.rejects(store.decrement('client'));
    await assert.rejects(store.resetKey('client'));
  }
});

const uri = process.env.CLASSIC_MART_LIVE_TEST_REDIS_URL;
test('real Redis counters survive separate app instances, enforce atomic limits and expire', { skip: !uri }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  const client = createClient({ url: uri, socket: { reconnectStrategy: false } });
  await client.connect();
  const scope = `test:${crypto.randomBytes(12).toString('hex')}`;
  const makeStore = (suffix = 'auth') => new RedisRateLimitStore({ scope: `${scope}:${suffix}`, getClient: async () => client });
  const first = makeStore(), second = makeStore();
  const cleanup = new Set();
  try {
    await t.test('two independent application instances use one fixed window', async () => {
      const application = store => {
        const app = express();
        app.use(rateLimit({ windowMs: 60_000, limit: 2, store, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: () => 'same-actor' }));
        app.get('/', (_request, response) => response.send('ok'));
        return app;
      };
      const app1 = application(first), app2 = application(second);
      cleanup.add(first.key('same-actor'));
      await request(app1).get('/').expect(200);
      await request(app2).get('/').expect(200);
      await request(app1).get('/').expect(429);
      assert.equal(await client.get(first.key('same-actor')), '3');
      assert.ok(await client.pTTL(first.key('same-actor')) > 0);
    });
    await t.test('concurrent increments across instances are atomic and scopes stay separate', async () => {
      const stores = [makeStore('parallel'), makeStore('parallel')];
      stores.forEach(store => store.init({ windowMs: 60_000 }));
      cleanup.add(stores[0].key('actor'));
      const values = await Promise.all(Array.from({ length: 30 }, (_, index) => stores[index % 2].increment('actor')));
      assert.deepEqual(values.map(value => value.totalHits).sort((a, b) => a - b), Array.from({ length: 30 }, (_, index) => index + 1));
      assert.equal(await client.get(first.key('actor')), null);
      assert.ok(values.every(value => value.resetTime instanceof Date && value.resetTime > new Date()));
    });
    await t.test('decrement preserves TTL, never goes negative, and expiry resets the counter', async () => {
      const store = makeStore('expiry');
      store.init({ windowMs: 60_000 });
      const key = store.key('actor'); cleanup.add(key);
      await store.increment('actor');
      await store.decrement('actor'); await store.decrement('actor');
      assert.equal(await client.get(key), '0');
      assert.ok(await client.pTTL(key) > 0);
      await client.pExpire(key, 1);
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal((await store.increment('actor')).totalHits, 1);
      await store.resetKey('actor');
      assert.equal(await client.exists(key), 0);
    });
  } finally {
    for (const key of cleanup) await client.del(key);
    await client.quit();
  }
});

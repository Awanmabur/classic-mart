import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
const { createWorkerReadiness } = await import('../src/services/worker-readiness.js');
const SHA = 'a'.repeat(40);

test('production worker readiness requires the current build and a recent successful completed cycle', async () => {
  const checkedAt = Date.UTC(2026, 9, 14, 12);
  let calls = 0;
  const ready = createWorkerReadiness({
    required: true, buildSha: SHA, isMongoReady: () => true, now: () => checkedAt,
    lookup: async (filter, options) => {
      calls++;
      assert.deepEqual(filter, {
        role: 'maintenance', buildSha: SHA, status: 'running', lastCycleOk: true,
        lastHeartbeatAt: { $gte: new Date(checkedAt - 180_000), $lte: new Date(checkedAt + 5_000) },
        lastCycleCompletedAt: { $gte: new Date(checkedAt - 180_000), $lte: new Date(checkedAt + 5_000) },
        expiresAt: { $gt: new Date(checkedAt) },
      });
      assert.ok(options.signal instanceof AbortSignal);
      return { _id: 'healthy-current-worker' };
    },
  });
  assert.equal(await ready(), true);
  assert.equal(calls, 1);
});

test('disconnected MongoDB and unknown build identities never issue or buffer heartbeat queries', async () => {
  let calls = 0;
  const lookup = async () => { calls++; throw new Error('must not query'); };
  for (const options of [
    { isMongoReady: () => false, buildSha: SHA },
    { isMongoReady: () => true, buildSha: '' },
    { isMongoReady: () => true, buildSha: 'unknown' },
    { isMongoReady: () => true, buildSha: 'a'.repeat(12) },
  ]) assert.equal(await createWorkerReadiness({ required: true, lookup, ...options })(), false);
  assert.equal(calls, 0);
});

test('worker probes share one in-flight query and cache either result for at most two seconds', async () => {
  let clock = 10_000;
  let calls = 0;
  let resolveQuery;
  let connected = true;
  const ready = createWorkerReadiness({
    required: true, buildSha: SHA, isMongoReady: () => connected, now: () => clock,
    lookup: () => { calls++; return new Promise((resolve) => { resolveQuery = resolve; }); },
  });
  const requests = Array.from({ length: 20 }, () => ready());
  await Promise.resolve();
  assert.equal(calls, 1);
  resolveQuery({ _id: 'worker' });
  assert.deepEqual(await Promise.all(requests), Array(20).fill(true));
  clock += 1_999;
  assert.equal(await ready(), true);
  assert.equal(calls, 1);
  connected = false;
  assert.equal(await ready(), false, 'database disconnect immediately invalidates a healthy cached result');
  connected = true;
  const next = ready();
  await Promise.resolve();
  assert.equal(calls, 2);
  resolveQuery(null);
  assert.equal(await next, false);
  assert.equal(await ready(), false);
  assert.equal(calls, 2);
  clock += 2_001;
  const recovered = ready();
  await Promise.resolve();
  resolveQuery({ _id: 'recovered-worker' });
  assert.equal(await recovered, true);
  assert.equal(calls, 3);
});

test('query failures and hung heartbeat reads fail closed within the probe deadline', async () => {
  const options = { required: true, buildSha: SHA, isMongoReady: () => true, cacheMs: 0, timeoutMs: 15 };
  const failed = createWorkerReadiness({ ...options, lookup: async () => { throw new Error('private database details'); } });
  assert.equal(await failed(), false);
  let signal;
  const hung = createWorkerReadiness({ ...options, lookup: (_filter, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  assert.equal(await hung(), false);
  assert.equal(signal.aborted, true);
});

test('test and local fixtures can omit the worker and health readiness exposes boolean checks only', async () => {
  const ready = createWorkerReadiness({ required: false, isMongoReady: () => { throw new Error('not consulted'); } });
  assert.equal(await ready(), true);
  const { createApp } = await import('../src/app.js');
  const response = await request(createApp(null)).get('/health/ready').expect(503);
  assert.equal(response.body.status, 'not_ready');
  assert.deepEqual(Object.keys(response.body.checks).sort(), ['mongo', 'redis', 'worker']);
  for (const value of Object.values(response.body.checks)) assert.equal(typeof value, 'boolean');
  assert.equal(response.body.checks.worker, true);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(response.body).sort(), ['checks', 'status']);
});

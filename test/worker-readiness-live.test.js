import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
const { WorkerHeartbeat } = await import('../src/models/WorkerHeartbeat.js');
const { createWorkerReadiness } = await import('../src/services/worker-readiness.js');
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;

test('real MongoDB worker readiness rejects absent, failed, stale, expired and other-build heartbeats', { skip: !uri }, async () => {
  const target = new URL(uri);
  assert.equal(target.hostname, '127.0.0.1');
  assert.match(target.pathname, /verification|test/i);
  await mongoose.connect(uri);
  const buildSha = crypto.randomBytes(20).toString('hex');
  const workerId = `readiness-test:${buildSha}`;
  const checkedAt = Date.now();
  const baseline = {
    workerId, buildSha, role: 'maintenance', hostname: 'isolated-test-worker', pid: process.pid,
    status: 'running', startedAt: new Date(checkedAt - 60_000), lastHeartbeatAt: new Date(checkedAt),
    lastCycleStartedAt: new Date(checkedAt - 1_000), lastCycleCompletedAt: new Date(checkedAt),
    lastCycleOk: true, expiresAt: new Date(checkedAt + 180_000),
  };
  const ready = createWorkerReadiness({ required: true, buildSha, now: () => checkedAt, cacheMs: 0 });
  try {
    await WorkerHeartbeat.init();
    assert.equal(await ready(), false, 'no completed worker cycle is not ready');
    await WorkerHeartbeat.create(baseline);
    assert.equal(await ready(), true);
    for (const patch of [
      { lastCycleOk: false },
      { status: 'error' },
      { status: 'stopping' },
      { lastHeartbeatAt: new Date(checkedAt - 180_001) },
      { lastCycleCompletedAt: new Date(checkedAt - 180_001) },
      { lastCycleCompletedAt: null },
      { lastHeartbeatAt: new Date(checkedAt + 5_001) },
      { expiresAt: new Date(checkedAt - 1) },
      { buildSha: 'f'.repeat(40) },
    ]) {
      await WorkerHeartbeat.updateOne({ workerId }, { $set: { ...baseline, ...patch } }, { upsert: true });
      assert.equal(await ready(), false, `invalid heartbeat must not count as healthy: ${JSON.stringify(patch)}`);
    }
    await WorkerHeartbeat.updateOne({ workerId }, { $set: baseline }, { upsert: true });
    assert.equal(await ready(), true, 'a completed successful current-build cycle restores readiness');
  } finally {
    await WorkerHeartbeat.deleteOne({ workerId });
    await mongoose.disconnect();
  }
});

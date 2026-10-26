import os from 'node:os';
import { env } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { disconnectRedis, getRedisClient } from './config/redis.js';
import { logger } from './config/logger.js';
import { maintenanceFailures, safeError } from './core/logging.js';
import { ensureStorageReady } from './config/storage.js';
import { WorkerHeartbeat } from './models/WorkerHeartbeat.js';
import { runMaintenanceCycle } from './services/maintenance.js';

let shuttingDown = false;
let databaseConnected = false;
let timer = null;
let activeCycle = null;
let shutdownExitCode = 0;
let startupPromise;
let shutdownPromise;
const startupController = new AbortController();
const hostname = os.hostname();
const workerId = `maintenance:${process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || hostname}:${process.pid}`;
const startedAt = new Date();
const HEARTBEAT_TTL_MS = 3 * 60_000;
function expiresAt(ms = HEARTBEAT_TTL_MS) { return new Date(Date.now() + ms); }

async function heartbeat(patch = {}) {
  // Storage can fail before Mongo is connected. Buffering a heartbeat then
  // would create a new pending database operation during failed-start cleanup.
  if (!databaseConnected) return;
  try {
    const now = new Date();
    const state = shuttingDown ? { ...patch, status: 'stopping', expiresAt: expiresAt(30_000) } : patch;
    await WorkerHeartbeat.updateOne(
      { workerId },
      { $set: { role: 'maintenance', hostname, pid: process.pid, buildSha: env.buildSha, status: 'running', lastHeartbeatAt: now, expiresAt: expiresAt(), ...state }, $setOnInsert: { startedAt } },
      { upsert: true },
    );
  } catch (error) { logger.warn({ err: error, workerId }, 'Worker heartbeat write failed'); }
}

function cycle() {
  if (activeCycle || shuttingDown) return activeCycle;
  activeCycle = (async () => {
    const cycleStartedAt = new Date(), started = Date.now();
    await heartbeat({ lastCycleStartedAt: cycleStartedAt });
    if (shuttingDown) return;
    try {
      const result = await runMaintenanceCycle();
      const failures = maintenanceFailures(result);
      const lastCycleOk = Object.keys(failures).length === 0;
      await heartbeat({ status: lastCycleOk ? 'running' : 'error', lastCycleCompletedAt: new Date(), lastCycleDurationMs: Date.now() - started, lastCycleOk, lastError: lastCycleOk ? '' : JSON.stringify(failures).slice(0, 1000) });
      if (!lastCycleOk) logger.warn({ failures, durationMs: Date.now() - started }, 'Worker maintenance reported failures');
    } catch (error) {
      await heartbeat({ status: 'error', lastCycleCompletedAt: new Date(), lastCycleDurationMs: Date.now() - started, lastCycleOk: false, lastError: JSON.stringify(safeError(error)).slice(0, 1000) });
      logger.error({ err: error }, 'Worker maintenance cycle failed');
    }
  })().finally(() => { activeCycle = null; });
  return activeCycle;
}

async function start() {
  await ensureStorageReady({ signal: startupController.signal });
  if (shuttingDown) return;
  await connectDatabase();
  databaseConnected = true;
  if (shuttingDown) return;
  await getRedisClient();
  if (shuttingDown) return;
  await heartbeat();
  if (shuttingDown) return;
  await cycle();
  if (shuttingDown) return;
  timer = setInterval(cycle, 60_000);
  timer.unref();
  logger.info({ pid: process.pid, workerId }, 'Classic Mart worker ready');
}

function shutdown(signal, exitCode = 0) {
  shutdownExitCode = Math.max(shutdownExitCode, exitCode);
  process.exitCode = shutdownExitCode;
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  startupController.abort();
  if (timer) clearInterval(timer);
  logger.info({ signal, workerId, exitCode: shutdownExitCode }, 'Classic Mart worker shutting down');
  const forceTimer = setTimeout(() => {
    logger.error({ workerId }, 'Forced worker shutdown after timeout');
    process.exit(1);
  }, 10_000);
  forceTimer.unref();

  shutdownPromise = (async () => {
    // Withdraw readiness promptly, and prevent a finishing cycle from writing
    // "running" again while the rest of shutdown waits for it to settle.
    await heartbeat({ status: 'stopping', expiresAt: expiresAt(30_000) });
    await startupPromise;
    await activeCycle;
    await heartbeat({ status: 'stopping', expiresAt: expiresAt(30_000) });
    const results = await Promise.allSettled([
      Promise.resolve().then(disconnectRedis),
      Promise.resolve().then(disconnectDatabase),
    ]);
    databaseConnected = false;
    for (const result of results) if (result.status === 'rejected') {
      shutdownExitCode = 1;
      logger.error({ err: result.reason, workerId }, 'Worker shutdown cleanup failed');
    }
    // Natural exit allows aborted fetch/native close callbacks to finish. The
    // unref'd deadline still bounds any genuinely stuck handles or operations.
    process.exitCode = shutdownExitCode;
  })().catch(error => {
    shutdownExitCode = 1;
    process.exitCode = 1;
    logger.error({ err: error, workerId }, 'Worker shutdown failed');
  });
  return shutdownPromise;
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', error => { logger.fatal({ err: error }, 'Worker uncaught exception'); shutdown('uncaughtException', 1); });
process.on('unhandledRejection', error => { logger.fatal({ err: error }, 'Worker unhandled rejection'); shutdown('unhandledRejection', 1); });
startupPromise = start().catch(error => {
  if (shuttingDown && startupController.signal.aborted
    && (error === startupController.signal.reason || error?.name === 'AbortError')) return;
  logger.fatal({ err: error }, 'Worker startup failed');
  // shutdown waits for this promise; keep its error handler non-blocking.
  void shutdown('startupFailure', 1);
});

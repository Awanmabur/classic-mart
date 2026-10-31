import { isDatabaseReady } from '../config/db.js';
import { env } from '../config/env.js';
import { WorkerHeartbeat } from '../models/WorkerHeartbeat.js';

const MAX_AGE_MS = 3 * 60_000;
const QUERY_TIMEOUT_MS = 1_500;

async function findHeartbeat(filter, { signal }) {
  // The schema also disables buffering: a disconnect between the readiness
  // guard and this query must fail rather than queue an eventual health read.
  return WorkerHeartbeat.findOne(filter).select('_id').lean().setOptions({
    bufferCommands: false, maxTimeMS: 1_000, timeoutMS: QUERY_TIMEOUT_MS, signal,
  }).exec();
}

export function createWorkerReadiness({
  required = env.isProduction,
  buildSha = env.buildSha,
  isMongoReady = isDatabaseReady,
  lookup = findHeartbeat,
  now = Date.now,
  cacheMs = 2_000,
  timeoutMs = QUERY_TIMEOUT_MS,
} = {}) {
  let cached;
  let pending;
  return async function workerReady() {
    // Local development and existing isolated application fixtures do not run
    // a background worker. Production always requires one from this build.
    if (!required) return true;
    if (!isMongoReady() || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(String(buildSha || ''))) {
      cached = undefined;
      return false;
    }
    if (cached && cached.expiresAt > now()) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      const checkedAt = now();
      const earliest = new Date(checkedAt - MAX_AGE_MS);
      const latest = new Date(checkedAt + 5_000);
      const controller = new AbortController();
      let timer;
      try {
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => { controller.abort(); resolve(false); }, timeoutMs);
        });
        const found = Promise.resolve().then(() => lookup({
          role: 'maintenance',
          buildSha,
          status: 'running',
          lastCycleOk: true,
          lastHeartbeatAt: { $gte: earliest, $lte: latest },
          lastCycleCompletedAt: { $gte: earliest, $lte: latest },
          expiresAt: { $gt: new Date(checkedAt) },
        }, { signal: controller.signal })).then(Boolean, () => false);
        const value = await Promise.race([found, timeout]);
        cached = { value, expiresAt: now() + Math.min(2_000, Math.max(0, cacheMs)) };
        return value;
      } finally {
        clearTimeout(timer);
      }
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}

export const isWorkerReady = createWorkerReadiness();

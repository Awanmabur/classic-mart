import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = new URL('../', import.meta.url);

// Execute the real entrypoints in isolated processes. Only their external
// dependencies are replaced with ESM loader stubs; no production test hooks,
// providers, database, process.exit patch, or shortened shutdown deadline.
async function withEntrypoint(entrypoint, mode, run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'classicmart-startup-'));
  const records = [];
  let child, closed, stderr = '';
  try {
    const common = pathToFileURL(path.join(directory, 'common.mjs')).href;
    await fs.writeFile(new URL(common), `
      import { setTimeout as delay } from 'node:timers/promises';
      export const mode = ${JSON.stringify(mode)};
      export const record = (event, details = {}) => console.log(JSON.stringify({ event, ...details }));
      const releases = new Map();
      export const waitForRelease = stage => new Promise(resolve => releases.set(stage, resolve));
      process.on('message', message => {
        // Invoke the same registered signal handlers on Windows too, where
        // child.kill(SIGTERM) terminates without delivering a POSIX signal.
        if (message?.signal) process.emit(message.signal);
        if (message?.release) releases.get(message.release)?.();
      });
      process.channel?.unref();
      let databaseHandle;
      export async function storage({ signal } = {}) {
        record('storage-start', { cancellable: Boolean(signal) });
        if (mode === 'storage-failure') {
          setTimeout(() => record('native-close-drained'), 120);
          throw Object.assign(new Error('R2 readiness request aborted'), { name: 'AbortError' });
        }
        if (mode === 'signal-storage') {
          const handle = setInterval(() => {}, 1_000);
          await new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
            record('storage-aborted');
            clearInterval(handle);
            setTimeout(() => { record('storage-cancel-drained'); reject(signal.reason); }, 25);
          }, { once: true }));
        }
      }
      export async function connectDatabase() {
        record('database-start');
        databaseHandle = setInterval(() => {}, 1_000);
        if (mode === 'signal-database') await waitForRelease('database');
        record('database-connected');
      }
      export async function disconnectDatabase() {
        record('database-disconnect-start');
        if (mode === 'stuck-cleanup') return new Promise(() => {});
        if (mode === 'redis-failure') await waitForRelease('cleanup');
        await delay(15);
        clearInterval(databaseHandle);
        record('database-disconnected');
      }
      export async function getRedisClient() {
        record('redis-start');
        if (mode === 'redis-failure') throw new Error('Redis fixture failed to connect');
        return null;
      }
      export async function disconnectRedis() {
        record('redis-disconnect-start');
        await delay(10);
        record('redis-disconnected');
      }
      export async function maintenance() {
        record('maintenance-start');
        if (mode === 'signal-cycle') await waitForRelease('cycle');
        record('maintenance-completed');
        return {};
      }
      export function log(level, fields, message) {
        record('log', { level, message: typeof fields === 'string' ? fields : message,
          signal: typeof fields === 'object' ? fields.signal : undefined });
      }
    `);
    const replacements = {
      'src/config/env.js': `export const env = { port: 0, buildSha: 'isolated-lifecycle-fixture' };`,
      'src/config/storage.js': `export { storage as ensureStorageReady } from ${JSON.stringify(common)};`,
      'src/config/db.js': `export { connectDatabase, disconnectDatabase } from ${JSON.stringify(common)};`,
      'src/config/redis.js': `export { getRedisClient, disconnectRedis } from ${JSON.stringify(common)};`,
      'src/config/logger.js': `import { log } from ${JSON.stringify(common)};
        export const logger = Object.fromEntries(['info','warn','error','fatal'].map(level => [level, (...args) => log(level, ...args)]));`,
      'src/app.js': `import { record } from ${JSON.stringify(common)};
        export function createApp() { record('app-created'); return (_request, response) => response.end('fixture'); }`,
      'src/models/WorkerHeartbeat.js': `import { record } from ${JSON.stringify(common)};
        export const WorkerHeartbeat = { async updateOne(_filter, update) { record('heartbeat', { status: update.$set.status }); } };`,
      'src/services/maintenance.js': `export { maintenance as runMaintenanceCycle } from ${JSON.stringify(common)};`,
    };
    const mapping = {};
    for (const [relative, source] of Object.entries(replacements)) {
      const file = path.join(directory, relative.replaceAll('/', '_') + '.mjs');
      await fs.writeFile(file, source);
      mapping[new URL(relative, root).href] = pathToFileURL(file).href;
    }
    const preload = path.join(directory, 'preload.mjs');
    await fs.writeFile(preload, `
      import { registerHooks } from 'node:module';
      const mapping = ${JSON.stringify(mapping)};
      registerHooks({ resolve(specifier, context, nextResolve) {
        let resolved;
        try { resolved = new URL(specifier, context.parentURL).href; } catch { return nextResolve(specifier, context); }
        return mapping[resolved] ? { url: mapping[resolved], shortCircuit: true } : nextResolve(specifier, context);
      } });
      await import(${JSON.stringify(common)});
    `);
    child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, fileURLToPath(new URL(`src/${entrypoint}.js`, root))], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8_000); });
    readline.createInterface({ input: child.stdout }).on('line', line => {
      try { records.push(JSON.parse(line)); } catch { /* Not a fixture record. */ }
    });
    async function waitFor(predicate, timeout = 4_000) {
      const deadline = Date.now() + timeout;
      while (!records.some(predicate)) {
        assert.equal(child.exitCode, null, `Entrypoint exited before the expected lifecycle event: ${stderr}\n${JSON.stringify(records)}`);
        assert.ok(Date.now() < deadline, `Timed out waiting for lifecycle event: ${stderr}\n${JSON.stringify(records)}`);
        await delay(10);
      }
    }
    async function result(timeout = 4_000) {
      let timer;
      try {
        return await Promise.race([closed, new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Entrypoint did not exit: ${stderr}\n${JSON.stringify(records)}`)), timeout);
        })]);
      } finally { clearTimeout(timer); }
    }
    await run({ child, records, waitFor, result, diagnostics: () => stderr,
      signal: signal => child.send({ signal }), release: release => child.send({ release }) });
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (closed) await closed;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

for (const entrypoint of ['server', 'worker']) {
  test(`${entrypoint} storage startup failure cleans unopened clients and drains native close work before exiting nonzero`, { timeout: 10_000 }, async () => {
    await withEntrypoint(entrypoint, 'storage-failure', async ({ records, result, diagnostics }) => {
      assert.deepEqual(await result(), { code: 1, signal: null }, diagnostics());
      assert.ok(records.some(record => record.event === 'log' && record.level === 'fatal'));
      assert.ok(records.some(record => record.event === 'native-close-drained'), 'Abrupt process.exit must not truncate pending close work.');
      assert.equal(records.filter(record => record.event === 'database-disconnected').length, 1);
      assert.equal(records.filter(record => record.event === 'redis-disconnected').length, 1);
      assert.ok(!records.some(record => ['database-start', 'redis-start', 'app-created', 'heartbeat'].includes(record.event)));
      assert.ok(!records.some(record => record.message?.endsWith('ready')));
    });
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    test(`${entrypoint} ${signal} cancels pending storage and exits cleanly after its abort drains`, { timeout: 10_000 }, async () => {
      await withEntrypoint(entrypoint, 'signal-storage', async context => {
        await context.waitFor(record => record.event === 'storage-start' && record.cancellable);
        context.signal(signal);
        assert.deepEqual(await context.result(), { code: 0, signal: null }, context.diagnostics());
        assert.ok(context.records.some(record => record.event === 'storage-aborted'));
        assert.ok(context.records.some(record => record.event === 'storage-cancel-drained'));
        assert.ok(!context.records.some(record => ['database-start', 'redis-start', 'heartbeat'].includes(record.event)));
        assert.ok(!context.records.some(record => record.level === 'fatal'));
      });
    });
  }

  test(`${entrypoint} shutdown during database initialization waits for it before disconnecting and never advances startup`, { timeout: 10_000 }, async () => {
    await withEntrypoint(entrypoint, 'signal-database', async context => {
      await context.waitFor(record => record.event === 'database-start');
      context.signal('SIGTERM');
      await context.waitFor(record => record.signal === 'SIGTERM');
      context.release('database');
      assert.deepEqual(await context.result(), { code: 0, signal: null }, context.diagnostics());
      const events = context.records.map(record => record.event);
      assert.ok(events.indexOf('database-connected') < events.indexOf('database-disconnect-start'));
      assert.ok(!events.includes('redis-start'));
      assert.ok(!events.includes('app-created'));
      assert.ok(!context.records.some(record => record.message?.endsWith('ready')));
      assert.ok(context.records.filter(record => record.event === 'heartbeat').every(record => record.status === 'stopping'));
    });
  });

  test(`${entrypoint} partial startup failure disconnects already-connected clients and preserves failure after a later signal`, { timeout: 10_000 }, async () => {
    await withEntrypoint(entrypoint, 'redis-failure', async context => {
      await context.waitFor(record => record.level === 'fatal');
      context.signal('SIGTERM');
      context.release('cleanup');
      assert.deepEqual(await context.result(), { code: 1, signal: null }, context.diagnostics());
      assert.equal(context.records.filter(record => record.event === 'database-disconnected').length, 1);
      assert.equal(context.records.filter(record => record.event === 'redis-disconnected').length, 1);
      assert.ok(!context.records.some(record => record.message?.endsWith('ready')));
    });
  });

  test(`${entrypoint} ready-process shutdown closes connections and withdraws worker readiness without hard exit`, { timeout: 10_000 }, async () => {
    await withEntrypoint(entrypoint, 'ready', async context => {
      await context.waitFor(record => record.message?.endsWith('ready'));
      context.signal('SIGTERM');
      assert.deepEqual(await context.result(), { code: 0, signal: null }, context.diagnostics());
      assert.equal(context.records.filter(record => record.event === 'database-disconnected').length, 1);
      assert.equal(context.records.filter(record => record.event === 'redis-disconnected').length, 1);
      if (entrypoint === 'worker') assert.equal(context.records.filter(record => record.event === 'heartbeat').at(-1).status, 'stopping');
    });
  });

  test(`${entrypoint} bounds genuinely stuck cleanup with its real ten-second forced shutdown`, { timeout: 20_000 }, async () => {
    await withEntrypoint(entrypoint, 'stuck-cleanup', async context => {
      await context.waitFor(record => record.message?.endsWith('ready'));
      const started = Date.now();
      context.signal('SIGTERM');
      assert.deepEqual(await context.result(14_000), { code: 1, signal: null }, context.diagnostics());
      assert.ok(Date.now() - started >= 9_000, 'The real graceful shutdown window must be available.');
      assert.ok(context.records.some(record => /Forced.*shutdown after timeout/.test(record.message || '')));
    });
  });
}

test('worker shutdown withdraws readiness during an active cycle and never republishes running or starts another cycle', { timeout: 10_000 }, async () => {
  await withEntrypoint('worker', 'signal-cycle', async context => {
    await context.waitFor(record => record.event === 'maintenance-start');
    context.signal('SIGTERM');
    await context.waitFor(record => record.event === 'heartbeat' && record.status === 'stopping');
    context.release('cycle');
    assert.deepEqual(await context.result(), { code: 0, signal: null }, context.diagnostics());
    const firstStopping = context.records.findIndex(record => record.event === 'heartbeat' && record.status === 'stopping');
    assert.ok(context.records.slice(firstStopping).filter(record => record.event === 'heartbeat').every(record => record.status === 'stopping'));
    assert.equal(context.records.filter(record => record.event === 'maintenance-start').length, 1);
    assert.ok(context.records.some(record => record.event === 'maintenance-completed'));
    assert.ok(!context.records.some(record => record.message?.endsWith('ready')));
  });
});

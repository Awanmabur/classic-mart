import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const supervisorUrl = new URL('../scripts/run-production.js', import.meta.url).href;

async function withSupervisor(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'classicmart-supervisor-'));
  const records = [];
  let stderr = '';
  let child;
  let closed;
  try {
    const childSpecs = [];
    for (const name of ['stubborn', 'cooperative']) {
      const entrypoint = path.join(directory, `${name}.mjs`);
      await fs.writeFile(entrypoint, `
        const name = ${JSON.stringify(name)};
        function record(event) { console.log(JSON.stringify({ name, event, pid: process.pid })); }
        process.on('SIGTERM', () => { record('SIGTERM'); if (name === 'cooperative') process.exit(0); });
        process.on('SIGINT', () => { record('SIGINT'); if (name === 'cooperative') process.exit(0); });
        process.on('SIGUSR2', () => process.exit(7));
        process.on('SIGHUP', () => process.exit(0));
        setInterval(() => {}, 1_000);
        record('ready');
      `);
      childSpecs.push([name, entrypoint]);
    }
    const runner = `
      import { runProductionSupervisor } from ${JSON.stringify(supervisorUrl)};
      runProductionSupervisor({ childSpecs: ${JSON.stringify(childSpecs)}, shutdownTimeoutMs: 100 });
    `;
    child = spawn(process.execPath, ['--input-type=module', '-e', runner], {
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      // The inherited stdout pipe remains open if a descendant survives the
      // supervisor, so close verifies the children were actually stopped.
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    readline.createInterface({ input: child.stdout }).on('line', line => {
      try { records.push(JSON.parse(line)); } catch { /* No fixture record. */ }
    });
    const deadline = Date.now() + 3_000;
    while (records.filter(record => record.event === 'ready').length !== 2) {
      assert.equal(child.exitCode, null, `Supervisor exited before both children started: ${stderr}`);
      assert.ok(Date.now() < deadline, 'Timed out starting isolated supervisor children.');
      await delay(10);
    }
    const result = async () => {
      let timer;
      try {
        return await Promise.race([
          closed,
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Supervisor left a child alive after forced shutdown.')), 2_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    await run({ child, records, result, diagnostics: () => stderr });
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    for (const pid of new Set(records.map(record => record.pid))) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (closed) await closed;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('production shutdown force-stops a real child which ignores SIGTERM', async () => {
  await withSupervisor(async ({ child, records, result, diagnostics }) => {
    child.kill('SIGTERM');
    assert.deepEqual(await result(), { code: 0, signal: null }, diagnostics());
    assert.ok(records.some(record => record.name === 'stubborn' && record.event === 'SIGTERM'));
    assert.ok(records.some(record => record.name === 'cooperative' && record.event === 'SIGTERM'));
    assert.equal(diagnostics(), '');
  });
});

test('a real child failure preserves its exit status while force-stopping its sibling', async () => {
  await withSupervisor(async ({ records, result, diagnostics }) => {
    process.kill(records.find(record => record.name === 'cooperative' && record.event === 'ready').pid, 'SIGUSR2');
    assert.deepEqual(await result(), { code: 7, signal: null }, diagnostics());
    assert.ok(records.some(record => record.name === 'stubborn' && record.event === 'SIGTERM'));
    assert.match(diagnostics(), /cooperative exited unexpectedly \(code=7/);
  });
});

test('forced SIGINT shutdown keeps its conventional interrupt exit status', async () => {
  await withSupervisor(async ({ child, records, result, diagnostics }) => {
    child.kill('SIGINT');
    assert.deepEqual(await result(), { code: 130, signal: null }, diagnostics());
    assert.ok(records.some(record => record.name === 'stubborn' && record.event === 'SIGINT'));
    assert.equal(diagnostics(), '');
  });
});

test('an unexpected successful child exit still fails the production supervisor', async () => {
  await withSupervisor(async ({ records, result, diagnostics }) => {
    process.kill(records.find(record => record.name === 'cooperative' && record.event === 'ready').pid, 'SIGHUP');
    assert.deepEqual(await result(), { code: 1, signal: null }, diagnostics());
    assert.ok(records.some(record => record.name === 'stubborn' && record.event === 'SIGTERM'));
    assert.match(diagnostics(), /cooperative exited unexpectedly \(code=0/);
  });
});

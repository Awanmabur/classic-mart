import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { ciTestContainers, inspectCiTestServices, runWithCiTestServices } from '../scripts/ci-test-services.js';

test('CI service inspection checks only the owned containers with bounded commands', async () => {
  const calls = [];
  const healthy = await inspectCiTestServices(async (...args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ Running: true, Dead: false, OOMKilled: false, ExitCode: 0 }) };
  });
  assert.equal(healthy.healthy, true);
  assert.equal(healthy.reason, '');
  assert.deepEqual(calls.map(call => call[1].at(-1)), [...ciTestContainers]);
  for (const [command, args, options] of calls) {
    assert.equal(command, 'docker');
    assert.deepEqual(args.slice(0, 3), ['inspect', '--format', '{{json .State}}']);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 5000);
    assert.equal(options.maxBuffer, 16_384);
  }
});

test('dead, OOM-killed and uninspectable CI services fail closed without raw command output', async () => {
  const result = await inspectCiTestServices(async (_command, args) => {
    if (args.at(-1) === 'classic-mart-redis') throw new Error('PRIVATE_COMMAND_OUTPUT');
    return { stdout: JSON.stringify({ Running: false, OOMKilled: true, ExitCode: 137 }) };
  });
  assert.equal(result.healthy, false);
  assert.match(result.reason, /classic-mart-mongo.*exit 137, OOMKilled=true/);
  assert.match(result.reason, /classic-mart-redis could not be inspected/);
  assert.doesNotMatch(result.reason, /PRIVATE_COMMAND_OUTPUT/);
});

test('paused and restarting containers are unavailable even when Docker reports Running', async () => {
  for (const blockedState of [{ Paused: true }, { Restarting: true }, { Dead: true }]) {
    const result = await inspectCiTestServices(async () => ({
      stdout: JSON.stringify({ Running: true, OOMKilled: false, ExitCode: 0, ...blockedState }),
    }));
    assert.equal(result.healthy, false);
    assert.match(result.reason, /classic-mart-mongo is unavailable/);
  }
});

test('an unhealthy baseline saves bounded diagnostics and never launches tests', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'classicmart-ci-services-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let launched = false, annotation = '';
  const result = await runWithCiTestServices({
    cwd: directory,
    probe: async () => ({ healthy: false, reason: 'Owned MongoDB stopped.' }),
    spawnChild: () => { launched = true; throw new Error('Must not launch'); },
    collectDiagnostics: () => '50%\n::warning::not a command\u001b[31m',
    report: message => { annotation += message; },
  });
  assert.equal(result, 1);
  assert.equal(launched, false);
  assert.match(await fs.readFile(path.join(directory, 'artifacts', 'ci-services.txt'), 'utf8'), /Owned MongoDB stopped/);
  assert.match(annotation, /^::error title=CI test service failed::/);
  assert.match(annotation, /50%25%0A::warning::not a command/);
  assert.equal(annotation.split('\n').length, 2, 'Only the single escaped error command is emitted.');
});

test('healthy monitoring preserves actual child failure and removes timers and signal listeners', { timeout: 10_000 }, async () => {
  let probes = 0, diagnostics = 0;
  const signals = new EventEmitter();
  const result = await runWithCiTestServices({
    args: ['--eval', 'setTimeout(() => { process.exitCode = 7; }, 100)'],
    stdio: 'ignore', intervalMs: 10, signalTarget: signals,
    probe: async () => { probes++; return { healthy: true }; },
    collectDiagnostics: () => { diagnostics++; return ''; },
    report: () => assert.fail('A healthy service must not create a failure annotation.'),
  });
  assert.equal(result, 7);
  assert.ok(probes > 1);
  const afterCompletion = probes;
  await delay(40);
  assert.equal(probes, afterCompletion, 'The completed runner must stop polling.');
  assert.equal(diagnostics, 0);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('a mid-suite outage stops the actual test process group including a SIGTERM-resistant descendant', {
  skip: process.platform !== 'linux', timeout: 15_000,
}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'classicmart-ci-tree-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pidFile = path.join(directory, 'descendant.pid');
  const descendant = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const parent = `require('node:child_process').spawn(process.execPath, ['--eval', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`;
  const signals = new EventEmitter();
  let inspected = 0, saved = '', annotation = '';
  const result = await runWithCiTestServices({
    args: ['--eval', parent], stdio: 'ignore', intervalMs: 10, graceMs: 50, signalTarget: signals,
    probe: async () => {
      inspected++;
      try { await fs.access(pidFile); return { healthy: false, reason: 'classic-mart-mongo stopped (OOMKilled=true).' }; }
      catch { return { healthy: true }; }
    },
    collectDiagnostics: () => 'Owned container state and bounded log tail.\n',
    saveDiagnostics: async details => { saved = details; },
    report: message => { annotation += message; },
  });
  assert.equal(result, 1);
  assert.ok(inspected > 1);
  assert.match(saved, /OOMKilled=true/);
  assert.match(annotation, /CI test service failed/);
  const descendantPid = Number(await fs.readFile(pidFile, 'utf8'));
  // A killed orphan may briefly remain as a zombie until the container's PID 1
  // reaps it. It must have no running process or executable work remaining.
  const deadline = Date.now() + 1000;
  let terminated = false;
  do {
    try {
      const stat = await fs.readFile(`/proc/${descendantPid}/stat`, 'utf8');
      terminated = /^Z /.test(stat.slice(stat.lastIndexOf(')') + 2));
    } catch (error) { if (error.code !== 'ENOENT') throw error; terminated = true; }
    if (!terminated) await delay(10);
  } while (!terminated && Date.now() < deadline);
  assert.equal(terminated, true, 'The descendant must be terminated within the bounded cleanup deadline.');
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('an inspection exception mid-suite stops tests even when diagnostics cannot be collected or saved', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async () => {
  let calls = 0, annotation = '';
  const result = await runWithCiTestServices({
    args: ['--eval', 'setInterval(() => {}, 1000)'], stdio: 'ignore', intervalMs: 10, graceMs: 20,
    signalTarget: new EventEmitter(),
    probe: async () => { if (++calls > 1) throw new Error('PRIVATE_PROBE_ERROR'); return { healthy: true }; },
    collectDiagnostics: () => { throw new Error('PRIVATE_DIAGNOSTIC_ERROR'); },
    saveDiagnostics: async () => { throw new Error('PRIVATE_PATH'); },
    report: message => { annotation += message; },
  });
  assert.equal(result, 1);
  assert.match(annotation, /could not be inspected/);
  assert.match(annotation, /Diagnostic collection was unavailable/);
  assert.match(annotation, /Diagnostic artifact could not be written/);
  assert.doesNotMatch(annotation, /PRIVATE_/);
});

test('CI runner cancellation terminates its child and removes owned listeners', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async () => {
  const signals = new EventEmitter();
  const timer = setTimeout(() => signals.emit('SIGTERM'), 80);
  try {
    const result = await runWithCiTestServices({
      args: ['--eval', 'setInterval(() => {}, 1000)'], stdio: 'ignore', intervalMs: 10, graceMs: 20,
      probe: async () => ({ healthy: true }), signalTarget: signals,
      report: () => assert.fail('Cancellation must not be reported as a service failure.'),
    });
    assert.equal(result, 143);
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
  } finally { clearTimeout(timer); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectCiServiceDiagnostics, githubServiceFailureAnnotation } from '../scripts/ci-service-diagnostics.js';

test('service diagnostics inspect only the fixed disposable containers with bounded non-shell commands', () => {
  const calls = [];
  const report = collectCiServiceDiagnostics((command, args, options) => {
    calls.push({ command, args, options });
    return { status: 1, stdout: 'x'.repeat(6000), stderr: '\nservice unavailable' };
  });
  assert.deepEqual(calls.map(({ command, args }) => [command, ...args]), [
    ['docker', 'inspect', '--format', '{{json .State}}', 'classic-mart-mongo'],
    ['docker', 'logs', '--tail', '60', 'classic-mart-mongo'],
    ['docker', 'inspect', '--format', '{{json .State}}', 'classic-mart-redis'],
    ['docker', 'logs', '--tail', '60', 'classic-mart-redis'],
  ]);
  for (const { options } of calls) {
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 5000);
    assert.equal(options.maxBuffer, 16_384);
  }
  assert.ok(report.length < 21_000);
  assert.equal(report.match(/service unavailable/g).length, 4);
  assert.equal(collectCiServiceDiagnostics(() => { throw Object.assign(new Error('Docker absent'), { code: 'ENOENT' }); })
    .match(/ENOENT/g).length, 4, 'inspection failures must remain diagnostic data');
});

test('CI service error annotations cannot inject workflow commands or terminal controls', () => {
  const report = githubServiceFailureAnnotation('\u001b[31m50%\u0000\u0007\r\n::warning::forged\u001b[0m');
  assert.equal(report, '::error title=CI service startup failed::50%25%0D%0A::warning::forged\n');
  assert.equal(report.split('\n').length, 2, 'exactly one physical workflow command is emitted');
  assert.ok(!/[\u0000\u0007\u001b]/.test(report));
  assert.ok(githubServiceFailureAnnotation('x'.repeat(30_000)).length < 24_100);
});

test('the actual CI startup shell preserves Docker failure status and retains escaped diagnostic evidence', async t => {
  const workflow = await fs.readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const match = workflow.match(/      - name: Start MongoDB replica set and Redis\n        run: \|\n((?:          .*\n)+)/);
  assert.ok(match, 'exercise the checked-in startup commands rather than a duplicate trap');
  const script = match[1].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'classicmart-ci-startup-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'scripts'));
  await fs.mkdir(path.join(directory, 'bin'));
  await fs.writeFile(path.join(directory, 'package.json'), '{"type":"module"}\n');
  await fs.copyFile(new URL('../scripts/ci-service-diagnostics.js', import.meta.url), path.join(directory, 'scripts/ci-service-diagnostics.js'));
  await fs.writeFile(path.join(directory, 'bin/docker'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$CLASSIC_MART_CI_DOCKER_CALLS"',
    'if [ "$1" = run ]; then exit 42; fi',
    "printf '\\033[31m50%%\\r\\n::warning::forged\\033[0m\\n'",
    'exit 0',
  ].join('\n') + '\n', { mode: 0o700 });
  const callsFile = path.join(directory, 'docker-calls.txt');
  const environment = { ...process.env, CLASSIC_MART_CI_DOCKER_CALLS: callsFile,
    PATH: [path.join(directory, 'bin'), path.dirname(process.execPath), process.env.PATH || ''].join(path.delimiter) };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', script], {
    cwd: directory, env: environment, encoding: 'utf8', timeout: 15_000, maxBuffer: 64_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 42, result.stdout + result.stderr);
  const annotations = result.stdout.split('\n').filter(line => line.startsWith('::error '));
  assert.equal(annotations.length, 1, result.stdout);
  assert.ok(annotations[0].includes('50%25%0D%0A::warning::forged'));
  assert.ok(!result.stdout.includes('\n::warning::'));
  assert.ok(!/[\u0000\u0007\u001b]/.test(result.stdout));
  const calls = (await fs.readFile(callsFile, 'utf8')).trimEnd().split('\n');
  assert.equal(calls.length, 5, 'a failed first docker run stops startup and collects four fixed diagnostics');
  assert.ok(calls[0].startsWith('run -d --name classic-mart-mongo '));
  assert.ok(calls.slice(1).every(line => /^(inspect|logs) /.test(line)));
  const artifact = await fs.readFile(path.join(directory, 'artifacts/ci-services.txt'), 'utf8');
  assert.ok(artifact.includes('classic-mart-mongo inspect'));
  assert.ok(artifact.includes('classic-mart-redis logs'));
  assert.ok(artifact.includes('50%\r\n::warning::forged'));
  assert.ok(!artifact.includes('\u001b'));
});

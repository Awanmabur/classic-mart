import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import githubTestReporter from '../scripts/github-test-reporter.js';

const runner = fileURLToPath(new URL('../scripts/run-tests.js', import.meta.url));
const decode = value => value.replaceAll('%0A', '\n').replaceAll('%0D', '\r').replaceAll('%3A', ':').replaceAll('%2C', ',').replaceAll('%25', '%');

test('GitHub failure annotations preserve the actual cause and escape workflow command injection without duplicate parents', async () => {
  const assertion = new Error('Expected current stock 50%, received 0\r\n::warning file=forged.js::untrusted text');
  const wrapped = Object.assign(new Error('test failed'), { cause: assertion, failureType: 'testCodeFailure' });
  const file = 'test/example,with:punctuation.test.js';
  async function* events() {
    yield { type: 'test:pass', data: { name: 'passing test' } };
    yield { type: 'test:fail', data: { name: 'assertion, 50%: current stock\nnew line', file, line: 23, column: 7, details: { error: wrapped } } };
    yield { type: 'test:fail', data: { name: 'enclosing suite', details: { error: { failureType: 'subtestsFailed' } } } };
  }
  let report = '';
  for await (const text of githubTestReporter(events())) report += text;
  const lines = report.trimEnd().split('\n');
  assert.equal(lines.length, 1, 'one leaf failure becomes one physical workflow command');
  assert.ok(lines[0].startsWith('::error '));
  const split = lines[0].indexOf('::', 2);
  const properties = lines[0].slice(8, split).split(',');
  assert.ok(properties.includes('file=test/example%2Cwith%3Apunctuation.test.js'));
  assert.ok(properties.includes('line=23')); assert.ok(properties.includes('col=7'));
  const body = decode(lines[0].slice(split + 2));
  assert.ok(body.includes(assertion.message));
  assert.ok(body.includes(assertion.stack));
  assert.ok(!body.includes('enclosing suite'));
  assert.ok(!report.includes('\n::warning'));
});

test('the real canonical runner keeps failure exit codes/spec output and publishes GitHub annotations only in Actions', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'classicmart-github-reporter-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'test'));
  await fs.writeFile(path.join(directory, 'package.json'), '{"type":"module"}\n');
  await fs.writeFile(path.join(directory, 'test', 'actual-failure.test.js'), [
    "import test from 'node:test';",
    "test('one passing fixture', () => {});",
    "test('actual assertion diagnostic', () => { throw new Error('Actual cause keeps 50% and a newline\\nsecond line'); });",
  ].join('\n'));
  const run = github => {
    const environment = { ...process.env, GITHUB_ACTIONS: github, GITHUB_WORKSPACE: directory,
      CLASSIC_MART_LIVE_TEST_MONGO_URI: '', FORCE_COLOR: '0' };
    // This is a fresh CLI invocation, not a child worker of this test harness.
    delete environment.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, [runner], { cwd: directory, encoding: 'utf8', timeout: 30_000,
      env: environment });
  };
  const github = run('true');
  assert.equal(github.error, undefined);
  assert.equal(github.status, 1, 'the expected fixture failure must still fail the runner');
  assert.ok(github.stdout.includes('one passing fixture'));
  assert.ok(github.stdout.includes('actual assertion diagnostic'));
  const annotations = github.stdout.split('\n').filter(line => line.startsWith('::error '));
  assert.equal(annotations.length, 1, github.stdout + github.stderr);
  assert.ok(annotations[0].includes('file=test/actual-failure.test.js'));
  assert.match(annotations[0], /,line=\d+/);
  assert.ok(decode(annotations[0]).includes('Actual cause keeps 50% and a newline\nsecond line'));
  const local = run('false');
  assert.equal(local.error, undefined);
  assert.equal(local.status, 1);
  assert.ok(local.stdout.includes('one passing fixture'));
  assert.ok(!local.stdout.split('\n').some(line => line.startsWith('::error ')));
});

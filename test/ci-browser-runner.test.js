import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCiBrowser } from '../scripts/run-ci-browser.js';

const runnerUrl = new URL('../scripts/run-ci-browser.js', import.meta.url).href;
const secret = 'PRIVATE_CI_CONFIG_AND_PROCESS_VALUE';

function browserReport() {
  const label = 'sign in';
  const error = { message: 'Error: COLOR_CONTRAST_AUDIT: ' + label + '\n\nexpect(received).toEqual(expected)' };
  const annotation = { type: 'colour-contrast-audit', description: label };
  const attachment = { name: 'colour-contrast-findings.json', contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ schemaVersion: 1, label,
      violations: [{ id: 'color-contrast', nodes: [{ target: ['.auth-submit'] }] }] })).toString('base64') };
  return {
    config: { webServer: { env: { PRIVATE_CREDENTIAL: secret } } }, errors: [],
    stats: { startTime: '2026-10-28T00:00:00.000Z', duration: 10, expected: 0, unexpected: 1, flaky: 0, skipped: 0 },
    suites: [{ title: 'accessibility.spec.js', file: 'accessibility.spec.js', line: 0, column: 0, specs: [{
      title: 'sign in audit', file: 'accessibility.spec.js', id: 'audit-id', line: 1, column: 1, tags: [], ok: false,
      tests: [{ timeout: 45_000, expectedStatus: 'passed', projectName: 'desktop-chromium', projectId: 'desktop-chromium',
        status: 'unexpected', annotations: [annotation], results: [{ status: 'failed', retry: 0, workerIndex: 0,
          parallelIndex: 0, duration: 10, startTime: '2026-10-28T00:00:00.000Z', error, errors: [error],
          stdout: [{ text: secret }], stderr: [], annotations: [annotation], attachments: [attachment] }] }],
    }] }],
  };
}

function ownedFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'classicmart-ci-runner-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stepSummary = path.join(root, 'step-summary.md');
  fs.writeFileSync(stepSummary, '');
  const environment = { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: stepSummary, PRIVATE_CREDENTIAL: secret };
  let captured = '';
  const stdout = { write(value) { captured += value; } };
  return { root, stepSummary, environment, stdout, output: () => captured,
    summary: () => JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'ci-browser-summary.json'), 'utf8')) };
}

test('the full-suite runner isolates raw environment-bearing JSON and retains only a sanitized explicit advisory summary', async t => {
  const fixture = ownedFixture(t);
  const originalOutput = path.join(fixture.root, 'untrusted-existing-output.json');
  fs.writeFileSync(originalOutput, 'PREEXISTING_REPORT');
  Object.assign(fixture.environment, { PLAYWRIGHT_JSON_OUTPUT_FILE: originalOutput,
    PLAYWRIGHT_JSON_OUTPUT_NAME: 'misdirected.json', PLAYWRIGHT_JSON_OUTPUT_DIR: fixture.root });
  let rawPath;
  const code = await runCiBrowser({ ...fixture, launch: async (command, args, options) => {
    assert.equal(command, process.execPath);
    assert.match(args[0].replaceAll('\\', '/'), /\/@playwright\/test\/cli\.js$/);
    assert.deepEqual(args.slice(1), ['test', '--reporter=line,html,junit,json']);
    assert.equal(options.cwd, fixture.root);
    assert.equal(options.stdio, 'inherit');
    rawPath = options.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
    assert.notEqual(rawPath, originalOutput);
    assert.equal(path.dirname(path.dirname(rawPath)), fs.realpathSync(os.tmpdir()));
    assert.equal(fs.statSync(path.dirname(rawPath)).mode & 0o777, 0o700);
    assert.ok(!rawPath.startsWith(fixture.root + path.sep));
    assert.equal(options.env.PLAYWRIGHT_HTML_OUTPUT_DIR, path.join(fixture.root, 'playwright-report'));
    assert.equal(options.env.PLAYWRIGHT_HTML_OPEN, 'never');
    assert.equal(options.env.PLAYWRIGHT_JUNIT_OUTPUT_FILE, path.join(fixture.root, 'test-results', 'playwright-junit.xml'));
    fs.writeFileSync(rawPath, JSON.stringify(browserReport()));
    return { exitCode: 1, signal: null };
  } });
  assert.equal(code, 0);
  assert.equal(fs.existsSync(path.dirname(rawPath)), false, 'Raw private configuration must be removed after classification.');
  assert.equal(fs.readFileSync(originalOutput, 'utf8'), 'PREEXISTING_REPORT');
  const summary = fixture.summary();
  assert.equal(summary.counts.contrastAdvisory, 1);
  assert.equal(summary.counts.passed, 0);
  assert.equal(summary.fullWcagConformance, false);
  const markdown = fs.readFileSync(fixture.stepSummary, 'utf8');
  for (const output of [JSON.stringify(summary), markdown, fixture.output()]) assert.ok(!output.includes(secret));
  assert.match(markdown, /not WCAG conformance certification/);
  assert.match(markdown, /Contrast-only failed cases.*advisory/);
  assert.match(fixture.output(), /::warning title=Approved palette contrast audit::/);
  assert.doesNotMatch(fixture.output(), /::error /);
});

test('missing, truncated, oversized and symlink-substituted completion reports block and their private directories are removed', async t => {
  for (const scenario of ['missing', 'truncated', 'oversized', 'symlink', 'launcher-error']) {
    const fixture = ownedFixture(t);
    let rawPath;
    const code = await runCiBrowser({ ...fixture, launch: async (_command, _args, options) => {
      rawPath = options.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
      if (scenario === 'truncated') fs.writeFileSync(rawPath, '{"suites":[');
      if (scenario === 'oversized') {
        fs.writeFileSync(rawPath, ''); fs.truncateSync(rawPath, 33 * 1024 * 1024);
      }
      if (scenario === 'symlink') {
        const target = path.join(fixture.root, 'valid-but-substituted.json');
        fs.writeFileSync(target, JSON.stringify(browserReport())); fs.symlinkSync(target, rawPath);
      }
      if (scenario === 'launcher-error') throw new Error(secret);
      return { exitCode: 1, signal: null };
    } });
    assert.equal(code, 1, scenario);
    assert.ok(fixture.summary().counts.blocking >= 1, scenario);
    assert.equal(fs.existsSync(path.dirname(rawPath)), false, scenario + ' private output cleanup');
    assert.ok(!fixture.output().includes(secret), scenario + ' must not reveal launch/config secrets');
  }
});

test('newline-bearing failure names cannot forge GitHub workflow annotations', async t => {
  const fixture = ownedFixture(t);
  const code = await runCiBrowser({ ...fixture, launch: async (_command, _args, options) => {
    const value = browserReport();
    value.suites[0].specs[0].title = 'Cart failure\n::notice::FORGED_WORKFLOW_NOTICE';
    value.suites[0].specs[0].tests[0].results[0].errors.push({ message: 'Error: cart deletion failed' });
    fs.writeFileSync(options.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify(value));
    return { exitCode: 1, signal: null };
  } });
  assert.equal(code, 1);
  const output = fixture.output();
  assert.equal(output.split('\n').filter(line => line.startsWith('::error ')).length, fixture.summary().failures.length);
  assert.ok(!output.includes('\n::notice::FORGED_WORKFLOW_NOTICE'));
  assert.match(output, /%0A::notice::FORGED_WORKFLOW_NOTICE/);
});

test('blocking assertion and global error details stay readable while configured secret values are redacted', async t => {
  for (const scenario of ['case', 'global']) {
    const fixture = ownedFixture(t);
    const password = secret + '_ADMIN_PASSWORD';
    const apiKey = secret + '_SMS_API_KEY';
    fixture.environment.ADMIN_PASSWORD = password;
    fixture.environment.SMS_API_KEY = apiKey;
    const failureCode = scenario === 'case' ? 'CART_PERSISTENCE_FAILED' : 'GLOBAL_BROWSER_SETUP_FAILED';
    const message = 'Error: ' + failureCode + ' password=' + password + ' key=' + apiKey;
    const code = await runCiBrowser({ ...fixture, launch: async (_command, _args, options) => {
      const value = browserReport();
      if (scenario === 'case') {
        const attempt = value.suites[0].specs[0].tests[0].results[0];
        // A soft contrast assertion may precede the actual blocking failure.
        attempt.errors.push({ message });
      } else value.errors = [{ message }];
      fs.writeFileSync(options.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify(value));
      return { exitCode: 1, signal: null };
    } });
    assert.equal(code, 1);
    const summary = fixture.summary();
    assert.ok(summary.failures.some(failure => failure.error?.includes(failureCode)), scenario + ' first actual error detail');
    assert.match(fixture.output(), new RegExp(failureCode), scenario + ' public failure annotation');
    for (const value of [JSON.stringify(summary), fixture.output(), fs.readFileSync(fixture.stepSummary, 'utf8')]) {
      assert.ok(!value.includes(password), scenario + ' configured password redaction');
      assert.ok(!value.includes(apiKey), scenario + ' configured API key redaction');
    }
  }
});

test('secret redaction happens before public truncation and masks individual recovery codes and provider credentials', async t => {
  const smtpPassword = 'SMTP_BOUNDARY_' + 's'.repeat(186);
  const privateCredential = 'private-credential-for-ci-redaction';
  const pesapalKey = 'pesapal-consumer-key-for-ci-redaction';
  const recoveryCode = 'recovery-code-one-123456';
  const recoveryCodes = recoveryCode + ', recovery-code-two-654321';
  for (const scenario of ['boundary', 'individual-recovery']) {
    const fixture = ownedFixture(t);
    Object.assign(fixture.environment, { SMTP_PASS: smtpPassword, PRIVATE_CREDENTIAL: privateCredential,
      PESAPAL_CONSUMER_KEY: pesapalKey, E2E_SELLER_MFA_RECOVERY_CODES: recoveryCodes });
    const message = scenario === 'boundary' ? 'Error: ' + 'x'.repeat(950) + smtpPassword
      : 'Error: PRIVATE_ASSERTION_FAILURE code=' + recoveryCode + ' credential=' + privateCredential + ' consumer-key=' + pesapalKey;
    assert.ok(!message.includes(recoveryCodes), 'The individual-code probe must not accidentally contain the full configured CSV.');
    const code = await runCiBrowser({ ...fixture, launch: async (_command, _args, options) => {
      const value = browserReport();
      if (scenario === 'boundary') value.suites[0].specs[0].title = 'y'.repeat(950) + smtpPassword;
      value.suites[0].specs[0].tests[0].results[0].errors.push({ message });
      fs.writeFileSync(options.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify(value));
      return { exitCode: 1, signal: null };
    } });
    assert.equal(code, 1);
    const output = fixture.output();
    for (const publicText of [JSON.stringify(fixture.summary()), output, fs.readFileSync(fixture.stepSummary, 'utf8')]) {
      assert.ok(!publicText.includes(smtpPassword), scenario + ' complete SMTP password');
      assert.ok(!publicText.includes(smtpPassword.slice(0, 24)), scenario + ' truncated SMTP password prefix');
      assert.ok(!publicText.includes(recoveryCode), scenario + ' individual recovery code');
      assert.ok(!publicText.includes(privateCredential), scenario + ' private credential');
      assert.ok(!publicText.includes(pesapalKey), scenario + ' Pesapal consumer key');
    }
    assert.match(output, /::error title=Browser verification failed::/);
    if (scenario === 'individual-recovery') assert.match(output, /PRIVATE_ASSERTION_FAILURE/);
  }
});

test('a real Node subprocess preserves zero only for evidenced contrast advisories and nonzero for real or missing results', t => {
  const fixture = ownedFixture(t);
  const scriptPath = path.join(fixture.root, 'run-fixture.mjs');
  const source = `import fs from 'node:fs';
import { runCiBrowser } from ${JSON.stringify(runnerUrl)};
const scenario = process.argv[2];
if (!['contrast', 'mixed', 'missing'].includes(scenario)) throw new Error('Invalid fixture scenario');
const report = ${JSON.stringify(browserReport())};
if (scenario === 'mixed') report.suites[0].specs[0].tests[0].results[0].errors.push({message:'Error: actual keyboard failure'});
process.exitCode = await runCiBrowser({root:${JSON.stringify(fixture.root)},environment:{},launch:async (_command,_args,options)=>{
  if (scenario !== 'missing') fs.writeFileSync(options.env.PLAYWRIGHT_JSON_OUTPUT_FILE,JSON.stringify(report));
  return {exitCode:1,signal:null};
}});
`;
  fs.writeFileSync(scriptPath, source, { mode: 0o600 });
  for (const [scenario, expected] of [['contrast', 0], ['mixed', 1], ['missing', 1]]) {
    const child = spawnSync(process.execPath, [scriptPath, scenario], { cwd: fixture.root, encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, expected, scenario + '\n' + child.stderr);
    assert.equal(child.signal, null);
    assert.ok(!child.stdout.includes(secret));
    const summary = fixture.summary();
    assert.equal(summary.exitCode, expected);
    if (scenario !== 'contrast') assert.ok(summary.counts.blocking >= 1);
  }
});

test('a temporary directory inside uploaded checkout artifacts blocks before a child can write raw environment data', t => {
  const fixture = ownedFixture(t);
  const temporaryRoot = path.join(fixture.root, 'artifacts', 'misconfigured-temp');
  const called = path.join(fixture.root, 'launcher-was-called');
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const scriptPath = path.join(fixture.root, 'private-temp-guard.mjs');
  fs.writeFileSync(scriptPath, `import fs from 'node:fs';
import { runCiBrowser } from ${JSON.stringify(runnerUrl)};
process.exitCode = await runCiBrowser({root:${JSON.stringify(fixture.root)},environment:{},launch:async (_command,_args,options)=>{
  fs.writeFileSync(${JSON.stringify(called)},'CALLED');
  fs.writeFileSync(options.env.PLAYWRIGHT_JSON_OUTPUT_FILE,JSON.stringify(${JSON.stringify(browserReport())}));
  return {exitCode:1,signal:null};
}});
`, { mode: 0o600 });
  const child = spawnSync(process.execPath, [scriptPath], { cwd: fixture.root, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, TMPDIR: temporaryRoot, TEMP: temporaryRoot, TMP: temporaryRoot } });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1, child.stderr);
  assert.equal(fs.existsSync(called), false, 'The child browser runner must not start with an unsafe report destination.');
  assert.deepEqual(fs.readdirSync(temporaryRoot), [], 'No raw report or private report directory may enter uploaded artifacts.');
  const summary = fixture.summary();
  assert.ok(summary.counts.blocking >= 1);
  assert.ok(summary.failures.some(failure => /private temporary directory outside/.test(failure.error || '')));
  assert.ok(!JSON.stringify(summary).includes(secret));
});

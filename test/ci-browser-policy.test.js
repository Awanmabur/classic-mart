import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCiBrowserReport } from '../scripts/run-ci-browser.js';

const label = 'opened product preview';
const marker = 'COLOR_CONTRAST_AUDIT: ';
const annotation = value => ({ type: 'colour-contrast-audit', description: value });
const proof = (value = label, violations = [{ id: 'color-contrast', nodes: [{ target: ['.button'] }] }]) => ({
  name: 'colour-contrast-findings.json', contentType: 'application/json',
  body: Buffer.from(JSON.stringify({ schemaVersion: 1, label: value, violations })).toString('base64'),
});
const error = value => ({ message: 'Error: ' + marker + value + '\n\nexpect(received).toEqual(expected)\n- Expected []\n+ Received colour-contrast findings' });

function result(status = 'passed', overrides = {}) {
  return { workerIndex: 0, parallelIndex: 0, status, duration: 100, retry: 0,
    startTime: '2026-10-28T00:00:00.000Z', errors: [], stdout: [], stderr: [], attachments: [], annotations: [], ...overrides };
}

function contrastResult(value = label, retry = 0) {
  const failure = error(value);
  return result('failed', { error: failure, errors: [failure], retry,
    annotations: [annotation(value)], attachments: [proof(value)] });
}

function testcase(status = 'expected', results = [result()], overrides = {}) {
  return { timeout: 45_000, annotations: [], expectedStatus: 'passed', projectId: 'desktop-chromium',
    projectName: 'desktop-chromium', status, results, ...overrides };
}

function report(cases = [testcase()]) {
  const counts = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
  for (const value of cases) counts[value.status]++;
  return {
    config: { rootDir: '/workspace/classic-mart/tests/e2e', projects: [
      { id: 'desktop-chromium', name: 'desktop-chromium' }, { id: 'mobile-chromium', name: 'mobile-chromium' },
    ] },
    errors: [], stats: { startTime: '2026-10-28T00:00:00.000Z', duration: 300, ...counts },
    suites: [{ title: 'accessibility.spec.js', file: 'accessibility.spec.js', line: 0, column: 0,
      specs: cases.map((value, index) => ({ title: 'Browser case ' + index, file: 'accessibility.spec.js',
        id: 'case-' + index, line: index + 1, column: 1, tags: [], ok: value.status !== 'unexpected', tests: [value] })) }],
  };
}

function advisoryReport() {
  return report([testcase('unexpected', [contrastResult()], { annotations: [annotation(label)] })]);
}

function block(value, processResult = { exitCode: 1 }) {
  const summary = classifyCiBrowserReport(value, processResult);
  assert.notEqual(summary.exitCode, 0, 'The process/report defect must block CI.');
  assert.ok(summary.counts.blocking >= 1, 'The summary must explain a blocking result.');
  assert.ok(summary.failures.length >= 1, 'An accepted advisory cannot replace the failure explanation.');
  assert.equal(summary.fullWcagConformance, false);
  return summary;
}

test('CI keeps actual pass, explicit skip and colour-only advisory counts distinct without claiming WCAG compliance', () => {
  const skipped = testcase('skipped', [result('skipped')], { expectedStatus: 'skipped',
    annotations: [{ type: 'skip', description: 'Mobile-only check.' }] });
  const input = report([testcase(), skipped,
    testcase('unexpected', [contrastResult()], { annotations: [annotation(label)] })]);
  const summary = classifyCiBrowserReport(input, { exitCode: 1 });
  assert.equal(summary.exitCode, 0);
  assert.equal(summary.schemaVersion, 1);
  assert.equal(typeof summary.policy, 'string');
  assert.equal(summary.fullWcagConformance, false);
  assert.deepEqual(summary.counts, { passed: 1, flaky: 0, skipped: 1, contrastAdvisory: 1, blocking: 0 });
  assert.equal(summary.advisories.length, 1);
  assert.deepEqual(summary.failures, []);
});

test('a genuinely successful browser run passes with no fabricated advisory findings', () => {
  const summary = classifyCiBrowserReport(report([testcase(), testcase()]), { exitCode: 0 });
  assert.equal(summary.exitCode, 0);
  assert.equal(summary.counts.passed, 2);
  assert.equal(summary.counts.contrastAdvisory, 0);
  assert.deepEqual(summary.advisories, []);
  assert.deepEqual(summary.failures, []);
});

test('every failed contrast retry needs its own matching annotation and exact proof', () => {
  const input = report([testcase('unexpected', [contrastResult(label, 0), contrastResult(label, 1)],
    { annotations: [annotation(label)] })]);
  assert.equal(classifyCiBrowserReport(input, { exitCode: 1 }).exitCode, 0);
  input.suites[0].specs[0].tests[0].results[1].attachments = [];
  block(input);
  const wrongAttempt = advisoryReport();
  const value = wrongAttempt.suites[0].specs[0].tests[0];
  value.results[0].annotations = [];
  value.annotations = [annotation(label)];
  block(wrongAttempt);
});

test('missing, malformed, empty, mixed-rule and wrong-label evidence never waives a real failed test', () => {
  const changes = [
    ['missing attachment', attempt => { attempt.attachments = []; }],
    ['malformed JSON', attempt => { attempt.attachments[0].body = Buffer.from('{').toString('base64'); }],
    ['malformed base64', attempt => { attempt.attachments[0].body = '{not base64}'; }],
    ['empty violations', attempt => { attempt.attachments = [proof(label, [])]; }],
    ['empty finding nodes', attempt => { attempt.attachments = [proof(label, [{ id: 'color-contrast', nodes: [] }])]; }],
    ['noncontrast violation', attempt => { attempt.attachments = [proof(label, [{ id: 'button-name', nodes: [{ target: ['button'] }] }])]; }],
    ['mixed violations', attempt => { attempt.attachments = [proof(label, [
      { id: 'color-contrast', nodes: [{ target: ['.button'] }] }, { id: 'aria-valid-attr', nodes: [{ target: ['input'] }] },
    ])]; }],
    ['different audit label', attempt => { attempt.attachments = [proof('a different page')]; }],
    ['wrong attachment type', attempt => { attempt.attachments[0].contentType = 'text/html'; }],
    ['wrong attachment name', attempt => { attempt.attachments[0].name = 'unrelated.json'; }],
    ['missing attempt annotation', attempt => { attempt.annotations = []; }],
    ['different attempt annotation', attempt => { attempt.annotations = [annotation('a different page')]; }],
    ['unsupported proof schema', attempt => {
      attempt.attachments[0].body = Buffer.from(JSON.stringify({ schemaVersion: 2, label,
        violations: [{ id: 'color-contrast', nodes: [{ target: ['.button'] }] }] })).toString('base64');
    }],
  ];
  for (const [name, change] of changes) {
    const input = advisoryReport();
    change(input.suites[0].specs[0].tests[0].results[0]);
    assert.notEqual(classifyCiBrowserReport(input, { exitCode: 1 }).exitCode, 0, name);
  }
});

test('colour evidence cannot hide a follow-on keyboard, cart, hook or other assertion failure', () => {
  for (const message of ['Error: cart state did not persist', 'Error: beforeEach hook failed',
    'Error: keyboard focus did not return', 'Error: button-name WCAG violations']) {
    const input = advisoryReport();
    input.suites[0].specs[0].tests[0].results[0].errors.push({ message });
    const summary = block(input);
    assert.equal(summary.counts.contrastAdvisory, 0);
  }
});

test('a marker appearing only in a stack, source snippet or quoted message is not a contrast assertion', () => {
  for (const message of [
    'Error: selector not found\n  17 | expect.soft(contrast, "' + marker + label + '").toEqual([])',
    'Error: failed hook\n    at ' + marker + label,
    'Error: unrelated failure: ' + marker + label,
  ]) {
    const input = advisoryReport();
    const attempt = input.suites[0].specs[0].tests[0].results[0];
    attempt.error = { message }; attempt.errors = [{ message }];
    block(input);
  }
});

test('timeout, interruption and global infrastructure errors block even beside valid colour proof', () => {
  for (const status of ['timedOut', 'interrupted', 'skipped']) {
    const input = advisoryReport();
    input.suites[0].specs[0].tests[0].results[0].status = status;
    block(input);
  }
  const input = advisoryReport();
  input.errors = [{ message: 'Browser process exited unexpectedly.' }];
  block(input);
});

test('process failure cannot be converted to success using an otherwise acceptable report', () => {
  block(advisoryReport(), { exitCode: 2 });
  block(advisoryReport(), { exitCode: null, signal: 'SIGTERM' });
  block(report(), { exitCode: 1 });
  block(advisoryReport(), { exitCode: 0 });
});

test('zero tests, an all-skipped run and unexecuted cases do not establish browser readiness', () => {
  block(report([]), { exitCode: 0 });
  block(report([testcase('skipped', [result('skipped')], { expectedStatus: 'skipped',
    annotations: [{ type: 'skip', description: 'Deliberately skipped.' }] })]), { exitCode: 0 });
  block(report([testcase(), testcase('skipped', [], { expectedStatus: 'passed' })]), { exitCode: 0 });
});

test('an empty intentional skip and infrastructure-failed retry cannot be concealed by other successful results', () => {
  block(report([testcase(), testcase('skipped', [], { expectedStatus: 'skipped',
    annotations: [{ type: 'skip', description: 'Mobile-only check.' }] })]), { exitCode: 0 });
  for (const status of ['timedOut', 'interrupted']) {
    const first = result(status, { error: { message: 'Error: browser infrastructure did not complete' },
      errors: [{ message: 'Error: browser infrastructure did not complete' }] });
    const retry = result('passed', { retry: 1 });
    block(report([testcase('flaky', [first, retry])]), { exitCode: 0 });
  }
});

test('inconsistent or absent completion counters block instead of trusting a partial report', () => {
  for (const mutation of [
    value => { value.stats.unexpected = 0; },
    value => { value.stats.expected = 100; },
    value => { value.stats.skipped = -1; },
    value => { value.stats.flaky = 0.5; },
    value => { delete value.stats; },
    value => { delete value.errors; },
    value => { value.suites = []; },
  ]) {
    const input = advisoryReport(); mutation(input); block(input);
  }
});

test('the advisory marker cannot authorize failures in unrelated suites or expected-failure annotations', () => {
  for (const file of ['critical-flows.spec.js', '../accessibility.spec.js', '/tmp/accessibility.spec.js']) {
    const input = advisoryReport();
    input.suites[0].specs[0].file = file;
    block(input);
  }
  const expectedFailure = advisoryReport();
  const value = expectedFailure.suites[0].specs[0].tests[0];
  value.expectedStatus = 'failed'; value.status = 'expected';
  expectedFailure.stats.unexpected = 0; expectedFailure.stats.expected = 1;
  block(expectedFailure, { exitCode: 0 });
});

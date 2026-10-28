import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MARKER = 'COLOR_CONTRAST_AUDIT: ';
const EVIDENCE_NAME = 'colour-contrast-findings.json';
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const OUTCOMES = ['expected', 'flaky', 'skipped', 'unexpected'];
const PROJECTS = new Set(['desktop-chromium', 'mobile-chromium']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const clean = value => stripVTControlCharacters(typeof value === 'string' ? value : '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
// Preserve the complete first line until known secret values have been removed.
// Truncating first can expose an otherwise unmatchable credential prefix.
const text = value => clean(value);
const escapeData = value => clean(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const firstLine = error => text(error?.message || error?.value || error?.stack).split(/\r?\n/).find(line => line.trim())?.trim() || '';

function firstErrorLine(results) {
  const errors = (Array.isArray(results) ? results : []).flatMap(result => Array.isArray(result?.errors) ? result.errors : result?.error ? [result.error] : []);
  return firstLine(errors.find(error => !assertionLabel(error)) || errors[0]);
}

function assertionLabel(error) {
  if (!plain(error) || typeof error.message !== 'string') return null;
  const line = clean(error.message).split(/\r?\n/).find(value => value.trim())?.trim();
  const message = line?.startsWith('Error: ') ? line.slice(7) : line;
  if (!message?.startsWith(MARKER)) return null;
  const label = message.slice(MARKER.length);
  return label && label.length <= 250 && !/[\r\n]/.test(label) ? label : null;
}

function evidence(result) {
  if (!Array.isArray(result.attachments) || !Array.isArray(result.annotations)) throw new Error('Contrast evidence or per-attempt annotations are missing.');
  const proofs = result.attachments.filter(attachment => attachment?.name === EVIDENCE_NAME);
  if (!proofs.length || proofs.length > 30) throw new Error('Contrast findings attachment is missing or unbounded.');
  const labels = new Map();
  for (const attachment of proofs) {
    if (attachment.contentType !== 'application/json' || typeof attachment.body !== 'string' || attachment.path ||
        attachment.body.length > Math.ceil(MAX_EVIDENCE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(attachment.body)) {
      throw new Error('Contrast findings must be a bounded inline JSON attachment.');
    }
    const body = Buffer.from(attachment.body, 'base64');
    if (!body.length || body.length > MAX_EVIDENCE_BYTES || body.toString('base64') !== attachment.body) throw new Error('Contrast findings encoding is invalid.');
    const value = JSON.parse(body.toString('utf8'));
    if (!plain(value) || value.schemaVersion !== 1 || typeof value.label !== 'string' || !value.label || value.label.length > 250 || /[\r\n]/.test(value.label) ||
        !Array.isArray(value.violations) || !value.violations.length || value.violations.length > 100 || labels.has(value.label)) throw new Error('Contrast findings schema is invalid.');
    let nodes = 0;
    for (const violation of value.violations) {
      if (!plain(violation) || violation.id !== 'color-contrast' || !Array.isArray(violation.nodes) || !violation.nodes.length || violation.nodes.length > 10_000) {
        throw new Error('Only proven colour-contrast violations may be advisory.');
      }
      for (const node of violation.nodes) {
        if (!plain(node) || !Array.isArray(node.target) || !node.target.length || node.target.length > 20 || node.target.some(target => typeof target !== 'string' || !target || target.length > 10_000)) {
          throw new Error('Contrast finding selectors are invalid.');
        }
      }
      nodes += violation.nodes.length;
    }
    if (!result.annotations.some(annotation => annotation?.type === 'colour-contrast-audit' && annotation.description === value.label)) throw new Error('Contrast evidence lacks its matching per-attempt annotation.');
    labels.set(value.label, nodes);
  }
  return labels;
}

function advisoryAttempt(result) {
  if (!plain(result) || result.status !== 'failed' || !Array.isArray(result.errors) || !result.errors.length || result.errors.length > 100) return null;
  try {
    const proofs = evidence(result), errors = result.errors.map(assertionLabel);
    if (errors.some(label => !label || !proofs.has(label))) return null;
    if (!plain(result.error) || result.error.cause || !proofs.has(assertionLabel(result.error))) return null;
    if (proofs.size !== new Set(errors).size) return null;
    return [...proofs].map(([label, nodes]) => ({ label, nodes }));
  } catch { return null; }
}

/** Apply the approved-palette CI policy without changing Playwright's test results. */
export function classifyCiBrowserReport(report, { exitCode, signal = null } = {}) {
  const summary = { schemaVersion: 1, policy: 'approved-palette-contrast-advisory', fullWcagConformance: false,
    counts: { passed: 0, flaky: 0, skipped: 0, contrastAdvisory: 0, blocking: 0 }, advisories: [], failures: [], exitCode: 1 };
  const fail = (reason, item = {}) => { summary.counts.blocking++; summary.failures.push({ ...item, reason }); };
  if (signal) fail('The browser runner was terminated by a signal.');
  if (exitCode !== 0 && exitCode !== 1) fail('The browser runner did not complete with a normal test result.');
  if (!plain(report) || !plain(report.stats) || !Array.isArray(report.suites) || !Array.isArray(report.errors)) {
    fail('The complete browser JSON report is missing or malformed.'); return summary;
  }
  if (report.errors.length) fail('The browser run contains a global, setup, hook or reporter error.', { error: firstLine(report.errors[0]) });
  if (!OUTCOMES.every(key => Number.isSafeInteger(report.stats[key]) && report.stats[key] >= 0)) {
    fail('Browser report outcome counts are invalid.'); return summary;
  }
  const totals = Object.fromEntries(OUTCOMES.map(key => [key, 0]));
  let cases = 0;
  function visit(suites, depth = 0) {
    if (depth > 30 || suites.length > 10_000) throw new Error('Browser suite structure is unbounded.');
    for (const suite of suites) {
      if (!plain(suite) || !Array.isArray(suite.specs) || (suite.suites !== undefined && !Array.isArray(suite.suites))) throw new Error('Browser suite structure is incomplete.');
      for (const spec of suite.specs) {
        if (!plain(spec) || !Array.isArray(spec.tests) || !spec.tests.length) throw new Error('Browser spec has no test outcomes.');
        for (const test of spec.tests) {
          if (++cases > 10_000) throw new Error('Browser test count is unbounded.');
          const item = { file: text(spec.file), title: text(spec.title), project: text(test?.projectName), error: firstErrorLine(test?.results) };
          if (!plain(test) || !OUTCOMES.includes(test.status) || !Array.isArray(test.results) || test.results.length > 20) throw new Error('Browser test outcome is incomplete.');
          totals[test.status]++;
          const results = test.results;
          if (!PROJECTS.has(test.projectName)) { fail('Unknown browser project cannot be classified as advisory.', item); continue; }
          if (!['passed', 'skipped'].includes(test.expectedStatus)) { fail('Expected failures cannot be classified as passing functionality.', item); continue; }
          if (results.some(result => !plain(result) || !['passed', 'failed', 'timedOut', 'skipped', 'interrupted'].includes(result.status) || !Array.isArray(result.errors))) {
            fail('Browser attempt result is missing or malformed.', item); continue;
          }
          if (results.some(result => result.status === 'interrupted')) { fail('An interrupted test is not an intentional skip.', item); continue; }
          if (results.some(result => result.status === 'timedOut')) { fail('A timed-out browser attempt remains blocking.', item); continue; }
          if (test.status === 'skipped') {
            if (test.expectedStatus !== 'skipped' || !results.length || results.some(result => result.status !== 'skipped' || result.errors.length || result.error)) fail('An unexecuted test is not an intentional skip.', item);
            else summary.counts.skipped++;
            continue;
          }
          if (test.expectedStatus !== 'passed' || !results.length) { fail('A required browser test did not execute.', item); continue; }
          const last = results.at(-1);
          if (test.status === 'expected' || test.status === 'flaky') {
            if (last.status !== 'passed' || last.errors.length || last.error || (test.status === 'expected' && results.some(result => result.status !== 'passed' || result.errors.length || result.error))) {
              fail('Browser success is inconsistent with its attempt results.', item); continue;
            }
            if (test.status === 'flaky') summary.counts.flaky++;
            else summary.counts.passed++;
            continue;
          }
          if (spec.file !== 'accessibility.spec.js') { fail('A functional browser test failed.', item); continue; }
          const attempts = results.map(advisoryAttempt);
          if (attempts.some(value => !value)) { fail('The failed test includes an unproven contrast, functional, timeout or hook error.', item); continue; }
          summary.counts.contrastAdvisory++;
          summary.advisories.push({ ...item, findings: attempts.at(-1) });
        }
      }
      visit(suite.suites || [], depth + 1);
    }
  }
  try { visit(report.suites); } catch { fail('The browser JSON report is incomplete or malformed.'); }
  if (!cases || summary.counts.passed + summary.counts.flaky + summary.counts.contrastAdvisory === 0) fail('No required browser tests executed.');
  if (OUTCOMES.some(key => totals[key] !== report.stats[key])) fail('Browser outcome totals do not match the complete report.');
  if (exitCode === 0 && totals.unexpected) fail('A successful process exit conflicts with unexpected browser failures.');
  if (exitCode === 1 && !totals.unexpected) fail('The browser process failed outside its reported test cases.');
  if (!summary.counts.blocking) summary.exitCode = 0;
  return summary;
}

export function ciBrowserSummaryMarkdown(summary) {
  return ['## Browser verification', '', `Policy: **${summary.policy}**. Approved colours are unchanged.`, '',
    '| Outcome | Cases |', '| --- | ---: |', `| Passed | ${summary.counts.passed} |`, `| Passed after retry | ${summary.counts.flaky} |`,
    `| Contrast-only failed cases — advisory | ${summary.counts.contrastAdvisory} |`, `| Intentionally skipped | ${summary.counts.skipped} |`,
    `| Blocking failures | ${summary.counts.blocking} |`, '',
    '**This is not WCAG conformance certification.** Contrast assertions still execute and their failed results remain in the HTML/JUnit reports.',
    'Functional, security, keyboard, non-contrast accessibility, timeout and infrastructure failures remain blocking.',
    'See `artifacts/ci-browser-summary.json` and the uploaded browser diagnostics for details.', ''].join('\n');
}

function writeSummary(summary, { root, environment, stdout }) {
  const secretNames = /SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|RECOVERY[_-]?CODES?|(?:^|_)PASS(?:$|_)|(?:^|_)KEY(?:$|_)|API[_-]?KEY|PRIVATE[_-]?KEY|ENCRYPTION[_-]?KEY|INTEGRITY[_-]?KEY|ACCESS[_-]?KEY|DATABASE_URL|MONGO_URI|REDIS_URL/i;
  const secretValues = [...new Set(Object.entries(environment)
    .filter(([name, value]) => secretNames.test(name) && typeof value === 'string' && value)
    .flatMap(([name, value]) => [value, ...value.split(/\r?\n/).filter(Boolean), ...(/RECOVERY[_-]?CODES?/i.test(name) ? value.split(',').map(code => code.trim()).filter(Boolean) : [])]))]
    .sort((a, b) => b.length - a.length);
  const redact = value => secretValues.reduce((safe, secret) => safe.replaceAll(secret, '[REDACTED]'), value);
  const safeSummary = JSON.parse(JSON.stringify(summary, (_, value) => typeof value === 'string' ? redact(value).slice(0, 1000) : value));
  const target = path.join(root, 'artifacts', 'ci-browser-summary.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(safeSummary, null, 2) + '\n', { mode: 0o600 });
  if (environment.GITHUB_STEP_SUMMARY) fs.appendFileSync(environment.GITHUB_STEP_SUMMARY, ciBrowserSummaryMarkdown(summary));
  stdout.write(JSON.stringify({ browserPolicy: summary.policy, ...summary.counts, fullWcagConformance: false, exitCode: summary.exitCode }) + '\n');
  if (environment.GITHUB_ACTIONS === 'true') {
    if (summary.counts.contrastAdvisory) stdout.write('::warning title=Approved palette contrast audit::' + escapeData(`${summary.counts.contrastAdvisory} browser cases failed only their colour-contrast assertions. These are reported as advisory under the approved-colour policy; WCAG conformance is not certified. Full findings remain in browser diagnostics.`) + '\n');
    for (const failure of safeSummary.failures.slice(0, 30)) stdout.write('::error title=Browser verification failed::' + escapeData([failure.project, failure.file, failure.title, failure.reason, failure.error].filter(Boolean).join(' — ')) + '\n');
  }
}

/** Full-suite CLI; the injected launcher is solely for subprocess regression tests. */
export async function runCiBrowser({ root = ROOT, environment = process.env, stdout = process.stdout, launch } = {}) {
  let directory, summary;
  try {
    const checkoutRoot = fs.realpathSync(root), temporaryRoot = fs.realpathSync(os.tmpdir());
    const relative = path.relative(checkoutRoot, temporaryRoot);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
      throw Object.assign(new Error('Private browser report directory is unavailable.'), { code: 'CI_REPORT_TEMP_NOT_PRIVATE' });
    }
    directory = fs.mkdtempSync(path.join(temporaryRoot, 'classicmart-ci-browser-'));
    fs.chmodSync(directory, 0o700);
    const reportFile = path.join(directory, 'report.json');
    const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
    const env = { ...environment, PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile,
      PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(root, 'playwright-report'), PLAYWRIGHT_HTML_OPEN: 'never',
      PLAYWRIGHT_JUNIT_OUTPUT_FILE: path.join(root, 'test-results', 'playwright-junit.xml') };
    // JSON must run last: errors raised while earlier reporters write their
    // HTML/JUnit output are then captured as global errors in its final report.
    const args = [cli, 'test', '--reporter=line,html,junit,json'];
    const execute = launch || ((command, argv, options) => new Promise((resolve, reject) => {
      const child = spawn(command, argv, options);
      let receivedSignal;
      const forward = signal => { receivedSignal ||= signal; child.kill(signal); };
      const sigint = () => forward('SIGINT'), sigterm = () => forward('SIGTERM');
      const cleanup = () => { process.removeListener('SIGINT', sigint); process.removeListener('SIGTERM', sigterm); };
      process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
      child.once('error', error => { cleanup(); reject(error); });
      child.once('close', (exitCode, signal) => { cleanup(); resolve({ exitCode, signal: receivedSignal || signal }); });
    }));
    const outcome = await execute(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
    let report;
    try {
      const stat = fs.lstatSync(reportFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REPORT_BYTES || !stat.size) throw new Error('Invalid report file.');
      report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    } catch { /* Missing, truncated and stale reports fail closed below. */ }
    summary = classifyCiBrowserReport(report, outcome);
  } catch (error) {
    summary = classifyCiBrowserReport(undefined, { exitCode: null });
    if (error?.code === 'CI_REPORT_TEMP_NOT_PRIVATE') summary.failures[0].error = 'Raw browser reports require a private temporary directory outside the project checkout.';
  } finally {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
  writeSummary(summary, { root, environment, stdout });
  return summary.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) {
    console.error('The CI browser gate always runs the complete configured suite; extra CLI arguments are not allowed.');
    process.exitCode = 1;
  } else {
    try { process.exitCode = await runCiBrowser(); }
    catch { console.error('Browser verification could not write its required diagnostics.'); process.exitCode = 1; }
  }
}

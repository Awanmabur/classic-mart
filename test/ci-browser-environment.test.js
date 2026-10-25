import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareCiBrowserEnvironment } from '../scripts/prepare-ci-browser.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'classicmart-ci-browser-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executablePath = path.join(directory, 'installed chromium');
  const environmentFile = path.join(directory, 'set_env_fixture');
  await fs.writeFile(executablePath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await fs.writeFile(environmentFile, 'EXISTING_SETTING=preserved');
  return { directory, executablePath, environmentFile };
}

test('CI shares its verified installed browser with current and legacy live suites without replacing settings', async t => {
  const files = await fixture(t);
  assert.equal(await prepareCiBrowserEnvironment(files), files.executablePath);
  assert.deepEqual((await fs.readFile(files.environmentFile, 'utf8')).trim().split('\n'), [
    'EXISTING_SETTING=preserved',
    'PLAYWRIGHT_CHROMIUM_EXECUTABLE=' + files.executablePath,
    'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=' + files.executablePath,
  ]);
});

test('CI refuses missing, non-executable and malformed browser paths before writing environment settings', async t => {
  const files = await fixture(t), original = await fs.readFile(files.environmentFile, 'utf8');
  for (const executablePath of [path.join(files.directory, 'missing'), files.directory,
    files.executablePath + '\nINJECTED_SETTING=true', 'relative-browser']) {
    await assert.rejects(prepareCiBrowserEnvironment({ ...files, executablePath }));
    assert.equal(await fs.readFile(files.environmentFile, 'utf8'), original);
  }
  if (process.platform !== 'win32') {
    await fs.chmod(files.executablePath, 0o600);
    await assert.rejects(prepareCiBrowserEnvironment(files), error => error.code === 'EACCES');
    assert.equal(await fs.readFile(files.environmentFile, 'utf8'), original);
  }
});

test('CI requires an existing environment file rather than creating a mistyped destination', async t => {
  const files = await fixture(t), missing = path.join(files.directory, 'missing-env');
  await assert.rejects(prepareCiBrowserEnvironment({ ...files, environmentFile: missing }), error => error.code === 'ENOENT');
  await assert.rejects(fs.stat(missing), error => error.code === 'ENOENT');
});

test('CI prepares its browser before canonical tests and only tracks the retained master branch', async () => {
  const workflow = await fs.readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const install = workflow.indexOf('playwright install --with-deps chromium');
  const prepare = workflow.indexOf('node scripts/prepare-ci-browser.js');
  const tests = workflow.indexOf('run: npm test');
  assert.ok(install >= 0 && prepare > install && tests > prepare);
  assert.match(workflow, /branches: \[master\]/);
  assert.match(workflow, /npm run browser:check/);
  assert.doesNotMatch(workflow, /continue-on-error/);
});

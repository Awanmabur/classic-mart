import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tag = () => crypto.randomBytes(12).toString('hex');
const approvedUri = () => `mongodb://127.0.0.1:1/classicmart_browser_test_${tag()}?replicaSet=browserguard`;
const credentialName = () => `classicmart-browser-accounts-${tag()}.json`;
const ownedFiles = [];
let controlDirectory;

before(async () => {
  controlDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'classicmart-browser-safety-'));
});
after(async () => {
  for (const filename of ownedFiles) await fs.rm(filename, { force: true });
  if (controlDirectory) await fs.rm(controlDirectory, { force: true, recursive: true });
});

async function absentOutput(directory = os.tmpdir()) {
  const filename = path.join(directory, credentialName());
  await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
  ownedFiles.push(filename);
  return filename;
}

// Exercise the real exported seeder in a fresh process. Replacing connect only
// provides a tripwire: none of these rejections may reach it, even if a guard
// regresses. No test can contact or modify a database.
function rejectedFixture(options, environment = {}) {
  const secret = 'must-not-log-fixture-credentials-' + tag();
  const script = `
    import mongoose from 'mongoose';
    let connections = 0;
    mongoose.connect = async () => {
      connections++;
      throw new Error('UNEXPECTED_BROWSER_FIXTURE_DATABASE_CONNECTION');
    };
    const { seedBrowserAccounts } = await import('./scripts/seed-browser-accounts.js');
    let result;
    try {
      await seedBrowserAccounts(${JSON.stringify(options)});
      result = { rejected: false, connections };
    } catch (error) {
      result = { rejected: true, connections, code: error.code || '', message: error.message };
    }
    process.stdout.write(JSON.stringify(result));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: root, encoding: 'utf8', timeout: 15_000,
    env: {
      ...process.env, NODE_ENV: 'test', SIMPLE_LOGIN: 'false', PRIVILEGED_MFA_REQUIRED: 'true',
      MONGO_URI: approvedUri(), CLASSIC_MART_TEST_MONGO_OVERRIDE: '1', REDIS_URL: '',
      MAIL_MODE: 'log', SMS_MODE: 'log', AI_PROVIDER: 'disabled',
      GITHUB_ACTIONS: '', GITHUB_ENV: '', CI: '', RUNNER_TEMP: controlDirectory,
      SESSION_SECRET: secret + '-session', TOKEN_PEPPER: secret + '-token',
      DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), SECURITY_INTEGRITY_KEY: secret + '-integrity',
      SMTP_PASSWORD: secret, YOOLA_API_KEY: secret, PESAPAL_CONSUMER_SECRET: secret,
      DOTENV_CONFIG_PATH: path.join(controlDirectory, 'unused.env'), DOTENV_CONFIG_QUIET: 'true',
      ...environment,
    },
  });
  assert.equal(result.error, undefined, 'the guard check must finish without a child-process error');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '', 'guard checks must not print credentials or an uncontrolled stack');
  assert.ok(!result.stdout.includes(secret), 'rejected setup must not expose configured credentials');
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.rejected, true, 'the actual seeder must reject this unsafe setup');
  assert.equal(observed.connections, 0, 'rejection must happen before database access');
  return observed;
}

test('browser fixtures reject production mode before opening their credential output', async () => {
  const filename = await absentOutput();
  const rejected = rejectedFixture({ uri: approvedUri(), credentialFile: filename }, { NODE_ENV: 'production' });
  assert.match(rejected.message, /NODE_ENV=test/);
  await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
});

for (const [label, uri, message] of [
  ['a remote host', 'mongodb://database.example.test/classic_mart_ci?replicaSet=browserguard', /loopback MongoDB host/],
  ['SRV discovery', 'mongodb+srv://127.0.0.1/classic_mart_ci?replicaSet=browserguard', /loopback MongoDB replica set/],
  ['an application database', 'mongodb://127.0.0.1:1/classicmart_production?replicaSet=browserguard', /isolated CI database/],
  ['a lookalike test database', 'mongodb://127.0.0.1:1/classicmart_browser_test_not_random?replicaSet=browserguard', /isolated CI database/],
  ['a missing replica-set declaration', 'mongodb://127.0.0.1:1/classic_mart_ci', /explicit replicaSet/],
]) {
  test(`browser fixtures reject ${label} before writing credentials or connecting`, async () => {
    const filename = await absentOutput();
    const rejected = rejectedFixture({ uri, credentialFile: filename });
    assert.match(rejected.message, message);
    await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
  });
}

test('an existing credential file is preserved without reading or replacing its contents', async () => {
  const filename = await absentOutput(), sentinel = 'existing-private-file-' + tag();
  await fs.writeFile(filename, sentinel, { mode: 0o600, flag: 'wx' });
  const rejected = rejectedFixture({ uri: approvedUri(), credentialFile: filename });
  assert.equal(rejected.code, 'EEXIST');
  assert.ok(!rejected.message.includes(sentinel));
  assert.equal(await fs.readFile(filename, 'utf8'), sentinel);
});

test('credential output outside the system temporary directory is refused', async () => {
  const filename = await absentOutput(root);
  const rejected = rejectedFixture({ uri: approvedUri(), credentialFile: filename });
  assert.match(rejected.message, /system temporary directory/);
  await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
});

test('credential output cannot follow an existing symlink to another file', async () => {
  const filename = await absentOutput(), target = path.join(controlDirectory, 'protected-symlink-target');
  const sentinel = 'protected-symlink-target-' + tag();
  await fs.writeFile(target, sentinel, { mode: 0o600, flag: 'wx' });
  await fs.symlink(target, filename, 'file');
  const rejected = rejectedFixture({ uri: approvedUri(), credentialFile: filename });
  assert.equal(rejected.code, 'EEXIST');
  assert.equal((await fs.lstat(filename)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(target, 'utf8'), sentinel);
});

for (const [label, auth, message] of [
  ['simple-login bypass', { SIMPLE_LOGIN: 'true', PRIVILEGED_MFA_REQUIRED: 'true' }, /SIMPLE_LOGIN=false/],
  ['disabled privileged MFA', { SIMPLE_LOGIN: 'false', PRIVILEGED_MFA_REQUIRED: 'false' }, /requires privileged MFA/],
]) {
  test(`browser fixture rejection cleans up its new private output for ${label}`, async () => {
    const filename = await absentOutput();
    const rejected = rejectedFixture({ uri: approvedUri(), credentialFile: filename }, auth);
    assert.match(rejected.message, message);
    await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
  });
}

for (const [label, flags, message] of [
  ['outside GitHub Actions', { GITHUB_ACTIONS: '', CI: 'true' }, /only in GitHub Actions/],
  ['outside the CI runner', { GITHUB_ACTIONS: 'true', CI: '' }, /requires the CI runner/],
]) {
  test(`forged GitHub environment output is refused ${label} without changing its file`, async () => {
    const filename = path.join(controlDirectory, `set_env_${tag()}`), sentinel = 'existing-runner-command-' + tag();
    await fs.writeFile(filename, sentinel, { flag: 'wx' });
    const rejected = rejectedFixture({ uri: approvedUri(), githubEnv: filename }, flags);
    assert.match(rejected.message, message);
    assert.equal(await fs.readFile(filename, 'utf8'), sentinel);
  });
}

test('a sibling path cannot impersonate the current runner temporary directory', async () => {
  const runner = path.join(controlDirectory, 'runner'), sibling = runner + '-other';
  await fs.mkdir(runner); await fs.mkdir(sibling);
  const filename = path.join(sibling, `set_env_${tag()}`), sentinel = 'other-runner-command-' + tag();
  await fs.writeFile(filename, sentinel, { flag: 'wx' });
  const rejected = rejectedFixture({ uri: approvedUri(), githubEnv: filename }, { GITHUB_ACTIONS: 'true', CI: 'true', RUNNER_TEMP: runner });
  assert.match(rejected.message, /current runner temporary directory/);
  assert.equal(await fs.readFile(filename, 'utf8'), sentinel);
});

test('GitHub environment output requires the actual runner command-file name', async () => {
  const filename = path.join(controlDirectory, 'unrelated.env'), sentinel = 'unrelated-file-' + tag();
  await fs.writeFile(filename, sentinel, { flag: 'wx' });
  const rejected = rejectedFixture({ uri: approvedUri(), githubEnv: filename }, { GITHUB_ACTIONS: 'true', CI: 'true' });
  assert.match(rejected.message, /runner environment-command file/);
  assert.equal(await fs.readFile(filename, 'utf8'), sentinel);
});

test('a GitHub environment symlink cannot redirect writes outside the current runner', async () => {
  const runner = path.join(controlDirectory, 'symlink-runner'); await fs.mkdir(runner);
  const target = path.join(controlDirectory, `set_env_${tag()}`), filename = path.join(runner, `set_env_${tag()}`);
  const sentinel = 'symlinked-runner-command-' + tag();
  await fs.writeFile(target, sentinel, { flag: 'wx' });
  await fs.symlink(target, filename, 'file');
  const rejected = rejectedFixture({ uri: approvedUri(), githubEnv: filename }, { GITHUB_ACTIONS: 'true', CI: 'true', RUNNER_TEMP: runner });
  assert.match(rejected.message, /current runner temporary directory/);
  assert.equal(await fs.readFile(target, 'utf8'), sentinel);
});

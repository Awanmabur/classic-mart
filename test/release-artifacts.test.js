import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const prototypes = ['script.js', 'role-workspaces.js', 'enhancements.js', 'session-controls.js'];

function isolatedSource() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'classic-mart-packaging-'));
  const write = (relative, text = '// packaging input\n') => {
    const target = path.join(directory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  const pkg = { name: 'classic-mart', version: '1.0.0', engines: { node: '>=24 <25' },
    scripts: { test: 'node --test' }, dependencies: {}, devDependencies: { 'test-only': '1.0.0' } };
  write('package.json', JSON.stringify(pkg));
  write('package-lock.json', JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3,
    packages: { '': { name: pkg.name, version: pkg.version, devDependencies: pkg.devDependencies } } }));
  for (const relative of ['src/app.js', 'src/config/initial-catalogue.js', 'src/core/local-mongo.js',
    'public/approved-dashboard/customer-live.js', 'public/approved-dashboard/session-entry.js',
    'public/approved-dashboard/assets/avatar.png', 'public/assets/products/sample.svg',
    'scripts/run-production.js', 'scripts/check-r2.js', 'scripts/launch-evidence.js', 'scripts/staff-access.js', 'scripts/operator-input.js',
    'scripts/verify-mail.js', 'scripts/verify-sms.js',
    'scripts/seed-initial-catalogue.js', 'scripts/seed.js', 'scripts/ensure-local-mongo.js',
    'test/reference.test.js', 'tests/e2e/reference.spec.js', '.github/workflows/ci.yml']) write(relative);
  for (const name of prototypes) write(`public/approved-dashboard/${name}`);
  write('scripts/runtime-package.js', fs.readFileSync(path.join(root, 'scripts/runtime-package.js')));
  write('dashboard-preview/final19/index.html', '<main>Approved reference</main>\n');
  write('dashboard-preview/final19/assets/avatar.png', 'original image bytes');
  write('DASHBOARD_PREVIEW.md', 'Preview instructions\n');
  write('README.md', 'Application instructions\n');
  write('docs/production/staged-launch.md', 'Actual operating instructions\n');
  write('.env', 'PRIVATE_RUNTIME_VALUE=must-stay-out\n');
  write('.env.example', 'NODE_ENV=development\n');
  write('.env.production.example', 'NODE_ENV=production\n');
  for (const name of ['CLEAN_MANIFEST.json', 'PRODUCTION_MANIFEST.json', 'RELEASE_MANIFEST.json']) write(name, 'stale generated content');
  return directory;
}

function build(directory, script, suffix = '') {
  execFileSync(process.execPath, [path.join(root, 'scripts', script)], { cwd: directory, stdio: 'pipe' });
  return path.join(directory, 'dist', `classic-mart-v1.0.0${suffix}`);
}

function exists(stage, relative) { return fs.existsSync(path.join(stage, relative)); }

test('engineering release keeps the frozen preview required by its shipped reference tests', t => {
  const directory = isolatedSource();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stage = build(directory, 'build-release.js');
  for (const relative of ['test/reference.test.js', 'tests/e2e/reference.spec.js',
    'dashboard-preview/final19/index.html', 'dashboard-preview/final19/assets/avatar.png', 'DASHBOARD_PREVIEW.md']) {
    assert.deepEqual(fs.readFileSync(path.join(stage, relative)), fs.readFileSync(path.join(directory, relative)), relative);
  }
  for (const name of prototypes) assert.ok(exists(stage, `public/approved-dashboard/${name}`));
  assert.equal(exists(stage, '.env'), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'RELEASE_MANIFEST.json'), 'utf8'));
  assert.equal(manifest.version, '1.0.0');
  assert.ok(manifest.files.some(file => file.path === 'dashboard-preview/final19/index.html'));
});

test('production release contains live assets and launch operations while excluding engineering and seed inputs', t => {
  const directory = isolatedSource();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stage = build(directory, 'build-production-release.js', '-production');
  for (const relative of ['public/approved-dashboard/customer-live.js', 'public/approved-dashboard/session-entry.js',
    'public/approved-dashboard/assets/avatar.png', 'scripts/check-r2.js', 'scripts/launch-evidence.js',
    'scripts/staff-access.js', 'scripts/operator-input.js', 'scripts/verify-mail.js', 'scripts/verify-sms.js', 'scripts/runtime-package.js',
    'docs/production/staged-launch.md']) assert.ok(exists(stage, relative), relative);
  for (const relative of ['dashboard-preview', 'test', 'tests', '.github', '.env', '.env.example',
    'src/core/local-mongo.js', 'src/config/initial-catalogue.js', 'public/assets/products',
    'scripts/seed-initial-catalogue.js', 'scripts/seed.js', 'CLEAN_MANIFEST.json', 'RELEASE_MANIFEST.json',
    ...prototypes.map(name => `public/approved-dashboard/${name}`)]) assert.equal(exists(stage, relative), false, relative);
  const pkg = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.scripts['launch:evidence'], 'node scripts/launch-evidence.js');
  assert.equal(pkg.scripts['staff:access'], 'node scripts/staff-access.js');
  assert.equal(pkg.scripts['mail:verify'], 'node scripts/verify-mail.js');
  assert.equal(pkg.scripts['sms:verify'], 'node scripts/verify-sms.js');
  assert.equal(pkg.scripts.test, undefined);
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'PRODUCTION_MANIFEST.json'), 'utf8'));
  assert.equal(manifest.kind, 'production');
  assert.ok(manifest.files.every(file => !file.path.endsWith('_MANIFEST.json')));
});

test('clean app release preserves deliberate catalogue setup without shipping preview engines or stale manifests', t => {
  const directory = isolatedSource();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stage = build(directory, 'build-clean-app-release.js', '-clean');
  for (const relative of ['scripts/seed-initial-catalogue.js', 'src/config/initial-catalogue.js',
    'scripts/launch-evidence.js', 'scripts/check-r2.js', 'scripts/staff-access.js', 'scripts/operator-input.js',
    'scripts/verify-mail.js', 'scripts/verify-sms.js', 'scripts/runtime-package.js', 'docs/production/staged-launch.md']) assert.ok(exists(stage, relative), relative);
  for (const relative of ['dashboard-preview', 'test', 'tests', '.github', '.env', 'src/core/local-mongo.js',
    'scripts/seed.js', 'PRODUCTION_MANIFEST.json', 'RELEASE_MANIFEST.json',
    ...prototypes.map(name => `public/approved-dashboard/${name}`)]) assert.equal(exists(stage, relative), false, relative);
  const pkg = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['launch:evidence'], 'node scripts/launch-evidence.js');
  assert.equal(pkg.scripts['staff:access'], 'node scripts/staff-access.js');
  assert.equal(pkg.scripts['mail:verify'], 'node scripts/verify-mail.js');
  assert.equal(pkg.scripts['sms:verify'], 'node scripts/verify-sms.js');
  assert.equal(pkg.devDependencies, undefined);
});

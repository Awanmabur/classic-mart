import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

test('real-browser and accessibility release gate is pinned and reproducible', () => {
  assert.equal(pkg.devDependencies['@playwright/test'], '1.62.1');
  assert.equal(pkg.devDependencies['@axe-core/playwright'], '4.13.0');
  assert.equal(lock.packages['node_modules/@playwright/test'].version, '1.62.1');
  assert.equal(lock.packages['node_modules/@axe-core/playwright'].version, '4.13.0');
  assert.match(pkg.scripts['release:check'], /npm run browser:check/);
});

test('browser suite covers desktop, mobile, authenticated navigation and WCAG AA', () => {
  const config = read('playwright.config.js');
  const critical = read('tests/e2e/critical-flows.spec.js');
  const accessibility = read('tests/e2e/accessibility.spec.js');
  assert.match(config, /desktop-chromium/);
  assert.match(config, /mobile-chromium/);
  assert.match(critical, /seeded privileged account/);
  assert.match(critical, /refresh and browser back navigation/);
  assert.match(critical, /double activation/);
  assert.match(accessibility, /wcag22aa/);
  assert.match(accessibility, /AxeBuilder/);
  assert.match(accessibility, /keyboard focus reaches the skip link/);
  assert.match(accessibility, /400-percent equivalent reflow/);
  assert.match(accessibility, /reduced-motion preference/);
  assert.match(accessibility, /visible focus indicator/);
  assert.match(accessibility, /minimum target size/);
  assert.match(critical, /authenticated operational tables become labelled phone cards/);
});

test('Node 24 CI installs the browser, seeds data, runs the gate and uploads diagnostics', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /node-version: '24\.x'/);
  assert.match(workflow, /node scripts\/seed\.js/);
  assert.match(workflow, /playwright install --with-deps chromium/);
  assert.match(workflow, /npm run browser:check/);
  assert.match(workflow, /classic-mart-browser-diagnostics/);
});

test('sanitized release includes browser gate sources', () => {
  const builder = read('scripts/build-release.js');
  assert.match(builder, /'playwright\.config\.js'/);
  assert.match(builder, /'tests'/);
});

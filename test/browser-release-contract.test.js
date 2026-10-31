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
  assert.equal(pkg.scripts['browser:check'], 'playwright test');
  assert.equal(pkg.scripts['browser:ci'], 'node scripts/run-ci-browser.js');
});

test('browser suite covers desktop, mobile, authenticated navigation and WCAG AA', () => {
  const config = read('playwright.config.js');
  const critical = read('tests/e2e/critical-flows.spec.js');
  const accessibility = read('tests/e2e/accessibility.spec.js');
  assert.match(config, /desktop-chromium/);
  assert.match(config, /mobile-chromium/);
  assert.match(critical, /dedicated Seller signs in to its catalogue and cannot enter Moderation/);
  assert.match(critical, /dedicated Moderator signs in to its catalogue and cannot enter the Seller workspace/);
  for (const role of ['SELLER', 'MODERATOR']) {
    for (const credential of ['EMAIL', 'PASSWORD', 'MFA_RECOVERY_CODES']) {
      assert.ok(critical.includes(`E2E_${role}_${credential}`), `${role} needs its own ${credential} browser fixture`);
    }
  }
  assert.match(critical, /signIn\(page, testInfo, sellerAccount\)/);
  assert.match(critical, /signIn\(page, testInfo, moderatorAccount\)/);
  assert.match(critical, /data-dashboard-workspace/);
  assert.match(critical, /#profileButton small/);
  assert.match(critical, /request\.get\('\/moderation\/products'[\s\S]*?denied\.status\(\)\)\.toBe\(403\)/);
  assert.match(critical, /request\.get\('\/seller\/products'[\s\S]*?denied\.status\(\)\)\.toBe\(403\)/);
  assert.match(critical, /MODERATION_FORBIDDEN/);
  assert.match(critical, /DASHBOARD_FORBIDDEN/);
  assert.doesNotMatch(critical, /process\.env\.(?:ADMIN_EMAIL|ADMIN_PASSWORD|E2E_ADMIN_MFA_RECOVERY_CODES)/);
  assert.match(critical, /refresh and browser back navigation/);
  assert.match(critical, /double activation/);
  assert.match(accessibility, /wcag22aa/);
  assert.match(accessibility, /AxeBuilder/);
  assert.match(accessibility, /keyboard focus reaches the skip link/);
  assert.match(accessibility, /400-percent equivalent reflow/);
  assert.match(accessibility, /reduced-motion preference/);
  assert.match(accessibility, /visible focus indicator/);
  assert.match(accessibility, /minimum target size/);
  assert.match(critical, /authenticated seller product tables become labelled phone cards/);
});

test('Node 24 CI installs the browser, seeds data, runs the gate and uploads diagnostics', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /node-version: '24\.x'/);
  assert.match(workflow, /node scripts\/seed\.js/);
  assert.match(workflow, /node scripts\/seed-browser-accounts\.js/);
  assert.match(workflow, /SIMPLE_LOGIN: 'false'/);
  assert.match(workflow, /PRIVILEGED_MFA_REQUIRED: 'true'/);
  assert.match(workflow, /CLASSIC_MART_E2E_LOOPBACK_ISOLATION: '1'/);
  for (const file of ['accessibility', 'critical-flows', 'image-corners', 'marketing-motion']) {
    assert.match(read(`tests/e2e/${file}.spec.js`), /from '\.\/browser-fixture\.js'/);
  }
  assert.match(workflow, /playwright install --with-deps chromium/);
  assert.match(workflow, /npm run browser:ci/);
  assert.match(workflow, /classic-mart-browser-diagnostics/);
});

test('dedicated browser fixtures are limited to isolated local test databases and protect credentials', () => {
  const fixture = read('scripts/seed-browser-accounts.js');
  assert.match(fixture, /process\.env\.NODE_ENV, 'test'/);
  assert.match(fixture, /'127\.0\.0\.1', 'localhost', '\[::1\]'/);
  assert.match(fixture, /classic_mart_ci/);
  assert.match(fixture, /classicmart_/);
  assert.match(fixture, /beginMfaEnrollment/);
  assert.match(fixture, /confirmMfaEnrollment/);
  assert.match(fixture, /role === 'moderator' \? 'customer' : role/);
  assert.match(fixture, /approvedByUserId: reviewer\._id/);
  assert.match(fixture, /'E2E_' \+ role\.toUpperCase\(\)/);
  assert.match(fixture, /::add-mask::/);
  assert.match(fixture, /process\.env\.GITHUB_ACTIONS, 'true'/);
  assert.match(fixture, /fs\.open\(target, 'wx', 0o600\)/);
  assert.doesNotMatch(fixture, /dropDatabase\(|deleteMany\(|updateMany\(/);
});

test('sanitized release includes browser gate sources', () => {
  const builder = read('scripts/build-release.js');
  assert.match(builder, /'playwright\.config\.js'/);
  assert.match(builder, /'tests'/);
});

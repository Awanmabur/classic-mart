import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../scripts/reset-admin-password.js', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('Super Admin password recovery is explicit, non-destructive and session revoking', () => {
  assert.equal(pkg.scripts['admin:reset-password'], 'node scripts/reset-admin-password.js');
  assert.match(source, /process\.argv\.includes\('--yes'\)/);
  assert.match(source, /ADMIN_RESET_PASSWORD/);
  assert.match(source, /role !== 'super_admin'/);
  assert.match(source, /session\.withTransaction/);
  assert.match(source, /passwordChangedAt/);
  assert.match(source, /tokenVersion/);
  assert.match(source, /failedLoginCount = 0/);
  assert.match(source, /Device\.updateMany/);
  assert.match(source, /admin_password_recovery/);
  assert.doesNotMatch(source, /rmSync|deleteMany|dropDatabase|\.classic-mart/);
});


test('fresh Super Admin bootstrap never hashes an empty or known default password', () => {
  const seed = fs.readFileSync(new URL('../scripts/seed.js', import.meta.url), 'utf8');
  assert.match(seed, /if \(!existingAdmin\)/);
  assert.match(seed, /generatedAdminPassword = `Cm!/);
  assert.match(seed, /ADMIN_PASSWORD is required before production/);
  assert.match(seed, /ChangeMe!2026Secure/);
  assert.match(seed, /assertStrongPassword\(bootstrapAdminPassword\)/);
  assert.match(seed, /hashPassword\(bootstrapAdminPassword\)/);
  assert.doesNotMatch(seed, /hashPassword\(env\.admin\.password\)/);
  assert.match(seed, /Fresh local Super Admin credentials:/);
});

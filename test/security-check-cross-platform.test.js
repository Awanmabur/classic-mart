import test from 'node:test';
import assert from 'node:assert/strict';
import { isSecurityChecker, normalizeProjectPath } from '../scripts/security-check-path.js';

test('security checker path normalization accepts POSIX and Windows separators', () => {
  assert.equal(normalizeProjectPath('scripts/security-check.js'), 'scripts/security-check.js');
  assert.equal(normalizeProjectPath('scripts\\security-check.js'), 'scripts/security-check.js');
  assert.equal(isSecurityChecker('scripts/security-check.js'), true);
  assert.equal(isSecurityChecker('scripts\\security-check.js'), true);
  assert.equal(isSecurityChecker('src\\services\\security.js'), false);
});

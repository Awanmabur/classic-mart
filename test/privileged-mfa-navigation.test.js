import assert from 'node:assert/strict';
import test from 'node:test';

import { requiresPrivilegedMfaForRequest } from '../src/middleware/privileged-mfa-paths.js';

function req(path, { method = 'GET', role = 'super_admin' } = {}) {
  return { path, method, user: { role } };
}

test('privileged MFA step-up does not trap marketplace and normal account navigation', () => {
  for (const path of ['/', '/products', '/categories', '/cart', '/wishlist', '/ask-classic', '/account/profile', '/account/orders', '/account/security', '/account/privacy', '/account/apps']) {
    assert.equal(requiresPrivilegedMfaForRequest(req(path)), false, `${path} should remain usable before privileged MFA enrollment`);
  }
});

test('privileged MFA step-up protects retained privileged headless APIs', () => {
  for (const path of ['/api/v1/finance/refunds', '/api/v1/seller/inventory', '/api/v1/admin/promoters/p_1/review', '/api/v1/payouts']) {
    assert.equal(requiresPrivilegedMfaForRequest(req(path)), true, `${path} must require privileged MFA`);
  }
});

test('non-privileged roles are never caught by the privileged MFA classifier', () => {
  for (const role of ['customer', 'promoter', 'business', 'delivery']) {
    assert.equal(requiresPrivilegedMfaForRequest(req('/api/v1/finance/refunds', { role })), false);
  }
});

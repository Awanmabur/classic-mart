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

test('warehouse pages and mutations require privileged MFA', () => {
  for (const path of ['/warehouse', '/warehouse/inventory', '/warehouse/tasks/wtk_test/execute', '/warehouse/reports/export.csv']) {
    assert.equal(requiresPrivilegedMfaForRequest(req(path, { role: 'warehouse' })), true);
  }
});

test('privileged MFA classification matches Express case-insensitive routing', () => {
  for (const path of ['/Seller/store', '/SELLER/products', '/SeLlEr/overview', '/WAREHOUSE/inventory',
    '/Moderation/verifications', '/FINANCE', '/ADMIN', '/Super-Admin', '/Operations/logistics',
    '/DASHBOARD/SELLER-STORE', '/API/V1/SELLER/inventory', '/Api/v1/FINANCE/refunds', '/API/v1/PAYOUTS']) {
    assert.equal(requiresPrivilegedMfaForRequest(req(path)), true, `${path} must enforce the same boundary as its canonical route`);
  }
  for (const path of ['/ACCOUNT/security', '/ACCOUNT/MFA/confirm', '/Logout', '/Products', '/sellerly', '/finance-reports']) {
    assert.equal(requiresPrivilegedMfaForRequest(req(path)), false, `${path} must not become a privileged surface`);
  }
});

test('non-privileged roles are never caught by the privileged MFA classifier', () => {
  for (const role of ['customer', 'promoter']) {
    assert.equal(requiresPrivilegedMfaForRequest(req('/api/v1/finance/refunds', { role })), false);
  }
});

test('Business and Delivery operations require MFA while personal security remains reachable', () => {
  for (const role of ['business', 'delivery']) {
    for (const path of [`/${role}/overview`, `/api/v1/${role}/records`, `/dashboard/${role}-overview`]) {
      assert.equal(requiresPrivilegedMfaForRequest(req(path, { role })), true, role + ':' + path);
    }
    for (const path of ['/account/profile', '/account/security', '/account/mfa/confirm', '/account/mfa/qr-code.png', '/logout']) {
      assert.equal(requiresPrivilegedMfaForRequest(req(path, { role })), false, role + ':' + path);
    }
  }
});

test('privileged roles can scan their pending MFA QR while operational actions remain protected', () => {
  for (const role of ['seller', 'business', 'delivery', 'warehouse', 'support', 'moderator', 'finance', 'country_admin', 'super_admin']) {
    assert.equal(requiresPrivilegedMfaForRequest(req('/account/mfa/qr-code.png', { role })), false);
    assert.equal(requiresPrivilegedMfaForRequest(req('/ACCOUNT/MFA/QR-CODE.PNG', { role })), false);
    assert.equal(requiresPrivilegedMfaForRequest(req('/api/v1/admin/staff', { role })), true);
  }
});

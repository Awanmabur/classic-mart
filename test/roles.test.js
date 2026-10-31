import test from 'node:test';
import assert from 'node:assert/strict';

const { hasPermission, roleLabel } = await import('../src/core/roles.js');

test('enforces role and account status', () => {
  assert.equal(
    hasPermission({ role: 'seller', status: 'active' }, 'catalogue:own'),
    true,
  );
  assert.equal(
    hasPermission({ role: 'customer', status: 'active' }, 'catalogue:own'),
    false,
  );
  assert.equal(hasPermission({ role: 'warehouse', status: 'active' }, 'warehouse:manage'), true);
  assert.equal(hasPermission({ role: 'support', status: 'active' }, 'warehouse:manage'), false);
  assert.equal(
    hasPermission({ role: 'super_admin', status: 'active' }, 'anything'),
    true,
  );
  assert.equal(hasPermission({ role: 'warehouse', status: 'active' }, 'warehouse:manage'), true);
  assert.equal(hasPermission({ role: 'support', status: 'active' }, 'warehouse:manage'), false);
  assert.equal(
    hasPermission({ role: 'super_admin', status: 'suspended' }, 'anything'),
    false,
  );
});

test('provides human-readable labels', () => {
  assert.equal(roleLabel('country_admin'), 'Country Admin');
  assert.equal(roleLabel('promoter'), 'Promoter');
  assert.equal(roleLabel('warehouse'), 'Warehouse Staff');
});

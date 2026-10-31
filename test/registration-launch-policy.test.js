import test from 'node:test';
import assert from 'node:assert/strict';
import { openRegistrationTypes, assertPublicRegistrationOpen, PUBLIC_ACCOUNT_TYPES } from '../src/core/registration.js';

test('production registration defaults to completed public workspaces', () => {
  const options = { production: true, configured: '' };
  assert.deepEqual(openRegistrationTypes(options), ['customer', 'seller', 'promoter']);
  for (const type of ['customer', 'seller', 'promoter']) assert.doesNotThrow(() => assertPublicRegistrationOpen(type, options));
  for (const type of ['business', 'delivery', 'super_admin', 'finance']) assert.throws(() => assertPublicRegistrationOpen(type, options), { code: 'REGISTRATION_NOT_OPEN' });
});

test('configuration can narrow launch registration but cannot enable unfinished workspaces', () => {
  const options = { production: true, configured: 'customer,seller,customer' };
  assert.deepEqual(openRegistrationTypes(options), ['customer', 'seller']);
  assert.throws(() => assertPublicRegistrationOpen('promoter', options), { code: 'REGISTRATION_NOT_OPEN' });
  for (const configured of ['business', 'delivery', 'customer,super_admin', ',,']) assert.throws(() => openRegistrationTypes({ production: true, configured }));
});

test('development retains explicit access to future public account types', () => {
  assert.deepEqual(openRegistrationTypes({ production: false, configured: 'customer' }), PUBLIC_ACCOUNT_TYPES);
});

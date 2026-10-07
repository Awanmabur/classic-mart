import test from 'node:test';
import assert from 'node:assert/strict';
import { sellerStoreIdentitySchema, sellerStoreOperationsSchema } from '../src/validation/seller-store.js';

test('store contact validation normalizes country-specific phones without granting verification', () => {
  const input = { version: '0', name: 'Real Store', supportEmail: 'SUPPORT@example.com', supportPhoneCountry: 'UG', supportPhone: '0781977217', status: 'verified', country: 'KE' };
  const result = sellerStoreIdentitySchema.parse(input);
  assert.equal(result.supportPhone, '+256781977217');
  assert.equal(result.supportEmail, 'support@example.com');
  assert.equal(result.status, undefined); assert.equal(result.country, undefined);
  for (const phone of ['123', '+25678197721799999', '+254712345678']) {
    assert.throws(() => sellerStoreIdentitySchema.parse({ ...input, supportPhone: phone }));
  }
  const kenyan = sellerStoreIdentitySchema.parse({ ...input, supportPhoneCountry: 'KE', supportPhone: '0712345678' });
  assert.equal(kenyan.supportPhone, '+254712345678');
  assert.equal(sellerStoreIdentitySchema.parse({ ...input, supportPhone: '' }).supportPhone, '');
  assert.throws(() => sellerStoreIdentitySchema.parse({ ...input, supportPhoneCountry: 'ZZ' }));
});

test('store changes require a revision and restrict operational fields and modes', () => {
  const identity = { name: 'Real Store', supportPhoneCountry: 'UG' };
  for (const version of [undefined, -1, 'bad', 0.5]) assert.throws(() => sellerStoreIdentitySchema.parse({ ...identity, version }));
  assert.throws(() => sellerStoreIdentitySchema.parse({ ...identity, version: 0, name: 'A' }));
  assert.throws(() => sellerStoreOperationsSchema.parse({ version: 0, fulfillmentMode: 'unlimited' }));
  const operations = sellerStoreOperationsSchema.parse({ version: 0, fulfillmentMode: 'merchant', status: 'verified', supportPhone: '123' });
  assert.deepEqual(operations, { version: 0, fulfillmentMode: 'merchant', primaryCategory: '', pickupCity: '' });
});

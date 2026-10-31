import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { User } = await import('../src/models/index.js');
const { saveShoppingCountry, shoppingCountryReturn } = await import('../src/services/shopping-country.js');
const { env } = await import('../src/config/env.js');

test('changing shopping country preserves home jurisdiction and fences concurrent account changes', async t => {
  const actor = { _id: 'actor', country: 'UG', shoppingCountry: 'UG', __v: 3, security: { tokenVersion: 4 } };
  const req = { user: actor };
  let calls = 0;
  t.mock.method(User, 'findOneAndUpdate', async (filter, update, options) => {
    calls++;
    assert.deepEqual(filter, { _id: 'actor', status: 'active', __v: 3, 'security.tokenVersion': 4 });
    assert.deepEqual(update, { $set: { shoppingCountry: 'KE', currency: 'KES' }, $inc: { __v: 1 } });
    assert.equal(options.runValidators, true);
    return { ...actor, shoppingCountry: 'KE', currency: 'KES', __v: 4 };
  });
  await saveShoppingCountry(req, { code: 'KE', currency: 'KES' });
  assert.equal(req.user.country, 'UG');
  assert.equal(req.user.shoppingCountry, 'KE');
  assert.equal(calls, 1);
  await saveShoppingCountry({}, { code: 'KE', currency: 'KES' });
  assert.equal(calls, 1);
});

test('failed preference save does not mutate the caller', async t => {
  const user = { _id: 'actor', __v: 3, security: { tokenVersion: 4 } };
  t.mock.method(User, 'findOneAndUpdate', async () => null);
  const req = { user };
  await assert.rejects(saveShoppingCountry(req, { code: 'KE', currency: 'KES' }), { status: 409, code: 'ACCOUNT_ACCESS_CHANGED' });
  assert.equal(req.user, user);
});

test('country return stays on site and replaces a prior explicit market URL', () => {
  assert.equal(shoppingCountryReturn('/', 'KE'), '/');
  assert.equal(shoppingCountryReturn('/products?country=UG&q=shirt', 'KE'), '/products?country=KE&q=shirt');
  assert.equal(shoppingCountryReturn(new URL('/categories?country=UG', env.baseUrl).href, 'KE'), '/categories?country=KE');
  for (const value of ['https://attacker.invalid/', '//attacker.invalid/', '/\\attacker.invalid/', '\u0000bad', null]) {
    assert.equal(shoppingCountryReturn(value, 'KE'), '/');
  }
});

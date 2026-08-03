import test from 'node:test';
import assert from 'node:assert/strict';
import { grantTrackedOrder, hasOrderGrant, orderAccessQuery } from '../src/services/order-access.js';

test('tracked order grant authorizes the exact order across a new cart session', () => {
  const request = { session: { cartKey: 'different-browser' } };
  grantTrackedOrder(request, 'ord_public_1');
  assert.equal(hasOrderGrant(request, 'ord_public_1'), true);
  assert.deepEqual(orderAccessQuery(request, 'ord_public_1'), { publicId: 'ord_public_1' });
  assert.deepEqual(orderAccessQuery(request, 'ord_public_2'), { publicId: 'ord_public_2', sessionKey: 'different-browser' });
});

test('expired tracked order grant does not authorize access', () => {
  const request = { session: { cartKey: 'guest-cart', orderGrants: { ord_expired: Date.now() - 1 } } };
  assert.equal(hasOrderGrant(request, 'ord_expired'), false);
  assert.deepEqual(orderAccessQuery(request, 'ord_expired'), { publicId: 'ord_expired', sessionKey: 'guest-cart' });
});

test('signed-in order access remains owner or current guest-cart scoped without a grant', () => {
  const request = { user: { _id: 'user-1' }, session: { cartKey: 'cart-1' } };
  assert.deepEqual(orderAccessQuery(request, 'ord_1'), {
    publicId: 'ord_1',
    $or: [{ userId: 'user-1' }, { sessionKey: 'cart-1' }],
  });
});

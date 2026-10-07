import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';
process.env.TOKEN_PEPPER = 'test-token-pepper-with-at-least-32-characters';

const { assertStockState, reserveStock } = await import('../src/services/inventory.js');

test('stock invariant computes sellable inventory after reserved, damaged and quarantined stock', () => {
  assert.deepEqual(assertStockState(20, 7), {
    onHand: 20,
    reserved: 7,
    damaged: 0,
    quarantined: 0,
    available: 13,
  });
  assert.deepEqual(assertStockState(20, 7, 2, 3), {
    onHand: 20,
    reserved: 7,
    damaged: 2,
    quarantined: 3,
    available: 8,
  });
});

test('stock invariant rejects overselling and invalid condition quantities', () => {
  assert.throws(() => assertStockState(5, 6), /negative/i);
  assert.throws(() => assertStockState(10, 4, 4, 3), /negative/i);
  assert.throws(() => assertStockState(-1, 0), /negative/i);
  assert.throws(() => assertStockState(1.5, 0), /whole numbers/i);
});

test('reservation service rejects unsafe quantities before database work', async () => {
  await assert.rejects(
    reserveStock({
      stockItemId: 'not-used', storeId: 'not-used', quantity: -4,
      idempotencyKey: 'test-reservation', actorUserId: 'not-used',
      expiresAt: new Date(Date.now() + 60_000),
    }),
    /positive whole number/i,
  );
});

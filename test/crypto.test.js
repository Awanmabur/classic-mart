import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';
process.env.TOKEN_PEPPER = 'test-token-pepper-with-at-least-32-characters';

const {
  hashPassword,
  hashToken,
  normalizeEmail,
  normalizePhone,
  safeEqual,
  verifyPassword,
} = await import('../src/core/crypto.js');
const { assertStrongPassword } = await import('../src/services/auth.js');

test('normalizes identities consistently', () => {
  assert.equal(normalizeEmail('  Person@Example.COM '), 'person@example.com');
  assert.equal(normalizePhone('+256 700-123-456'), '+256700123456');
});

test('hashes and verifies passwords without exposing plaintext', async () => {
  const password = 'SecureClassic9!';
  const hash = await hashPassword(password);
  assert.notEqual(hash, password);
  assert.equal(await verifyPassword(hash, password), true);
  assert.equal(await verifyPassword(hash, 'WrongPassword9!'), false);
});

test('enforces the password policy', () => {
  assert.doesNotThrow(() => assertStrongPassword('SecureClassic9!'));
  assert.throws(() => assertStrongPassword('short1A'));
  assert.throws(() => assertStrongPassword('alllowercase123'));
});

test('token hashes are deterministic and comparisons are timing safe', () => {
  assert.equal(hashToken('123456'), hashToken('123456'));
  assert.equal(safeEqual('same', 'same'), true);
  assert.equal(safeEqual('same', 'different'), false);
});

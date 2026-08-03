import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';
process.env.TOKEN_PEPPER = 'test-token-pepper-with-at-least-32-characters';
process.env.DATA_ENCRYPTION_KEY =
  'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

const { decryptSensitive, encryptSensitive } = await import(
  '../src/core/sensitive.js'
);

test('sensitive seller values use authenticated randomized encryption', () => {
  const first = encryptSensitive('UG-BR-12345');
  const second = encryptSensitive('UG-BR-12345');
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /UG-BR-12345/);
  assert.equal(decryptSensitive(first), 'UG-BR-12345');
});

test('tampered encrypted values cannot be decrypted', () => {
  const encrypted = encryptSensitive('TIN-12345');
  const tampered = `${encrypted.slice(0, -1)}x`;
  assert.throws(() => decryptSensitive(tampered), /could not be decrypted/i);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptPrivateBuffer, decryptPrivateBuffer } from '../src/core/sensitive.js';

test('private evidence encryption authenticates the bytes and storage identity with fresh nonces', () => {
  const plain = Buffer.from([0, 255, 2, 128, 42]);
  const key = 'verification-case/proof.cmv';
  const encrypted = encryptPrivateBuffer(plain, key);
  assert.deepEqual(decryptPrivateBuffer(encrypted, key), plain);
  assert.notDeepEqual(encryptPrivateBuffer(plain, key), encrypted);
  assert.throws(() => decryptPrivateBuffer(encrypted, 'verification-other/proof.cmv'), { code: 'PRIVATE_EVIDENCE_INVALID' });
  for (const index of [0, 5, 18, encrypted.length - 1]) {
    const tampered = Buffer.from(encrypted); tampered[index] ^= 1;
    assert.throws(() => decryptPrivateBuffer(tampered, key), { code: 'PRIVATE_EVIDENCE_INVALID' });
  }
  assert.throws(() => decryptPrivateBuffer(encrypted.subarray(0, 20), key), { code: 'PRIVATE_EVIDENCE_INVALID' });
});

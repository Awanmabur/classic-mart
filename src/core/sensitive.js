import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from './errors.js';

function encryptionKey() {
  const configured = env.dataEncryptionKey;
  if (/^[a-f0-9]{64}$/i.test(configured)) {
    return Buffer.from(configured, 'hex');
  }
  if (configured) {
    const decoded = Buffer.from(configured, 'base64');
    if (decoded.length === 32) return decoded;
  }
  return crypto.createHash('sha256').update(configured).digest();
}

export function encryptSensitive(value) {
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(value), 'utf8'),
    cipher.final(),
  ]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

export function decryptSensitive(value) {
  if (!value) return '';
  const [version, iv, tag, encrypted] = String(value).split(':');
  if (version !== 'v1' || !iv || !tag || !encrypted) {
    throw new AppError(
      'Sensitive record could not be decrypted.',
      500,
      'SENSITIVE_DATA_INVALID',
    );
  }
  try {
    const ivBuffer = Buffer.from(iv, 'base64url');
    const tagBuffer = Buffer.from(tag, 'base64url');
    const encryptedBuffer = Buffer.from(encrypted, 'base64url');
    // Node's base64url decoder accepts non-canonical encodings whose unused
    // trailing bits can be changed without changing the decoded bytes. Reject
    // those aliases so any textual tampering is detected deterministically.
    if (
      ivBuffer.toString('base64url') !== iv ||
      tagBuffer.toString('base64url') !== tag ||
      encryptedBuffer.toString('base64url') !== encrypted
    ) {
      throw new Error('Non-canonical sensitive encoding');
    }
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      ivBuffer,
    );
    decipher.setAuthTag(tagBuffer);
    return Buffer.concat([
      decipher.update(encryptedBuffer),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new AppError(
      'Sensitive record could not be decrypted.',
      500,
      'SENSITIVE_DATA_INVALID',
    );
  }
}

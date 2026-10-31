import { decryptPrivateBuffer } from '../core/sensitive.js';
import { readMediaObjectBuffer } from './object-storage.js';

export async function readVerificationDocumentBuffer(document) {
  const stored = await readMediaObjectBuffer(document.storageKey);
  return document.encrypted ? decryptPrivateBuffer(stored, document.storageKey) : stored;
}

export async function sendVerificationDocument(response, document) {
  const data = await readVerificationDocumentBuffer(document);
  response.set({ 'Cache-Control': 'private, no-store', 'Content-Type': 'image/webp', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow, noarchive' });
  return response.send(data);
}

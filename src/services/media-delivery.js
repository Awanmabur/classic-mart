import { readMediaObject } from './object-storage.js';

export async function sendStoredMedia(response, storageKey, {
  cacheControl = 'private, no-store',
  contentType = 'image/webp',
  contentDisposition = '',
} = {}) {
  const object = await readMediaObject(storageKey);
  response.setHeader('Cache-Control', cacheControl);
  response.setHeader('Content-Type', contentType || object.contentType || 'application/octet-stream');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (contentDisposition) response.setHeader('Content-Disposition', contentDisposition);
  if (object.etag) response.setHeader('ETag', object.etag);
  return response.send(object.body);
}

import { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, asyncHandler } from '../core/errors.js';
import { noStore } from '../middleware/request.js';
import { isMediaObjectNotFound } from '../services/object-storage.js';
import { readVerificationDocumentBuffer } from '../services/verification-media.js';
import { Store } from '../models/index.js';
import { writeAudit } from '../services/audit.js';
import { currentRequestDevice } from '../services/moderation-workspace-access.js';
import { sendStoredMedia } from '../services/media-delivery.js';
import { readableVerificationDocument } from '../services/seller-verification.js';
import { readableSellerProductImage } from '../services/seller-products.js';

const router = Router();
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const productPlaceholder = path.join(projectRoot, 'public', 'assets', 'product-placeholder.svg');

async function sendFirstStoredMedia(response, keys, options) {
  for (const key of keys.filter(Boolean)) {
    try {
      await sendStoredMedia(response, key, options);
      return true;
    } catch (error) {
      if (!isMediaObjectNotFound(error)) throw error;
    }
  }
  return false;
}

export async function sendCatalogueImage(request, response, { media, isPublic }, authorize) {
  if (!isPublic) response.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  const preferredKey = request.query.size === 'thumb' ? media.thumbnailStorageKey : media.storageKey;
  const sent = await sendFirstStoredMedia(response, [preferredKey, media.storageKey], {
    cacheControl: isPublic ? 'public, max-age=60, must-revalidate' : 'private, no-store',
    contentType: 'image/webp',
    authorize,
  });
  if (sent) return;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'image/svg+xml');
  response.setHeader('X-Classic-Mart-Media-Fallback', 'missing-object');
  return response.sendFile(productPlaceholder);
}

router.get('/media/catalogue/:publicId', asyncHandler(async (request, response) => {
  const initial = await readableSellerProductImage(request, request.params.publicId);
  return sendCatalogueImage(request, response, initial, async () => {
      const current = await readableSellerProductImage(request, request.params.publicId);
      if (current.isPublic !== initial.isPublic || current.media.storageKey !== initial.media.storageKey || current.media.thumbnailStorageKey !== initial.media.thumbnailStorageKey) {
        throw new AppError('Image not found.', 404, 'MEDIA_NOT_FOUND');
      }
  });
}));

router.get('/media/verification/:publicId', noStore, asyncHandler(async (request, response) => {
  const document = await readableVerificationDocument(request, request.params.publicId);
  const data = await readVerificationDocumentBuffer(document);
  await readableVerificationDocument(request, request.params.publicId);
  await currentRequestDevice(request);
  const store = await Store.findById(document.storeId).select('country').lean();
  await writeAudit(request, 'seller.verification_document_viewed', { targetType: 'verification_document',
    targetPublicId: document.publicId, country: store?.country });
  await readableVerificationDocument(request, request.params.publicId);
  await currentRequestDevice(request);
  response.set({ 'Cache-Control': 'private, no-store', 'Content-Type': 'image/webp', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow, noarchive' });
  return response.send(data);
}));

export default router;

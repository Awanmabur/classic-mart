import { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asyncHandler, AppError } from '../core/errors.js';
import { hasPermission } from '../core/roles.js';
import { Product, ProductMedia, Store, VerificationDocument } from '../models/index.js';
import { noStore } from '../middleware/request.js';
import { isMediaObjectNotFound } from '../services/object-storage.js';
import { sendStoredMedia } from '../services/media-delivery.js';

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

router.get('/media/catalogue/:publicId', asyncHandler(async (request, response) => {
  const media = await ProductMedia.findOne({ publicId: request.params.publicId }).select('+storageKey +thumbnailStorageKey');
  if (!media) throw new AppError('Media not found.', 404, 'MEDIA_NOT_FOUND');
  const product = await Product.findById(media.productId).select('ownerUserId status countries');
  const mayModerate = hasPermission(request.user, 'catalogue:moderate') && (request.user.role !== 'country_admin' || product?.countries.includes(request.user.country));
  const isPublic = media.status === 'approved' && product?.status === 'published';
  const mayPreview = isPublic || String(product?.ownerUserId) === String(request.user?._id) || mayModerate;
  if (!mayPreview) throw new AppError('Media not found.', 404, 'MEDIA_NOT_FOUND');
  const preferredKey = request.query.size === 'thumb' ? media.thumbnailStorageKey : media.storageKey;
  const sent = await sendFirstStoredMedia(response, [preferredKey, media.storageKey], {
    cacheControl: isPublic ? 'public, max-age=300, stale-while-revalidate=3600' : 'private, no-store',
    contentType: 'image/webp',
  });
  if (sent) return;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'image/svg+xml');
  response.setHeader('X-Classic-Mart-Media-Fallback', 'missing-object');
  return response.sendFile(productPlaceholder);
}));

router.get('/media/verification/:publicId', noStore, asyncHandler(async (request, response) => {
  if (!request.user) throw new AppError('Authentication required.', 401, 'UNAUTHENTICATED');
  const document = await VerificationDocument.findOne({ publicId: request.params.publicId }).select('+storageKey');
  if (!document) throw new AppError('Document not found.', 404, 'DOCUMENT_NOT_FOUND');
  let mayModerate = hasPermission(request.user, 'catalogue:moderate');
  if (mayModerate && request.user.role === 'country_admin') {
    mayModerate = Boolean(await Store.exists({ _id: document.storeId, country: request.user.country }));
  }
  const mayView = String(document.userId) === String(request.user._id) || mayModerate;
  if (!mayView) throw new AppError('Document not found.', 404, 'DOCUMENT_NOT_FOUND');
  return sendStoredMedia(response, document.storageKey, {
    cacheControl: 'private, no-store',
    contentType: 'image/webp',
    contentDisposition: 'inline',
  });
}));

export default router;

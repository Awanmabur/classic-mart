import { Router } from 'express';
import { AppError, asyncHandler } from '../core/errors.js';
import { readablePublicCatalogueImage } from '../services/public-catalogue-media.js';
import { sendCatalogueImage } from './media.js';

const router = Router();

router.get('/media/catalogue/:publicId', asyncHandler(async (request, response, next) => {
  const initial = await readablePublicCatalogueImage(request.params.publicId);
  if (!initial) return next();
  return sendCatalogueImage(request, response, initial, async () => {
    const current = await readablePublicCatalogueImage(request.params.publicId);
    if (!current || current.media.storageKey !== initial.media.storageKey
      || current.media.thumbnailStorageKey !== initial.media.thumbnailStorageKey) {
      throw new AppError('Image not found.', 404, 'MEDIA_NOT_FOUND');
    }
  });
}));

export default router;

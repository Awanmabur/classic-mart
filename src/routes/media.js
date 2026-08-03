import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asyncHandler, AppError } from '../core/errors.js';
import { hasPermission } from '../core/roles.js';
import {
  Product,
  ProductMedia,
  Store,
  VerificationDocument,
} from '../models/index.js';
import { noStore } from '../middleware/request.js';
import { resolveUploadPath } from '../services/media.js';

const router = Router();
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const productPlaceholder = path.join(
  projectRoot,
  'public',
  'assets',
  'product-placeholder.svg',
);

async function firstReadablePath(keys) {
  for (const key of keys.filter(Boolean)) {
    try {
      const candidate = resolveUploadPath(key);
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue to the original image or the built-in safe placeholder.
    }
  }
  return productPlaceholder;
}

router.get(
  '/media/catalogue/:publicId',
  asyncHandler(async (request, response) => {
    const media = await ProductMedia.findOne({
      publicId: request.params.publicId,
    }).select('+storageKey +thumbnailStorageKey');
    if (!media) throw new AppError('Media not found.', 404, 'MEDIA_NOT_FOUND');
    const product = await Product.findById(media.productId).select(
      'ownerUserId status countries',
    );
    const mayModerate =
      hasPermission(request.user, 'catalogue:moderate') &&
      (request.user.role !== 'country_admin' ||
        product?.countries.includes(request.user.country));
    const isPublic =
      media.status === 'approved' && product?.status === 'published';
    const mayPreview =
      isPublic ||
      String(product?.ownerUserId) === String(request.user?._id) ||
      mayModerate;
    if (!mayPreview) {
      throw new AppError('Media not found.', 404, 'MEDIA_NOT_FOUND');
    }
    response.setHeader(
      'Cache-Control',
      isPublic
        ? 'public, max-age=86400, immutable'
        : 'no-store, private',
    );
    response.setHeader('Content-Type', 'image/webp');
    const preferredKey =
      request.query.size === 'thumb'
        ? media.thumbnailStorageKey
        : media.storageKey;
    const mediaPath = await firstReadablePath([
      preferredKey,
      media.storageKey,
    ]);
    if (mediaPath === productPlaceholder) {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'image/svg+xml');
      response.setHeader('X-Classic-Mart-Media-Fallback', 'missing-file');
    }
    return response.sendFile(mediaPath);
  }),
);

router.get(
  '/media/verification/:publicId',
  noStore,
  asyncHandler(async (request, response) => {
    if (!request.user) {
      throw new AppError('Authentication required.', 401, 'UNAUTHENTICATED');
    }
    const document = await VerificationDocument.findOne({
      publicId: request.params.publicId,
    }).select('+storageKey');
    if (!document) {
      throw new AppError('Document not found.', 404, 'DOCUMENT_NOT_FOUND');
    }
    let mayModerate = hasPermission(request.user, 'catalogue:moderate');
    if (mayModerate && request.user.role === 'country_admin') {
      mayModerate = Boolean(
        await Store.exists({
          _id: document.storeId,
          country: request.user.country,
        }),
      );
    }
    const mayView =
      String(document.userId) === String(request.user._id) || mayModerate;
    if (!mayView) {
      throw new AppError('Document not found.', 404, 'DOCUMENT_NOT_FOUND');
    }
    response.setHeader('Content-Type', 'image/webp');
    response.setHeader('Content-Disposition', 'inline');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return response.sendFile(resolveUploadPath(document.storageKey));
  }),
);

export default router;

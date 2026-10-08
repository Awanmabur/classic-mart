import crypto from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import sharp from 'sharp';
import { encryptPrivateBuffer } from '../core/sensitive.js';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { scanUpload } from './malware.js';
import { deleteMediaObject, putMediaObject } from './object-storage.js';
import { EvidenceDocument, ProductMedia, VerificationDocument } from '../models/index.js';

const acceptedInputTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
]);

export const uploadProductImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 8, fieldArrayIndexLimit: 16 },
  fileFilter(_request, file, callback) {
    if (!acceptedInputTypes.has(file.mimetype)) {
      return callback(
        new AppError(
          'Upload a JPEG, PNG, WebP or AVIF image.',
          422,
          'MEDIA_TYPE_INVALID',
        ),
      );
    }
    return callback(null, true);
  },
}).single('image');

export const uploadVerificationImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 8, fieldArrayIndexLimit: 16 },
  fileFilter(_request, file, callback) {
    if (!acceptedInputTypes.has(file.mimetype)) {
      return callback(
        new AppError(
          'Upload a JPEG, PNG, WebP or AVIF image.',
          422,
          'MEDIA_TYPE_INVALID',
        ),
      );
    }
    return callback(null, true);
  },
}).single('document');

async function sanitizeImage(file, limitInputPixels = 40_000_000) {
  if (!file?.buffer) {
    throw new AppError('Choose an image to upload.', 422, 'MEDIA_REQUIRED');
  }
  await scanUpload(file.buffer);
  let metadata;
  try {
    metadata = await sharp(file.buffer, {
      failOn: 'warning',
      limitInputPixels,
    }).metadata();
  } catch {
    throw new AppError(
      'The uploaded file is not a valid image.',
      422,
      'MEDIA_INVALID',
    );
  }
  if (
    !['jpeg', 'png', 'webp', 'avif'].includes(metadata.format) ||
    !metadata.width ||
    !metadata.height ||
    metadata.width < 320 ||
    metadata.height < 320
  ) {
    throw new AppError(
      'Image must be a valid raster image at least 320 × 320 pixels.',
      422,
      'MEDIA_DIMENSIONS_INVALID',
    );
  }

  return sharp(file.buffer, {
    failOn: 'warning',
    limitInputPixels,
  })
    .rotate()
    .resize({
      width: 2_400,
      height: 2_400,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 84, effort: 5 })
    .toBuffer({ resolveWithObject: true });
}

async function writeSanitizedImage(directoryName, sanitized) {
  const filename = `${crypto.randomUUID()}.webp`;
  const storageKey = `${directoryName}/${filename}`;
  await putMediaObject(storageKey, sanitized.data, {
    contentType: 'image/webp',
    cacheControl: 'private, no-store',
  });
  return { storageKey };
}

export async function sanitizeAndStoreProductImage({
  file,
  product,
  altText,
  position,
}) {
  const prepared = await prepareProductImage(file, product.publicId);
  try {
    return await ProductMedia.create({ publicId: publicId('med'), productId: product._id, storeId: product.storeId,
      ...prepared, altText, position, status: 'ready' });
  } catch (error) {
    await deleteMediaObject(prepared.storageKey).catch(() => {});
    await deleteMediaObject(prepared.thumbnailStorageKey).catch(() => {});
    throw error;
  }
}

export async function prepareProductImage(file, productPublicId) {
  const sanitized = await sanitizeImage(file, 16_000_000);
  const thumbnail = await sharp(sanitized.data)
    .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80, effort: 5 })
    .toBuffer({ resolveWithObject: true });
  let stored, thumbnailStored;
  try {
    stored = await writeSanitizedImage(productPublicId, sanitized);
    thumbnailStored = await writeSanitizedImage(productPublicId, thumbnail);
    return {
      storageKey: stored.storageKey,
      thumbnailStorageKey: thumbnailStored.storageKey,
      originalName: path.basename(file.originalname).slice(0, 180),
      mimeType: 'image/webp',
      sizeBytes: sanitized.data.length,
      width: sanitized.info.width,
      height: sanitized.info.height,
      checksumSha256: crypto
        .createHash('sha256')
        .update(sanitized.data)
        .digest('hex'),
    };
  } catch (error) {
    if (stored) await deleteMediaObject(stored.storageKey).catch(() => {});
    if (thumbnailStored) await deleteMediaObject(thumbnailStored.storageKey).catch(() => {});
    throw error;
  }
}

export async function sanitizeAndStoreVerificationDocument({
  file,
  verification,
  store,
  user,
  documentType,
}) {
  const prepared = await prepareVerificationDocument(file, verification.publicId);
  try {
    return await VerificationDocument.create({
      publicId: publicId('doc'),
      verificationId: verification._id,
      storeId: store._id,
      userId: user._id,
      documentType,
      ...prepared,
    });
  } catch (error) {
    await deleteMediaObject(prepared.storageKey).catch(() => {});
    throw error;
  }
}

export async function prepareVerificationDocument(file, verificationPublicId) {
  const sanitized = await sanitizeImage(file, 16_000_000);
  const storageKey = `verification-${verificationPublicId}/${crypto.randomUUID()}.cmv`;
  await putMediaObject(storageKey, encryptPrivateBuffer(sanitized.data, storageKey), { contentType: 'application/octet-stream', cacheControl: 'private, no-store' });
  return { storageKey, encrypted: true, mimeType: 'image/webp', sizeBytes: sanitized.data.length,
    width: sanitized.info.width, height: sanitized.info.height,
    checksumSha256: crypto.createHash('sha256').update(sanitized.data).digest('hex') };
}


export async function sanitizeAndStoreEvidenceImage({ file, user, country, contextType, contextPublicId, description = '', documentType = 'general' }) {
  const sanitized = await sanitizeImage(file);
  const stored = await writeSanitizedImage(`evidence-${contextType}-${contextPublicId}`, sanitized);
  try {
    return await EvidenceDocument.create({
      publicId: publicId('evd'), ownerUserId: user._id, country, contextType, contextPublicId,
      storageKey: stored.storageKey, mimeType: 'image/webp', size: sanitized.data.length, documentType,
      status: 'ready', description: String(description || '').slice(0, 300),
    });
  } catch (error) {
    await deleteMediaObject(stored.storageKey).catch(() => {});
    throw error;
  }
}

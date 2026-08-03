import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Product, ProductMedia } from '../models/index.js';
import { getStorefront } from './storefront.js';
import { resolveUploadPath } from './media.js';
import { AppError } from '../core/errors.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const signatureCache = new Map();
const SIGNATURE_SIDE = 14;
const MAX_CANDIDATES = 120;

async function signature(input) {
  let result;
  try {
    result = await sharp(input, { failOn: 'warning', limitInputPixels: 25_000_000 })
      .rotate()
      .resize(SIGNATURE_SIDE, SIGNATURE_SIDE, { fit: 'cover', position: 'attention' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new AppError('The selected file is not a valid product image.', 422, 'VISUAL_SEARCH_IMAGE_INVALID');
  }
  const values = [...result.data];
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const centered = values.map((value) => (value - mean) / 255);
  return { values: centered, width: result.info.width, height: result.info.height };
}

function distance(left, right) {
  if (!left?.values?.length || left.values.length !== right?.values?.length) return Number.POSITIVE_INFINITY;
  let total = 0;
  for (let index = 0; index < left.values.length; index += 1) {
    const delta = left.values[index] - right.values[index];
    total += delta * delta;
  }
  return Math.sqrt(total / left.values.length);
}

function mediaPath(media) {
  if (media.source === 'seed_asset') {
    const safeName = path.basename(String(media.originalName || ''));
    return path.join(root, 'public', 'assets', 'products', safeName);
  }
  return resolveUploadPath(media.thumbnailStorageKey || media.storageKey);
}

async function mediaSignature(media) {
  const cacheKey = `${media.publicId}:${media.updatedAt?.getTime?.() || 0}:${media.sizeBytes || 0}`;
  if (signatureCache.has(cacheKey)) return signatureCache.get(cacheKey);
  const computed = await signature(mediaPath(media));
  signatureCache.set(cacheKey, computed);
  if (signatureCache.size > 600) signatureCache.delete(signatureCache.keys().next().value);
  return computed;
}

export async function visualSearchProducts(country, imageBuffer, { limit = 16 } = {}) {
  const querySignature = await signature(imageBuffer);
  const productRows = await Product.find({ status: 'published', countries: country.code })
    .select('_id publicId')
    .sort({ publishedAt: -1, _id: -1 })
    .limit(MAX_CANDIDATES)
    .lean();
  if (!productRows.length) return [];

  const mediaRows = await ProductMedia.find({
    productId: { $in: productRows.map((product) => product._id) },
    status: { $in: ['ready', 'approved'] },
  })
    .select('+storageKey +thumbnailStorageKey publicId productId source originalName sizeBytes position updatedAt')
    .sort({ productId: 1, position: 1, createdAt: 1 })
    .lean();

  const primaryMedia = new Map();
  for (const media of mediaRows) {
    const key = String(media.productId);
    if (!primaryMedia.has(key)) primaryMedia.set(key, media);
  }

  const scored = [];
  for (const product of productRows) {
    const media = primaryMedia.get(String(product._id));
    if (!media) continue;
    try {
      const candidate = await mediaSignature(media);
      scored.push({ id: product.publicId, score: distance(querySignature, candidate) });
    } catch {
      // Skip media that is missing or no longer decodable without failing the whole search.
    }
  }

  const catalogue = await getStorefront(country);
  const byId = new Map((catalogue.products || []).map((product) => [product.id, product]));
  const ranked = scored
    .filter((item) => Number.isFinite(item.score) && byId.has(item.id))
    .sort((a, b) => a.score - b.score)
    .slice(0, Math.max(1, Math.min(40, Number(limit) || 16)))
    .map((item) => ({ ...byId.get(item.id), visualMatchScore: Number((1 / (1 + item.score)).toFixed(4)) }));

  return ranked.length ? ranked : (catalogue.products || []).slice(0, Math.max(1, Math.min(40, Number(limit) || 16)));
}

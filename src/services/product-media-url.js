import { env } from '../config/env.js';

const SEED_ASSET = /^[a-z0-9][a-z0-9_-]*\.(?:svg|jpe?g|png|webp)$/i;

export function publicProductImageUrl(media, thumbnail = true) {
  if (!media) return '/assets/product-placeholder.svg';
  if (
    env.mediaStorageDriver !== 'r2' &&
    media.source === 'seed_asset' &&
    SEED_ASSET.test(String(media.originalName || ''))
  ) {
    return `/assets/products/${encodeURIComponent(media.originalName)}`;
  }
  return `/media/catalogue/${encodeURIComponent(media.publicId)}${thumbnail ? '?size=thumb' : ''}`;
}

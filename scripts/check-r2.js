import { ensureMediaStorageReady } from '../src/services/object-storage.js';

try {
  await ensureMediaStorageReady();
  console.log('Cloudflare R2 media storage is ready.');
} catch (error) {
  console.error('Cloudflare R2 media storage check failed:', error?.message || error);
  process.exitCode = 1;
}

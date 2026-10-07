import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';
process.env.TOKEN_PEPPER = 'test-token-pepper-with-at-least-32-characters';
process.env.REDIS_URL = '';

const { createApp } = await import('../src/app.js');
const {
  Product,
  ProductMedia,
  ProductVariant,
  SellerVerification,
  StockItem,
} = await import('../src/models/index.js');
const { normalizeMediaStorageKey } = await import('../src/services/object-storage.js');
const { sanitizeAndStoreProductImage } = await import('../src/services/media.js');
const app = createApp(null);

function hasUniqueIndex(model, expectedKeys) {
  return model.schema.indexes().some(([keys, options]) => {
    return (
      options.unique === true &&
      Object.entries(expectedKeys).every(([key, value]) => keys[key] === value)
    );
  });
}

test('seller and moderation routes are protected on the server', async () => {
  await request(app)
    .get('/seller')
    .expect(302)
    .expect('location', '/login?next=%2Fseller');
  await request(app)
    .get('/moderation')
    .expect(302)
    .expect('location', '/login?next=%2Fmoderation');
});

test('ownership-critical collections enforce scoped uniqueness', () => {
  assert.equal(hasUniqueIndex(Product, { storeId: 1, slug: 1 }), true);
  assert.equal(hasUniqueIndex(ProductVariant, { storeId: 1, sku: 1 }), true);
  assert.equal(
    hasUniqueIndex(StockItem, { warehouseId: 1, variantId: 1 }),
    true,
  );
});

test('sensitive and storage fields are excluded by default', () => {
  assert.equal(
    SellerVerification.schema.path('registrationNumber').options.select,
    false,
  );
  assert.equal(ProductMedia.schema.path('storageKey').options.select, false);
  assert.equal(
    ProductMedia.schema.path('checksumSha256').options.select,
    false,
  );
});

test('active media storage normalization rejects traversal and image sanitization rejects SVG payloads', async () => {
  for(const key of ['../private.env','prd/../private.env','prd\\..\\private.env','prd/%2e%2e/private.env']) assert.throws(()=>normalizeMediaStorageKey(key),/Invalid media storage key/);
  assert.equal(normalizeMediaStorageKey('prd_123/123e4567-e89b-12d3-a456-426614174000.webp'),'prd_123/123e4567-e89b-12d3-a456-426614174000.webp');
  await assert.rejects(sanitizeAndStoreProductImage({file:{buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400"/></svg>')},product:{publicId:'prd_test'},altText:'Unsafe SVG',position:0}),error=>['MEDIA_INVALID','MEDIA_TYPE_INVALID','MEDIA_DIMENSIONS_INVALID'].includes(error.code));
});

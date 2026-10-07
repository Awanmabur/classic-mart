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
const { resolveUploadPath } = await import('../src/services/media.js');
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
    .get('/seller/products')
    .expect(302)
    .expect('location', '/login?next=%2Fseller%2Fproducts');
  await request(app)
    .get('/moderation/products')
    .expect(302)
    .expect('location', '/login?next=%2Fmoderation%2Fproducts');
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

test('media path resolver rejects traversal and non-WebP storage keys', () => {
  assert.throws(
    () => resolveUploadPath('../private.env'),
    /media not found/i,
  );
  assert.throws(
    () => resolveUploadPath('prd_123/payload.svg'),
    /media not found/i,
  );
  assert.match(
    resolveUploadPath(
      'prd_123/123e4567-e89b-12d3-a456-426614174000.webp',
    ),
    /storage[\\/]uploads/,
  );
  assert.match(
    resolveUploadPath('prd_seed_headphones/seed.webp'),
    /storage[\\/]uploads/,
  );
});

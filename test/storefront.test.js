import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';
process.env.TOKEN_PEPPER = 'test-token-pepper-with-at-least-32-characters';

const { assembleStorefront } = await import(
  '../src/services/storefront.js'
);
const { CustomerCatalogueState, SellerContactRequest } = await import(
  '../src/models/index.js'
);

const objectId = () => new mongoose.Types.ObjectId();

test('assembles the public catalogue in batches without leaking Mongo IDs', () => {
  const productId = objectId();
  const variantId = objectId();
  const categoryId = objectId();
  const brandId = objectId();
  const storeId = objectId();
  const result = assembleStorefront({
    country: {
      code: 'UG',
      name: 'Uganda',
      currency: 'UGX',
      locale: 'en-UG',
    },
    products: [
      {
        _id: productId,
        publicId: 'prd_public_headphones',
        storeId,
        categoryId,
        brandId,
        title: 'Published Headphones',
        description: 'A complete published product description.',
        publishedAt: new Date(),
      },
    ],
    variants: [
      {
        _id: variantId,
        publicId: 'var_public_default',
        productId,
        title: 'Default',
        sku: 'HEAD-001',
        priceMinor: 125_000,
        compareAtMinor: 150_000,
        currency: 'UGX',
      },
    ],
    media: [
      {
        publicId: 'med_public_image',
        productId,
        altText: 'Headphones',
      },
    ],
    stock: [{ _id: variantId, available: 7 }],
    categories: [
      {
        _id: categoryId,
        publicId: 'cat_electronics',
        slug: 'electronics',
        name: 'Electronics',
        description: 'Technology products.',
      },
    ],
    brands: [
      {
        _id: brandId,
        publicId: 'brand_classic',
        slug: 'classic',
        name: 'Classic',
      },
    ],
    stores: [
      {
        _id: storeId,
        publicId: 'store_classic',
        slug: 'classic-mart',
        name: 'Classic Mart',
        description: 'Verified store.',
        country: 'UG',
        currency: 'UGX',
        status: 'verified',
      },
    ],
  });

  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].id, 'prd_public_headphones');
  assert.equal(result.products[0].price, 125_000);
  assert.equal(result.products[0].stock, 7);
  assert.equal(
    result.products[0].image,
    '/media/catalogue/med_public_image?size=thumb',
  );
  assert.equal('_id' in result.products[0], false);
  assert.equal(result.categories[0].count, 1);
  assert.equal(result.sellers[0].productCount, 1);
});

test('customer catalogue state enforces bounded server-side collections', () => {
  assert.equal(
    CustomerCatalogueState.schema.path('wishlistProductIds').options.validate
      .validator(new Array(500).fill(objectId())),
    true,
  );
  assert.equal(
    CustomerCatalogueState.schema.path('wishlistProductIds').options.validate
      .validator(new Array(501).fill(objectId())),
    false,
  );
  assert.equal(
    CustomerCatalogueState.schema.path('comparisonProductIds').options.validate
      .validator(new Array(5).fill(objectId())),
    false,
  );
  assert.ok(SellerContactRequest.schema.indexes().length > 0);
});

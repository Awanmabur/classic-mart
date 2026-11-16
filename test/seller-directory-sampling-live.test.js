import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;

test('public sellers fairly sample products per verified store after genuine database eligibility', { skip: !uri, timeout: 120_000 }, async () => {
  const connection = new URL(uri);
  assert.ok(['127.0.0.1', 'localhost'].includes(connection.hostname));
  assert.match(connection.pathname, /test|verification/i);

  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: 'classicmart_seller_sample_test_' + suffix, serverSelectionTimeoutMS: 10_000 });
  try {
    const { Store, Category, Product, ProductVariant, ProductMedia } = await import('../src/models/index.js');
    const { publishedSellers, clearStorefrontCache, publicSellerSampleStages } = await import('../src/services/storefront.js');
    for (const Model of Object.values(mongoose.models)) await Model.init();

    const country = { code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG' };
    const owner = new mongoose.Types.ObjectId();
    const categoryId = new mongoose.Types.ObjectId();
    const restrictedCategoryId = new mongoose.Types.ObjectId();

    await Category.collection.insertMany([
      { _id: categoryId, publicId: 'cat_public_' + suffix, name: 'Visible goods', slug: 'goods-' + suffix,
        active: true, restricted: false, countries: ['UG'] },
      { _id: restrictedCategoryId, publicId: 'cat_restricted_' + suffix, name: 'Restricted goods',
        slug: 'restricted-' + suffix, active: true, restricted: true, countries: ['UG'] },
    ]);

    const stores = Array.from({ length: 2 }, (_, index) => ({
      _id: new mongoose.Types.ObjectId(),
      publicId: 'str_sample_' + suffix + '_' + index,
      ownerUserId: owner,
      name: 'Verified sample seller ' + index,
      slug: 'sample-' + suffix + '-' + index,
      country: 'UG', currency: 'UGX', status: 'verified',
      createdAt: new Date(Date.now() - index * 1000),
    }));
    await Store.collection.insertMany(stores);

    const products = [], variants = [], media = [];
    let counter = 0;
    for (let storeNo = 0; storeNo < stores.length; storeNo++) {
      for (let i = 0; i < 13; i++) {
        const productId = new mongoose.Types.ObjectId();
        const valid = i < 10;
        const restricted = i === 11;
        const product = {
          _id: productId,
          publicId: 'prd_sample_' + suffix + '_' + counter,
          storeId: stores[storeNo]._id, ownerUserId: owner,
          categoryId: restricted ? restrictedCategoryId : categoryId,
          title: 'Approved sample ' + storeNo + ' ' + i,
          slug: 'sample-' + suffix + '-' + counter,
          status: i === 12 ? 'draft' : 'published',
          countries: ['UG'],
          publishedAt: new Date(Date.now() - (storeNo * 100 + i) * 1000),
          moderation: { riskLevel: 'low' },
        };
        products.push(product);
        variants.push({
          _id: new mongoose.Types.ObjectId(),
          publicId: 'var_sample_' + suffix + '_' + counter,
          productId, storeId: stores[storeNo]._id,
          active: true,
          title: 'Default',
          sku: 'SAMPLE-' + suffix + '-' + counter,
          currency: valid || restricted ? 'UGX' : 'KES',
          priceMinor: 1000 + i,
        });
        media.push({
          _id: new mongoose.Types.ObjectId(),
          publicId: 'med_sample_' + suffix + '_' + counter,
          productId, storeId: stores[storeNo]._id,
          status: 'approved', source: 'seed_asset',
          originalName: 'wireless-headphones.svg',
          position: 0, createdAt: new Date(Date.now() + i),
        });
        counter++;
      }
    }
    await Promise.all([
      Product.collection.insertMany(products),
      ProductVariant.collection.insertMany(variants),
      ProductMedia.collection.insertMany(media),
    ]);

    clearStorefrontCache();
    const first = await publishedSellers(country, { limit: 50 });
    assert.equal(first.items.length, 2, 'both verified sellers remain visible');
    assert.equal(first.page.total, 2);
    const bySlug = new Map(first.items.map(row => [row.slug, row]));
    for (const store of stores) {
      const seller = bySlug.get(store.slug);
      assert.ok(seller, 'missing seller ' + store.slug);
      assert.equal(seller.productCount, 10, 'count excludes draft, restricted and wrong-currency variants');
      assert.equal(seller.productImages.length, 4, 'four eligible sample thumbnails per seller');
      assert.equal(seller.image.startsWith('/assets/products/'), true);
      assert.deepEqual(seller.categories, ['Visible goods']);
      assert.equal(seller.verified, true);
      assert.equal(seller.followed, false);
      for (const sensitive of ['_id', 'ownerUserId', 'moderation', 'variants', 'userMongoId', 'earnedMinor']) {
        assert.equal(Object.hasOwn(seller, sensitive), false, sensitive + ' leaked');
      }
    }

    const eligibleSample = await Product.aggregate([
      { $match: { storeId: { $in: stores.map(store => store._id) }, status: 'published', countries: 'UG' } },
      ...publicSellerSampleStages(country),
    ]);
    const perStore = new Map();
    for (const product of eligibleSample) {
      const id = String(product.storeId);
      perStore.set(id, (perStore.get(id) || 0) + 1);
      assert.equal(product._publicCategory?.name, 'Visible goods');
    }
    assert.deepEqual(stores.map(store => perStore.get(String(store._id))), [8, 8],
      'sampling must be per-store, not one global top-N');
    clearStorefrontCache();
  } finally {
    try { await mongoose.connection.dropDatabase(); } finally { await mongoose.disconnect(); }
  }
});

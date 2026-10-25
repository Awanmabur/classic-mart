import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;

test('catalogue summaries stay personal and fresh without loading complete products or private histories', { skip: !uri, timeout: 120_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /test|verification/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: 'classicmart_catalogue_read_test_' + suffix, monitorCommands: true });
  const commands = [];
  const monitor = event => {
    if (['find', 'aggregate'].includes(event.commandName)) commands.push(event.command);
  };
  mongoose.connection.getClient().on('commandStarted', monitor);
  try {
    const models = await import('../src/models/index.js');
    const { CountrySetting, User, Store, Category, Product, ProductVariant, ProductMedia, StockItem, Warehouse, CustomerCatalogueState, Order, Review } = models;
    const { createApp } = await import('../src/app.js');
    const { hashPassword } = await import('../src/core/crypto.js');
    const { publishedProduct, publicCatalogueIdentityMap, getStorefront, clearStorefrontCache } = await import('../src/services/storefront.js');
    for (const Model of Object.values(mongoose.models)) await Model.init();
    const country = (await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256' })).toObject();
    const password = 'Catalogue-' + suffix + '-A1!', passwordHash = await hashPassword(password);
    const actor = n => User.create({ publicId: `usr_cat_${suffix}_${n}`, name: 'Catalogue fixture', email: `catalogue-${suffix}-${n}@example.com`,
      emailNormalized: `catalogue-${suffix}-${n}@example.com`, phone: '+25670000000' + n, phoneNormalized: '+25670000000' + n,
      passwordHash, role: 'customer', status: 'active', country: 'UG', currency: 'UGX', emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(),
      onboardingCompletedAt: new Date(), consents: { terms: true, privacy: true, recordedAt: new Date() } });
    const owner = await actor(1), shopper = await actor(2), stranger = await actor(3);
    const store = await Store.create({ publicId: `str_cat_${suffix}`, ownerUserId: owner._id, name: 'Catalogue fixture store', slug: 'catalogue-' + suffix, country: 'UG', currency: 'UGX', status: 'verified' });
    const category = await Category.create({ publicId: `cat_cat_${suffix}`, name: 'Catalogue category', slug: 'catalogue-' + suffix, active: true, countries: ['UG'] });
    const warehouse = await Warehouse.create({ publicId: `whs_cat_${suffix}`, storeId: store._id, ownerUserId: owner._id, name: 'Catalogue fixture warehouse', country: 'UG', city: 'Kampala', address: 'Owned test fixture' });
    const product = await Product.create({ publicId: `prd_cat_${suffix}`, storeId: store._id, ownerUserId: owner._id, categoryId: category._id,
      title: 'Catalogue reading fixture', slug: 'catalogue-' + suffix, description: 'A real product with confidential moderation history.', countries: ['UG'], status: 'published', publishedAt: new Date(),
      moderation: { reason: 'PRIVATE-MODERATION-' + suffix, reviewHistory: [{ action: 'approve', actorUserId: owner._id, reason: 'PRIVATE-HISTORY-' + suffix }] } });
    const variant = await ProductVariant.create({ publicId: `var_cat_${suffix}`, productId: product._id, storeId: store._id, sku: 'CAT-' + suffix,
      title: 'Default', priceMinor: 12000, currency: 'UGX', active: true, costMinor: 999, minimumPriceMinor: 1000 });
    const stock = await StockItem.create({ publicId: `stk_cat_${suffix}`, storeId: store._id, warehouseId: warehouse._id, variantId: variant._id, onHand: 7 });
    await ProductMedia.create({ publicId: `med_cat_${suffix}`, productId: product._id, storeId: store._id, source: 'seed_asset', originalName: 'wireless-headphones.svg',
      storageKey: 'private-key-' + suffix, thumbnailStorageKey: 'private-thumb-' + suffix, mimeType: 'image/webp', sizeBytes: 100, width: 100, height: 100, checksumSha256: 'a'.repeat(64), status: 'approved' });
    await CustomerCatalogueState.create({ userId: shopper._id, wishlistProductIds: [product._id], comparisonProductIds: [product._id], recentProducts: [{ productId: product._id }], followedStoreIds: [store._id] });
    const app = createApp(null);
    const signed = async user => {
      const agent = request.agent(app), login = await agent.get('/login').expect(200);
      const token = login.text.match(/name="_csrf"[^>]*value="([^"]+)"/)?.[1];
      assert.ok(token);
      await agent.post('/login').type('form').send({ email: user.email, password, _csrf: token }).expect(302);
      return agent;
    };
    const client = await signed(shopper), other = await signed(stranger);

    await t.test('summary returns only the current account IDs and CSRF token without product hydration', async () => {
      const fail = () => { throw new Error('A summary must not perform full catalogue hydration.'); };
      const mocks = [t.mock.method(ProductVariant, 'find', fail), t.mock.method(ProductMedia, 'find', fail), t.mock.method(StockItem, 'aggregate', fail), t.mock.method(Order, 'aggregate', fail), t.mock.method(Review, 'aggregate', fail)];
      try {
        commands.length = 0;
        const response = await client.get('/api/v1/storefront/state?summary=1').expect(200);
        assert.match(response.headers['cache-control'], /private, no-store/);
        assert.equal(response.body.authenticated, true);
        assert.ok(response.body.csrfToken);
        assert.deepEqual(response.body.state, { wishlist: [product.publicId], comparison: [product.publicId], recent: [product.publicId], followedStores: [store.slug] });
        assert.equal(commands.filter(command => command.aggregate === 'products').length, 1);
        assert.equal(commands.some(command => ['productvariants', 'productmedias', 'stockitems', 'orders', 'reviews'].includes(command.find || command.aggregate)), false);
        assert.deepEqual((await other.get('/api/v1/storefront/state?summary=1').expect(200)).body.state, { wishlist: [], comparison: [], recent: [], followedStores: [] });
        const anonymous = await request(app).get('/api/v1/storefront/state?summary=1').expect(200);
        assert.equal(anonymous.body.authenticated, false);
        assert.equal(anonymous.body.csrfToken, null);
        assert.deepEqual(anonymous.body.state.wishlist, []);
      } finally { mocks.forEach(mock => mock.mock.restore()); }
    });

    await t.test('public hydration projects away private histories/costs and counts only relevant sold order items', async () => {
      // Insert owned read fixtures directly: only the aggregation fields matter here.
      const unrelated = new mongoose.Types.ObjectId();
      await Order.collection.insertMany([
        { country: 'UG', status: 'paid', items: [{ productId: product._id, quantity: 3 }, { productId: unrelated, quantity: 99 }] },
        { country: 'UG', status: 'cancelled', items: [{ productId: product._id, quantity: 111 }] },
        { country: 'KE', status: 'paid', items: [{ productId: product._id, quantity: 222 }] },
      ].map((row, index) => ({ ...row, publicId: `ord_cat_${suffix}_${index}`, sessionKey: suffix, idempotencyKey: 'catalogue-' + index })));
      commands.length = 0;
      const result = await publishedProduct(product.publicId, country);
      assert.equal(result.sold, 3);
      assert.equal(result.price, 12000);
      assert.equal(result.stock, 7);
      const json = JSON.stringify(result);
      for (const privateText of ['PRIVATE-MODERATION-', 'PRIVATE-HISTORY-', 'private-key-', 'private-thumb-', 'costMinor', 'minimumPriceMinor', String(owner._id)]) assert.equal(json.includes(privateText), false, privateText);
      const variantQuery = commands.find(command => command.find === 'productvariants');
      assert.equal(variantQuery.projection.costMinor, undefined);
      assert.equal(variantQuery.projection.minimumPriceMinor, undefined);
      const productQuery = commands.find(command => command.find === 'products');
      assert.equal(productQuery.projection['moderation.reviewHistory'], undefined);
      assert.equal(productQuery.projection.description, 1);
      const orderQuery = commands.find(command => command.aggregate === 'orders');
      assert.deepEqual(orderQuery.pipeline[0].$match['items.productId'].$in, [product._id]);
      const index = (await Order.collection.indexes()).find(index => index.key.country === 1 && index.key.status === 1 && index.key['items.productId'] === 1);
      assert.ok(index, 'A deployed model index must support narrowing sales metrics before unwind.');
      const full = await client.get('/api/v1/storefront/state').expect(200);
      assert.equal(full.body.state.wishlistProducts[0].id, product.publicId);
      assert.equal(full.body.state.wishlistProducts[0].stock, 7);
      assert.ok(Array.isArray(full.body.state.comparisonProducts));
      assert.ok(Array.isArray(full.body.state.recentProducts));
      assert.ok(Array.isArray(full.body.state.recommendations));
    });

    await t.test('summary visibility and detail stock/price recheck authoritative records rather than a warm public cache', async () => {
      clearStorefrontCache();
      assert.equal((await getStorefront(country)).products[0].stock, 7);
      await ProductVariant.updateOne({ _id: variant._id }, { $set: { priceMinor: 15000 } });
      await StockItem.updateOne({ _id: stock._id }, { $set: { onHand: 2 } });
      const fresh = await client.get('/api/v1/storefront/products/' + product.publicId).expect(200);
      assert.equal(fresh.body.product.price, 15000);
      assert.equal(fresh.body.product.stock, 2);
      await Product.updateOne({ _id: product._id }, { $set: { status: 'suspended' } });
      assert.deepEqual((await client.get('/api/v1/storefront/state?summary=1').expect(200)).body.state.wishlist, []);
      await client.get('/api/v1/storefront/products/' + product.publicId).expect(404);
      await Product.updateOne({ _id: product._id }, { $set: { status: 'published' } });
      await ProductVariant.updateOne({ _id: variant._id }, { $set: { currency: 'KES' } });
      assert.equal((await publicCatalogueIdentityMap([product._id], country)).size, 0);
      await ProductVariant.updateOne({ _id: variant._id }, { $set: { currency: 'UGX' } });
      await Category.updateOne({ _id: category._id }, { $set: { restricted: true } });
      assert.equal((await publicCatalogueIdentityMap([product._id], country)).size, 0, 'Restricted products require independent approval in summaries too.');
    });
  } finally {
    mongoose.connection.getClient().off('commandStarted', monitor);
    try { await mongoose.connection.dropDatabase(); } finally { await mongoose.disconnect(); }
  }
});

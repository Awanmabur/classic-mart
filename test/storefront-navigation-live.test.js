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

test('header navigation is small and retains current market and restricted-product eligibility', { skip: !uri, timeout: 120_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /test|verification/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  const dbName = 'classicmart_navigation_test_' + suffix;
  await mongoose.connect(uri, { dbName, monitorCommands: true });
  const commands = [];
  const client = mongoose.connection.getClient();
  const monitor = event => {
    if (event.databaseName === dbName && ['find', 'aggregate'].includes(event.commandName)) {
      commands.push({ operation: event.commandName, collection: event.command[event.commandName],
        ...(event.commandName === 'aggregate' ? { pipeline: event.command.pipeline } : {}) });
    }
  };
  client.on('commandStarted', monitor);
  try {
    const models = await import('../src/models/index.js');
    const { Category, CountrySetting, Product, ProductVariant, Store, User } = models;
    const { createApp } = await import('../src/app.js');
    const { storefrontNavigation } = await import('../src/services/storefront-navigation.js');
    const { hashPassword } = await import('../src/core/crypto.js');
    await Promise.all(Object.values(models).filter(Model => typeof Model?.init === 'function').map(Model => Model.init()));
    const country = { code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true };
    const market = await CountrySetting.create(country);
    const category = (name, extra = {}) => Category.create({ publicId: 'cat_nav_' + suffix + '_' + name,
      slug: 'nav-' + name + '-' + suffix, name, active: true, countries: ['UG'], ...extra });
    const ordinary = await category('ordinary');
    await category('inactive', { active: false });
    await category('other-country', { countries: ['KE'] });
    const restricted = await category('restricted', { restricted: true });
    await category('restricted-empty', { restricted: true });
    const ownerId = new mongoose.Types.ObjectId();
    const store = await Store.create({ publicId: 'str_nav_' + suffix, slug: 'nav-' + suffix, name: 'Navigation fixture',
      ownerUserId: ownerId, country: 'UG', currency: 'UGX', status: 'verified' });
    const product = await Product.create({ publicId: 'prd_nav_' + suffix, storeId: store._id, ownerUserId: ownerId,
      title: 'Restricted navigation fixture', slug: 'nav-' + suffix, categoryId: restricted._id,
      description: 'Private product internals must not appear in a category header response.', countries: ['UG'], status: 'published',
      moderation: { riskLevel: 'high', secondReviewRequired: false,
        firstApprovalByUserId: new mongoose.Types.ObjectId(), reviewedByUserId: new mongoose.Types.ObjectId() } });
    const variant = await ProductVariant.create({ publicId: 'var_nav_' + suffix, productId: product._id, storeId: store._id,
      sku: 'NAV-' + suffix, title: 'Default', currency: 'UGX', priceMinor: 12000, active: true });
    const app = createApp(null);
    const visibleIds = [ordinary.slug, restricted.slug].sort();

    await t.test('the actual anonymous endpoint returns only names and links without full catalogue reads', async () => {
      commands.length = 0;
      const response = await request(app).get('/api/v1/storefront/navigation').expect(200);
      assert.deepEqual(Object.keys(response.body), ['categories']);
      assert.deepEqual(response.body.categories.map(row => row.id).sort(), visibleIds);
      for (const row of response.body.categories) assert.deepEqual(Object.keys(row).sort(), ['id', 'name', 'slug']);
      assert.equal(response.headers['set-cookie'], undefined, 'Header metadata must not create a guest session.');
      assert.match(response.headers['cache-control'], /^public,/);
      assert.match(response.headers.vary, /Cookie/);
      assert.match(response.headers.vary, /CF-IPCountry/);
      const navigationReads = commands.filter(row => row.collection !== 'ipblocks');
      assert.deepEqual(navigationReads.map(row => row.collection).sort(), ['categories', 'categories', 'countrysettings']);
      assert.ok(Buffer.byteLength(response.text) < 1000, 'Two category links must stay small.');
      commands.length = 0;
      const full = await request(app).get('/api/v1/storefront/catalogue').expect(200);
      const fullReads = commands.filter(row => row.collection !== 'ipblocks');
      for (const collection of ['stockitems', 'reviews', 'orders']) {
        assert.ok(fullReads.some(row => row.collection === collection), 'The baseline must exercise actual full-catalogue ' + collection + ' hydration.');
      }
      assert.ok(fullReads.length > navigationReads.length);
      assert.ok(Buffer.byteLength(full.text) > Buffer.byteLength(response.text));
      t.diagnostic(JSON.stringify({ navigation: { reads: navigationReads.length, bytes: Buffer.byteLength(response.text) },
        fullCatalogue: { reads: fullReads.length, bytes: Buffer.byteLength(full.text) } }));
    });

    await t.test('restricted categories disappear when the product, store, review or price becomes ineligible', async () => {
      const cases = [
        [Product, product._id, { status: 'draft' }, { status: 'published' }],
        [Product, product._id, { 'moderation.firstApprovalByUserId': ownerId }, { 'moderation.firstApprovalByUserId': new mongoose.Types.ObjectId() }],
        [Store, store._id, { status: 'suspended' }, { status: 'verified' }],
        [ProductVariant, variant._id, { active: false }, { active: true }],
        [ProductVariant, variant._id, { currency: 'KES' }, { currency: 'UGX' }],
      ];
      for (const [Model, _id, hidden, restored] of cases) {
        await Model.updateOne({ _id }, { $set: hidden });
        const denied = await request(app).get('/api/v1/storefront/navigation').expect(200);
        assert.deepEqual(denied.body.categories.map(row => row.id), [ordinary.slug]);
        await Model.updateOne({ _id }, { $set: restored });
      }
      await CountrySetting.updateOne({ _id: market._id }, { $set: { active: false } });
      assert.deepEqual((await request(app).get('/api/v1/storefront/navigation').expect(200)).body.categories, []);
      await CountrySetting.updateOne({ _id: market._id }, { $set: { active: true } });
      assert.deepEqual((await storefrontNavigation({ code: 'KE', currency: 'KES' })).categories, [], 'An unavailable market has no public header links.');
    });

    await t.test('signed-in metadata stays private and contains no saved state, CSRF token or account fields', async () => {
      const password = 'Navigation-' + suffix + '-A1!';
      const email = 'navigation-' + suffix + '@example.com';
      await User.create({ publicId: 'usr_nav_' + suffix, name: 'Navigation account', email, emailNormalized: email,
        phone: '+256700000001', phoneNormalized: '+256700000001', passwordHash: await hashPassword(password),
        role: 'customer', status: 'active', country: 'UG', currency: 'UGX', emailVerifiedAt: new Date(),
        onboardingCompletedAt: new Date(), consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const browser = request.agent(app), login = await browser.get('/login').expect(200);
      const token = login.text.match(/name="_csrf"[^>]*value="([^"]+)"/)?.[1];
      assert.ok(token);
      await browser.post('/login').type('form').send({ email, password, _csrf: token }).expect(302);
      const response = await browser.get('/api/v1/storefront/navigation').expect(200);
      assert.match(response.headers['cache-control'], /private, no-store/);
      assert.deepEqual(Object.keys(response.body), ['categories']);
      assert.deepEqual(response.body.categories.map(row => row.id).sort(), visibleIds);
      assert.doesNotMatch(response.text, /Navigation account|csrfToken|wishlist|usr_nav_/);
    });

    await t.test('restricted navigation proves one eligible listing per category without grouping the full product catalogue', async () => {
      const products = await Product.insertMany(Array.from({ length: 24 }, (_, index) => ({
        publicId: 'prd_nav_bulk_' + suffix + '_' + index, storeId: store._id, ownerUserId: ownerId,
        title: 'Additional eligible listing ' + index, slug: 'nav-bulk-' + suffix + '-' + index, categoryId: restricted._id,
        description: 'Additional eligible products must not expand the navigation proof result.', countries: ['UG'], status: 'published',
        moderation: { riskLevel: 'high', secondReviewRequired: false,
          firstApprovalByUserId: new mongoose.Types.ObjectId(), reviewedByUserId: new mongoose.Types.ObjectId() },
      })));
      await ProductVariant.insertMany(products.map((row, index) => ({
        publicId: 'var_nav_bulk_' + suffix + '_' + index, productId: row._id, storeId: store._id,
        sku: 'NAV-BULK-' + suffix + '-' + index, title: 'Default', currency: 'UGX', priceMinor: 12000, active: true,
      })));
      commands.length = 0;
      assert.deepEqual((await storefrontNavigation(country)).categories.map(row => row.id).sort(), visibleIds);
      const proofs = commands.filter(row => row.operation === 'aggregate');
      assert.equal(proofs.length, 1, 'All category proofs share one database command.');
      assert.equal(proofs[0].collection, 'categories', 'Proofs begin at category identities, not all matching products.');
      const listingLookup = proofs[0].pipeline.find(stage => stage.$lookup?.from === 'products')?.$lookup;
      assert.ok(listingLookup);
      assert.deepEqual(listingLookup.pipeline.at(-2), { $limit: 1 }, 'Stop after the first fully eligible listing.');
      assert.deepEqual(listingLookup.pipeline.at(-1), { $project: { _id: 1 } });
      assert.equal(listingLookup.pipeline.some(stage => stage.$group), false);
      assert.ok(listingLookup.pipeline.some(stage => stage.$lookup?.from === 'productvariants'), 'The bound cannot skip price/currency eligibility.');
    });
  } finally {
    client.off('commandStarted', monitor);
    try { await mongoose.connection.dropDatabase(); } finally { await mongoose.disconnect(); }
  }
});

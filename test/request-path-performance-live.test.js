import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import request from 'supertest';
import sharp from 'sharp';

const suffix = crypto.randomBytes(8).toString('hex');
process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
process.env.MEDIA_STORAGE_DRIVER = 'filesystem';
process.env.UPLOAD_DIR = `/tmp/classicmart-request-performance-${suffix}`;
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;
const csrf = html => {
  const token = html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/);
  assert.ok(token, 'The actual login form must supply a CSRF token.');
  return token[1];
};

test('public photo delivery avoids account work while fresh publication and private-preview gates remain authoritative', { skip: !uri, timeout: 120_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  await mongoose.connect(uri, { dbName: 'classicmart_request_performance_test_' + suffix, monitorCommands: true });
  const commands = [];
  const monitor = event => {
    if (['find', 'aggregate', 'update', 'insert', 'delete', 'findAndModify'].includes(event.commandName)) {
      commands.push({ command: event.commandName, collection: event.command[event.commandName] });
    }
  };
  const client = mongoose.connection.getClient();
  client.on('commandStarted', monitor);
  try {
    const models = await import('../src/models/index.js');
    const { User, Store, StoreMember, Device, Product, ProductMedia, Category, Brand, CountrySetting, FeatureFlag } = models;
    const { createApp } = await import('../src/app.js');
    const { hashPassword } = await import('../src/core/crypto.js');
    const { putMediaObject } = await import('../src/services/object-storage.js');
    const { clearActiveFeatureCache } = await import('../src/services/stage9.js');
    const { logger } = await import('../src/config/logger.js');
    t.mock.method(logger, 'error', () => {});
    await Promise.all(Object.values(models).filter(Model => typeof Model?.init === 'function').map(Model => Model.init()));
    const market = await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true });
    const password = 'Performance-' + suffix + '-A1!', passwordHash = await hashPassword(password);
    const actor = async (role, n) => {
      const email = `request-performance-${suffix}-${n}@example.com`;
      return User.create({ publicId: `usr_req_${suffix}_${n}`, role, name: 'Request performance fixture', status: 'active', email, emailNormalized: email,
        phone: '+25670' + String(n).padStart(7, '0'), phoneNormalized: '+25670' + String(n).padStart(7, '0'),
        passwordHash, country: 'UG', currency: 'UGX', emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
        consents: { terms: true, privacy: true, recordedAt: new Date() } });
    };
    const owner = await actor('seller', 1), shopper = await actor('customer', 2);
    const store = await Store.create({ publicId: `str_req_${suffix}`, name: 'Published source fixture', slug: 'request-' + suffix,
      ownerUserId: owner._id, country: 'UG', currency: 'UGX', status: 'verified' });
    const category = await Category.create({ publicId: `cat_req_${suffix}`, name: 'Request fixture category', slug: 'request-' + suffix, active: true, countries: ['UG'] });
    const brand = await Brand.create({ publicId: `brd_req_${suffix}`, name: 'Request fixture brand', slug: 'request-' + suffix, status: 'approved' });
    const product = await Product.create({ publicId: `prd_req_${suffix}`, ownerUserId: owner._id, storeId: store._id, categoryId: category._id, brandId: brand._id,
      title: 'Published image fixture', slug: 'request-' + suffix, description: 'A real source record used for publication and media request verification.', countries: ['UG'], status: 'published' });
    const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ec6c22' } }).webp().toBuffer();
    const storageKey = `products/${store.publicId}/request-${suffix}.webp`;
    await putMediaObject(storageKey, bytes, { contentType: 'image/webp' });
    const media = await ProductMedia.create({ publicId: `med_req_${suffix}`, productId: product._id, storeId: store._id, storageKey, thumbnailStorageKey: storageKey,
      mimeType: 'image/webp', width: 64, height: 64, sizeBytes: bytes.length, checksumSha256: crypto.createHash('sha256').update(bytes).digest('hex'), status: 'approved' });
    const href = '/media/catalogue/' + media.publicId + '?size=thumb';
    const app = createApp(null), signed = request.agent(app);
    const login = await signed.get('/login').expect(200);
    await signed.post('/login').type('form').send({ email: shopper.email, password, _csrf: csrf(login.text) }).expect(302);

    await t.test('a real signed-in browser receives identical public bytes with two publication reads and no identity/navigation/feature work', async () => {
      commands.length = 0;
      const response = await signed.get(href).expect(200);
      assert.deepEqual(response.body, bytes);
      assert.match(response.headers['cache-control'], /^public,/);
      assert.equal(response.headers['set-cookie'], undefined, 'Public image delivery must not roll or create a browser session.');
      assert.deepEqual(commands, [{ command: 'aggregate', collection: 'productmedias' }, { command: 'aggregate', collection: 'productmedias' }]);
      const anonymous = await request(app).get(href).expect(200);
      assert.deepEqual(anonymous.body, bytes);
      const head = await signed.head(href).expect(200);
      assert.equal(head.text, undefined);
      assert.match(head.headers['cache-control'], /^public,/);
    });

    await t.test('public photos disappear immediately when any authoritative publication source is withdrawn', async () => {
      const cases = [
        [ProductMedia, media._id, { status: 'ready' }, { status: 'approved' }],
        [Product, product._id, { status: 'draft' }, { status: 'published' }],
        [Product, product._id, { countries: ['KE'] }, { countries: ['UG'] }],
        [Store, store._id, { status: 'suspended' }, { status: 'verified' }],
        [Store, store._id, { currency: 'KES' }, { currency: 'UGX' }],
        [Category, category._id, { active: false }, { active: true }],
        [Category, category._id, { countries: ['KE'] }, { countries: ['UG'] }],
        [Brand, brand._id, { status: 'rejected' }, { status: 'approved' }],
        [CountrySetting, market._id, { active: false }, { active: true }],
        [CountrySetting, market._id, { currency: 'KES' }, { currency: 'UGX' }],
      ];
      for (const [Model, _id, withdrawn, restored] of cases) {
        await Model.updateOne({ _id }, { $set: withdrawn });
        const denied = await request(app).get(href).expect(404);
        assert.match(denied.headers['cache-control'], /no-store/);
        assert.notDeepEqual(denied.body, bytes);
        await Model.updateOne({ _id }, { $set: restored });
        await request(app).get(href).expect(200);
      }
      await Category.updateOne({ _id: category._id }, { $set: { restricted: true } });
      await request(app).get(href).expect(404);
      const first = new mongoose.Types.ObjectId(), final = new mongoose.Types.ObjectId();
      await Product.updateOne({ _id: product._id }, { $set: { 'moderation.firstApprovalByUserId': first, 'moderation.reviewedByUserId': final, 'moderation.secondReviewRequired': false } });
      await request(app).get(href).expect(200);
      await Product.updateOne({ _id: product._id }, { $set: { 'moderation.firstApprovalByUserId': owner._id } });
      await request(app).get(href).expect(404);
      await Category.updateOne({ _id: category._id }, { $set: { restricted: false } });
      await Product.updateOne({ _id: product._id }, { $set: { 'moderation.firstApprovalByUserId': null, 'moderation.reviewedByUserId': null } });
    });

    await t.test('source withdrawal during an actual object read prevents a public byte response', async () => {
      const original = fs.readFile;
      const mock = t.mock.method(fs, 'readFile', async (file, ...args) => {
        const data = await original(file, ...args);
        if (path.basename(String(file)) === path.basename(storageKey)) await Product.updateOne({ _id: product._id }, { $set: { status: 'suspended' } });
        return data;
      });
      const denied = await signed.get(href).expect(404);
      assert.match(denied.headers['cache-control'], /no-store/);
      assert.notDeepEqual(denied.body, bytes);
      mock.mock.restore();
      await Product.updateOne({ _id: product._id }, { $set: { status: 'published' } });
    });

    await t.test('private photos retain actual owner membership, authenticator enrollment, and current device checks', async () => {
      await StoreMember.create({ publicId: `stm_req_${suffix}`, storeId: store._id, userId: owner._id,
        role: 'owner', status: 'active', invitedByUserId: owner._id, acceptedAt: new Date() });
      const ownerBrowser = request.agent(app);
      const ownerForm = await ownerBrowser.get('/login').expect(200);
      await ownerBrowser.post('/login').type('form').send({ email: owner.email, password, _csrf: csrf(ownerForm.text) }).expect(302);
      await Product.updateOne({ _id: product._id }, { $set: { status: 'draft' } });
      await request(app).get(href).expect(404);
      // A shopper with a valid account cannot obtain another store's draft.
      await signed.get(href).expect(403);
      await User.updateOne({ _id: shopper._id }, { $set: { 'security.mfaEnabled': true } });
      await signed.get(href).expect(404);
      await User.updateOne({ _id: shopper._id }, { $set: { 'security.mfaEnabled': false } });
      await ownerBrowser.get(href).expect(403);
      // This fixture changes the persisted enrollment state, not the request
      // identity. loadUser must read it on the next actual HTTP request.
      await User.updateOne({ _id: owner._id }, { $set: { 'security.mfaEnabled': true } });
      const preview = await ownerBrowser.get(href).expect(200);
      assert.deepEqual(preview.body, bytes);
      assert.match(preview.headers['cache-control'], /^private, no-store$/);
      assert.match(preview.headers['x-robots-tag'], /noindex/);
      const previewHead = await ownerBrowser.head(href).expect(200);
      assert.equal(previewHead.text, undefined);
      assert.match(previewHead.headers['cache-control'], /^private, no-store$/);
      await StoreMember.updateOne({ storeId: store._id, userId: owner._id }, { $set: { status: 'revoked' } });
      await ownerBrowser.get(href).expect(404);
      await StoreMember.updateOne({ storeId: store._id, userId: owner._id }, { $set: { status: 'active' } });
      await Device.updateMany({ userId: owner._id }, { $set: { revokedAt: new Date() } });
      await ownerBrowser.get(href).expect(404);
      await Product.updateOne({ _id: product._id }, { $set: { status: 'published' } });
      await request(app).get(href).expect(200);
    });

    await t.test('ordinary page requests avoid empty business organization reads and feature-store failures while the actual flag consumer stays strict', async () => {
      clearActiveFeatureCache();
      commands.length = 0;
      await signed.get('/about').expect(200);
      assert.equal(commands.some(command => ['businessorganizations', 'platformgrants', 'featureflags'].includes(command.collection)), false);
      assert.equal(commands.filter(command => command.collection === 'businessmembers').length, 1);
      await FeatureFlag.create({ publicId: `flg_req_${suffix}`, key: 'request-performance', enabled: true, countries: ['UG'], roles: ['customer'], rolloutPercentage: 100 });
      clearActiveFeatureCache();
      const state = await request(app).get('/api/v1/storefront/state').expect(200);
      assert.equal(state.body.features['request-performance'], true);
      // Keep the existing per-country rollout guard on all three Ask Classic
      // entry points when flags are no longer loaded for unrelated routes.
      await FeatureFlag.create({ publicId: `flg_req_ai_${suffix}`, key: 'classic_ai.ask', enabled: true,
        countries: ['KE'], roles: ['customer'], rolloutPercentage: 100 });
      clearActiveFeatureCache();
      const form = await signed.get('/account/security').expect(200);
      const guardedGet = await signed.get('/ask-classic').set('Accept', 'application/json').expect(404);
      assert.equal(guardedGet.body.error.code, 'AI_FEATURE_DISABLED');
      const guardedPost = await signed.post('/ask-classic').set('Accept', 'application/json').type('form')
        .send({ question: 'Find something', _csrf: csrf(form.text) }).expect(404);
      assert.equal(guardedPost.body.error.code, 'AI_FEATURE_DISABLED');
      const guardedVisual = await signed.post('/ask-classic/visual').set('Accept', 'application/json')
        .field('_csrf', csrf(form.text)).expect(404);
      assert.equal(guardedVisual.body.error.code, 'AI_FEATURE_DISABLED');
      clearActiveFeatureCache();
      const mock = t.mock.method(FeatureFlag, 'find', () => { throw new Error('Feature definition transport failed.'); });
      await signed.get('/about').expect(200);
      await request(app).get('/api/v1/storefront/state').expect(500);
      await signed.get('/ask-classic').expect(500);
      mock.mock.restore();
      clearActiveFeatureCache();
    });
  } finally {
    client.removeListener('commandStarted', monitor);
    try { await mongoose.connection.dropDatabase(); } finally { await mongoose.disconnect(); }
    await fs.rm(process.env.UPLOAD_DIR, { recursive: true, force: true });
  }
});

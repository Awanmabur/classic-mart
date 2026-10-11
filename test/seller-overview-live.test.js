import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';
import { chromium } from '@playwright/test';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('seller reporting windows use the store calendar and reject unsupported periods', async () => {
  const { sellerOverviewWindow } = await import('../src/services/seller-overview.js');
  const now = new Date('2026-10-01T00:30:00Z');
  const kampala = sellerOverviewWindow('7months', 'Africa/Kampala', now);
  assert.equal(kampala.start.toISOString(), '2026-03-31T21:00:00.000Z');
  assert.deepEqual(kampala.buckets.map(bucket => bucket.key), ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  const newYork = sellerOverviewWindow('30days', 'America/New_York', new Date('2026-03-20T12:00:00Z'));
  assert.equal(newYork.start.toISOString(), '2026-02-19T05:00:00.000Z');
  assert.equal(newYork.buckets[4].start.toISOString(), '2026-03-11T04:00:00.000Z', 'DST changes the UTC boundary without changing the local day');
  assert.equal(newYork.buckets.length, 6);
  assert.equal(newYork.buckets.flatMap(bucket => bucket.keys).length, 30);
  assert.throws(() => sellerOverviewWindow('all', 'UTC', now));
  assert.throws(() => sellerOverviewWindow(['year'], 'UTC', now));
  assert.throws(() => sellerOverviewWindow('year', 'not/a-zone', now), error => error.code === 'SELLER_CALENDAR_UNAVAILABLE');
});

test('approved seller overview is live, independently scoped, payment-aware and complete beyond sample limits', { skip: !uri, timeout: 120_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex'), database = `classicmart_seller_overview_test_${suffix}`;
  await mongoose.connect(uri, { dbName: database });
  const { createApp } = await import('../src/app.js');
  const models = await import('../src/models/index.js');
  const { User, Store, StoreMember, SellerOrder, Order, PaymentIntent, Refund, Product, Category, Review, Warehouse, StockItem } = models;
  const { loadSellerOverview } = await import('../src/services/seller-overview.js');
  const { hashPassword } = await import('../src/core/crypto.js');
  const { beginMfaEnrollment, confirmMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
  const password = `Overview-${suffix}-A1!`, passwordHash = await hashPassword(password), app = createApp(null);
  const transports = [];
  const now = new Date('2026-10-09T12:00:00Z');
  let sequence = 0, actorSequence = 0, server, browser;
  async function actor(role = 'seller', { enroll = role === 'seller' } = {}) {
    const number = ++sequence, email = `overview-${suffix}-${number}@example.com`, phone = `+25670${String(number).padStart(7, '0')}`;
    let user = await User.create({ publicId: `usr_overview_${suffix}_${number}`, name: `Overview Owner ${number}`, email, emailNormalized: email,
      phone, phoneNormalized: phone, passwordHash, role, country: 'UG', currency: 'UGX', locale: 'en-UG', emailVerifiedAt: now,
      onboardingCompletedAt: now, consents: { terms: true, privacy: true, recordedAt: now } });
    let recoveryCodes = [];
    if (enroll) {
      const enrollment = await beginMfaEnrollment(user._id, password);
      const confirmed = await confirmMfaEnrollment(user._id, totpCode(enrollment.secret));
      user = confirmed.user;
      recoveryCodes = confirmed.codes;
    }
    const transport = new http.Agent({ localAddress: `127.0.0.${++actorSequence + 2}`, keepAlive: false });
    transports.push(transport);
    const client = request.agent(app).use(req => req.agent(transport)), login = await client.get('/login').expect(200);
    const authenticated = await client.post('/login').type('form').send({ email, password, _csrf: csrf(login.text) }).expect(302);
    if (enroll) {
      assert.equal(authenticated.headers.location, '/mfa');
      const challenge = await client.get('/mfa').expect(200);
      await client.post('/mfa').type('form').send({ code: recoveryCodes[0], _csrf: csrf(challenge.text) }).expect(302);
    }
    return { user, client, recoveryCodes };
  }
  async function storeFor(user, name, status = 'verified') {
    const store = await Store.create({ publicId: `str_overview_${suffix}_${++sequence}`, ownerUserId: user._id, name, slug: `${suffix}-${sequence}`,
      country: 'UG', currency: 'UGX', status });
    const member = await StoreMember.create({ publicId: `stm_overview_${suffix}_${sequence}`, storeId: store._id, userId: user._id,
      role: 'owner', status: 'active', invitedByUserId: user._id, acceptedAt: now });
    return { store, member };
  }
  const serviceRequest = (actor, store) => ({ user: actor.user, store, session: { tokenVersion: actor.user.security.tokenVersion } });
  async function commerce(store, { subtotal = 1000, discount = 100, createdAt = new Date('2026-10-02T12:00:00Z'), paidAt = new Date('2026-10-03T12:00:00Z'),
    status = 'confirmed', paymentStatus = 'succeeded', otherStore = null, rootCountry = 'UG', currency = 'UGX', paid = true } = {}) {
    const index = ++sequence, orderId = new mongoose.Types.ObjectId(), publicId = `ord_overview_${suffix}_${index}`;
    const item = { storeId: store._id, storePublicId: store.publicId, productId: new mongoose.Types.ObjectId(), variantId: new mongoose.Types.ObjectId(),
      linePublicId: `oli_${index}`, reservationPublicId: `rsv_${index}`, productPublicId: `prd_${index}`, variantPublicId: `var_${index}`,
      title: 'Overview fixture product', variantTitle: 'Default', sku: `OV-${index}`, quantity: 1, unitPriceMinor: subtotal, lineTotalMinor: subtotal, currency };
    const totalMinor = subtotal - discount + 75 + 25 + (otherStore ? 2000 : 0);
    await Order.collection.insertOne({ _id: orderId, publicId, sessionKey: `session-${suffix}-${index}`, idempotencyKey: `${suffix}-${index}`,
      checkoutId: `checkout-${suffix}-${index}`, cartPublicId: `crt-${suffix}-${index}`, country: rootCountry, userId: new mongoose.Types.ObjectId(), status: 'paid',
      paymentState: 'paid', paymentMethod: 'wallet', totals: { currency, subtotalMinor: subtotal + (otherStore ? 2000 : 0), discountMinor: discount,
        shippingMinor: 75, taxMinor: 25, totalMinor }, items: [item, ...(otherStore ? [{ ...item, storeId: otherStore._id, storePublicId: otherStore.publicId }] : [])],
      createdAt, updatedAt: createdAt });
    const seller = await SellerOrder.create({ publicId: `sor_overview_${suffix}_${index}`, orderId, orderPublicId: publicId, storeId: store._id,
      storePublicId: store.publicId, country: 'UG', currency, status, subtotalMinor: subtotal, discountMinor: discount, shippingMinor: 75, taxMinor: 25,
      items: [{ title: item.title, quantity: 1, lineTotalMinor: subtotal, currency }], createdAt, updatedAt: createdAt });
    let payment;
    if (paid) payment = await PaymentIntent.create({ publicId: `pay_overview_${suffix}_${index}`, orderId, orderPublicId: publicId, country: rootCountry,
      currency, idempotencyKey: `${suffix}-${index}`, provider: 'wallet', method: 'wallet', status: paymentStatus, amountMinor: totalMinor,
      ...(paidAt ? { paidAt } : {}) });
    return { orderId, seller, payment, totalMinor };
  }
  async function refund(entry, allocations, { amount = 100, status = 'completed', currency = 'UGX', completedAt = new Date('2026-10-04T12:00:00Z') } = {}) {
    return Refund.create({ publicId: `ref_overview_${suffix}_${++sequence}`, idempotencyKey: `${suffix}-${sequence}`, orderId: entry.orderId,
      paymentIntentId: entry.payment?._id || new mongoose.Types.ObjectId(), amountMinor: amount, currency, allocations, status, completedAt, reason: 'Test refund', provider: 'wallet' });
  }
  try {
    await Promise.all(Object.values(models).filter(model => typeof model?.init === 'function').map(model => model.init()));
    await models.CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256' });
    const owner = await actor(), otherOwner = await actor(), buyer = await actor('customer');
    const { store, member } = await storeFor(owner.user, 'Real Seller Store');
    const { store: foreign } = await storeFor(otherOwner.user, 'Foreign Store');
    const scoped = serviceRequest(owner, store);

    await t.test('empty owned pending store opens original seller panels without customer cards or fabricated numbers', async () => {
      await Store.updateOne({ _id: store._id }, { $set: { status: 'pending_verification' } });
      const data = await loadSellerOverview(scoped, { now });
      assert.equal(data.metrics.netSalesMinor, 0);
      assert.equal(data.metrics.orders, 0);
      assert.equal(data.metrics.rating, null);
      assert.ok(data.trend.every(bucket => bucket.netMinor === 0));
      assert.equal(data.team.total, 1);
      const page = await owner.client.get('/seller/overview').expect(200);
      assert.match(page.headers['cache-control'], /no-store/);
      assert.match(page.headers['x-robots-tag'], /noindex/);
      for (const className of ['role-welcome panel', 'role-metric-grid', 'role-overview-grid', 'role-chart-panel', 'role-focus-panel', 'role-bottom-grid', 'role-activity-feed', 'role-team-panel']) assert.ok(page.text.includes(className));
      assert.match(page.text, /data-page="seller-overview" data-role="seller" data-page-kind="overview"/);
      assert.doesNotMatch(page.text, /Recently Viewed|Recommended for You|Classic Club|Loyalty Points|Workspace score|92%|Amina Stores/);
      assert.match(page.text, /No reviews yet/);
      assert.equal((await owner.client.get('/seller/overview').set('accept', 'application/json')).body.metrics.netSalesMinor, 0);
      await owner.client.get('/seller?period=30days').expect(308).expect('location', '/seller/overview?period=30days');
      await owner.client.get('/dashboard/seller-overview').expect(308).expect('location', '/seller/overview');
      await Store.updateOne({ _id: store._id }, { $set: { status: 'verified' } });
    });

    await t.test('300 store orders use full aggregation, exclude personal buyer and second store data, and count verified payment dates', async () => {
      const category = await Category.create({ publicId: `cat_overview_${suffix}`, name: 'Overview category', slug: `overview-${suffix}` });
      const ownProduct = await Product.create({ publicId: `prd_overview_${suffix}`, storeId: store._id, ownerUserId: owner.user._id, categoryId: category._id,
        title: 'Real Seller Product', slug: 'real-seller-product', description: 'A product for store metrics.', countries: ['UG'], status: 'published' });
      const foreignProduct = await Product.create({ publicId: `prd_foreign_${suffix}`, storeId: foreign._id, ownerUserId: otherOwner.user._id, categoryId: category._id,
        title: 'Foreign Product Secret', slug: 'foreign-product', description: 'Another store.', countries: ['UG'], status: 'published' });
      for (const [index, product, country, rating, status] of [[1, ownProduct, 'UG', 4, 'published'], [2, ownProduct, 'UG', 5, 'published'],
        [3, ownProduct, 'KE', 1, 'published'], [4, ownProduct, 'UG', 1, 'pending'], [5, foreignProduct, 'UG', 1, 'published']]) {
        await Review.create({ publicId: `rev_${suffix}_${index}`, userId: buyer.user._id, orderId: new mongoose.Types.ObjectId(), orderPublicId: `ord_rev_${index}`,
          productId: product._id, productPublicId: product.publicId, country, rating, status, body: 'A real reviewed item.' });
      }
      for (let index = 0; index < 300; index += 1) await commerce(store);
      await commerce(foreign, { subtotal: 9_000_000 });
      const purchase = await commerce(foreign, { subtotal: 88_888 });
      await Order.collection.updateOne({ _id: purchase.orderId }, { $set: { userId: owner.user._id, 'items.0.title': 'Personal Buyer Purchase' } });
      await commerce(store, { subtotal: 99_999, rootCountry: 'KE' });
      await commerce(store, { subtotal: 99_999, currency: 'KES' });
      await commerce(store, { subtotal: 99_999, status: 'pending_payment', paid: false });
      await commerce(store, { subtotal: 99_999, paymentStatus: 'pending_collection', paidAt: null });
      await commerce(store, { subtotal: 99_999, paymentStatus: 'reversed' });
      await commerce(store, { subtotal: 2000, discount: 500, createdAt: new Date('2026-01-01T12:00:00Z'), paidAt: new Date('2026-10-01T12:00:00Z') });
      const data = await loadSellerOverview(scoped, { period: '30days', now });
      assert.equal(data.metrics.paidMinor, 271_500, '300 x 900 plus 1,500 paid now from an old order');
      assert.equal(data.metrics.orders, 303, 'three non-paying orders count as orders but never revenue');
      assert.equal(data.metrics.publishedProducts, 1);
      assert.equal(data.metrics.rating, 4.5);
      assert.equal(data.metrics.reviews, 2);
      assert.equal(data.metrics.netSalesMinor, data.trend.reduce((sum, bucket) => sum + bucket.netMinor, 0));
      const page = await owner.client.get('/seller/overview').expect(200);
      assert.doesNotMatch(page.text, /Foreign Product Secret|Personal Buyer Purchase|Foreign Store/);
    });

    await t.test('only completed owned allocations and allocation-free full refunds reverse item sales, including older paid orders', async () => {
      const own = await commerce(store, { subtotal: 5000, discount: 500 });
      await refund(own, [{ storePublicId: store.publicId, grossMinor: 1000 }, { storePublicId: foreign.publicId, grossMinor: 2000 }], { amount: 3000 });
      await refund(own, [{ storePublicId: store.publicId, grossMinor: 99_999 }], { amount: 99_999, status: 'processing' });
      await refund(own, [{ storePublicId: store.publicId, grossMinor: 99_999 }], { amount: 99_999, currency: 'KES' });
      const oldMultiStore = await commerce(store, { subtotal: 10_000, discount: 2000, otherStore: foreign,
        createdAt: new Date('2025-10-01T12:00:00Z'), paidAt: new Date('2025-10-02T12:00:00Z') });
      await refund(oldMultiStore, [], { amount: oldMultiStore.totalMinor });
      const malformed = await commerce(store, { subtotal: 1000, discount: 0 });
      await refund(malformed, [], { amount: 100, status: 'completed' });
      const wrongCountry = await commerce(store, { subtotal: 10_000, rootCountry: 'KE' });
      await refund(wrongCountry, [{ storePublicId: store.publicId, grossMinor: 10_000 }], { amount: 10_000 });
      const data = await loadSellerOverview(scoped, { period: '30days', now });
      assert.equal(data.metrics.refundMinor, 9000, '1,000 allocated plus 8,000 own items from full multi-store refund; exclude other store, shipping and tax');
      assert.equal(data.metrics.paidMinor, 277_000);
      assert.equal(data.metrics.netSalesMinor, 268_000);
      const october4 = data.trend.find(bucket => bucket.refundMinor);
      assert.equal(october4.refundMinor, 9000);
      assert.equal((await loadSellerOverview(scoped, { period: '7months', now })).metrics.refundMinor, 9000);
    });

    await t.test('payment identities must match the authoritative order before sales or refund allocations count', async () => {
      const baseline = await loadSellerOverview(scoped, { period: '30days', now });
      const owned = await commerce(store, { subtotal: 3000, discount: 0 });
      await PaymentIntent.updateOne({ _id: owned.payment._id }, { $set: { orderPublicId: 'ord_other_identity' } });
      const other = await commerce(foreign, { subtotal: 5000, discount: 0 });
      const invalidRefund = await refund(owned, [{ storePublicId: store.publicId, grossMinor: 200 }], { amount: 200 });
      await Refund.updateOne({ _id: invalidRefund._id }, { $set: { paymentIntentId: other.payment._id } });
      const rejected = await loadSellerOverview(scoped, { period: '30days', now });
      assert.equal(rejected.metrics.paidMinor, baseline.metrics.paidMinor);
      assert.equal(rejected.metrics.refundMinor, baseline.metrics.refundMinor);
      assert.equal(rejected.metrics.orders, baseline.metrics.orders + 1);
      await PaymentIntent.updateOne({ _id: owned.payment._id }, { $set: { orderPublicId: owned.seller.orderPublicId } });
      const paid = await loadSellerOverview(scoped, { period: '30days', now });
      assert.equal(paid.metrics.paidMinor, baseline.metrics.paidMinor + 3000);
      assert.equal(paid.metrics.refundMinor, baseline.metrics.refundMinor, 'an unrelated captured payment cannot authorize this refund');
      await Refund.updateOne({ _id: invalidRefund._id }, { $set: { paymentIntentId: owned.payment._id } });
      assert.equal((await loadSellerOverview(scoped, { period: '30days', now })).metrics.refundMinor, baseline.metrics.refundMinor + 200);
    });

    await t.test('authorization rechecks fresh user/member/store/country and forbids customer and least privilege members', async () => {
      await buyer.client.get('/seller/overview').set('accept', 'application/json').expect(403);
      assert.equal(await Store.countDocuments({ ownerUserId: buyer.user._id }), 0, 'role rejection must happen before store creation');
      await buyer.client.get('/seller').set('accept', 'application/json').expect(403);
      await buyer.client.get('/dashboard/seller-overview').set('accept', 'application/json').expect(403);
      const restricted = await actor();
      const restrictedMember = await StoreMember.create({ publicId: `stm_restricted_${suffix}`, storeId: store._id, userId: restricted.user._id,
        role: 'support', status: 'active', invitedByUserId: owner.user._id, acceptedAt: now });
      await restricted.client.get('/seller/overview').set('accept', 'application/json').expect(403);
      assert.equal(await Store.countDocuments({ ownerUserId: restricted.user._id }), 0);
      await assert.rejects(loadSellerOverview(serviceRequest(restricted, store), { now }), error => error.code === 'STORE_PERMISSION_DENIED');
      await StoreMember.updateOne({ _id: restrictedMember._id }, { $set: { role: 'admin' } });
      assert.equal((await restricted.client.get('/seller/overview').set('accept', 'application/json').expect(200)).body.store.publicId, store.publicId);
      await StoreMember.updateOne({ _id: restrictedMember._id }, { $set: { status: 'revoked' } });
      await assert.rejects(loadSellerOverview(serviceRequest(restricted, store), { now }), error => error.code === 'STORE_PERMISSION_DENIED');
      await assert.rejects(loadSellerOverview(serviceRequest(owner, foreign), { now }), error => error.code === 'STORE_PERMISSION_DENIED');
      // An owner membership is repaired by the existing loadSellerStore middleware;
      // direct service requests must still reject a revoked authoritative membership.
      await StoreMember.updateOne({ _id: member._id }, { $set: { status: 'revoked' } });
      await assert.rejects(loadSellerOverview(scoped, { now }), error => error.code === 'STORE_PERMISSION_DENIED');
      await StoreMember.updateOne({ _id: member._id }, { $set: { status: 'active' } });
      await Store.updateOne({ _id: store._id }, { $set: { status: 'suspended' } });
      await owner.client.get('/seller/overview').set('accept', 'application/json').expect(409);
      await Store.updateOne({ _id: store._id }, { $set: { status: 'verified' } });
      await models.CountrySetting.updateOne({ code: 'UG' }, { $set: { active: false } });
      await assert.rejects(loadSellerOverview(scoped, { now }), error => error.code === 'SELLER_COUNTRY_UNAVAILABLE');
      await models.CountrySetting.updateOne({ code: 'UG' }, { $set: { active: true } });
      await assert.rejects(loadSellerOverview({ ...scoped, session: { tokenVersion: 99 } }, { now }), error => error.code === 'ACCOUNT_UNAVAILABLE');
      const unenrolled = await actor('seller', { enroll: false });
      await unenrolled.client.get('/seller/overview').expect(302).expect('location', '/account/security?next=%2Fseller%2Foverview');
      const denied = await unenrolled.client.get('/seller/overview').set('accept', 'application/json').expect(403);
      assert.equal(denied.body.error.code, 'MFA_ENROLLMENT_REQUIRED');
      assert.equal(await Store.countDocuments({ ownerUserId: unenrolled.user._id }), 0);
    });

    await t.test('period queries fail closed and downloadable summary uses the same genuine totals and formula escaping', async () => {
      await owner.client.get('/seller/overview?period=all').set('accept', 'application/json').expect(422);
      await owner.client.get('/seller/overview?period[x]=year').set('accept', 'application/json').expect(422);
      await owner.client.get('/seller/overview?period=year&period=30days').set('accept', 'application/json').expect(422);
      await owner.client.get('/seller/overview/summary.csv?period[]=year').expect(422);
      const json = await owner.client.get('/seller/overview?period=30days').set('accept', 'application/json').expect(200);
      const csv = await owner.client.get('/seller/overview/summary.csv?period=30days').expect(200);
      assert.match(csv.headers['content-type'], /text\/csv/);
      assert.match(csv.headers['cache-control'], /no-store/);
      assert.ok(csv.text.includes(`"Net paid item sales minor","${json.body.metrics.netSalesMinor}"`));
      await Store.updateOne({ _id: store._id }, { $set: { name: '=2+2' } });
      assert.match((await owner.client.get('/seller/overview/summary.csv')).text, /"'=2\+2"/);
      await Store.updateOne({ _id: store._id }, { $set: { name: 'Real Seller Store' } });
    });

    await t.test('desktop and mobile show actual seller overview and navigate products/orders while customer overview stays separate', async () => {
      server = app.listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
      for (const [index, width] of [1366, 390].entries()) {
        const context = await browser.newContext({ viewport: { width, height: 1100 }, baseURL: `http://127.0.0.1:${server.address().port}` });
        const page = await context.newPage();
        await page.goto('/login');
        await page.locator('input[name=email]').fill(owner.user.email);
        await page.locator('input[name=password]').fill(password);
        await Promise.all([page.waitForURL('**/mfa'), page.locator('form[action="/login"] button[type=submit]').click()]);
        await page.locator('input[name=code]').fill(owner.recoveryCodes[index + 1]);
        await Promise.all([page.waitForURL('**/seller/overview'), page.locator('form[action="/mfa"] button[type=submit]').click()]);
        await page.locator('[data-page="seller-overview"]').waitFor();
        assert.equal(await page.locator('[data-page="seller-overview"] .role-metric').count(), 4);
        assert.equal(await page.locator('[data-page="seller-overview"] .role-chart').count(), 1);
        assert.equal(await page.locator('[data-page="seller-overview"] .role-bottom-grid > section').count(), 2);
        assert.equal(await page.locator('body').getAttribute('data-dashboard-workspace'), 'seller');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px seller page must fit the viewport`);
        await page.waitForFunction(() => [...document.querySelectorAll('main, .app-page.active, .role-metric')]
          .every(element => Number(getComputedStyle(element).opacity) >= 0.999));
        await page.screenshot({ path: `/tmp/classicmart-real-seller-overview-${width}.png`, fullPage: true });
        await page.goto('/seller/products');
        await page.locator('[data-page="seller-products"]').waitFor();
        await page.goto('/seller/orders');
        await page.locator('[data-page="seller-orders"]').waitFor();
        await context.close();
      }
      const customer = await buyer.client.get('/dashboard').expect(200);
      assert.match(customer.text, /data-dashboard-workspace="customer"/);
      assert.doesNotMatch(customer.text, /seller-overview-page/);
    });
  } finally {
    if (browser) await browser.close();
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    for (const transport of transports) transport.destroy();
    try { if (mongoose.connection.readyState === 1) { assert.equal(mongoose.connection.name, database); await mongoose.connection.dropDatabase(); } }
    finally { await mongoose.disconnect(); }
  }
});

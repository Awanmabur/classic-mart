import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';

const suffix = crypto.randomBytes(8).toString('hex');
process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
for (const name of ['SESSION_SECRET', 'TOKEN_PEPPER', 'SECURITY_INTEGRITY_KEY', 'DATA_ENCRYPTION_KEY']) {
  process.env[name] = crypto.randomBytes(32).toString('hex');
}
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const paths = ['/seller/promotions', '/seller/coupons', '/seller/subscription'];
const csrf = html => {
  const match = html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/);
  assert.ok(match, 'the real authenticated page must include a CSRF token');
  return match[1];
};
const hasCode = code => error => error?.code === code;
const assertRedirect = (response, location) => {
  assert.equal(response.status, 302, response.text);
  assert.equal(response.headers.location, location);
};

test('seller growth pages persist authenticated store promotions, coupons and subscription requests with atomic evidence', { skip: !uri, timeout: 180_000 }, async t => {
  const endpoint = new URL(uri);
  assert.equal(endpoint.hostname, '127.0.0.1');
  assert.match(endpoint.pathname, /verification|test/i);
  const database = `classicmart_seller_growth_pages_test_${suffix}`;
  const transports = [];
  await mongoose.connect(uri, { dbName: database });
  try {
    const { createApp } = await import('../src/app.js');
    const models = await import('../src/models/index.js');
    const { User, Store, StoreMember, CountrySetting, Category, Product, ProductVariant, SellerPromotion,
      SubscriptionPlan, SubscriptionEnrollment, SubscriptionChangeRequest, SubscriptionCharge, PlatformGrant, AuditLog, Device } = models;
    const { hashPassword, hashToken } = await import('../src/core/crypto.js');
    const { beginMfaEnrollment, confirmMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
    const { sellerPromotionsPage, sellerSubscriptionPage, createGrowthPromotion, updateGrowthPromotionStatus,
      requestSellerSubscription } = await import('../src/services/seller-growth-pages.js');
    const { promotionQuote } = await import('../src/services/seller-growth.js');
    const { env } = await import('../src/config/env.js');
    assert.equal(env.mailMode, 'log');
    assert.equal(env.sms.mode, 'log');
    const app = createApp(null), password = `Growth-${suffix}-A1!`, passwordHash = await hashPassword(password);
    let sequence = 0;
    const nextId = prefix => `${prefix}_growth_${suffix}_${++sequence}`;
    const start = new Date(Date.now() - 60_000).toISOString();
    const end = new Date(Date.now() + 7 * 86_400_000).toISOString();

    async function actor(role = 'seller', { enroll = role === 'seller', onboarded = true } = {}) {
      const number = ++sequence, email = `growth-${suffix}-${number}@example.com`, phone = `+25670${String(number).padStart(7, '0')}`;
      let user = await User.create({ publicId: `usr_growth_${suffix}_${number}`, name: `Growth Actor ${number}`, email, emailNormalized: email,
        phone, phoneNormalized: phone, passwordHash, role, country: 'UG', currency: 'UGX', locale: 'en-UG',
        emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), ...(onboarded ? { onboardingCompletedAt: new Date() } : {}),
        consents: { terms: true, privacy: true, recordedAt: new Date() } });
      let recoveryCodes = [];
      if (enroll) {
        const pending = await beginMfaEnrollment(user._id, password);
        const confirmed = await confirmMfaEnrollment(user._id, totpCode(pending.secret));
        user = confirmed.user; recoveryCodes = confirmed.codes;
      }
      // Actual separate loopback clients avoid weakening the application's rate limits.
      const transport = new http.Agent({ localAddress: `127.0.0.${transports.length + 2}`, keepAlive: false });
      transports.push(transport);
      const client = request.agent(app).use(req => req.agent(transport));
      const login = await client.get('/login').expect(200);
      const authenticated = await client.post('/login').type('form').send({ email, password, _csrf: csrf(login.text) }).expect(302);
      if (enroll) {
        assert.equal(authenticated.headers.location, '/mfa');
        const challenge = await client.get('/mfa').expect(200);
        await client.post('/mfa').type('form').send({ code: recoveryCodes[0], _csrf: csrf(challenge.text) }).expect(302);
      }
      user = await User.findById(user._id);
      const serviceSessionID = crypto.randomUUID();
      const serviceDevice = await Device.create({ publicId: nextId('dev'), userId: user._id, sessionHash: hashToken(serviceSessionID), label: 'Current Seller fixture device', userAgent: 'Seller regression', ipHash: hashToken('127.0.0.1'), lastSeenAt: new Date() });
      return { user, client, serviceSessionID, serviceDevice };
    }
    async function storeFor(identity, name) {
      const store = await Store.create({ publicId: nextId('str'), ownerUserId: identity.user._id, name,
        slug: `growth-${suffix}-${sequence}`, country: 'UG', currency: 'UGX', status: 'verified' });
      const member = await StoreMember.create({ publicId: nextId('stm'), storeId: store._id, userId: identity.user._id,
        invitedByUserId: identity.user._id, role: 'owner', status: 'active', acceptedAt: new Date() });
      return { store, member };
    }
    const scoped = (identity, store) => ({ id: nextId('request'), user: identity.user, store, device: identity.serviceDevice, sessionID: identity.serviceSessionID,
      session: { userId: String(identity.user._id), tokenVersion: identity.user.security.tokenVersion, activeStorePublicId: store.publicId, ...(identity.user.security.mfaEnabled ? { mfaVerifiedAt: Date.now() } : {}) }, country: { code: store.country, currency: store.currency }, ip: '127.0.0.1', get: () => '', query: {} });
    async function selectStore(identity, selectedStore) {
      const security = await identity.client.get('/account/security').expect(200);
      await identity.client.post('/seller/workspace').set('accept', 'application/json').type('form')
        .send({ storePublicId: selectedStore.publicId, _csrf: csrf(security.text) }).expect(200);
    }
    const json = (identity, path) => identity.client.get(path).set('accept', 'application/json');
    async function post(identity, pagePath, actionPath, payload, acceptJson = false) {
      const page = await identity.client.get(pagePath).expect(200);
      const result = identity.client.post(actionPath).type('form');
      if (acceptJson) result.set('accept', 'application/json');
      return result.send({ _csrf: csrf(page.text), ...payload });
    }
    function assertShell(page, domain) {
      assert.match(page.text, /data-dashboard-workspace="seller"/);
      assert.match(page.text, /<small>Seller<\/small>/);
      assert.match(page.text, new RegExp(`data-page="seller-${domain}"`));
      assert.doesNotMatch(page.text, /Development preview|role-workspaces\.js|aria-label="Wishlist"|aria-label="Cart"/);
      assert.match(page.headers['cache-control'], /private/);
      assert.match(page.headers['cache-control'], /no-store/);
      assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
      csrf(page.text);
    }

    // Await every registered collection/index before transactions and before cleanup.
    await Promise.all(Object.values(mongoose.models).map(model => model.init()));
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true });
    const owner = await actor(), other = await actor(), customer = await actor('customer'), unenrolled = await actor('seller', { enroll: false });
    const { store, member: ownerMember } = await storeFor(owner, 'Growth Owner Store');
    const { store: foreign } = await storeFor(other, 'FOREIGN_GROWTH_STORE_SECRET');
    const req = scoped(owner, store);
    const category = await Category.create({ publicId: nextId('cat'), name: 'Growth products', slug: `growth-products-${suffix}`, countries: ['UG'] });
    async function productFor(identity, selectedStore, title, { status = 'published', countries = ['UG'], currency = 'UGX', active = true } = {}) {
      const product = await Product.create({ publicId: nextId('prd'), storeId: selectedStore._id, ownerUserId: identity.user._id,
        categoryId: category._id, title, slug: `growth-product-${suffix}-${sequence}`, description: 'A genuine product fixture for seller growth validation.', countries, status });
      const variant = await ProductVariant.create({ publicId: nextId('var'), productId: product._id, storeId: selectedStore._id,
        sku: `GROWTH-${suffix}-${sequence}`, title: 'Standard', priceMinor: 10_000, minimumPriceMinor: 8000, costMinor: 5000, currency, active });
      return { product, variant };
    }
    const first = await productFor(owner, store, 'Growth Cotton Bag'), second = await productFor(owner, store, 'Growth Travel Pouch');
    const foreignProduct = await productFor(other, foreign, 'FOREIGN_GROWTH_PRODUCT_SECRET');
    const wrongCountry = await productFor(owner, store, 'WRONG_COUNTRY_GROWTH_PRODUCT', { countries: ['KE'] });
    const wrongCurrency = await productFor(owner, store, 'WRONG_CURRENCY_GROWTH_PRODUCT', { currency: 'KES' });
    const draftProduct = await productFor(owner, store, 'DRAFT_GROWTH_PRODUCT', { status: 'draft' });
    const promotion = { type: 'bundle', name: 'Real bag and pouch offer', productPublicIds: `${first.product.publicId},${second.product.publicId}`,
      discountBps: '1000', fixedDiscountMinor: '0', minQuantity: '1', minSubtotalMinor: '0', startsAt: start, endsAt: end, status: 'draft' };
    const coupon = { name: 'Real store voucher', code: `SAVE${suffix}`, discountBps: '1000', fixedDiscountMinor: '0',
      minSubtotalMinor: '0', startsAt: start, endsAt: end, status: 'draft' };
    let savedPromotion, savedCoupon;

    await t.test('authentication, customer roles, onboarding and MFA fail before operational reads or writes', async () => {
      for (const path of paths) {
        await request(app).get(path).expect(302).expect('location', '/login?next=' + encodeURIComponent(path));
        await request(app).get(path).set('accept', 'application/json').expect(401);
        await json(customer, path).expect(403);
        await unenrolled.client.get(path).expect(302).expect('location', '/account/security?next=' + encodeURIComponent(path));
        const denied = await json(unenrolled, path).expect(403);
        assert.equal(denied.body.error.code, 'MFA_ENROLLMENT_REQUIRED');
      }
      const customerSecurity = await customer.client.get('/account/security').expect(200);
      for (const [path, input] of [['/seller/promotions', promotion], ['/seller/coupons', coupon], ['/seller/subscription/requests', { planPublicId: 'spl_missing' }]]) {
        await customer.client.post(path).type('form').send({ ...input, _csrf: csrf(customerSecurity.text) }).set('accept', 'application/json').expect(403);
        await owner.client.post(path).type('form').send(input).expect(403);
      }
      assert.equal(await Store.countDocuments({ ownerUserId: customer.user._id }), 0);
      assert.equal(await SellerPromotion.countDocuments(), 0);
      assert.equal(await SubscriptionChangeRequest.countDocuments(), 0);
      const unfinished = await actor('seller', { onboarded: false });
      for (const path of paths) await unfinished.client.get(path).expect(302).expect('location', '/onboarding');
      assert.equal(await Store.countDocuments({ ownerUserId: unfinished.user._id }), 0);
    });

    await t.test('canonical seller pages expose real empty collections, private responses and canonical forms', async () => {
      for (const domain of ['promotions', 'coupons', 'subscription']) {
        const path = '/seller/' + domain, page = await owner.client.get(path).expect(200);
        assertShell(page, domain);
        if (domain !== 'subscription') assert.match(page.text, new RegExp(`action="${path}"`));
        else assert.doesNotMatch(page.text, /action="\/seller\/subscription\/requests"/);
        const data = (await json(owner, path).expect(200)).body;
        assert.equal(data.kind, 'growth'); assert.equal(data.domain, domain);
        assert.equal(data.store.publicId, store.publicId);
        if (domain !== 'subscription') assert.deepEqual(data.promotions, []);
        else { assert.deepEqual(data.plans, []); assert.equal(data.enrollment, null); assert.deepEqual(data.changeRequests, []); }
        assert.doesNotMatch(JSON.stringify(data), /FOREIGN_GROWTH|WRONG_COUNTRY_GROWTH|WRONG_CURRENCY_GROWTH|DRAFT_GROWTH_PRODUCT/);
        await owner.client.get('/dashboard/seller-' + domain + '?search=hello').expect(308).expect('location', path + '?search=hello');
      }
    });

    await t.test('real promotion and coupon forms persist only authoritative store fields and audit evidence', async () => {
      assertRedirect(await post(owner, '/seller/promotions', '/seller/promotions', { ...promotion, storeId: String(foreign._id),
        storePublicId: foreign.publicId, country: 'KE', currency: 'KES', createdByUserId: String(other.user._id) }), '/seller/promotions');
      savedPromotion = await SellerPromotion.findOne({ storeId: store._id, name: promotion.name });
      assert.ok(savedPromotion); assert.equal(savedPromotion.type, 'bundle'); assert.equal(savedPromotion.status, 'draft');
      assert.deepEqual(savedPromotion.productPublicIds.toObject(), [first.product.publicId, second.product.publicId]);
      assert.equal(savedPromotion.discountBps, 1000); assert.equal(savedPromotion.country, 'UG'); assert.equal(savedPromotion.currency, 'UGX');
      assert.equal(savedPromotion.storePublicId, store.publicId); assert.equal(String(savedPromotion.createdByUserId), String(owner.user._id));
      assertRedirect(await post(owner, '/seller/coupons', '/seller/coupons', { ...coupon, code: coupon.code.toLowerCase(), type: 'sponsored',
        storeId: String(foreign._id), country: 'KE', currency: 'KES' }), '/seller/coupons');
      savedCoupon = await SellerPromotion.findOne({ code: coupon.code.toUpperCase() });
      assert.equal(savedCoupon.type, 'voucher'); assert.equal(savedCoupon.storePublicId, store.publicId);
      assert.equal(savedCoupon.country, 'UG'); assert.equal(savedCoupon.currency, 'UGX'); assert.equal(savedCoupon.status, 'draft');
      assert.equal(await AuditLog.countDocuments({ action: 'seller.promotion.created', targetPublicId: savedPromotion.publicId, actorId: owner.user._id }), 1);
      assert.equal(await AuditLog.countDocuments({ action: 'seller.coupon.created', targetPublicId: savedCoupon.publicId, actorId: owner.user._id }), 1);
      const promotions = (await json(owner, '/seller/promotions').expect(200)).body;
      const coupons = (await json(owner, '/seller/coupons').expect(200)).body;
      assert.ok(promotions.promotions.some(row => row.publicId === savedPromotion.publicId));
      assert.ok(coupons.promotions.some(row => row.publicId === savedCoupon.publicId));
      assert.equal(promotions.promotions.some(row => row.publicId === savedCoupon.publicId), false);
      assert.equal(coupons.promotions.some(row => row.publicId === savedPromotion.publicId), false);
      for (const data of [promotions, coupons]) {
        assert.doesNotMatch(JSON.stringify(data), new RegExp(String(store._id)));
        assert.doesNotMatch(JSON.stringify(data), /passwordHash|security|createdByUserId/);
      }
    });

    await t.test('discount, eligibility and date checks reject invalid data without partial records', async () => {
      const count = await SellerPromotion.countDocuments();
      for (const patch of [{ discountBps: '1000.5' }, { discountBps: '-1' }, { discountBps: '9001' },
        { fixedDiscountMinor: '0.5' }, { fixedDiscountMinor: '-1' }, { fixedDiscountMinor: '2000000001' },
        { minQuantity: '1.5' }, { minSubtotalMinor: '-1' }, { name: 'x' },
        { productPublicIds: first.product.publicId }, { productPublicIds: foreignProduct.product.publicId },
        { productPublicIds: `${first.product.publicId},${wrongCountry.product.publicId}` },
        { productPublicIds: `${first.product.publicId},${wrongCurrency.product.publicId}` },
        { productPublicIds: `${first.product.publicId},${draftProduct.product.publicId}` },
        { type: 'quantity_break', minQuantity: '1', productPublicIds: first.product.publicId },
        { type: 'sponsored', productPublicIds: '', disclosureText: '' },
        { discountBps: '0', fixedDiscountMinor: '0' }]) {
        await assert.rejects(createGrowthPromotion(scoped(owner, store), { ...promotion, ...patch }), error => error?.status === 422 || error?.name === 'ZodError');
      }
      for (const patch of [{ startsAt: 'not-a-date' }, { endsAt: 'not-a-date' }, { startsAt: end, endsAt: start }]) {
        await assert.rejects(createGrowthPromotion(scoped(owner, store), { ...promotion, ...patch }), hasCode('PROMOTION_DATE_INVALID'));
      }
      await assert.rejects(createGrowthPromotion(scoped(owner, store), { ...promotion,
        startsAt: new Date(Date.now() - 86_400_000).toISOString(), endsAt: new Date(Date.now() - 60_000).toISOString(), status: 'active' }), hasCode('PROMOTION_WINDOW_ENDED'));
      await assert.rejects(createGrowthPromotion(scoped(owner, store), { ...promotion, discountBps: '2500' }), hasCode('MINIMUM_PRICE_VIOLATION'));
      await assert.rejects(createGrowthPromotion(scoped(owner, store), { ...coupon, code: 'ALLSTORE' + suffix, discountBps: '2500' }, true), hasCode('MINIMUM_PRICE_VIOLATION'));
      await assert.rejects(createGrowthPromotion(scoped(owner, store), { ...coupon, code: '' }, true), error => error?.status === 422 || error?.name === 'ZodError');
      assert.equal(await SellerPromotion.countDocuments(), count);
      const invalid = await post(owner, '/seller/promotions', '/seller/promotions', { ...promotion, name: 'Saved invalid offer name', startsAt: 'invalid-date' });
      assert.equal(invalid.status, 422); assert.match(invalid.text, /Saved invalid offer name/);
      assertShell(invalid, 'promotions');
      const duplicate = await post(other, '/seller/coupons', '/seller/coupons', coupon, true);
      assert.equal(duplicate.status, 409);
      assert.equal(await SellerPromotion.countDocuments(), count);
    });

    await t.test('store and domain boundaries protect reads and promotion status changes', async () => {
      const foreignCoupon = await createGrowthPromotion(scoped(other, foreign), { ...coupon, name: 'FOREIGN_COUPON_SECRET', code: 'FOREIGN' + suffix }, true);
      for (const path of ['/seller/promotions', '/seller/coupons']) {
        const page = await owner.client.get(path + '?storePublicId=' + foreign.publicId + '&storeId=' + foreign._id).expect(200);
        assert.doesNotMatch(page.text, /FOREIGN_COUPON_SECRET|FOREIGN_GROWTH_STORE_SECRET|FOREIGN_GROWTH_PRODUCT_SECRET/);
        assert.equal((await json(owner, path + '?storePublicId=' + foreign.publicId).expect(200)).body.store.publicId, store.publicId);
      }
      const token = csrf((await owner.client.get('/seller/promotions').expect(200)).text);
      await owner.client.post(`/seller/promotions/${savedPromotion.publicId}/status`).type('form').send({ status: 'active', version: savedPromotion.__v }).expect(403);
      for (const [path, row] of [[`/seller/promotions/${savedCoupon.publicId}/status`, savedCoupon],
        [`/seller/coupons/${savedPromotion.publicId}/status`, savedPromotion], [`/seller/coupons/${foreignCoupon.publicId}/status`, foreignCoupon]]) {
        await owner.client.post(path).set('accept', 'application/json').type('form').send({ _csrf: token, status: 'active', version: row.__v,
          storeId: String(foreign._id), storePublicId: foreign.publicId }).expect(404);
      }
      assert.equal((await SellerPromotion.findById(foreignCoupon._id)).status, 'draft');
      await assert.rejects(sellerPromotionsPage(scoped(owner, foreign)), hasCode('STORE_PERMISSION_DENIED'));
      await assert.rejects(sellerSubscriptionPage(scoped(owner, foreign)), hasCode('STORE_PERMISSION_DENIED'));
      await assert.rejects(updateGrowthPromotionStatus(scoped(owner, store), foreignCoupon.publicId, { status: 'active', version: foreignCoupon.__v }, true), hasCode('PROMOTION_NOT_FOUND'));
    });

    await t.test('activation rechecks current floors, stale versions and terminal status, and persists audited transitions', async () => {
      await ProductVariant.updateOne({ _id: first.variant._id }, { $set: { minimumPriceMinor: 9500 } });
      const failed = await post(owner, '/seller/promotions', `/seller/promotions/${savedPromotion.publicId}/status`, { status: 'active', version: savedPromotion.__v }, true);
      assert.equal(failed.status, 409); assert.equal(failed.body.error.code, 'MINIMUM_PRICE_VIOLATION');
      assert.equal((await SellerPromotion.findById(savedPromotion._id)).status, 'draft');
      await ProductVariant.updateOne({ _id: first.variant._id }, { $set: { minimumPriceMinor: 8000 } });
      const activate = await post(owner, '/seller/promotions', `/seller/promotions/${savedPromotion.publicId}/status`, { status: 'active', version: savedPromotion.__v });
      assert.equal(activate.status, 302);
      const active = await SellerPromotion.findById(savedPromotion._id);
      assert.equal(active.status, 'active'); assert.equal(active.__v, savedPromotion.__v + 1);
      const stale = await post(owner, '/seller/promotions', `/seller/promotions/${savedPromotion.publicId}/status`, { status: 'paused', version: savedPromotion.__v }, true);
      assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'PROMOTION_VERSION_CONFLICT');
      assertRedirect(await post(owner, '/seller/promotions', `/seller/promotions/${active.publicId}/status`, { status: 'paused', version: active.__v }), '/seller/promotions');
      const paused = await SellerPromotion.findById(active._id);
      assert.equal(paused.status, 'paused');
      assertRedirect(await post(owner, '/seller/promotions', `/seller/promotions/${active.publicId}/status`, { status: 'expired', version: paused.__v }), '/seller/promotions');
      const expired = await SellerPromotion.findById(active._id);
      await assert.rejects(updateGrowthPromotionStatus(scoped(owner, store), expired.publicId, { status: 'active', version: expired.__v }), hasCode('PROMOTION_STATUS_CONFLICT'));
      const updatedCoupon = await updateGrowthPromotionStatus(scoped(owner, store), savedCoupon.publicId, { status: 'active', version: savedCoupon.__v }, true);
      assert.equal(updatedCoupon.status, 'active');
      assert.equal(await AuditLog.countDocuments({ action: 'seller.promotion.status', targetPublicId: active.publicId }), 3);
      assert.equal(await AuditLog.countDocuments({ action: 'seller.coupon.status', targetPublicId: savedCoupon.publicId }), 1);
      const quoteRows = [{ storeId: store.publicId, productId: first.product.publicId, variantId: first.variant.publicId,
        priceMinor: 10_000, minimumPriceMinor: 8000, quantity: 1 }];
      const quote = await promotionQuote({ rows: quoteRows, country: 'UG', codes: [savedCoupon.code] });
      assert.equal(quote.discountMinor, 1000); assert.equal(quote.applications.length, 1);
      assert.equal((await promotionQuote({ rows: quoteRows, country: 'UG' })).discountMinor, 0);
      await updateGrowthPromotionStatus(scoped(owner, store), savedCoupon.publicId, { status: 'paused', version: updatedCoupon.__v }, true);
      assert.equal((await promotionQuote({ rows: quoteRows, country: 'UG', codes: [savedCoupon.code] })).discountMinor, 0);
      const scheduled = await createGrowthPromotion(scoped(owner, store), { ...promotion, name: 'Future scheduled offer', status: 'active',
        startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: end });
      assert.equal(scheduled.status, 'active');
      assert.equal((await promotionQuote({ rows: [...quoteRows, { ...quoteRows[0], productId: second.product.publicId, variantId: second.variant.publicId }], country: 'UG' })).discountMinor, 0);
      await SellerPromotion.updateOne({ _id: scheduled._id }, { $set: { startsAt: new Date(Date.now() - 86_400_000), endsAt: new Date(Date.now() - 60_000), status: 'paused' } });
      await assert.rejects(updateGrowthPromotionStatus(scoped(owner, store), scheduled.publicId, { status: 'active', version: scheduled.__v }), hasCode('PROMOTION_WINDOW_ENDED'));
    });

    await t.test('promotion and status transactions roll back fully when audit storage fails', async () => {
      const before = await SellerPromotion.countDocuments();
      const current = await SellerPromotion.findById(savedCoupon._id).lean();
      const storeBefore = await Store.findById(store._id).lean();
      const memberBefore = await StoreMember.findById(ownerMember._id).lean();
      t.mock.method(AuditLog, 'create', async () => { throw new Error('Growth audit unavailable'); });
      try {
        await assert.rejects(createGrowthPromotion(scoped(owner, store), { ...promotion, name: 'Must roll back creation' }), /Growth audit unavailable/);
        await assert.rejects(createGrowthPromotion(scoped(owner, store), { ...coupon, code: 'ROLLBACK' + suffix }, true), /Growth audit unavailable/);
        await assert.rejects(updateGrowthPromotionStatus(scoped(owner, store), savedCoupon.publicId, { status: 'active', version: current.__v }, true), /Growth audit unavailable/);
      } finally { t.mock.restoreAll(); }
      assert.equal(await SellerPromotion.countDocuments(), before);
      assert.deepEqual(await SellerPromotion.findById(savedCoupon._id).lean(), current);
      assert.deepEqual(await Store.findById(store._id).lean(), storeBefore);
      assert.deepEqual(await StoreMember.findById(ownerMember._id).lean(), memberBefore);
    });

    await t.test('lists paginate all real store offers, escape literal searches and render stored names safely', async () => {
      await SellerPromotion.insertMany(Array.from({ length: 30 }, (_, index) => ({ publicId: nextId('spr'), storeId: store._id,
        storePublicId: store.publicId, country: 'UG', currency: 'UGX', type: 'free_shipping', name: `Paged [offer] ${index}`,
        startsAt: new Date(start), endsAt: new Date(end), status: 'draft', createdByUserId: owner.user._id })));
      const escaped = await createGrowthPromotion(scoped(owner, store), { type: 'free_shipping', name: '<script>alert("growth")</script>',
        startsAt: start, endsAt: end, status: 'draft' });
      const total = await SellerPromotion.countDocuments({ storeId: store._id, country: 'UG', currency: 'UGX', type: { $ne: 'voucher' } });
      const ids = new Set();
      let cursor = '', more = true, pages = 0;
      while (more) {
        assert.ok(++pages < 10, 'pagination must eventually finish');
        const data = (await json(owner, '/seller/promotions' + (cursor ? '?after=' + encodeURIComponent(cursor) : '')).expect(200)).body;
        assert.equal(data.page.total, total);
        for (const row of data.promotions) { assert.equal(ids.has(row.publicId), false, 'cursor pages must not repeat offers'); ids.add(row.publicId); }
        assert.doesNotMatch(JSON.stringify(data), /FOREIGN_COUPON_SECRET|FOREIGN_GROWTH_PRODUCT_SECRET/);
        more = data.page.hasMore; cursor = data.page.next;
        if (more) assert.ok(cursor);
      }
      assert.ok(pages > 1); assert.equal(ids.size, total); assert.ok(ids.has(escaped.publicId));
      const searched = (await json(owner, '/seller/promotions?search=' + encodeURIComponent('[offer]')).expect(200)).body;
      assert.equal(searched.page.total, 30); assert.ok(searched.promotions.every(row => row.name.includes('[offer]')));
      const page = await owner.client.get('/seller/promotions?search=' + encodeURIComponent('alert("growth")')).expect(200);
      assert.doesNotMatch(page.text, /<script>alert\("growth"\)<\/script>/);
      assert.match(page.text, /&lt;script&gt;alert\(/);
    });

    let plan, currentEnrollment;
    await t.test('subscription reads select active seller country/currency plans and only owned enrollments and request history', async () => {
      async function planFor(name, overrides = {}) {
        return SubscriptionPlan.create({ publicId: nextId('spl'), key: `growth-${suffix}-${sequence}`, name, description: 'Recorded plan terms.',
          audience: 'seller', country: 'UG', currency: 'UGX', priceMinor: 25_000, cadence: 'monthly', features: ['Recorded seller support'],
          status: 'active', createdByUserId: owner.user._id, updatedByUserId: owner.user._id, ...overrides });
      }
      plan = await planFor('Real Growth Seller Plan');
      await planFor('PROMOTER_PLAN_SECRET', { audience: 'promoter' });
      await planFor('FOREIGN_COUNTRY_PLAN_SECRET', { country: 'KE', currency: 'KES' });
      await planFor('WRONG_CURRENCY_PLAN_SECRET', { currency: 'KES' });
      await planFor('DRAFT_PLAN_SECRET', { status: 'draft' });
      await planFor('RETIRED_PLAN_SECRET', { status: 'retired' });
      const billing = await import('../src/services/seller-subscription-operations.js');
      const { sellerTransaction } = await import('../src/services/seller-operations-access.js');
      const reviewer = await actor('super_admin', { enroll: true });
      await User.updateOne({ _id: reviewer.user._id }, { $set: { platformAccessManagedAt: new Date(), operationalCountries: ['*'] } });
      reviewer.user = await User.findById(reviewer.user._id);
      await PlatformGrant.create({ publicId: nextId('pgr'), userId: reviewer.user._id, role: 'super_admin', operationalCountries: ['*'], status: 'active',
        startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000), reason: 'Independent subscription fixture reviewer.', approvalPublicId: nextId('apr'), approvedByUserId: new mongoose.Types.ObjectId() });
      const currentPlan = await planFor('Current reviewed free Seller period', { priceMinor: 0, entitlements: { productLimit: 1000, seatLimit: 10, campaignLimit: 10, analyticsDays: 3660, analyticsExport: true } });
      for (const [identity, selectedStore] of [[owner, store], [other, foreign]]) {
        const change = await billing.requestReviewedSellerSubscription(scoped(identity, selectedStore), { planPublicId: currentPlan.publicId, note: 'Activate independently reviewed free plan terms.' });
        await sellerTransaction(session => billing.reviewSellerSubscriptionRequest({ ...scoped(reviewer, selectedStore), requiredOperationalWorkspace: 'superadmin' }, change.publicId,
          { decision: 'approve', version: change.__v, reason: 'Independently reviewed the actual free period and capacity.' }, { session }));
        const reviewed = await SubscriptionChangeRequest.findById(change._id);
        const charge = await billing.startSellerSubscriptionPayment(scoped(identity, selectedStore), { requestPublicId: reviewed.publicId, version: reviewed.__v, idempotencyKey: nextId('activation') });
        assert.equal(charge.status, 'succeeded');
        const settled = await SubscriptionCharge.findOne({ publicId: charge.publicId });
        assert.equal(settled.amountMinor, 0); assert.ok(settled.paidAt);
        if (identity === owner) currentEnrollment = await SubscriptionEnrollment.findOne({ subscriptionChargeId: settled._id, storeId: store._id });
      }
      assert.ok(currentEnrollment?.terms);
      // Retiring the free catalogue offer does not erase its already activated period.
      await SubscriptionPlan.updateOne({ _id: currentPlan._id }, { $set: { status: 'retired' } });
      const history = { audience: 'seller', planId: plan._id, planPublicId: plan.publicId, country: 'UG', currency: 'UGX',
        requestedPriceMinor: plan.priceMinor, requestedCadence: plan.cadence, status: 'rejected' };
      await SubscriptionChangeRequest.create({ publicId: nextId('scr'), ...history, userId: owner.user._id, storeId: store._id, storePublicId: store.publicId, note: 'OWN_SUBSCRIPTION_HISTORY' });
      await SubscriptionChangeRequest.create({ publicId: nextId('scr'), ...history, userId: other.user._id, storeId: foreign._id, storePublicId: foreign.publicId, note: 'FOREIGN_SUBSCRIPTION_REQUEST_SECRET' });
      const result = await json(owner, '/seller/subscription?storeId=' + foreign._id).expect(200), data = result.body;
      assert.deepEqual(data.plans.map(row => row.publicId), [plan.publicId]);
      assert.equal(data.enrollment.publicId, currentEnrollment.publicId);
      assert.equal(data.changeRequests.length, 2); assert.equal(data.changeRequests.filter(row => row.note === 'OWN_SUBSCRIPTION_HISTORY').length, 1);
      assert.doesNotMatch(JSON.stringify(data), /PROMOTER_PLAN_SECRET|FOREIGN_COUNTRY_PLAN_SECRET|WRONG_CURRENCY_PLAN_SECRET|DRAFT_PLAN_SECRET|RETIRED_PLAN_SECRET|FOREIGN_SUBSCRIPTION_REQUEST_SECRET/);
      const page = await owner.client.get('/seller/subscription').expect(200);
      assertShell(page, 'subscription'); assert.match(page.text, /Real Growth Seller Plan/);
      assert.match(page.text, /action="\/seller\/subscription\/requests"/);
      assert.doesNotMatch(page.text, /FOREIGN_SUBSCRIPTION_REQUEST_SECRET|DRAFT_PLAN_SECRET|PROMOTER_PLAN_SECRET/);
    });

    await t.test('subscription request forms snapshot authoritative plan terms without activating or modifying enrollment', async () => {
      const previous = await SubscriptionEnrollment.findById(currentEnrollment._id).lean();
      for (const unavailable of await SubscriptionPlan.find({ publicId: { $ne: plan.publicId } })) {
        await assert.rejects(requestSellerSubscription(scoped(owner, store), { planPublicId: unavailable.publicId }), hasCode('SUBSCRIPTION_PLAN_UNAVAILABLE'));
      }
      const invalid = await post(owner, '/seller/subscription', '/seller/subscription/requests', { planPublicId: 'spl_unknown', note: 'Invalid plan' }, true);
      assert.equal(invalid.status, 422); assert.equal(invalid.body.error.code, 'SUBSCRIPTION_PLAN_UNAVAILABLE');
      assertRedirect(await post(owner, '/seller/subscription', '/seller/subscription/requests', { planPublicId: plan.publicId, note: 'Please review our subscription request.',
        userId: String(other.user._id), storeId: String(foreign._id), storePublicId: foreign.publicId, country: 'KE', currency: 'KES',
        requestedPriceMinor: '0', priceMinor: '0', requestedCadence: 'yearly', status: 'approved' }), '/seller/subscription');
      const change = await SubscriptionChangeRequest.findOne({ storeId: store._id, status: 'requested' });
      assert.equal(change.planPublicId, plan.publicId); assert.equal(change.requestedPriceMinor, 25_000);
      assert.equal(change.requestedCadence, 'monthly'); assert.equal(change.status, 'requested');
      assert.equal(change.country, 'UG'); assert.equal(change.currency, 'UGX'); assert.equal(change.storePublicId, store.publicId);
      assert.equal(String(change.userId), String(owner.user._id));
      assert.deepEqual(await SubscriptionEnrollment.findById(currentEnrollment._id).lean(), previous);
      const duplicate = await post(owner, '/seller/subscription', '/seller/subscription/requests', { planPublicId: plan.publicId }, true);
      assert.equal(duplicate.status, 409); assert.equal(duplicate.body.error.code, 'SUBSCRIPTION_CHANGE_PENDING');
      assert.equal(await SubscriptionChangeRequest.countDocuments({ storeId: store._id, status: 'requested' }), 1);
      assert.equal(await AuditLog.countDocuments({ action: 'seller.subscription_change_requested', targetPublicId: change.publicId }), 1);
      await SubscriptionChangeRequest.updateOne({ _id: change._id }, { $set: { status: 'cancelled' } });
    });

    await t.test('subscription audit failure leaves no request and concurrent submissions produce exactly one pending request', async () => {
      const before = await SubscriptionChangeRequest.countDocuments({ storeId: store._id });
      const enrollmentBefore = await SubscriptionEnrollment.findById(currentEnrollment._id).lean();
      const storeBefore = await Store.findById(store._id).lean();
      const memberBefore = await StoreMember.findById(ownerMember._id).lean();
      t.mock.method(AuditLog, 'create', async () => { throw new Error('Subscription audit unavailable'); });
      try {
        await assert.rejects(requestSellerSubscription(scoped(owner, store), { planPublicId: plan.publicId, note: 'Must roll back' }), /Subscription audit unavailable/);
      } finally { t.mock.restoreAll(); }
      assert.equal(await SubscriptionChangeRequest.countDocuments({ storeId: store._id }), before);
      assert.deepEqual(await Store.findById(store._id).lean(), storeBefore);
      assert.deepEqual(await StoreMember.findById(ownerMember._id).lean(), memberBefore);
      const delegated = await StoreMember.create({ publicId: nextId('stm'), storeId: store._id, userId: other.user._id,
        invitedByUserId: owner.user._id, role: 'admin', status: 'active', acceptedAt: new Date() });
      let attempts;
      try {
        attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => requestSellerSubscription(scoped(index % 2 ? other : owner, store), {
          planPublicId: plan.publicId, note: `Concurrent request ${index}` })));
      } finally { await StoreMember.updateOne({ _id: delegated._id }, { $set: { status: 'revoked' } }); }
      assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
      const failures = attempts.filter(result => result.status === 'rejected');
      assert.equal(failures.length, 7);
      assert.ok(failures.every(result => result.reason.code === 'SUBSCRIPTION_CHANGE_PENDING'), failures.map(result => result.reason.code || result.reason.message).join(', '));
      const change = await SubscriptionChangeRequest.findOne({ storeId: store._id, status: 'requested' });
      assert.equal(await SubscriptionChangeRequest.countDocuments({ storeId: store._id, status: 'requested' }), 1);
      assert.equal(await SubscriptionChangeRequest.countDocuments({ storeId: store._id }), before + 1);
      assert.equal(await AuditLog.countDocuments({ action: 'seller.subscription_change_requested', targetPublicId: change.publicId }), 1);
      assert.deepEqual(await SubscriptionEnrollment.findById(currentEnrollment._id).lean(), enrollmentBefore);
    });

    await t.test('fresh membership, account, store and country checks protect direct services and delegated staff', async () => {
      const staff = await actor('customer', { enroll: true });
      const member = await StoreMember.create({ publicId: nextId('stm'), storeId: store._id, userId: staff.user._id,
        invitedByUserId: owner.user._id, role: 'catalogue', status: 'active', acceptedAt: new Date() });
      await selectStore(staff, store);
      for (const path of paths) await json(staff, path).expect(403);
      await assert.rejects(createGrowthPromotion(scoped(staff, store), promotion), hasCode('STORE_PERMISSION_DENIED'));
      await assert.rejects(requestSellerSubscription(scoped(staff, store), { planPublicId: plan.publicId }), hasCode('STORE_PERMISSION_DENIED'));
      await StoreMember.updateOne({ _id: member._id }, { $set: { role: 'admin' } });
      for (const path of paths) assert.equal((await json(staff, path).expect(200)).body.store.publicId, store.publicId);
      await StoreMember.updateOne({ _id: member._id }, { $set: { status: 'revoked' } });
      await assert.rejects(sellerPromotionsPage(scoped(staff, store)), hasCode('STORE_PERMISSION_DENIED'));
      await assert.rejects(sellerSubscriptionPage(scoped(staff, store)), hasCode('STORE_PERMISSION_DENIED'));
      await StoreMember.updateOne({ _id: ownerMember._id }, { $set: { status: 'revoked' } });
      try { await assert.rejects(createGrowthPromotion(scoped(owner, store), promotion), hasCode('STORE_PERMISSION_DENIED')); }
      finally { await StoreMember.updateOne({ _id: ownerMember._id }, { $set: { status: 'active' } }); }
      await User.updateOne({ _id: owner.user._id }, { $inc: { 'security.tokenVersion': 1 } });
      try {
        await assert.rejects(sellerPromotionsPage(req), hasCode('ACCOUNT_UNAVAILABLE'));
        await assert.rejects(requestSellerSubscription(req, { planPublicId: plan.publicId }), hasCode('ACCOUNT_UNAVAILABLE'));
      } finally { await User.updateOne({ _id: owner.user._id }, { $set: { 'security.tokenVersion': owner.user.security.tokenVersion } }); }
      await Store.updateOne({ _id: store._id }, { $set: { status: 'suspended' } });
      try {
        for (const path of paths) await json(owner, path).expect(path === '/seller/subscription' ? 200 : 409);
        await assert.rejects(createGrowthPromotion(scoped(owner, store), promotion), hasCode('STORE_LOCKED'));
      } finally { await Store.updateOne({ _id: store._id }, { $set: { status: 'verified' } }); }
      await CountrySetting.updateOne({ code: 'UG' }, { $set: { currency: 'KES' } });
      try {
        await assert.rejects(sellerPromotionsPage(scoped(owner, store)), hasCode('STORE_MARKET_UNAVAILABLE'));
        await assert.rejects(sellerSubscriptionPage(scoped(owner, store)), hasCode('STORE_MARKET_UNAVAILABLE'));
      } finally { await CountrySetting.updateOne({ code: 'UG' }, { $set: { currency: 'UGX' } }); }
    });
  } finally {
    t.mock.restoreAll();
    for (const transport of transports) transport.destroy();
    try {
      await Promise.all(Object.values(mongoose.models).map(model => model.init()));
      assert.equal(mongoose.connection.name, database);
      await mongoose.connection.dropDatabase();
    } finally { await mongoose.disconnect(); }
  }
});

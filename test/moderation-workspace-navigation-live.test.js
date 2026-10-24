import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import request from 'supertest';
import { chromium } from '@playwright/test';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
for (const name of ['SESSION_SECRET', 'TOKEN_PEPPER', 'SECURITY_INTEGRITY_KEY', 'DATA_ENCRYPTION_KEY']) process.env[name] = crypto.randomBytes(32).toString('hex');
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const csrf = html => {
  const token = html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/);
  assert.ok(token, 'The real page must provide a CSRF token.');
  return token[1];
};
const routes = Object.freeze({
  'moderator-order-cases': '/moderation/order-cases',
  'moderator-overview': '/moderation/overview',
  'moderator-products': '/moderation/products',
  'moderator-reviews': '/moderation/reviews',
  'moderator-sellers': '/moderation/verifications',
  'moderator-disputes': '/moderation/risk-cases',
  'moderator-audit': '/moderation/audit',
  'moderator-reports': '/moderation/reports',
  'moderator-settings': '/moderation/settings',
});

test('Moderation retains the approved shared design and original image assets', () => {
  for (const name of ['styles.css', 'design-system.css', 'role-workspaces.css', 'script.js', 'enhancements.js',
    ...fs.readdirSync(path.join(root, 'dashboard-preview/final19/assets')).map(name => 'assets/' + name)]) {
    assert.deepEqual(fs.readFileSync(path.join(root, 'public/approved-dashboard', name)),
      fs.readFileSync(path.join(root, 'dashboard-preview/final19', name)), name);
  }
});

test('all nine Moderation destinations use current grants, genuine MFA and the approved responsive workspace', { skip: !uri, timeout: 360_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex'), transports = [];
  await mongoose.connect(uri, { dbName: `classicmart_moderation_navigation_test_${suffix}` });
  let server, browser;
  try {
    const { createApp } = await import('../src/app.js');
    const { User, Store, CountrySetting, PlatformGrant, Category, Product, ProductVariant, Order, Review,
      SellerVerification, TrustCase, RiskSignal, ModerationQaReview, AuditLog, Device, LedgerAccount, LoyaltyAccount } = await import('../src/models/index.js');
    const { hashPassword } = await import('../src/core/crypto.js');
    const { encryptSensitive } = await import('../src/core/sensitive.js');
    const { beginMfaEnrollment, confirmMfaEnrollment, pendingMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
    await Promise.all(Object.values(mongoose.models).map(Model => Model.init()));
    await CountrySetting.create([
      { code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254', active: true },
      { code: 'TZ', name: 'Unassigned Moderation navigation market', currency: 'TZS', locale: 'en-TZ', timeZone: 'Africa/Dar_es_Salaam', phonePrefix: '+255', active: true },
    ]);
    const password = `Moderation-Navigation-${suffix}-A1!`, passwordHash = await hashPassword(password), app = createApp(null);
    let sequence = 0;
    async function actor(role, { managed = false, enroll = false, countries = ['UG', 'KE'], country = 'UG', name } = {}) {
      const index = ++sequence, email = `moderation-navigation-${suffix}-${index}@example.com`, phone = '+25670' + String(index).padStart(7, '0');
      const user = await User.create({ publicId: `usr_mnav_${suffix}_${index}`, name: name || `Navigation Moderation Actor ${index}`, email, emailNormalized: email,
        phone, phoneNormalized: phone, passwordHash, role, country, currency: 'TZS', shoppingCountry: 'TZ', operationalCountries: countries,
        platformAccessManagedAt: managed ? new Date() : undefined, emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
        consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const grant = managed ? await PlatformGrant.create({ publicId: `pgr_mnav_${suffix}_${index}`, userId: user._id, role: 'moderator', operationalCountries: countries,
        status: 'active', startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000), reason: 'Isolated Moderation workspace navigation verification.',
        approvalPublicId: `apr_mnav_${suffix}_${index}`, approvedByUserId: new mongoose.Types.ObjectId() }) : null;
      let secret, codes;
      if (enroll) {
        const enrollment = await beginMfaEnrollment(user._id, password); secret = enrollment.secret;
        // Keep the current code for a real login; reuse of the enrollment code
        // below must fail without weakening the authenticator replay protection.
        const confirmed = await confirmMfaEnrollment(user._id, totpCode(secret, { time: Date.now() - 30_000 })); codes = confirmed.codes;
      }
      return { user, grant, secret, codes };
    }
    function agent() {
      const transport = new http.Agent({ localAddress: `127.0.0.${transports.length + 110}`, keepAlive: false }); transports.push(transport);
      return request.agent(app).use(req => req.agent(transport));
    }
    // Keep intentional denied probes on independent client IPs. The production
    // intrusion guard remains enabled and must not block later authorized reads.
    function deniedProbe(client, href) {
      const transport = new http.Agent({ localAddress: `127.0.1.${transports.length + 1}`, keepAlive: false });
      transports.push(transport); return client.get(href).agent(transport);
    }
    async function login(entry, { challenge = true } = {}) {
      const client = agent(), form = await client.get('/login').expect(200);
      const response = await client.post('/login').type('form').send({ email: entry.user.email, password, _csrf: csrf(form.text) }).expect(302);
      if (challenge) {
        assert.equal(response.headers.location, '/mfa');
        const challengePage = await client.get('/mfa').expect(200);
        await client.post('/mfa').type('form').send({ code: totpCode(entry.secret), _csrf: csrf(challengePage.text) }).expect(302);
      }
      return { client, response };
    }
    const owner = await actor('customer', { managed: true });
    const initial = await login(owner, { challenge: false }), client = initial.client;
    assert.equal(initial.response.headers.location, '/moderation/overview', 'The active Moderator grant controls landing despite the customer identity mirror.');
    const securityPath = '/account/security?next=%2Fmoderation%2Foverview';

    await t.test('public signup cannot request or smuggle a Moderator grant', async () => {
      const values = index => ({ name: 'Public Moderator Request', email: `mnav-signup-${suffix}-${index}@example.com`,
        phoneCountry: 'UG', phone: '07' + crypto.randomInt(10_000_000, 99_999_999), password, confirmPassword: password, acceptTerms: 'on' });
      const badClient = agent(), badForm = await badClient.get('/signup?role=moderator').expect(200), bad = values('explicit');
      assert.match(badForm.text, /name="accountType" type="hidden" value="customer"/);
      await badClient.post('/signup').type('form').send({ ...bad, accountType: 'moderator', _csrf: csrf(badForm.text) }).expect(422);
      assert.equal(await User.exists({ emailNormalized: bad.email }), null);
      const publicClient = agent(), form = await publicClient.get('/signup').expect(200), harmless = values('smuggled');
      await publicClient.post('/signup').type('form').send({ ...harmless, role: 'moderator', operationalCountries: ['*'],
        authorizationContext: { platformManaged: true }, _csrf: csrf(form.text) }).expect(302).expect('location', '/verify-email');
      const account = await User.findOne({ emailNormalized: harmless.email });
      assert.equal(account.role, 'customer'); assert.equal(account.platformAccessManagedAt, undefined);
      assert.equal(await PlatformGrant.countDocuments({ userId: account._id }), 0);
      await publicClient.get('/moderation/overview').set('Accept', 'application/json').expect(403);
    });

    await t.test('real enrollment retains Moderation continuation, one-time recovery codes and authenticator replay protection', async () => {
      await client.get('/moderation/overview').expect(302).expect('location', securityPath);
      await client.get('/moderation/overview').set('Accept', 'application/json').expect(403);
      let page = await client.get(securityPath).expect(200);
      assert.match(page.text, /data-dashboard-workspace="moderator"/);
      assert.match(page.text, /name="next" value="\/moderation\/overview"/);
      await client.post('/account/mfa/begin').type('form').send({ currentPassword: password, next: '/moderation/overview' }).expect(403);
      assert.equal(await pendingMfaEnrollment(owner.user._id), null);
      await client.post('/account/mfa/begin').type('form').send({ currentPassword: password, next: '/moderation/overview', _csrf: csrf(page.text) })
        .expect(302).expect('location', securityPath);
      const enrollment = await pendingMfaEnrollment(owner.user._id); owner.secret = enrollment.secret;
      page = await client.get(securityPath).expect(200);
      await client.post('/account/mfa/confirm').type('form').send({ code: 'invalid', next: '/moderation/overview', _csrf: csrf(page.text) })
        .expect(302).expect('location', securityPath);
      assert.equal((await User.findById(owner.user._id)).security.mfaEnabled, false);
      page = await client.get(securityPath).expect(200);
      owner.enrollmentCode = totpCode(owner.secret, { time: Date.now() - 30_000 });
      await client.post('/account/mfa/confirm').type('form').send({ code: owner.enrollmentCode, next: '/moderation/overview', _csrf: csrf(page.text) })
        .expect(302).expect('location', securityPath);
      page = await client.get(securityPath).expect(200);
      assert.match(page.text, /href="\/moderation\/overview">Continue to Moderation workspace<\/a>/);
      owner.codes = [...page.text.matchAll(/<code>([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})<\/code>/g)].map(match => match[1]);
      assert.equal(owner.codes.length, 10);
      assert.equal((await User.findById(owner.user._id)).role, 'customer');
      assert.equal(await Store.countDocuments({ ownerUserId: owner.user._id }), 0);
      const repeat = await client.get(securityPath).expect(200);
      assert.equal([...repeat.text.matchAll(/<code>([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})<\/code>/g)].length, 0);
      await client.post('/logout').type('form').send({ _csrf: csrf(repeat.text) }).expect(302);
      const loginPage = await client.get('/login').expect(200);
      await client.post('/login').type('form').send({ email: owner.user.email, password, _csrf: csrf(loginPage.text) }).expect(302).expect('location', '/mfa');
      const challenge = await client.get('/mfa').expect(200);
      await client.post('/mfa').type('form').send({ code: owner.enrollmentCode, _csrf: csrf(challenge.text) }).expect(422);
      await client.post('/mfa').type('form').send({ code: totpCode(owner.secret), _csrf: csrf(challenge.text) }).expect(302).expect('location', '/moderation/overview');
    });

    const now = new Date(), decisionAt = new Date(now.getTime() - 60_000), fixtures = {};
    const priorDecisionReason = 'A persisted prior decision is awaiting independent quality review.';
    const category = await Category.create({ publicId: `cat_mnav_${suffix}`, name: 'Navigation catalogue', slug: `mnav-${suffix}`, active: true, countries: ['UG', 'KE', 'TZ'] });
    for (const [country, currency, amountMinor] of [['UG', 'UGX', 12_000], ['KE', 'KES', 3_400], ['TZ', 'TZS', 990_000]]) {
      const buyer = await actor('customer', { country }), seller = await actor('seller', { country }), applicant = await actor('seller', { country });
      const store = await Store.create({ publicId: `str_mnav_${country.toLowerCase()}_${suffix}`, ownerUserId: seller.user._id,
        name: `Navigation Store ${country}`, slug: `mnav-${country.toLowerCase()}-${suffix}`, country, currency, status: 'verified', verifiedAt: now });
      const unverifiedStore = await Store.create({ publicId: `str_mnav_unverified_${country.toLowerCase()}_${suffix}`, ownerUserId: applicant.user._id,
        name: `Navigation Verification Store ${country}`, slug: `mnav-unverified-${country.toLowerCase()}-${suffix}`, country, currency, status: 'pending_verification' });
      const verification = await SellerVerification.create({ publicId: `svr_mnav_${country.toLowerCase()}_${suffix}_persisted_verification_reference`,
        storeId: unverifiedStore._id, userId: applicant.user._id, sellerType: 'business', legalName: `Navigation Legal Seller ${country}`, status: 'submitted',
        registrationNumber: encryptSensitive('MODERATION_PRIVATE_REGISTRATION_' + country), taxNumber: encryptSensitive('MODERATION_PRIVATE_TAX_' + country),
        declarationAcceptedAt: now, submittedAt: now });
      const product = await Product.create({ publicId: `prd_mnav_${country.toLowerCase()}_${suffix}_persisted_product_reference`, ownerUserId: seller.user._id, storeId: store._id,
        categoryId: category._id, title: `Navigation Product ${country}`, slug: `mnav-product-${country.toLowerCase()}-${suffix}`,
        description: 'Persisted product submitted for the real Moderation queue.', countries: ['UG', 'KE', 'TZ'], status: 'changes_requested',
        moderation: { reviewedAt: decisionAt, reviewedByUserId: owner.user._id, reason: priorDecisionReason,
          reviewHistory: [{ action: 'changes', actorUserId: owner.user._id, reason: priorDecisionReason, at: decisionAt }] } });
      const decisionVersionSnapshot = product.__v;
      product.status = 'submitted'; product.moderation.submittedAt = now; product.increment(); await product.save();
      const variant = await ProductVariant.create({ publicId: `var_mnav_${country.toLowerCase()}_${suffix}`, productId: product._id, storeId: store._id,
        sku: `MNAV-${country}-${suffix}`, title: 'Default', priceMinor: amountMinor, currency, active: true });
      const order = await Order.create({ publicId: `ord_mnav_${country.toLowerCase()}_${suffix}_persisted_order_reference`, userId: buyer.user._id, country,
        sessionKey: `mnav_order_${country}_${suffix}`, idempotencyKey: `mnav-order-${country}-${suffix}`, checkoutId: `mnav-checkout-${country}-${suffix}`,
        cartPublicId: `crt_mnav_${country.toLowerCase()}_${suffix}`, deliveryMethod: 'standard', paymentMethod: 'cod', reservationExpiresAt: new Date(Date.now() + 86_400_000),
        status: 'paid', paymentState: 'paid', fulfillmentState: 'delivered', contact: { fullName: buyer.user.name, email: buyer.user.email, phone: buyer.user.phone,
          address: 'MODERATION_PRIVATE_CUSTOMER_ADDRESS', city: 'Navigation City', country, note: 'MODERATION_PRIVATE_CUSTOMER_NOTE' },
        totals: { subtotalMinor: amountMinor, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: amountMinor, currency },
        items: [{ linePublicId: `lin_mnav_${country.toLowerCase()}_${suffix}`, productId: product._id, variantId: variant._id, storeId: store._id,
          reservationPublicId: `rsv_mnav_${country.toLowerCase()}_${suffix}`, productPublicId: product.publicId, variantPublicId: variant.publicId, storePublicId: store.publicId,
          title: product.title, variantTitle: variant.title, sku: variant.sku, quantity: 1, deliveredQuantity: 1, unitPriceMinor: amountMinor, unitCostMinor: 900,
          costSnapshotStatus: 'captured', lineTotalMinor: amountMinor, currency }] });
      const review = await Review.create({ publicId: `rev_mnav_${country.toLowerCase()}_${suffix}_persisted_review_reference`, userId: buyer.user._id,
        orderId: order._id, orderPublicId: order.publicId, orderLinePublicId: order.items[0].linePublicId, productId: product._id,
        productPublicId: product.publicId, country, rating: 4, title: `Recorded ${country} customer review`,
        body: 'Persisted verified customer review awaiting moderation.', verifiedPurchase: true, status: 'pending' });
      const trust = await TrustCase.create({ publicId: `trc_mnav_${country.toLowerCase()}_${suffix}_persisted_trust_reference`, reporterUserId: buyer.user._id,
        country, type: 'unsafe_product', productId: product._id, productPublicId: product.publicId, storeId: store._id, storePublicId: store.publicId,
        description: 'Recorded product safety report awaiting an accountable review.', status: 'open' });
      const risk = await RiskSignal.create({ publicId: `rsk_mnav_${country.toLowerCase()}_${suffix}_persisted_risk_reference`, country,
        subjectType: 'store', subjectPublicId: store.publicId, type: 'navigation_recorded_signal', severity: 'high', score: 75,
        status: 'open', evidence: ['Recorded source observation for navigation verification.'], createdBy: 'operator' });
      const qa = await ModerationQaReview.create({ publicId: `mqa_mnav_${country.toLowerCase()}_${suffix}_persisted_qa_reference`, targetType: 'product',
        targetObjectId: product._id, targetPublicId: product.publicId, country, riskLevel: 'high', decision: 'changes_requested',
        decisionReason: priorDecisionReason, decisionVersionSnapshot, decisionEventAt: decisionAt, originalReviewerUserId: owner.user._id, sampledAt: now });
      const auditTarget = product.publicId;
      await AuditLog.create({ requestId: `req_mnav_${country}_${suffix}`, actorId: owner.user._id, actorPublicId: owner.user.publicId,
        action: 'catalogue.product_changes_requested', targetType: 'product', targetPublicId: auditTarget, country, result: 'success', createdAt: decisionAt,
        metadata: { decision: 'changes', private: 'MODERATION_PRIVATE_AUDIT_METADATA_' + country } });
      fixtures[country] = { buyer: buyer.user, seller: seller.user, applicant: applicant.user, store, unverifiedStore, verification, product, order, review, trust, risk, qa, auditTarget };
    }
    const paginatedProducts = [];
    for (let index = 0; index < 30; index++) paginatedProducts.push({ publicId: `prd_mnav_page_${suffix}_${String(index).padStart(2, '0')}`,
      ownerUserId: fixtures.UG.seller._id, storeId: fixtures.UG.store._id, categoryId: category._id, title: `Navigation backlog listing ${index}`,
      slug: `mnav-backlog-${suffix}-${index}`, description: 'Persisted submitted backlog listing for bounded queue pagination.',
      countries: ['UG', 'KE', 'TZ'], status: 'submitted', moderation: { submittedAt: now } });
    await Product.create(paginatedProducts);

    await t.test('all nine private canonical pages and query-preserving aliases retain only Moderation navigation', async () => {
      for (const [id, href] of Object.entries(routes)) {
        const page = await client.get(href).set('Accept', 'text/html').expect(200);
        assert.match(page.text, /data-dashboard-workspace="moderator"/);
        assert.ok(page.text.includes(`data-dashboard-page="${id}"`), id);
        assert.match(page.text, /moderation-live\.css/);
        assert.doesNotMatch(page.text, /Development preview|Not available yet|id="roleSwitcher"|<h3>Classic Club<\/h3>|MODERATION_PRIVATE_(?:CUSTOMER|AUDIT|REGISTRATION|TAX)/);
        assert.match(page.headers['cache-control'], /no-store/);
        assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
        for (const destination of Object.values(routes)) assert.ok(page.text.includes(`href="${destination}"`), href + ':' + destination);
        await client.get('/dashboard/' + id + '?country=UG&search=retained%20query').expect(308).expect('location', href + '?country=UG&search=retained%20query');
      }
    });

    await t.test('operational markets override shopping preferences and all page DTOs exclude foreign records and raw contacts', async () => {
      const overview = (await client.get('/moderation/overview').set('Accept', 'application/json').expect(200)).body;
      assert.deepEqual(overview.context.countries.map(row => row.code).sort(), ['KE', 'UG']);
      for (const href of Object.values(routes)) {
        const response = await client.get(href + '?country=UG').set('Accept', 'application/json');
        assert.equal(response.status, 200, href + ': ' + JSON.stringify(response.body));
        assert.equal(response.body.context.country, 'UG'); assert.equal(response.body.context.currency, 'UGX');
        assert.equal(response.body.context.timeZone, 'Africa/Kampala');
        const text = JSON.stringify(response.body);
        for (const market of ['KE', 'TZ']) for (const [kind, row] of Object.entries(fixtures[market])) {
          if (kind === 'buyer' || kind === 'seller' || kind === 'applicant') continue;
          assert.ok(!text.includes(typeof row === 'string' ? row : row.publicId), href + ' excludes ' + market + ':' + kind);
        }
        assert.doesNotMatch(text, /MODERATION_PRIVATE_(?:CUSTOMER|AUDIT|REGISTRATION|TAX)/);
        for (const record of [fixtures.UG.buyer, fixtures.UG.seller, fixtures.UG.applicant]) {
          assert.ok(!text.includes(record.email), href + ' private email'); assert.ok(!text.includes(record.phone), href + ' private phone');
        }
        await deniedProbe(client, href + '?country=TZ').set('Accept', 'application/json').expect(403);
      }
      await deniedProbe(client, '/moderation/products?country=UG&country=KE').set('Accept', 'application/json').expect(422);
      await deniedProbe(client, '/moderation/reports?country[bad]=UG').set('Accept', 'application/json').expect(422);
      await deniedProbe(client, '/moderation/products?search[$ne]=x').set('Accept', 'application/json').expect(422);
      await deniedProbe(client, '/moderation/reviews?after=not-a-cursor').set('Accept', 'application/json').expect(422);
      assert.equal(await LedgerAccount.countDocuments({ ownerType: 'customer', ownerPublicId: owner.user.publicId }), 0);
      assert.equal(await LoyaltyAccount.countDocuments({ userId: owner.user._id }), 0);
    });

    await t.test('real product backlog uses disjoint keysets and owning-store country rather than selling-country overlap', async () => {
      const first = (await client.get('/moderation/products?country=UG').set('Accept', 'application/json').expect(200)).body;
      assert.equal(first.rows.length, 25); assert.equal(first.page.total, 31); assert.ok(first.page.next);
      const second = (await client.get('/moderation/products?country=UG&after=' + encodeURIComponent(first.page.next)).set('Accept', 'application/json').expect(200)).body;
      assert.equal(second.rows.length, 6); assert.equal(second.page.total, 31); assert.equal(second.page.hasMore, false); assert.equal(second.page.next, '');
      const ids = [...first.rows, ...second.rows].map(row => row.id);
      assert.equal(new Set(ids).size, 31); assert.ok(ids.includes(fixtures.UG.product.publicId));
      assert.ok(!ids.includes(fixtures.KE.product.publicId)); assert.ok(!ids.includes(fixtures.TZ.product.publicId));
      const allMarkets = (await client.get('/moderation/products').set('Accept', 'application/json').expect(200)).body;
      assert.equal(allMarkets.page.total, 32, 'A listing selling in both countries belongs to one owning-store queue.');
    });

    await t.test('selected records and original product and verification detail URLs remain private and in the approved nine-page shell', async () => {
      for (const [href, kind] of [['/moderation/products', 'product'], ['/moderation/verifications', 'verification'], ['/moderation/reviews', 'review']]) {
        await deniedProbe(client, href + '?country=UG&record=' + fixtures.TZ[kind].publicId).set('Accept', 'application/json').expect(404);
        await deniedProbe(client, href + '?country=UG&record=' + fixtures.KE[kind].publicId).set('Accept', 'application/json').expect(404);
      }
      for (const [href, kind] of [['/moderation/products', 'product'], ['/moderation/verifications', 'verification']]) {
        const page = await client.get(href + '/' + fixtures.UG[kind].publicId + '?country=UG').expect(200);
        assert.match(page.text, /data-dashboard-workspace="moderator"/);
        assert.doesNotMatch(page.text, /data-dashboard-workspace="seller"|MODERATION_PRIVATE_(?:CUSTOMER|REGISTRATION|TAX)/);
        assert.ok(page.text.includes(fixtures.UG[kind].publicId)); assert.match(page.text, /name="version"/);
        for (const destination of Object.values(routes)) assert.ok(page.text.includes(`href="${destination}"`), 'detail:' + destination);
        await deniedProbe(client, href + '/' + fixtures.TZ[kind].publicId).set('Accept', 'application/json').expect(404);
        await deniedProbe(client, href + '/' + fixtures.KE[kind].publicId + '?country=UG').set('Accept', 'application/json').expect(404);
      }
    });

    await t.test('expired grants, changed tokens, revoked devices and disabled MFA deny existing sessions', async () => {
      for (const [name, change, status] of [
        ['expired grant', entry => PlatformGrant.updateOne({ _id: entry.grant._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } }), 403],
        ['suspended account', entry => User.updateOne({ _id: entry.user._id }, { $set: { status: 'suspended' } }), 401],
        ['changed token', entry => User.updateOne({ _id: entry.user._id }, { $inc: { 'security.tokenVersion': 1 } }), 401],
        ['revoked devices', entry => Device.updateMany({ userId: entry.user._id, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: 'Moderation navigation revocation test' } }), 401],
        ['disabled MFA', entry => User.updateOne({ _id: entry.user._id }, { $set: { 'security.mfaEnabled': false } }), 403],
      ]) {
        const entry = await actor('customer', { managed: true, enroll: true }), { client: existingClient } = await login(entry);
        await existingClient.get('/moderation/overview').set('Accept', 'application/json').expect(200);
        await change(entry);
        for (const destination of Object.values(routes)) await existingClient.get(destination).set('Accept', 'application/json').expect(status);
      }
    });

    await t.test('CSV export stops before a data row when the current grant narrows during header backpressure', async () => {
      const { streamModerationReportCsv } = await import('../src/services/moderation-report-pages.js');
      const entry = await actor('customer', { managed: true, enroll: true }), current = await User.findById(entry.user._id);
      const readRequest = { id: 'req_mnav_stream_' + suffix, user: current, session: { tokenVersion: current.security.tokenVersion }, query: { country: '' },
        ip: '127.0.0.18', get: () => 'ModerationNavigationExport/1.0' };
      const output = new EventEmitter(), chunks = [];
      output.destroyed = false; output.set = () => output; output.end = () => assert.fail('A revoked broader export cannot finish.');
      output.write = value => {
        chunks.push(String(value));
        if (chunks.length === 1) {
          queueMicrotask(() => { void PlatformGrant.updateOne({ _id: entry.grant._id }, { $set: { operationalCountries: ['UG'] } })
            .then(() => output.emit('drain'), error => output.emit('error', error)); });
          return false;
        }
        return true;
      };
      await assert.rejects(streamModerationReportCsv(readRequest, output, 'moderator-audit'), error => error.code === 'MODERATION_SCOPE_CHANGED');
      assert.equal(chunks.length, 1, 'Only safe column headers may be written before access changes.');
      for (const market of ['UG', 'KE', 'TZ']) assert.ok(!chunks.join('').includes(fixtures[market].auditTarget));
      assert.equal(output.listenerCount('drain'), 0); assert.equal(output.listenerCount('close'), 0); assert.equal(output.listenerCount('error'), 0);
    });

    await t.test('other primary workspaces cannot render Moderation pages or detail shells even with broad administrative permissions', async () => {
      for (const role of ['customer', 'seller', 'promoter', 'support', 'finance', 'warehouse', 'business', 'country_admin', 'super_admin']) {
        const other = await actor(role, { enroll: true, countries: role === 'super_admin' ? ['*'] : ['UG', 'KE'] });
        const { client: otherClient } = await login(other);
        for (const href of Object.values(routes)) await otherClient.get(href).set('Accept', 'application/json').expect(403);
        await otherClient.get('/moderation/products/' + fixtures.UG.product.publicId).set('Accept', 'application/json').expect(403);
        await otherClient.get('/moderation/verifications/' + fixtures.UG.verification.publicId).set('Accept', 'application/json').expect(403);
        assert.equal(await Store.countDocuments({ ownerUserId: other.user._id }), 0, role + ' read does not provision a store.');
      }
    });

    await t.test('personal account pages retain all nine Moderation destinations without customer balances or a role selector', async () => {
      for (const href of ['/account/security', '/account/messages']) {
        const page = await client.get(href).expect(200);
        assert.match(page.text, /data-dashboard-workspace="moderator"/);
        assert.doesNotMatch(page.text, /<h3>Classic Club<\/h3>|id="roleSwitcher"|Development preview/);
        for (const destination of Object.values(routes)) assert.ok(page.text.includes(`href="${destination}"`), href + ':' + destination);
      }
      assert.equal(await Store.countDocuments({ ownerUserId: owner.user._id }), 0);
      assert.equal(await LedgerAccount.countDocuments({ ownerType: 'customer', ownerPublicId: owner.user.publicId }), 0);
      assert.equal(await LoyaltyAccount.countDocuments({ userId: owner.user._id }), 0);
    });

    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    for (const width of [1366, 390]) await t.test(`all nine actual Moderation pages, details and five settings sections remain readable at ${width}px`, async () => {
      const browserActor = await actor('customer', { managed: true, enroll: true });
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      try {
        const page = await context.newPage();
        await page.goto(base + '/login');
        await page.locator('input[name="email"]').fill(browserActor.user.email);
        await page.locator('input[name="password"]').fill(password);
        await Promise.all([page.waitForURL(base + '/mfa'), page.locator('form[action="/login"] button[type="submit"]').click()]);
        await page.locator('form[action="/mfa"] input[name="code"]').fill(totpCode(browserActor.secret));
        await Promise.all([page.waitForURL(base + '/moderation/overview'), page.locator('form[action="/mfa"] button[type="submit"]').click()]);
        async function checkLayout(href) {
          const layout = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
            overflowing: [...document.querySelectorAll('.role-page *')].map(node => { const box = node.getBoundingClientRect(); return { tag: node.tagName, classes: node.className,
              right: Math.round(box.right), width: Math.round(box.width), text: node.textContent.trim().slice(0, 100) }; }).filter(node => node.width > 0 && node.right > innerWidth + 1).slice(0, 8) }));
          if (layout.scrollWidth > width + 1) await page.screenshot({ path: `/tmp/classicmart-moderation-${width}-overflow.png`, fullPage: true, animations: 'disabled' });
          assert.ok(layout.scrollWidth <= width + 1, href + ' page overflow: ' + JSON.stringify(layout));
          assert.equal(await page.locator('body').getAttribute('data-dashboard-workspace'), 'moderator');
          assert.equal(await page.locator('.side-navigation a[href^="/moderation/"]').count(), 9);
          assert.equal(await page.locator('#roleSwitcher').count(), 0);
          assert.equal(await page.locator('.role-page h1').isVisible(), true, href + ' heading');
        }
        for (const [id, href] of Object.entries(routes)) {
          const response = await page.goto(base + href + '?country=UG');
          assert.equal(response.status(), 200, href);
          assert.equal(await page.locator('body').getAttribute('data-dashboard-page'), id);
          await checkLayout(href);
          if (id === 'moderator-settings') {
            assert.equal(await page.locator('.role-settings-nav a').count(), 5);
            for (const section of ['profile', 'business', 'payments', 'notifications', 'security']) {
              const tab = page.locator(`.role-settings-nav a[href*="section=${section}"]`);
              assert.equal(await tab.count(), 1, 'Real settings section: ' + section);
              await tab.scrollIntoViewIfNeeded();
              await Promise.all([page.waitForNavigation(), tab.click()]);
              assert.equal(new URL(page.url()).searchParams.get('section'), section);
              assert.equal(await page.locator('.role-settings-panel.active').count(), 1);
              assert.equal(await page.locator('.role-settings-panel.active').isVisible(), true);
              assert.equal(await page.locator('.role-settings-panel.active').getAttribute('data-role-settings-panel'), section);
              await checkLayout(href + '?section=' + section);
            }
          } else {
            assert.equal(await page.locator('.role-metric-grid .role-metric').count(), 4, href + ' metrics');
            assert.equal(await page.locator('.role-metric-grid').evaluate(node => getComputedStyle(node).gap), width === 1366 ? '12px' : '9px');
            if (id === 'moderator-overview') {
              assert.equal(await page.locator('.role-welcome').count(), 1); assert.equal(await page.locator('.role-overview-grid').count(), 1); assert.equal(await page.locator('.role-bottom-grid').count(), 1);
            } else {
              assert.equal(await page.locator('.role-content-grid').count(), 1);
              assert.equal(await page.locator('.role-progress-card').count(), 1); assert.equal(await page.locator('.role-activity-panel').count(), 1);
              if (width === 1366) assert.match(await page.locator('.role-content-grid').evaluate(node => getComputedStyle(node).gridTemplateColumns), /292px$/);
            }
          }
          if (['moderator-products', 'moderator-sellers', 'moderator-reviews', 'moderator-audit'].includes(id)) {
            const recordText = ({ 'moderator-products': fixtures.UG.product.title, 'moderator-sellers': fixtures.UG.verification.legalName,
              'moderator-reviews': fixtures.UG.review.publicId, 'moderator-audit': fixtures.UG.auditTarget })[id];
            // Products use an oldest-first tied-date cursor; the base record's
            // lower ObjectId precedes the created backlog and is on page one.
            const record = page.locator('.role-table tbody td').filter({ hasText: recordText }).first();
            assert.equal(await record.count(), 1, href + ' actual persisted reference'); assert.equal(await record.isVisible(), true);
            if (id === 'moderator-products' || id === 'moderator-sellers') {
              const publicId = id === 'moderator-products' ? fixtures.UG.product.publicId : fixtures.UG.verification.publicId;
              assert.equal(await record.locator('..').locator('a[href*="' + publicId + '"]').count(), 1, href + ' opens the actual stored case');
            }
            if (width === 390) {
              const readability = await record.evaluate(node => { const box = node.getBoundingClientRect(), style = getComputedStyle(node); return {
                width: box.width, height: box.height, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, whiteSpace: style.whiteSpace }; });
              assert.ok(readability.width > 200 && readability.height >= 20, href + ' mobile reference has readable card space');
              assert.ok(readability.scrollWidth <= readability.clientWidth + 1, href + ' full reference wraps without clipping'); assert.notEqual(readability.whiteSpace, 'nowrap');
            }
          }
          if (['moderator-overview', 'moderator-products', 'moderator-disputes', 'moderator-settings'].includes(id)) {
            await page.screenshot({ path: `/tmp/classicmart-${id}-${width}.png`, fullPage: true, animations: 'disabled' });
          }
        }
        for (const [href, record] of [['/moderation/products/', fixtures.UG.product], ['/moderation/verifications/', fixtures.UG.verification]]) {
          const response = await page.goto(base + href + record.publicId + '?country=UG'); assert.equal(response.status(), 200);
          await checkLayout(href + record.publicId); assert.equal(await page.locator('input[name="version"]').count() > 0, true);
          await page.screenshot({ path: `/tmp/classicmart-moderation-${record === fixtures.UG.product ? 'product' : 'verification'}-detail-${width}.png`, fullPage: true, animations: 'disabled' });
        }
        await page.goto(base + '/account/security');
        assert.equal(await page.locator('body').getAttribute('data-dashboard-workspace'), 'moderator');
        assert.equal(await page.locator('.side-navigation a[href^="/moderation/"]').count(), 9);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Moderation personal security overflow');
        assert.equal((await User.findById(browserActor.user._id)).role, 'customer');
        assert.equal(await LedgerAccount.countDocuments({ ownerType: 'customer', ownerPublicId: browserActor.user.publicId }), 0);
      } finally { await context.close(); }
    });

    await t.test('fresh final rendering rejects a broader snapshot after grant or operational timezone changes', async () => {
      const { loadModerationReportPage } = await import('../src/services/moderation-report-pages.js');
      const { renderModerationPage } = await import('../src/dashboard/moderation-page-view.js');
      const current = await User.findById(owner.user._id), readRequest = { user: current,
        session: { tokenVersion: current.security.tokenVersion }, query: {}, accepts: () => 'json' };
      const oldReport = await loadModerationReportPage(readRequest, 'moderator-overview');
      assert.ok(oldReport.context.countries.some(row => row.code === 'KE'));
      await PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { operationalCountries: ['UG'] } });
      await assert.rejects(renderModerationPage(readRequest, { json: () => assert.fail('An obsolete broader report must not be sent.') }, 'moderator-overview', oldReport),
        error => [403, 409].includes(error.status));
      const scoped = (await client.get('/moderation/overview').set('Accept', 'application/json').expect(200)).body;
      assert.deepEqual(scoped.context.countries.map(row => row.code), ['UG']); assert.equal(scoped.context.currency, 'UGX');
      for (const href of Object.values(routes)) await deniedProbe(client, href + '?country=KE').set('Accept', 'application/json').expect(403);
      const oldMarketReport = await loadModerationReportPage(readRequest, 'moderator-overview');
      await CountrySetting.updateOne({ code: 'UG' }, { $set: { timeZone: 'Pacific/Auckland' } });
      await assert.rejects(renderModerationPage(readRequest, { json: () => assert.fail('An obsolete market calendar must not be sent.') }, 'moderator-overview', oldMarketReport),
        error => [403, 409].includes(error.status));
      await CountrySetting.updateOne({ code: 'UG' }, { $set: { timeZone: 'Africa/Kampala' } });
      await PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { status: 'revoked', revokedAt: new Date() } });
      await User.updateOne({ _id: owner.user._id }, { $set: { role: 'moderator' } });
      for (const href of Object.values(routes)) await deniedProbe(client, href).set('Accept', 'application/json').expect(403);
      const account = await client.get('/account/security').expect(200);
      assert.match(account.text, /data-dashboard-workspace="customer"/);
      assert.ok(!account.text.includes('href="/moderation/overview"'), 'A revoked identity mirror cannot retain a Moderator workspace.');
      assert.equal(await Store.countDocuments({ ownerUserId: owner.user._id }), 0);
    });
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    for (const transport of transports) transport.destroy();
    try { await Promise.all(Object.values(mongoose.models).map(Model => Model.init())); await mongoose.connection.dropDatabase(); }
    finally { await mongoose.disconnect(); }
  }
});

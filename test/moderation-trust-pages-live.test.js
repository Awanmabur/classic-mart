import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import mongoose from 'mongoose';
import request from 'supertest';
import sharp from 'sharp';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
process.env.MEDIA_STORAGE_DRIVER = 'filesystem';
process.env.UPLOAD_DIR = `/tmp/classicmart-moderation-trust-media-${crypto.randomBytes(8).toString('hex')}`;
for (const name of ['SESSION_SECRET', 'TOKEN_PEPPER', 'SECURITY_INTEGRITY_KEY', 'DATA_ENCRYPTION_KEY']) process.env[name] = crypto.randomBytes(32).toString('hex');
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];
const same = (a, b) => String(a || '') === String(b || '');

test('Moderation reviews and trust cases use independent claims, actual sources, owned conversations and transactional outcomes', { skip: !uri, timeout: 300_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex'), transports = [];
  await mongoose.connect(uri, { dbName: `classicmart_moderation_trust_test_${suffix}` });
  try {
    const { createApp } = await import('../src/app.js');
    const { User, Device, PlatformGrant, CountrySetting, Store, StoreMember, Category, Product, ProductVariant, Order, Review, TrustCase, RiskSignal, EvidenceDocument, AuditLog, Notification, Refund, LedgerTransaction } = await import('../src/models/index.js');
    const pages = await import('../src/services/moderation-trust-pages.js');
    const compatibility = await import('../src/services/trust.js');
    const { disputeSellerReview, sellerRelationshipPage } = await import('../src/services/seller-relationship-pages.js');
    const { hashPassword, hashToken } = await import('../src/core/crypto.js');
    const { encryptSensitive } = await import('../src/core/sensitive.js');
    const { totpCode } = await import('../src/services/mfa.js');
    const { putMediaObject, deleteMediaObject } = await import('../src/services/object-storage.js');
    await Promise.all(Object.values(mongoose.models).map(Model => Model.init()));
    await CountrySetting.create([
      { code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256' },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254' },
      { code: 'TZ', name: 'Private unassigned market', currency: 'TZS', locale: 'en-TZ', timeZone: 'Africa/Dar_es_Salaam', phonePrefix: '+255' },
    ]);
    const password = `Trust-${suffix}-A1!`, passwordHash = await hashPassword(password), secret = 'JBSWY3DPEHPK3PXP';
    const app = createApp(null);
    let sequence = 0;
    const id = kind => `${kind}_mt_${suffix}_${++sequence}`;
    async function actor(role = 'customer', { managed = true, countries = ['UG', 'KE'], login = false } = {}) {
      const number = ++sequence, email = `moderation-trust-${suffix}-${number}@example.com`, phone = '+25670' + String(number).padStart(7, '0');
      const user = await User.create({ publicId: id('usr'), name: `Trust fixture ${number}`, email, emailNormalized: email, phone, phoneNormalized: phone,
        passwordHash, role, country: countries[0], currency: countries[0] === 'TZ' ? 'TZS' : countries[0] === 'KE' ? 'KES' : 'UGX', operationalCountries: countries,
        emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), platformAccessManagedAt: managed ? new Date() : undefined,
        security: { mfaEnabled: true, mfaSecretEncrypted: encryptSensitive(secret) }, consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const grant = managed ? await PlatformGrant.create({ publicId: id('pgr'), userId: user._id, role: 'moderator', operationalCountries: countries,
        status: 'active', startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86400_000),
        reason: 'Independent moderation fixture', approvalPublicId: id('apr'), approvedByUserId: new mongoose.Types.ObjectId() }) : null;
      const entry = { user, grant };
      if (login) {
        const transport = new http.Agent({ localAddress: `127.0.0.${number + 40}`, keepAlive: false }); transports.push(transport);
        const client = request.agent(app).use(req => req.agent(transport));
        const page = await client.get('/login').expect(200);
        await client.post('/login').type('form').send({ email, password, _csrf: csrf(page.text) }).expect(302).expect('location', '/mfa');
        const challenge = await client.get('/mfa').expect(200);
        const authenticated = await client.post('/mfa').type('form').send({ code: totpCode(secret), _csrf: csrf(challenge.text) }).expect(302);
        const cookie = authenticated.headers['set-cookie'].find(value => value.startsWith('cm.sid='));
        const signed = decodeURIComponent(cookie.split(';')[0].slice('cm.sid='.length));
        entry.sessionID = signed.slice(2, signed.lastIndexOf('.'));
        entry.device = await Device.findOne({ userId: user._id, sessionHash: hashToken(entry.sessionID), revokedAt: null }).select('+sessionHash');
        assert.ok(entry.device);
        entry.client = client; entry.user = await User.findById(user._id);
      }
      return entry;
    }
    const moderator = await actor('customer', { login: true }), second = await actor('customer', { login: true });
    const globalModerator = await actor('customer', { countries: ['UG', 'KE', 'TZ'] });
    const buyer = await actor('customer', { login: true }), reporter = await actor(), seller = await actor('seller', { managed: false, login: true });
    const platformSeller = await actor('seller', { login: true });
    const activeMember = await actor(), invitedMember = await actor(), productOwner = await actor(), formerDisputer = await actor();
    const foreignBuyer = await actor('customer', { managed: false, countries: ['TZ'] });
    const req = (entry = moderator, query = {}) => ({ id: id('req'), user: entry.user,
      session: { userId: String(entry.user._id), tokenVersion: entry.user.security.tokenVersion, mfaVerifiedAt: Date.now() },
      ...(entry.sessionID ? { sessionID: entry.sessionID, device: entry.device } : {}), query,
      country: { code: 'UG', currency: 'UGX' }, ip: '127.0.0.1', get: () => 'ModerationTrustTest/1.0' });
    const category = await Category.create({ publicId: id('cat'), name: 'Trust goods', slug: id('category'), countries: ['UG', 'KE', 'TZ'] });
    async function subject({ countries = ['UG', 'KE'], country = countries[0], owner, productActor, status = 'published', store: existingStore } = {}) {
      // Store ownership is unique: each new fixture store has its own seller in its actual home market.
      const storeOwner = owner || (existingStore ? { user: await User.findById(existingStore.ownerUserId) } : await actor('seller', { managed: false, countries: [country] }));
      const productOwnerActor = productActor || storeOwner;
      const store = existingStore || await Store.create({ publicId: id('sto'), ownerUserId: storeOwner.user._id, name: 'Actual trust store', slug: id('store'), country,
        currency: country === 'TZ' ? 'TZS' : country === 'KE' ? 'KES' : 'UGX', status: 'verified' });
      const product = await Product.create({ publicId: id('prd'), storeId: store._id, ownerUserId: productOwnerActor.user._id, categoryId: category._id,
        title: 'Actual purchased goods', slug: id('product'), description: 'A product with real linked purchase records.', countries, status });
      const variant = await ProductVariant.create({ publicId: id('var'), productId: product._id, storeId: store._id, sku: id('sku').toUpperCase(), title: 'Standard',
        priceMinor: 10000, costMinor: 5000, currency: store.currency });
      return { store, product, variant };
    }
    async function purchase(subjectRow, { customer = buyer, country = 'UG', delivered = true } = {}) {
      const currency = country === 'TZ' ? 'TZS' : country === 'KE' ? 'KES' : 'UGX', linePublicId = id('oli');
      return Order.create({ publicId: id('ord'), idempotencyKey: id('checkout'), checkoutId: id('checkout'), cartPublicId: id('crt'), sessionKey: id('session'),
        userId: customer.user._id, country, status: 'paid', paymentState: 'paid', fulfillmentState: delivered ? 'delivered' : 'shipped', deliveryMethod: 'standard', paymentMethod: 'card',
        contact: { fullName: customer.user.name, email: customer.user.email, phone: customer.user.phone, address: 'PRIVATE_PURCHASE_ADDRESS', city: 'Actual fixture city', country },
        totals: { subtotalMinor: 10000, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 10000, currency }, reservationExpiresAt: new Date(Date.now() + 86400_000),
        items: [{ linePublicId, productId: subjectRow.product._id, productPublicId: subjectRow.product.publicId, variantId: subjectRow.variant._id, variantPublicId: subjectRow.variant.publicId,
          storeId: subjectRow.store._id, storePublicId: subjectRow.store.publicId, reservationPublicId: id('rsv'), title: subjectRow.product.title, variantTitle: subjectRow.variant.title,
          sku: subjectRow.variant.sku, quantity: 1, deliveredQuantity: delivered ? 1 : 0, unitPriceMinor: 10000, lineTotalMinor: 10000, currency }] });
    }
    async function seededReview(subjectRow, options = {}) {
      const order = await purchase(subjectRow, options);
      const review = await Review.create({ publicId: id('rev'), userId: (options.customer || buyer).user._id, orderId: order._id, orderPublicId: order.publicId,
        orderLinePublicId: order.items[0].linePublicId, productId: subjectRow.product._id, productPublicId: subjectRow.product.publicId,
        country: order.country, rating: 4, title: 'Actual delivered purchase', body: 'Verified delivered goods need an independent decision.', verifiedPurchase: true });
      return { review, order };
    }
    const primary = await subject({ owner: seller }), foreign = await subject({ countries: ['TZ'], country: 'TZ' });
    await StoreMember.create([
      { publicId: id('stm'), storeId: primary.store._id, userId: seller.user._id, role: 'owner', status: 'active', acceptedAt: new Date(), invitedByUserId: seller.user._id },
      { publicId: id('stm'), storeId: primary.store._id, userId: activeMember.user._id, role: 'support', status: 'active', invitedByUserId: seller.user._id },
      { publicId: id('stm'), storeId: primary.store._id, userId: invitedMember.user._id, role: 'catalogue', status: 'invited', invitedByUserId: seller.user._id },
      { publicId: id('stm'), storeId: primary.store._id, userId: platformSeller.user._id, role: 'support', status: 'active', acceptedAt: new Date(), invitedByUserId: seller.user._id },
    ]);
    const purchaseRow = await purchase(primary);
    let ownedReview, productCase, storeCase;
    const version = async (Model, row) => (await Model.findById(row._id)).__v;
    const act = (kind, row, input, entry = moderator) => pages.moderationTrustAction(req(entry), kind, row.publicId, input);
    const claim = async (kind, Model, row, entry = moderator) => act(kind, row, { action: 'claim', version: await version(Model, row) }, entry);

    await t.test('review creation owns a delivered line and rejects duplicate, undelivered, foreign and store-related purchases', async () => {
      const input = { orderId: purchaseRow.publicId, orderLineId: purchaseRow.items[0].linePublicId, productId: primary.product.publicId, rating: 5, body: 'These delivered goods match the purchase recorded in my account.' };
      ownedReview = await pages.createOwnedVerifiedReview(req(buyer), { ...input, userId: moderator.user.publicId, country: 'TZ', status: 'published', verifiedPurchase: false });
      assert.equal(ownedReview.status, 'pending'); assert.equal(ownedReview.country, 'UG'); assert.equal(ownedReview.verifiedPurchase, true); assert.ok(same(ownedReview.userId, buyer.user._id));
      await assert.rejects(pages.createOwnedVerifiedReview(req(buyer), input), error => error.code === 'REVIEW_EXISTS');
      await assert.rejects(pages.createOwnedVerifiedReview(req(reporter), input), error => error.code === 'VERIFIED_PURCHASE_REQUIRED');
      const undelivered = await purchase(primary, { delivered: false });
      await assert.rejects(pages.createOwnedVerifiedReview(req(buyer), { ...input, orderId: undelivered.publicId }), error => error.code === 'VERIFIED_PURCHASE_REQUIRED');
      for (const entry of [seller, activeMember, invitedMember]) {
        const order = await purchase(primary, { customer: entry });
        await assert.rejects(pages.createOwnedVerifiedReview(req(entry), { ...input, orderId: order.publicId, orderLineId: order.items[0].linePublicId }), error => error.status === 403);
      }
      assert.equal(await AuditLog.countDocuments({ action: 'review.created', targetPublicId: ownedReview.publicId }), 1);
      assert.ok(await Notification.exists({ userId: moderator.user._id, type: 'moderation_work', country: 'UG' }));
    });

    await t.test('review queues count the full assigned scope and hide forged sources, foreign purchases and private identities', async () => {
      for (let index = 0; index < 28; index++) await seededReview(primary, { country: index % 2 ? 'KE' : 'UG' });
      const outside = await seededReview(foreign, { customer: foreignBuyer, country: 'TZ' });
      const forged = await seededReview(primary); await Review.updateOne({ _id: forged.review._id }, { $set: { orderPublicId: outside.order.publicId } });
      const flow = await pages.loadModerationTrustPage(req(), 'moderator-reviews');
      assert.equal(flow.page.total, 29); assert.equal(flow.records.length, 25); assert.equal(flow.page.hasMore, true);
      const next = await pages.loadModerationTrustPage(req(moderator, { after: flow.page.next }), 'moderator-reviews');
      assert.equal(next.records.length, 4); assert.ok(!next.records.some(row => flow.records.some(first => first.publicId === row.publicId)));
      const ke = await pages.loadModerationTrustPage(req(moderator, { country: 'KE' }), 'moderator-reviews'); assert.equal(ke.page.total, 14); assert.ok(ke.records.every(row => row.country === 'KE'));
      for (const value of [outside.review.publicId, forged.review.publicId, buyer.user.email, 'PRIVATE_PURCHASE_ADDRESS', 'mfaSecretEncrypted', 'tokenVersion']) assert.ok(!JSON.stringify(flow).includes(value));
      await assert.rejects(pages.loadModerationTrustPage(req(moderator, { country: 'TZ' }), 'moderator-reviews'), error => error.status === 403);
      await assert.rejects(pages.loadModerationTrustPage(req(moderator, { after: 'invalid-cursor' }), 'moderator-reviews'), error => error.status === 422);
      await assert.rejects(claim('reviews', Review, forged.review), error => error.status === 409);
      await assert.rejects(claim('reviews', Review, outside.review), error => [403, 404].includes(error.status));
      const html = await moderator.client.get('/moderation/reviews?record=' + ownedReview.publicId).expect(200);
      assert.match(html.text, /data-dashboard-workspace="moderator"/); assert.match(html.headers['cache-control'], /no-store/); assert.equal(html.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
      const json = await moderator.client.get('/moderation/reviews?record=' + ownedReview.publicId).set('Accept', 'application/json').expect(200);
      assert.equal(json.body.selected.record.publicId, ownedReview.publicId); assert.equal(json.body.selected.record.version, await version(Review, ownedReview));
      const exportPage = await moderator.client.get('/moderation/reviews/export.csv').expect(200);
      assert.equal(exportPage.text.trimEnd().split('\r\n').length, 30, 'CSV export includes every matching source-verified row, including the next page.');
      assert.ok(!exportPage.text.includes(outside.review.publicId)); assert.ok(!exportPage.text.includes(forged.review.publicId)); assert.ok(!exportPage.text.includes(buyer.user.email));
      assert.match(exportPage.headers['cache-control'], /no-store/);
      await moderator.client.get('/moderation/reviews?country=UG&country=KE').set('Accept', 'application/json').expect(422);
      await moderator.client.get('/moderation/reviews?country[bad]=UG').set('Accept', 'application/json').expect(422);
    });

    await t.test('HTTP actions enforce CSRF, current claims and versions before exposing a published review', async () => {
      const page = await moderator.client.get('/moderation/reviews?record=' + ownedReview.publicId).expect(200), token = csrf(page.text);
      const current = await version(Review, ownedReview), url = '/moderation/reviews/' + ownedReview.publicId + '/action';
      await moderator.client.post(url).set('Accept', 'application/json').send({ action: 'claim', version: current }).expect(403);
      await moderator.client.post(url).set('Accept', 'application/json').set('x-csrf-token', token).send({ action: 'publish', version: current, reason: 'Recorded buyer evidence supports publication.' }).expect(409);
      await moderator.client.post(url).set('Accept', 'application/json').set('x-csrf-token', token).send({ action: 'claim' }).expect(422);
      const claimed = await moderator.client.post(url).set('Accept', 'application/json').set('x-csrf-token', token).send({ action: 'claim', version: current }).expect(200);
      assert.equal(claimed.body.record.version, current + 1);
      await assert.rejects(act('reviews', ownedReview, { action: 'publish', version: claimed.body.record.version, reason: 'Another operator cannot decide a claimed review.' }, second), error => error.code === 'MODERATION_CLAIM_REQUIRED');
      const published = await moderator.client.post(url).set('Accept', 'application/json').set('x-csrf-token', token).send({ action: 'publish', version: claimed.body.record.version, reason: 'Delivered purchase evidence supports the recorded review.' }).expect(200);
      assert.equal(published.body.record.status, 'published');
      await moderator.client.post(url).set('Accept', 'application/json').set('x-csrf-token', token).send({ action: 'reject', version: claimed.body.record.version, reason: 'A stale page must not reverse a newer decision.' }).expect(409);
      const publicPage = await request(app).get('/api/v1/reviews/product/' + primary.product.publicId).expect(200);
      assert.ok(publicPage.body.reviews.some(row => row.publicId === ownedReview.publicId));
      assert.ok(!JSON.stringify(publicPage.body).includes('assignedUserId')); assert.ok(!JSON.stringify(publicPage.body).includes(buyer.user.email));
      assert.equal(await Notification.countDocuments({ userId: buyer.user._id, type: 'moderation_case' }), 1);
      assert.equal((await User.findById(moderator.user._id)).role, 'customer', 'Authoritative moderation grants never rewrite the stored role.');
    });

    await t.test('seller disputes reset claims and require an independent reviewer, including former disputers', async () => {
      await assert.rejects(pages.disputeOwnedReview(req(reporter), ownedReview.publicId, { version: await version(Review, ownedReview), reason: 'An unrelated account must not dispute this seller review.' }), error => error.status === 404 && error.code === 'REVIEW_NOT_FOUND');
      const sellerRequest = () => ({ ...req(seller), store: primary.store, params: { publicId: ownedReview.publicId }, body: { version: ownedReviewVersion, reason: 'Please independently examine the recorded delivered product review.' } });
      const ownedReviewVersion = await version(Review, ownedReview);
      const forbidden = { ...req(platformSeller), store: primary.store, params: { publicId: ownedReview.publicId },
        body: { version: ownedReviewVersion, reason: 'Platform-managed identities must not exercise Seller support permissions.' } };
      const sourceBefore = await Review.findById(ownedReview._id).lean(), auditBefore = await AuditLog.countDocuments({ targetPublicId: ownedReview.publicId });
      await assert.rejects(disputeSellerReview(forbidden), error => error.code === 'SELLER_IDENTITY_FORBIDDEN');
      await assert.rejects(pages.disputeOwnedReview(forbidden, ownedReview.publicId, forbidden.body, { sellerWorkspace: true }), error => error.code === 'SELLER_IDENTITY_FORBIDDEN');
      await assert.rejects(sellerRelationshipPage(forbidden, 'seller-reviews'), error => error.code === 'SELLER_IDENTITY_FORBIDDEN');
      assert.deepEqual(await Review.findById(ownedReview._id).lean(), sourceBefore);
      assert.equal(await AuditLog.countDocuments({ targetPublicId: ownedReview.publicId }), auditBefore);
      await assert.rejects(pages.disputeOwnedReview(sellerRequest(), ownedReview.publicId, { reason: 'A Seller workspace dispute must include the saved source version.' }, { sellerWorkspace: true }), error => error.name === 'ZodError');
      await Device.updateOne({ _id: seller.device._id }, { $set: { revokedAt: new Date() } });
      try {
        await assert.rejects(disputeSellerReview(sellerRequest()), error => error.code === 'ACCOUNT_UNAVAILABLE');
        await assert.rejects(sellerRelationshipPage(sellerRequest(), 'seller-reviews'), error => error.code === 'ACCOUNT_UNAVAILABLE');
      } finally { await Device.updateOne({ _id: seller.device._id }, { $unset: { revokedAt: 1 } }); }
      assert.deepEqual(await Review.findById(ownedReview._id).lean(), sourceBefore);
      await User.updateOne({ _id: seller.user._id }, { $set: { 'security.mfaEnabled': false } });
      try { await assert.rejects(disputeSellerReview(sellerRequest()), error => error.code === 'MFA_ENROLLMENT_REQUIRED'); }
      finally { await User.updateOne({ _id: seller.user._id }, { $set: { 'security.mfaEnabled': true } }); }
      await Store.updateOne({ _id: primary.store._id }, { $set: { status: 'suspended' } });
      try { await assert.rejects(disputeSellerReview(sellerRequest()), error => error.code === 'STORE_LOCKED'); }
      finally { await Store.updateOne({ _id: primary.store._id }, { $set: { status: 'verified' } }); }
      assert.equal((await Review.findById(ownedReview._id)).status, 'published'); assert.equal(await version(Review, ownedReview), ownedReviewVersion);
      const submittedDispute = await disputeSellerReview(sellerRequest()); assert.equal(submittedDispute.publicId, ownedReview.publicId);
      const disputed = await Review.findById(ownedReview._id);
      assert.equal(disputed.status, 'disputed'); assert.equal(disputed.assignedUserId, undefined); assert.equal(disputed.publicMessages.at(-1).author, 'seller');
      const sellerSelection = '/seller/reviews?review=' + disputed.publicId;
      const sellerJson = await seller.client.get(sellerSelection).set('Accept', 'application/json').expect(200);
      assert.equal(sellerJson.body.selected.publicMessages.at(-1).author, 'seller'); assert.equal(sellerJson.body.selected.publicMessages.at(-1).message, disputed.disputeReason);
      for (const privateValue of ['actorUserId', 'assignedUserId', String(seller.user._id), String(moderator.user._id)]) assert.ok(!JSON.stringify(sellerJson.body.selected).includes(privateValue));
      const sellerHtml = await seller.client.get(sellerSelection).expect(200);
      assert.ok(sellerHtml.text.includes(disputed.disputeReason)); assert.match(sellerHtml.text, /Public review conversation/);
      await assert.rejects(claim('reviews', Review, disputed, seller), error => error.status === 403);
      for (const entry of [platformSeller, buyer, activeMember, invitedMember]) await assert.rejects(claim('reviews', Review, disputed, entry), error => error.code === 'MODERATION_CONFLICT_OF_INTEREST');
      const ownPage = await pages.loadModerationTrustPage(req(buyer, { record: disputed.publicId }), 'moderator-reviews');
      assert.equal(ownPage.selected.canAct, false); assert.match(ownPage.selected.independenceReason, /independent|store/i);
      const separate = await seededReview(primary); await compatibility.publishReview(req(), separate.review.publicId, { decision: 'publish', reason: 'A genuine legacy caller receives an independent recorded decision.' });
      const membership = await StoreMember.create({ publicId: id('stm'), storeId: primary.store._id, userId: formerDisputer.user._id, role: 'support', status: 'active', invitedByUserId: seller.user._id });
      const historical = await pages.disputeOwnedReview(req(formerDisputer), separate.review.publicId, 'This affected store support employee requests review.');
      await StoreMember.updateOne({ _id: membership._id }, { $set: { status: 'revoked' } });
      await assert.rejects(claim('reviews', Review, historical, formerDisputer), error => error.code === 'MODERATION_CONFLICT_OF_INTEREST');
      const referred = await TrustCase.create({ publicId: id('case'), reporterUserId: reporter.user._id, country: 'UG', type: 'review_manipulation',
        productId: primary.product._id, productPublicId: primary.product.publicId, storeId: primary.store._id, storePublicId: primary.store.publicId,
        reviewId: historical._id, reviewPublicId: historical.publicId, description: 'The referred disputed review requires an independent case decision.' });
      for (const entry of [buyer, formerDisputer]) await assert.rejects(claim('cases', TrustCase, referred, entry), error => error.code === 'MODERATION_CONFLICT_OF_INTEREST');
      const distinctOwner = await subject({ productActor: productOwner }), owned = await seededReview(distinctOwner);
      await assert.rejects(claim('reviews', Review, owned.review, productOwner), error => error.code === 'MODERATION_CONFLICT_OF_INTEREST');
      const claimed = await claim('reviews', Review, disputed, second);
      const restored = await act('reviews', disputed, { action: 'publish', version: claimed.__v, reason: 'Independent delivered purchase review remains eligible for publication.' }, second);
      assert.equal(restored.status, 'published'); assert.equal(restored.decisionHistory.length, 2);
      assert.equal(restored.assignmentHistory.filter(row => row.action === 'claim').length, 2);
    });

    await t.test('customer product and store reports keep actual subject and country links and reject duplicate or mismatched concerns', async () => {
      productCase = await pages.createOwnedTrustIssue(req(reporter), { type: 'unsafe_product', productId: primary.product.publicId, country: 'KE', description: 'The actual product sold in Kenya requires a safety review.', reporterUserId: seller.user.publicId, status: 'closed' });
      storeCase = await pages.createOwnedTrustIssue(req(reporter), { type: 'seller_conduct', storeId: primary.store.publicId, country: 'UG', description: 'Please examine the recorded conduct of this actual store.' });
      assert.equal(productCase.country, 'KE'); assert.ok(same(productCase.storeId, primary.store._id)); assert.ok(same(productCase.reporterUserId, reporter.user._id)); assert.equal(productCase.status, 'open');
      const signal = await RiskSignal.findOne({ evidence: productCase.publicId }); assert.equal(signal.subjectPublicId, primary.product.publicId); assert.equal(signal.country, 'KE');
      await assert.rejects(pages.createOwnedTrustIssue(req(reporter), { type: 'unsafe_product', productId: primary.product.publicId, country: 'KE', description: 'A duplicate active concern must not create another case.' }), error => error.code === 'TRUST_REPORT_ALREADY_OPEN');
      await assert.rejects(pages.createOwnedTrustIssue(req(reporter), { type: 'counterfeit', productId: primary.product.publicId, storeId: foreign.store.publicId, country: 'UG', description: 'This mismatched foreign store does not own the selected product.' }), error => error.code === 'TRUST_SUBJECT_MISMATCH');
      await assert.rejects(pages.createOwnedTrustIssue(req(reporter), { type: 'counterfeit', productId: primary.product.publicId, country: 'TZ', description: 'A report cannot choose a market absent from the product.' }), error => error.code === 'TRUST_COUNTRY_INVALID');
      await assert.rejects(claim('cases', TrustCase, productCase, reporter), error => error.code === 'MODERATION_CONFLICT_OF_INTEREST');
      await assert.rejects(claim('cases', TrustCase, storeCase, seller), error => error.status === 403);
      for (const entry of [platformSeller, activeMember, invitedMember]) await assert.rejects(claim('cases', TrustCase, storeCase, entry), error => error.code === 'MODERATION_CONFLICT_OF_INTEREST');
      await assert.rejects(claim('signals', RiskSignal, signal, reporter), error => error.code === 'MODERATION_CONFLICT_OF_INTEREST');
      await RiskSignal.collection.updateOne({ _id: signal._id }, { $unset: { reporterUserId: '' } });
      await assert.rejects(claim('signals', RiskSignal, signal, reporter), error => error.code === 'MODERATION_CONFLICT_OF_INTEREST');
      await RiskSignal.collection.updateOne({ _id: signal._id }, { $set: { reporterUserId: reporter.user._id } });
      assert.equal(await AuditLog.countDocuments({ action: 'trust.report_created', targetPublicId: productCase.publicId }), 1);
    });

    await t.test('trust queues and signal decisions validate actual source countries rather than a local record label', async () => {
      const outside = await pages.createOwnedTrustIssue(req(foreignBuyer), { type: 'counterfeit', productId: foreign.product.publicId, country: 'TZ', description: 'A private foreign product requires its own market reviewers.' });
      const forged = await TrustCase.create({ publicId: id('case'), reporterUserId: reporter.user._id, country: 'UG', type: 'seller_conduct', storeId: foreign.store._id, storePublicId: foreign.store.publicId, description: 'A forged local country must not expose the foreign store.' });
      const wrongSignal = await RiskSignal.create({ publicId: id('rsk'), country: 'UG', subjectType: 'product', subjectPublicId: foreign.product.publicId, type: 'trust_counterfeit', severity: 'high', score: 80, createdBy: 'user', reporterUserId: reporter.user._id, evidence: [outside.publicId] });
      const cases = await pages.loadModerationTrustPage(req(), 'moderator-disputes'); assert.ok(cases.records.some(row => row.publicId === productCase.publicId)); assert.ok(cases.records.some(row => row.publicId === storeCase.publicId));
      assert.ok(!JSON.stringify(cases).includes(outside.publicId)); assert.ok(!JSON.stringify(cases).includes(forged.publicId)); assert.ok(!JSON.stringify(cases).includes(reporter.user.email));
      const signals = await pages.loadModerationTrustPage(req(moderator, { kind: 'signals' }), 'moderator-disputes'); assert.ok(!JSON.stringify(signals).includes(wrongSignal.publicId));
      await assert.rejects(claim('cases', TrustCase, forged), error => error.status === 409);
      await assert.rejects(claim('signals', RiskSignal, wrongSignal), error => error.status === 409);
      await assert.rejects(claim('cases', TrustCase, outside), error => [403, 404].includes(error.status));
      const valid = await RiskSignal.findOne({ evidence: productCase.publicId }), claimed = await claim('signals', RiskSignal, valid);
      const reviewed = await act('signals', valid, { action: 'review', version: claimed.__v, reason: 'The actual product source and customer concern were independently reviewed.' });
      assert.equal(reviewed.status, 'reviewed'); assert.ok(same(reviewed.reviewedByUserId, moderator.user._id));
      await assert.rejects(act('signals', valid, { action: 'review', version: claimed.__v, reason: 'A stale signal decision cannot overwrite its recorded review.' }), error => error.status === 409);
    });

    await t.test('case replies have an owned customer counterpart and one appeal requires a different deciding moderator', async () => {
      let current = await claim('cases', TrustCase, productCase);
      current = await act('cases', current, { action: 'investigate', version: current.__v, reason: 'Independent safety investigation of the actual product.' });
      current = await act('cases', current, { action: 'reply', version: current.__v, message: 'Please describe the observed safety concern in the delivered product.' });
      await assert.rejects(pages.customerReplyTrustCase(req(buyer), current.publicId, { version: current.__v, message: 'Another customer must not enter this private case.' }), error => error.status === 404);
      const stale = current.__v;
      current = await pages.customerReplyTrustCase(req(reporter), current.publicId, { version: current.__v, message: 'The actual package had a damaged safety seal when received.' });
      await assert.rejects(pages.customerReplyTrustCase(req(reporter), current.publicId, { version: stale, message: 'A stale reply must not append another public case message.' }), error => error.code === 'MODERATION_VERSION_CONFLICT');
      const dto = pages.customerTrustCaseDto(current); assert.equal(dto.publicMessages.at(-1).author, 'customer'); assert.ok(!JSON.stringify(dto).includes('actorUserId')); assert.ok(!JSON.stringify(dto).includes('assignedUserId'));
      current = await act('cases', current, { action: 'dismiss', version: current.__v, reason: 'Initial recorded evidence does not establish a current product violation.' });
      await assert.rejects(pages.appealOwnedTrustCase(req(buyer), current.publicId, { version: current.__v, message: 'An unrelated account cannot appeal another customer report.' }), error => error.status === 404);
      current = await pages.appealOwnedTrustCase(req(reporter), current.publicId, { version: current.__v, message: 'Please independently reconsider the documented damaged safety seal.' });
      assert.equal(current.status, 'appealed'); assert.equal(current.assignedUserId, undefined); assert.equal(current.appealCount, 1);
      await assert.rejects(claim('cases', TrustCase, current), error => error.code === 'TRUST_APPEAL_FOUR_EYES');
      await assert.rejects(act('cases', current, { action: 'dismiss', version: current.__v, reason: 'The original deciding moderator cannot decide the appeal.' }), error => error.code === 'TRUST_APPEAL_FOUR_EYES');
      current = await claim('cases', TrustCase, current, second);
      current = await act('cases', current, { action: 'close', version: current.__v, reason: 'A different moderator completed the independent appeal review.' }, second);
      assert.equal(current.status, 'closed'); assert.ok(same(current.decisionByUserId, second.user._id));
      await assert.rejects(pages.appealOwnedTrustCase(req(reporter), current.publicId, { version: current.__v, message: 'A second appeal cannot reopen an already independently reviewed report.' }), error => error.code === 'TRUST_APPEAL_STATE');
      assert.ok(await Notification.exists({ userId: reporter.user._id, type: 'moderation_case', country: 'KE' }));
      productCase = current;
    });

    await t.test('private trust evidence requires the exact attached case, country, reporter and ready state', async () => {
      const storageKey = `private/${id('trust')}.webp`, bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).webp().toBuffer();
      await putMediaObject(storageKey, bytes, { contentType: 'image/webp', cacheControl: 'private, no-store' });
      try {
        const evidence = await EvidenceDocument.create({ publicId: id('evd'), ownerUserId: reporter.user._id, country: 'UG', contextType: 'trust_case', contextPublicId: storeCase.publicId,
          documentType: 'general', storageKey, mimeType: 'image/webp', size: bytes.length, status: 'ready' });
        await TrustCase.updateOne({ _id: storeCase._id }, { $push: { evidenceDocumentIds: evidence._id } });
        const record = await pages.authorizeModerationTrustEvidence(req(), evidence.publicId); assert.equal(record.publicId, evidence.publicId); assert.equal(record.storageKey, storageKey);
        const rendered = await moderator.client.get('/moderation/risk-cases?record=' + storeCase.publicId).expect(200);
        const claimForm = rendered.text.match(new RegExp('<form[^>]*action="/moderation/risk-cases/' + storeCase.publicId + '/action"[^>]*>([\\s\\S]*?)</form>'))[1];
        const renderedVersion = Number(claimForm.match(/name="version" value="(\d+)"/)[1]);
        const businessRecords = [[TrustCase, storeCase], [Product, primary.product], [Store, primary.store], [Review, ownedReview], [Order, purchaseRow]];
        const beforeDownload = await Promise.all(businessRecords.map(async ([Model, row]) => {
          const fresh = await Model.findById(row._id).lean(); return { version: fresh.__v, updatedAt: fresh.updatedAt };
        }));
        assert.equal(renderedVersion, beforeDownload[0].version);
        const evidenceUrl = '/moderation/evidence/' + evidence.publicId;
        const downloaded = await moderator.client.get(evidenceUrl).expect(200);
        assert.match(downloaded.headers['content-type'], /^image\/webp/); assert.deepEqual(downloaded.body, bytes);
        assert.match(downloaded.headers['cache-control'], /private, no-store/); assert.equal(downloaded.headers['x-content-type-options'], 'nosniff');
        const accessFilter = { action: 'moderation.trust_evidence_accessed', targetPublicId: storeCase.publicId, actorId: moderator.user._id };
        assert.equal(await AuditLog.countDocuments(accessFilter), 1);
        const afterDownload = await Promise.all(businessRecords.map(async ([Model, row]) => {
          const fresh = await Model.findById(row._id).lean(); return { version: fresh.__v, updatedAt: fresh.updatedAt };
        }));
        assert.deepEqual(afterDownload, beforeDownload, 'Viewing evidence preserves current business versions and timestamps.');
        const claimedAfterReading = await moderator.client.post('/moderation/risk-cases/' + storeCase.publicId + '/action').set('Accept', 'application/json').set('x-csrf-token', csrf(rendered.text))
          .send({ action: 'claim', version: renderedVersion }).expect(200);
        await act('cases', storeCase, { action: 'release', version: claimedAfterReading.body.record.version });
        await seller.client.get(evidenceUrl).set('Accept', 'application/json').expect(403);
        const originalReadFile = fs.readFile;
        let revokedDuringRead = false;
        t.mock.method(fs, 'readFile', async (...args) => {
          const contents = await originalReadFile(...args);
          if (!revokedDuringRead && String(args[0]).endsWith('/' + storageKey)) {
            revokedDuringRead = true;
            await PlatformGrant.updateOne({ _id: moderator.grant._id }, { $set: { status: 'suspended' } });
          }
          return contents;
        });
        try {
          await moderator.client.get(evidenceUrl).set('Accept', 'application/json').expect(403);
          assert.equal(revokedDuringRead, true, 'Revoke the current grant after the exact private object has been read.');
          assert.equal(await AuditLog.countDocuments(accessFilter), 1, 'A failed authorization after storage awaits must not record successful access.');
        } finally {
          t.mock.restoreAll();
          await PlatformGrant.updateOne({ _id: moderator.grant._id }, { $set: { status: 'active' } });
        }
        for (const entry of [seller, activeMember, invitedMember, reporter]) await assert.rejects(pages.authorizeModerationTrustEvidence(req(entry), evidence.publicId), error => error.status === 403);
        for (const patch of [{ status: 'quarantined' }, { country: 'KE' }, { ownerUserId: buyer.user._id }, { contextPublicId: productCase.publicId }]) {
          await EvidenceDocument.updateOne({ _id: evidence._id }, { $set: patch });
          await assert.rejects(pages.authorizeModerationTrustEvidence(req(), evidence.publicId), error => [403, 404, 409].includes(error.status));
          await EvidenceDocument.updateOne({ _id: evidence._id }, { $set: { status: 'ready', country: 'UG', ownerUserId: reporter.user._id, contextPublicId: storeCase.publicId } });
        }
        await TrustCase.updateOne({ _id: storeCase._id }, { $pull: { evidenceDocumentIds: evidence._id } });
        await assert.rejects(pages.authorizeModerationTrustEvidence(req(), evidence.publicId), error => [403, 404, 409].includes(error.status));
        const json = await moderator.client.get('/moderation/risk-cases?record=' + storeCase.publicId).set('Accept', 'application/json').expect(200); assert.ok(!JSON.stringify(json.body).includes(storageKey));
      } finally { await deleteMediaObject(storageKey); }
    });

    await t.test('global product and store enforcement require every affected selling country and verified restoration records', async () => {
      const global = await subject({ countries: ['UG', 'KE', 'TZ'] });
      let doc = await pages.createOwnedTrustIssue(req(reporter), { type: 'counterfeit', productId: global.product.publicId, country: 'UG', description: 'This actual globally sold product needs recorded counterfeit enforcement.' });
      const selected = await pages.loadModerationTrustPage(req(moderator, { record: doc.publicId }), 'moderator-disputes');
      assert.equal(selected.selected.canEnforceProduct, false); assert.equal(selected.selected.canEnforceStore, false);
      doc = await claim('cases', TrustCase, doc);
      await assert.rejects(act('cases', doc, { action: 'action', version: doc.__v, reason: 'A local reviewer cannot globally suspend foreign selling markets.', enforcement: 'suspend_product' }), error => error.code === 'TRUST_ENFORCEMENT_COUNTRY_FORBIDDEN');
      assert.equal((await Product.findById(global.product._id)).status, 'published'); assert.equal((await TrustCase.findById(doc._id)).status, 'open');
      doc = await act('cases', doc, { action: 'release', version: doc.__v }); doc = await claim('cases', TrustCase, doc, globalModerator);
      doc = await act('cases', doc, { action: 'action', version: doc.__v, reason: 'All affected market authority independently confirms suspension.', enforcement: 'suspend_product' }, globalModerator);
      assert.equal((await Product.findById(global.product._id)).status, 'suspended');
      let restoration = await pages.createOwnedTrustIssue(req(reporter), { type: 'seller_conduct', productId: global.product.publicId, country: 'UG', description: 'Verified corrective evidence needs an independently recorded restoration.' });
      restoration = await claim('cases', TrustCase, restoration, globalModerator);
      await act('cases', restoration, { action: 'action', version: restoration.__v, reason: 'Verified corrective evidence restores the recorded prior product state.', enforcement: 'restore_product' }, globalModerator);
      assert.equal((await Product.findById(global.product._id)).status, 'published');
      const storeSubject = await subject({ countries: ['UG'] });
      await subject({ countries: ['TZ'], store: storeSubject.store, status: 'draft' });
      let storeReport = await pages.createOwnedTrustIssue(req(reporter), { type: 'seller_conduct', storeId: storeSubject.store.publicId, country: 'UG', description: 'This store owns both public local goods and a foreign draft product.' });
      storeReport = await claim('cases', TrustCase, storeReport);
      await assert.rejects(act('cases', storeReport, { action: 'action', version: storeReport.__v, reason: 'Store suspension also affects its foreign draft catalogue.', enforcement: 'suspend_store' }), error => error.code === 'TRUST_ENFORCEMENT_COUNTRY_FORBIDDEN');
      storeReport = await act('cases', storeReport, { action: 'release', version: storeReport.__v }); storeReport = await claim('cases', TrustCase, storeReport, globalModerator);
      await act('cases', storeReport, { action: 'action', version: storeReport.__v, reason: 'Authorized global store enforcement preserves its verified prior status.', enforcement: 'suspend_store' }, globalModerator);
      assert.equal((await Store.findById(storeSubject.store._id)).status, 'suspended');
      let restoreStore = await pages.createOwnedTrustIssue(req(reporter), { type: 'review_manipulation', storeId: storeSubject.store.publicId, country: 'UG', description: 'Recorded remediation requires a verified store restoration decision.' });
      restoreStore = await claim('cases', TrustCase, restoreStore, globalModerator);
      const prior = await AuditLog.findOne({ action: 'trust.store_suspended', targetPublicId: storeSubject.store.publicId });
      // Intentionally corrupt this isolated fixture through the raw collection; normal audit updates are immutable.
      await AuditLog.collection.updateOne({ _id: prior._id }, { $set: { 'metadata.previousStatus': 'closed' } });
      await assert.rejects(act('cases', restoreStore, { action: 'action', version: restoreStore.__v, reason: 'An invalid prior state cannot restore this suspended store.', enforcement: 'restore_store' }, globalModerator), error => error.code === 'STORE_RESTORE_STATE');
      await AuditLog.collection.updateOne({ _id: prior._id }, { $set: { 'metadata.previousStatus': 'verified' } });
      await act('cases', restoreStore, { action: 'action', version: restoreStore.__v, reason: 'Matching authoritative suspension audit restores the actual verified store.', enforcement: 'restore_store' }, globalModerator);
      assert.equal((await Store.findById(storeSubject.store._id)).status, 'verified');
      assert.equal(await Refund.countDocuments(), 0); assert.equal(await LedgerTransaction.countDocuments(), 0);
    });

    await t.test('competing claims and current decisions have one winner and preserve the complete recorded history', async () => {
      const fixture = await seededReview(primary), initial = fixture.review.__v, notices = await Notification.countDocuments({ userId: buyer.user._id, type: 'moderation_case' });
      const claims = await Promise.allSettled([moderator, second].map(entry => act('reviews', fixture.review, { action: 'claim', version: initial }, entry)));
      assert.equal(claims.filter(row => row.status === 'fulfilled').length, 1); assert.equal(claims.filter(row => row.status === 'rejected' && row.reason.status === 409).length, 1);
      const claimed = await Review.findById(fixture.review._id), winner = same(claimed.assignedUserId, moderator.user._id) ? moderator : second;
      const decisions = await Promise.allSettled(['publish', 'reject'].map(action => act('reviews', claimed, { action, version: claimed.__v, reason: 'Only one current independent decision may complete this review.' }, winner)));
      assert.equal(decisions.filter(row => row.status === 'fulfilled').length, 1); assert.equal(decisions.filter(row => row.status === 'rejected' && row.reason.status === 409).length, 1);
      const saved = await Review.findById(claimed._id); assert.equal(saved.assignmentHistory.length, 1); assert.equal(saved.decisionHistory.length, 1); assert.equal(saved.__v, initial + 2);
      assert.equal(await Notification.countDocuments({ userId: buyer.user._id, type: 'moderation_case' }), notices + 1);
    });

    await t.test('audit and customer-notification failure roll back decisions, enforcement, claims, grant fences and notices', async () => {
      const isolated = await subject({ countries: ['UG'] });
      let doc = await pages.createOwnedTrustIssue(req(reporter), { type: 'counterfeit', productId: isolated.product.publicId, country: 'UG', description: 'A real local product is used to prove atomic domain and notification writes.' });
      doc = await claim('cases', TrustCase, doc);
      const before = { doc: await TrustCase.findById(doc._id).lean(), product: await Product.findById(isolated.product._id).lean(), user: await User.findById(moderator.user._id).lean(), grant: await PlatformGrant.findById(moderator.grant._id).lean(), market: await CountrySetting.findOne({ code: 'UG' }).lean(), notices: await Notification.countDocuments(), audits: await AuditLog.countDocuments() };
      const operation = () => act('cases', doc, { action: 'action', version: doc.__v, reason: 'A failed dependent write must roll back actual product enforcement.', enforcement: 'suspend_product' });
      for (const [Model, message] of [[AuditLog, 'Trust audit unavailable'], [Notification, 'Trust notification unavailable']]) {
        t.mock.method(Model, 'create', async () => { throw new Error(message); });
        try { await assert.rejects(operation(), new RegExp(message)); } finally { t.mock.restoreAll(); }
        assert.deepEqual(await TrustCase.findById(doc._id).lean(), before.doc); assert.deepEqual(await Product.findById(isolated.product._id).lean(), before.product);
        assert.equal((await User.findById(moderator.user._id)).__v, before.user.__v); assert.equal((await PlatformGrant.findById(moderator.grant._id)).__v, before.grant.__v); assert.equal((await CountrySetting.findOne({ code: 'UG' })).__v, before.market.__v);
        assert.equal(await Notification.countDocuments(), before.notices); assert.equal(await AuditLog.countDocuments(), before.audits);
      }
      const order = await purchase(isolated), input = { orderId: order.publicId, productId: isolated.product.publicId, rating: 4, body: 'Failed review intake must not retain partial purchases or work notices.' };
      const count = await Review.countDocuments(), orderVersion = order.__v;
      t.mock.method(AuditLog, 'create', async () => { throw new Error('Review intake audit unavailable'); });
      try { await assert.rejects(pages.createOwnedVerifiedReview(req(buyer), input), /Review intake audit unavailable/); } finally { t.mock.restoreAll(); }
      assert.equal(await Review.countDocuments(), count); assert.equal((await Order.findById(order._id)).__v, orderVersion); assert.equal(await Notification.countDocuments(), before.notices);
    });

    await t.test('authoritative grant, account, enrollment and active market changes reject stale HTTP sessions and service requests', async () => {
      const fixture = await seededReview(primary);
      await PlatformGrant.updateOne({ _id: moderator.grant._id }, { $set: { status: 'suspended' } });
      await moderator.client.get('/moderation/reviews').set('Accept', 'application/json').expect(403);
      await assert.rejects(claim('reviews', Review, fixture.review), error => error.status === 403);
      await PlatformGrant.updateOne({ _id: moderator.grant._id }, { $set: { status: 'active' } });
      await User.updateOne({ _id: moderator.user._id }, { $set: { 'security.mfaEnabled': false } });
      await assert.rejects(claim('reviews', Review, fixture.review), error => error.code === 'MFA_ENROLLMENT_REQUIRED');
      await User.updateOne({ _id: moderator.user._id }, { $set: { 'security.mfaEnabled': true } });
      await CountrySetting.updateOne({ code: 'UG' }, { $set: { active: false } });
      await assert.rejects(claim('reviews', Review, fixture.review), error => [403, 404, 409].includes(error.status));
      await CountrySetting.updateOne({ code: 'UG' }, { $set: { active: true } });
      await User.updateOne({ _id: moderator.user._id }, { $inc: { 'security.tokenVersion': 1 } });
      await assert.rejects(claim('reviews', Review, fixture.review), error => error.code === 'ACCOUNT_UNAVAILABLE');
      assert.equal((await Review.findById(fixture.review._id)).assignedUserId, undefined);
      assert.equal((await User.findById(moderator.user._id)).role, 'customer');
    });
  } finally {
    t.mock.restoreAll();
    for (const transport of transports) transport.destroy();
    await fs.rm(process.env.UPLOAD_DIR, { recursive: true, force: true });
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

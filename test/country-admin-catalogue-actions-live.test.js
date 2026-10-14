import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.REDIS_URL = '';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
for (const name of ['SESSION_SECRET', 'TOKEN_PEPPER', 'SECURITY_INTEGRITY_KEY', 'DATA_ENCRYPTION_KEY']) process.env[name] = crypto.randomBytes(32).toString('hex');
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;

test('Country Admin catalogue edits and independent review claims use current sources, full market scope and atomic audit', { skip: !uri, timeout: 180_000 }, async t => {
  const parsed = new URL(uri);
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.port, '27019');
  assert.match(parsed.pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: 'classicmart_country_admin_catalogue_test_' + suffix });
  try {
    const { User, PlatformGrant, CountrySetting, Category, Brand, Store, StoreMember, Product, ProductVariant, Order, Review, AuditLog, Notification } = await import('../src/models/index.js');
    const actions = await import('../src/services/country-admin-catalogue-actions.js');
    const { encryptSensitive } = await import('../src/core/sensitive.js');
    await Promise.all(Object.values(mongoose.models).map(Model => Model.init()));
    await CountrySetting.create([
      { code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256' },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254' },
      { code: 'TZ', name: 'Foreign market', currency: 'TZS', locale: 'en-TZ', timeZone: 'Africa/Dar_es_Salaam', phonePrefix: '+255' },
    ]);
    let sequence = 0;
    const id = prefix => prefix + '_caca_' + suffix + '_' + ++sequence;
    async function actor({ role = 'country_admin', countries = ['UG', 'KE'], managed = true } = {}) {
      const number = ++sequence, email = 'country-admin-catalogue-' + suffix + '-' + number + '@example.com', phone = '+25670' + String(number).padStart(7, '0');
      const user = await User.create({ publicId: id('usr'), name: 'Country catalogue actor ' + number, email, emailNormalized: email, phone, phoneNormalized: phone,
        passwordHash: 'unused-direct-service-fixture', role: managed ? 'customer' : role, country: countries[0], operationalCountries: managed ? ['TZ'] : countries,
        currency: 'UGX', shoppingCountry: 'TZ', platformAccessManagedAt: managed ? new Date() : undefined, emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
        security: { mfaEnabled: true, mfaSecretEncrypted: encryptSensitive('JBSWY3DPEHPK3PXP') }, consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const grant = managed ? await PlatformGrant.create({ publicId: id('pgr'), userId: user._id, role, operationalCountries: countries, status: 'active',
        startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86400_000), reason: 'Isolated Country Admin catalogue verification',
        approvalPublicId: id('apr'), approvedByUserId: new mongoose.Types.ObjectId() }) : null;
      return { user, grant };
    }
    const admin = await actor(), contender = await actor(), local = await actor({ countries: ['UG'] }), moderator = await actor({ role: 'moderator' });
    const buyer = await actor({ role: 'customer', managed: false });
    const request = (entry = admin, { publicId, body = {}, country = 'UG' } = {}) => ({ id: id('req'), user: entry.user,
      session: { tokenVersion: entry.user.security.tokenVersion }, query: { country }, params: publicId ? { publicId } : {}, body,
      country: { code: country || 'UG' }, ip: '127.0.0.1', get: () => 'CountryAdminCatalogueLive/1.0' });
    const version = async (Model, row) => Number((await Model.findById(row._id)).__v || 0);
    const category = await Category.create({ publicId: id('cat'), name: 'Local catalogue goods', slug: id('category'), countries: ['UG'],
      attributes: [{ key: 'colour', label: 'Colour', type: 'select', required: true, options: ['Blue', 'Green'] }] });
    const globalCategory = await Category.create({ publicId: id('cat'), name: 'Global catalogue goods', slug: id('category'), countries: [] });
    const sharedCategory = await Category.create({ publicId: id('cat'), name: 'Shared foreign catalogue goods', slug: id('category'), countries: ['UG', 'TZ'] });
    async function subject(country, categoryRow = category, options = {}) {
      const owner = options.owner || await actor({ role: 'seller', countries: [country], managed: false });
      const currency = { UG: 'UGX', KE: 'KES', TZ: 'TZS' }[country];
      const store = await Store.create({ publicId: id('sto'), ownerUserId: owner.user._id, name: 'Actual ' + country + ' source store', slug: id('store'), country, currency, status: 'verified' });
      const product = await Product.create({ publicId: id('prd'), storeId: store._id, ownerUserId: owner.user._id, categoryId: categoryRow._id,
        title: 'Actual delivered catalogue goods', slug: id('product'), description: 'A real product with an actual source store.', countries: options.countries || [country],
        attributes: categoryRow.attributes.length ? { colour: 'Blue' } : {}, status: 'published' });
      const variant = await ProductVariant.create({ publicId: id('var'), productId: product._id, storeId: store._id, sku: id('sku').toUpperCase(), title: 'Standard',
        priceMinor: 10000, costMinor: 5000, currency });
      return { owner, store, product, variant };
    }
    const primary = await subject('UG'), foreign = await subject('TZ', sharedCategory);
    const edit = async (row, changes, entry = admin, type = 'categories') => actions.actCountryAdminCategory(request(entry, { publicId: row.publicId,
      body: { version: await version(type === 'categories' ? Category : Brand, row), reason: 'Reasoned catalogue correction', ...changes } }), type);
    const decision = async (row, action, fields = {}, entry = admin) => actions.actCountryAdminReview(request(entry, { publicId: row.publicId,
      body: { version: await version(Review, row), ...fields } }), action);
    async function reviewedPurchase(source = primary, { customer = buyer, delivered = true, country = 'UG', verified = true } = {}) {
      const currency = { UG: 'UGX', KE: 'KES', TZ: 'TZS' }[country], linePublicId = id('oli');
      const order = await Order.create({ publicId: id('ord'), idempotencyKey: id('checkout'), checkoutId: id('checkout'), cartPublicId: id('crt'), sessionKey: id('session'),
        userId: customer.user._id, country, status: 'paid', paymentState: 'paid', fulfillmentState: delivered ? 'delivered' : 'shipped', deliveryMethod: 'standard', paymentMethod: 'card',
        contact: { fullName: customer.user.name, email: customer.user.email, phone: customer.user.phone, address: 'PRIVATE_COUNTRY_ADMIN_ADDRESS', city: 'Private city', country },
        totals: { subtotalMinor: 10000, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 10000, currency }, reservationExpiresAt: new Date(Date.now() + 86400_000),
        items: [{ linePublicId, productId: source.product._id, productPublicId: source.product.publicId, variantId: source.variant._id, variantPublicId: source.variant.publicId,
          storeId: source.store._id, storePublicId: source.store.publicId, reservationPublicId: id('rsv'), title: source.product.title, variantTitle: source.variant.title,
          sku: source.variant.sku, quantity: 1, deliveredQuantity: delivered ? 1 : 0, unitPriceMinor: 10000, lineTotalMinor: 10000, currency }] });
      const review = await Review.create({ publicId: id('rev'), userId: customer.user._id, orderId: order._id, orderPublicId: order.publicId, orderLinePublicId: linePublicId,
        productId: source.product._id, productPublicId: source.product.publicId, country, rating: 4, body: 'A genuine purchased product awaiting an independent review.', verifiedPurchase: verified });
      return { review, order };
    }

    await t.test('category updates retain complete market and attribute invariants and safe current detail', async () => {
      const flow = await actions.loadCountryAdminCategoryDetail(request(), category.publicId, 'categories');
      assert.equal(flow.canEdit, true); assert.deepEqual(flow.affectedCountries, ['UG']);
      assert.equal(flow.record.createdByUserId, undefined); assert.equal(flow.record._id, undefined);
      await assert.rejects(edit(category, { countries: ['UG', 'TZ'] }), error => error.code === 'COUNTRY_ADMIN_CATALOGUE_COUNTRY_FORBIDDEN');
      await assert.rejects(edit(category, { countries: [] }), error => error.name === 'ZodError');
      await assert.rejects(edit(category, { parentId: category.publicId }), error => error.code === 'COUNTRY_ADMIN_CATALOGUE_FIELD_FORBIDDEN');
      await assert.rejects(edit(category, { sortOrder: -1 }), error => error.code === 'COUNTRY_ADMIN_CATALOGUE_FIELD_FORBIDDEN');
      await assert.rejects(edit(category, { attributes: [] }), error => error.code === 'COUNTRY_ADMIN_CATEGORY_ATTRIBUTES_IN_USE');
      await assert.rejects(edit(category, { attributes: [{ key: 'colour', label: 'Colour', type: 'select', options: ['Green'], required: true }] }), error => error.code === 'COUNTRY_ADMIN_CATEGORY_ATTRIBUTES_IN_USE');
      const beforeVersion = await version(Category, category), saved = await edit(category, { name: 'Scoped catalogue goods', active: 'yes', restricted: 'no' });
      assert.equal(saved.name, 'Scoped catalogue goods'); assert.equal(saved.version, beforeVersion + 1); assert.equal(saved._id, undefined);
      assert.ok(await AuditLog.exists({ action: 'country_admin.category_updated', targetPublicId: category.publicId, actorId: admin.user._id, country: 'UG' }));
      await assert.rejects(actions.actCountryAdminCategory(request(admin, { publicId: category.publicId, body: { version: beforeVersion, reason: 'Stale edit', name: 'Must not persist' } }), 'categories'), error => error.code === 'COUNTRY_ADMIN_CATALOGUE_VERSION_CONFLICT');
      for (const row of [globalCategory, sharedCategory]) {
        const detail = await actions.loadCountryAdminCategoryDetail(request(), row.publicId, 'categories');
        assert.equal(detail.canEdit, false); assert.ok(detail.readOnlyReason);
        await assert.rejects(edit(row, { active: false }), error => error.code === 'COUNTRY_ADMIN_CATALOGUE_COUNTRY_FORBIDDEN');
      }
      await assert.rejects(actions.loadCountryAdminCategoryDetail(request(moderator), category.publicId), error => error.status === 403);
      await assert.rejects(actions.loadCountryAdminCategoryDetail(request(admin, { country: 'TZ' }), category.publicId), error => error.code === 'COUNTRY_ADMIN_COUNTRY_FORBIDDEN');
    });

    await t.test('current Product selling countries and Store country prevent shared catalogue edits', async () => {
      await Product.updateOne({ _id: primary.product._id }, { $set: { countries: ['UG', 'TZ'] }, $inc: { __v: 1 } });
      assert.equal((await actions.loadCountryAdminCategoryDetail(request(), category.publicId)).canEdit, false);
      await assert.rejects(edit(category, { description: 'Should remain unchanged.' }), error => error.code === 'COUNTRY_ADMIN_CATALOGUE_COUNTRY_FORBIDDEN');
      await Product.updateOne({ _id: primary.product._id }, { $set: { countries: ['UG'] }, $inc: { __v: 1 } });
      await Store.updateOne({ _id: primary.store._id }, { $set: { country: 'TZ', currency: 'TZS' }, $inc: { __v: 1 } });
      await assert.rejects(edit(category, { active: false }), error => error.code === 'COUNTRY_ADMIN_CATALOGUE_COUNTRY_FORBIDDEN');
      await Store.updateOne({ _id: primary.store._id }, { $set: { country: 'UG', currency: 'UGX' }, $inc: { __v: 1 } });
    });

    await t.test('brand requests require scoped requester and all current references; approved global brands remain read-only', async () => {
      const pending = await Brand.create({ publicId: id('brd'), name: 'Scoped requested brand', slug: id('brand'), status: 'pending', requestedByStoreId: primary.store._id });
      const shared = await Brand.create({ publicId: id('brd'), name: 'Shared brand request', slug: id('brand'), status: 'pending', requestedByStoreId: primary.store._id });
      await Product.updateOne({ _id: foreign.product._id }, { $set: { brandId: shared._id }, $inc: { __v: 1 } });
      const approved = await Brand.create({ publicId: id('brd'), name: 'Global approved brand', slug: id('brand'), status: 'approved' });
      const unlinked = await Brand.create({ publicId: id('brd'), name: 'Unlinked brand request', slug: id('brand'), status: 'pending' });
      assert.equal((await actions.loadCountryAdminCategoryDetail(request(), pending.publicId, 'brands')).canEdit, true);
      assert.equal((await actions.loadCountryAdminCategoryDetail(request(), shared.publicId, 'brands')).canEdit, false);
      await assert.rejects(edit(shared, { status: 'approved' }, admin, 'brands'), error => error.code === 'COUNTRY_ADMIN_CATALOGUE_COUNTRY_FORBIDDEN');
      await assert.rejects(edit(approved, { name: 'Forbidden global change' }, admin, 'brands'), error => error.code === 'COUNTRY_ADMIN_CATALOGUE_COUNTRY_FORBIDDEN');
      await assert.rejects(edit(unlinked, { name: 'Unverified requester' }, admin, 'brands'), error => error.code === 'COUNTRY_ADMIN_CATALOGUE_NOT_FOUND');
      const result = await edit(pending, { status: 'approved' }, admin, 'brands');
      assert.equal(result.status, 'approved'); assert.equal(result.reviewedByUserId, undefined);
      assert.equal((await actions.loadCountryAdminCategoryDetail(request(), pending.publicId, 'brands')).canEdit, false);
      assert.ok(await AuditLog.exists({ action: 'country_admin.brand_updated', targetPublicId: pending.publicId, 'metadata.previousStatus': 'pending', 'metadata.status': 'approved' }));
    });

    await t.test('catalogue failures roll back data, source fences and audit together', async () => {
      const recordBefore = await Category.findById(category._id).lean(), productBefore = await Product.findById(primary.product._id).lean();
      const countBefore = await AuditLog.countDocuments({ action: 'country_admin.category_updated', targetPublicId: category.publicId });
      const originalCreate = AuditLog.create;
      AuditLog.create = async (...args) => {
        if (args[0]?.[0]?.action === 'country_admin.category_updated') throw new Error('Injected transactional audit failure');
        return originalCreate.apply(AuditLog, args);
      };
      try { await assert.rejects(edit(category, { name: 'Atomic failure must not persist' }), /Injected transactional audit failure/); }
      finally { AuditLog.create = originalCreate; }
      const current = await Category.findById(category._id).lean();
      assert.equal(current.name, recordBefore.name); assert.equal(current.__v, recordBefore.__v);
      assert.equal((await Product.findById(primary.product._id)).__v, productBefore.__v);
      assert.equal(await AuditLog.countDocuments({ action: 'country_admin.category_updated', targetPublicId: category.publicId }), countBefore);
    });

    await t.test('review details require immutable delivered sources and remove private identities', async () => {
      const valid = await reviewedPurchase(), undelivered = await reviewedPurchase(primary, { delivered: false }), unverified = await reviewedPurchase(primary, { verified: false });
      const detail = await actions.loadCountryAdminReviewDetail(request(), valid.review.publicId);
      assert.equal(detail.canClaim, true); assert.equal(detail.canDecide, false); assert.equal(detail.record.assignment.state, 'unassigned');
      assert.equal(detail.order.fulfillmentState, 'delivered'); assert.equal(detail.store.country, 'UG');
      assert.doesNotMatch(JSON.stringify(detail), /PRIVATE_COUNTRY_ADMIN_ADDRESS|"(?:_id|userId|actorUserId|ownerUserId|storeId|orderId|productId|passwordHash|email|phone|contact)"/);
      for (const row of [undelivered, unverified]) await assert.rejects(actions.loadCountryAdminReviewDetail(request(), row.review.publicId), error => error.code === 'REVIEW_NOT_FOUND');
      await assert.rejects(decision(undelivered.review, 'claim'), error => error.code === 'REVIEW_LINKAGE_INVALID');
      const foreignPurchase = await reviewedPurchase(foreign, { country: 'UG' });
      await assert.rejects(actions.loadCountryAdminReviewDetail(request(), foreignPurchase.review.publicId), error => error.code === 'REVIEW_NOT_FOUND');
      await assert.rejects(decision(foreignPurchase.review, 'claim'), error => error.code === 'COUNTRY_ADMIN_SOURCE_COUNTRY_FORBIDDEN');
    });

    await t.test('independent claims gate review outcomes and persist public notices with audit', async () => {
      const { review } = await reviewedPurchase();
      await assert.rejects(decision(review, 'publish', { reason: 'This is a verified purchase.' }), error => error.code === 'MODERATION_CLAIM_REQUIRED');
      await decision(review, 'claim');
      await assert.rejects(decision(review, 'claim', {}, contender), error => error.code === 'MODERATION_CLAIM_REQUIRED');
      await assert.rejects(decision(review, 'release', {}, contender), error => error.code === 'MODERATION_CLAIM_REQUIRED');
      assert.equal((await actions.loadCountryAdminReviewDetail(request(), review.publicId)).canDecide, true);
      await decision(review, 'reply', { message: 'The purchase source has been checked.' });
      await decision(review, 'release');
      await decision(review, 'claim', {}, contender);
      const saved = await decision(review, 'decision', { decision: 'publish', reason: 'Independent delivered purchase review accepted.' }, contender);
      assert.equal(saved.status, 'published'); assert.equal(saved.assignment.mine, true);
      assert.doesNotMatch(JSON.stringify(saved), /"(?:_id|userId|actorUserId|moderatedByUserId|assignedUserId)"/);
      assert.equal(saved.publicMessages.at(-1).author, 'moderation');
      assert.ok(await AuditLog.exists({ action: 'review.moderated', targetPublicId: review.publicId, actorId: contender.user._id, 'metadata.decision': 'publish' }));
      assert.ok(await Notification.exists({ userId: buyer.user._id, country: 'UG', type: 'moderation_case' }));
      assert.ok(await Notification.exists({ userId: primary.owner.user._id, country: 'UG', type: 'moderation_case' }));
      await assert.rejects(decision(review, 'reject', { reason: 'A second outcome cannot overwrite it.' }), error => error.code === 'REVIEW_STATE');
    });

    await t.test('buyer, owners, invited members and changed source countries cannot decide', async () => {
      const own = await reviewedPurchase(primary, { customer: admin });
      assert.equal((await actions.loadCountryAdminReviewDetail(request(), own.review.publicId)).canAct, false);
      await assert.rejects(decision(own.review, 'claim'), error => error.code === 'MODERATION_CONFLICT_OF_INTEREST');
      const membership = await StoreMember.create({ publicId: id('stm'), storeId: primary.store._id, userId: admin.user._id, role: 'support', status: 'invited', invitedByUserId: primary.owner.user._id });
      const memberReview = await reviewedPurchase();
      await assert.rejects(decision(memberReview.review, 'claim'), error => error.code === 'MODERATION_CONFLICT_OF_INTEREST');
      await StoreMember.deleteOne({ _id: membership._id });
      const changed = await reviewedPurchase();
      await decision(changed.review, 'claim', {}, local);
      await Store.updateOne({ _id: primary.store._id }, { $set: { country: 'KE', currency: 'KES' }, $inc: { __v: 1 } });
      await assert.rejects(decision(changed.review, 'publish', { reason: 'No foreign-source decision may persist.' }, local), error => error.code === 'COUNTRY_ADMIN_SOURCE_COUNTRY_FORBIDDEN');
      assert.equal((await Review.findById(changed.review._id)).status, 'pending');
      await Store.updateOne({ _id: primary.store._id }, { $set: { country: 'UG', currency: 'UGX' }, $inc: { __v: 1 } });
      await assert.rejects(decision(changed.review, 'release', {}, moderator), error => error.status === 403);
      await PlatformGrant.updateOne({ _id: local.grant._id }, { $set: { status: 'revoked', revokedAt: new Date() }, $inc: { __v: 1 } });
      await assert.rejects(decision(changed.review, 'release', {}, local), error => error.code === 'COUNTRY_ADMIN_GRANT_UNAVAILABLE');
    });
  } finally { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
});

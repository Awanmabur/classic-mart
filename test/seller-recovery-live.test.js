import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)?.[1];

test('Seller recovery uses current accepted store authority, independent reviews and verified typed billing', { skip: !uri, timeout: 240_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'classicmart-seller-recovery-'));
  process.env.UPLOAD_DIR = uploadDir;
  process.env.MEDIA_STORAGE_DRIVER = 'filesystem';
  let submissions = 0, unknownSubmission = true;
  const providerRecords = new Map();
  const provider = http.createServer(async (incoming, response) => {
    const url = new URL(incoming.url, 'http://127.0.0.1');
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname.endsWith('/Auth/RequestToken')) return response.end(JSON.stringify({ token: 'local-seller-test-token', expiryDate: new Date(Date.now() + 3600000).toISOString() }));
    if (url.pathname.endsWith('/Transactions/SubmitOrderRequest')) {
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const tracking = `seller_tracking_${suffix}_${++submissions}`;
      providerRecords.set(tracking, { payment_status_description: 'PENDING', merchant_reference: body.id, amount: body.amount, currency: body.currency, confirmation_code: tracking });
      if (unknownSubmission) { unknownSubmission = false; response.statusCode = 502; return response.end(JSON.stringify({ message: 'Local test simulates a response lost after provider acceptance.' })); }
      return response.end(JSON.stringify({ order_tracking_id: tracking, merchant_reference: body.id, redirect_url: 'https://127.0.0.1/checkout/' + tracking }));
    }
    if (url.pathname.endsWith('/Transactions/GetTransactionStatus')) return response.end(JSON.stringify(providerRecords.get(url.searchParams.get('orderTrackingId')) || {}));
    response.statusCode = 404; response.end('{}');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  process.env.PESAPAL_BASE_URL = `http://127.0.0.1:${provider.address().port}`;
  process.env.PESAPAL_CONSUMER_KEY = 'local-seller-test-key';
  process.env.PESAPAL_CONSUMER_SECRET = 'local-seller-test-secret';
  process.env.PESAPAL_IPN_ID = 'local-seller-test-ipn';
  await mongoose.connect(uri, { dbName: 'classicmart_seller_recovery_test_' + suffix });
  const models = await import('../src/models/index.js');
  const { User, Device, CountrySetting, PlatformGrant, Store, StoreMember, StoreTeamInvitation, SubscriptionPlan, SubscriptionChangeRequest, SubscriptionCharge, SubscriptionEnrollment, LedgerTransaction, Category, Product, ProductVariant, Campaign, CampaignApplication, PromoterVerification, PromoterLink, AttributionTouch, TrustCase, EvidenceDocument, AuditLog } = models;
  const team = await import('../src/services/seller-team-pages.js');
  const billing = await import('../src/services/seller-subscription-operations.js');
  const affiliate = await import('../src/services/seller-affiliate-pages.js');
  const { sellerEntitlements } = await import('../src/services/seller-entitlements.js');
  const { sellerOperationsAccess, sellerTransaction } = await import('../src/services/seller-operations-access.js');
  const { saveSellerStoreSettings } = await import('../src/services/seller-store-settings.js');
  const { sellerStoreReadAccess } = await import('../src/services/seller-store-read-access.js');
  const { sellerBusinessAccess } = await import('../src/services/seller-business-access.js');
  const { decideCountryAffiliateCampaign } = await import('../src/services/country-admin-growth-pages.js');
  const { secureApplyToCampaign, secureCreatePromoterLink } = await import('../src/services/promoter-campaign-pages.js');
  const { hashPassword, hashToken } = await import('../src/core/crypto.js');
  const { beginMfaEnrollment, confirmMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
  const { createApp } = await import('../src/app.js');
  const app = createApp(null), transports = [], password = 'Seller-' + suffix + '-A1!', passwordHash = await hashPassword(password);
  let sequence = 0;
  const id = prefix => `${prefix}_${suffix}_${++sequence}`;
  const revision = async (Model, row) => (await Model.findById(row._id)).__v || 0;
  async function actor(role = 'customer') {
    const publicId = id('usr'), email = publicId + '@example.com', phone = '+25670' + String(sequence).padStart(7, '0');
    let user = await User.create({ publicId, name: 'Seller recovery ' + sequence, email, emailNormalized: email, phone, phoneNormalized: phone, passwordHash, role, country: 'UG', currency: 'UGX', shoppingCountry: 'UG', emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), onboardingCompletedAt: new Date(), consents: { terms: true, privacy: true, recordedAt: new Date() } });
    const pending = await beginMfaEnrollment(user._id, password), enrolled = await confirmMfaEnrollment(user._id, totpCode(pending.secret)); user = enrolled.user;
    const sessionID = crypto.randomUUID(), device = await Device.create({ publicId: id('dev'), userId: user._id, sessionHash: hashToken(sessionID), label: 'Seller recovery fixture', userAgent: 'Seller recovery fixture', ipHash: hashToken('127.0.0.1'), lastSeenAt: new Date() });
    return { user, recovery: enrolled.codes[0], service: { user, device, sessionID, session: { userId: String(user._id), tokenVersion: user.security.tokenVersion, mfaVerifiedAt: Date.now() }, id: id('req'), get: () => 'Seller recovery fixture', ip: '127.0.0.1', country: { code: 'UG', currency: 'UGX' }, query: {}, body: {} } };
  }
  async function login(person) {
    const transport = new http.Agent({ localAddress: '127.0.0.' + (transports.length + 130), keepAlive: false }); transports.push(transport);
    const client = request.agent(app).use(req => req.agent(transport));
    const page = await client.get('/login').expect(200);
    const logged = await client.post('/login').type('form').send({ email: person.user.email, password, _csrf: csrf(page.text) }).expect(302);
    assert.equal(logged.headers.location, '/mfa');
    const mfa = await client.get('/mfa').expect(200); await client.post('/mfa').type('form').send({ code: person.recovery, _csrf: csrf(mfa.text) }).expect(302);
    const account = await client.get('/account/store-invitations').expect(200);
    return { client, token: csrf(account.text) };
  }
  async function staff(person, role) {
    await User.updateOne({ _id: person.user._id }, { $set: { platformAccessManagedAt: new Date() } });
    return PlatformGrant.create({ publicId: id('grant'), userId: person.user._id, role, operationalCountries: role === 'super_admin' ? ['*'] : ['UG'], startsAt: new Date(Date.now() - 60000), expiresAt: new Date(Date.now() + 86400000), reason: 'Independent Seller recovery reviewer fixture.', approvalPublicId: id('approval'), approvedByUserId: owner.user._id });
  }
  let owner, recipient, administrator, outsider, promoter, countryAdmin, superAdmin, store, foreignStore, product, category, charge, ownerHttp, recipientHttp, adminHttp;
  try {
    for (const Model of [User, Device, CountrySetting, PlatformGrant, Store, StoreMember, StoreTeamInvitation, SubscriptionPlan, SubscriptionChangeRequest, SubscriptionCharge, SubscriptionEnrollment, LedgerTransaction, Category, Product, ProductVariant, Campaign, CampaignApplication, PromoterVerification, PromoterLink, AttributionTouch, TrustCase, EvidenceDocument]) await Model.init();
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', returnWindowDays: 14, platformFeeBps: 700, taxBps: 1800, policyVersion: 'seller-recovery-v1' });
    owner = await actor('seller'); recipient = await actor(); administrator = await actor(); outsider = await actor('seller'); promoter = await actor('promoter'); countryAdmin = await actor('country_admin'); superAdmin = await actor('super_admin');
    await staff(countryAdmin, 'country_admin'); await staff(superAdmin, 'super_admin');
    store = await Store.create({ publicId: id('str'), ownerUserId: owner.user._id, name: 'Scoped Seller recovery store', slug: id('store'), country: 'UG', currency: 'UGX', status: 'verified', verifiedAt: new Date() });
    foreignStore = await Store.create({ publicId: id('str'), ownerUserId: outsider.user._id, name: 'Other Seller private store', slug: id('other'), country: 'UG', currency: 'UGX', status: 'verified', verifiedAt: new Date() });
    for (const [person, row] of [[owner, store], [outsider, foreignStore]]) { await StoreMember.create({ publicId: id('stm'), storeId: row._id, userId: person.user._id, role: 'owner', status: 'active', acceptedAt: new Date(), invitedByUserId: person.user._id }); person.service.store = row; person.service.session.activeStorePublicId = row.publicId; }
    category = await Category.create({ publicId: id('cat'), name: 'Seller recovery products', slug: id('category'), countries: ['UG'], active: true });
    const catalogue = Array.from({ length: 50 }, (_, index) => ({ publicId: id('prd'), storeId: store._id, ownerUserId: owner.user._id, categoryId: category._id, title: 'Recorded product ' + index, slug: id('product'), description: 'Real persisted Seller recovery catalogue product.', countries: ['UG'], status: index === 0 ? 'published' : 'draft' }));
    const products = await Product.insertMany(catalogue); product = products[0];
    await ProductVariant.create({ publicId: id('var'), productId: product._id, storeId: store._id, sku: id('SKU').toUpperCase(), title: 'Published exact offer', priceMinor: 1000, currency: 'UGX', active: true });
    ownerHttp = await login(owner); recipientHttp = await login(recipient); adminHttp = await login(administrator);

    await t.test('team, affiliate and billing pages render their real forms in the approved private Seller shell', async () => {
      for (const [href, form] of [['/seller/team', 'Invite a team member'], ['/seller/affiliate', 'Create campaign'], ['/seller/subscription', 'Payment and renewal']]) {
        const page = await ownerHttp.client.get(href).expect(200);
        assert.match(page.text, /data-dashboard-workspace="seller"/); assert.ok(page.text.includes(form));
        assert.match(page.headers['cache-control'], /no-store/); assert.match(page.headers['x-robots-tag'], /noindex/);
      }
    });

    await t.test('reviewed frozen terms require exact verified provider money and an unknown submission cannot charge twice', async () => {
      await ownerHttp.client.post('/seller/team/invitations').set('Accept', 'application/json').send({ email: recipient.user.email, role: 'finance', _csrf: ownerHttp.token }).expect(409);
      await ownerHttp.client.get('/seller/analytics/summary.csv').set('Accept', 'application/json').expect(403);
      await ownerHttp.client.post('/seller/products').set('Accept', 'application/json').send({ _csrf: ownerHttp.token }).expect(409);
      const plan = await SubscriptionPlan.create({ publicId: id('spl'), key: id('seller-plan'), name: 'Reviewed Seller capacity', audience: 'seller', country: 'UG', currency: 'UGX', priceMinor: 2500, cadence: 'monthly', status: 'active', entitlements: { productLimit: 51, seatLimit: 4, campaignLimit: 2, analyticsDays: 3660, analyticsExport: true }, createdByUserId: superAdmin.user._id, updatedByUserId: superAdmin.user._id });
      await ownerHttp.client.post('/seller/subscription/requests').type('form').send({ planPublicId: plan.publicId, note: 'Review the actual fixed terms.', _csrf: ownerHttp.token }).expect(302);
      let change = await SubscriptionChangeRequest.findOne({ storeId: store._id, status: 'requested' });
      await assert.rejects(billing.startSellerSubscriptionPayment(owner.service, { requestPublicId: change.publicId, version: change.__v, idempotencyKey: id('payment') }), error => error.code === 'SUBSCRIPTION_APPROVAL_REQUIRED');
      await sellerTransaction(session => billing.reviewSellerSubscriptionRequest(superAdmin.service, change.publicId, { version: change.__v, decision: 'approve', reason: 'Independently verified capacity and billing terms.' }, { session }));
      change = await SubscriptionChangeRequest.findById(change._id);
      const originalTerms = change.approvedTerms.toObject(); change.approvedTerms.entitlements.seatLimit = 999;
      await assert.rejects(change.save(), error => error.code === 'SUBSCRIPTION_TERMS_IMMUTABLE');
      await SubscriptionPlan.updateOne({ _id: plan._id }, { $set: { priceMinor: 9999, 'entitlements.seatLimit': 99 }, $inc: { __v: 1 } });
      change = await SubscriptionChangeRequest.findById(change._id); const paymentKey = id('payment');
      await ownerHttp.client.post('/seller/subscription/payments').set('Accept', 'application/json').send({ requestPublicId: change.publicId, version: change.__v, idempotencyKey: paymentKey, _csrf: ownerHttp.token }).expect(502);
      charge = await SubscriptionCharge.findOne({ storeId: store._id }); assert.equal(charge.status, 'held'); assert.equal(charge.amountMinor, 2500); assert.deepEqual(charge.terms.toObject(), originalTerms);
      await ownerHttp.client.post('/seller/subscription/payments').set('Accept', 'application/json').send({ requestPublicId: change.publicId, version: change.__v, idempotencyKey: paymentKey, _csrf: ownerHttp.token }).expect(200);
      await ownerHttp.client.post('/seller/subscription/payments').set('Accept', 'application/json').send({ requestPublicId: change.publicId, version: await revision(SubscriptionChangeRequest, change), idempotencyKey: id('payment'), _csrf: ownerHttp.token }).expect(409);
      assert.equal(submissions, 1); assert.equal(await SubscriptionEnrollment.countDocuments({ storeId: store._id }), 0);
      const [tracking, data] = [...providerRecords][0]; data.payment_status_description = 'COMPLETED'; data.amount = 2501;
      await assert.rejects(billing.verifySellerSubscriptionPayment(charge.publicId, tracking), error => error.code === 'SUBSCRIPTION_VERIFICATION_MISMATCH');
      assert.equal(await LedgerTransaction.countDocuments({ referencePublicId: charge.publicId }), 0); data.amount = 2500;
      const callback = '/seller/subscription/return?OrderMerchantReference=' + charge.providerReference + '&OrderTrackingId=' + tracking;
      await request(app).get(callback).expect(302); await request(app).get(callback).expect(302);
      charge = await SubscriptionCharge.findById(charge._id); assert.equal(charge.status, 'succeeded');
      assert.equal(await SubscriptionEnrollment.countDocuments({ subscriptionChargeId: charge._id }), 1); assert.equal(await LedgerTransaction.countDocuments({ referencePublicId: charge.publicId, referenceType: 'subscription_payment' }), 1);
      assert.deepEqual(await sellerEntitlements(store), originalTerms.entitlements);
      await ownerHttp.client.get('/seller/analytics?period=7months').set('Accept', 'application/json').expect(200);
      await ownerHttp.client.get('/seller/overview/summary.csv?period=7months').expect(200);
      const created = await ownerHttp.client.post('/seller/products').type('form').send({ title: 'Paid capacity product', description: 'This real product consumes the approved paid product allowance.', categoryPublicId: category.publicId, variantTitle: 'New exact SKU', sku: id('SKU').toUpperCase(), price: '1000', _csrf: ownerHttp.token }).expect(302);
      assert.match(created.headers.location, /^\/seller\/products\/prd_/); assert.equal(await Product.countDocuments({ storeId: store._id }), 51);
      await ownerHttp.client.post('/seller/products').set('Accept', 'application/json').send({ _csrf: ownerHttp.token }).expect(409);
      await SubscriptionEnrollment.create({ publicId: id('sen'), planId: plan._id, planPublicId: plan.publicId, audience: 'seller', userId: outsider.user._id, storeId: foreignStore._id, storePublicId: foreignStore.publicId, country: 'UG', currency: 'UGX', priceMinor: 0, terms: { ...originalTerms, priceMinor: 0 }, startsAt: new Date(Date.now() - 1000), currentPeriodEndsAt: new Date(Date.now() + 86400000) });
      assert.equal((await sellerEntitlements(foreignStore)).seatLimit, 1, 'a fabricated enrollment with no settled linked charge grants no typed benefits');
    });

    await t.test('an explicit renewal buys one future immutable period and cannot stack another pending renewal', async () => {
      const change = await SubscriptionChangeRequest.findOne({ storeId: store._id, status: 'approved' });
      const started = await ownerHttp.client.post('/seller/subscription/payments').set('Accept', 'application/json').send({ requestPublicId: change.publicId, version: change.__v, idempotencyKey: id('renewal'), _csrf: ownerHttp.token }).expect(200);
      assert.equal(started.body.charge.amountMinor, 2500, 'renewal retains the reviewed price after the catalogue was edited');
      const renewal = await SubscriptionCharge.findOne({ publicId: started.body.charge.publicId });
      providerRecords.get(renewal.providerTrackingId).payment_status_description = 'COMPLETED';
      await billing.verifySellerSubscriptionPayment(renewal.publicId, renewal.providerTrackingId);
      const firstPeriod = await SubscriptionEnrollment.findById(charge.enrollmentId), nextPeriod = await SubscriptionEnrollment.findOne({ subscriptionChargeId: renewal._id });
      assert.equal(nextPeriod.startsAt.getTime(), firstPeriod.currentPeriodEndsAt.getTime()); assert.ok(nextPeriod.currentPeriodEndsAt > nextPeriod.startsAt);
      await assert.rejects(billing.startSellerSubscriptionPayment(owner.service, { requestPublicId: change.publicId, version: await revision(SubscriptionChangeRequest, change), idempotencyKey: id('third-period') }), error => error.code === 'SUBSCRIPTION_RENEWAL_ALREADY_PAID');
      assert.equal(submissions, 2);
    });

    await t.test('verified exact recipients accept atomically, keep their identity role and explicitly select a workspace', async () => {
      const invited = await ownerHttp.client.post('/seller/team/invitations').set('Accept', 'application/json').send({ email: recipient.user.email, role: 'finance', _csrf: ownerHttp.token }).expect(200);
      const invitation = await StoreTeamInvitation.findOne({ publicId: invited.body.publicId });
      assert.equal(await StoreMember.countDocuments({ storeId: store._id, userId: recipient.user._id }), 0);
      await assert.rejects(team.decideStoreTeamInvitation(outsider.service, invitation.publicId, { decision: 'accept', version: invitation.__v }), error => error.code === 'STORE_INVITATION_NOT_FOUND');
      await User.updateOne({ _id: recipient.user._id }, { $unset: { emailVerifiedAt: 1 }, $inc: { __v: 1 } });
      await recipientHttp.client.post('/account/store-invitations/' + invitation.publicId + '/accept').set('Accept', 'application/json').send({ version: invitation.__v, _csrf: recipientHttp.token }).expect(403);
      await User.updateOne({ _id: recipient.user._id }, { $set: { emailVerifiedAt: new Date() }, $inc: { __v: 1 } });
      await recipientHttp.client.post('/account/store-invitations/' + invitation.publicId + '/accept').set('Accept', 'application/json').send({ version: invitation.__v + 1, _csrf: recipientHttp.token }).expect(409);
      const accepted = await Promise.all([1, 2].map(() => recipientHttp.client.post('/account/store-invitations/' + invitation.publicId + '/accept').set('Accept', 'application/json').send({ version: invitation.__v, _csrf: recipientHttp.token })));
      assert.deepEqual(accepted.map(row => row.status).sort(), [200, 409]);
      assert.equal(await StoreMember.countDocuments({ storeId: store._id, userId: recipient.user._id, status: 'active' }), 1); assert.equal((await User.findById(recipient.user._id)).role, 'customer');
      await recipientHttp.client.get('/seller/team').set('Accept', 'application/json').expect(403);
      const workspace = await recipientHttp.client.post('/seller/workspace').set('Accept', 'application/json').send({ storePublicId: store.publicId, _csrf: recipientHttp.token }).expect(200);
      assert.equal(workspace.body.landing, '/seller/earnings'); await recipientHttp.client.get('/seller/earnings').expect(200); await recipientHttp.client.get('/seller/team').set('Accept', 'application/json').expect(403);
      const adminInvite = await team.inviteStoreTeamMember(owner.service, { email: administrator.user.email, role: 'admin' });
      await adminHttp.client.post('/account/store-invitations/' + adminInvite.publicId + '/accept').set('Accept', 'application/json').send({ version: adminInvite.version, _csrf: adminHttp.token }).expect(200);
      await adminHttp.client.post('/seller/workspace').set('Accept', 'application/json').send({ storePublicId: store.publicId, _csrf: adminHttp.token }).expect(200);
      administrator.service.store = store;
      const seats = await Promise.all([1, 2].map(index => ownerHttp.client.post('/seller/team/invitations').set('Accept', 'application/json').send({ email: `last-seat-${index}-${suffix}@example.com`, role: 'support', _csrf: ownerHttp.token })));
      assert.deepEqual(seats.map(row => row.status).sort(), [200, 409], 'concurrent invitations cannot reserve the last paid seat twice');
      const reserved = seats.find(row => row.status === 200).body;
      await team.revokeStoreTeamInvitation(owner.service, reserved.publicId, { version: reserved.version });
      await assert.rejects(team.inviteStoreTeamMember(administrator.service, { email: outsider.user.email, role: 'admin' }), error => error.code === 'STORE_OWNER_REQUIRED');
      const ownerMember = await StoreMember.findOne({ storeId: store._id, role: 'owner' });
      await assert.rejects(team.updateStoreTeamMember(administrator.service, ownerMember.publicId, { action: 'revoke', version: ownerMember.__v }), error => error.code === 'STORE_OWNER_PROTECTED');
      const pending = await team.inviteStoreTeamMember(administrator.service, { email: outsider.user.email, role: 'support' });
      let adminMember = await StoreMember.findOne({ storeId: store._id, userId: administrator.user._id });
      await team.updateStoreTeamMember(owner.service, adminMember.publicId, { action: 'role', role: 'support', version: adminMember.__v });
      assert.equal((await StoreTeamInvitation.findOne({ publicId: pending.publicId })).status, 'revoked');
      assert.equal(await team.prepareStoreTeamInvitationDelivery({ aggregatePublicId: pending.publicId, payload: { country: 'UG' } }), null);
      await assert.rejects(team.decideStoreTeamInvitation(outsider.service, pending.publicId, { decision: 'accept', version: 0 }), error => ['SELLER_VERSION_CONFLICT', 'STORE_INVITATION_EXPIRED'].includes(error.code));
      await Device.updateOne({ _id: recipient.service.device._id }, { $set: { revokedAt: new Date() } }); recipient.service.store = store;
      await assert.rejects(sellerOperationsAccess(recipient.service, 'finance'), error => error.code === 'ACCOUNT_UNAVAILABLE');
      adminMember = await StoreMember.findById(adminMember._id);
      await team.updateStoreTeamMember(owner.service, adminMember.publicId, { action: 'role', role: 'admin', version: adminMember.__v });
      const tokenInvite = await team.inviteStoreTeamMember(administrator.service, { email: outsider.user.email, role: 'support' });
      await User.updateOne({ _id: administrator.user._id }, { $inc: { 'security.tokenVersion': 1 } });
      assert.equal(await team.prepareStoreTeamInvitationDelivery({ aggregatePublicId: tokenInvite.publicId, payload: { country: 'UG' } }), null);
      await assert.rejects(team.decideStoreTeamInvitation(outsider.service, tokenInvite.publicId, { decision: 'accept', version: tokenInvite.version }), error => error.code === 'STORE_INVITATION_UNAVAILABLE');
      const pendingRow = await StoreTeamInvitation.findOne({ publicId: tokenInvite.publicId }); await team.revokeStoreTeamInvitation(owner.service, pendingRow.publicId, { version: pendingRow.__v });
    });

    await t.test('public Seller campaigns still need independent Country Admin and Seller application decisions before real attributed links', async () => {
      const draft = await ownerHttp.client.post('/seller/affiliate/campaigns').set('Accept', 'application/json').send({ name: 'Reviewed affiliate campaign', visibility: 'public', commissionBps: 500, attributionDays: 30, productPublicIds: [product.publicId], facts: ['Actual published product from this store.'], allowedChannels: ['website'], disclosureText: 'I may earn a commission on this purchase.', _csrf: ownerHttp.token }).expect(200);
      const campaignId = draft.body.publicId;
      await ownerHttp.client.post('/seller/affiliate/campaigns/' + campaignId).set('Accept', 'application/json').send({ action: 'submit', version: draft.body.version, _csrf: ownerHttp.token }).expect(200);
      let campaign = await Campaign.findOne({ publicId: campaignId });
      await StoreMember.create({ publicId: id('stm'), storeId: store._id, userId: countryAdmin.user._id, role: 'support', status: 'active', invitedByUserId: owner.user._id, acceptedAt: new Date() });
      await assert.rejects(decideCountryAffiliateCampaign(countryAdmin.service, campaignId, { country: 'UG', status: 'active', version: campaign.__v, reason: 'Must reject a reviewer with this store membership.' }), error => error.code === 'CAMPAIGN_REVIEW_CONFLICT');
      await StoreMember.updateOne({ storeId: store._id, userId: countryAdmin.user._id }, { $set: { status: 'revoked' } });
      await decideCountryAffiliateCampaign(countryAdmin.service, campaignId, { country: 'UG', status: 'active', version: campaign.__v, reason: 'Independently reviewed factual claims and products.' });
      await PromoterVerification.create({ publicId: id('pvf'), userId: promoter.user._id, country: 'UG', status: 'verified', channels: ['website'], niches: ['products'], disclosureAcceptedAt: new Date(), reviewedAt: new Date(), reviewedByUserId: countryAdmin.user._id });
      const application = await secureApplyToCampaign(promoter.service, campaignId, 'Please review my independent website promotion.');
      assert.equal(application.status, 'pending');
      await assert.rejects(secureCreatePromoterLink(promoter.service, { campaignId, destination: '/products/' + product.publicId, channel: 'website' }), error => error.code === 'CAMPAIGN_APPROVAL_REQUIRED');
      await ownerHttp.client.post('/seller/affiliate/applications/' + application.publicId).set('Accept', 'application/json').send({ decision: 'approve', reason: 'Verified independent promoter and suitable website.', version: application.__v, _csrf: ownerHttp.token }).expect(200);
      const link = await secureCreatePromoterLink(promoter.service, { campaignId, destination: '/products/' + product.publicId, channel: 'website' });
      const visit = await request(app).get('/r/' + link.token).set('User-Agent', 'Seller recovery customer browser').expect(302); assert.match(visit.headers.location, new RegExp('^/products/' + product.publicId));
      assert.equal(await AttributionTouch.countDocuments({ linkId: link._id, status: 'valid', country: 'UG' }), 1);
      campaign = await Campaign.findOne({ publicId: campaignId }); await affiliate.transitionSellerAffiliateCampaign(owner.service, campaignId, { action: 'pause', version: campaign.__v });
      await request(app).get('/r/' + link.token).set('Accept', 'application/json').expect(410);
      campaign = await Campaign.findOne({ publicId: campaignId }); await affiliate.transitionSellerAffiliateCampaign(owner.service, campaignId, { action: 'resume', version: campaign.__v });
      const currentApplication = await CampaignApplication.findById(application._id); await affiliate.decideSellerAffiliateApplication(owner.service, application.publicId, { decision: 'revoke', reason: 'Promotion agreement ended.', version: currentApplication.__v });
      assert.equal((await PromoterLink.findById(link._id)).active, false); await request(app).get('/r/' + link.token).set('Accept', 'application/json').expect(404);
    });

    await t.test('suspended stores retain private policy responses, sanitized evidence and one independent appeal while commerce remains blocked', async () => {
      const row = await TrustCase.create({ publicId: id('trc'), reporterUserId: recipient.user._id, country: 'UG', type: 'seller_conduct', storeId: store._id, storePublicId: store.publicId, description: 'The actual policy concern that the Seller must be able to read.', status: 'open' });
      const foreignCase = await TrustCase.create({ publicId: id('trc'), reporterUserId: owner.user._id, country: 'UG', type: 'seller_conduct', storeId: foreignStore._id, storePublicId: foreignStore.publicId, description: 'Other Seller confidential policy concern.' });
      await Store.updateOne({ _id: store._id }, { $set: { status: 'suspended' }, $inc: { __v: 1 } });
      const page = await ownerHttp.client.get('/seller/trust-cases?record=' + row.publicId).expect(200); assert.match(page.text, /actual policy concern/); assert.match(page.headers['cache-control'], /no-store/); assert.match(page.headers['x-robots-tag'], /noindex/);
      const projection = await ownerHttp.client.get('/seller/trust-cases?record=' + row.publicId).set('Accept', 'application/json').expect(200); assert.equal(projection.body.selected.description, row.description); assert.equal(JSON.stringify(projection.body).includes(String(recipient.user._id)), false); assert.equal(JSON.stringify(projection.body).includes(foreignCase.publicId), false);
      await ownerHttp.client.get('/seller/trust-cases?record=' + foreignCase.publicId).set('Accept', 'application/json').expect(404);
      await ownerHttp.client.post('/seller/affiliate/campaigns').set('Accept', 'application/json').send({ _csrf: ownerHttp.token }).expect(409);
      await ownerHttp.client.post('/seller/products').set('Accept', 'application/json').send({ _csrf: ownerHttp.token }).expect(409);
      await ownerHttp.client.post('/seller/trust-cases/' + row.publicId + '/respond').set('Accept', 'application/json').send({ version: row.__v, action: 'correction', message: 'We corrected the concern and retained the supporting record.', _csrf: ownerHttp.token }).expect(200);
      const sharp = (await import('sharp')).default, image = await sharp({ create: { width: 320, height: 320, channels: 3, background: '#abc' } }).png().toBuffer();
      await ownerHttp.client.post('/seller/trust-cases/' + row.publicId + '/evidence').field('_csrf', ownerHttp.token).field('version', String(await revision(TrustCase, row))).field('description', 'Private correction evidence.').attach('document', image, { filename: 'correction.png', contentType: 'image/png' }).expect(302);
      const evidence = await EvidenceDocument.findOne({ contextPublicId: row.publicId, documentType: 'seller_policy_response' }); assert.ok(evidence);
      const privateImage = await ownerHttp.client.get('/seller/trust-cases/evidence/' + evidence.publicId).expect(200); assert.match(privateImage.headers['content-type'], /image\/webp/); assert.match(privateImage.headers['cache-control'], /no-store/);
      const outsiderHttp = await login(outsider); await outsiderHttp.client.get('/seller/trust-cases/evidence/' + evidence.publicId).set('Accept', 'application/json').expect(404);
      await TrustCase.updateOne({ _id: row._id }, { $set: { status: 'actioned', decision: 'Original independently recorded decision.', decisionByUserId: countryAdmin.user._id, decisionAt: new Date() }, $inc: { __v: 1 } });
      await ownerHttp.client.post('/seller/trust-cases/' + row.publicId + '/respond').set('Accept', 'application/json').send({ version: await revision(TrustCase, row), action: 'appeal', message: 'Please independently review the correction evidence and recorded decision.', _csrf: ownerHttp.token }).expect(200);
      const appealed = await TrustCase.findById(row._id); assert.equal(appealed.status, 'appealed'); assert.equal(appealed.sellerAppealCount, 1); assert.equal(String(appealed.appealOriginalDecisionByUserId), String(countryAdmin.user._id)); assert.equal(appealed.assignedUserId, undefined);
      await ownerHttp.client.post('/seller/trust-cases/' + row.publicId + '/respond').set('Accept', 'application/json').send({ version: appealed.__v, action: 'appeal', message: 'A repeated appeal must not create another review.', _csrf: ownerHttp.token }).expect(409);
      await Store.updateOne({ _id: store._id }, { $set: { status: 'verified' }, $inc: { __v: 1 } });
    });

    await t.test('cancellation, expiry and provider reversal remove paid capacities without duplicate ledger entries', async () => {
      let enrollment = await SubscriptionEnrollment.findById(charge.enrollmentId);
      await ownerHttp.client.post('/seller/subscription/enrollments/' + enrollment.publicId + '/cancel').set('Accept', 'application/json').send({ version: enrollment.__v, _csrf: ownerHttp.token }).expect(200);
      assert.equal((await sellerEntitlements(store)).seatLimit, 4, 'paid benefits remain through cancellation period end');
      await SubscriptionEnrollment.updateOne({ _id: enrollment._id }, { $set: { currentPeriodEndsAt: new Date(Date.now() - 1000) }, $inc: { __v: 1 } });
      await billing.sellerSubscriptionMaintenance({ limit: 1 }); enrollment = await SubscriptionEnrollment.findById(enrollment._id); assert.equal(enrollment.status, 'cancelled');
      assert.equal((await sellerEntitlements(store)).seatLimit, 1); await ownerHttp.client.get('/seller/analytics/summary.csv').set('Accept', 'application/json').expect(403);
      await ownerHttp.client.get('/seller/overview?period=7months').set('Accept', 'application/json').expect(403);
      await ownerHttp.client.post('/seller/products').set('Accept', 'application/json').send({ _csrf: ownerHttp.token }).expect(409);
      const [tracking, data] = [...providerRecords][0]; data.payment_status_description = 'REVERSED';
      await billing.verifySellerSubscriptionPayment(charge.publicId, tracking); await billing.verifySellerSubscriptionPayment(charge.publicId, tracking);
      assert.equal((await SubscriptionCharge.findById(charge._id)).status, 'reversed'); assert.equal(await LedgerTransaction.countDocuments({ referencePublicId: charge.publicId, referenceType: 'subscription_reversal' }), 1);
      assert.equal((await sellerEntitlements(store)).analyticsExport, false);
    });

    await t.test('settings and supplier access recheck accepted staff, current devices, ownership and market without stale writes', async () => {
      const settingsOwner = await actor('seller'), settingsAdmin = await actor();
      const settingsStore = await Store.create({ publicId: id('str'), ownerUserId: settingsOwner.user._id, name: 'Settings authority store', slug: id('settings-store'), country: 'UG', currency: 'UGX', status: 'verified' });
      await StoreMember.create({ publicId: id('stm'), storeId: settingsStore._id, userId: settingsOwner.user._id, role: 'owner', status: 'active', acceptedAt: new Date(), invitedByUserId: settingsOwner.user._id });
      const membership = await StoreMember.create({ publicId: id('stm'), storeId: settingsStore._id, userId: settingsAdmin.user._id, role: 'admin', status: 'active', acceptedAt: new Date(), invitedByUserId: settingsOwner.user._id });
      settingsAdmin.service.store = settingsStore; settingsAdmin.service.session.activeStorePublicId = settingsStore.publicId;
      settingsAdmin.service.body = { version: settingsStore.__v, name: 'Current administrator saved this', description: 'Authorized settings update.', supportEmail: 'HELP@example.com', supportPhoneCountry: 'UG', supportPhone: '+256781977217' };
      const saved = await saveSellerStoreSettings(settingsAdmin.service, 'identity');
      assert.equal(saved.__v, settingsStore.__v + 1); assert.equal(saved.operations.supportEmail, 'help@example.com');
      assert.equal(await AuditLog.countDocuments({ targetPublicId: saved.publicId, action: 'seller.store_settings_updated' }), 1);
      const snapshot = async () => ({ store: await Store.collection.findOne({ _id: settingsStore._id }), audits: await AuditLog.countDocuments({ targetPublicId: settingsStore.publicId }) });
      async function denied(code) {
        const before = await snapshot();
        await assert.rejects(saveSellerStoreSettings(settingsAdmin.service, 'identity'), error => error.code === code);
        assert.deepEqual(await snapshot(), before, 'a denied write rolls back Store and audit effects');
      }
      await denied('STORE_VERSION_CONFLICT'); settingsAdmin.service.body.version = saved.__v;
      await StoreMember.updateOne({ _id: membership._id }, { $unset: { acceptedAt: 1 }, $inc: { __v: 1 } });
      await denied('STORE_PERMISSION_DENIED'); await assert.rejects(sellerStoreReadAccess(settingsAdmin.service), error => error.code === 'STORE_PERMISSION_DENIED');
      await StoreMember.updateOne({ _id: membership._id }, { $set: { acceptedAt: new Date() }, $inc: { __v: 1 } });
      await Device.updateOne({ _id: settingsAdmin.service.device._id }, { $set: { revokedAt: new Date() }, $inc: { __v: 1 } });
      await denied('ACCOUNT_UNAVAILABLE'); await assert.rejects(sellerStoreReadAccess(settingsAdmin.service), error => error.code === 'ACCOUNT_UNAVAILABLE');
      await Device.updateOne({ _id: settingsAdmin.service.device._id }, { $unset: { revokedAt: 1 }, $inc: { __v: 1 } });
      await User.updateOne({ _id: settingsOwner.user._id }, { $set: { status: 'suspended' }, $inc: { __v: 1 } });
      await denied('STORE_PERMISSION_DENIED'); await assert.rejects(sellerBusinessAccess(settingsAdmin.service), error => error.code === 'SELLER_BUSINESS_FORBIDDEN');
      await User.updateOne({ _id: settingsOwner.user._id }, { $set: { status: 'active' }, $inc: { __v: 1 } });
      await User.updateOne({ _id: settingsOwner.user._id }, { $set: { platformAccessManagedAt: new Date() }, $inc: { __v: 1 } });
      await denied('STORE_PERMISSION_DENIED'); await assert.rejects(sellerStoreReadAccess(settingsAdmin.service), error => error.code === 'STORE_PERMISSION_DENIED');
      await User.updateOne({ _id: settingsOwner.user._id }, { $unset: { platformAccessManagedAt: 1 }, $inc: { __v: 1 } });
      await CountrySetting.updateOne({ code: 'UG' }, { $set: { active: false }, $inc: { __v: 1 } });
      await denied('STORE_MARKET_UNAVAILABLE'); await assert.rejects(sellerStoreReadAccess(settingsAdmin.service), error => error.code === 'STORE_MARKET_UNAVAILABLE');
      await CountrySetting.updateOne({ code: 'UG' }, { $set: { active: true }, $inc: { __v: 1 } });
      const unselected = { ...settingsAdmin.service, store: undefined, session: { ...settingsAdmin.service.session } }; delete unselected.session.activeStorePublicId;
      await assert.rejects(sellerBusinessAccess(unselected), error => error.code === 'SELLER_WORKSPACE_REQUIRED');
      assert.equal((await sellerBusinessAccess(settingsAdmin.service)).store.publicId, settingsStore.publicId);
      const initial = await snapshot();
      t.mock.method(AuditLog, 'create', async () => { throw new Error('Settings audit unavailable'); });
      try { await assert.rejects(saveSellerStoreSettings(settingsAdmin.service, 'identity'), /Settings audit unavailable/); }
      finally { t.mock.restoreAll(); }
      assert.deepEqual(await snapshot(), initial, 'an audit failure rolls back the shared authority fence and settings mutation');
    });
  } finally {
    t.mock.restoreAll();
    for (const transport of transports) transport.destroy();
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
    await new Promise(resolve => provider.close(resolve));
    await fs.rm(uploadDir, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
for (const name of ['SESSION_SECRET', 'TOKEN_PEPPER', 'SECURITY_INTEGRITY_KEY', 'DATA_ENCRYPTION_KEY']) process.env[name] = crypto.randomBytes(32).toString('hex');
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('payout amounts are converted exactly for the store currency', async () => {
  const { sellerPayoutAmount } = await import('../src/services/seller-finance-pages.js');
  assert.equal(sellerPayoutAmount('12.34', 'KES'), 1234);
  assert.equal(sellerPayoutAmount('2000', 'UGX'), 2000);
  assert.equal(sellerPayoutAmount('1.234', 'KWD'), 1234);
  for (const [value, currency] of [['12.345', 'KES'], ['1.1', 'UGX'], ['0', 'KES'], ['1e3', 'KES'], ['-1', 'KES'], ['2000000001', 'UGX'], ['9007199254740993', 'UGX']]) {
    assert.throws(() => sellerPayoutAmount(value, currency), error => error.code === 'PAYOUT_AMOUNT_INVALID');
  }
});

test('seller finance pages enforce identity, store scope, truthful ledger balances and payout reservations', { skip: !uri, timeout: 120_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: `classicmart_seller_finance_pages_test_${suffix}` });
  const { createApp } = await import('../src/app.js');
  const models = await import('../src/models/index.js');
  const { User, Store, StoreMember, CountrySetting, PayoutAccount, Payout, Refund, SellerOrder, Order, PaymentIntent, Device, PlatformGrant, SubscriptionPlan, SubscriptionChangeRequest, SubscriptionCharge, SubscriptionEnrollment } = models;
  const { hashPassword, hashToken } = await import('../src/core/crypto.js');
  const { beginMfaEnrollment, confirmMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
  const { ensureLedgerAccount, postLedgerTransaction } = await import('../src/services/money.js');
  const { requestPayout } = await import('../src/services/payments.js');
  const { loadSellerFinancePage, createSellerPayoutDestination, requestSellerPayout } = await import('../src/services/seller-finance-pages.js');
  const app = createApp(null), password = `Finance-${suffix}-A1!`, passwordHash = await hashPassword(password), transports = [];
  let sequence = 0;
  async function actor(role = 'seller', enrolled = true) {
    const index = ++sequence, email = `finance-${suffix}-${index}@example.com`, phone = `+25670${String(index).padStart(7, '0')}`;
    let user = await User.create({ publicId: `usr_finance_${suffix}_${index}`, name: `Finance Actor ${index}`, email, emailNormalized: email,
      phone, phoneNormalized: phone, passwordHash, role, country: 'UG', currency: 'UGX', locale: 'en-UG', emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(),
      onboardingCompletedAt: new Date(), consents: { terms: true, privacy: true, recordedAt: new Date() } });
    let recovery;
    if (enrolled) {
      const enrollment = await beginMfaEnrollment(user._id, password);
      const confirmed = await confirmMfaEnrollment(user._id, totpCode(enrollment.secret));
      user = confirmed.user; recovery = confirmed.codes[0];
    }
    const transport = new http.Agent({ localAddress: `127.0.0.${index + 2}`, keepAlive: false });
    transports.push(transport);
    const client = request.agent(app).use(req => req.agent(transport));
    const login = await client.get('/login').expect(200);
    const loggedIn = await client.post('/login').type('form').send({ email, password, _csrf: csrf(login.text) }).expect(302);
    if (recovery) {
      assert.equal(loggedIn.headers.location, '/mfa');
      const mfa = await client.get('/mfa').expect(200);
      await client.post('/mfa').type('form').send({ code: recovery, _csrf: csrf(mfa.text) }).expect(302);
    }
    user = await User.findById(user._id);
    const serviceSessionID = crypto.randomUUID();
    const serviceDevice = await Device.create({ publicId: `dev_context_${suffix}_${index}`, userId: user._id, sessionHash: hashToken(serviceSessionID), label: 'Current Seller fixture device', userAgent: 'Seller regression', ipHash: hashToken('127.0.0.1'), lastSeenAt: new Date() });
    return { user, client, serviceSessionID, serviceDevice };
  }
  const scoped = (actor, store) => ({ id: crypto.randomUUID(), user: actor.user, store, device: actor.serviceDevice, sessionID: actor.serviceSessionID, country: { code: store.country, currency: store.currency }, ip: '127.0.0.1', get: () => '', session: { userId: String(actor.user._id), tokenVersion: actor.user.security.tokenVersion, activeStorePublicId: store.publicId, ...(actor.user.security.mfaEnabled ? { mfaVerifiedAt: Date.now() } : {}) } });
  async function selectStore(identity, selectedStore) {
    const security = await identity.client.get('/account/security').expect(200);
    await identity.client.post('/seller/workspace').set('accept', 'application/json').type('form')
      .send({ storePublicId: selectedStore.publicId, _csrf: csrf(security.text) }).expect(200);
  }
  try {
    await Promise.all(Object.values(models).filter(model => typeof model?.init === 'function').map(model => model.init()));
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256' });
    const owner = await actor(), foreignOwner = await actor(), buyer = await actor('customer'), unenrolled = await actor('customer', false);
    await owner.client.get('/seller/earnings').expect(200);
    await foreignOwner.client.get('/seller/earnings').expect(200);
    const store = await Store.findOne({ ownerUserId: owner.user._id }), foreign = await Store.findOne({ ownerUserId: foreignOwner.user._id });
    const billing = await import('../src/services/seller-subscription-operations.js');
    const { sellerTransaction } = await import('../src/services/seller-operations-access.js');
    const reviewer = await actor('super_admin');
    await User.updateOne({ _id: reviewer.user._id }, { $set: { platformAccessManagedAt: new Date(), operationalCountries: ['*'] } });
    reviewer.user = await User.findById(reviewer.user._id);
    await PlatformGrant.create({ publicId: `free-finance-${suffix}` + '-grant', userId: reviewer.user._id, role: 'super_admin', operationalCountries: ['*'], status: 'active',
      startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000), reason: 'Independent reviewed free analytics fixture.', approvalPublicId: `free-finance-${suffix}` + '-approval', approvedByUserId: new mongoose.Types.ObjectId() });
    const analyticsPlan = await SubscriptionPlan.create({ publicId: `free-finance-${suffix}` + '-plan', key: `free-finance-${suffix}`, name: 'Reviewed analytics capacity', audience: 'seller', country: 'UG', currency: 'UGX', priceMinor: 0, cadence: 'monthly', status: 'active',
      entitlements: { productLimit: 1000, seatLimit: 10, campaignLimit: 10, analyticsDays: 3660, analyticsExport: true }, createdByUserId: reviewer.user._id, updatedByUserId: reviewer.user._id });
    const analyticsChange = await billing.requestReviewedSellerSubscription(scoped(owner, store), { planPublicId: analyticsPlan.publicId, note: 'Request genuine reviewed analytics capacity.' });
    await sellerTransaction(session => billing.reviewSellerSubscriptionRequest({ ...scoped(reviewer, store), requiredOperationalWorkspace: 'superadmin' }, analyticsChange.publicId,
      { decision: 'approve', version: analyticsChange.__v, reason: 'Independently reviewed the actual free plan terms.' }, { session }));
    const reviewedChange = await SubscriptionChangeRequest.findById(analyticsChange._id);
    const activated = await billing.startSellerSubscriptionPayment(scoped(owner, store), { requestPublicId: reviewedChange.publicId, version: reviewedChange.__v, idempotencyKey: `free-finance-${suffix}` + '-activation' });
    assert.equal(activated.status, 'succeeded');
    assert.equal((await SubscriptionCharge.findOne({ publicId: activated.publicId })).amountMinor, 0);
    assert.ok(await SubscriptionEnrollment.exists({ storeId: store._id, subscriptionChargePublicId: activated.publicId, status: 'active' }));
    const accountScope = { country: 'UG', currency: 'UGX' };
    const payable = await ensureLedgerAccount({ ...accountScope, code: 'seller_payable', type: 'liability', ownerType: 'store', ownerPublicId: store.publicId });
    const foreignPayable = await ensureLedgerAccount({ ...accountScope, code: 'seller_payable', type: 'liability', ownerType: 'store', ownerPublicId: foreign.publicId });
    const cash = await ensureLedgerAccount({ ...accountScope, code: 'cash', type: 'asset', ownerType: 'platform', ownerPublicId: 'classic-mart' });
    const posted = await postLedgerTransaction({ country: 'UG', currency: 'UGX', idempotencyKey: `shared-${suffix}`, referenceType: 'test_settlement', referencePublicId: 'settlement-own',
      description: '  =FORMULA_TEST', entries: [{ account: cash, debitMinor: 5_010_000, creditMinor: 0 },
        { account: payable, debitMinor: 0, creditMinor: 10_000, memo: 'Own store' },
        { account: foreignPayable, debitMinor: 0, creditMinor: 5_000_000, memo: 'FOREIGN_ENTRY_PRIVATE' }] });
    const ownedAccount = await PayoutAccount.create({ publicId: `poa_owned_${suffix}`, ownerUserId: owner.user._id, ownerStoreId: store._id,
      ownerStorePublicId: store.publicId, ownerType: 'seller', country: 'UG', currency: 'UGX', method: 'bank', label: 'Verified business account', destinationEncrypted: 'DESTINATION_PRIVATE', status: 'verified' });
    const foreignAccount = await PayoutAccount.create({ publicId: `poa_foreign_${suffix}`, ownerUserId: foreignOwner.user._id, ownerStoreId: foreign._id,
      ownerStorePublicId: foreign.publicId, ownerType: 'seller', country: 'UG', currency: 'UGX', method: 'bank', label: 'FOREIGN_ACCOUNT_PRIVATE', destinationEncrypted: 'FOREIGN_DESTINATION_PRIVATE', status: 'verified' });
    const orderId = new mongoose.Types.ObjectId(), paymentId = new mongoose.Types.ObjectId();
    await Order.collection.insertOne({ _id: orderId, publicId: `ord_finance_${suffix}`,
      sessionKey: `session-finance-refund-${suffix}`, idempotencyKey: `checkout-finance-refund-${suffix}` });
    await Refund.create({ publicId: `ref_finance_${suffix}`, idempotencyKey: `refund-${suffix}`, orderId, paymentIntentId: paymentId,
      amountMinor: 90100, currency: 'UGX', reason: 'Shared order refund', status: 'completed', completedAt: new Date(), providerRefundId: 'PROVIDER_PRIVATE',
      allocations: [{ storePublicId: store.publicId, grossMinor: 100, sellerReceivableMinor: 90, platformFeeMinor: 10 },
        { storePublicId: foreign.publicId, grossMinor: 90000, sellerReceivableMinor: 81000, platformFeeMinor: 9000 }] });

    await t.test('finance DTO and exports retain only this store economics and do not confuse sales with withdrawable funds', async () => {
      const data = (await owner.client.get('/seller/earnings').set('accept', 'application/json').expect(200)).body;
      assert.equal(data.availableMinor, 10000);
      assert.equal(data.finance.completedRefundSellerMinor, 90);
      assert.equal(data.finance.activity.items[0].deltaMinor, 10000);
      assert.equal(data.finance.refunds.items[0].economics.grossMinor, 100);
      const serialized = JSON.stringify(data);
      for (const privateValue of ['FOREIGN_ENTRY_PRIVATE', foreign.publicId, foreignPayable.publicId, 'PROVIDER_PRIVATE', 'destinationEncrypted', 'allocations', 'entries']) assert.ok(!serialized.includes(privateValue), privateValue);
      const html = await owner.client.get('/seller/payouts').expect(200);
      assert.match(html.headers['cache-control'], /no-store/);
      assert.match(html.headers['x-robots-tag'], /noindex/);
      assert.match(html.text, /role-form-grid/);
      assert.match(html.text, /action="\/seller\/payouts"/);
      assert.doesNotMatch(html.text, /FOREIGN_ACCOUNT_PRIVATE|DESTINATION_PRIVATE|Development preview/);
      const csv = await owner.client.get('/seller/earnings/ledger.csv').expect(200);
      assert.match(csv.text, /"'  =FORMULA_TEST"/);
      assert.ok(!csv.text.includes('FOREIGN_ENTRY_PRIVATE'));
      assert.ok(csv.text.includes(posted.publicId));
      await owner.client.get('/dashboard/seller-earnings?search=settlement').expect(308).expect('location', '/seller/earnings?search=settlement');
      await owner.client.get('/seller/earnings?search=one&search=two').set('accept', 'application/json').expect(422);
      await owner.client.get('/seller/earnings?search[bad]=one').set('accept', 'application/json').expect(422);
    });

    await t.test('real payout forms reject CSRF, foreign destinations, unsafe amounts, changed retries and overdraws', async () => {
      const html = await owner.client.get('/seller/payouts').expect(200), token = csrf(html.text);
      const payload = { payoutAccountId: ownedAccount.publicId, amount: '2500', idempotencyKey: `request-${suffix}` };
      await owner.client.post('/seller/payouts').type('form').send(payload).expect(403);
      await owner.client.post('/seller/payouts').type('form').send({ ...payload, _csrf: token, amount: '2500.1' }).expect(422);
      await owner.client.post('/seller/payouts').type('form').send({ ...payload, _csrf: token, payoutAccountId: foreignAccount.publicId }).expect(409);
      await owner.client.post('/seller/payouts').type('form').send({ ...payload, _csrf: token }).expect(302).expect('location', '/seller/payouts');
      const payout = await Payout.findOne({ idempotencyKey: payload.idempotencyKey });
      assert.equal(payout.status, 'requested');
      assert.equal(payout.amountMinor, 2500);
      assert.equal(String(payout.ownerStoreId), String(store._id));
      await owner.client.post('/seller/payouts').type('form').send({ ...payload, _csrf: token }).expect(302);
      assert.equal(await Payout.countDocuments({ idempotencyKey: payload.idempotencyKey }), 1);
      await owner.client.post('/seller/payouts').type('form').send({ ...payload, _csrf: token, amount: '3000' }).expect(409);
      const page = (await owner.client.get('/seller/payouts').set('accept', 'application/json').expect(200)).body;
      assert.equal(page.availableMinor, 7500);
      assert.equal(page.finance.inFlightPayoutMinor, 2500);
      assert.equal(page.payouts[0].status, 'requested');
      await owner.client.post('/seller/payouts').type('form').send({ ...payload, _csrf: token, idempotencyKey: `overdraw-${suffix}`, amount: '7501' }).expect(409);
      assert.equal(await Payout.countDocuments({ ownerStoreId: store._id }), 1);
      const destination = { method: 'mobile_money', label: 'Business mobile', beneficiary_name: 'Business owner', network: 'Test Network', phone: '+256700000001', _csrf: token };
      await owner.client.post('/seller/payouts/accounts').type('form').send(destination).expect(302);
      const pending = await PayoutAccount.findOne({ ownerStoreId: store._id, label: destination.label }).select('+destinationEncrypted');
      assert.equal(pending.status, 'pending');
      assert.notEqual(pending.destinationEncrypted, destination.phone);
      assert.ok(!pending.destinationEncrypted.includes(destination.phone));
      await owner.client.post('/seller/payouts').type('form').send({ ...payload, _csrf: token, idempotencyKey: `unverified-${suffix}`, payoutAccountId: pending.publicId }).expect(409);
    });

    await t.test('pagination and filtering remain scoped when stores share timestamps', async () => {
      const timestamp = new Date('2026-09-30T12:00:00Z');
      await Payout.insertMany(Array.from({ length: 27 }, (_, index) => ({ publicId: `pyo_page_${suffix}_${index}`, idempotencyKey: `page-${suffix}-${index}`,
        ownerUserId: owner.user._id, requestedByUserId: owner.user._id, ownerStoreId: store._id, ownerStorePublicId: store.publicId,
        payoutAccountId: ownedAccount._id, amountMinor: 1, currency: 'UGX', status: 'failed', createdAt: timestamp })));
      const first = (await owner.client.get('/seller/payouts?status=failed').set('accept', 'application/json').expect(200)).body;
      assert.equal(first.page.total, 27); assert.equal(first.rows.length, 25); assert.equal(first.page.hasMore, true);
      const second = (await owner.client.get('/seller/payouts?status=failed&after=' + first.page.next).set('accept', 'application/json').expect(200)).body;
      assert.equal(second.rows.length, 2);
      assert.ok(second.rows.every(row => !first.rows.some(previous => previous.id === row.id)));
      assert.equal((await owner.client.get('/seller/payouts?search=not-a-payout').set('accept', 'application/json').expect(200)).body.rows.length, 0);
      assert.equal((await owner.client.get('/seller/earnings?search=settlement-own').set('accept', 'application/json').expect(200)).body.finance.activity.page.total, 1);
    });

    await t.test('accepted Customer finance staff keep store payouts in the Seller domain', async () => {
      const delegate = await actor('customer');
      await StoreMember.create({ publicId: `stm_delegate_finance_${suffix}`, storeId: store._id, userId: delegate.user._id,
        role: 'finance', status: 'active', invitedByUserId: owner.user._id, acceptedAt: new Date() });
      await selectStore(delegate, store);
      const html = await delegate.client.get('/seller/payouts').expect(200), token = csrf(html.text);
      await delegate.client.post('/seller/payouts/accounts').type('form').send({ _csrf: token, method: 'bank', label: 'Store finance destination',
        beneficiary_name: 'Store beneficiary', account_bank: 'Store Bank', account_number: '12345678' }).expect(302);
      const destination = await PayoutAccount.findOne({ label: 'Store finance destination' });
      assert.equal(destination.ownerType, 'seller');
      assert.equal(String(destination.ownerStoreId), String(store._id));
      assert.equal(String(destination.ownerUserId), String(owner.user._id));
      await PayoutAccount.updateOne({ _id: destination._id }, { $set: { status: 'verified' } });
      await delegate.client.post('/seller/payouts').type('form').send({ _csrf: token, payoutAccountId: destination.publicId,
        amount: '100', idempotencyKey: `delegate-store-${suffix}` }).expect(302);
      const payout = await Payout.findOne({ idempotencyKey: `delegate-store-${suffix}` });
      assert.equal(String(payout.ownerStoreId), String(store._id));
      assert.equal(String(payout.ownerUserId), String(owner.user._id));
      assert.equal(String(payout.requestedByUserId), String(delegate.user._id));
      assert.equal(await PayoutAccount.countDocuments({ ownerUserId: delegate.user._id }), 0);
    });

    await t.test('fresh finance authorization rejects buyer, nonfinance staff, revoked members, stale sessions and locked stores', async () => {
      await buyer.client.get('/seller/earnings').set('accept', 'application/json').expect(403);
      const staff = await actor('customer');
      const member = await StoreMember.create({ publicId: `stm_finance_staff_${suffix}`, storeId: store._id, userId: staff.user._id,
        role: 'support', status: 'active', invitedByUserId: owner.user._id, acceptedAt: new Date() });
      await selectStore(staff, store);
      await staff.client.get('/seller/payouts').set('accept', 'application/json').expect(403);
      await StoreMember.updateOne({ _id: member._id }, { $set: { role: 'finance' } });
      assert.equal((await staff.client.get('/seller/payouts').set('accept', 'application/json').expect(200)).body.store.publicId, store.publicId);
      await staff.client.get('/seller/analytics').set('accept', 'application/json').expect(403);
      await StoreMember.updateOne({ _id: member._id }, { $set: { status: 'revoked' } });
      await assert.rejects(loadSellerFinancePage(scoped(staff, store), 'seller-payouts'), error => error.code === 'STORE_PERMISSION_DENIED');
      await assert.rejects(loadSellerFinancePage(scoped(owner, foreign), 'seller-earnings'), error => error.code === 'STORE_PERMISSION_DENIED');
      const forbiddenPromoter = await actor('promoter');
      await StoreMember.create({ publicId: `stm_forbidden_promoter_${suffix}`, storeId: store._id, userId: forbiddenPromoter.user._id,
        role: 'finance', status: 'active', invitedByUserId: owner.user._id, acceptedAt: new Date() });
      await assert.rejects(loadSellerFinancePage(scoped(forbiddenPromoter, store), 'seller-payouts'), error => error.code === 'SELLER_IDENTITY_FORBIDDEN');
      await assert.rejects(loadSellerFinancePage(scoped(reviewer, store), 'seller-payouts'), error => error.code === 'SELLER_IDENTITY_FORBIDDEN');
      await Device.updateOne({ _id: owner.serviceDevice._id }, { $set: { revokedAt: new Date() } });
      try { await assert.rejects(loadSellerFinancePage(scoped(owner, store), 'seller-payouts'), error => error.code === 'ACCOUNT_UNAVAILABLE'); }
      finally { await Device.updateOne({ _id: owner.serviceDevice._id }, { $set: { revokedAt: null } }); }
      await User.updateOne({ _id: owner.user._id }, { $set: { status: 'suspended' } });
      try { await StoreMember.updateOne({ _id: member._id }, { $set: { status: 'active', role: 'finance' } });
        await assert.rejects(loadSellerFinancePage(scoped(staff, store), 'seller-payouts'), error => error.code === 'STORE_PERMISSION_DENIED'); }
      finally { await User.updateOne({ _id: owner.user._id }, { $set: { status: 'active' } }); await StoreMember.updateOne({ _id: member._id }, { $set: { status: 'revoked' } }); }
      const stale = scoped(owner, store); stale.session.tokenVersion += 1;
      await assert.rejects(loadSellerFinancePage(stale, 'seller-earnings'), error => error.code === 'ACCOUNT_UNAVAILABLE');
      await StoreMember.create({ publicId: `stm_no_mfa_${suffix}`, storeId: store._id, userId: unenrolled.user._id, role: 'finance', status: 'active', invitedByUserId: owner.user._id, acceptedAt: new Date() });
      await unenrolled.client.get('/seller/payouts').set('accept', 'application/json').expect(403);
      await assert.rejects(loadSellerFinancePage(scoped(unenrolled, store), 'seller-payouts'), error => error.code === 'MFA_ENROLLMENT_REQUIRED');
      await Store.updateOne({ _id: store._id }, { $set: { status: 'suspended' } });
      await owner.client.get('/seller/earnings').set('accept', 'application/json').expect(409);
      await Store.updateOne({ _id: store._id }, { $set: { status: 'verified' } });
    });

    await t.test('analytics counts verified paid sales and exports the store calendar with no invented traffic metrics', async () => {
      const now = new Date(), paidAt = new Date(now.getTime() - 60_000), rootId = new mongoose.Types.ObjectId(), orderPublicId = `ord_analytics_${suffix}`;
      await Order.collection.insertOne({ _id: rootId, publicId: orderPublicId, country: 'UG',
        sessionKey: `session-finance-analytics-${suffix}`, idempotencyKey: `checkout-finance-analytics-${suffix}`,
        totals: { currency: 'UGX', totalMinor: 3456 },
        items: [{ storeId: store._id, storePublicId: store.publicId }], createdAt: paidAt });
      await SellerOrder.create({ publicId: `sor_analytics_${suffix}`, orderId: rootId, orderPublicId, storeId: store._id, storePublicId: store.publicId,
        country: 'UG', currency: 'UGX', status: 'confirmed', subtotalMinor: 3456, items: [{ title: 'Analytics product', quantity: 1, lineTotalMinor: 3456, currency: 'UGX' }], createdAt: paidAt });
      await PaymentIntent.create({ publicId: `pay_analytics_${suffix}`, orderId: rootId, orderPublicId, country: 'UG', currency: 'UGX',
        idempotencyKey: `analytics-${suffix}`, provider: 'wallet', method: 'wallet', status: 'succeeded', amountMinor: 3456, paidAt });
      const analytics = (await owner.client.get('/seller/analytics?period=30days').set('accept', 'application/json').expect(200)).body;
      assert.equal(analytics.analytics.paidMinor, 3456); assert.equal(analytics.analytics.netSalesMinor, 3456);
      assert.equal(analytics.timeZone, 'Africa/Kampala');
      assert.ok(analytics.trend.some(row => row.value === 3456));
      assert.ok(!('traffic' in analytics.analytics)); assert.ok(!('conversionRate' in analytics.analytics));
      const html = await owner.client.get('/seller/analytics').expect(200);
      assert.match(html.text, /Performance trend/);
      await owner.client.get('/seller/analytics?period=all').set('accept', 'application/json').expect(422);
      await owner.client.get('/seller/analytics?period=year&period=30days').set('accept', 'application/json').expect(422);
      const exported = await owner.client.get('/seller/analytics/summary.csv?period=30days').expect(200);
      assert.match(exported.text, /Africa\/Kampala/); assert.match(exported.text, /3456/);
      await owner.client.get('/seller/earnings/contribution.csv').expect(200);
    });

    await t.test('store payout MFA also protects generic APIs and direct services for delegated identities', async () => {
      const promoter = await actor('promoter', false);
      await StoreMember.create({ publicId: `stm_promoter_no_mfa_${suffix}`, storeId: store._id, userId: promoter.user._id,
        role: 'finance', status: 'active', invitedByUserId: owner.user._id, acceptedAt: new Date() });
      const security = await unenrolled.client.get('/account/security').expect(200), token = csrf(security.text);
      const apiDestination = { method: 'bank', label: 'Unenrolled store destination', destination: { beneficiary_name: 'Store owner', account_bank: 'Test Bank', account_number: '12345678' } };
      const apiCreated = await unenrolled.client.post('/api/v1/payout-accounts').set('x-csrf-token', token).send(apiDestination).expect(403);
      assert.equal(apiCreated.body.error.code, 'MFA_ENROLLMENT_REQUIRED');
      const apiRequest = await unenrolled.client.post('/api/v1/payouts').set('x-csrf-token', token).send({ payoutAccountId: ownedAccount.publicId,
        amountMinor: 10, idempotencyKey: `customer-api-no-mfa-${suffix}` }).expect(403);
      assert.equal(apiRequest.body.error.code, 'MFA_ENROLLMENT_REQUIRED');
      for (const actor of [unenrolled, promoter]) {
        await assert.rejects(createSellerPayoutDestination(scoped(actor, store), { method: 'bank', label: 'Direct unverified destination',
          beneficiary_name: 'Store owner', account_bank: 'Test Bank', account_number: '12345678' }), error => error.code === (actor === promoter ? 'SELLER_IDENTITY_FORBIDDEN' : 'MFA_ENROLLMENT_REQUIRED'));
        await assert.rejects(requestSellerPayout(scoped(actor, store), { payoutAccountId: ownedAccount.publicId,
          amount: '10', idempotencyKey: `direct-no-mfa-${actor.user.publicId}` }), error => error.code === (actor === promoter ? 'SELLER_IDENTITY_FORBIDDEN' : 'MFA_ENROLLMENT_REQUIRED'));
      }
      const promoterSecurity = await promoter.client.get('/account/security').expect(200), promoterToken = csrf(promoterSecurity.text);
      await promoter.client.post('/api/v1/payouts').set('x-csrf-token', promoterToken).send({ payoutAccountId: ownedAccount.publicId,
        amountMinor: 10, idempotencyKey: `promoter-api-no-mfa-${suffix}` }).expect(409);
      const personal = await promoter.client.post('/api/v1/payout-accounts').set('x-csrf-token', promoterToken).send({ ...apiDestination, label: 'Personal promoter destination' }).expect(201);
      assert.equal(personal.body.account.ownerType, 'promoter');
      assert.ok(!personal.body.account.ownerStoreId);
      assert.equal(await Payout.countDocuments({ idempotencyKey: { $in: [`customer-api-no-mfa-${suffix}`, `promoter-api-no-mfa-${suffix}`] } }), 0);
      const ownerToken = csrf((await owner.client.get('/seller/payouts').expect(200)).text);
      await owner.client.post('/api/v1/payouts').set('x-csrf-token', ownerToken).send({ payoutAccountId: ownedAccount.publicId,
        amountMinor: 10, idempotencyKey: `owner-api-with-mfa-${suffix}` }).expect(201);
      assert.equal((await Payout.findOne({ idempotencyKey: `owner-api-with-mfa-${suffix}` })).status, 'requested');
    });

    await t.test('verified destinations in another country or currency cannot reserve store funds', async () => {
      const before = await loadSellerFinancePage(scoped(owner, store), 'seller-payouts');
      const payoutCount = await Payout.countDocuments({ ownerStoreId: store._id });
      const token = csrf((await owner.client.get('/seller/payouts').expect(200)).text);
      for (const [name, country, currency] of [['country', 'KE', 'UGX'], ['currency', 'UG', 'KES']]) {
        const account = await PayoutAccount.create({ publicId: `poa_wrong_${name}_${suffix}`, ownerUserId: owner.user._id,
          ownerStoreId: store._id, ownerStorePublicId: store.publicId, ownerType: 'seller', country, currency,
          method: 'bank', label: `Wrong ${name} destination`, destinationEncrypted: 'UNRELATED_DESTINATION', status: 'verified' });
        const api = await owner.client.post('/api/v1/payouts').set('x-csrf-token', token).send({ payoutAccountId: account.publicId,
          amountMinor: 100, idempotencyKey: `wrong-${name}-api-${suffix}` }).expect(409);
        assert.equal(api.body.error.code, 'PAYOUT_ACCOUNT_REQUIRED');
        await owner.client.post('/seller/payouts').type('form').send({ _csrf: token, payoutAccountId: account.publicId,
          amount: '100', idempotencyKey: `wrong-${name}-page-${suffix}` }).expect(409);
      }
      assert.equal(await Payout.countDocuments({ ownerStoreId: store._id }), payoutCount);
      const after = await loadSellerFinancePage(scoped(owner, store), 'seller-payouts');
      assert.equal(after.availableMinor, before.availableMinor);
      assert.equal(after.finance.activity.page.total, before.finance.activity.page.total);
      assert.equal(await models.LedgerAccount.countDocuments({ code: 'seller_payable', ownerPublicId: store.publicId,
        $or: [{ country: 'KE' }, { currency: 'KES' }] }), 0);
    });

    await t.test('payout core rejects stale actors, disabled destinations and changed idempotent requests without reserving funds', async () => {
      const before = await loadSellerFinancePage(scoped(owner, store), 'seller-payouts');
      const count = await Payout.countDocuments({ ownerStoreId: store._id });
      const input = { payoutAccountId: ownedAccount.publicId, amountMinor: 1, idempotencyKey: `core-invalid-${suffix}` };
      for (const amountMinor of [0, -1, 1.25, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(requestPayout(scoped(owner, store), { ...input, amountMinor }), error => error.code === 'PAYOUT_AMOUNT_INVALID');
      }
      await User.updateOne({ _id: owner.user._id }, { $set: { status: 'suspended' } });
      try {
        await assert.rejects(requestPayout(scoped(owner, store), input), error => error.code === 'SELLER_IDENTITY_FORBIDDEN');
      } finally { await User.updateOne({ _id: owner.user._id }, { $set: { status: 'active' } }); }
      await User.updateOne({ _id: owner.user._id }, { $inc: { 'security.tokenVersion': 1 } });
      try {
        await assert.rejects(requestPayout(scoped(owner, store), input), error => error.code === 'SELLER_IDENTITY_FORBIDDEN');
      } finally { await User.updateOne({ _id: owner.user._id }, { $set: { 'security.tokenVersion': owner.user.security.tokenVersion } }); }
      const staleSession = scoped(owner, store);
      staleSession.session.tokenVersion += 1;
      await assert.rejects(requestPayout(staleSession, input), error => error.code === 'ACCOUNT_UNAVAILABLE');
      await PayoutAccount.updateOne({ _id: ownedAccount._id }, { $set: { status: 'disabled' } });
      try {
        await assert.rejects(requestPayout(scoped(owner, store), input), error => error.code === 'PAYOUT_ACCOUNT_REQUIRED');
      } finally { await PayoutAccount.updateOne({ _id: ownedAccount._id }, { $set: { status: 'verified' } }); }
      await assert.rejects(requestPayout(scoped(owner, store), { ...input, amountMinor: 2501, idempotencyKey: `request-${suffix}` }),
        error => error.code === 'PAYOUT_IDEMPOTENCY_CONFLICT');
      assert.equal(await Payout.countDocuments({ ownerStoreId: store._id }), count);
      const after = await loadSellerFinancePage(scoped(owner, store), 'seller-payouts');
      assert.equal(after.availableMinor, before.availableMinor);
      assert.equal(after.finance.activity.page.total, before.finance.activity.page.total);
    });

    await t.test('a promoter cannot reuse a store payout key for a personal payout', async () => {
      const promoter = await actor('promoter');
      await StoreMember.create({ publicId: `stm_domain_retry_${suffix}`, storeId: store._id, userId: promoter.user._id,
        role: 'finance', status: 'active', invitedByUserId: owner.user._id, acceptedAt: new Date() });
      const idempotencyKey = `domain-retry-${suffix}`;
      await assert.rejects(requestPayout(scoped(promoter, store), { payoutAccountId: ownedAccount.publicId, amountMinor: 1, idempotencyKey: `forbidden-store-${suffix}` }), error => error.code === 'SELLER_IDENTITY_FORBIDDEN');
      const storePayout = await requestPayout(scoped(owner, store), { payoutAccountId: ownedAccount.publicId, amountMinor: 1, idempotencyKey });
      assert.equal(String(storePayout.ownerStoreId), String(store._id));
      const personalAccount = await PayoutAccount.create({ publicId: `poa_domain_retry_${suffix}`, ownerUserId: promoter.user._id,
        ownerType: 'promoter', country: 'UG', currency: 'UGX', method: 'bank', label: 'Personal retry destination', destinationEncrypted: 'PERSONAL_PRIVATE', status: 'verified' });
      await assert.rejects(requestPayout({ ...scoped(promoter, store), store: undefined, session: { userId: String(promoter.user._id), tokenVersion: promoter.user.security.tokenVersion } },
        { payoutAccountId: personalAccount.publicId, amountMinor: 1, idempotencyKey }), error => error.code === 'PAYOUT_IDEMPOTENCY_CONFLICT');
      assert.equal(await Payout.countDocuments({ idempotencyKey }), 1);
      assert.equal(await models.LedgerAccount.countDocuments({ code: 'promoter_payable', ownerPublicId: String(promoter.user._id) }), 0);
    });

    await t.test('competing finance members cannot reserve the same available balance twice', async () => {
      const colleague = await actor('customer');
      await StoreMember.create({ publicId: `stm_balance_race_${suffix}`, storeId: store._id, userId: colleague.user._id,
        role: 'finance', status: 'active', invitedByUserId: owner.user._id, acceptedAt: new Date() });
      const before = await loadSellerFinancePage(scoped(owner, store), 'seller-payouts');
      const count = await Payout.countDocuments({ ownerStoreId: store._id });
      assert.ok(before.availableMinor > 0);
      const results = await Promise.allSettled([owner, colleague].map((actor, index) => requestPayout(scoped(actor, store),
        { payoutAccountId: ownedAccount.publicId, amountMinor: before.availableMinor, idempotencyKey: `balance-race-${suffix}-${index}` })));
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'PAYOUT_BALANCE').length, 1);
      assert.equal(await Payout.countDocuments({ ownerStoreId: store._id }), count + 1);
      assert.equal((await loadSellerFinancePage(scoped(owner, store), 'seller-payouts')).availableMinor, 0);
    });
  } finally {
    for (const transport of transports) transport.destroy();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

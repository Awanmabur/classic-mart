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
process.env.PESAPAL_BASE_URL = 'https://promoter-finance-test.invalid';
process.env.PESAPAL_CONSUMER_KEY = crypto.randomBytes(16).toString('hex');
process.env.PESAPAL_CONSUMER_SECRET = crypto.randomBytes(32).toString('hex');
for (const name of ['SESSION_SECRET', 'TOKEN_PEPPER', 'SECURITY_INTEGRITY_KEY', 'DATA_ENCRYPTION_KEY']) process.env[name] = crypto.randomBytes(32).toString('hex');
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('Promoter periods use the configured market calendar', async () => {
  const { promoterReportingWindow } = await import('../src/services/promoter-finance-pages.js');
  const march = promoterReportingWindow('year', 'America/New_York', new Date('2026-03-10T12:00:00Z'));
  assert.equal(march.start.toISOString(), '2026-01-01T05:00:00.000Z');
  assert.equal(march.buckets[2].start.toISOString(), '2026-03-01T05:00:00.000Z');
  const uganda = promoterReportingWindow('year', 'Africa/Kampala', new Date('2026-10-10T22:00:00Z'));
  assert.equal(uganda.start.toISOString(), '2025-12-31T21:00:00.000Z');
  assert.throws(() => promoterReportingWindow('all-time', 'UTC'));
});

test('Promoter finance pages keep identity, market, funds and performance scoped', { skip: !uri, timeout: 120000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: `classicmart_promoter_finance_test_${suffix}` });
  const models = await import('../src/models/index.js');
  const { User, Device, CountrySetting, PromoterVerification, Campaign, PromoterLink, AttributionTouch, CommissionEntry, LedgerAccount, LedgerTransaction, PaymentIntent, Payout, PayoutAccount, Order, AuditLog, BusinessInvoice, Shipment, InventoryReservation, FinancialDocument, LoyaltyAccount, LoyaltyEntry } = models;
  const { createApp } = await import('../src/app.js');
  const { hashPassword } = await import('../src/core/crypto.js');
  const { ensureLedgerAccount, postLedgerTransaction, accountBalanceMinor } = await import('../src/services/money.js');
  const { requestPayout, payoutOwnerContext, savePayoutAccount, verifyAndApplyPayment } = await import('../src/services/payments.js');
  const { reviewCommissionAppeal } = await import('../src/services/promoters.js');
  const { loadPromoterFinancePage, requestPromoterPayout, createPromoterPayoutDestination } = await import('../src/services/promoter-finance-pages.js');
  const app = createApp(null), password = `Promoter-${suffix}-A1!`, passwordHash = await hashPassword(password), transports = [];
  let sequence = 0;
  async function actor(role = 'promoter') {
    const index = ++sequence, email = `promoter-finance-${suffix}-${index}@example.com`, phone = '+25670' + String(index).padStart(7, '0');
    const user = await User.create({ publicId: `usr_pf_${suffix}_${index}`, name: `Promoter ${index}`, email, emailNormalized: email, phone, phoneNormalized: phone,
      passwordHash, role, country: 'UG', currency: 'UGX', locale: 'en-UG', emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
      consents: { terms: true, privacy: true, recordedAt: new Date() } });
    const transport = new http.Agent({ localAddress: `127.0.0.${index + 5}`, keepAlive: false }); transports.push(transport);
    const client = request.agent(app).use(req => req.agent(transport));
    const login = await client.get('/login').expect(200);
    await client.post('/login').type('form').send({ email, password, _csrf: csrf(login.text) }).expect(302);
    return { user, client };
  }
  const scoped = entry => ({ user: entry.user, session: { tokenVersion: entry.user.security.tokenVersion }, query: {}, id: `req_pf_${suffix}_${++sequence}`, get: () => '', ip: '127.0.0.1' });
  const now = new Date(), old = new Date(now.getTime() - 100 * 86400000);
  async function order(id, country = 'UG', currency = 'UGX', paymentState = 'paid', createdAt = now) {
    const _id = new mongoose.Types.ObjectId();
    await Order.collection.insertOne({ _id, publicId: id, sessionKey: `session_${id}`, idempotencyKey: `order_key_${id}`, country, totals: { currency, totalMinor: 999999 }, createdAt, paymentState,
      status: paymentState === 'paid' ? 'paid' : 'pending_payment', fulfillmentState: 'unfulfilled', refundState: 'none',
      contact: { email: 'BUYER_EMAIL_PRIVATE', phone: 'BUYER_PHONE_PRIVATE' }, items: [{ title: 'OTHER_BUYER_LINE_PRIVATE' }] });
    return { _id, publicId: id };
  }
  try {
    // Wait for every centrally registered model before fixtures and teardown.
    // The root runner serializes Mongo suites and retains production indexes.
    for (const Model of Object.values(mongoose.connection.models)) await Model.init();
    await CountrySetting.create([{ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256' },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254' }]);
    const owner = await actor(), other = await actor(), customer = await actor('customer'), superAdmin = await actor('super_admin');
    const verification = await PromoterVerification.create({ publicId: `prv_pf_${suffix}`, userId: owner.user._id, country: 'UG', status: 'verified' });
    await PromoterVerification.create({ publicId: `prv_other_pf_${suffix}`, userId: other.user._id, country: 'UG', status: 'verified' });
    const campaign = await Campaign.create({ publicId: `cmp_pf_${suffix}`, scope: 'marketplace', systemManaged: true, country: 'UG', name: '  =CAMPAIGN_FORMULA', status: 'active', commissionBps: 300 });
    const link = await PromoterLink.create({ publicId: `plk_pf_${suffix}`, campaignId: campaign._id, promoterUserId: owner.user._id, token: `token_${suffix}`, destination: '/products', channel: 'whatsapp' });
    const touch = await AttributionTouch.create({ publicId: `tch_pf_${suffix}`, campaignId: campaign._id, linkId: link._id, promoterUserId: owner.user._id, country: 'UG', sessionKey: 'VISITOR_SESSION_PRIVATE', ipHash: 'IP_HASH_PRIVATE', userAgentHash: 'UA_HASH_PRIVATE', expiresAt: new Date(now.getTime() + 86400000), status: 'converted', landedAt: now, createdAt: now });
    await AttributionTouch.create({ publicId: `tch_blocked_pf_${suffix}`, campaignId: campaign._id, linkId: link._id, promoterUserId: owner.user._id, country: 'UG', sessionKey: 'BLOCKED_SESSION_PRIVATE', ipHash: 'BLOCKED_IP_PRIVATE', userAgentHash: 'BLOCKED_UA_PRIVATE', expiresAt: new Date(now.getTime() + 86400000), status: 'blocked', landedAt: now, createdAt: now });
    await AttributionTouch.create({ publicId: `tch_other_pf_${suffix}`, campaignId: campaign._id, linkId: link._id, promoterUserId: other.user._id, country: 'UG', sessionKey: 'FOREIGN_TOUCH_PRIVATE', ipHash: 'FOREIGN_HASH_PRIVATE', userAgentHash: 'FOREIGN_UA_PRIVATE', expiresAt: new Date(now.getTime() + 86400000), landedAt: now, createdAt: now });
    await AttributionTouch.create({ publicId: `tch_old_pf_${suffix}`, campaignId: campaign._id, linkId: link._id, promoterUserId: owner.user._id, country: 'UG', sessionKey: 'OLD_VISIT_PRIVATE', ipHash: 'OLD_HASH_PRIVATE', userAgentHash: 'OLD_UA_PRIVATE', expiresAt: now, landedAt: old, createdAt: old });
    const paidOrder = await order(`ord_paid_pf_${suffix}`), pendingOrder = await order(`ord_pending_pf_${suffix}`, 'UG', 'UGX', 'pending'), fxOrder = await order(`ord_fx_pf_${suffix}`, 'KE', 'KES');
    await PaymentIntent.create({ publicId: `pay_pf_${suffix}`, orderId: paidOrder._id, orderPublicId: paidOrder.publicId, country: 'UG', currency: 'UGX', idempotencyKey: `payment_pf_${suffix}`, provider: 'wallet', method: 'wallet', status: 'succeeded', paidAt: now, amountMinor: 999999 });
    await PaymentIntent.create({ publicId: `pay_mismatch_pf_${suffix}`, orderId: pendingOrder._id, orderPublicId: `ord_wrong_pf_${suffix}`, country: 'UG', currency: 'UGX', idempotencyKey: `payment_mismatch_pf_${suffix}`, provider: 'wallet', method: 'wallet', status: 'succeeded', paidAt: now, amountMinor: 999999 });
    const commission = await CommissionEntry.create({ publicId: `com_paid_pf_${suffix}`, orderId: paidOrder._id, orderPublicId: paidOrder.publicId, campaignId: campaign._id, promoterUserId: owner.user._id, touchId: touch._id, productPublicId: 'prd_owned', storePublicId: 'sto_brand', currency: 'UGX', amountMinor: 10000, commissionBps: 300, policyVersion: 'fixture', status: 'payable', payableAt: now, createdAt: now });
    await CommissionEntry.create({ publicId: `com_pending_pf_${suffix}`, orderId: pendingOrder._id, orderPublicId: pendingOrder.publicId, campaignId: campaign._id, promoterUserId: owner.user._id, touchId: touch._id, productPublicId: 'prd_pending', storePublicId: 'sto_brand', currency: 'UGX', amountMinor: 50000, commissionBps: 300, policyVersion: 'fixture', status: 'pending', createdAt: now });
    const foreignCommission = await CommissionEntry.create({ publicId: `com_fx_pf_${suffix}`, orderId: fxOrder._id, orderPublicId: fxOrder.publicId, campaignId: campaign._id, promoterUserId: owner.user._id, touchId: touch._id, productPublicId: 'prd_fx', storePublicId: 'sto_foreign', currency: 'KES', amountMinor: 80000, commissionBps: 300, policyVersion: 'fixture', status: 'payable', payableAt: old, createdAt: now });
    const payable = await ensureLedgerAccount({ code: 'promoter_payable', type: 'liability', ownerType: 'promoter', ownerPublicId: String(owner.user._id), country: 'UG', currency: 'UGX' });
    const foreignPayable = await ensureLedgerAccount({ code: 'promoter_payable', type: 'liability', ownerType: 'promoter', ownerPublicId: String(other.user._id), country: 'UG', currency: 'UGX' });
    const cash = await ensureLedgerAccount({ code: 'test_cash', type: 'asset', ownerType: 'platform', ownerPublicId: 'classic-mart', country: 'UG', currency: 'UGX' });
    const transaction = await postLedgerTransaction({ country: 'UG', currency: 'UGX', idempotencyKey: `ledger_pf_${suffix}`, referenceType: 'test_commission', referencePublicId: commission.publicId,
      description: '  =LEDGER_FORMULA', entries: [{ account: cash, debitMinor: 110000, creditMinor: 0 }, { account: payable, debitMinor: 0, creditMinor: 10000 }, { account: foreignPayable, debitMinor: 0, creditMinor: 100000, memo: 'OTHER_PROMOTER_ENTRY_PRIVATE' }] });
    const account = await PayoutAccount.create({ publicId: `poa_pf_${suffix}`, ownerUserId: owner.user._id, ownerType: 'promoter', country: 'UG', currency: 'UGX', label: 'Programme account', method: 'bank', destinationEncrypted: 'OWN_DESTINATION_PRIVATE', status: 'verified' });
    const foreignAccount = await PayoutAccount.create({ publicId: `poa_foreign_pf_${suffix}`, ownerUserId: other.user._id, ownerType: 'promoter', country: 'UG', currency: 'UGX', label: 'FOREIGN_ACCOUNT_PRIVATE', method: 'bank', destinationEncrypted: 'FOREIGN_DESTINATION_PRIVATE', status: 'verified' });
    const foreignCampaign = await Campaign.create({ publicId: `cmp_foreign_pf_${suffix}`, scope: 'marketplace', systemManaged: true, country: 'KE', name: 'WRONG_MARKET_CAMPAIGN_PRIVATE', status: 'active', commissionBps: 300 });
    await CommissionEntry.create({ publicId: `com_cross_market_pf_${suffix}`, orderId: paidOrder._id, orderPublicId: paidOrder.publicId, campaignId: foreignCampaign._id, promoterUserId: owner.user._id, touchId: touch._id, productPublicId: 'prd_cross_market', storePublicId: 'sto_brand', currency: 'UGX', amountMinor: 888888, commissionBps: 300, policyVersion: 'fixture', status: 'payable', payableAt: now, createdAt: now });
    const foreignLink = await PromoterLink.create({ publicId: `plk_foreign_pf_${suffix}`, campaignId: campaign._id, promoterUserId: other.user._id, token: `token_foreign_${suffix}`, destination: '/products', channel: 'FOREIGN_CHANNEL_PRIVATE' });
    await AttributionTouch.create({ publicId: `tch_cross_owner_pf_${suffix}`, campaignId: campaign._id, linkId: foreignLink._id, promoterUserId: owner.user._id, country: 'UG', sessionKey: 'CROSS_OWNER_SESSION_PRIVATE', ipHash: 'CROSS_OWNER_IP_PRIVATE', userAgentHash: 'CROSS_OWNER_UA_PRIVATE', expiresAt: new Date(now.getTime() + 86400000), status: 'valid', landedAt: now, createdAt: now });

    await t.test('six pages use actual records and preserve buyer and payout privacy', async () => {
      for (const slug of ['traffic', 'conversions', 'commissions', 'wallet', 'payouts', 'analytics']) {
        const page = await owner.client.get('/promoter/' + slug).set('accept', 'application/json').expect(200);
        assert.equal(page.body.market.country, 'UG'); assert.equal(page.body.currency, 'UGX'); assert.equal(page.body.availableMinor, 10000);
        const text = JSON.stringify(page.body);
        for (const hidden of ['BUYER_EMAIL_PRIVATE', 'BUYER_PHONE_PRIVATE', 'OTHER_BUYER_LINE_PRIVATE', 'OWN_DESTINATION_PRIVATE', 'destinationEncrypted', 'OTHER_PROMOTER_ENTRY_PRIVATE', 'FOREIGN_ACCOUNT_PRIVATE', 'IP_HASH_PRIVATE', 'VISITOR_SESSION_PRIVATE', foreignCommission.publicId, 'FOREIGN_TOUCH_PRIVATE', 'WRONG_MARKET_CAMPAIGN_PRIVATE', 'FOREIGN_CHANNEL_PRIVATE', 'CROSS_OWNER_SESSION_PRIVATE']) assert.ok(!text.includes(hidden), slug + ':' + hidden);
        await owner.client.get('/dashboard/promoter-' + slug + '?search=retained').expect(308).expect('location', '/promoter/' + slug + '?search=retained');
      }
      const traffic = (await owner.client.get('/promoter/traffic').set('accept', 'application/json')).body;
      assert.equal(traffic.page.total, 2); assert.equal(traffic.analytics.eligibleVisits, 1); assert.equal(traffic.analytics.blockedVisits, 1);
      const conversions = (await owner.client.get('/promoter/conversions').set('accept', 'application/json')).body;
      assert.equal(conversions.analytics.conversions, 2); assert.equal(conversions.analytics.paidConversions, 1);
      assert.equal(conversions.conversions.find(row => row.publicId === paidOrder.publicId).paymentVerified, true);
      assert.equal(conversions.conversions.find(row => row.publicId === pendingOrder.publicId).paymentVerified, false);
      const commissions = (await owner.client.get('/promoter/commissions').set('accept', 'application/json')).body;
      assert.equal(commissions.finance.estimatedMinor, 50000); assert.equal(commissions.finance.earnedMinor, 60000);
      const analytics = (await owner.client.get('/promoter/analytics').set('accept', 'application/json')).body;
      assert.equal(analytics.analytics.byChannel[0].commissionMinor, 60000); assert.equal(analytics.analytics.byChannel[0].conversions, 2);
      assert.equal(analytics.trend.reduce((sum, row) => sum + row.value, 0), 60000);
      const html = await owner.client.get('/promoter/payouts').expect(200);
      assert.match(html.text, /role-form-grid/); assert.match(html.text, /action="\/promoter\/payouts"/); assert.match(html.headers['cache-control'], /no-store/); assert.match(html.headers['x-robots-tag'], /noindex/);
      const csv = await owner.client.get('/promoter/wallet/export.csv').expect(200);
      assert.match(csv.text, /"'  =LEDGER_FORMULA"/); assert.ok(csv.text.includes(transaction.publicId)); assert.ok(!csv.text.includes('OTHER_PROMOTER_ENTRY_PRIVATE'));
      const commissionCsv = await owner.client.get('/promoter/commissions/export.csv').expect(200); assert.match(commissionCsv.text, /"'=CAMPAIGN_FORMULA"/);
      await owner.client.get('/promoter/traffic?period=all').set('accept', 'application/json').expect(422);
      await owner.client.get('/promoter/wallet?search[bad]=x').set('accept', 'application/json').expect(422);
      await owner.client.get('/promoter/conversions?status=paid&status=pending').set('accept', 'application/json').expect(422);
      await owner.client.get('/promoter/wallet?after=not-a-cursor').set('accept', 'application/json').expect(422);
      await owner.client.get('/promoter/analytics?after=!!!').set('accept', 'application/json').expect(422);
    });

    await t.test('payouts reserve ledger funds and reject CSRF, foreign accounts, unsafe amounts and conflicting retries', async () => {
      const html = await owner.client.get('/promoter/payouts').expect(200), token = csrf(html.text);
      const body = { payoutAccountId: account.publicId, amount: '2500', idempotencyKey: `payout_pf_${suffix}` };
      await owner.client.post('/promoter/payouts').type('form').send(body).expect(403);
      await owner.client.post('/promoter/payouts').type('form').send({ ...body, _csrf: token, amount: '2500.1' }).expect(422);
      await owner.client.post('/promoter/payouts').type('form').send({ ...body, _csrf: token, payoutAccountId: foreignAccount.publicId }).expect(409);
      await owner.client.post('/promoter/payouts').type('form').send({ ...body, _csrf: token }).expect(302).expect('location', '/promoter/payouts');
      await owner.client.post('/promoter/payouts').type('form').send({ ...body, _csrf: token }).expect(302);
      assert.equal(await Payout.countDocuments({ idempotencyKey: body.idempotencyKey }), 1);
      await owner.client.post('/promoter/payouts').type('form').send({ ...body, _csrf: token, amount: '3000' }).expect(409);
      const page = (await owner.client.get('/promoter/payouts').set('accept', 'application/json')).body;
      assert.equal(page.availableMinor, 7500); assert.equal(page.finance.inFlightPayoutMinor, 2500);
      await owner.client.post('/promoter/payouts').type('form').send({ ...body, _csrf: token, amount: '7501', idempotencyKey: `overdraw_pf_${suffix}` }).expect(409);
      const destination = { method: 'bank', label: 'New programme account', beneficiary_name: 'Promoter account owner', account_bank: 'Test bank', account_number: '123456789' };
      const saved = await owner.client.post('/api/v1/payout-accounts').set('x-csrf-token', token).send({ method: destination.method, label: destination.label, destination }).expect(201);
      assert.equal(saved.body.account.ownerType, 'promoter'); assert.ok(!JSON.stringify(saved.body).includes('destinationEncrypted')); assert.ok(!JSON.stringify(saved.body).includes('123456789'));
      const pending = await PayoutAccount.findOne({ publicId: saved.body.account.publicId }).select('+destinationEncrypted'); assert.equal(pending.status, 'pending'); assert.notEqual(pending.destinationEncrypted, '123456789');
      await owner.client.post('/promoter/payouts').type('form').send({ ...body, _csrf: token, payoutAccountId: pending.publicId, idempotencyKey: `pending_pf_${suffix}` }).expect(409);
    });

    await t.test('shopping currency changes do not move personal programme funds; revoked programme access retains earned funds', async () => {
      await User.updateOne({ _id: owner.user._id }, { $set: { shoppingCountry: 'KE', currency: 'KES' } });
      owner.user.currency = 'KES'; owner.user.shoppingCountry = 'KE';
      await PromoterVerification.updateOne({ _id: verification._id }, { $set: { status: 'rejected' } });
      const page = (await owner.client.get('/promoter/payouts').set('accept', 'application/json').expect(200)).body;
      assert.equal(page.market.country, 'UG'); assert.equal(page.currency, 'UGX'); assert.equal(page.availableMinor, 7500);
      const context = await payoutOwnerContext(scoped(owner)); assert.equal(context.country, 'UG'); assert.equal(context.currency, 'UGX');
      const fresh = await createPromoterPayoutDestination(scoped(owner), { method: 'bank', label: 'Pinned currency', beneficiary_name: 'Promoter', account_bank: 'Bank', account_number: '98765432' });
      assert.equal(fresh.country, 'UG'); assert.equal(fresh.currency, 'UGX');
      const payout = await requestPromoterPayout(scoped(owner), { payoutAccountId: account.publicId, amount: '500', idempotencyKey: `pinned_pf_${suffix}` }); assert.equal(payout.currency, 'UGX'); assert.equal(payout.amountMinor, 500);
    });

    await t.test('concurrent overdraws allow one reservation and use current account verification', async () => {
      const before = await accountBalanceMinor(payable._id);
      const results = await Promise.allSettled([0, 1].map(index => requestPayout(scoped(owner), { payoutAccountId: account.publicId, amountMinor: before, idempotencyKey: `concurrent_pf_${suffix}_${index}` })));
      assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(results.filter(row => row.status === 'rejected' && row.reason.code === 'PAYOUT_BALANCE').length, 1);
      assert.equal(await accountBalanceMinor(payable._id), 0);
      await PayoutAccount.updateOne({ _id: account._id }, { $set: { status: 'disabled' } });
      await assert.rejects(requestPayout(scoped(owner), { payoutAccountId: account.publicId, amountMinor: 1, idempotencyKey: `disabled_pf_${suffix}` }), error => error.code === 'PAYOUT_ACCOUNT_REQUIRED');
      await PayoutAccount.updateOne({ _id: account._id }, { $set: { status: 'verified' } });
    });

    await t.test('pagination, filters and status totals remain exact', async () => {
      const timestamp = new Date(now.getTime() - 10000);
      await Payout.insertMany(Array.from({ length: 27 }, (_, index) => ({ publicId: `pyo_page_pf_${suffix}_${index}`, idempotencyKey: `page_pf_${suffix}_${index}`, ownerUserId: owner.user._id, requestedByUserId: owner.user._id, payoutAccountId: account._id, currency: 'UGX', amountMinor: 1, status: 'failed', createdAt: timestamp })));
      const first = (await owner.client.get('/promoter/payouts?status=failed').set('accept', 'application/json').expect(200)).body;
      assert.equal(first.page.total, 27); assert.equal(first.rows.length, 25); assert.equal(first.finance.payoutsByStatus.failed.count, 27);
      const second = (await owner.client.get('/promoter/payouts?status=failed&after=' + first.page.next).set('accept', 'application/json').expect(200)).body;
      assert.equal(second.rows.length, 2); assert.ok(second.rows.every(row => !first.rows.some(previous => previous.id === row.id)));
      assert.equal((await owner.client.get('/promoter/payouts?search=absent').set('accept', 'application/json')).body.rows.length, 0);
      const paid = (await owner.client.get('/promoter/conversions?status=paid').set('accept', 'application/json')).body; assert.equal(paid.page.total, 1);
    });

    await t.test('a paid order label without a matching payment record never increases verified paid metrics', async () => {
      const unverified = await order(`ord_unverified_pf_${suffix}`);
      const estimate = await CommissionEntry.create({ publicId: `com_unverified_pf_${suffix}`, orderId: unverified._id, orderPublicId: unverified.publicId, campaignId: campaign._id, promoterUserId: owner.user._id, touchId: touch._id, productPublicId: 'prd_unverified', storePublicId: 'sto_brand', currency: 'UGX', amountMinor: 100, commissionBps: 300, policyVersion: 'fixture', status: 'pending', createdAt: now });
      const page = (await owner.client.get('/promoter/conversions').set('accept', 'application/json').expect(200)).body;
      assert.equal(page.analytics.conversions, 3); assert.equal(page.analytics.paidConversions, 1);
      const row = page.conversions.find(item => item.publicId === unverified.publicId); assert.equal(row.paymentState, 'paid'); assert.equal(row.paymentVerified, false);
      const csv = await owner.client.get('/promoter/conversions/export.csv').expect(200); assert.ok(csv.text.includes('Payment verified')); assert.ok(!csv.text.includes('BUYER_EMAIL_PRIVATE'));
      await CommissionEntry.deleteOne({ _id: estimate._id }); await Order.deleteOne({ _id: unverified._id });
    });

    await t.test('appeals are private and atomic; accepting an estimate creates no withdrawable money', async () => {
      const reviewer = await actor('finance'); await User.updateOne({ _id: reviewer.user._id }, { $set: { 'security.mfaEnabled': true } }); reviewer.user.security.mfaEnabled = true;
      const estimate = await CommissionEntry.create({ publicId: `com_appeal_estimate_pf_${suffix}`, orderId: pendingOrder._id, orderPublicId: pendingOrder.publicId, campaignId: campaign._id, promoterUserId: owner.user._id, touchId: touch._id, productPublicId: 'prd_appeal_estimate', storePublicId: 'sto_brand', currency: 'UGX', amountMinor: 4000, reversedAmountMinor: 4000, commissionBps: 300, policyVersion: 'fixture', status: 'reversed', reversalReason: 'Refund estimate' });
      const page = await owner.client.get('/promoter/commissions').expect(200), token = csrf(page.text), message = 'Please review the recorded commission reversal.';
      assert.ok(page.text.includes('/promoter/commissions/' + estimate.publicId + '/appeal'));
      await owner.client.post('/promoter/commissions/' + estimate.publicId + '/appeal').type('form').send({ message }).expect(403);
      await owner.client.post('/promoter/commissions/' + estimate.publicId + '/appeal').type('form').send({ _csrf: token, message: 'short' }).expect(422);
      await other.client.post('/promoter/commissions/' + estimate.publicId + '/appeal').set('x-csrf-token', csrf((await other.client.get('/promoter/commissions')).text)).send({ message }).expect(404);
      await owner.client.post('/promoter/commissions/' + estimate.publicId + '/appeal').set('accept', 'application/json').set('x-csrf-token', token).send({ message }).expect(201);
      assert.equal(await AuditLog.countDocuments({ action: 'promoter.commission_appealed', targetPublicId: estimate.publicId }), 1);
      await owner.client.post('/promoter/commissions/' + estimate.publicId + '/appeal').set('x-csrf-token', token).send({ message }).expect(409);
      await assert.rejects(reviewCommissionAppeal(scoped(owner), estimate.publicId, { decision: 'accept', reason: 'Denied owner review' }), error => error.status === 403);
      await User.updateOne({ _id: reviewer.user._id }, { $set: { country: 'KE' } });
      await assert.rejects(reviewCommissionAppeal(scoped(reviewer), estimate.publicId, { decision: 'accept', reason: 'Denied market review' }), error => error.code === 'FINANCE_COUNTRY_FORBIDDEN');
      await User.updateOne({ _id: reviewer.user._id }, { $set: { country: 'UG' } });
      const before = await accountBalanceMinor(payable._id), beforeTransactions = await LedgerTransaction.countDocuments({ referenceType: 'commission_appeal' });
      t.mock.method(AuditLog, 'create', async () => { throw new Error('Audit storage unavailable'); });
      try { await assert.rejects(reviewCommissionAppeal(scoped(reviewer), estimate.publicId, { decision: 'accept', reason: 'Restore estimate after review' }), /Audit storage unavailable/); } finally { t.mock.restoreAll(); }
      assert.equal((await CommissionEntry.findById(estimate._id)).appeal.status, 'pending');
      const accepted = await reviewCommissionAppeal(scoped(reviewer), estimate.publicId, { decision: 'accept', reason: 'Restore estimate after review' });
      assert.equal(accepted.status, 'pending'); assert.equal(accepted.reversedAmountMinor, 0); assert.equal(accepted.refundedCommissionMinor, 4000); assert.equal(accepted.payableAt, undefined);
      assert.equal(await accountBalanceMinor(payable._id), before); assert.equal(await LedgerTransaction.countDocuments({ referenceType: 'commission_appeal' }), beforeTransactions);
      const evidence = await AuditLog.findOne({ action: 'finance.commission_appeal_reviewed', targetPublicId: estimate.publicId }).lean(); assert.equal(evidence.metadata.restoredPostedMinor, 0);
      await assert.rejects(reviewCommissionAppeal(scoped(reviewer), estimate.publicId, { decision: 'accept', reason: 'Duplicate review' }), error => error.code === 'COMMISSION_APPEAL_NOT_FOUND');
    });

    await t.test('current role, token, verification, onboarding and market configuration fail closed', async () => {
      for (const entry of [customer, superAdmin]) await entry.client.get('/promoter/wallet').set('accept', 'application/json').expect(403);
      const fresh = await actor();
      for (const patch of [{ role: 'finance' }, { status: 'suspended' }, { emailVerifiedAt: null }, { onboardingCompletedAt: null }, { 'security.tokenVersion': 1 }, { platformAccessManagedAt: new Date() }]) {
        await User.updateOne({ _id: fresh.user._id }, { $set: patch });
        await assert.rejects(loadPromoterFinancePage(scoped(fresh), 'promoter-wallet'), error => error.status === 403);
        await assert.rejects(savePayoutAccount(scoped(fresh), { method: 'bank', label: 'Denied account', destination: { account_bank: 'Bank', account_number: '12345678', beneficiary_name: 'Denied user' } }), error => error.status === 403);
        await User.updateOne({ _id: fresh.user._id }, { $set: { role: 'promoter', status: 'active', emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), 'security.tokenVersion': 0 }, $unset: { platformAccessManagedAt: '' } });
      }
      await CountrySetting.updateOne({ code: 'UG' }, { $set: { active: false } });
      await assert.rejects(loadPromoterFinancePage(scoped(fresh), 'promoter-wallet'), error => error.status === 409);
      await CountrySetting.updateOne({ code: 'UG' }, { $set: { active: true } });
      await Device.updateMany({ userId: fresh.user._id }, { $set: { revokedAt: new Date() } });
      await fresh.client.get('/promoter/wallet').set('accept', 'application/json').expect(401);
      assert.equal(await PayoutAccount.countDocuments({ ownerUserId: fresh.user._id }), 0);
    });

    await t.test('commission settlement cannot consume another currency or pending estimate', async () => {
      const { settlePromoterCommissions } = await import('../src/services/promoters.js');
      const session = await mongoose.startSession();
      try { await session.withTransaction(async () => { await settlePromoterCommissions(owner.user._id, 1000, session, { country: 'UG', currency: 'UGX' }); }); } finally { await session.endSession(); }
      assert.equal((await CommissionEntry.findById(commission._id)).paidAmountMinor, 1000);
      assert.equal((await CommissionEntry.findById(foreignCommission._id)).paidAmountMinor, 0);
      assert.equal((await CommissionEntry.findOne({ publicId: `com_pending_pf_${suffix}` })).paidAmountMinor, 0);
    });

    await t.test('verified business credit payment atomically releases commissions and rewards once, without external calls', async () => {
      const buyer = await actor('business'), organizationId = new mongoose.Types.ObjectId(), storeId = new mongoose.Types.ObjectId(), productId = new mongoose.Types.ObjectId(), variantId = new mongoose.Types.ObjectId();
      const invoiceId = new mongoose.Types.ObjectId(), purchaseOrderId = new mongoose.Types.ObjectId(), invoicePublicId = `bin_credit_pf_${suffix}`, storePublicId = `sto_credit_pf_${suffix}`;
      const reservation = await InventoryReservation.create({ publicId: `rsv_credit_pf_${suffix}`, idempotencyKey: `reservation_credit_pf_${suffix}`, storeId, stockItemId: new mongoose.Types.ObjectId(), variantId, quantity: 1, actorUserId: buyer.user._id, status: 'committed', committedAt: old, expiresAt: old });
      const creditOrder = await Order.create({ publicId: `ord_credit_pf_${suffix}`, idempotencyKey: `order_credit_pf_${suffix}`, checkoutId: `checkout_credit_pf_${suffix}`, cartPublicId: `cart_credit_pf_${suffix}`, sessionKey: `session_credit_pf_${suffix}`, userId: buyer.user._id, country: 'UG', status: 'confirmed', paymentMethod: 'credit_terms', paymentState: 'credit_due', deliveryMethod: 'standard', fulfillmentState: 'delivered', businessOrganizationId: organizationId, purchaseOrderId, businessInvoiceId: invoiceId, businessInvoicePublicId: invoicePublicId,
        contact: { fullName: buyer.user.name, email: buyer.user.email, phone: buyer.user.phone, address: '10 Business Road', city: 'Kampala', country: 'Uganda' }, totals: { subtotalMinor: 10000, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 10000, currency: 'UGX' },
        items: [{ linePublicId: `line_credit_pf_${suffix}`, productId, variantId, storeId, reservationPublicId: reservation.publicId, productPublicId: `prd_credit_pf_${suffix}`, variantPublicId: `var_credit_pf_${suffix}`, storePublicId, title: 'Business credit item', variantTitle: 'Standard', sku: `CREDIT_${suffix}`, quantity: 1, unitPriceMinor: 10000, lineTotalMinor: 10000, currency: 'UGX' }], reservationExpiresAt: old });
      const address = { companyName: 'Credit test business', contactName: buyer.user.name, email: buyer.user.email, phone: buyer.user.phone, address: '10 Business Road', city: 'Kampala', country: 'UG' };
      const invoice = await BusinessInvoice.create({ _id: invoiceId, publicId: invoicePublicId, invoiceNumber: `CREDIT-${suffix}`, organizationId, purchaseOrderId, orderId: creditOrder._id, orderPublicId: creditOrder.publicId, storeId, storePublicId, country: 'UG', currency: 'UGX', paymentTerms: 'credit', status: 'open', subtotalMinor: 10000, totalMinor: 10000, paidMinor: 0, billTo: address, shipTo: address, lines: [{ productPublicId: `prd_credit_pf_${suffix}`, variantPublicId: `var_credit_pf_${suffix}`, sku: `CREDIT_${suffix}`, title: 'Business credit item', variantTitle: 'Standard', quantity: 1, unitMinor: 10000, lineMinor: 10000 }] });
      await Shipment.create({ publicId: `shp_credit_pf_${suffix}`, orderId: creditOrder._id, orderPublicId: creditOrder.publicId, country: 'UG', mode: 'standard', status: 'delivered', deliveredAt: old });
      const creditCommission = await CommissionEntry.create({ publicId: `com_credit_pf_${suffix}`, orderId: creditOrder._id, orderPublicId: creditOrder.publicId, campaignId: campaign._id, promoterUserId: owner.user._id, touchId: touch._id, productPublicId: `prd_credit_pf_${suffix}`, storePublicId, currency: 'UGX', amountMinor: 1000, commissionBps: 1000, policyVersion: 'fixture', status: 'pending' });
      const receivable = await ensureLedgerAccount({ code: 'business_accounts_receivable', type: 'asset', ownerType: 'business', ownerId: organizationId, ownerPublicId: String(organizationId), country: 'UG', currency: 'UGX' });
      const sellerPayable = await ensureLedgerAccount({ code: 'seller_payable', type: 'liability', ownerType: 'store', ownerPublicId: storePublicId, country: 'UG', currency: 'UGX' });
      await postLedgerTransaction({ idempotencyKey: `credit_opening_pf_${suffix}`, referenceType: 'business_invoice', referencePublicId: invoice.publicId, country: 'UG', currency: 'UGX', description: 'Existing delivered credit invoice', entries: [{ account: receivable, debitMinor: 10000, creditMinor: 0 }, { account: sellerPayable, debitMinor: 0, creditMinor: 10000 }] });
      const payment = await PaymentIntent.create({ publicId: `pay_credit_pf_${suffix}`, orderId: creditOrder._id, orderPublicId: creditOrder.publicId, country: 'UG', currency: 'UGX', idempotencyKey: `payment_credit_pf_${suffix}`, provider: 'pesapal', method: 'pesapal', purpose: 'business_invoice', status: 'pending', amountMinor: 10000, providerReference: `credit_reference_pf_${suffix}`, providerTrackingId: `credit_tracking_pf_${suffix}` });
      await CountrySetting.updateOne({ code: 'UG' }, { $set: { 'growth.loyaltyEnabled': true, 'growth.loyaltyPointsPer1000Minor': 2, 'growth.referralEnabled': false } });
      const externalRequests = [];
      t.mock.method(globalThis, 'fetch', async input => {
        const endpoint = new URL(String(input)); assert.equal(endpoint.hostname, 'promoter-finance-test.invalid'); externalRequests.push(endpoint.pathname);
        if (endpoint.pathname === '/api/Auth/RequestToken') return new Response(JSON.stringify({ token: 'isolated-verification-token', expiryDate: new Date(Date.now() + 300000).toISOString() }), { status: 200 });
        assert.equal(endpoint.pathname, '/api/Transactions/GetTransactionStatus'); assert.equal(endpoint.searchParams.get('orderTrackingId'), payment.providerTrackingId);
        return new Response(JSON.stringify({ payment_status_description: 'COMPLETED', merchant_reference: payment.providerReference, amount: 10000, currency: 'UGX', confirmation_code: `confirmation_pf_${suffix}`, payment_method: 'Test mobile money' }), { status: 200 });
      });
      const before = await accountBalanceMinor(payable._id);
      t.mock.method(LoyaltyEntry, 'create', async () => { throw new Error('Reward storage unavailable'); });
      try { await assert.rejects(verifyAndApplyPayment(payment.publicId, payment.providerTrackingId), /Reward storage unavailable/); } finally { LoyaltyEntry.create.mock.restore(); }
      assert.equal((await Order.findById(creditOrder._id)).paymentState, 'credit_due'); assert.equal((await BusinessInvoice.findById(invoice._id)).status, 'open');
      assert.equal((await CommissionEntry.findById(creditCommission._id)).status, 'pending'); assert.equal(await accountBalanceMinor(payable._id), before); assert.equal(await LedgerTransaction.countDocuments({ referenceType: 'business_invoice_payment', referencePublicId: invoice.publicId }), 0);
      try {
        assert.equal((await verifyAndApplyPayment(payment.publicId, payment.providerTrackingId)).status, 'succeeded');
        assert.equal((await Order.findById(creditOrder._id)).paymentState, 'paid'); assert.equal((await BusinessInvoice.findById(invoice._id)).status, 'paid');
        const earned = await CommissionEntry.findById(creditCommission._id); assert.equal(earned.status, 'payable'); assert.ok(earned.payableAt); assert.equal(await accountBalanceMinor(payable._id), before + 1000);
        assert.equal(await accountBalanceMinor(receivable._id, null, 'asset'), 0); assert.equal((await LoyaltyAccount.findOne({ userId: buyer.user._id })).points, 20);
        assert.equal(await FinancialDocument.countDocuments({ paymentIntentId: payment._id }), 1);
        assert.equal((await verifyAndApplyPayment(payment.publicId, payment.providerTrackingId)).status, 'succeeded');
        assert.equal(await accountBalanceMinor(payable._id), before + 1000); assert.equal(await LoyaltyEntry.countDocuments({ userId: buyer.user._id, referencePublicId: creditOrder.publicId }), 1);
        assert.equal(await LedgerTransaction.countDocuments({ referenceType: 'business_invoice_payment', referencePublicId: invoice.publicId }), 1);
        const page = (await owner.client.get('/promoter/conversions').set('accept', 'application/json').expect(200)).body;
        assert.equal(page.conversions.find(row => row.publicId === creditOrder.publicId).paymentVerified, true); assert.equal(page.analytics.paidConversions, 2);
        assert.ok(externalRequests.length >= 3);
      } finally { t.mock.restoreAll(); }
    });
  } finally {
    for (const transport of transports) transport.destroy();
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
  }
});

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
const csrf = html => {
  const match = html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/);
  assert.ok(match, 'a real sign-in page contains the CSRF token');
  return match[1];
};

test('Promoter overview uses complete eligible records, real funds and a private pinned-market report', { skip: !uri, timeout: 180_000 }, async t => {
  const endpoint = new URL(uri);
  assert.equal(endpoint.hostname, '127.0.0.1');
  assert.match(endpoint.pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex'), transports = [];
  await mongoose.connect(uri, { dbName: `classicmart_promoter_overview_test_${suffix}` });
  try {
    const { createApp } = await import('../src/app.js');
    const { User, CountrySetting, PromoterVerification, Store, StoreMember, Category, Brand, Product, ProductVariant,
      Campaign, CampaignApplication, PromoterLink, AttributionTouch, CommissionEntry, Order, PaymentIntent, PayoutAccount, Payout, AuditLog } = await import('../src/models/index.js');
    const { hashPassword } = await import('../src/core/crypto.js');
    const { ensureLedgerAccount, postLedgerTransaction } = await import('../src/services/money.js');
    const { loadPromoterOverview, loadPromoterSidebar } = await import('../src/services/promoter-overview.js');
    const { promoterAccess } = await import('../src/services/promoter-workspace-access.js');
    const password = `Overview-${suffix}-A1!`, passwordHash = await hashPassword(password), app = createApp(null);
    const now = new Date(), recent = new Date(now.getTime() - 10_000), started = new Date(now.getTime() - 60 * 86_400_000), ends = new Date(now.getTime() + 60 * 86_400_000);
    let sequence = 0;
    const id = prefix => `${prefix}_ov_${suffix}_${++sequence}`;
    const scoped = (actor, period = '30days') => ({ user: actor.user, session: { tokenVersion: actor.user.security.tokenVersion }, query: { period } });

    async function identity(role = 'promoter', { login = false, patch = {} } = {}) {
      const index = ++sequence, email = `overview-${suffix}-${index}@example.com`, phone = '+25670' + String(index).padStart(7, '0');
      const user = await User.create({ publicId: id('usr'), name: `Overview actor ${index}`, email, emailNormalized: email, phone, phoneNormalized: phone,
        passwordHash, role, country: 'UG', currency: 'UGX', locale: 'en-UG', emailVerifiedAt: now, onboardingCompletedAt: now,
        consents: { terms: true, privacy: true, recordedAt: now }, ...patch });
      if (!login) return { user };
      const transport = new http.Agent({ localAddress: `127.0.0.${transports.length + 40}`, keepAlive: false }); transports.push(transport);
      const client = request.agent(app).use(req => req.agent(transport));
      const page = await client.get('/login').expect(200);
      await client.post('/login').type('form').send({ email, password, _csrf: csrf(page.text) }).expect(302);
      return { user, client };
    }
    async function merchant({ ownerPatch = {}, storePatch = {}, role = 'seller' } = {}) {
      const owner = await identity(role, { patch: ownerPatch });
      const store = await Store.create({ publicId: id('str'), ownerUserId: owner.user._id, name: 'Approved overview merchant', slug: id('overview'),
        country: 'UG', currency: 'UGX', status: 'verified', ...storePatch });
      return { ...owner, store };
    }
    async function product(merchantActor, { productPatch = {}, variantPatch = {}, selectedCategory } = {}) {
      const row = await Product.create({ publicId: id('prd'), ownerUserId: merchantActor.user._id, storeId: merchantActor.store._id, categoryId: (selectedCategory || category)._id,
        title: 'Overview approved product', slug: id('product'), description: 'A genuinely approved product for promoter reporting fixtures.',
        countries: ['UG'], status: 'published', ...productPatch });
      const variant = await ProductVariant.create({ publicId: id('var'), productId: row._id, storeId: merchantActor.store._id, sku: id('SKU'), title: 'Standard offer',
        priceMinor: 10_000, currency: 'UGX', active: true, ...variantPatch });
      return { row, variant };
    }
    async function acceptedCampaign(actor, { merchantActor = seller, selectedProduct = approvedProduct, patch = {}, applicationPatch = {} } = {}) {
      const campaign = await Campaign.create({ publicId: id('cmp'), ownerUserId: merchantActor.user._id, storeId: merchantActor.store._id, country: 'UG',
        name: 'Approved overview campaign ' + sequence, status: 'active', scope: 'seller', commissionBps: 300,
        productPublicIds: [selectedProduct.row.publicId], startsAt: started, endsAt: ends, ...patch });
      const application = await CampaignApplication.create({ publicId: id('cpa'), campaignId: campaign._id, campaignPublicId: campaign.publicId,
        promoterUserId: actor.user._id, country: 'UG', status: 'approved', ...applicationPatch });
      return { campaign, application };
    }
    async function orderAndCommission(actor, { campaign = first.campaign, at = recent, amount = 1000, reversed = 0, country = 'UG', orderCurrency = 'UGX',
      currency = 'UGX', status = 'payable', verifiedPayment = false, mismatchPublicId = false } = {}) {
      const orderId = new mongoose.Types.ObjectId(), publicId = id('ord');
      await Order.collection.insertOne({ _id: orderId, publicId, checkoutId: id('checkout'), cartPublicId: id('cart'), sessionKey: id('order_session'), idempotencyKey: id('order_key'), country, totals: { currency: orderCurrency, totalMinor: 999_999 }, createdAt: at,
        status: 'paid', paymentState: 'paid', fulfillmentState: 'unfulfilled', refundState: 'none',
        contact: { email: 'BUYER_EMAIL_OVERVIEW_PRIVATE', phone: 'BUYER_PHONE_OVERVIEW_PRIVATE' }, items: [{ title: 'UNRELATED_ORDER_LINE_OVERVIEW_PRIVATE' }] });
      const commission = await CommissionEntry.create({ publicId: id('com'), orderId, orderPublicId: mismatchPublicId ? id('ord_mismatch') : publicId,
        campaignId: campaign._id, promoterUserId: actor.user._id, touchId: touch._id, productPublicId: id('prd_commission'), storePublicId: seller.store.publicId,
        amountMinor: amount, reversedAmountMinor: reversed, currency, commissionBps: 300, policyVersion: 'overview-fixture', status,
        ...(status === 'payable' ? { payableAt: at } : {}), createdAt: at });
      if (verifiedPayment) await PaymentIntent.create({ publicId: id('pay'), orderId, orderPublicId: publicId, country, currency: orderCurrency,
        provider: 'wallet', method: 'wallet', purpose: 'order_payment', status: 'succeeded', amountMinor: 999_999, idempotencyKey: id('payment'), paidAt: at });
      return commission;
    }

    // Finish every registered collection/index before fixtures or transactional ledgers.
    await Promise.all(Object.values(mongoose.models).map(model => model.init()));
    await CountrySetting.create([{ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', growth: { promoterCommissionBps: 300 } },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254', growth: { promoterCommissionBps: 300 } }]);
    const owner = await identity('promoter', { login: true }), other = await identity('promoter', { login: true }), customer = await identity('customer', { login: true });
    const verification = await PromoterVerification.create({ publicId: id('prv'), userId: owner.user._id, country: 'UG', status: 'verified' });
    await PromoterVerification.create({ publicId: id('prv'), userId: other.user._id, country: 'UG', status: 'verified' });
    const category = await Category.create({ publicId: id('cat'), name: 'Approved overview products', slug: id('category'), countries: ['UG'] });
    const seller = await merchant(), approvedProduct = await product(seller), first = await acceptedCampaign(owner);
    for (let index = 1; index < 60; index += 1) await acceptedCampaign(owner);
    const programme = await acceptedCampaign(owner, { patch: { scope: 'marketplace', systemManaged: true, productPublicIds: [], name: 'Approved marketplace programme' } });
    const link = await PromoterLink.create({ publicId: id('plk'), promoterUserId: owner.user._id, campaignId: first.campaign._id, token: id('token'), channel: 'whatsapp', destination: '/products/' + approvedProduct.row.publicId });
    const touch = await AttributionTouch.create({ publicId: id('tch'), promoterUserId: owner.user._id, campaignId: first.campaign._id, linkId: link._id, country: 'UG',
      sessionKey: 'OVERVIEW_SESSION_PRIVATE', ipHash: 'OVERVIEW_IP_PRIVATE', userAgentHash: 'OVERVIEW_UA_PRIVATE', landedAt: recent, expiresAt: ends, createdAt: recent });
    for (let index = 1; index < 60; index += 1) await AttributionTouch.create({ publicId: id('tch'), promoterUserId: owner.user._id, campaignId: first.campaign._id, linkId: link._id, country: 'UG',
      sessionKey: id('private_session'), ipHash: id('private_ip'), userAgentHash: id('private_ua'), landedAt: recent, expiresAt: ends, createdAt: recent });
    for (let index = 0; index < 5; index += 1) await AttributionTouch.create({ publicId: id('tch'), promoterUserId: owner.user._id, campaignId: first.campaign._id, linkId: link._id, country: 'UG',
      sessionKey: id('blocked_session'), ipHash: id('blocked_ip'), userAgentHash: id('blocked_ua'), status: 'blocked', landedAt: recent, expiresAt: ends, createdAt: recent });
    for (let index = 0; index < 60; index += 1) await orderAndCommission(owner, { reversed: index % 10 === 0 ? 100 : 0, status: index < 10 ? 'pending' : 'payable', verifiedPayment: index < 40 });

    const payable = await ensureLedgerAccount({ code: 'promoter_payable', type: 'liability', ownerType: 'promoter', ownerPublicId: String(owner.user._id), country: 'UG', currency: 'UGX' });
    const cash = await ensureLedgerAccount({ code: 'overview_cash', type: 'asset', ownerType: 'platform', ownerPublicId: 'classic-mart', country: 'UG', currency: 'UGX' });
    await postLedgerTransaction({ country: 'UG', currency: 'UGX', idempotencyKey: id('earnings'), referenceType: 'test_commission', referencePublicId: id('reference'), description: 'Recorded promoter payable funds',
      entries: [{ account: cash, debitMinor: 12_500, creditMinor: 0 }, { account: payable, debitMinor: 0, creditMinor: 12_500 }] });
    const payoutAccount = await PayoutAccount.create({ publicId: id('poa'), ownerUserId: owner.user._id, ownerType: 'promoter', country: 'UG', currency: 'UGX', method: 'bank', label: 'Owned destination', destinationEncrypted: 'OVERVIEW_DESTINATION_PRIVATE', status: 'verified' });
    const payout = await Payout.create({ publicId: id('pyo'), ownerUserId: owner.user._id, requestedByUserId: owner.user._id, payoutAccountId: payoutAccount._id, idempotencyKey: id('payout'), amountMinor: 2500, currency: 'UGX', status: 'requested' });
    await postLedgerTransaction({ country: 'UG', currency: 'UGX', idempotencyKey: id('payout_hold'), referenceType: 'payout', referencePublicId: payout.publicId, description: 'Payout reservation',
      entries: [{ account: payable, debitMinor: 2500, creditMinor: 0 }, { account: cash, debitMinor: 0, creditMinor: 2500 }] });

    await t.test('overview totals use all sixty records, verified payments and the payable ledger after reservations', async () => {
      const result = await loadPromoterOverview(scoped(owner), { now });
      assert.equal(result.activeCampaigns, 61);
      assert.equal(result.coverage.total, 61); assert.equal(result.coverage.people.length, 4);
      assert.equal(result.analytics.eligibleVisits, 60); assert.equal(result.analytics.blockedVisits, 5);
      assert.equal(result.analytics.conversions, 60); assert.equal(result.analytics.paidConversions, 40);
      assert.equal(result.analytics.commissionMinor, 59_400); assert.equal(result.monthEarnedMinor, 59_400);
      assert.equal(result.availableMinor, 10_000); assert.equal(result.finance.estimatedMinor, 9900); assert.equal(result.finance.inFlightPayoutMinor, 2500);
      assert.equal(result.analytics.trend.reduce((sum, row) => sum + row.visits, 0), 60);
      assert.equal(result.analytics.trend.reduce((sum, row) => sum + row.commissionMinor, 0), 59_400);
      assert.equal(result.metrics[0].value, 60); assert.equal(result.metrics[1].value, 40); assert.equal(result.metrics[3].value, 61);
      assert.ok(result.priorities.some(row => row.text.includes('estimated')));
      const sidebar = await loadPromoterSidebar(await promoterAccess(scoped(owner)), { now });
      assert.equal(sidebar.activeCampaigns, 61); assert.equal(sidebar.monthEarnedMinor, 59_400);
      assert.deepEqual(sidebar.campaignPeople, result.coverage.people);
      for (const slug of ['links', 'wallet', 'profile']) {
        const html = await owner.client.get('/promoter/' + slug).expect(200);
        const card = html.text.match(/<section class="sidebar-club-card">[\s\S]*?<\/section>/)?.[0];
        assert.ok(card, slug + ' has the approved sidebar');
        assert.match(card, /59,400[^<]* recorded commission/); assert.match(card, /61 active campaigns/);
        assert.doesNotMatch(card, /— recorded commission|— active campaigns/);
      }
      const empty = await loadPromoterSidebar(await promoterAccess(scoped(other)), { now });
      assert.equal(empty.activeCampaigns, 0); assert.equal(empty.monthEarnedMinor, 0);
      const emptyHtml = await other.client.get('/promoter/links').expect(200);
      const emptyCard = emptyHtml.text.match(/<section class="sidebar-club-card">[\s\S]*?<\/section>/)?.[0];
      assert.ok(emptyCard); assert.match(emptyCard, /0[^<]* recorded commission/); assert.match(emptyCard, /0 active campaigns/);
      assert.doesNotMatch(emptyCard, /— recorded commission|— active campaigns/);
    });

    await t.test('inactive merchants, owners, product approvals, country offers and policies do not inflate active campaigns', async () => {
      for (const patch of [{ status: 'paused' }, { startsAt: ends }, { endsAt: started }, { country: 'KE' }, { ownerUserId: other.user._id }, { productPublicIds: [approvedProduct.row.publicId, 'prd_unavailable_overview'] }]) await acceptedCampaign(owner, { patch });
      await acceptedCampaign(owner, { applicationPatch: { status: 'revoked' } });
      await acceptedCampaign(owner, { applicationPatch: { campaignPublicId: 'cmp_mismatched_overview' } });
      await acceptedCampaign(owner, { patch: { scope: 'marketplace', systemManaged: true, commissionBps: 500, productPublicIds: [] } });
      await acceptedCampaign(owner, { patch: { scope: 'marketplace', systemManaged: false, commissionBps: 300, productPublicIds: [] } });
      for (const properties of [{ storePatch: { status: 'suspended' } }, { storePatch: { currency: 'KES' } }, { storePatch: { country: 'KE' } },
        { ownerPatch: { status: 'suspended' } }, { ownerPatch: { emailVerifiedAt: null } }, { ownerPatch: { onboardingCompletedAt: null } }, { role: 'customer' }]) {
        const ineligibleMerchant = await merchant(properties), ineligibleProduct = await product(ineligibleMerchant);
        await acceptedCampaign(owner, { merchantActor: ineligibleMerchant, selectedProduct: ineligibleProduct });
      }
      for (const properties of [{ productPatch: { status: 'draft' } }, { productPatch: { countries: ['KE'] } }, { productPatch: { ownerUserId: other.user._id } },
        { productPatch: { moderation: { riskLevel: 'high', secondReviewRequired: true } } }, { variantPatch: { active: false } }, { variantPatch: { currency: 'KES' } }, { variantPatch: { priceMinor: 0 } }]) {
        await acceptedCampaign(owner, { selectedProduct: await product(seller, properties) });
      }
      const rejectedBrand = await Brand.create({ publicId: id('brd'), name: 'Rejected overview brand', slug: id('brand'), status: 'rejected' });
      await acceptedCampaign(owner, { selectedProduct: await product(seller, { productPatch: { brandId: rejectedBrand._id } }) });
      const restricted = await Category.create({ publicId: id('cat'), name: 'Restricted overview products', slug: id('category'), countries: ['UG'], restricted: true });
      await acceptedCampaign(owner, { selectedProduct: await product(seller, { selectedCategory: restricted }) });
      const operated = await merchant(), operatedProduct = await product(operated);
      await StoreMember.create({ publicId: id('stm'), storeId: operated.store._id, userId: owner.user._id, invitedByUserId: operated.user._id, role: 'catalogue', status: 'active', acceptedAt: now });
      await acceptedCampaign(owner, { merchantActor: operated, selectedProduct: operatedProduct });
      assert.equal((await loadPromoterOverview(scoped(owner), { now })).activeCampaigns, 61);
      await CountrySetting.updateOne({ code: 'UG' }, { $set: { 'growth.promoterCommissionBps': 0 } });
      assert.equal((await loadPromoterOverview(scoped(owner), { now })).activeCampaigns, 60);
      await CountrySetting.updateOne({ code: 'UG' }, { $set: { 'growth.promoterCommissionBps': 300 } });
    });

    await t.test('foreign users, countries, currencies, campaign joins and shopper preferences cannot alter owned totals', async () => {
      const foreignCampaign = await acceptedCampaign(owner, { patch: { country: 'KE', name: 'FOREIGN_OVERVIEW_CAMPAIGN_PRIVATE' } });
      const foreignLink = await PromoterLink.create({ publicId: id('plk'), promoterUserId: owner.user._id, campaignId: foreignCampaign.campaign._id, token: id('token'), destination: '/products', channel: 'FOREIGN_OVERVIEW_CHANNEL_PRIVATE' });
      for (const properties of [{ country: 'KE' }, { orderCurrency: 'KES' }, { currency: 'KES', orderCurrency: 'KES', country: 'KE' }, { campaign: foreignCampaign.campaign }, { mismatchPublicId: true }]) await orderAndCommission(owner, { amount: 900_000, ...properties });
      await AttributionTouch.create({ publicId: id('tch'), promoterUserId: owner.user._id, campaignId: foreignCampaign.campaign._id, linkId: foreignLink._id, country: 'UG', sessionKey: id('foreign'), ipHash: id('hash'), userAgentHash: id('hash'), landedAt: recent, expiresAt: ends });
      await AttributionTouch.create({ publicId: id('tch'), promoterUserId: owner.user._id, campaignId: first.campaign._id, linkId: link._id, country: 'KE', sessionKey: id('foreign'), ipHash: id('hash'), userAgentHash: id('hash'), landedAt: recent, expiresAt: ends });
      await orderAndCommission(other, { amount: 750_000 });
      await CampaignApplication.create({ publicId: id('cpa'), campaignId: first.campaign._id, campaignPublicId: first.campaign.publicId, promoterUserId: other.user._id, country: 'UG', status: 'approved' });
      await User.updateOne({ _id: owner.user._id }, { $set: { shoppingCountry: 'KE', currency: 'KES', timeZone: 'America/New_York' } });
      owner.user.shoppingCountry = 'KE'; owner.user.currency = 'KES'; owner.user.timeZone = 'America/New_York';
      const result = await loadPromoterOverview(scoped(owner), { now });
      assert.equal(result.market.country, 'UG'); assert.equal(result.currency, 'UGX'); assert.equal(result.timeZone, 'Africa/Kampala');
      assert.equal(result.analytics.eligibleVisits, 60); assert.equal(result.analytics.commissionMinor, 59_400); assert.equal(result.monthEarnedMinor, 59_400);
      assert.equal(result.activeCampaigns, 61); assert.equal(result.availableMinor, 10_000);
      assert.ok(!JSON.stringify(result).includes('FOREIGN_OVERVIEW'));
      const foreign = await loadPromoterOverview(scoped(other), { now });
      assert.equal(foreign.activeCampaigns, 1); assert.equal(foreign.analytics.commissionMinor, 750_000); assert.equal(foreign.availableMinor, 0);
      assert.equal(foreign.analytics.eligibleVisits, 0); assert.equal(foreign.monthEarnedMinor, 750_000);
      const sidebar = await loadPromoterSidebar(await promoterAccess(scoped(owner)), { now });
      assert.equal(sidebar.activeCampaigns, 61); assert.equal(sidebar.monthEarnedMinor, 59_400);
    });

    await t.test('current-month commission uses Kampala midnight and excludes records at the report end', async () => {
      const fixedNow = new Date('2026-10-01T01:00:00.000Z'), monthStart = new Date('2026-09-30T21:00:00.000Z');
      await orderAndCommission(owner, { at: new Date(monthStart.getTime() - 1), amount: 500 });
      await orderAndCommission(owner, { at: monthStart, amount: 700, reversed: 200 });
      await orderAndCommission(owner, { at: new Date(fixedNow.getTime() - 1), amount: 900 });
      await orderAndCommission(owner, { at: fixedNow, amount: 800 });
      const result = await loadPromoterOverview(scoped(owner), { now: fixedNow });
      assert.equal(result.monthEarnedMinor, 1400);
      assert.equal(result.analytics.commissionMinor, 1900);
      assert.equal(result.analytics.trend.reduce((sum, row) => sum + row.commissionMinor, 0), 1900);
      assert.equal(result.availableMinor, 10_000, 'reporting periods do not change actual ledger funds');
    });

    await t.test('the real overview and CSV use private headers, valid scalar periods, no buyer identifiers and export evidence', async () => {
      const json = await owner.client.get('/promoter/overview?period=year').set('accept', 'application/json').expect(200);
      assert.equal(json.body.period, 'year'); assert.equal(json.body.activeCampaigns, 61);
      assert.match(json.headers['cache-control'], /private/); assert.match(json.headers['cache-control'], /no-store/);
      assert.equal(json.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
      const html = await owner.client.get('/promoter/overview').expect(200);
      assert.match(html.text, /data-dashboard-workspace="promoter"/); assert.match(html.text, /role-overview/);
      assert.doesNotMatch(html.text, /Development preview|role-workspaces\.js|Customer Club|aria-label="Wishlist"|aria-label="Cart"/);
      const csv = await owner.client.get('/promoter/overview/summary.csv?period=7months').expect(200);
      assert.match(csv.headers['content-type'], /text\/csv/); assert.match(csv.headers['content-disposition'], /attachment/);
      assert.match(csv.headers['cache-control'], /private/); assert.equal(csv.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
      assert.match(csv.text, /"UG","UGX","Africa\/Kampala","7months"/); assert.match(csv.text, /"Eligible visits","60"/);
      for (const hidden of ['BUYER_EMAIL_OVERVIEW_PRIVATE', 'BUYER_PHONE_OVERVIEW_PRIVATE', 'UNRELATED_ORDER_LINE_OVERVIEW_PRIVATE',
        'OVERVIEW_DESTINATION_PRIVATE', 'OVERVIEW_SESSION_PRIVATE', 'OVERVIEW_IP_PRIVATE', 'OVERVIEW_UA_PRIVATE', 'FOREIGN_OVERVIEW', owner.user.email, other.user.email]) {
        assert.ok(!csv.text.includes(hidden), hidden); assert.ok(!JSON.stringify(json.body).includes(hidden), hidden);
      }
      assert.equal(await AuditLog.countDocuments({ actorId: owner.user._id, action: 'promoter.overview_exported' }), 1);
      for (const path of ['/promoter/overview', '/promoter/overview/summary.csv']) {
        await owner.client.get(path + '?period=').set('accept', 'application/json').expect(422);
        await owner.client.get(path + '?period=all').set('accept', 'application/json').expect(422);
        await owner.client.get(path + '?period=year&period=30days').set('accept', 'application/json').expect(422);
        await owner.client.get(path + '?period[bad]=year').set('accept', 'application/json').expect(422);
        await customer.client.get(path).set('accept', 'application/json').expect(403);
        await request(app).get(path).set('accept', 'application/json').expect(401);
      }
      await owner.client.get('/dashboard/promoter-overview?period=year').expect(308).expect('location', '/promoter/overview?period=year');
    });

    await t.test('CSV neutralizes a stored formula-looking market value and revoked verification removes actionable campaign relationships', async () => {
      // CSV remains safe even if previously imported configuration contains a formula prefix.
      await CountrySetting.create({ code: '=X', name: 'Imported market', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256' });
      await PromoterVerification.updateOne({ _id: verification._id }, { $set: { country: '=X' } });
      const csv = await owner.client.get('/promoter/overview/summary.csv').expect(200);
      assert.match(csv.text, /"'=X","UGX","Africa\/Kampala","30days"/);
      await PromoterVerification.updateOne({ _id: verification._id }, { $set: { country: 'UG', status: 'rejected' } });
      const result = await loadPromoterOverview(scoped(owner), { now });
      assert.equal(result.activeCampaigns, 0); assert.equal(result.coverage.total, 0); assert.deepEqual(result.coverage.people, []);
      assert.equal(result.availableMinor, 10_000, 'programme revocation does not hide personally earned ledger funds');
      assert.ok(result.priorities.some(row => row.href === '/promoter/profile?section=business'));
      const sidebar = await loadPromoterSidebar(await promoterAccess(scoped(owner)), { now });
      assert.equal(sidebar.activeCampaigns, 0); assert.deepEqual(sidebar.campaignPeople, []);
    });
    assert.ok(programme.campaign.systemManaged);
  } finally {
    for (const transport of transports) transport.destroy();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

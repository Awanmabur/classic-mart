import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';
import sharp from 'sharp';

const suffix = crypto.randomBytes(8).toString('hex');
Object.assign(process.env, { NODE_ENV: 'test', SIMPLE_LOGIN: 'false', PRIVILEGED_MFA_REQUIRED: 'true',
  MAIL_MODE: 'log', SMS_MODE: 'log', REDIS_URL: '', MEDIA_STORAGE_DRIVER: 'filesystem',
  UPLOAD_DIR: '/tmp/classicmart-aftersales-' + suffix });
for (const name of ['SESSION_SECRET', 'TOKEN_PEPPER', 'SECURITY_INTEGRITY_KEY', 'DATA_ENCRYPTION_KEY']) process.env[name] = crypto.randomBytes(32).toString('hex');
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('real aftersales HTTP consent, specialist departments and private seller order cases preserve actual source outcomes', { skip: !uri, timeout: 240_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1'); assert.match(new URL(uri).pathname, /verification|test/i);
  await mongoose.connect(uri, { dbName: 'classicmart_aftersales_test_' + suffix });
  const transports = [];
  try {
    const { createApp } = await import('../src/app.js');
    const { User, PlatformGrant, CountrySetting, Store, StoreMember, Category, Product, ProductVariant, Warehouse,
      StockItem, Order, SellerOrder, Shipment, ReturnRequest, WarehouseTask, PaymentIntent, Refund, EvidenceDocument,
      LedgerTransaction, AuditLog, Device, Dispute, SupportTicket, Notification } = await import('../src/models/index.js');
    const { SpecialistReferral } = await import('../src/models/SpecialistReferral.js');
    const cases = await import('../src/services/support-case-pages.js');
    const specialists = await import('../src/services/specialist-order-cases.js');
    const resolution = await import('../src/services/return-resolution.js');
    const { currentCustomerAccess } = await import('../src/services/customer-access.js');
    const tickets = await import('../src/services/support-ticket-pages.js');
    const { mutateWarehouse } = await import('../src/services/warehouse-operations.js');
    const { ensureLedgerAccount, postLedgerTransaction } = await import('../src/services/money.js');
    const { hashPassword, hashToken } = await import('../src/core/crypto.js');
    const { encryptSensitive } = await import('../src/core/sensitive.js');
    const { totpCode } = await import('../src/services/mfa.js');
    await Promise.all(Object.values(mongoose.models).map(Model => Model.init()));
    await CountrySetting.create([{ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256' },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254' }]);
    let sequence = 0;
    const id = kind => `${kind}_as_${suffix}_${++sequence}`, secret = 'JBSWY3DPEHPK3PXP', password = 'Aftersales-' + suffix + '-A1!';
    const passwordHash = await hashPassword(password), app = createApp(null);
    async function actor(role, { countries = ['UG'], managed = !['customer', 'seller'].includes(role), login = true, mfa = role !== 'customer' } = {}) {
      const number = ++sequence, email = `aftersales-${suffix}-${number}@example.com`, phone = '+25670' + String(number).padStart(7, '0');
      const user = await User.create({ publicId: id('usr'), name: 'Aftersales operator ' + number, email, emailNormalized: email,
        phone, phoneNormalized: phone, passwordHash, role: managed ? 'customer' : role, country: countries[0], currency: countries[0] === 'KE' ? 'KES' : 'UGX',
        operationalCountries: countries, emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
        platformAccessManagedAt: managed ? new Date() : undefined, security: { mfaEnabled: mfa, mfaSecretEncrypted: mfa ? encryptSensitive(secret) : undefined },
        consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const grant = managed ? await PlatformGrant.create({ publicId: id('pgr'), userId: user._id, role, operationalCountries: countries,
        status: 'active', startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000), reason: 'Aftersales source fixture',
        approvalPublicId: id('apr'), approvedByUserId: new mongoose.Types.ObjectId() }) : null;
      let client;
      if (login) {
        const transport = new http.Agent({ localAddress: '127.0.0.' + (number % 100 + 100), keepAlive: false }); transports.push(transport);
        client = request.agent(app).use(req => req.agent(transport));
        const page = await client.get('/login').expect(200);
        await client.post('/login').type('form').send({ email, password, _csrf: csrf(page.text) }).expect(302);
        if (mfa) { const page = await client.get('/mfa').expect(200); await client.post('/mfa').type('form').send({ code: totpCode(secret), _csrf: csrf(page.text) }).expect(302); }
      }
      return { user, grant, client };
    }
    const support = await actor('support'), finance = await actor('finance'), financeSecond = await actor('finance'),
      moderator = await actor('moderator'), admin = await actor('country_admin'), foreignFinance = await actor('finance', { countries: ['KE'] }),
      receiving = await actor('warehouse', { login: false }), buyer = await actor('customer'), otherBuyer = await actor('customer'),
      seller = await actor('seller'), otherSeller = await actor('seller'), catalogue = await actor('customer', { mfa: true });
    const req = (entry, query = {}) => ({ id: id('req'), user: entry.user, session: { tokenVersion: entry.user.security.tokenVersion, mfaVerifiedAt: Date.now() },
      query, ip: '127.0.0.1', get: () => 'AftersalesFixture/1.0' });
    const category = await Category.create({ publicId: id('cat'), name: 'Aftersales goods', slug: id('category'), countries: ['UG'] });
    const store = await Store.create({ publicId: id('sto'), ownerUserId: seller.user._id, name: 'Aftersales store', slug: id('store'), country: 'UG', currency: 'UGX', status: 'verified' });
    const otherStore = await Store.create({ publicId: id('sto'), ownerUserId: otherSeller.user._id, name: 'Unrelated store', slug: id('store'), country: 'UG', currency: 'UGX', status: 'verified' });
    await StoreMember.create([{ publicId: id('stm'), storeId: store._id, userId: seller.user._id, role: 'owner', status: 'active', invitedByUserId: seller.user._id },
      { publicId: id('stm'), storeId: otherStore._id, userId: otherSeller.user._id, role: 'owner', status: 'active', invitedByUserId: otherSeller.user._id },
      { publicId: id('stm'), storeId: store._id, userId: catalogue.user._id, role: 'catalogue', status: 'active', acceptedAt: new Date(), invitedByUserId: seller.user._id }]);
    const product = await Product.create({ publicId: id('prd'), storeId: store._id, ownerUserId: seller.user._id, categoryId: category._id,
      title: 'Exact delivered goods', slug: id('product'), description: 'Actual return inspection fixture', countries: ['UG'], status: 'published' });
    const variant = await ProductVariant.create({ publicId: id('var'), productId: product._id, storeId: store._id, sku: id('sku').toUpperCase(), title: 'Standard', priceMinor: 10_000, costMinor: 5000, currency: 'UGX' });
    const warehouse = await Warehouse.create({ publicId: id('whs'), storeId: store._id, ownerUserId: seller.user._id, name: 'Actual receiving point', country: 'UG', city: 'Kampala', address: 'Receiving fixture' });
    const stock = await StockItem.create({ publicId: id('stk'), storeId: store._id, warehouseId: warehouse._id, variantId: variant._id, onHand: 10, reserved: 0, damaged: 0, quarantined: 0 });
    await PlatformGrant.updateOne({ _id: receiving.grant._id }, { $set: { warehouseScopes: [warehouse.publicId] } });
    const image = await sharp({ create: { width: 360, height: 360, channels: 3, background: '#d4e5e5' } }).png().toBuffer();
    async function paidOrder({ owner = buyer, country = 'UG', settle = true } = {}) {
      const currency = country === 'KE' ? 'KES' : 'UGX', line = id('oli');
      const order = await Order.create({ publicId: id('ord'), idempotencyKey: id('checkout'), checkoutId: id('checkout'), cartPublicId: id('crt'), sessionKey: id('session'),
        userId: owner.user._id, country, status: 'paid', paymentState: 'paid', fulfillmentState: 'delivered', deliveryMethod: 'standard', paymentMethod: 'cod',
        contact: { fullName: 'BUYER_PRIVATE_NAME', email: owner.user.email, phone: owner.user.phone, address: 'BUYER_PRIVATE_ADDRESS', city: 'Kampala', country },
        totals: { subtotalMinor: 20_000, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 20_000, currency }, reservationExpiresAt: new Date(Date.now() + 86_400_000),
        items: [{ linePublicId: line, productId: product._id, variantId: variant._id, storeId: store._id, storePublicId: store.publicId, reservationPublicId: id('rsv'),
          productPublicId: product.publicId, variantPublicId: variant.publicId, sku: variant.sku, title: product.title, variantTitle: variant.title,
          quantity: 2, deliveredQuantity: 2, unitPriceMinor: 10_000, lineTotalMinor: 20_000, currency }] });
      const intent = await PaymentIntent.create({ publicId: id('pay'), orderId: order._id, orderPublicId: order.publicId, country, currency,
        idempotencyKey: id('payment'), provider: 'cod', method: 'cod', status: 'succeeded', amountMinor: 20_000, paidAt: new Date(), providerReference: id('cod') });
      const shipment = await Shipment.create({ publicId: id('shp'), orderId: order._id, orderPublicId: order.publicId, country, mode: 'standard', kind: 'outbound',
        status: 'delivered', deliveredAt: new Date(), proof: { type: 'otp', reference: 'verified', recordedAt: new Date() },
        cod: { required: true, amountMinor: 20_000, currency, collectedMinor: 20_000, reconciledAt: new Date() } });
      await SellerOrder.create({ publicId: id('sord'), orderId: order._id, orderPublicId: order.publicId, storeId: store._id, storePublicId: store.publicId,
        country, status: 'fulfilled', subtotalMinor: 20_000, platformFeeMinor: 1000, currency,
        items: [{ orderLineId: line, productPublicId: product.publicId, variantPublicId: variant.publicId, title: product.title, quantity: 2,
          unitPriceMinor: 10_000, lineTotalMinor: 20_000, currency, grossMinor: 20_000, customerPaidMinor: 20_000, platformFeeMinor: 1000, sellerReceivableMinor: 19_000 }] });
      if (settle) {
        const cash = await ensureLedgerAccount({ code: 'cod_clearing', type: 'asset', ownerType: 'platform', ownerPublicId: 'classic-mart', country, currency });
        const payable = await ensureLedgerAccount({ code: 'seller_payable', type: 'liability', ownerType: 'store', ownerPublicId: store.publicId, country, currency });
        const fee = await ensureLedgerAccount({ code: 'platform_revenue', type: 'revenue', ownerType: 'platform', ownerPublicId: 'classic-mart', country, currency });
        await postLedgerTransaction({ idempotencyKey: 'cod:' + shipment.publicId, referenceType: 'cod_reconciliation', referencePublicId: shipment.publicId,
          country, currency, description: 'Verified original COD receipt fixture', entries: [{ account: cash, debitMinor: 20_000, creditMinor: 0 },
            { account: payable, debitMinor: 0, creditMinor: 19_000 }, { account: fee, debitMinor: 0, creditMinor: 1000 }] });
      }
      return { order, intent, line, owner };
    }
    async function post(entry, path, body, { page = '/support/returns', status = 200 } = {}) {
      const html = await entry.client.get(page).expect(200);
      return entry.client.post(path).set('x-csrf-token', csrf(html.text)).set('accept', 'application/json').send(body).expect(status);
    }
    const version = async (Model, row) => Number((await Model.findById(row._id)).__v || 0);
    async function inspectedExchange(fixture = null) {
      const source = fixture || await paidOrder(), html = await source.owner.client.get('/returns').expect(200);
      const created = await source.owner.client.post('/api/v1/returns').set('x-csrf-token', csrf(html.text)).send({ orderId: source.order.publicId,
        items: [{ orderLineId: source.line, quantity: 1 }], reason: 'damaged', details: 'Actual delivered goods require receipt and an inspected exchange.', resolution: 'exchange', returnMethod: 'dropoff' }).expect(201);
      const returned = await ReturnRequest.findOne({ publicId: created.body.returnRequest.publicId });
      await post(support, '/support/returns/' + returned.publicId + '/decision', { version: returned.__v, decision: 'approve', note: 'Approved actual delivered goods for warehouse receipt and inspection.' });
      const receipt = await cases.uploadWarehouseReturnIntakeEvidence(req(receiving), returned.publicId,
        { version: await version(ReturnRequest, returned), orderLineId: source.line, warehousePublicId: warehouse.publicId }, { buffer: image, mimetype: 'image/png', originalname: 'actual-receipt.png' });
      await cases.recordWarehouseReturnIntake(req(receiving), returned.publicId, { version: receipt.version, orderLineId: source.line, warehousePublicId: warehouse.publicId, evidencePublicId: receipt.evidencePublicId });
      const task = await WarehouseTask.findOne({ returnRequestId: returned._id });
      await mutateWarehouse({ ...req(receiving), params: { publicId: task.publicId }, body: { version: task.__v } }, 'claim');
      await mutateWarehouse({ ...req(receiving), params: { publicId: task.publicId }, body: { version: await version(WarehouseTask, task), disposition: 'damaged' } }, 'execute');
      await post(support, '/support/returns/' + returned.publicId + '/inspect', { version: await version(ReturnRequest, returned), condition: 'damaged', notes: 'Confirmed actual completed damaged warehouse disposition of the received unit.' });
      return { ...source, returned, receipt, task };
    }
    const primary = await inspectedExchange();
    let proposal;
    await t.test('Support offers an actual original-payment alternative; only the owning buyer can consent', async () => {
      const path = '/support/returns/' + primary.returned.publicId + '/refund-proposal', body = { version: await version(ReturnRequest, primary.returned), reason: 'The inspected goods can instead be refunded to their verified original payment.' };
      await support.client.post(path).set('accept', 'application/json').send(body).expect(403);
      await post(support, path, { ...body, version: '' }, { status: 422 });
      await post(support, path, { ...body, version: 999 }, { status: 409 });
      const beforeStock = await StockItem.findById(stock._id).lean();
      const result = await post(support, path, body); proposal = result.body.returnRequest;
      assert.equal((await ReturnRequest.findById(primary.returned._id)).status, 'exchange_pending');
      assert.equal(await Refund.countDocuments(), 0); assert.equal(await Order.countDocuments({ paymentMethod: 'exchange' }), 0);
      assert.deepEqual(await StockItem.findById(stock._id).lean(), beforeStock);
      await post(support, '/support/returns/' + primary.returned.publicId + '/exchange', { version: proposal.version }, { status: 409 });
      const buyerPage = await buyer.client.get('/account/returns').expect(200); assert.match(buyerPage.text, /Accept refund alternative/);
      const decision = { version: proposal.version, proposalPublicId: proposal.proposalPublicId, decision: 'accept' };
      await post(otherBuyer, '/account/returns/' + primary.returned.publicId + '/refund-proposal', decision, { page: '/account/returns', status: 404 });
      await PaymentIntent.updateOne({ _id: primary.intent._id }, { $set: { providerReference: 'changed-source' } });
      await post(buyer, '/account/returns/' + primary.returned.publicId + '/refund-proposal', decision, { page: '/account/returns', status: 409 });
      await PaymentIntent.updateOne({ _id: primary.intent._id }, { $set: { providerReference: primary.intent.providerReference } });
      await post(buyer, '/account/returns/' + primary.returned.publicId + '/refund-proposal', decision, { page: '/account/returns' });
      const accepted = await ReturnRequest.findById(primary.returned._id);
      assert.equal(accepted.status, 'refund_pending'); assert.equal(accepted.resolution, 'refund'); assert.equal(accepted.resolutionChange.status, 'accepted');
      assert.equal(String(accepted.resolutionChange.respondedByUserId), String(buyer.user._id)); assert.match(accepted.resolutionChange.sourceHash, /^[a-f0-9]{64}$/);
      assert.equal(await Refund.countDocuments(), 0); assert.equal(await LedgerTransaction.countDocuments({ referenceType: 'refund' }), 0);
      await post(buyer, '/account/returns/' + primary.returned.publicId + '/refund-proposal', decision, { page: '/account/returns', status: 409 });
    });
    await t.test('decline remains available after a source is unavailable, and no receipt or payment can be invented', async () => {
      const declined = await inspectedExchange();
      const result = await post(support, '/support/returns/' + declined.returned.publicId + '/refund-proposal', { version: await version(ReturnRequest, declined.returned), reason: 'A refund is available for the exact inspected unit if you explicitly choose it.' });
      await EvidenceDocument.updateOne({ publicId: declined.receipt.evidencePublicId }, { $set: { status: 'quarantined' } });
      await post(buyer, '/account/returns/' + declined.returned.publicId + '/refund-proposal', { version: result.body.returnRequest.version,
        proposalPublicId: result.body.returnRequest.proposalPublicId, decision: 'decline' }, { page: '/account/returns' });
      const saved = await ReturnRequest.findById(declined.returned._id); assert.equal(saved.status, 'exchange_pending'); assert.equal(saved.resolutionChange.status, 'declined');
      await post(support, '/support/returns/' + declined.returned.publicId + '/refund-proposal', { version: saved.__v, reason: 'Attempt to replace the buyer’s already recorded decision without new consent.' }, { status: 409 });
      const missingPayment = await inspectedExchange(await paidOrder({ settle: false }));
      await post(support, '/support/returns/' + missingPayment.returned.publicId + '/refund-proposal', { version: await version(ReturnRequest, missingPayment.returned), reason: 'A status label alone cannot substitute for the original immutable payment settlement.' }, { status: 409 });
      assert.equal((await ReturnRequest.findById(missingPayment.returned._id)).resolutionChange?.publicId, undefined);
    });
    await t.test('accepted inspection hash survives Finance reservation and actual independent ledger completion', async () => {
      const accepted = await ReturnRequest.findById(primary.returned._id), hash = accepted.resolutionChange.sourceHash;
      await post(support, '/support/returns/' + accepted.publicId + '/refer-finance', { version: accepted.__v, note: 'Buyer explicitly accepted the verified original-payment refund for exact inspected goods.' });
      await ReturnRequest.updateOne({ _id: accepted._id }, { $set: { 'inspection.notes': 'Out-of-band change to the accepted inspected source' } });
      await finance.client.get('/finance/refunds?return=' + accepted.publicId).set('accept', 'application/json').expect(409);
      await ReturnRequest.updateOne({ _id: accepted._id }, { $set: { 'inspection.notes': accepted.inspection.notes } });
      const flow = await finance.client.get('/finance/refunds?return=' + accepted.publicId).set('accept', 'application/json').expect(200);
      const result = await post(finance, '/finance/refunds', { orderId: primary.order.publicId, returnPublicId: accepted.publicId,
        returnVersion: flow.body.refundOrder.returnVersion, version: flow.body.refundOrder.payment.version, idempotencyKey: flow.body.idempotencyKey,
        amountMinor: 10_000, reason: 'Independent refund of exact inspected goods following explicit buyer consent' }, { page: '/finance/refunds', status: 201 });
      const refund = result.body.refund;
      assert.equal(refund.status, 'processing'); assert.equal((await ReturnRequest.findById(accepted._id)).status, 'refund_processing');
      assert.equal(await LedgerTransaction.countDocuments({ idempotencyKey: 'refund:' + refund.publicId }), 0);
      await post(finance, '/finance/refunds/' + refund.publicId + '/complete', { version: refund.version, reference: 'actual-independent-cash-refund' }, { page: '/finance/refunds', status: 403 });
      await post(financeSecond, '/finance/refunds/' + refund.publicId + '/complete', { version: refund.version, reference: 'actual-independent-cash-refund' }, { page: '/finance/refunds' });
      const ledger = await LedgerTransaction.findOne({ idempotencyKey: 'refund:' + refund.publicId }); assert.ok(ledger);
      assert.equal(ledger.entries.reduce((sum, row) => sum + row.creditMinor, 0), 10_000);
      assert.equal(ledger.entries.reduce((sum, row) => sum + row.debitMinor, 0), 10_000);
      assert.equal((await ReturnRequest.findById(accepted._id)).status, 'refunded');
      assert.equal((await ReturnRequest.findById(accepted._id)).resolutionChange.sourceHash, hash);
    });
    async function referredCase(department, { fixture = null } = {}) {
      const source = fixture || await paidOrder();
      const { createDispute } = await import('../src/services/trust.js');
      const dispute = await createDispute(req(source.owner), { orderId: source.order.publicId, category: 'damaged', subject: 'Exact order case needing specialist review', description: 'BUYER_PRIVATE_DESCRIPTION: review the original delivered goods and saved private evidence.' });
      await post(support, '/support/escalations/' + dispute.publicId + '/assign', { version: dispute.__v }, { page: '/support/escalations' });
      await post(support, '/support/escalations/' + dispute.publicId + '/review', { version: await version(Dispute, dispute), notes: 'SUPPORT_PRIVATE_REVIEW: source-bound investigation needs an independent departmental assessment.', message: 'We are checking the actual order records and evidence.' }, { page: '/support/escalations' });
      await post(support, '/support/escalations/' + dispute.publicId + '/escalate', { version: await version(Dispute, dispute), department,
        reason: 'SUPPORT_PRIVATE_REASON: please investigate this exact saved order source before recommending a resolution.',
        message: 'An independent specialist will review the saved order case.', ...(department === 'seller' ? { storePublicId: store.publicId, sellerMessage: 'Please explain the condition of the delivered goods from your own store order lines.' } : {}) }, { page: '/support/escalations' });
      return { ...source, dispute, referral: await SpecialistReferral.findOne({ disputeId: dispute._id }) };
    }
    await t.test('Finance, Moderation and Country Admin claim and return real departmental assessments', async () => {
      for (const [department, actor, workspace, base] of [['finance', finance, 'finance', '/finance/order-cases'], ['moderation', moderator, 'moderator', '/moderation/order-cases'], ['delivery', admin, 'admin', '/admin/order-cases']]) {
        const fixture = await referredCase(department), selected = base + '?record=' + fixture.referral.publicId;
        const html = await actor.client.get(selected).expect(200); assert.match(html.text, /Claim order case/); assert.match(html.headers['cache-control'], /no-store/); assert.match(html.headers['x-robots-tag'], /noindex/);
        const flow = await actor.client.get(selected).set('accept', 'application/json').expect(200); assert.equal(flow.body.metrics.length, 4); assert.equal(flow.body.selected.orderPublicId, fixture.order.publicId);
        await foreignFinance.client.get('/finance/order-cases?record=' + fixture.referral.publicId).set('accept', 'application/json').expect(404);
        await post(actor, base + '/' + fixture.referral.publicId + '/claim', { version: 999 }, { page: base, status: 409 });
        const claimed = await post(actor, base + '/' + fixture.referral.publicId + '/claim', { version: fixture.referral.__v }, { page: base });
        await post(support, '/support/escalations/' + fixture.dispute.publicId + '/resolve', { version: await version(Dispute, fixture.dispute), decision: 'customer_service', summary: 'Attempt to resolve without the receiving specialist’s actual response.' }, { page: '/support/escalations', status: 409 });
        const result = await post(actor, base + '/' + fixture.referral.publicId + '/respond', { version: claimed.body.referral.version, finding: 'recommendation', summary: department + ' PRIVATE_SPECIALIST_RESPONSE: reviewed the saved source; Support must separately verify actual payment or delivery outcomes.' }, { page: base });
        assert.equal(result.body.referral.status, 'responded'); assert.equal((await Dispute.findById(fixture.dispute._id)).status, 'investigating');
        const ticket = await SupportTicket.findById(fixture.referral.ticketId); assert.ok(ticket.notes.some(note => note.internal && note.message.includes('PRIVATE_SPECIALIST_RESPONSE')));
        const history = await support.client.get('/support/escalations?record=' + fixture.dispute.publicId).set('accept', 'application/json').expect(200);
        assert.ok(history.body.selected.specialistReferrals.some(row => row.publicId === fixture.referral.publicId && row.response));
        const customer = await buyer.client.get('/returns').expect(200); assert.ok(!customer.text.includes('PRIVATE_SPECIALIST_RESPONSE'));
        await assert.rejects(specialists.mutateSpecialistOrderCase(req(support), workspace, fixture.referral.publicId, 'claim', { version: result.body.referral.version }), error => error.status === 403);
        await post(support, '/support/escalations/' + fixture.dispute.publicId + '/resolve', { version: await version(Dispute, fixture.dispute), decision: 'refund_confirmed', summary: 'An assessment alone cannot confirm any actual original-payment refund.' }, { page: '/support/escalations', status: 409 });
      }
    });
    await t.test('seller /cases is a private current-store order queue, distinct from policy TrustCases', async () => {
      const fixture = await referredCase('seller'), base = '/seller/cases';
      const flow = await seller.client.get(base + '?record=' + fixture.referral.publicId).set('accept', 'application/json').expect(200);
      assert.equal(flow.body.kind, 'specialist'); assert.equal(flow.body.metrics.length, 4); assert.equal(flow.body.selected.items.length, 1);
      for (const secret of ['BUYER_PRIVATE_NAME', 'BUYER_PRIVATE_ADDRESS', 'BUYER_PRIVATE_DESCRIPTION', 'SUPPORT_PRIVATE_REVIEW', 'SUPPORT_PRIVATE_REASON', buyer.user.email]) assert.ok(!JSON.stringify(flow.body).includes(secret), secret);
      await otherSeller.client.get(base + '?record=' + fixture.referral.publicId).set('accept', 'application/json').expect(404);
      await catalogue.client.get(base).set('accept', 'application/json').expect(403);
      const policy = await seller.client.get('/seller/trust-cases').set('accept', 'application/json').expect(200); assert.equal(policy.body.kind, 'policy-cases');
      const claimed = await post(seller, base + '/' + fixture.referral.publicId + '/claim', { version: fixture.referral.__v }, { page: base });
      const html = await seller.client.get(base + '?record=' + fixture.referral.publicId).expect(200); assert.match(html.text, /Return assessment to Support/);
      const upload = await seller.client.post(base + '/' + fixture.referral.publicId + '/evidence').set('x-csrf-token', csrf(html.text)).set('accept', 'application/json')
        .field('version', String(claimed.body.referral.version)).field('description', 'Seller private original dispatch condition evidence').attach('document', image, 'dispatch.png').expect(201);
      const evidence = await EvidenceDocument.findOne({ contextType: 'specialist_referral', contextPublicId: fixture.referral.publicId });
      assert.ok(evidence); const before = await SpecialistReferral.findById(fixture.referral._id).lean();
      await seller.client.get(base + '/evidence/' + evidence.publicId).expect(200).expect('Content-Type', /image\/webp/);
      assert.equal((await SpecialistReferral.findById(fixture.referral._id)).__v, before.__v);
      await otherSeller.client.get(base + '/evidence/' + evidence.publicId).set('accept', 'application/json').expect(404);
      await support.client.get('/support/order-case-evidence/' + evidence.publicId).expect(200).expect('Content-Type', /image\/webp/);
      await post(seller, base + '/' + fixture.referral.publicId + '/respond', { version: upload.body.referral.version, finding: 'further_action', summary: 'The exact store-owned order lines and private dispatch evidence have been reviewed; Support should decide the buyer response.' }, { page: base });
      assert.equal((await SpecialistReferral.findById(fixture.referral._id)).status, 'responded');
      assert.equal((await Dispute.findById(fixture.dispute._id)).status, 'investigating');
      await StoreMember.updateOne({ storeId: store._id, userId: seller.user._id }, { $set: { status: 'revoked' } });
      await seller.client.get(base + '/evidence/' + evidence.publicId).set('accept', 'application/json').expect(403);
      await StoreMember.updateOne({ storeId: store._id, userId: seller.user._id }, { $set: { status: 'active' } });
    });
    await t.test('authority, source and audit failures abort complete transactions, including customer Device checks', async () => {
      const fixture = await referredCase('finance'), context = req(finance), originalUser = await User.findById(finance.user._id).lean();
      const audit = t.mock.method(AuditLog, 'create', async () => { throw new Error('Required aftersales audit unavailable'); });
      try { await assert.rejects(specialists.mutateSpecialistOrderCase(context, 'finance', fixture.referral.publicId, 'claim', { version: fixture.referral.__v }), /Required aftersales audit unavailable/); } finally { audit.mock.restore(); }
      assert.equal((await SpecialistReferral.findById(fixture.referral._id)).status, 'pending'); assert.equal((await User.findById(finance.user._id)).__v, originalUser.__v);
      const expired = { ...context, session: { ...context.session, mfaVerifiedAt: Date.now() - 13 * 60 * 60_000 } };
      await assert.rejects(specialists.mutateSpecialistOrderCase(expired, 'finance', fixture.referral.publicId, 'claim', { version: fixture.referral.__v }), error => error.code === 'MFA_VERIFICATION_REQUIRED');
      await PlatformGrant.updateOne({ _id: finance.grant._id }, { $set: { operationalCountries: ['KE'] } });
      await assert.rejects(specialists.mutateSpecialistOrderCase(context, 'finance', fixture.referral.publicId, 'claim', { version: fixture.referral.__v }), error => error.status === 404);
      await PlatformGrant.updateOne({ _id: finance.grant._id }, { $set: { operationalCountries: ['UG'] } });
      await SupportTicket.updateOne({ _id: fixture.referral.ticketId }, { $set: { orderPublicId: id('ord') } });
      await assert.rejects(specialists.mutateSpecialistOrderCase(context, 'finance', fixture.referral.publicId, 'claim', { version: fixture.referral.__v }), error => error.code === 'SPECIALIST_SOURCE_MISMATCH');
      const sessionID = id('session'), device = await Device.create({ publicId: id('dev'), userId: buyer.user._id, sessionHash: hashToken(sessionID), label: 'Revoked fixture browser', userAgent: 'Fixture', ipHash: id('ip'), revokedAt: new Date() });
      const stale = { ...req(buyer), sessionID, device, session: { userId: buyer.user._id, tokenVersion: buyer.user.security.tokenVersion } };
      await assert.rejects(currentCustomerAccess(stale), error => error.code === 'ACCOUNT_UNAVAILABLE');
      await assert.rejects(tickets.createCustomerSupportTicket(stale, { subject: 'Current session required', category: 'order', priority: 'normal', message: 'A revoked browser cannot create this support conversation.' }), error => error.code === 'ACCOUNT_UNAVAILABLE');
      await assert.rejects(resolution.answerReturnRefundProposal(stale, primary.returned.publicId, { version: await version(ReturnRequest, primary.returned), proposalPublicId: proposal.proposalPublicId, decision: 'accept' }), error => error.code === 'ACCOUNT_UNAVAILABLE');
      assert.ok(await Notification.countDocuments({ type: 'specialist_order_case', userId: finance.user._id }));
    });
  } finally {
    t.mock.restoreAll(); for (const transport of transports) transport.destroy();
    await Promise.all(Object.values(mongoose.models).map(Model => Model.init()));
    try { await mongoose.connection.dropDatabase(); } finally { await mongoose.disconnect(); await fs.rm(process.env.UPLOAD_DIR, { recursive: true, force: true }); }
  }
});

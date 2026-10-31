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
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('a registered pending seller can read its approved workspace while verification still blocks fulfilment', { skip: !uri, timeout: 180_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: `classicmart_pending_workspace_test_${suffix}` });
  const { createApp } = await import('../src/app.js');
  const models = await import('../src/models/index.js');
  const { User, Store, StoreMember, CountrySetting, Order, SellerOrder, Shipment, SellerShipment, Parcel, WarehouseTask } = models;
  const { SELLER_LIVE_ROUTES } = await import('../src/dashboard/seller-routes.js');
  const { pendingMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
  const { assertSellerOrderAccess } = await import('../src/services/seller-orders.js');
  const { createApiClient } = await import('../src/services/stage11.js');
  const password = `Pending-${suffix}-A1!`, app = createApp(null), transports = [];
  let sequence = 0, seller, store, ownOrder, peerOrder;

  function client() {
    const transport = new http.Agent({ localAddress: `127.0.0.${++sequence + 140}`, keepAlive: false });
    transports.push(transport);
    return request.agent(app).use(req => req.agent(transport));
  }
  async function register(role) {
    const agent = client(), email = `pending-workspace-${suffix}-${sequence}@example.com`;
    const form = await agent.get('/signup?role=' + role).expect(200);
    await agent.post('/signup').type('form').send({ accountType: role, name: 'Pending Workspace Seller', email,
      phoneCountry: 'UG', phone: '07' + crypto.randomInt(10000000, 99999999), password, confirmPassword: password,
      acceptTerms: 'on', _csrf: csrf(form.text) }).expect(302).expect('location', '/verify-email');
    const verification = await agent.get('/verify-email').expect(200);
    const code = verification.text.match(/Development verification code: (\d{6})/)[1];
    await agent.post('/verify-email').type('form').send({ code, _csrf: csrf(verification.text) }).expect(302).expect('location', '/onboarding');
    const onboarding = await agent.get('/onboarding').expect(200);
    await agent.post('/onboarding').type('form').send({ role, publicName: 'Pending Workspace Seller',
      businessName: role === 'seller' ? 'Pending Workspace Store' : '', location: 'Kampala', _csrf: csrf(onboarding.text) })
      .expect(302).expect('location', role === 'seller' ? '/seller/overview' : '/dashboard');
    return { agent, email, user: await User.findOne({ emailNormalized: email }) };
  }
  async function orderFixture(target, index) {
    const line = { linePublicId: `oline_pending_${suffix}_${index}`, productId: new mongoose.Types.ObjectId(),
      variantId: new mongoose.Types.ObjectId(), storeId: target._id, reservationPublicId: `res_pending_${suffix}_${index}`,
      productPublicId: `prd_pending_${suffix}_${index}`, variantPublicId: `var_pending_${suffix}_${index}`,
      storePublicId: target.publicId, title: `Store item ${index}`, variantTitle: 'Standard', sku: `PENDING-${index}`,
      quantity: 1, unitPriceMinor: 15000, lineTotalMinor: 15000, currency: 'UGX' };
    const root = await Order.create({ publicId: `ord_pending_${suffix}_${index}`, idempotencyKey: `pending-${suffix}-${index}`,
      checkoutId: `chk_pending_${suffix}_${index}`, cartPublicId: `crt_pending_${suffix}_${index}`, sessionKey: `pending-${suffix}-${index}`,
      country: 'UG', status: 'confirmed', paymentState: 'pending', paymentMethod: 'cod', deliveryMethod: 'standard',
      contact: { fullName: `Private Buyer ${index}`, email: `buyer-${index}@example.com`, phone: '+256701222333',
        address: `Private delivery address ${index}`, city: 'Kampala', country: 'Uganda' },
      totals: { subtotalMinor: 15000, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 15000, currency: 'UGX' },
      items: [line], reservationExpiresAt: new Date(Date.now() + 3600000) });
    return SellerOrder.create({ publicId: `sor_pending_${suffix}_${index}`, orderId: root._id, orderPublicId: root.publicId,
      storeId: target._id, storePublicId: target.publicId, country: 'UG', currency: 'UGX', status: 'confirmed', subtotalMinor: 15000,
      items: [{ ...line, orderLineId: line.linePublicId }] });
  }
  async function operationalSnapshot() {
    return JSON.parse(JSON.stringify(await Promise.all([Order, SellerOrder, Shipment, SellerShipment, Parcel, WarehouseTask]
      .map(Model => Model.find().sort({ publicId: 1 }).lean()))));
  }
  try {
    await Promise.all(Object.values(models).filter(model => typeof model?.init === 'function').map(model => model.init()));
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true });

    await t.test('real signup and later login still require MFA before entering the pending seller workspace', async () => {
      seller = await register('seller');
      assert.equal(seller.user.role, 'seller');
      assert.ok(seller.user.emailVerifiedAt);
      assert.ok(seller.user.onboardingCompletedAt);
      await seller.agent.get('/seller/orders').set('accept', 'application/json').expect(403)
        .expect(response => assert.equal(response.body.error.code, 'MFA_ENROLLMENT_REQUIRED'));
      await seller.agent.get('/seller/shipping').expect(302).expect('location', '/account/security?next=%2Fseller%2Fshipping');
      const later = client(), login = await later.get('/login').expect(200);
      await later.post('/login').type('form').send({ email: seller.email, password, _csrf: csrf(login.text) })
        .expect(302).expect('location', '/seller/overview');
      seller.agent = later;
      const destination = '/seller/orders', securityPath = '/account/security?next=%2Fseller%2Forders';
      await later.get(destination).expect(302).expect('location', securityPath);
      let security = await later.get(securityPath).expect(200);
      assert.match(security.text, /data-dashboard-workspace="seller"/);
      await later.post('/account/mfa/begin').type('form').send({ currentPassword: password, next: destination, _csrf: csrf(security.text) })
        .expect(302).expect('location', securityPath);
      const enrollment = await pendingMfaEnrollment(seller.user._id);
      security = await later.get(securityPath).expect(200);
      await later.post('/account/mfa/confirm').type('form').send({ code: totpCode(enrollment.secret), next: destination, _csrf: csrf(security.text) })
        .expect(302).expect('location', securityPath);
      const confirmed = await later.get(securityPath).expect(200);
      assert.match(confirmed.text, /href="\/seller\/orders">Continue to Seller workspace<\/a>/);
      assert.match(confirmed.text, /Save these recovery codes offline before continuing/);
      seller.recoveryCode = confirmed.text.match(/<code>([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})<\/code>/)[1];
      const orders = await later.get(destination).expect(200);
      assert.match(orders.text, /data-dashboard-page="seller-orders"/);
      store = await Store.findOne({ ownerUserId: seller.user._id });
      assert.equal(store.status, 'pending_verification');
      assert.equal(store.verifiedAt, undefined);
      seller.user = await User.findById(seller.user._id);
      assert.equal(seller.user.security.mfaEnabled, true);
    });

    await t.test('all 23 pending seller pages and aliases retain the approved shell with a verification next action', async () => {
      assert.equal(Object.keys(SELLER_LIVE_ROUTES).length, 23);
      for (const [id, href] of Object.entries(SELLER_LIVE_ROUTES)) {
        const page = await seller.agent.get(href).set('accept', 'text/html').expect(200);
        assert.ok(page.text.includes(`data-dashboard-page="${id}"`), href);
        assert.match(page.text, /data-dashboard-workspace="seller"/);
        assert.match(page.text, /data-seller-verification-notice/);
        assert.match(page.text, /href="\/seller\/verification">Review store verification<\/a>/);
        assert.doesNotMatch(page.text, /Development preview|This store is unavailable for fulfilment|id="roleSwitcher"/);
        assert.match(page.headers['cache-control'], /no-store/);
        assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
        await seller.agent.get('/dashboard/' + id + '?search=retained').expect(308).expect('location', href + '?search=retained');
      }
      await seller.agent.get('/seller/verification').expect(200);
      const security = await seller.agent.get('/account/security').expect(200);
      assert.match(security.text, /data-dashboard-workspace="seller"/);
      const empty = await seller.agent.get('/seller/orders').set('accept', 'application/json').expect(200);
      assert.equal(empty.body.metrics.total, 0);
      assert.deepEqual(empty.body.orders, []);
      assert.equal((await Store.findById(store._id)).status, 'pending_verification');
    });

    await t.test('pending order and shipping reads use actual scoped data and never advertise fulfilment actions', async () => {
      const peer = await register('seller');
      const peerStore = await Store.create({ publicId: `str_pending_peer_${suffix}`, ownerUserId: peer.user._id,
        name: 'Other Pending Store', slug: `pending-peer-${suffix}`, country: 'UG', currency: 'UGX' });
      ownOrder = await orderFixture(store, 'own');
      peerOrder = await orderFixture(peerStore, 'peer');
      for (const href of ['/seller/orders', '/seller/shipping']) {
        const page = await seller.agent.get(href).set('accept', 'application/json').expect(200);
        assert.deepEqual(page.body.orders.map(row => row.publicId), [ownOrder.publicId]);
        assert.equal(page.body.metrics.total, 1);
        assert.equal(page.body.metrics.processing, 1);
        assert.ok(Object.values(page.body.orders[0].actions).every(value => value === false));
        assert.match(page.body.orders[0].blockedReason, /Complete store verification/);
        assert.ok(!JSON.stringify(page.body).includes(peerOrder.publicId));
      }
      const detail = await seller.agent.get('/seller/orders/' + ownOrder.publicId).set('accept', 'application/json').expect(200);
      assert.equal(detail.body.order.contact.fullName, 'Private Buyer own');
      assert.deepEqual(detail.body.warehouses, []);
      assert.ok(Object.values(detail.body.actions).every(value => value === false));
      const html = await seller.agent.get('/seller/orders/' + ownOrder.publicId).expect(200);
      assert.doesNotMatch(html.text, /action="\/seller\/orders\/[^\"]+\/(?:processing|pick|pack|dispatch)"/);
      await seller.agent.get('/seller/orders/' + peerOrder.publicId).set('accept', 'application/json').expect(404);
      const exported = await seller.agent.get('/seller/orders/export.csv').expect(200);
      assert.ok(exported.text.includes(ownOrder.publicId));
      assert.ok(!exported.text.includes(peerOrder.publicId));
    });

    await t.test('all pending fulfilment writes and the API idempotency preflight stay locked without changing orders', async () => {
      const before = await operationalSnapshot(), detail = await seller.agent.get('/seller/orders/' + ownOrder.publicId).expect(200);
      for (const action of ['processing', 'pick', 'pack', 'dispatch']) {
        await seller.agent.post('/seller/orders/' + ownOrder.publicId + '/' + action).set('accept', 'application/json').type('form')
          .send({ version: ownOrder.__v, _csrf: csrf(detail.text) }).expect(409)
          .expect(response => assert.equal(response.body.error.code, 'STORE_LOCKED'));
      }
      const failed = await seller.agent.post('/seller/orders/' + ownOrder.publicId + '/processing').type('form')
        .send({ version: ownOrder.__v, _csrf: csrf(detail.text) }).expect(409);
      assert.match(failed.text, /data-dashboard-workspace="seller"/);
      assert.match(failed.text, /Complete store verification/);
      const serviceRequest = { user: seller.user, store, session: { tokenVersion: seller.user.security.tokenVersion }, params: { id: ownOrder.publicId } };
      await assertSellerOrderAccess(serviceRequest);
      await assert.rejects(assertSellerOrderAccess(serviceRequest, { mutation: true }), error => error.status === 409 && error.code === 'STORE_LOCKED');
      const integration = await createApiClient({ user: seller.user, store, name: 'Pending verification regression', scopes: ['orders:read', 'orders:fulfil'] });
      const apiRequest = { apiClient: integration.client, apiStore: store, params: { id: ownOrder.publicId } };
      await assert.rejects(assertSellerOrderAccess(apiRequest, { mutation: true }), error => error.status === 409 && error.code === 'STORE_LOCKED');
      await request(app).post('/api/v1/seller/orders/' + ownOrder.publicId + '/processing')
        .set('authorization', 'Bearer ' + integration.apiKey).set('if-match', String(ownOrder.__v))
        .set('idempotency-key', `pending-api-${suffix}`).send({}).expect(403)
        .expect(response => assert.equal(response.body.error.code, 'STORE_UNAVAILABLE'));
      assert.deepEqual(await operationalSnapshot(), before);
      assert.equal((await Store.findById(store._id)).status, 'pending_verification');
    });

    await t.test('MFA login retains the pending seller workspace while ordinary customers remain excluded', async () => {
      const later = client(), form = await later.get('/login').expect(200);
      await later.post('/login').type('form').send({ email: seller.email, password, _csrf: csrf(form.text) }).expect(302).expect('location', '/mfa');
      await later.get('/seller/orders').set('accept', 'application/json').expect(401);
      const challenge = await later.get('/mfa').expect(200);
      await later.post('/mfa').type('form').send({ code: seller.recoveryCode, _csrf: csrf(challenge.text) })
        .expect(302).expect('location', '/seller/overview');
      await later.get('/seller/orders').expect(200);
      await later.get('/seller/shipping').expect(200);
      await later.get('/seller/store').expect(200);
      const customer = await register('customer');
      for (const href of Object.values(SELLER_LIVE_ROUTES)) await customer.agent.get(href).set('accept', 'application/json').expect(403);
      assert.equal(await Store.countDocuments({ ownerUserId: customer.user._id }), 0);
      assert.equal((await User.findById(customer.user._id)).role, 'customer');
    });

    await t.test('suspension denies operational pages and keeps store settings readable without allowing writes', async () => {
      await Store.updateOne({ _id: store._id }, { $set: { status: 'suspended', suspendedAt: new Date() } });
      const privateReadPaths = new Set(['/seller/store', '/seller/subscription', '/seller/cases', '/seller/trust-cases']);
      for (const href of Object.values(SELLER_LIVE_ROUTES)) {
        const result = await seller.agent.get(href).set('accept', 'application/json').expect(privateReadPaths.has(href) ? 200 : 409);
        if (!privateReadPaths.has(href)) assert.equal(result.body.error.code, 'STORE_LOCKED', href + ' still blocks trading.');
      }
      const locked = await seller.agent.get('/seller/store').expect(200);
      assert.match(locked.text, /Settings cannot be changed/);
      assert.equal([...locked.text.matchAll(/<fieldset disabled class="seller-settings-fields">/g)].length, 3,
        'every settings submit remains inside a disabled fieldset');
      const before = JSON.parse(JSON.stringify(await Store.findById(store._id).lean()));
      await seller.agent.post('/seller/store/operations').type('form').send({ version: before.__v,
        primaryCategory: '', pickupCity: 'Changed city', fulfillmentMode: 'merchant', _csrf: csrf(locked.text) }).expect(409);
      assert.deepEqual(JSON.parse(JSON.stringify(await Store.findById(store._id).lean())), before);
      await seller.agent.get('/seller/verification').set('accept', 'application/json').expect(409);
      await seller.agent.post('/seller/verification/submit').set('accept', 'application/json').type('form')
        .send({ version: 0, sellerType: 'individual', legalName: 'Pending Workspace Seller', declaration: 'yes', _csrf: csrf(locked.text) }).expect(409);
      const security = await seller.agent.get('/account/security').expect(200);
      await seller.agent.post('/seller/orders/' + ownOrder.publicId + '/processing').set('accept', 'application/json').type('form')
        .send({ version: ownOrder.__v, _csrf: csrf(security.text) }).expect(409);
      await Store.updateOne({ _id: store._id }, { $set: { status: 'closed' } });
      for (const href of ['/seller/store', '/seller/orders', '/seller/shipping']) await seller.agent.get(href).set('accept', 'application/json').expect(403).expect(result => assert.equal(result.body.error.code, 'SELLER_WORKSPACE_FORBIDDEN'));
      assert.equal(await Store.countDocuments({ ownerUserId: seller.user._id }), 1);
      assert.equal((await User.findById(seller.user._id)).role, 'seller');
      assert.equal(await StoreMember.countDocuments({ storeId: store._id, userId: seller.user._id, role: 'owner', status: 'active' }), 1);
    });
  } finally {
    for (const transport of transports) transport.destroy();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

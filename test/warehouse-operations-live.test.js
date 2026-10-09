import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';
import { chromium } from '@playwright/test';

const suffix = crypto.randomBytes(8).toString('hex');
process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const csrf = html => {
  const token = html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/);
  assert.ok(token, 'the real rendered form must provide its session CSRF token');
  return token[1];
};

test('managed warehouse operators complete audited inventory and paid-order fulfilment through real approved pages', { skip: !uri }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const database = `classicmart_warehouse_operations_test_${suffix}`;
  await mongoose.connect(uri, { dbName: database });
  const { createApp } = await import('../src/app.js');
  const models = await import('../src/models/index.js');
  const { User, Store, Category, Product, ProductVariant, Warehouse, StockItem, WarehouseTask, WarehouseWave,
    PlatformGrant, InventoryMovement, InventoryDiscrepancy, InventoryReservation, OperationAction, Order,
    SellerOrder, SellerShipment, Shipment, Parcel, CountrySetting, ShippingZone, AuditLog, DeliveryProfile, ReturnRequest } = models;
  const { hashPassword } = await import('../src/core/crypto.js');
  const { pendingMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
  const { hydratePlatformAuthorization } = await import('../src/services/platform-grants.js');
  const { offerShipment, acceptDeliveryOffer, transitionShipment } = await import('../src/services/logistics.js');
  const { createReturnRequest, decideReturn, markReturnReceived } = await import('../src/services/trust.js');
  const { decryptSensitive } = await import('../src/core/sensitive.js');
  const operations = await import('../src/services/warehouse-operations.js');
  const password = `Warehouse-${suffix}A1!`, app = createApp(null), transports = [];
  let sequence = 0, server, browser, warehouse;
  const id = prefix => `${prefix}_warehouse_${suffix}_${sequence++}`;
  const actionKey = () => id('action');
  async function actor({ role = 'customer', country = 'UG', warehouses = [], countries = [country], capabilities = [], mfa = true, managed = false } = {}) {
    const index = sequence++, email = `warehouse-${suffix}-${index}@example.com`, phone = '+2567' + crypto.randomInt(10000000, 99999999);
    const user = await User.create({ publicId: id('usr'), name: `Warehouse Operator ${index}`, email, emailNormalized: email,
      phone, phoneNormalized: phone, passwordHash: await hashPassword(password), role: managed ? 'customer' : role, country,
      currency: country === 'KE' ? 'KES' : 'UGX', emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(),
      onboardingCompletedAt: new Date(), ...(managed ? { platformAccessManagedAt: new Date(), operationalCountries: [] } : {}),
      consents: { terms: true, privacy: true, recordedAt: new Date() } });
    const grant = managed ? await PlatformGrant.create({ publicId: id('pgr'), userId: user._id, role,
      operationalCountries: countries, warehouseScopes: warehouses.map(row => row.publicId), capabilities, startsAt: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), status: 'active', reason: 'Approved isolated warehouse verification fixture',
      approvalPublicId: id('approval'), approvedByUserId: user._id }) : null;
    const transport = new http.Agent({ localAddress: `127.0.0.${transports.length + 2}`, keepAlive: false });
    transports.push(transport);
    const agent = request.agent(app).use(req => req.agent(transport));
    const form = await agent.get('/login').expect(200);
    await agent.post('/login').type('form').send({ email, password, _csrf: csrf(form.text) }).expect(302);
    if (mfa) {
      const security = await agent.get('/account/security').expect(200);
      await agent.post('/account/mfa/begin').type('form').send({ currentPassword: password, _csrf: csrf(security.text) }).expect(302);
      const pending = await pendingMfaEnrollment(user._id);
      assert.ok(pending?.secret);
      await agent.post('/account/mfa/confirm').type('form').send({ code: totpCode(pending.secret), _csrf: csrf((await agent.get('/account/security')).text) }).expect(302);
      assert.equal((await User.findById(user._id)).security.mfaEnabled, true);
    }
    return { user: await User.findById(user._id), agent, grant };
  }
  async function serviceRequest(member, publicId = '', body = {}) {
    const user = await User.findById(member.user._id).select('+operationalCountries');
    await hydratePlatformAuthorization(user);
    return { id: id('request'), user, authActor: user, params: { publicId }, body, query: {}, country: { code: 'UG' }, get: () => '' };
  }
  async function mutation(member, path, body, { status = 200, includeCsrf = true } = {}) {
    const page = await member.agent.get('/account/security').expect(200);
    return member.agent.post(path).set('accept', 'application/json').type('form')
      .send({ ...(includeCsrf ? { _csrf: csrf(page.text) } : {}), ...body }).expect(status);
  }
  async function createTask(member, warehouse, stock, fields = {}) {
    const body = { warehousePublicId: warehouse.publicId, version: (await Warehouse.findById(warehouse._id)).__v, stockPublicId: stock.publicId, type: 'receive', quantity: 3,
      reference: id('receipt'), notes: 'Real approved-page receiving verification', actionKey: actionKey(), ...fields };
    const response = await mutation(member, '/warehouse/tasks', body);
    const task = await WarehouseTask.findOne({ warehouseId: warehouse._id, reference: body.reference });
    assert.ok(task);
    return { task, body, response };
  }
  async function taskAction(member, task, action, fields = {}, status = 200) {
    const current = await WarehouseTask.findById(task._id);
    return mutation(member, `/warehouse/tasks/${task.publicId}/${action}`, { version: current.__v, ...fields }, { status });
  }
  async function stockSnapshot(stock) {
    const row = await StockItem.findById(stock._id).lean();
    return [row.onHand, row.reserved, row.damaged, row.quarantined, row.binCode, row.__v];
  }
  async function catalogue(store, warehouse, title = 'Warehouse Test Product') {
    const product = await Product.create({ publicId: id('prd'), storeId: store._id, ownerUserId: store.ownerUserId,
      categoryId: (await Category.findOne({ publicId: `cat_warehouse_${suffix}` }))._id, title, slug: id('product'),
      description: 'A real published product with real stock and checkout for warehouse operations.', countries: ['UG'], status: 'published' });
    const variant = await ProductVariant.create({ publicId: id('var'), productId: product._id, storeId: store._id, sku: id('SKU'), title: 'Standard',
      priceMinor: 45000, costMinor: 12345, currency: 'UGX', active: true, weightGrams: 200 });
    const stock = await StockItem.create({ publicId: id('stk'), storeId: store._id, variantId: variant._id, warehouseId: warehouse._id,
      onHand: 50, reserved: 0, reorderPoint: 5 });
    return { product, variant, stock };
  }
  async function paidOrder(buyer, item, quantity = 2) {
    const cart = await buyer.agent.get('/api/v1/cart').expect(200);
    await buyer.agent.post('/api/v1/cart/items').set('x-csrf-token', cart.body.csrfToken)
      .send({ productId: item.product.publicId, variantId: item.variant.publicId, quantity }).expect(200);
    const checkout = await buyer.agent.post('/api/v1/checkout/review').set('x-csrf-token', cart.body.csrfToken)
      .send({ deliveryMethod: 'standard', paymentMethod: 'cod', city: 'Kampala' }).expect(200);
    const placed = await buyer.agent.post('/api/v1/orders').set('x-csrf-token', cart.body.csrfToken).send({ checkoutId: checkout.body.checkoutId,
      idempotencyKey: actionKey(), deliveryMethod: 'standard', paymentMethod: 'cod', city: 'Kampala', contact: {
        fullName: buyer.user.name, email: buyer.user.email, phone: buyer.user.phone, address: 'Real buyer verification street', city: 'Kampala', country: 'Uganda' } }).expect(201);
    const order = await Order.findOne({ publicId: placed.body.order.id });
    const pendingStock = await stockSnapshot(item.stock);
    await buyer.agent.post(`/api/v1/orders/${order.publicId}/payment-intents`).set('x-csrf-token', cart.body.csrfToken)
      .send({ idempotencyKey: actionKey() }).expect(201);
    assert.equal((await StockItem.findById(item.stock._id)).onHand, pendingStock[0] - quantity);
    assert.ok((await InventoryReservation.find({ publicId: { $in: order.items.map(line => line.reservationPublicId) } })).every(row => row.status === 'committed'));
    return { order: await Order.findById(order._id), shipment: await Shipment.findOne({ orderId: order._id, kind: 'outbound' }),
      parcel: await Parcel.findOne({ orderPublicId: order.publicId }), sellerOrder: await SellerOrder.findOne({ orderId: order._id }) };
  }
  async function parcelTask(member, fixture, type, extra = {}) {
    const body = { warehousePublicId: warehouse.publicId, version: (await Warehouse.findById(warehouse._id)).__v,
      parcelPublicId: fixture.parcel.publicId, type, reference: id('parcel-task'), actionKey: actionKey(), ...extra };
    const response = await mutation(member, '/warehouse/tasks', body);
    const task = await WarehouseTask.findOne({ parcelId: fixture.parcel._id, type });
    assert.ok(task);
    return { task, body, response };
  }
  function assertPrivateDto(dto, privateValues = []) {
    const serialized = JSON.stringify(dto);
    assert.doesNotMatch(serialized, /"(?:_id|__v|passwordHash|costMinor|unitCostMinor|email|pickupCodeHash|deliveryCodeHash|pickupCodeEncrypted|deliveryCodeEncrypted|phone)"\s*:/);
    for (const value of privateValues) assert.equal(serialized.includes(String(value)), false, 'the operational page must omit private or out-of-scope values');
  }
  try {
    await Promise.all(Object.values(models).filter(model => model?.init && typeof model.init === 'function').map(model => model.init()));
    for (const [code, currency, timeZone] of [['UG', 'UGX', 'Africa/Kampala'], ['KE', 'KES', 'Africa/Nairobi'], ['TZ', 'TZS', 'Africa/Dar_es_Salaam']])
      await CountrySetting.create({ code, name: code, currency, locale: 'en', timeZone, phonePrefix: code === 'UG' ? '+256' : code === 'KE' ? '+254' : '+255', active: true,
        delivery: { requirePhotoForCod: false } });
    await Category.create({ publicId: `cat_warehouse_${suffix}`, name: 'Warehouse Test Goods', slug: `warehouse-${suffix}`, countries: ['UG'], active: true });
    await ShippingZone.create({ publicId: id('zone'), country: 'UG', name: 'Warehouse verification delivery', cities: ['Kampala'], standardFeeMinor: 5000, currency: 'UGX', active: true });
    const seller = await actor({ role: 'seller' }), buyer = await actor({ mfa: false });
    const store = await Store.create({ publicId: id('str'), ownerUserId: seller.user._id, name: 'Warehouse Verification Store', slug: id('store'), country: 'UG', currency: 'UGX', status: 'verified' });
    warehouse = await Warehouse.create({ publicId: id('wh'), storeId: store._id, ownerUserId: seller.user._id,
      name: 'Approved Kampala Warehouse', country: 'UG', city: 'Kampala', address: 'Warehouse verification address', active: true });
    const excluded = await Warehouse.create({ publicId: id('wh'), storeId: store._id, ownerUserId: seller.user._id,
      name: `PRIVATE_UNASSIGNED_WAREHOUSE_${suffix}`, country: 'UG', city: 'Kampala', address: 'Unassigned private warehouse address', active: true });
    const kenya = await Warehouse.create({ publicId: id('wh'), storeId: store._id, ownerUserId: seller.user._id,
      name: 'Approved Kenya Warehouse', country: 'KE', city: 'Nairobi', address: 'Kenya warehouse verification address', active: true });
    const tanzania = await Warehouse.create({ publicId: id('wh'), storeId: store._id, ownerUserId: seller.user._id,
      name: `PRIVATE_COUNTRY_WAREHOUSE_${suffix}`, country: 'TZ', city: 'Dar es Salaam', address: 'Unapproved country warehouse address', active: true });
    const operator = await actor({ role: 'warehouse', managed: true, warehouses: [warehouse] });
    const second = await actor({ role: 'warehouse', managed: true, warehouses: [warehouse] });
    const supervisor = await actor({ role: 'country_admin', managed: true, warehouses: [warehouse] });
    const item = await catalogue(store, warehouse), privateItem = await catalogue(store, excluded, `PRIVATE_OUT_OF_SCOPE_PRODUCT_${suffix}`);

    await t.test('real login, managed grants and MFA gate every canonical warehouse page; signup cannot grant privilege', async () => {
      await request(app).get('/warehouse').expect(302).expect('location', '/login?next=%2Fwarehouse');
      await buyer.agent.get('/warehouse').set('accept', 'application/json').expect(403);
      const unprotected = await actor({ role: 'warehouse', managed: true, warehouses: [warehouse], mfa: false });
      await unprotected.agent.get('/warehouse').expect(302).expect('location', '/account/security?next=%2Fwarehouse');
      const mfaDenied = await unprotected.agent.get('/warehouse').set('accept', 'application/json').expect(403);
      assert.equal(mfaDenied.body.error.code, 'MFA_ENROLLMENT_REQUIRED');
      await assert.rejects(operations.assertWarehouseAccess(await serviceRequest(unprotected)), { code: 'MFA_ENROLLMENT_REQUIRED' });
      const signupAgent = request.agent(app), signup = await signupAgent.get('/signup').expect(200), email = id('signup') + '@example.com';
      await signupAgent.post('/signup').type('form').send({ name: 'Unprivileged Signup', email, phoneCountry: 'UG', phone: '07' + crypto.randomInt(10000000, 99999999),
        password, confirmPassword: password, acceptTerms: 'on', role: 'warehouse', operationalCountries: ['UG'], warehouseScopes: [warehouse.publicId], _csrf: csrf(signup.text) }).expect(302);
      const signedUp = await User.findOne({ emailNormalized: email });
      assert.equal(signedUp.role, 'customer'); assert.equal(await PlatformGrant.countDocuments({ userId: signedUp._id }), 0);
      for (const pageName of ['', '/inventory', '/receiving', '/picking', '/packing', '/dispatch', '/returns', '/reports', '/settings']) {
        const html = await operator.agent.get('/warehouse' + pageName).expect(200);
        assert.match(html.headers['cache-control'], /private/); assert.match(html.headers['cache-control'], /no-store/);
        assert.equal(html.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
        assert.doesNotMatch(html.text, /roleSwitcher|Development preview|role-workspaces\.js/);
        const json = await operator.agent.get('/warehouse' + pageName).set('accept', 'application/json').expect(200);
        assertPrivateDto(json.body, [operator.user.email, buyer.user.email, privateItem.product.title, excluded.name, tanzania.name, warehouse._id, item.stock._id]);
      }
      assert.equal((await User.findById(operator.user._id)).role, 'customer', 'the authoritative grant, rather than a global role mirror, supplies operational privilege');
      const delegated = await actor({ role: 'support', managed: true, warehouses: [warehouse], capabilities: ['warehouse:manage'] });
      const delegatedPage = await delegated.agent.get('/warehouse/settings').set('accept', 'application/json').expect(200);
      assertPrivateDto(delegatedPage.body, [excluded.name, privateItem.product.title, delegated.user.email]);
      const delegatedTask = await createTask(delegated, warehouse, item.stock);
      await mutation(delegated, '/warehouse/tasks', { ...delegatedTask.body, warehousePublicId: excluded.publicId,
        stockPublicId: privateItem.stock.publicId, version: excluded.__v, actionKey: actionKey() }, { status: 404 });
      await PlatformGrant.updateOne({ _id: delegated.grant._id }, { $set: { capabilities: [] } });
      await delegated.agent.get('/warehouse').set('accept', 'application/json').expect(403);
      await mutation(delegated, '/warehouse/tasks', delegatedTask.body, { status: 403 });
    });

    await t.test('receiving and put-away survive replay, stale versions, CSRF, contested assignment and audit failure', async () => {
      const before = await stockSnapshot(item.stock), created = await createTask(operator, warehouse, item.stock);
      await mutation(operator, '/warehouse/tasks', created.body);
      assert.equal(await WarehouseTask.countDocuments({ reference: created.body.reference }), 1);
      const conflict = await mutation(operator, '/warehouse/tasks', { ...created.body, quantity: 9 }, { status: 409 });
      assert.equal(conflict.body.error.code, 'WAREHOUSE_ACTION_CONFLICT');
      await mutation(operator, `/warehouse/tasks/${created.task.publicId}/claim`, { version: created.task.__v }, { includeCsrf: false, status: 403 });
      await mutation(operator, `/warehouse/tasks/${created.task.publicId}/claim`, {}, { status: 428 });
      await mutation(operator, `/operations/logistics/tasks/${created.task.publicId}/claim`, {}, { status: 428 });
      for (const version of [-1, '1.5', 'not-a-version']) await mutation(operator, `/warehouse/tasks/${created.task.publicId}/claim`, { version }, { status: 422 });
      const candidates = await Promise.allSettled([operator, second].map(async member => operations.mutateWarehouse(await serviceRequest(member, created.task.publicId, { version: created.task.__v }), 'claim')));
      assert.equal(candidates.filter(row => row.status === 'fulfilled').length, 1);
      assert.ok(candidates.filter(row => row.status === 'rejected').every(row => row.reason.status === 409));
      const claimed = await WarehouseTask.findById(created.task._id), winner = String(claimed.assignedUserId) === String(operator.user._id) ? operator : second;
      await mutation(winner, `/warehouse/tasks/${created.task.publicId}/execute`, { version: created.task.__v }, { status: 409 });
      const executeBody = { version: claimed.__v, actionKey: actionKey() };
      t.mock.method(AuditLog, 'create', async () => { throw new Error('Warehouse audit fixture failure'); });
      try { await assert.rejects(operations.mutateWarehouse(await serviceRequest(winner, created.task.publicId, executeBody), 'execute'), /Warehouse audit fixture failure/); }
      finally { t.mock.restoreAll(); }
      assert.deepEqual(await stockSnapshot(item.stock), before); assert.equal((await WarehouseTask.findById(created.task._id)).status, 'in_progress');
      await mutation(winner, `/warehouse/tasks/${created.task.publicId}/execute`, executeBody);
      await mutation(winner, `/warehouse/tasks/${created.task.publicId}/execute`, executeBody);
      assert.equal((await StockItem.findById(item.stock._id)).onHand, before[0] + 3);
      assert.equal(await InventoryMovement.countDocuments({ reference: created.body.reference, type: 'receipt' }), 1);
      assert.equal((await WarehouseTask.findById(created.task._id)).status, 'completed');
      const putAway = await createTask(operator, warehouse, item.stock, { type: 'put_away', quantity: 0, binCode: 'A-01-02' });
      await taskAction(operator, putAway.task, 'claim'); await taskAction(operator, putAway.task, 'execute');
      assert.equal((await StockItem.findById(item.stock._id)).binCode, 'A-01-02');
      assert.equal((await StockItem.findById(item.stock._id)).onHand, before[0] + 3);
      const release = await createTask(operator, warehouse, item.stock);
      await taskAction(operator, release.task, 'claim'); await taskAction(operator, release.task, 'release');
      assert.equal((await WarehouseTask.findById(release.task._id)).status, 'open');
      assert.equal((await WarehouseTask.findById(release.task._id)).assignedUserId, null);
    });

    await t.test('stock counts require a distinct reviewer and change stock exactly once', async () => {
      const stock = await StockItem.findById(item.stock._id), body = { countedOnHand: stock.onHand - 2, reason: 'Physical count differs from recorded goods', version: stock.__v, actionKey: actionKey() };
      await mutation(operator, `/warehouse/stock/${stock.publicId}/cycle-count`, body);
      await mutation(operator, `/warehouse/stock/${stock.publicId}/cycle-count`, body);
      const discrepancy = await InventoryDiscrepancy.findOne({ stockItemId: stock._id, status: 'pending_review' });
      assert.ok(discrepancy); assert.equal(await InventoryDiscrepancy.countDocuments({ stockItemId: stock._id }), 1);
      assert.equal((await StockItem.findById(stock._id)).onHand, stock.onHand);
      await mutation(operator, `/warehouse/discrepancies/${discrepancy.publicId}/review`, { version: discrepancy.__v, decision: 'approve', reviewNote: 'Attempted self-approval' }, { status: 403 });
      await PlatformGrant.updateOne({ _id: operator.grant._id }, { $set: { role: 'country_admin' } });
      const fourEyes = await mutation(operator, `/warehouse/discrepancies/${discrepancy.publicId}/review`, { version: discrepancy.__v, decision: 'approve', reviewNote: 'Same counter temporarily has supervisory authority' }, { status: 409 });
      assert.equal(fourEyes.body.error.code, 'INVENTORY_REVIEW_FOUR_EYES');
      await PlatformGrant.updateOne({ _id: operator.grant._id }, { $set: { role: 'warehouse' } });
      const review = { version: discrepancy.__v, decision: 'approve', reviewNote: 'Independent reviewer verified the physical count', actionKey: actionKey() };
      await mutation(supervisor, `/warehouse/discrepancies/${discrepancy.publicId}/review`, review);
      await mutation(supervisor, `/warehouse/discrepancies/${discrepancy.publicId}/review`, review);
      assert.equal((await StockItem.findById(stock._id)).onHand, body.countedOnHand);
      assert.equal((await InventoryDiscrepancy.findById(discrepancy._id)).status, 'approved');
      assert.equal(await InventoryMovement.countDocuments({ reference: discrepancy.publicId, type: 'adjustment' }), 1);
      await mutation(supervisor, `/warehouse/discrepancies/${discrepancy.publicId}/review`, { ...review, reviewNote: 'Changed replay payload' }, { status: 409 });
      await mutation(operator, '/warehouse/tasks', { warehousePublicId: warehouse.publicId, version: (await Warehouse.findById(warehouse._id)).__v,
        stockPublicId: stock.publicId, type: 'cycle_count', quantity: body.countedOnHand, actionKey: actionKey() }, { status: 422 });
    });

    await t.test('scope changes and revocation fence mutations and cached action receipts', async () => {
      await mutation(operator, '/warehouse/tasks', { warehousePublicId: excluded.publicId, version: excluded.__v, stockPublicId: privateItem.stock.publicId, type: 'receive', quantity: 1, reference: id('private'), actionKey: actionKey() }, { status: 404 });
      const created = await createTask(operator, warehouse, item.stock), before = await stockSnapshot(item.stock);
      await PlatformGrant.updateOne({ _id: operator.grant._id }, { $set: { status: 'revoked', revokedAt: new Date() } });
      await mutation(operator, '/warehouse/tasks', created.body, { status: 403 });
      await operator.agent.get('/warehouse').set('accept', 'application/json').expect(403);
      assert.deepEqual(await stockSnapshot(item.stock), before);
      await PlatformGrant.updateOne({ _id: operator.grant._id }, { $set: { status: 'active', revokedAt: null } });
      const originalGrantFind = PlatformGrant.find; let revoked = false;
      t.mock.method(PlatformGrant, 'find', function (...args) {
        const query = originalGrantFind.apply(this, args), originalExec = query.exec;
        query.exec = async function (...execArgs) {
          const value = await originalExec.apply(this, execArgs);
          if (!revoked && this.getOptions().session && String(args[0]?.userId) === String(operator.user._id) && value?.some(row => row.publicId === operator.grant.publicId)) {
            revoked = true;
            await PlatformGrant.updateOne({ _id: operator.grant._id }, { $set: { status: 'revoked', revokedAt: new Date() } });
          }
          return value;
        };
        return query;
      });
      try { await assert.rejects(operations.mutateWarehouse(await serviceRequest(operator, created.task.publicId, { version: created.task.__v }), 'claim'), { code: 'WAREHOUSE_PERMISSION_DENIED' }); }
      finally { t.mock.restoreAll(); }
      assert.equal(revoked, true); assert.equal((await WarehouseTask.findById(created.task._id)).status, 'open');
      await PlatformGrant.updateOne({ _id: operator.grant._id }, { $set: { status: 'active', revokedAt: null } });
      const multi = await actor({ role: 'warehouse', managed: true, countries: ['UG', 'KE'], warehouses: [warehouse, kenya] });
      const multiple = await multi.agent.get('/warehouse/settings').set('accept', 'application/json').expect(200);
      assert.match(JSON.stringify(multiple.body), new RegExp(kenya.publicId));
      assert.equal((await User.findById(multi.user._id)).country, 'UG');
      assertPrivateDto(multiple.body, [excluded.name, tanzania.name]);
      await PlatformGrant.updateOne({ _id: multi.grant._id }, { $set: { warehouseScopes: [warehouse.publicId] } });
      assert.doesNotMatch(JSON.stringify((await multi.agent.get('/warehouse/settings').set('accept', 'application/json').expect(200)).body), new RegExp(kenya.publicId));
    });

    await t.test('paid checkout generates authentic parcel work; warehouse picks, packing and dispatch update buyer tracking without reducing stock twice', async () => {
      const fixture = await paidOrder(buyer, item), afterPayment = await stockSnapshot(item.stock);
      await mutation(operator, '/warehouse/tasks', { warehousePublicId: warehouse.publicId, version: (await Warehouse.findById(warehouse._id)).__v,
        parcelPublicId: fixture.parcel.publicId, type: 'pack', actionKey: actionKey() }, { status: 409 });
      for (const [type, parcelStatus] of [['pick', 'picked'], ['pack', 'packed'], ['dispatch', 'handed_over']]) {
        const created = await parcelTask(operator, fixture, type);
        await mutation(operator, '/warehouse/tasks', created.body);
        assert.equal(await WarehouseTask.countDocuments({ parcelId: fixture.parcel._id, type }), 1);
        if (type === 'pick') assert.equal(created.task.quantity, fixture.order.items.reduce((sum, line) => sum + line.quantity, 0));
        await taskAction(operator, created.task, 'claim');
        const current = await WarehouseTask.findById(created.task._id), executeBody = { version: current.__v, actionKey: actionKey() };
        await mutation(operator, `/warehouse/tasks/${current.publicId}/execute`, executeBody);
        await mutation(operator, `/warehouse/tasks/${current.publicId}/execute`, executeBody);
        assert.equal((await Parcel.findById(fixture.parcel._id)).status, parcelStatus);
        assert.deepEqual(await stockSnapshot(item.stock), afterPayment, `${type} uses already-committed payment reservations`);
        const tracking = await buyer.agent.get('/api/v1/orders/' + fixture.order.publicId).expect(200);
        assert.equal(tracking.body.order.sellerShipments[0].status, parcelStatus);
        assert.notEqual(tracking.body.order.fulfillmentState, 'delivered', 'warehouse dispatch must never claim carrier proof delivery');
      }
      const tracking = await buyer.agent.get('/api/v1/orders/' + fixture.order.publicId).expect(200);
      assert.equal(tracking.body.order.fulfillmentState, 'ready'); assert.equal(tracking.body.order.shipment.status, 'ready');
      assert.equal((await SellerOrder.findById(fixture.sellerOrder._id)).status, 'ready');
      assert.equal((await SellerShipment.findOne({ orderId: fixture.order._id })).status, 'handed_over');
      const label = await operator.agent.get('/warehouse/parcels/' + fixture.parcel.publicId + '/label').expect(200);
      assert.ok(label.text.includes(fixture.parcel.barcode)); assert.match(label.text, /Code 39/); assert.match(label.text, /<svg/);
      for (const privateValue of [buyer.user.email, buyer.user.phone, item.variant._id]) assert.equal(label.text.includes(String(privateValue)), false);
      await PlatformGrant.updateOne({ _id: operator.grant._id }, { $set: { warehouseScopes: [excluded.publicId] } });
      await operator.agent.get('/warehouse/parcels/' + fixture.parcel.publicId + '/label').expect(404);
      await PlatformGrant.updateOne({ _id: operator.grant._id }, { $set: { warehouseScopes: [warehouse.publicId] } });
    });

    await t.test('pick waves claim complete real parcel tasks once and release or complete all tasks consistently', async () => {
      const waveBuyer = await actor({ mfa: false }), fixtures = [];
      fixtures.push(await paidOrder(buyer, item), await paidOrder(waveBuyer, item));
      const tasks = [];
      for (const fixture of fixtures) tasks.push((await parcelTask(operator, fixture, 'pick')).task);
      const body = { warehousePublicId: warehouse.publicId, version: (await Warehouse.findById(warehouse._id)).__v, batchSize: 2, actionKey: actionKey() };
      await mutation(operator, '/warehouse/pick-waves', body); await mutation(operator, '/warehouse/pick-waves', body);
      let wave = await WarehouseWave.findOne({ warehouseId: warehouse._id, status: 'in_progress' });
      assert.ok(wave); assert.equal(wave.taskCount, 2); assert.equal(await WarehouseWave.countDocuments({ warehouseId: warehouse._id }), 1);
      assert.ok((await WarehouseTask.find({ _id: { $in: tasks.map(task => task._id) } })).every(task => task.status === 'in_progress' && task.wavePublicId === wave.publicId));
      await mutation(second, `/warehouse/pick-waves/${wave.publicId}/release`, { version: wave.__v }, { status: 409 });
      await mutation(operator, `/warehouse/pick-waves/${wave.publicId}/release`, { version: wave.__v });
      assert.equal((await WarehouseWave.findById(wave._id)).status, 'released');
      assert.ok((await WarehouseTask.find({ _id: { $in: tasks.map(task => task._id) } })).every(task => task.status === 'open' && !task.wavePublicId && !task.assignedUserId));
      await mutation(operator, '/warehouse/pick-waves', { ...body, version: (await Warehouse.findById(warehouse._id)).__v, actionKey: actionKey() });
      wave = await WarehouseWave.findOne({ warehouseId: warehouse._id, status: 'in_progress' });
      for (const task of tasks) await taskAction(operator, task, 'execute');
      const complete = await WarehouseWave.findById(wave._id);
      assert.equal(complete.status, 'completed'); assert.equal(complete.history.filter(row => row.action === 'task_completed').length, tasks.length);
      assert.ok((await Parcel.find({ _id: { $in: fixtures.map(fixture => fixture.parcel._id) } })).every(parcel => parcel.status === 'picked'));
    });

    await t.test('buyer cancellation removes queued warehouse work and completes only waves with no remaining live orders', async () => {
      async function cancel(fixture) {
        const tracking = await buyer.agent.get('/api/v1/orders/' + fixture.order.publicId).expect(200);
        const result = await buyer.agent.post(`/api/v1/orders/${fixture.order.publicId}/cancel`).set('x-csrf-token', tracking.body.csrfToken)
          .send({ reason: 'Buyer cancelled before warehouse picking' });
        assert.equal(result.status, 200, result.body.error?.code);
        assert.equal((await Order.findById(fixture.order._id)).status, 'cancelled');
        assert.equal((await Parcel.findById(fixture.parcel._id)).status, 'cancelled');
        assert.ok((await WarehouseTask.find({ orderId: fixture.order._id })).every(task => task.status === 'cancelled'));
      }
      const sole = await paidOrder(buyer, item), soleTask = (await parcelTask(operator, sole, 'pick')).task;
      await mutation(operator, '/warehouse/pick-waves', { warehousePublicId: warehouse.publicId,
        version: (await Warehouse.findById(warehouse._id)).__v, batchSize: 2, actionKey: actionKey() });
      const soleWave = await WarehouseWave.findOne({ taskIds: soleTask._id });
      assert.ok(soleWave); await cancel(sole);
      assert.equal((await WarehouseWave.findById(soleWave._id)).status, 'completed');
      const cancelled = await paidOrder(buyer, item), live = await paidOrder(buyer, item);
      const cancelledTask = (await parcelTask(operator, cancelled, 'pick')).task, liveTask = (await parcelTask(operator, live, 'pick')).task;
      await mutation(operator, '/warehouse/pick-waves', { warehousePublicId: warehouse.publicId,
        version: (await Warehouse.findById(warehouse._id)).__v, batchSize: 2, actionKey: actionKey() });
      const mixedWave = await WarehouseWave.findOne({ taskIds: { $all: [cancelledTask._id, liveTask._id] } });
      assert.ok(mixedWave); await cancel(cancelled);
      assert.equal((await WarehouseWave.findById(mixedWave._id)).status, 'in_progress');
      const stillOwned = await WarehouseTask.findById(liveTask._id);
      assert.equal(stillOwned.status, 'in_progress'); assert.equal(String(stillOwned.assignedUserId), String(operator.user._id));
      assert.equal(stillOwned.wavePublicId, mixedWave.publicId); assert.notEqual((await Order.findById(live.order._id)).status, 'cancelled');
      await taskAction(operator, liveTask, 'execute');
      assert.equal((await WarehouseWave.findById(mixedWave._id)).status, 'completed');
      assert.equal((await Parcel.findById(live.parcel._id)).status, 'picked');
    });

    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) await t.test('desktop and mobile approved pages complete receiving, bin assignment, paid parcel fulfilment and received-return inspection without clipping or browser errors', async () => {
      const carrier = await actor({ role: 'delivery' });
      await DeliveryProfile.create({ publicId: id('dlp'), userId: carrier.user._id, country: 'UG', transport: 'motorcycle',
        verificationStatus: 'approved', approvedAt: new Date(), available: true, codEnabled: true });
      server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
      const context = await browser.newContext(), errors = [];
      const cookie = (await operator.agent.get('/warehouse')).headers['set-cookie'].find(value => value.startsWith('cm.sid=')).split(';')[0];
      const separator = cookie.indexOf('=');
      await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: origin }]);
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      async function go(mode, query = '') {
        const opened = await page.goto(origin + '/warehouse' + (mode ? '/' + mode : '') + query);
        assert.equal(opened.status(), 200); assert.equal(new URL(page.url()).hash, '');
      }
      async function submit(form, buttonName) {
        assert.equal(await form.locator('[name="_csrf"]').count(), 1);
        assert.equal(await form.locator('[name="version"]').count(), 1);
        const [navigation] = await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), form.getByRole('button', { name: buttonName }).click()]);
        assert.equal(navigation.status(), 200); assert.equal(new URL(page.url()).hash, '');
        assert.match(new URL(page.url()).pathname, /^\/warehouse(?:\/|$)/);
      }
      async function finishTask(task, mode, stale = false) {
        await submit(page.locator(`form[action="/warehouse/tasks/${task.publicId}/claim"]`), /^Claim Task/);
        let form = page.locator(`form[action="/warehouse/tasks/${task.publicId}/execute"]`);
        await form.locator('..').locator('summary').click();
        if (task.parcelId) {
          const manifest = form.locator('..').locator('.warehouse-live-manifest');
          assert.ok(await manifest.isVisible(), `${mode} exposes the real parcel item manifest before confirmation`);
          assert.ok((await manifest.textContent()).includes(item.variant.sku));
        }
        if (stale) {
          await taskAction(operator, task, 'release');
          const [conflict] = await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), form.getByRole('button', { name: 'Confirm Completion', exact: true }).click()]);
          assert.equal(conflict.status(), 409);
          assert.ok(await page.locator('.dashboard-message-error[role="alert"]').isVisible());
          assert.equal((await WarehouseTask.findById(task._id)).status, 'open');
          await go(mode);
          await submit(page.locator(`form[action="/warehouse/tasks/${task.publicId}/claim"]`), /^Claim Task/);
          form = page.locator(`form[action="/warehouse/tasks/${task.publicId}/execute"]`);
          await form.locator('..').locator('summary').click();
        }
        await submit(form, 'Confirm Completion');
        assert.equal((await WarehouseTask.findById(task._id)).status, 'completed');
      }
      for (const width of [1366, 390]) {
        await page.setViewportSize({ width, height: 950 });
        const before = await stockSnapshot(item.stock), reference = id('browser-receive');
        await go('receiving', '?warehousePublicId=' + warehouse.publicId);
        const receiving = page.locator('form.warehouse-live-create-form').filter({ has: page.locator('input[name="type"][value="receive"]') });
        await receiving.locator('[name="stockPublicId"]').selectOption(item.stock.publicId);
        await receiving.locator('[name="quantity"]').fill('4'); await receiving.locator('[name="reference"]').fill(reference);
        await receiving.locator('[name="notes"]').fill('Actual browser receiving confirmation');
        await submit(receiving, 'Create Receiving Task');
        const receivedTask = await WarehouseTask.findOne({ reference });
        assert.ok(receivedTask); await finishTask(receivedTask, 'receiving', width === 390);
        assert.equal((await StockItem.findById(item.stock._id)).onHand, before[0] + 4);
        assert.equal(await InventoryMovement.countDocuments({ reference, type: 'receipt' }), 1);
        await go('receiving', '?warehousePublicId=' + warehouse.publicId);
        const bin = `B-${width}-04`, putReference = id('browser-bin');
        const putAway = page.locator('form.warehouse-live-create-form').filter({ has: page.locator('input[name="type"][value="put_away"]') });
        await putAway.locator('[name="stockPublicId"]').selectOption(item.stock.publicId);
        await putAway.locator('[name="binCode"]').fill(bin); await putAway.locator('[name="reference"]').fill(putReference);
        await submit(putAway, 'Create Put-away Task');
        const putTask = await WarehouseTask.findOne({ reference: putReference }); await finishTask(putTask, 'receiving');
        assert.equal((await StockItem.findById(item.stock._id)).binCode, bin);
        const fixture = await paidOrder(buyer, item), paidStock = await stockSnapshot(item.stock);
        for (const [mode, type, parcelStatus] of [['picking', 'pick', 'picked'], ['packing', 'pack', 'packed'], ['dispatch', 'dispatch', 'handed_over']]) {
          await go(mode, '?warehousePublicId=' + warehouse.publicId);
          const create = page.locator('form.warehouse-live-parcel-form').filter({ has: page.locator(`input[name="parcelPublicId"][value="${fixture.parcel.publicId}"]`) });
          assert.equal(await create.count(), 1, `${mode} offers the real paid parcel action`);
          await submit(create, `Create ${type[0].toUpperCase() + type.slice(1)} Task`);
          const task = await WarehouseTask.findOne({ parcelId: fixture.parcel._id, type });
          const queueRow = page.locator(`form[action="/warehouse/tasks/${task.publicId}/claim"]`).locator('xpath=ancestor::tr');
          assert.equal(Number((await queueRow.locator('[data-label="Quantity"]').textContent()).replaceAll(',', '').trim()), 2, `${mode} displays the parcel units`);
          await finishTask(task, mode); assert.equal((await Parcel.findById(fixture.parcel._id)).status, parcelStatus);
          assert.deepEqual(await stockSnapshot(item.stock), paidStock);
        }
        const tracking = await buyer.agent.get('/api/v1/orders/' + fixture.order.publicId).expect(200);
        assert.equal(tracking.body.order.fulfillmentState, 'ready'); assert.equal(tracking.body.order.sellerShipments[0].status, 'handed_over');
        // Generate the return intake queue through the real delivery proof and
        // return services, so an arbitrary task cannot fabricate stock returns.
        let shipment = await Shipment.findById(fixture.shipment._id).select('+pickupCodeEncrypted +deliveryCodeEncrypted');
        const pickup = decryptSensitive(shipment.pickupCodeEncrypted), delivery = decryptSensitive(shipment.deliveryCodeEncrypted);
        const offer = await offerShipment({ shipment, deliveryUserId: carrier.user._id, earningMinor: 3000, currency: 'UGX', actorUserId: operator.user._id });
        shipment = await acceptDeliveryOffer({ offer, actorUserId: carrier.user._id });
        shipment = await transitionShipment({ shipment, actorUserId: carrier.user._id, nextStatus: 'picked_up', proofCode: pickup });
        shipment = await transitionShipment({ shipment, actorUserId: carrier.user._id, nextStatus: 'in_transit' });
        await transitionShipment({ shipment, actorUserId: carrier.user._id, nextStatus: 'delivered', proofCode: delivery });
        assert.equal((await Order.findById(fixture.order._id)).fulfillmentState, 'delivered');
        const requested = await createReturnRequest(await serviceRequest(buyer), { orderId: fixture.order.publicId,
          items: [{ orderLineId: fixture.order.items[0].linePublicId, quantity: 1 }], reason: 'other', details: 'Goods returned after verified delivery',
          resolution: 'refund', returnMethod: 'dropoff' });
        await decideReturn(await serviceRequest(supervisor), requested.returnRequest.publicId, { decision: 'approve', note: 'Approved item return for warehouse verification' });
        const received = await markReturnReceived(await serviceRequest(supervisor), requested.returnRequest.publicId, 'Goods physically received for stock inspection');
        const returnTask = await WarehouseTask.findOne({ returnRequestId: received._id, type: 'return_inspection' });
        assert.ok(returnTask); const beforeReturn = await stockSnapshot(item.stock);
        await go('returns');
        await submit(page.locator(`form[action="/warehouse/tasks/${returnTask.publicId}/claim"]`), /^Claim Task/);
        const inspect = page.locator(`form[action="/warehouse/tasks/${returnTask.publicId}/execute"]`);
        await inspect.locator('..').locator('summary').click();
        await inspect.locator('[name="disposition"]').selectOption('damaged'); await submit(inspect, 'Confirm Completion');
        const inspectedStock = await StockItem.findById(item.stock._id), inspectedReturn = await ReturnRequest.findById(received._id);
        assert.equal(inspectedStock.onHand, beforeReturn[0] + 1); assert.equal(inspectedStock.damaged, beforeReturn[2] + 1);
        assert.equal(inspectedReturn.items[0].stockDisposition, 'damaged'); assert.equal(inspectedReturn.items[0].warehouseInspectionStatus, 'completed');
        assert.equal(await InventoryMovement.countDocuments({ reference: received.publicId, type: 'return' }), 1);
        const returnedLine = (await Order.findById(fixture.order._id)).items[0];
        assert.equal(returnedLine.returnedQuantity, 1); assert.equal(returnedLine.refundedQuantity, 0);
        for (const mode of ['', 'inventory', 'receiving', 'picking', 'packing', 'dispatch', 'returns', 'reports', 'settings']) {
          await go(mode);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `warehouse ${mode} page overflow at ${width}`);
          assert.equal(await page.locator('.role-table-wrap').evaluateAll(wrappers => wrappers.some(wrapper => wrapper.scrollWidth > wrapper.clientWidth + 1)), false, `warehouse ${mode} table clipping at ${width}`);
          assert.equal(await page.locator('a[href^="/warehouse"]').evaluateAll(links => links.some(link => new URL(link.href).hash)), false);
          assert.equal(await page.locator('.warehouse-live-page button:visible').evaluateAll(buttons => buttons.some(button => !button.textContent.trim() || Number.parseFloat(getComputedStyle(button).fontSize) < 12)), false, `warehouse ${mode} button labels at ${width}`);
          if (['receiving', 'inventory', 'picking', 'reports'].includes(mode)) {
            await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.effect.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))); });
            await page.screenshot({ path: `/tmp/classic-mart-warehouse-${mode}-${width}.png`, fullPage: true });
          }
        }
      }
      assert.deepEqual(errors, []); await context.close();
    });

    await t.test('inventory summaries include rows beyond the cursor page; scans, country filters and CSV exports remain scoped and bounded', async () => {
      const rows = Array.from({ length: 185 }, (_, index) => ({ publicId: id('var'), productId: item.product._id, storeId: store._id,
        sku: `WAREHOUSE-${suffix}-BULK-${index}`, title: `Inventory aggregate SKU ${index}`, priceMinor: 1000, costMinor: 12345,
        currency: 'UGX', active: true }));
      const variants = await ProductVariant.insertMany(rows);
      await StockItem.insertMany(variants.map(variant => ({ publicId: id('stk'), storeId: store._id, warehouseId: warehouse._id,
        variantId: variant._id, onHand: 4, reorderPoint: 4 })));
      const expected = await StockItem.find({ warehouseId: warehouse._id }).lean();
      const first = await operator.agent.get('/warehouse/inventory').set('accept', 'application/json').expect(200);
      assert.equal(first.body.inventory.length, 25); assert.equal(first.body.page.total, expected.length); assert.equal(first.body.page.hasMore, true);
      assert.equal(first.body.summary.skuCount, expected.length);
      assert.equal(first.body.summary.availableUnits, expected.reduce((sum, row) => sum + row.onHand - row.reserved - row.damaged - row.quarantined, 0));
      assert.equal(first.body.summary.lowStockCount, expected.filter(row => row.onHand - row.reserved - row.damaged - row.quarantined <= row.reorderPoint).length);
      const next = await operator.agent.get('/warehouse/inventory?after=' + encodeURIComponent(first.body.page.next)).set('accept', 'application/json').expect(200);
      assert.equal(next.body.inventory.length, 25);
      assert.equal(next.body.inventory.some(row => first.body.inventory.some(other => other.publicId === row.publicId)), false);
      assertPrivateDto(next.body, [privateItem.product.title, excluded.name, tanzania.name, item.variant._id]);
      const scanned = await operator.agent.get('/warehouse/inventory?scanCode=' + encodeURIComponent(item.variant.sku)).set('accept', 'application/json').expect(200);
      assert.equal(scanned.body.inventory.length, 1); assert.equal(scanned.body.inventory[0].publicId, item.stock.publicId);
      const literal = await operator.agent.get('/warehouse/inventory?scanCode=%5B.*').set('accept', 'application/json').expect(200);
      assert.equal(literal.body.inventory.length, 0);
      await operator.agent.get('/warehouse/inventory?warehousePublicId=' + excluded.publicId).set('accept', 'application/json').expect(404);
      for (const mode of ['overview', 'inventory', 'receiving', 'picking', 'packing', 'dispatch', 'returns', 'reports', 'settings']) {
        const canonical = mode === 'overview' ? '/warehouse' : '/warehouse/' + mode;
        await operator.agent.get('/dashboard/warehouse-' + mode + '?taskStatus=open').expect(308).expect('location', canonical + '?taskStatus=open');
      }
      const movement = await InventoryMovement.create({ publicId: id('mov'), storeId: store._id, warehouseId: warehouse._id, stockItemId: item.stock._id,
        variantId: item.variant._id, type: 'adjustment', quantity: 0, onHandBefore: 4, onHandAfter: 4, reservedBefore: 0, reservedAfter: 0,
        reason: ' \t+FORMULA', reference: '=HYPERLINK("https://example.com")', actorUserId: operator.user._id });
      // Existing records can predate schema trimming. Exercise the export
      // boundary against that historical value, rather than a normalized form.
      await InventoryMovement.collection.insertOne({ ...movement.toObject(), _id: new mongoose.Types.ObjectId(), publicId: id('mov'), reason: ' \t+FORMULA' });
      const exported = await operator.agent.get('/warehouse/reports/export.csv').expect(200);
      assert.match(exported.headers['content-type'], /text\/csv/); assert.match(exported.headers['content-disposition'], /attachment/);
      assert.ok(exported.text.includes(movement.publicId)); assert.ok(exported.text.includes('"\'=HYPERLINK(""https://example.com"")"'));
      assert.ok(exported.text.includes('"\' \t+FORMULA"'));
      for (const privateValue of [privateItem.product.title, excluded.name, operator.user.email, buyer.user.email, item.variant._id])
        assert.equal(exported.text.includes(String(privateValue)), false);
      await InventoryMovement.insertMany(Array.from({ length: 501 }, () => ({ publicId: id('mov'), storeId: store._id, warehouseId: warehouse._id,
        stockItemId: item.stock._id, variantId: item.variant._id, type: 'adjustment', quantity: 0, onHandBefore: 4, onHandAfter: 4,
        reservedBefore: 0, reservedAfter: 0, reason: 'Bounded historical movement export fixture', reference: id('export'), actorUserId: operator.user._id })));
      await operator.agent.get('/warehouse/reports/export.csv').set('accept', 'application/json').expect(422);
    });
  } finally {
    t.mock.restoreAll();
    for (const transport of transports) transport.destroy();
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    try {
      assert.equal(mongoose.connection.name, database);
      if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    } finally { await mongoose.disconnect(); }
  }
});

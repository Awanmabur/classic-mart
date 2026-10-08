import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const suffix = crypto.randomBytes(8).toString('hex');

test('payment authorisation and seller API fulfilment commit once with recoverable replay', { skip: !uri }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  await mongoose.connect(uri, { dbName: `classicmart_order_payment_api_test_${suffix}` });
  const { createApp } = await import('../src/app.js');
  const { User, Store, StoreMember, Warehouse, StockItem, InventoryReservation, InventoryMovement, Order, SellerOrder,
    Shipment, SellerShipment, Parcel, PaymentIntent, LedgerTransaction, AuditLog, WarehouseTask,
    CountrySetting, ApiIdempotency, WebhookEndpoint, WebhookDelivery, FinancialDocument } = await import('../src/models/index.js');
  const { initiatePayment } = await import('../src/services/payments.js');
  const { createApiClient } = await import('../src/services/stage11.js');
  const { ensureLedgerAccount, postLedgerTransaction, accountBalanceMinor } = await import('../src/services/money.js');
  const { encryptSensitive } = await import('../src/core/sensitive.js');
  const app = createApp(null);
  let counter = 0;
  const id = prefix => `${prefix}_${suffix}_${++counter}`;
  async function actor(role) {
    const publicId = id('usr'), email = `${publicId}@example.com`, phone = `+2567${crypto.randomInt(10000000, 99999999)}`;
    return User.create({ publicId, name: `${role} API Test`, email, emailNormalized: email, phone, phoneNormalized: phone,
      passwordHash: crypto.randomBytes(32).toString('hex'), role, country: 'UG', currency: 'UGX', emailVerifiedAt: new Date(),
      onboardingCompletedAt: new Date(), consents: { terms: true, privacy: true, recordedAt: new Date() } });
  }
  let owner, buyer, store, warehouse, membership;
  async function pendingOrder(method = 'cod') {
    const variantId = new mongoose.Types.ObjectId(), productId = new mongoose.Types.ObjectId();
    const stock = await StockItem.create({ publicId: id('stk'), storeId: store._id, warehouseId: warehouse._id, variantId, onHand: 20, reserved: 2 });
    const reservation = await InventoryReservation.create({ publicId: id('rsv'), idempotencyKey: id('reserve'), storeId: store._id,
      stockItemId: stock._id, variantId, quantity: 2, expiresAt: new Date(Date.now() + 600_000), actorUserId: buyer._id });
    const line = { linePublicId: id('line'), productId, variantId, storeId: store._id, reservationPublicId: reservation.publicId,
      productPublicId: id('prd'), variantPublicId: id('var'), storePublicId: store.publicId, title: 'Order API Test Item',
      variantTitle: 'Standard', sku: id('SKU').toUpperCase(), quantity: 2, unitPriceMinor: 5000, unitCostMinor: 777,
      costSnapshotStatus: 'captured', lineTotalMinor: 10000, currency: 'UGX' };
    const order = await Order.create({ publicId: id('ord'), idempotencyKey: id('order-key'), checkoutId: id('checkout'),
      cartPublicId: id('cart'), sessionKey: id('session'), userId: buyer._id, country: 'UG', deliveryMethod: 'standard', paymentMethod: method,
      contact: { fullName: buyer.name, email: buyer.email, phone: buyer.phone, address: '10 Test Road', city: 'Kampala', country: 'Uganda', note: '' },
      totals: { subtotalMinor: 10000, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 10000, currency: 'UGX' },
      items: [line], reservationExpiresAt: reservation.expiresAt });
    const sellerOrder = await SellerOrder.create({ publicId: id('sord'), orderId: order._id, orderPublicId: order.publicId, storeId: store._id,
      storePublicId: store.publicId, country: 'UG', subtotalMinor: 10000, platformFeeMinor: 500, currency: 'UGX',
      items: [{ ...line, orderLineId: line.linePublicId, grossMinor: 10000, customerPaidMinor: 10000, platformFeeMinor: 500, sellerReceivableMinor: 9500 }] });
    const paymentKey = id('payment-key');
    const serviceRequest = { user: buyer, session: { cartKey: order.sessionKey }, get: () => '', id: id('req') };
    return { order, sellerOrder, stock, reservation, paymentKey, serviceRequest };
  }
  const pay = f => initiatePayment(f.serviceRequest, { orderId: f.order.publicId, idempotencyKey: f.paymentKey });
  async function counts(f) {
    return { shipments: await Shipment.countDocuments({ orderId: f.order._id }), parcels: await Parcel.countDocuments({ orderPublicId: f.order.publicId }),
      sellerShipments: await SellerShipment.countDocuments({ orderId: f.order._id }), sales: await InventoryMovement.countDocuments({ reference: f.order.publicId, type: 'sale' }) };
  }
  try {
    await Promise.all([User, Store, StoreMember, Warehouse, StockItem, InventoryReservation, Order, SellerOrder, Shipment, SellerShipment,
      Parcel, PaymentIntent, ApiIdempotency, WebhookDelivery, LedgerTransaction, FinancialDocument].map(Model => Model.init()));
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256',
      growth: { loyaltyEnabled: false, referralEnabled: false } });
    owner = await actor('seller'); buyer = await actor('customer');
    store = await Store.create({ publicId: id('sto'), ownerUserId: owner._id, name: 'Payment API Test Store', slug: id('store'),
      country: 'UG', currency: 'UGX', status: 'verified', verifiedAt: new Date() });
    membership = await StoreMember.create({ publicId: id('stm'), storeId: store._id, userId: owner._id, invitedByUserId: owner._id, role: 'owner', status: 'active' });
    warehouse = await Warehouse.create({ publicId: id('wh'), storeId: store._id, ownerUserId: owner._id, name: 'Actual Reserved Warehouse',
      country: 'UG', city: 'Kampala', address: 'Warehouse Test Road', active: true });

    await t.test('COD shipment failure rolls back inventory and confirmation; same key retries successfully', async () => {
      const f = await pendingOrder();
      t.mock.method(Shipment, 'create', async () => { throw new Error('Shipment creation unavailable'); });
      await assert.rejects(pay(f), /Shipment creation unavailable/);
      t.mock.restoreAll();
      assert.equal((await Order.findById(f.order._id)).paymentState, 'unpaid');
      assert.equal((await SellerOrder.findById(f.sellerOrder._id)).status, 'pending_payment');
      assert.equal((await PaymentIntent.findOne({ orderId: f.order._id })).status, 'created');
      assert.equal((await StockItem.findById(f.stock._id)).onHand, 20);
      assert.equal((await StockItem.findById(f.stock._id)).reserved, 2);
      assert.equal((await InventoryReservation.findById(f.reservation._id)).status, 'active');
      assert.deepEqual(await counts(f), { shipments: 0, parcels: 0, sellerShipments: 0, sales: 0 });
      const success = await pay(f);
      assert.equal(success.status, 'pending_collection');
      assert.equal((await Order.findById(f.order._id)).status, 'confirmed');
      assert.equal((await SellerOrder.findById(f.sellerOrder._id)).status, 'confirmed');
      assert.equal((await StockItem.findById(f.stock._id)).onHand, 18);
      assert.equal((await StockItem.findById(f.stock._id)).reserved, 0);
      assert.equal((await InventoryReservation.findById(f.reservation._id)).status, 'committed');
      assert.deepEqual(await counts(f), { shipments: 1, parcels: 1, sellerShipments: 1, sales: 1 });
      assert.equal((await pay(f)).id, success.id);
      assert.deepEqual(await counts(f), { shipments: 1, parcels: 1, sellerShipments: 1, sales: 1 });
    });

    await t.test('legacy confirmed COD replay repairs missing shipment without recommitting expired stock', async () => {
      const f = await pendingOrder(); await pay(f);
      await SellerShipment.deleteMany({ orderId: f.order._id });
      await Parcel.deleteMany({ orderPublicId: f.order.publicId });
      await Shipment.deleteMany({ orderId: f.order._id });
      await Order.updateOne({ _id: f.order._id }, { $set: { reservationExpiresAt: new Date(Date.now() - 60_000) } });
      await pay(f);
      assert.deepEqual(await counts(f), { shipments: 1, parcels: 1, sellerShipments: 1, sales: 1 });
      assert.equal((await StockItem.findById(f.stock._id)).onHand, 18);
      await SellerShipment.deleteMany({ orderId: f.order._id });
      await Parcel.deleteMany({ orderPublicId: f.order.publicId });
      await Shipment.deleteMany({ orderId: f.order._id });
      await Order.updateOne({ _id: f.order._id }, { $set: { cancellationState: 'cancelled', status: 'cancelled' } });
      await pay(f);
      assert.equal(await Shipment.countDocuments({ orderId: f.order._id }), 0, 'cancelled replay must never recreate a carrier shipment');
    });

    await t.test('wallet charge, ledger receipt and shipment roll back together and retry charges once', async () => {
      const wallet = await ensureLedgerAccount({ code: 'customer_wallet', type: 'liability', ownerType: 'customer', ownerId: buyer._id,
        ownerPublicId: buyer.publicId, country: 'UG', currency: 'UGX' });
      const cash = await ensureLedgerAccount({ code: 'test_wallet_clearing', type: 'asset', ownerType: 'platform', ownerPublicId: 'classic-mart', country: 'UG', currency: 'UGX' });
      await postLedgerTransaction({ idempotencyKey: id('wallet-fund'), referenceType: 'test_funding', referencePublicId: buyer.publicId,
        country: 'UG', currency: 'UGX', description: 'Fund local test wallet', entries: [{ account: cash, debitMinor: 30000, creditMinor: 0 }, { account: wallet, debitMinor: 0, creditMinor: 30000 }] });
      const f = await pendingOrder('wallet');
      t.mock.method(Shipment, 'create', async () => { throw new Error('Wallet shipment unavailable'); });
      await assert.rejects(pay(f), /Wallet shipment unavailable/);
      t.mock.restoreAll();
      assert.equal(await accountBalanceMinor(wallet._id), 30000);
      assert.equal(await FinancialDocument.countDocuments({ orderId: f.order._id }), 0);
      assert.equal((await SellerOrder.findById(f.sellerOrder._id)).status, 'pending_payment');
      assert.deepEqual(await counts(f), { shipments: 0, parcels: 0, sellerShipments: 0, sales: 0 });
      const paid = await pay(f);
      assert.equal(paid.status, 'succeeded');
      assert.equal(await accountBalanceMinor(wallet._id), 20000);
      assert.equal(await FinancialDocument.countDocuments({ orderId: f.order._id }), 1);
      await pay(f);
      assert.equal(await accountBalanceMinor(wallet._id), 20000);
      assert.equal(await LedgerTransaction.countDocuments({ idempotencyKey: `payment:${paid.id}` }), 1);
      assert.deepEqual(await counts(f), { shipments: 1, parcels: 1, sellerShipments: 1, sales: 1 });
    });

    await t.test('unverified online intent cannot use payment replay to create fulfilment', async () => {
      const f = await pendingOrder('card');
      await InventoryReservation.updateOne({ _id: f.reservation._id }, { $set: { status: 'committed', committedAt: new Date() } });
      await Order.updateOne({ _id: f.order._id }, { $set: { status: 'paid', paymentState: 'paid' } });
      await PaymentIntent.create({ publicId: id('pay'), orderId: f.order._id, orderPublicId: f.order.publicId, country: 'UG',
        idempotencyKey: f.paymentKey, provider: 'pesapal', method: 'card', status: 'succeeded', amountMinor: 10000, currency: 'UGX' });
      await pay(f);
      assert.equal(await Shipment.countDocuments({ orderId: f.order._id }), 0);
    });

    await t.test('seller API scopes and versions guard sanitised list/detail and sequential fulfilment', async () => {
      const f = await pendingOrder(); await pay(f);
      const { apiKey } = await createApiClient({ user: owner, store, name: 'Order fulfilment test', scopes: ['orders:read', 'orders:fulfil'], requestsPerMinute: 120 });
      const { apiKey: readKey } = await createApiClient({ user: owner, store, name: 'Read only order test', scopes: ['orders:read'], requestsPerMinute: 120 });
      const base = '/api/v1/seller/orders/' + f.sellerOrder.publicId;
      const listing = await request(app).get('/api/v1/seller/orders?limit=100').set('Authorization', `Bearer ${apiKey}`).expect(200);
      const listed = listing.body.data.find(row => row.id === f.sellerOrder.publicId);
      assert.ok(listed);
      for (const key of ['unitCostMinor','costSnapshotStatus','sellerReceivableMinor','grossMinor','platformFeeMinor','reservationPublicId']) assert.equal(key in listed.items[0], false, key);
      const detail = await request(app).get(base).set('Authorization', `Bearer ${apiKey}`).expect(200);
      assert.equal(detail.body.order.contact.phone, buyer.phone);
      assert.doesNotMatch(JSON.stringify(detail.body), /pickupCode|deliveryCode|providerTracking|secretHash/);
      await request(app).post(base + '/processing').set('Authorization', `Bearer ${readKey}`).set('Idempotency-Key', id('api-read-forbidden')).set('If-Match', '0').send({}).expect(403);
      await request(app).post(base + '/processing').set('Authorization', `Bearer ${apiKey}`).set('Idempotency-Key', id('api-version-required')).send({}).expect(428);
      const processingKey = id('api-processing');
      const post = (action, version, key = id('api-action')) => request(app).post(base + '/' + action).set('Authorization', `Bearer ${apiKey}`).set('Idempotency-Key', key).set('If-Match', String(version)).send({});
      const processing = await post('processing', detail.body.order.version, processingKey).expect(200);
      assert.equal(processing.body.order.status, 'processing');
      const replay = await post('processing', detail.body.order.version, processingKey).expect(200);
      assert.equal(replay.body.idempotencyReplayed, true);
      assert.deepEqual(replay.body.order, processing.body.order);
      await post('pack', processing.body.order.version).expect(409);
      await post('pick', detail.body.order.version).expect(409);
      const picked = await post('pick', processing.body.order.version).expect(200);
      const packed = await post('pack', picked.body.order.version).expect(200);
      const ready = await post('dispatch', packed.body.order.version).expect(200);
      assert.equal(ready.body.order.status, 'ready');
      assert.equal(ready.body.order.sellerShipment.status, 'handed_over');
      assert.equal(ready.body.order.statusLabel, 'Ready for carrier pickup');
      assert.equal((await Order.findById(f.order._id)).fulfillmentState, 'ready');
      assert.equal(await WarehouseTask.countDocuments({ orderId: f.order._id, status: 'completed' }), 3);
      assert.equal(await InventoryMovement.countDocuments({ reference: f.order.publicId, type: 'sale' }), 1);
      await StoreMember.updateOne({ _id: membership._id }, { $set: { status: 'revoked', revokedAt: new Date() } });
      await post('processing', detail.body.order.version, processingKey).expect(403);
      await request(app).get(base).set('Authorization', `Bearer ${apiKey}`).expect(403);
      await StoreMember.updateOne({ _id: membership._id }, { $set: { status: 'active', revokedAt: null } });
    });

    await t.test('committed API action survives completion-response failure with one audit and webhook', async () => {
      const f = await pendingOrder(); await pay(f);
      const { client, apiKey } = await createApiClient({ user: owner, store, name: 'Atomic fulfil only key', scopes: ['orders:fulfil'], requestsPerMinute: 120 });
      const endpoint = await WebhookEndpoint.create({ publicId: id('whk'), storeId: store._id, createdByUserId: owner._id,
        url: 'https://example.com/classicmart-order-test', events: ['order.updated'], secretEncrypted: encryptSensitive(crypto.randomBytes(32).toString('hex')), secretLast4: 'test' });
      const key = id('api-crash-safe'), original = ApiIdempotency.updateOne.bind(ApiIdempotency);
      t.mock.method(ApiIdempotency, 'updateOne', (...args) => {
        if (!args[2]?.session && args[1]?.$set?.status === 'completed') throw new Error('API response completion unavailable');
        return original(...args);
      });
      const post = () => request(app).post('/api/v1/seller/orders/' + f.sellerOrder.publicId + '/pick')
        .set('Authorization', `Bearer ${apiKey}`).set('Idempotency-Key', key).set('If-Match', '0').send({});
      await post().expect(500);
      t.mock.restoreAll();
      assert.equal((await ApiIdempotency.findOne({ apiClientId: client._id, key })).status, 'completed');
      assert.equal((await Parcel.findOne({ orderPublicId: f.order.publicId })).status, 'picked');
      const response = await post().expect(200);
      assert.equal(response.body.idempotencyReplayed, true);
      assert.equal(response.body.order.version, 1);
      assert.equal(await WarehouseTask.countDocuments({ orderId: f.order._id, type: 'pick', status: 'completed' }), 1);
      assert.equal(await AuditLog.countDocuments({ action: 'external.order_pick', targetPublicId: f.sellerOrder.publicId }), 1);
      assert.equal(await WebhookDelivery.countDocuments({ endpointId: endpoint._id, 'payload.resourcePublicId': f.sellerOrder.publicId }), 1);
    });
  } finally {
    t.mock.restoreAll();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

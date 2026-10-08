import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import mongoose from 'mongoose';
import request from 'supertest';
import sharp from 'sharp';
import { chromium } from '@playwright/test';

const suffix = crypto.randomBytes(8).toString('hex');
process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
process.env.UPLOAD_DIR = `/tmp/classicmart-order-evidence-test-${suffix}`;
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('seller orders complete payment-gated, isolated and atomic warehouse fulfilment with honest buyer tracking', { skip: !uri }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const database = `classicmart_seller_orders_test_${suffix}`;
  await mongoose.connect(uri, { dbName: database });
  const { createApp } = await import('../src/app.js');
  const { User, Store, StoreMember, Product, ProductVariant, Category, Warehouse, StockItem, InventoryMovement,
    InventoryReservation, Order, SellerOrder, SellerShipment, Shipment, Parcel, WarehouseTask, CountrySetting,
    ShippingZone, AuditLog, OutboxEvent, DeliveryOffer, DeliveryProfile } = await import('../src/models/index.js');
  const { hashPassword } = await import('../src/core/crypto.js');
  const { pendingMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
  const { sellerOrderList, sellerOrderDetail, transitionSellerOrder } = await import('../src/services/seller-orders.js');
  const { offerShipment, acceptDeliveryOffer, transitionShipment } = await import('../src/services/logistics.js');
  const { decryptSensitive } = await import('../src/core/sensitive.js');
  const { sanitizeAndStoreEvidenceImage } = await import('../src/services/media.js');
  const password = `Orders-${suffix}A1!`, app = createApp(null), transports = [];
  let actorSequence = 0, catalogueSequence = 0, orderSequence = 0, server, browser;

  async function actor(role = 'seller', country = 'UG', mfa = true) {
    const index = actorSequence++, email = `orders-${suffix}-${index}@example.com`, phone = '+2567' + crypto.randomInt(10000000, 99999999);
    const user = await User.create({ publicId: `usr_orders_${suffix}_${index}`, name: `Order User ${index}`, email, emailNormalized: email,
      phone, phoneNormalized: phone, passwordHash: await hashPassword(password), role, country, currency: country === 'UG' ? 'UGX' : 'KES',
      emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), consents: { terms: true, privacy: true, recordedAt: new Date() } });
    const transport = new http.Agent({ localAddress: `127.0.0.${index + 2}`, keepAlive: false });
    transports.push(transport);
    const agent = request.agent(app).use(req => req.agent(transport));
    const login = await agent.get('/login').expect(200);
    await agent.post('/login').type('form').send({ email, password, _csrf: csrf(login.text) }).expect(302);
    if (mfa) {
      const security = await agent.get('/account/security').expect(200);
      await agent.post('/account/mfa/begin').type('form').send({ currentPassword: password, _csrf: csrf(security.text) }).expect(302);
      const pending = await pendingMfaEnrollment(user._id);
      assert.ok(pending?.secret);
      await agent.post('/account/mfa/confirm').type('form').send({ code: totpCode(pending.secret), _csrf: csrf((await agent.get('/account/security')).text) }).expect(302);
      assert.equal((await User.findById(user._id)).security.mfaEnabled, true);
    }
    return { user: await User.findById(user._id), agent };
  }
  async function seller() {
    const member = await actor();
    await member.agent.get('/seller/products').expect(200);
    member.store = await Store.findOneAndUpdate({ ownerUserId: member.user._id }, { $set: { status: 'verified', verifiedAt: new Date() } }, { returnDocument: 'after' });
    return member;
  }
  function serviceRequest(member, sellerOrder, version = sellerOrder.__v, fields = {}) {
    return { id: `orders-${suffix}-${crypto.randomBytes(4).toString('hex')}`, user: member.user, store: member.store,
      params: { publicId: sellerOrder.publicId }, body: { version, ...fields }, country: { code: 'UG' }, get: () => '' };
  }
  async function catalogue(member, warehouse, title) {
    const index = catalogueSequence++;
    const category = await Category.findOne({ publicId: `cat_orders_${suffix}` });
    const product = await Product.create({ publicId: `prd_orders_${suffix}_${index}`, storeId: member.store._id, ownerUserId: member.user._id,
      categoryId: category._id, title, slug: `orders-${suffix}-${index}`, description: 'A real published catalogue item used to verify checkout and seller warehouse fulfilment.', countries: ['UG'], status: 'published' });
    const variant = await ProductVariant.create({ publicId: `var_orders_${suffix}_${index}`, productId: product._id, storeId: member.store._id,
      sku: `ORDERS-${suffix}-${index}`, title: 'Default', priceMinor: 45000 + index * 1000, costMinor: 12345, currency: 'UGX', active: true, weightGrams: 200 });
    const stock = await StockItem.create({ publicId: `stk_orders_${suffix}_${index}`, storeId: member.store._id, variantId: variant._id,
      warehouseId: warehouse._id, onHand: 100, reserved: 0, reorderPoint: 5 });
    return { product, variant, stock };
  }
  async function buyerOrder(buyer, lines, { confirm = true } = {}) {
    const index = orderSequence++, cart = await buyer.agent.get('/api/v1/cart').expect(200);
    for (const { item, quantity = 1 } of lines) await buyer.agent.post('/api/v1/cart/items').set('x-csrf-token', cart.body.csrfToken)
      .send({ productId: item.product.publicId, variantId: item.variant.publicId, quantity }).expect(200);
    const review = await buyer.agent.post('/api/v1/checkout/review').set('x-csrf-token', cart.body.csrfToken)
      .send({ deliveryMethod: 'standard', paymentMethod: 'cod', city: 'Kampala' }).expect(200);
    const placed = await buyer.agent.post('/api/v1/orders').set('x-csrf-token', cart.body.csrfToken).send({
      checkoutId: review.body.checkoutId, idempotencyKey: `order-place-${suffix}-${index}`, deliveryMethod: 'standard', paymentMethod: 'cod', city: 'Kampala',
      contact: { fullName: 'Order Test Buyer', email: buyer.user.email, phone: buyer.user.phone, address: 'Buyer collection test street', city: 'Kampala', country: 'Uganda' },
    }).expect(201);
    const order = await Order.findOne({ publicId: placed.body.order.id });
    assert.equal(order.status, 'pending_payment');
    const reservations = await InventoryReservation.find({ publicId: { $in: order.items.map(line => line.reservationPublicId) } });
    assert.equal(reservations.length, lines.length);
    assert.ok(reservations.every(row => row.status === 'active'));
    const token = cart.body.csrfToken, paymentKey = `order-payment-${suffix}-${index}`;
    if (confirm) await confirmOrder(buyer, order, token, paymentKey);
    return { order: await Order.findById(order._id), token, paymentKey, reservations };
  }
  async function confirmOrder(buyer, order, token, paymentKey) {
    const beforeStock = await StockItem.find().sort({ publicId: 1 }).lean();
    const paid = await buyer.agent.post(`/api/v1/orders/${order.publicId}/payment-intents`).set('x-csrf-token', token).send({ idempotencyKey: paymentKey }).expect(201);
    assert.equal(paid.body.payment.provider, 'cod');
    assert.equal(paid.body.payment.status, 'pending_collection');
    const afterStock = await StockItem.find().sort({ publicId: 1 }).lean();
    const beforeById = new Map(beforeStock.map(row => [String(row._id), row]));
    const reservations = await InventoryReservation.find({ publicId: { $in: order.items.map(line => line.reservationPublicId) } });
    assert.ok(reservations.every(row => row.status === 'committed'));
    for (const reservation of reservations) {
      const after = afterStock.find(row => String(row._id) === String(reservation.stockItemId)), before = beforeById.get(String(reservation.stockItemId));
      assert.equal(after.onHand, before.onHand - reservation.quantity);
      assert.equal(after.reserved, before.reserved - reservation.quantity);
    }
    const retry = await buyer.agent.post(`/api/v1/orders/${order.publicId}/payment-intents`).set('x-csrf-token', token).send({ idempotencyKey: paymentKey }).expect(201);
    assert.equal(retry.body.payment.id, paid.body.payment.id);
    assert.deepEqual((await StockItem.find().sort({ publicId: 1 }).lean()).map(row => [row.publicId, row.onHand, row.reserved]), afterStock.map(row => [row.publicId, row.onHand, row.reserved]));
    assert.equal(await Shipment.countDocuments({ orderId: order._id, kind: 'outbound' }), 1);
    assert.equal(await Parcel.countDocuments({ orderPublicId: order.publicId }), new Set(order.items.map(line => line.storePublicId)).size);
    assert.equal(await SellerShipment.countDocuments({ orderId: order._id }), new Set(order.items.map(line => line.storePublicId)).size);
  }
  async function postAction(member, sellerOrder, action, { version, fields = {}, status = 200, includeCsrf = true } = {}) {
    const page = await member.agent.get('/seller/orders/' + sellerOrder.publicId).expect(200);
    const current = await SellerOrder.findById(sellerOrder._id);
    return member.agent.post(`/seller/orders/${sellerOrder.publicId}/${action}`).set('accept', 'application/json').type('form')
      .send({ version: version ?? current.__v, ...(includeCsrf ? { _csrf: csrf(page.text) } : {}), ...fields }).expect(status);
  }
  async function tracking(buyer, order, fulfillmentState, parcelState) {
    const response = await buyer.agent.get('/api/v1/orders/' + order.publicId).expect(200);
    assert.equal(response.body.order.fulfillmentState, fulfillmentState);
    if (parcelState) assert.equal(response.body.order.sellerShipments[0].status, parcelState);
    return response.body.order;
  }
  async function snapshot(order) {
    const [root, sellers, parcels, shipments, tasks, audits, outbox] = await Promise.all([
      Order.findById(order._id).lean(), SellerOrder.find({ orderId: order._id }).sort({ publicId: 1 }).lean(),
      Parcel.find({ orderPublicId: order.publicId }).sort({ publicId: 1 }).lean(), SellerShipment.find({ orderId: order._id }).sort({ publicId: 1 }).lean(),
      WarehouseTask.find({ orderId: order._id }).sort({ publicId: 1 }).lean(), AuditLog.find({ targetPublicId: { $in: (await SellerOrder.find({ orderId: order._id }).lean()).map(row => row.publicId) } }).sort({ _id: 1 }).lean(),
      OutboxEvent.countDocuments(),
    ]);
    return JSON.parse(JSON.stringify({ root, sellers, parcels, shipments, tasks, audits, outbox }));
  }

  try {
    await Promise.all([Store.init(), StoreMember.init(), Product.init(), ProductVariant.init(), StockItem.init(), Category.init(),
      Order.init(), SellerOrder.init(), SellerShipment.init(), Shipment.init(), Parcel.init(), InventoryReservation.init(), WarehouseTask.init()]);
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true });
    await ShippingZone.create({ publicId: `zone_orders_${suffix}`, country: 'UG', name: 'Kampala test delivery', cities: ['Kampala'], standardFeeMinor: 5000, currency: 'UGX', active: true });
    await Category.create({ publicId: `cat_orders_${suffix}`, name: 'Order Test Goods', slug: `orders-${suffix}`, countries: ['UG'], active: true });
    await request(app).get('/seller/orders').expect(302).expect('location', '/login?next=%2Fseller%2Forders');
    const owner = await seller(), other = await seller(), buyer = await actor('customer', 'UG', false), stranger = await actor('customer', 'UG', false);
    const oldest = await Warehouse.create({ publicId: `wh_oldest_${suffix}`, storeId: owner.store._id, ownerUserId: owner.user._id,
      name: 'Oldest warehouse without reserved goods', country: 'UG', city: 'Kampala', address: 'Old warehouse test address', active: true });
    const actual = await Warehouse.create({ publicId: `wh_actual_${suffix}`, storeId: owner.store._id, ownerUserId: owner.user._id,
      name: 'Actual reserved-stock warehouse', country: 'UG', city: 'Kampala', address: 'Actual warehouse test address', active: true });
    const second = await Warehouse.create({ publicId: `wh_second_${suffix}`, storeId: owner.store._id, ownerUserId: owner.user._id,
      name: 'Second reserved-stock warehouse', country: 'UG', city: 'Kampala', address: 'Second warehouse test address', active: true });
    const foreignWarehouse = await Warehouse.create({ publicId: `wh_foreign_${suffix}`, storeId: other.store._id, ownerUserId: other.user._id,
      name: 'Other store warehouse', country: 'UG', city: 'Kampala', address: 'Other warehouse test address', active: true });
    const main = await catalogue(owner, actual, `Owner reserved-stock item ${suffix}`), extra = await catalogue(owner, second, `Owner second-warehouse item ${suffix}`), foreign = await catalogue(other, foreignWarehouse, `PRIVATE_OTHER_STORE_ITEM_${suffix}`);
    const pending = await buyerOrder(buyer, [{ item: main, quantity: 2 }], { confirm: false });
    let sellerOrder = await SellerOrder.findOne({ orderId: pending.order._id, storeId: owner.store._id });
    const pendingSnapshot = await snapshot(pending.order);
    for (const action of ['processing', 'pick', 'pack', 'dispatch']) await postAction(owner, sellerOrder, action, { status: 409 });
    assert.deepEqual(await snapshot(pending.order), pendingSnapshot, 'unconfirmed COD must not alter inventory or fulfilment');
    await stranger.agent.get('/account/security').expect(200);
    const refusedTracking = await stranger.agent.get('/api/v1/orders/' + pending.order.publicId).expect(401);
    assert.equal(refusedTracking.body.error.code, 'ORDER_TRACKING_VERIFICATION_REQUIRED');
    assert.equal(refusedTracking.body.order, undefined);
    await confirmOrder(buyer, pending.order, pending.token, pending.paymentKey);
    sellerOrder = await SellerOrder.findById(sellerOrder._id);
    assert.equal(sellerOrder.status, 'confirmed');
    const listing = await owner.agent.get('/seller/orders').expect(200);
    assert.match(listing.text, new RegExp(sellerOrder.publicId));
    assert.doesNotMatch(listing.text, /Development preview|role-workspaces\.js|roleSwitcher/);
    assert.match(listing.headers['cache-control'], /private/);
    assert.match(listing.headers['cache-control'], /no-store/);
    assert.equal(listing.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
    await other.agent.get('/seller/orders/' + sellerOrder.publicId).expect(404);
    const otherSecurity = await other.agent.get('/account/security').expect(200);
    await other.agent.post(`/seller/orders/${sellerOrder.publicId}/processing`).type('form').send({ version: sellerOrder.__v, _csrf: csrf(otherSecurity.text) }).expect(404);
    await buyer.agent.get('/seller/orders').expect(403);
    await postAction(owner, sellerOrder, 'processing', { includeCsrf: false, status: 403 });
    for (const version of ['', '-1', '1.5', 'not-a-version']) await postAction(owner, sellerOrder, 'processing', { version, status: 422 });
    for (const action of ['pack', 'dispatch']) await postAction(owner, sellerOrder, action, { status: 409 });
    const initialVersion = sellerOrder.__v;
    await postAction(owner, sellerOrder, 'processing');
    assert.equal((await SellerOrder.findById(sellerOrder._id)).__v, initialVersion + 1);
    await tracking(buyer, pending.order, 'processing', 'created');
    const stale = await postAction(owner, sellerOrder, 'pick', { version: initialVersion, status: 409 });
    assert.equal(stale.body.error.code, 'SELLER_ORDER_VERSION_CONFLICT');
    assert.equal(await WarehouseTask.countDocuments({ orderId: pending.order._id }), 0);

    const unprotectedStaff = await actor('customer', 'UG', false);
    await StoreMember.create({ publicId: `stm_orders_unprotected_${suffix}`, storeId: owner.store._id, userId: unprotectedStaff.user._id,
      invitedByUserId: owner.user._id, role: 'fulfilment', status: 'active' });
    await unprotectedStaff.agent.get('/seller/orders').expect(302).expect('location', '/account/security?next=%2Fseller%2Forders');
    const refusedMfa = await unprotectedStaff.agent.get('/seller/orders').set('accept', 'application/json').expect(403);
    assert.equal(refusedMfa.body.error.code, 'MFA_ENROLLMENT_REQUIRED');
    const staff = await actor('customer', 'UG', true); staff.store = owner.store;
    const delegation = await StoreMember.create({ publicId: `stm_orders_${suffix}`, storeId: owner.store._id, userId: staff.user._id,
      invitedByUserId: owner.user._id, role: 'catalogue', status: 'active' });
    for (const role of ['catalogue', 'finance', 'support']) {
      await StoreMember.updateOne({ _id: delegation._id }, { $set: { role } });
      const staffSecurity = await staff.agent.get('/account/security').expect(200);
      await staff.agent.post(`/seller/orders/${sellerOrder.publicId}/pick`).type('form').send({ version: (await SellerOrder.findById(sellerOrder._id)).__v, _csrf: csrf(staffSecurity.text) }).expect(403);
    }
    await StoreMember.updateOne({ _id: delegation._id }, { $set: { role: 'fulfilment' } });
    const staffDetail = await staff.agent.get('/seller/orders/' + sellerOrder.publicId).expect(200);
    assert.match(staffDetail.text, new RegExp(main.product.title));
    const staffDto = await sellerOrderDetail(serviceRequest(staff, await SellerOrder.findById(sellerOrder._id)));
    assert.doesNotMatch(JSON.stringify(staffDto), /unitCostMinor|platformFeeMinor|sellerReceivableMinor|costSnapshotStatus|passwordHash|pickupCodeHash|deliveryCodeHash|deliveryCodeEncrypted|pickupCodeEncrypted/);
    await StoreMember.updateOne({ _id: delegation._id }, { $set: { status: 'revoked', revokedAt: new Date() } });
    await assert.rejects(transitionSellerOrder(serviceRequest(staff, await SellerOrder.findById(sellerOrder._id)), 'pick'), { code: 'STORE_PERMISSION_DENIED' });
    await StoreMember.updateOne({ _id: delegation._id }, { $set: { status: 'active', revokedAt: null } });
    await User.updateOne({ _id: staff.user._id }, { $inc: { 'security.tokenVersion': 1 } });
    await assert.rejects(transitionSellerOrder(serviceRequest(staff, await SellerOrder.findById(sellerOrder._id)), 'pick'), { code: 'ACCOUNT_UNAVAILABLE' });
    await staff.agent.get('/seller/orders').expect(302).expect('location', '/login?next=%2Fseller%2Forders');

    await Store.updateOne({ _id: owner.store._id }, { $set: { status: 'suspended' } });
    await assert.rejects(transitionSellerOrder(serviceRequest(owner, await SellerOrder.findById(sellerOrder._id)), 'pick'), { code: 'STORE_LOCKED' });
    await Store.updateOne({ _id: owner.store._id }, { $set: { status: 'verified' } });
    const beforeCountry = await snapshot(pending.order);
    await Order.updateOne({ _id: pending.order._id }, { $set: { country: 'KE' } }, { timestamps: false });
    await assert.rejects(transitionSellerOrder(serviceRequest(owner, await SellerOrder.findById(sellerOrder._id)), 'pick'), { code: 'ORDER_COUNTRY_INVALID' });
    await Order.updateOne({ _id: pending.order._id }, { $set: { country: 'UG' } }, { timestamps: false });
    assert.deepEqual(await snapshot(pending.order), beforeCountry);
    await SellerOrder.updateOne({ _id: sellerOrder._id }, { $set: { country: 'KE' } });
    await owner.agent.get('/seller/orders/' + sellerOrder.publicId).expect(404);
    assert.doesNotMatch((await owner.agent.get('/seller/orders')).text, new RegExp(sellerOrder.publicId));
    await SellerOrder.updateOne({ _id: sellerOrder._id }, { $set: { country: 'UG' } });

    const beforeAuditFailure = await snapshot(pending.order);
    t.mock.method(AuditLog, 'create', async () => { throw new Error('Seller order audit unavailable'); });
    try { await assert.rejects(transitionSellerOrder(serviceRequest(owner, await SellerOrder.findById(sellerOrder._id)), 'pick'), /Seller order audit unavailable/); }
    finally { t.mock.restoreAll(); }
    assert.deepEqual(await snapshot(pending.order), beforeAuditFailure, 'audit failure must roll back all parcel/order/tasks and events');
    const raceVersion = (await SellerOrder.findById(sellerOrder._id)).__v;
    const contenders = await Promise.allSettled(Array.from({ length: 6 }, () => transitionSellerOrder(serviceRequest(owner, sellerOrder, raceVersion), 'pick')));
    assert.equal(contenders.filter(row => row.status === 'fulfilled').length, 1, contenders.filter(row => row.status === 'rejected').map(row => row.reason.code || row.reason.message).join(', '));
    assert.ok(contenders.filter(row => row.status === 'rejected').every(row => row.reason.code === 'SELLER_ORDER_VERSION_CONFLICT'));
    assert.equal((await SellerOrder.findById(sellerOrder._id)).__v, raceVersion + 1);
    let task = await WarehouseTask.findOne({ orderId: pending.order._id });
    assert.equal(task.type, 'pick'); assert.equal(task.status, 'completed'); assert.equal(task.quantity, 2);
    assert.equal(String(task.warehouseId), String(actual._id));
    assert.notEqual(String(task.warehouseId), String(oldest._id));
    assert.equal(await WarehouseTask.countDocuments({ orderId: pending.order._id }), 1);
    assert.equal(await AuditLog.countDocuments({ targetPublicId: sellerOrder.publicId, action: 'seller.order_pick' }), 1);
    await tracking(buyer, pending.order, 'processing', 'picked');
    await postAction(owner, sellerOrder, 'pack');
    await tracking(buyer, pending.order, 'processing', 'packed');
    await postAction(owner, sellerOrder, 'dispatch');
    const readyTracking = await tracking(buyer, pending.order, 'ready', 'handed_over');
    assert.equal(readyTracking.shipment.status, 'ready');
    assert.equal((await SellerOrder.findById(sellerOrder._id)).status, 'ready');
    const processingList = await owner.agent.get('/seller/orders?status=processing').set('accept', 'application/json').expect(200);
    assert.ok(processingList.body.orders.some(row => row.publicId === sellerOrder.publicId));
    const notShipped = await owner.agent.get('/seller/orders?status=shipped').set('accept', 'application/json').expect(200);
    assert.equal(notShipped.body.orders.some(row => row.publicId === sellerOrder.publicId), false, 'seller dispatch must not appear under carrier Shipped');
    assert.equal(await WarehouseTask.countDocuments({ orderId: pending.order._id, status: 'completed' }), 3);
    assert.ok((await WarehouseTask.find({ orderId: pending.order._id })).every(row => String(row.warehouseId) === String(actual._id)));
    assert.equal((await StockItem.findById(main.stock._id)).onHand, 98, 'packing and dispatch must not commit or subtract stock again');
    assert.equal(await InventoryMovement.countDocuments({ reference: pending.order.publicId, type: 'sale' }), 1);
    await postAction(owner, sellerOrder, 'dispatch', { status: 409 });

    const carrier = await actor('delivery'), logistics = await actor('warehouse');
    await DeliveryProfile.create({ publicId: `dlp_orders_${suffix}`, userId: carrier.user._id, country: 'UG', transport: 'motorcycle',
      verificationStatus: 'approved', available: true, approvedAt: new Date(), codEnabled: true });
    let shipment = await Shipment.findOne({ orderId: pending.order._id }).select('+pickupCodeEncrypted +deliveryCodeEncrypted');
    const pickupCode = decryptSensitive(shipment.pickupCodeEncrypted), deliveryCode = decryptSensitive(shipment.deliveryCodeEncrypted);
    const offer = await offerShipment({ shipment, deliveryUserId: carrier.user._id, earningMinor: 3000, currency: 'UGX', actorUserId: logistics.user._id });
    shipment = await acceptDeliveryOffer({ offer: await DeliveryOffer.findById(offer._id), actorUserId: carrier.user._id });
    await assert.rejects(transitionShipment({ shipment, nextStatus: 'picked_up', actorUserId: carrier.user._id, proofCode: 'invalid' }), { code: 'PROOF_INVALID' });
    assert.equal((await Order.findById(pending.order._id)).fulfillmentState, 'ready');
    shipment = await transitionShipment({ shipment, nextStatus: 'picked_up', actorUserId: carrier.user._id, proofCode: pickupCode });
    await tracking(buyer, pending.order, 'shipped', 'in_transit');
    shipment = await transitionShipment({ shipment, nextStatus: 'in_transit', actorUserId: carrier.user._id });
    await assert.rejects(transitionShipment({ shipment, nextStatus: 'delivered', actorUserId: carrier.user._id, proofCode: deliveryCode }), { code: 'DELIVERY_PHOTO_REQUIRED' });
    assert.equal((await Order.findById(pending.order._id)).fulfillmentState, 'shipped');
    const photo = await sharp({ create: { width: 640, height: 640, channels: 3, background: '#ef6c00' } }).png().toBuffer();
    await sanitizeAndStoreEvidenceImage({ file: { buffer: photo, mimetype: 'image/png', originalname: 'seller-order-delivery-proof.png' },
      user: carrier.user, country: 'UG', contextType: 'delivery_job', contextPublicId: shipment.publicId, documentType: 'delivery_photo' });
    shipment = await transitionShipment({ shipment, nextStatus: 'delivered', actorUserId: carrier.user._id, proofCode: deliveryCode });
    await tracking(buyer, pending.order, 'delivered', 'delivered');
    assert.equal((await SellerOrder.findById(sellerOrder._id)).status, 'fulfilled');
    assert.equal((await Order.findById(pending.order._id)).items[0].deliveredQuantity, 2);
    assert.equal(shipment.cod.collectedMinor, pending.order.totals.totalMinor);
    const deliveredList = await owner.agent.get('/seller/orders?status=delivered').set('accept', 'application/json').expect(200);
    assert.ok(deliveredList.body.orders.some(row => row.publicId === sellerOrder.publicId));

    const multi = await buyerOrder(buyer, [{ item: main }, { item: extra }]);
    const multiSeller = await SellerOrder.findOne({ orderId: multi.order._id, storeId: owner.store._id });
    await postAction(owner, multiSeller, 'processing');
    await postAction(owner, multiSeller, 'pick');
    const pickTasks = await WarehouseTask.find({ orderId: multi.order._id, type: 'pick' });
    assert.equal(pickTasks.length, 2);
    assert.deepEqual(pickTasks.map(row => String(row.warehouseId)).sort(), [String(actual._id), String(second._id)].sort());
    assert.ok(pickTasks.every(row => row.quantity === 1 && row.status === 'completed'));
    const withoutConsolidation = await snapshot(multi.order);
    await postAction(owner, multiSeller, 'pack', { status: 422 });
    assert.deepEqual(await snapshot(multi.order), withoutConsolidation);
    await postAction(owner, multiSeller, 'pack', { fields: { warehousePublicId: foreignWarehouse.publicId }, status: 422 });
    await postAction(owner, multiSeller, 'pack', { fields: { warehousePublicId: actual.publicId } });
    const beforeIncorrectDispatch = await snapshot(multi.order);
    await postAction(owner, multiSeller, 'dispatch', { fields: { warehousePublicId: second.publicId }, status: 422 });
    assert.deepEqual(await snapshot(multi.order), beforeIncorrectDispatch);
    await postAction(owner, multiSeller, 'dispatch');
    await tracking(buyer, multi.order, 'ready', 'handed_over');

    const split = await buyerOrder(buyer, [{ item: main }, { item: foreign }]);
    const ownSplit = await SellerOrder.findOne({ orderId: split.order._id, storeId: owner.store._id });
    const foreignSplit = await SellerOrder.findOne({ orderId: split.order._id, storeId: other.store._id });
    const isolatedDetail = await owner.agent.get('/seller/orders/' + ownSplit.publicId).expect(200);
    assert.doesNotMatch(isolatedDetail.text, new RegExp(foreign.product.title));
    assert.doesNotMatch((await owner.agent.get('/seller/orders')).text, new RegExp(foreignSplit.publicId));
    const detailDto = await sellerOrderDetail(serviceRequest(owner, ownSplit));
    assert.doesNotMatch(JSON.stringify(detailDto), new RegExp(foreign.product.title));
    await other.agent.get('/seller/orders/' + ownSplit.publicId).expect(404);
    const listDto = await sellerOrderList(serviceRequest(owner, ownSplit), { status: 'all', q: split.order.publicId });
    assert.match(JSON.stringify(listDto), new RegExp(ownSplit.publicId));
    assert.doesNotMatch(JSON.stringify(listDto), new RegExp(foreignSplit.publicId));
    const literalSearch = await owner.agent.get('/seller/orders?search=%5B.*').set('accept', 'application/json').expect(200);
    assert.equal(literalSearch.body.orders.length, 0, 'search metacharacters are literal text');
    const firstPage = await sellerOrderList(serviceRequest(owner, ownSplit), { limit: 1 });
    assert.equal(firstPage.orders.length, 1); assert.equal(firstPage.page.hasMore, true);
    const secondPage = await sellerOrderList(serviceRequest(owner, ownSplit), { limit: 1, after: firstPage.page.next });
    assert.equal(secondPage.orders.length, 1);
    assert.notEqual(secondPage.orders[0].publicId, firstPage.orders[0].publicId);
    const exported = await owner.agent.get('/seller/orders/export.csv').expect(200);
    assert.match(exported.headers['content-type'], /text\/csv/);
    assert.match(exported.text, new RegExp(ownSplit.publicId));
    assert.doesNotMatch(exported.text, new RegExp(foreignSplit.publicId));
    await owner.agent.get('/seller/shipping').expect(200);
    const awaitingPayment = await buyerOrder(buyer, [{ item: main }], { confirm: false });
    const awaitingSeller = await SellerOrder.findOne({ orderId: awaitingPayment.order._id, storeId: owner.store._id });
    const shipmentExport = await owner.agent.get('/seller/orders/export.csv?shipping=1').expect(200);
    assert.doesNotMatch(shipmentExport.text, new RegExp(awaitingSeller.publicId));
    assert.match(shipmentExport.text, new RegExp(ownSplit.publicId));
    const shipmentListing = await owner.agent.get('/seller/shipping').set('accept', 'application/json').expect(200);
    assert.equal(shipmentListing.body.orders.some(row => row.publicId === awaitingSeller.publicId), false);

    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
      server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
      const context = await browser.newContext(), errors = [];
      const cookie = (await owner.agent.get('/seller/orders')).headers['set-cookie'].find(value => value.startsWith('cm.sid=')).split(';')[0];
      const cookieSeparator = cookie.indexOf('=');
      await context.addCookies([{ name: cookie.slice(0, cookieSeparator), value: cookie.slice(cookieSeparator + 1), url: origin }]);
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      for (const width of [1366, 390]) {
        const browserOrder = await buyerOrder(buyer, [{ item: main }]);
        const browserSeller = await SellerOrder.findOne({ orderId: browserOrder.order._id, storeId: owner.store._id });
        await page.setViewportSize({ width, height: 950 });
        const opened = await page.goto(origin + '/seller/orders');
        assert.equal(opened.status(), 200);
        const row = page.locator('tr').filter({ hasText: browserSeller.publicId });
        assert.equal(await row.count(), 1);
        await Promise.all([page.waitForURL(`**/seller/orders/${browserSeller.publicId}`), row.getByRole('link', { name: /^View Order / }).click()]);
        assert.equal(new URL(page.url()).hash, '');
        assert.ok(await page.getByRole('heading', { name: 'Order ' + browserSeller.publicId, exact: true }).isVisible());
        if (width === 390) {
          // Another real operator action invalidates this rendered form. The
          // browser must show a useful error without repeating the mutation.
          await postAction(owner, browserSeller, 'processing');
          const staleForm = page.locator(`form[action="/seller/orders/${browserSeller.publicId}/processing"]`);
          const [conflict] = await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            staleForm.getByRole('button', { name: 'Start Processing', exact: true }).click()]);
          assert.equal(conflict.status(), 409);
          assert.ok(await page.locator('.dashboard-message-error[role="alert"]').isVisible());
          assert.match(await page.locator('.dashboard-message-error[role="alert"]').textContent(), /order changed/i);
          assert.equal((await SellerOrder.findById(browserSeller._id)).__v, browserSeller.__v + 1);
          assert.equal(await WarehouseTask.countDocuments({ orderId: browserOrder.order._id }), 0);
          await page.goto(origin + '/seller/orders/' + browserSeller.publicId);
        }
        for (const [action, name] of [['processing', 'Start Processing'], ['pick', 'Pick Items'], ['pack', 'Confirm Packing'], ['dispatch', 'Dispatch for Pickup']]) {
          if (width === 390 && action === 'processing') continue;
          const form = page.locator(`form[action="/seller/orders/${browserSeller.publicId}/${action}"]`);
          assert.equal(await form.locator('[name="version"]').count(), 1);
          await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), form.getByRole('button', { name, exact: true }).click()]);
          assert.equal(new URL(page.url()).pathname, '/seller/orders/' + browserSeller.publicId);
          assert.equal(new URL(page.url()).hash, '');
        }
        const buyerState = await tracking(buyer, browserOrder.order, 'ready', 'handed_over');
        assert.equal(buyerState.shipment.status, 'ready');
        await page.reload();
        assert.ok(await page.getByText('Ready for pickup', { exact: true }).first().isVisible());
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `seller detail overflow at ${width}`);
        assert.equal(await page.locator('.role-table-wrap').evaluateAll(wrappers => wrappers.some(wrapper => wrapper.scrollWidth > wrapper.clientWidth + 1)), false, `seller detail table clipping at ${width}`);
        await page.evaluate(async () => {
          await Promise.all(document.getAnimations().filter(animation => animation.effect.getTiming().iterations !== Infinity)
            .map(animation => animation.finished.catch(() => {})));
        });
        await page.screenshot({ path: `/tmp/classic-mart-seller-orders-${width}.png`, fullPage: true });
        await page.goto(origin + '/seller/shipping');
        assert.ok(await page.getByRole('heading', { name: 'Shipping & Delivery', exact: true }).isVisible());
        assert.equal(new URL(page.url()).hash, '');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `seller shipping overflow at ${width}`);
        assert.equal(await page.locator('.role-table-wrap').evaluateAll(wrappers => wrappers.some(wrapper => wrapper.scrollWidth > wrapper.clientWidth + 1)), false, `seller shipping table clipping at ${width}`);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    t.mock.restoreAll();
    for (const transport of transports) transport.destroy();
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    // Only this test's randomized database is ever dropped.
    assert.equal(mongoose.connection.name, database);
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
    await fs.rm(process.env.UPLOAD_DIR, { recursive: true, force: true });
  }
});

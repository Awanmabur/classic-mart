import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import mongoose from 'mongoose';
import request from 'supertest';
import sharp from 'sharp';
import { chromium } from '@playwright/test';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('Delivery and Warehouse execute verified custody, private evidence, independent COD and measured reports', { skip: !uri, timeout: 240_000 }, async t => {
  const target = new URL(uri); assert.equal(target.hostname, '127.0.0.1'); assert.match(target.pathname, /verification|test/i);
  const suffix = crypto.randomBytes(7).toString('hex');
  await mongoose.connect(uri, { dbName: 'classicmart_delivery_recovery_test_' + suffix });
  const { createApp } = await import('../src/app.js');
  const models = await import('../src/models/index.js');
  const { User, CountrySetting, Device, PlatformGrant, DeliveryProfile, Store, Category, Product, ProductVariant, ReturnRequest, Warehouse, StockItem, InventoryReservation, Order, SellerOrder,
    Shipment, Parcel, SellerShipment, DeliveryOffer, DeliveryException, EvidenceDocument, WarehouseTask, InventoryDiscrepancy, PaymentIntent,
    LedgerAccount, LedgerTransaction, AuditLog, PayoutAccount, Payout, FinancialDocument } = models;
  const { hashPassword, hashToken } = await import('../src/core/crypto.js');
  const { beginMfaEnrollment, confirmMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
  const { ensureShipmentForOrder, createWarehouseTask, claimWarehouseTask, executeWarehouseTask, reconcileCod } = await import('../src/services/logistics.js');
  const { deliveryAccess } = await import('../src/services/delivery-workspace-access.js');
  const { shipmentSource } = await import('../src/services/delivery-source.js');
  const { loadWarehouseMeasuredReport, prepareWarehouseMeasuredExport, warehouseMeasuredExportRows } = await import('../src/services/warehouse-measured-reports.js');
  const { readMediaObject, deleteMediaObject } = await import('../src/services/object-storage.js');
  const { decryptPrivateBuffer } = await import('../src/core/sensitive.js');
  const { accountBalanceMinor } = await import('../src/services/money.js');
  const { savePayoutAccount, requestPayout, reviewPayoutAccount, rejectPayout } = await import('../src/services/payments.js');
  const { createReturnRequest, decideReturn, markReturnReceived } = await import('../src/services/trust.js');
  const app = createApp(null), password = 'Delivery-' + suffix + '-A1!', passwordHash = await hashPassword(password);
  const transports = [], storageKeys = [], routes = ['/delivery', '/delivery/profile', '/delivery/offers', '/delivery/jobs', '/delivery/tracking', '/delivery/earnings'];
  let sequence = 0, browser, server, carrier, otherCarrier, warehouseActor, financeActor, supportActor, customer, store, warehouse, category;
  const id = prefix => `${prefix}_${suffix}_${++sequence}`;
  const json = client => client.set('Accept', 'application/json');
  async function actor(role, { country = 'UG', currency = 'UGX', mfa = role !== 'customer' } = {}) {
    const index = ++sequence, email = `delivery-${suffix}-${index}@example.com`, phone = '+25672' + String(index).padStart(7, '0');
    let user = await User.create({ publicId: id('usr'), name: role + ' recovery ' + index, email, emailNormalized: email, phone, phoneNormalized: phone,
      passwordHash, role, country, currency, locale: 'en-UG', emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
      consents: { terms: true, privacy: true, recordedAt: new Date() } });
    let codes = [];
    if (mfa) { const pending = await beginMfaEnrollment(user._id, password), confirmed = await confirmMfaEnrollment(user._id, totpCode(pending.secret)); user = confirmed.user; codes = confirmed.codes; }
    const transport = new http.Agent({ localAddress: '127.0.0.' + (100 + (index % 100)), keepAlive: false }); transports.push(transport);
    const client = request.agent(app).use(req => req.agent(transport));
    const form = await client.get('/login').expect(200);
    await client.post('/login').type('form').send({ email, password, _csrf: csrf(form.text) }).expect(302);
    if (mfa) { const challenge = await client.get('/mfa').expect(200); await client.post('/mfa').type('form').send({ code: codes[0], _csrf: csrf(challenge.text) }).expect(302); }
    return { user, client, codes };
  }
  async function context(entry) {
    const sessionID = crypto.randomBytes(24).toString('hex');
    const device = await Device.create({ publicId: id('dev'), userId: entry.user._id, sessionHash: hashToken(sessionID), label: 'Isolated service verification',
      userAgent: 'ClassicMart recovery verification', ipHash: hashToken('127.0.0.1'), lastSeenAt: new Date() });
    return { user: await User.findById(entry.user._id), device, sessionID, session: { userId: String(entry.user._id), tokenVersion: entry.user.security.tokenVersion },
      query: {}, body: {}, params: {}, id: id('req'), ip: '127.0.0.1', get: () => '', log: { error() {}, warn() {} } };
  }
  async function tokenFor(entry, path = '/delivery') { return csrf((await entry.client.get(path).expect(200)).text); }
  const post = (entry, path, body, token) => json(entry.client.post(path)).set('x-csrf-token', token).send(body);
  async function profileRow(entry = carrier) { return DeliveryProfile.findOne({ userId: entry.user._id }); }
  async function shipmentRow(fixture) { return Shipment.findById(fixture.shipment._id); }
  const image = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#c04800' } }).jpeg().withMetadata({ exif: { IFD0: { Artist: 'PRIVATE_DELIVERY_METADATA' } } }).toBuffer();
  async function upload(entry, path, version, documentType, token, extra = {}) {
    let upload = json(entry.client.post(path)).field('_csrf', token).field('version', String(version));
    if (documentType) upload = upload.field('documentType', documentType);
    for (const [key, value] of Object.entries(extra)) upload = upload.field(key, String(value));
    const response = await upload.attach('document', image, { filename: 'proof.jpg', contentType: 'image/jpeg' }).expect(200);
    const evidence = await EvidenceDocument.findOne({ publicId: response.body.record.publicId }).select('+storageKey'); storageKeys.push(evidence.storageKey);
    return evidence;
  }
  async function fixture({ cod = true } = {}) {
    const product = await Product.create({ publicId: id('prd'), storeId: store._id, ownerUserId: store.ownerUserId, categoryId: category._id, title: 'Actual custody test item', slug: id('item'), description: 'Published item for real stock and return custody.', countries: ['UG'], status: 'published' });
    const variant = await ProductVariant.create({ publicId: id('var'), productId: product._id, storeId: store._id, sku: id('sku').toUpperCase(), title: 'Standard', priceMinor: 5000, costMinor: 1200, currency: 'UGX' });
    const variantId = variant._id, stock = await StockItem.create({ publicId: id('stk'), warehouseId: warehouse._id, storeId: store._id, variantId, onHand: 18 });
    const reservation = await InventoryReservation.create({ publicId: id('rsv'), idempotencyKey: id('reservation'), storeId: store._id, stockItemId: stock._id,
      variantId, quantity: 2, status: 'committed', committedAt: new Date(), expiresAt: new Date(Date.now() + 600_000), actorUserId: customer.user._id });
    const item = { linePublicId: id('line'), productId: product._id, variantId, storeId: store._id, reservationPublicId: reservation.publicId,
      productPublicId: product.publicId, variantPublicId: variant.publicId, storePublicId: store.publicId, title: product.title, variantTitle: variant.title, sku: variant.sku,
      quantity: 2, unitPriceMinor: 5000, unitCostMinor: 1200, costSnapshotStatus: 'captured', lineTotalMinor: 10000, currency: 'UGX' };
    const order = await Order.create({ publicId: id('ord'), idempotencyKey: id('order'), checkoutId: id('checkout'), cartPublicId: id('cart'), sessionKey: id('session'),
      userId: customer.user._id, country: 'UG', status: cod ? 'confirmed' : 'paid', paymentState: cod ? 'pending' : 'paid', paymentMethod: cod ? 'cod' : 'card', deliveryMethod: 'standard',
      contact: { fullName: customer.user.name, email: customer.user.email, phone: customer.user.phone, address: 'PRIVATE_BUYER_CUSTODY_ADDRESS', city: 'Kampala', country: 'UG' },
      totals: { subtotalMinor: 10000, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 10000, currency: 'UGX' }, items: [item], reservationExpiresAt: new Date(Date.now() + 600_000) });
    await SellerOrder.create({ publicId: id('sord'), orderId: order._id, orderPublicId: order.publicId, storeId: store._id, storePublicId: store.publicId, country: 'UG', status: 'confirmed',
      subtotalMinor: 10000, platformFeeMinor: 500, currency: 'UGX', items: [{ ...item, orderLineId: item.linePublicId, grossMinor: 10000, customerPaidMinor: 10000, platformFeeMinor: 500, sellerReceivableMinor: 9500 }] });
    if (cod) await PaymentIntent.create({ publicId: id('pay'), orderId: order._id, orderPublicId: order.publicId, country: 'UG', idempotencyKey: id('payment'), provider: 'cod', method: 'cod', status: 'pending_collection', amountMinor: 10000, currency: 'UGX' });
    const shipment = await ensureShipmentForOrder(order, store.ownerUserId), parcel = await Parcel.findOne({ shipmentId: shipment._id });
    return { order, stock, reservation, shipment, parcel, item };
  }
  async function handOver(f) {
    for (const type of ['pick', 'pack', 'dispatch']) {
      const task = await createWarehouseTask({ warehouseId: warehouse._id, storeId: store._id, orderId: f.order._id, shipmentId: f.shipment._id, parcelId: f.parcel._id,
        stockItemId: f.stock._id, variantId: f.stock.variantId, type, assignedUserId: warehouseActor.user._id, quantity: type === 'pick' ? 2 : 0 });
      await executeWarehouseTask({ task, actorUserId: warehouseActor.user._id });
    }
    assert.equal((await Parcel.findById(f.parcel._id)).status, 'handed_over');
  }
  async function assign(f, token, operatorToken) {
    let shipment = await shipmentRow(f); const profile = await profileRow();
    await post(warehouseActor, `/warehouse/deliveries/${shipment.publicId}/offer`, { version: shipment.__v, carrierPublicId: profile.publicId, earningMinor: 600, currency: 'UGX' }, operatorToken).expect(200);
    const old = await DeliveryOffer.findOne({ shipmentId: shipment._id, deliveryUserId: carrier.user._id });
    shipment = await shipmentRow(f);
    await post(warehouseActor, `/warehouse/deliveries/${shipment.publicId}/offer`, { version: shipment.__v, carrierPublicId: profile.publicId, earningMinor: 600, currency: 'UGX' }, operatorToken).expect(200);
    await post(carrier, `/delivery/offers/${old.publicId}/accept`, { version: old.__v }, token).expect(409);
    const offer = await DeliveryOffer.findById(old._id);
    await post(carrier, `/delivery/offers/${offer.publicId}/accept`, { version: offer.__v }, token).expect(200);
    return offer;
  }
  try {
    for (const Model of [User, CountrySetting, Device, PlatformGrant, DeliveryProfile, Store, Category, Product, ProductVariant, ReturnRequest, Warehouse, StockItem, InventoryReservation, Order, SellerOrder, Shipment, Parcel,
      SellerShipment, DeliveryOffer, DeliveryException, EvidenceDocument, WarehouseTask, InventoryDiscrepancy, PaymentIntent, LedgerAccount, LedgerTransaction, AuditLog, PayoutAccount, Payout, FinancialDocument]) await Model.init();
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true, growth: { loyaltyEnabled: false, referralEnabled: false } });
    customer = await actor('customer'); carrier = await actor('delivery'); otherCarrier = await actor('delivery'); warehouseActor = await actor('warehouse'); financeActor = await actor('finance'); supportActor = await actor('support');
    const seller = await actor('seller');
    store = await Store.create({ publicId: id('sto'), ownerUserId: seller.user._id, name: 'Recovery supplier', slug: id('supplier'), country: 'UG', currency: 'UGX', status: 'verified' });
    warehouse = await Warehouse.create({ publicId: id('wh'), storeId: store._id, ownerUserId: seller.user._id, name: 'Actual receiving warehouse', country: 'UG', city: 'Kampala', address: 'Physical warehouse address' });
    category = await Category.create({ publicId: id('cat'), name: 'Delivery custody supplies', slug: id('category'), countries: ['UG'], active: true });
    const token = await tokenFor(carrier), warehouseToken = await tokenFor(warehouseActor, '/warehouse/carriers'), financeToken = await tokenFor(financeActor, '/finance/payments');
    let identity;
    await t.test('all six canonical pages keep the Delivery shell; private verification, explicit availability and versions are real', async () => {
      for (const path of routes) {
        const page = await carrier.client.get(path).expect(200); assert.match(page.text, /data-role="delivery"/); assert.doesNotMatch(page.text, /data-role="customer"|data-page="seller-overview"/);
        assert.match(page.headers['cache-control'], /no-store/); assert.match(page.headers['x-robots-tag'], /noindex/);
        await json(customer.client.get(path)).expect(403);
      }
      await carrier.client.get('/dashboard/delivery-jobs?status=delivered').expect(308).expect('Location', '/delivery/jobs?status=delivered');
      await post(carrier, '/delivery/profile', { transport: 'bicycle', vehicleLabel: 'Recovery bicycle', serviceAreas: 'Kampala', version: 0, action: 'save' }, token).expect(200);
      let profile = await profileRow();
      await post(carrier, '/delivery/profile', { transport: 'bicycle', serviceAreas: 'Kampala', version: 0, action: 'submit' }, token).expect(409);
      await json(carrier.client.post('/delivery/profile/evidence')).field('version', String(profile.__v)).field('documentType', 'identity').attach('document', image, 'identity.jpg').expect(403);
      identity = await upload(carrier, '/delivery/profile/evidence', profile.__v, 'identity', token);
      assert.match(identity.storageKey, /\.cmv$/); const encrypted = (await readMediaObject(identity.storageKey)).body;
      const info = await sharp(decryptPrivateBuffer(encrypted, identity.storageKey)).metadata(); assert.equal(info.format, 'webp'); assert.equal(info.exif, undefined);
      await otherCarrier.client.get('/delivery/evidence/' + identity.publicId).expect(403);
      await customer.client.get('/delivery/evidence/' + identity.publicId).expect(403);
      await carrier.client.get('/delivery/evidence/' + identity.publicId).expect(200).expect('Content-Type', /image\/webp/);
      profile = await profileRow();
      await post(carrier, '/delivery/profile', { transport: 'bicycle', serviceAreas: 'Kampala', version: profile.__v, action: 'submit' }, token).expect(200);
      profile = await profileRow();
      await post(warehouseActor, `/warehouse/carriers/${profile.publicId}/review`, { version: profile.__v, decision: 'approve', codEnabled: 'true', reason: 'Independent carrier identity review completed.' }, warehouseToken).expect(200);
      profile = await profileRow(); assert.equal(profile.verificationStatus, 'approved'); assert.equal(profile.available, false);
      await post(carrier, '/delivery/availability', { version: profile.__v, available: 'true' }, token).expect(200);
      assert.equal((await profileRow()).available, true);
      await post(carrier, '/delivery/availability', { version: profile.__v, available: 'false' }, token).expect(409);
    });
    let f;
    await t.test('actual Warehouse handover, source-bound offer, OTP lockout counters and private photo precede a delivered order and real earnings', async () => {
      f = await fixture();
      const before = await json(carrier.client.get('/delivery/offers')).expect(200); assert.doesNotMatch(JSON.stringify(before.body), /PRIVATE_BUYER_CUSTODY_ADDRESS/);
      await Order.updateOne({ _id: f.order._id }, { $set: { cancellationState: 'requested' } });
      await post(warehouseActor, '/warehouse/deliveries/' + f.shipment.publicId + '/offer', { version: f.shipment.__v, carrierPublicId: (await profileRow()).publicId, earningMinor: 600, currency: 'UGX' }, warehouseToken).expect(409);
      assert.equal(await DeliveryOffer.countDocuments({ shipmentId: f.shipment._id }), 0);
      await Order.updateOne({ _id: f.order._id }, { $set: { cancellationState: 'none' } });
      const offer = await assign(f, token, warehouseToken);
      const otherToken = await tokenFor(otherCarrier), assigned = await shipmentRow(f);
      const unapproved = await post(otherCarrier, `/delivery/offers/${offer.publicId}/accept`, { version: offer.__v }, otherToken).expect(403);
      assert.equal(unapproved.body.error.code, 'DELIVERY_NOT_APPROVED');
      await post(otherCarrier, '/delivery/profile', { transport: 'bicycle', serviceAreas: 'Kampala', version: 0, action: 'save' }, otherToken).expect(200);
      let otherProfile = await profileRow(otherCarrier);
      await upload(otherCarrier, '/delivery/profile/evidence', otherProfile.__v, 'identity', otherToken);
      otherProfile = await profileRow(otherCarrier);
      await post(otherCarrier, '/delivery/profile', { transport: 'bicycle', serviceAreas: 'Kampala', version: otherProfile.__v, action: 'submit' }, otherToken).expect(200);
      otherProfile = await profileRow(otherCarrier);
      await post(warehouseActor, `/warehouse/carriers/${otherProfile.publicId}/review`, { version: otherProfile.__v, decision: 'approve', codEnabled: 'true', reason: 'Independent identity review of the second carrier.' }, warehouseToken).expect(200);
      otherProfile = await profileRow(otherCarrier);
      await post(otherCarrier, '/delivery/availability', { version: otherProfile.__v, available: 'true' }, otherToken).expect(200);
      const foreignOffer = await post(otherCarrier, `/delivery/offers/${offer.publicId}/accept`, { version: offer.__v }, otherToken).expect(404);
      assert.equal(foreignOffer.body.error.code, 'OFFER_NOT_FOUND');
      assert.equal(String((await shipmentRow(f)).deliveryUserId), String(carrier.user._id));
      assert.equal((await shipmentRow(f)).__v, assigned.__v);
      assert.equal(await DeliveryOffer.countDocuments({ shipmentId: assigned._id, deliveryUserId: otherCarrier.user._id }), 0);
      let row = await shipmentRow(f);
      const operatorView = await json(warehouseActor.client.get('/warehouse/deliveries?record=' + row.publicId)).expect(200);
      const pickupCode = operatorView.body.selected.code; assert.match(pickupCode, /^\d{6}$/);
      await post(carrier, `/delivery/jobs/${row.publicId}/picked_up`, { version: row.__v, proofCode: pickupCode }, token).expect(409);
      await handOver(f);
      row = await shipmentRow(f);
      const bad = pickupCode === '000000' ? '111111' : '000000';
      await post(carrier, `/delivery/jobs/${row.publicId}/picked_up`, { version: row.__v, proofCode: bad }, token).expect(422);
      row = await shipmentRow(f); assert.equal(row.pickupProofAttempts, 1); assert.equal(row.status, 'assigned');
      await post(carrier, `/delivery/jobs/${row.publicId}/picked_up`, { version: row.__v, proofCode: pickupCode }, token).expect(200);
      row = await shipmentRow(f); assert.equal(row.status, 'picked_up'); assert.equal(row.pickupProofAttempts, 0);
      await post(carrier, `/delivery/jobs/${row.publicId}/in_transit`, { version: row.__v }, token).expect(200);
      row = await shipmentRow(f);
      const tracking = await json(customer.client.get('/api/v1/orders/' + f.order.publicId)).expect(200), deliveryCode = tracking.body.order.shipment.deliveryCode;
      assert.match(deliveryCode, /^\d{6}$/);
      const own = await json(carrier.client.get('/delivery/jobs?record=' + row.publicId)).expect(200);
      assert.equal(own.body.selected.contact.address, 'PRIVATE_BUYER_CUSTODY_ADDRESS'); assert.doesNotMatch(JSON.stringify(own.body), new RegExp(deliveryCode));
      await post(carrier, `/delivery/jobs/${row.publicId}/delivered`, { version: row.__v, proofCode: deliveryCode }, token).expect(422);
      assert.equal((await Order.findById(f.order._id)).fulfillmentState === 'delivered', false);
      await upload(carrier, `/delivery/jobs/${row.publicId}/evidence`, row.__v, 'delivery_photo', token);
      row = await shipmentRow(f);
      await post(carrier, `/delivery/jobs/${row.publicId}/delivered`, { version: row.__v, proofCode: deliveryCode }, token).expect(200);
      row = await shipmentRow(f); assert.equal(row.status, 'delivered'); assert.equal(row.proof.reference, 'verified'); assert.ok(row.proofEvidenceDocumentIds.length);
      assert.equal((await Order.findById(f.order._id)).fulfillmentState, 'delivered'); assert.equal((await Order.findById(f.order._id)).items[0].deliveredQuantity, 2);
      assert.equal(await LedgerTransaction.countDocuments({ idempotencyKey: 'delivery-earning:' + row.publicId }), 1);
      const earnings = await json(carrier.client.get('/delivery/earnings')).expect(200); assert.equal(earnings.body.earnings.availableMinor, 600);
      await post(carrier, `/delivery/jobs/${row.publicId}/delivered`, { version: row.__v, proofCode: deliveryCode }, token).expect(409);
      assert.equal(await LedgerTransaction.countDocuments({ idempotencyKey: 'delivery-earning:' + row.publicId }), 1);
    });
    await t.test('COD mismatch requires corrected private receipt, independent Warehouse receipt and a separate Finance posting', async () => {
      let row = await shipmentRow(f);
      await post(financeActor, `/operations/logistics/shipments/${row.publicId}/reconcile-cod`, {}, financeToken).expect(409);
      await upload(carrier, `/delivery/jobs/${row.publicId}/cod-handover`, row.__v, '', token, { declaredAmountMinor: 9999 });
      row = await shipmentRow(f); assert.ok(row.cod.mismatchExceptionPublicId);
      await post(warehouseActor, `/warehouse/deliveries/${row.publicId}/review-cod`, { version: row.__v, reason: 'Actual physical cash receipt checked.' }, warehouseToken).expect(409);
      let exception = await DeliveryException.findOne({ publicId: row.cod.mismatchExceptionPublicId });
      await post(warehouseActor, `/warehouse/delivery-exceptions/${exception.publicId}/resolve`, { version: exception.__v, decision: 'dismiss', resolutionNote: 'Cannot bypass the missing cash.' }, warehouseToken).expect(409);
      await upload(carrier, `/delivery/jobs/${row.publicId}/cod-handover`, row.__v, '', token, { declaredAmountMinor: 10000 });
      exception = await DeliveryException.findById(exception._id);
      await post(warehouseActor, `/warehouse/delivery-exceptions/${exception.publicId}/resolve`, { version: exception.__v, decision: 'resolve', resolutionNote: 'Physical cash and replacement receipt now match.' }, warehouseToken).expect(200);
      row = await shipmentRow(f);
      await post(financeActor, `/operations/logistics/shipments/${row.publicId}/reconcile-cod`, {}, financeToken).expect(409);
      await post(warehouseActor, `/warehouse/deliveries/${row.publicId}/review-cod`, { version: row.__v, reason: 'Cash physically received and receipt independently reviewed.' }, warehouseToken).expect(200);
      await post(financeActor, `/operations/logistics/shipments/${row.publicId}/reconcile-cod`, {}, financeToken).expect(303);
      await post(financeActor, `/operations/logistics/shipments/${row.publicId}/reconcile-cod`, {}, financeToken).expect(303);
      const tx = await LedgerTransaction.findOne({ idempotencyKey: 'cod:' + row.publicId }); assert.ok(tx);
      assert.equal(tx.entries.reduce((sum, entry) => sum + entry.debitMinor - entry.creditMinor, 0), 0);
      assert.equal(await LedgerTransaction.countDocuments({ idempotencyKey: 'cod:' + row.publicId }), 1); assert.equal((await Order.findById(f.order._id)).paymentState, 'paid');
      assert.equal(await FinancialDocument.countDocuments({ orderId: f.order._id, type: 'cod_receipt' }), 1);
    });
    await t.test('a pickup return uses buyer collection and Warehouse receiving codes before actual inspection stock intake', async () => {
      const customerRequest = await context(customer), supportRequest = await context(supportActor);
      const decoyWarehouse = await Warehouse.create({ publicId: id('wh'), storeId: store._id, ownerUserId: store.ownerUserId, name: 'Older unrelated receiving warehouse', country: 'UG', city: 'Kampala', address: 'Another receiving location' });
      const decoyStock = await StockItem.create({ publicId: id('stk'), warehouseId: decoyWarehouse._id, storeId: store._id, variantId: f.stock.variantId, onHand: 41 });
      await Warehouse.collection.updateOne({ _id: decoyWarehouse._id }, { $set: { createdAt: new Date('2020-01-01T00:00:00Z') } });
      await StockItem.collection.updateOne({ _id: decoyStock._id }, { $set: { createdAt: new Date('2020-01-01T00:00:00Z') } });
      const created = await createReturnRequest(customerRequest, { orderId: f.order.publicId, reason: 'changed_mind', details: 'One unopened unit is being physically returned.', resolution: 'refund', returnMethod: 'pickup', items: [{ orderLineId: f.item.linePublicId, quantity: 1 }] });
      let returned = created.returnRequest;
      await decideReturn(supportRequest, returned.publicId, { version: returned.__v, decision: 'approve', note: 'The delivered item is eligible for physical pickup return.' });
      returned = await ReturnRequest.findById(returned._id);
      const pickup = { shipment: await Shipment.findOne({ publicId: returned.returnShipmentPublicId }) };
      await assert.rejects(markReturnReceived(supportRequest, returned.publicId, { version: returned.__v }), { code: 'RETURN_SHIPMENT_NOT_DELIVERED' });
      await assign(pickup, token, warehouseToken);
      let row = await shipmentRow(pickup);
      const pickupCodePath = '/api/v1/customer/returns/' + returned.publicId + '/pickup-code';
      await json(customer.client.get('/api/v1/returns/' + returned.publicId + '/pickup-code')).expect(307).expect('Location', pickupCodePath);
      const buyer = await json(customer.client.get(pickupCodePath)).expect(200);
      assert.equal(buyer.body.shipmentPublicId, row.publicId);
      assert.match(buyer.headers['cache-control'], /private.*no-store/);
      assert.ok(!Object.hasOwn(buyer.body, 'deliveryCode'));
      const receiver = await json(warehouseActor.client.get('/warehouse/deliveries?record=' + row.publicId)).expect(200);
      assert.match(buyer.body.pickupCode, /^\d{6}$/); assert.match(receiver.body.selected.code, /^\d{6}$/);
      const own = await json(carrier.client.get('/delivery/jobs?record=' + row.publicId)).expect(200);
      assert.doesNotMatch(JSON.stringify(own.body), new RegExp(buyer.body.pickupCode + '|' + receiver.body.selected.code));
      await post(carrier, '/delivery/jobs/' + row.publicId + '/failed', { version: row.__v, reasonCode: 'recipient_unavailable', reason: 'The buyer was not ready to hand over the returned unit.' }, token).expect(200);
      row = await shipmentRow(pickup); await upload(carrier, '/delivery/jobs/' + row.publicId + '/evidence', row.__v, 'failed_attempt', token);
      row = await shipmentRow(pickup); await post(carrier, '/delivery/jobs/' + row.publicId + '/rescheduled', { version: row.__v, rescheduledFor: new Date(Date.now() + 60000).toISOString() }, token).expect(200);
      row = await shipmentRow(pickup); await post(carrier, '/delivery/jobs/' + row.publicId + '/in_transit', { version: row.__v }, token).expect(409);
      await post(carrier, '/delivery/jobs/' + row.publicId + '/picked_up', { version: row.__v, proofCode: buyer.body.pickupCode }, token).expect(200);
      row = await shipmentRow(pickup); await post(carrier, '/delivery/jobs/' + row.publicId + '/in_transit', { version: row.__v }, token).expect(200);
      row = await shipmentRow(pickup); await upload(carrier, '/delivery/jobs/' + row.publicId + '/evidence', row.__v, 'delivery_photo', token);
      row = await shipmentRow(pickup); await post(carrier, '/delivery/jobs/' + row.publicId + '/delivered', { version: row.__v, proofCode: receiver.body.selected.code }, token).expect(200);
      const stockBefore = (await StockItem.findById(f.stock._id)).onHand;
      returned = await ReturnRequest.findById(returned._id); assert.equal(returned.status, 'awaiting_return');
      await markReturnReceived(supportRequest, returned.publicId, { version: returned.__v, note: 'The returned unit physically reached its receiving warehouse.' });
      returned = await ReturnRequest.findById(returned._id); assert.equal(returned.status, 'received');
      assert.equal((await StockItem.findById(f.stock._id)).onHand, stockBefore, 'Carrier delivery does not invent restocked inventory.');
      const task = await claimWarehouseTask({ taskPublicId: returned.items[0].warehouseTaskPublicId, actorUserId: warehouseActor.user._id });
      assert.equal(String(task.stockItemId), String(f.stock._id)); assert.equal(String(task.warehouseId), String(warehouse._id));
      await executeWarehouseTask({ task, actorUserId: warehouseActor.user._id, disposition: 'good' });
      assert.equal((await StockItem.findById(f.stock._id)).onHand, stockBefore + 1);
      assert.equal((await StockItem.findById(decoyStock._id)).onHand, 41);
      assert.equal((await ReturnRequest.findById(returned._id)).items[0].warehouseInspectionStatus, 'completed');
    });
    await t.test('returning an undelivered parcel requires a new Warehouse receiving code and current private handover photo', async () => {
      const outbound = await fixture({ cod: false }); await assign(outbound, token, warehouseToken); await handOver(outbound);
      let row = await shipmentRow(outbound);
      const collection = await json(warehouseActor.client.get('/warehouse/deliveries?record=' + row.publicId)).expect(200);
      await post(carrier, '/delivery/jobs/' + row.publicId + '/picked_up', { version: row.__v, proofCode: collection.body.selected.code }, token).expect(200);
      row = await shipmentRow(outbound); await post(carrier, '/delivery/jobs/' + row.publicId + '/in_transit', { version: row.__v }, token).expect(200);
      row = await shipmentRow(outbound); await post(carrier, '/delivery/jobs/' + row.publicId + '/return_to_sender', { version: row.__v, reason: 'The buyer requested physical return to sender.' }, token).expect(200);
      row = await shipmentRow(outbound);
      const receiver = await json(warehouseActor.client.get('/warehouse/deliveries?record=' + row.publicId)).expect(200);
      assert.match(receiver.body.selected.code, /^\d{6}$/);
      const buyer = await json(customer.client.get('/api/v1/orders/' + outbound.order.publicId)).expect(200);
      assert.equal(buyer.body.order.shipment.deliveryCode || '', '');
      await post(carrier, '/delivery/jobs/' + row.publicId + '/returned', { version: row.__v, proofCode: receiver.body.selected.code, reason: 'Goods physically received.' }, token).expect(422);
      await upload(carrier, '/delivery/jobs/' + row.publicId + '/evidence', row.__v, 'delivery_photo', token);
      row = await shipmentRow(outbound); await post(carrier, '/delivery/jobs/' + row.publicId + '/returned', { version: row.__v, proofCode: receiver.body.selected.code, reason: 'Goods physically received at the warehouse.' }, token).expect(200);
      row = await shipmentRow(outbound); assert.equal(row.status, 'returned'); assert.equal(row.proof.reference, 'verified');
      assert.equal((await Order.findById(outbound.order._id)).items[0].deliveredQuantity, 0);
      assert.equal(await LedgerTransaction.countDocuments({ idempotencyKey: 'delivery-earning:' + row.publicId }), 0);
    });
    await t.test('only independently verified payout destinations reserve actual available Delivery earnings', async () => {
      const carrierRequest = await context(carrier), financeRequest = await context(financeActor);
      const saved = await savePayoutAccount(carrierRequest, { method: 'mobile_money', label: 'Verified test destination', destination: { beneficiary_name: carrier.user.name, network: 'MTN', phone: carrier.user.phone } });
      await assert.rejects(requestPayout(carrierRequest, { payoutAccountId: saved.publicId, amountMinor: 100, idempotencyKey: id('payout') }), { code: 'PAYOUT_ACCOUNT_REQUIRED' });
      let destination = await PayoutAccount.findOne({ publicId: saved.publicId });
      await reviewPayoutAccount(financeRequest, destination.publicId, { version: destination.__v, decision: 'verify', reason: 'Independent verification of the destination details.' });
      const ledger = await LedgerAccount.findOne({ ownerType: 'delivery', ownerPublicId: String(carrier.user._id), country: 'UG', currency: 'UGX', code: 'delivery_payable' });
      const before = await accountBalanceMinor(ledger._id), operationKey = id('payout');
      await assert.rejects(requestPayout(carrierRequest, { payoutAccountId: saved.publicId, amountMinor: before + 1, idempotencyKey: id('too_large') }), { code: 'PAYOUT_BALANCE' });
      const payout = await requestPayout(carrierRequest, { payoutAccountId: saved.publicId, amountMinor: 100, idempotencyKey: operationKey });
      assert.equal(await accountBalanceMinor(ledger._id), before - 100);
      const replay = await requestPayout(carrierRequest, { payoutAccountId: saved.publicId, amountMinor: 100, idempotencyKey: operationKey }); assert.equal(replay.publicId, payout.publicId);
      assert.equal(await LedgerTransaction.countDocuments({ idempotencyKey: 'payout-hold:' + payout.publicId }), 1);
      await rejectPayout(financeRequest, payout.publicId, { version: payout.__v, reason: 'Test reservation is released without claiming an external transfer.' });
      assert.equal(await accountBalanceMinor(ledger._id), before); assert.equal((await Payout.findById(payout._id)).status, 'rejected');
    });
    await t.test('current Device revocation, token replacement, market changes and scoped Warehouse grants cannot be replayed', async () => {
      const service = await context(carrier); await deliveryAccess(service, { approved: true });
      await Device.updateOne({ _id: service.device._id }, { $set: { revokedAt: new Date() } });
      await assert.rejects(deliveryAccess(service, { approved: true }), { code: 'ACCOUNT_UNAVAILABLE' });
      const fresh = await context(carrier); await User.updateOne({ _id: carrier.user._id }, { $inc: { 'security.tokenVersion': 1 } });
      await assert.rejects(deliveryAccess(fresh, { approved: true }), { code: 'ACCOUNT_UNAVAILABLE' });
      // Restore only this isolated fixture identity for the following browser check.
      await User.updateOne({ _id: carrier.user._id }, { $set: { 'security.tokenVersion': carrier.user.security.tokenVersion } });
      const direct = await context(warehouseActor);
      const grant = await PlatformGrant.create({ publicId: id('pgr'), userId: warehouseActor.user._id, role: 'warehouse', operationalCountries: ['UG'], warehouseScopes: [warehouse.publicId],
        startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 3_600_000), status: 'active', reason: 'Scoped isolated verification grant', approvalPublicId: id('apr'), approvedByUserId: financeActor.user._id });
      await User.updateOne({ _id: warehouseActor.user._id }, { $set: { platformAccessManagedAt: new Date() } });
      direct.user = await User.findById(warehouseActor.user._id);
      const prepared = await prepareWarehouseMeasuredExport(direct), rows = warehouseMeasuredExportRows(direct, prepared);
      await PlatformGrant.updateOne({ _id: grant._id }, { $set: { status: 'revoked', revokedAt: new Date() } });
      await assert.rejects(rows.next(), /authorization|access|permission|grant/i);
      await PlatformGrant.updateOne({ _id: grant._id }, { $set: { status: 'active' }, $unset: { revokedAt: '' } });
    });
    await t.test('measured reports show actual timestamps and full keyset CSV without fabricated duration or accuracy', async () => {
      const contextRequest = await context(warehouseActor), completedAt = new Date(Date.now() - 3_600_000), claimedAt = new Date(completedAt.getTime() - 600_000);
      const rows = [];
      for (let index = 0; index < 57; index++) rows.push({ publicId: id('wtk'), warehouseId: warehouse._id, storeId: store._id, type: 'receive', status: 'completed', assignedUserId: warehouseActor.user._id,
        claimedAt, completedAt, dueAt: new Date(completedAt.getTime() + (index % 2 ? -60_000 : 60_000)) });
      await WarehouseTask.create(rows);
      const report = await loadWarehouseMeasuredReport(contextRequest); assert.ok(report.summary.completedTasks >= 60); assert.ok(report.summary.durationSamples >= 57); assert.ok(report.summary.averageTaskMinutes > 0);
      assert.equal(report.rows.length, 25); assert.equal(report.page.hasMore, true);
      const prepared = await prepareWarehouseMeasuredExport(contextRequest), seen = new Set();
      for await (const row of warehouseMeasuredExportRows(contextRequest, prepared)) { assert.ok(!seen.has(row.publicId)); seen.add(row.publicId); }
      assert.equal(seen.size, await WarehouseTask.countDocuments({ warehouseId: warehouse._id, status: 'completed', completedAt: { $type: 'date' } }));
      const csv = await warehouseActor.client.get('/warehouse/reports/measured.csv').expect(200); assert.match(csv.headers['cache-control'], /no-store/); assert.equal(csv.text.split('\r\n').filter(Boolean).length, seen.size + 1);
      await warehouseActor.client.get('/warehouse/reports?measure=counts&from=2026-02-30').expect(422);
      const independent = await Warehouse.create({ publicId: id('wh'), storeId: store._id, ownerUserId: store.ownerUserId, name: 'Another stock location', country: 'UG', city: 'Kampala', address: 'Separate warehouse' });
      await StockItem.create({ publicId: id('stk'), warehouseId: independent._id, storeId: store._id, variantId: f.stock.variantId, onHand: 30 });
      const physical = await shipmentSource(await shipmentRow(f)); assert.equal(String(physical.warehouses[0]._id), String(warehouse._id));
    });
    await t.test('dedicated Delivery pages render in Chromium at desktop and phone widths', { skip: !process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }, async () => {
      server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = 'http://127.0.0.1:' + server.address().port;
      browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, headless: true });
      const context = await browser.newContext(), page = await context.newPage();
      await page.goto(base + '/login'); await page.locator('input[name="email"]').fill(carrier.user.email); await page.locator('input[name="password"]').fill(password);
      await Promise.all([page.waitForURL(/\/mfa/), page.locator('button[type="submit"]').click()]);
      await page.locator('input[name="code"]').fill(carrier.codes[1]); await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/mfa')), page.locator('button[type="submit"]').click()]);
      const failures = []; page.on('pageerror', error => failures.push(error.message));
      for (const width of [1366, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const path of routes) {
          const response = await page.goto(base + path, { waitUntil: 'networkidle' }); assert.equal(response.status(), 200, path);
          await page.locator('.delivery-live-page[data-role="delivery"]').waitFor(); assert.equal(await page.locator('[data-role="customer"]').count(), 0);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, path + ' ' + width);
        }
      }
      assert.deepEqual(failures, []); await context.close();
    });
  } finally {
    if (browser) await browser.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const transport of transports) transport.destroy();
    for (const key of storageKeys) await deleteMediaObject(key).catch(() => {});
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
  }
});

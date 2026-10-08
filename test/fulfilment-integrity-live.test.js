import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const suffix = crypto.randomBytes(8).toString('hex');

test('fulfilment commits rejected proof attempts, authenticates carrier claims and cancels all aggregates atomically', { skip: !uri }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  await mongoose.connect(uri, { dbName: `classicmart_fulfilment_integrity_test_${suffix}` });
  const models = await import('../src/models/index.js');
  const { User, DeliveryProfile, Store, Warehouse, StockItem, InventoryReservation, InventoryMovement, Order, SellerOrder, Shipment, Parcel, SellerShipment, DeliveryOffer, CountrySetting, WarehouseTask, PlatformGrant } = models;
  const { hashPassword } = await import('../src/core/crypto.js');
  const { ensureShipmentForOrder, transitionShipment, offerShipment, acceptDeliveryOffer, createWarehouseTask, executeWarehouseTask } = await import('../src/services/logistics.js');
  const { cancelOrder } = await import('../src/services/checkout.js');
  const { decryptSensitive } = await import('../src/core/sensitive.js');
  const passwordHash = await hashPassword(`Fulfilment-${suffix}A1!`);
  let sequence = 0;
  const id = prefix => `${prefix}_fi_${suffix}_${sequence++}`;
  const objectId = () => new mongoose.Types.ObjectId();
  async function user(role, country = 'UG') {
    const publicId = id('usr'), email = `${publicId}@example.com`;
    const phone = '+2567' + crypto.randomInt(10000000, 99999999);
    return User.create({ publicId, name: 'Fulfilment Test Account', email, emailNormalized: email, phone, phoneNormalized: phone, passwordHash, role, country, currency: 'UGX', emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), consents: { terms: true, privacy: true, recordedAt: new Date() } });
  }
  try {
    await Promise.all([User.init(), Store.init(), Warehouse.init(), Shipment.init(), Parcel.init(), SellerOrder.init(), SellerShipment.init(), DeliveryOffer.init(), WarehouseTask.init(), StockItem.init(), InventoryReservation.init(), PlatformGrant.init()]);
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true, delivery: { requirePhotoForCod: false } });
    const owner = await user('seller'), buyer = await user('customer'), operator = await user('warehouse'), driver = await user('delivery'), otherDriver = await user('delivery');
    const profile = await DeliveryProfile.create({ publicId: id('dlp'), userId: driver._id, country: 'UG', transport: 'motorcycle', verificationStatus: 'approved', available: true, codEnabled: true });
    await DeliveryProfile.create({ publicId: id('dlp'), userId: otherDriver._id, country: 'UG', transport: 'motorcycle', verificationStatus: 'approved', available: true, codEnabled: true });
    const store = await Store.create({ publicId: id('str'), ownerUserId: owner._id, name: 'Integrity Store', slug: id('integrity'), country: 'UG', currency: 'UGX', status: 'verified' });
    const warehouse = await Warehouse.create({ publicId: id('wh'), storeId: store._id, ownerUserId: owner._id, name: 'Integrity Warehouse', country: 'UG', city: 'Kampala', address: 'Integrity warehouse address' });
    async function fixture({ country = 'UG', currency = 'UGX', fixtureStore = store, fixtureWarehouse = warehouse } = {}) {
      const variantId = objectId(), productId = objectId(), publicId = id('ord'), reservationPublicId = id('res');
      const stock = await StockItem.create({ publicId: id('stk'), storeId: fixtureStore._id, warehouseId: fixtureWarehouse._id, variantId, onHand: 8 });
      const reservation = await InventoryReservation.create({ publicId: reservationPublicId, idempotencyKey: id('reservation'), storeId: fixtureStore._id, stockItemId: stock._id, variantId, quantity: 2, status: 'committed', committedAt: new Date(), expiresAt: new Date(Date.now() + 60000), actorUserId: buyer._id });
      const item = { linePublicId: id('line'), productId, variantId, storeId: fixtureStore._id, reservationPublicId, productPublicId: id('prd'), variantPublicId: id('var'), storePublicId: fixtureStore.publicId, title: 'Integrity Parcel Item', variantTitle: 'Standard', sku: id('sku'), quantity: 2, unitPriceMinor: 1000, lineTotalMinor: 2000, currency };
      const order = await Order.create({ publicId, idempotencyKey: id('checkout'), checkoutId: id('checkout'), cartPublicId: id('cart'), sessionKey: id('session'), userId: buyer._id, country, status: 'confirmed', paymentState: 'pending', paymentMethod: 'cod', deliveryMethod: 'standard', contact: { fullName: buyer.name, email: buyer.email, phone: buyer.phone, address: 'Test delivery address', city: fixtureWarehouse.city, country }, totals: { subtotalMinor: 2000, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 2000, currency }, items: [item], reservationExpiresAt: new Date(Date.now() + 60000) });
      const sellerOrder = await SellerOrder.create({ publicId: id('so'), orderId: order._id, orderPublicId: publicId, storeId: fixtureStore._id, storePublicId: fixtureStore.publicId, country, status: 'confirmed', subtotalMinor: 2000, currency, items: [{ ...item, orderLineId: item.linePublicId }] });
      const shipment = await ensureShipmentForOrder(order, owner._id);
      const parcel = await Parcel.findOne({ shipmentId: shipment._id });
      const sellerShipment = await SellerShipment.findOne({ rootShipmentId: shipment._id });
      return { order, stock, reservation, sellerOrder, shipment, parcel, sellerShipment };
    }
    async function taskFor(fixture, type, overrides = {}, session = null) {
      return createWarehouseTask({ warehouseId: warehouse._id, storeId: store._id, orderId: fixture.order._id, shipmentId: fixture.shipment._id, parcelId: fixture.parcel._id, stockItemId: fixture.stock._id, type, assignedUserId: operator._id, quantity: type === 'pick' ? 2 : 0, ...overrides }, session);
    }
    async function handOver(fixture) {
      for (const type of ['pick', 'pack', 'dispatch']) await executeWarehouseTask({ task: await taskFor(fixture, type), actorUserId: operator._id });
    }
    async function assign(fixture) {
      const offer = await offerShipment({ shipment: fixture.shipment, deliveryUserId: driver._id, earningMinor: 100, currency: 'UGX', actorUserId: operator._id });
      const shipment = await acceptDeliveryOffer({ offer, actorUserId: driver._id });
      return { offer, shipment };
    }
    const buyerRequest = { user: buyer, session: {}, log: { error() {} } };

    await t.test('carrier offers honor authoritative multiple-country and warehouse grants and serialize revocation', async () => {
      const staff = await user('warehouse', 'UG');
      await User.updateOne({ _id: staff._id }, { $set: { platformAccessManagedAt: new Date(), role: 'customer', operationalCountries: ['UG'] } });
      async function countryFixture(country, currency) {
        await CountrySetting.create({ code: country, name: country, currency, locale: 'en', timeZone: 'Africa/Nairobi', phonePrefix: country === 'KE' ? '+254' : '+255', active: true });
        const seller = await user('seller', country), carrier = await user('delivery', country);
        const fixtureStore = await Store.create({ publicId: id('str'), ownerUserId: seller._id, name: country + ' Integrity Store', slug: id('country-store'), country, currency, status: 'verified' });
        const fixtureWarehouse = await Warehouse.create({ publicId: id('wh'), storeId: fixtureStore._id, ownerUserId: seller._id, name: country + ' Integrity Warehouse', country, city: 'Test City', address: 'Country-scoped warehouse address' });
        await DeliveryProfile.create({ publicId: id('dlp'), userId: carrier._id, country, transport: 'motorcycle', verificationStatus: 'approved', available: true, codEnabled: true });
        return { ...await fixture({ country, currency, fixtureStore, fixtureWarehouse }), carrier, warehouse: fixtureWarehouse };
      }
      const kenya = await countryFixture('KE', 'KES'), tanzania = await countryFixture('TZ', 'TZS');
      const grant = await PlatformGrant.create({ publicId: id('pgr'), userId: staff._id, role: 'warehouse', operationalCountries: ['UG', 'KE'], warehouseScopes: [warehouse.publicId, kenya.warehouse.publicId], startsAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 60000), status: 'active', reason: 'Integration fixture approved two-country logistics access', approvalPublicId: id('approval'), approvedByUserId: operator._id });
      const offerArgs = f => ({ shipment: f.shipment, deliveryUserId: f.carrier._id, earningMinor: 100, currency: f.order.totals.currency, actorUserId: staff._id });
      const acceptedScope = await offerShipment(offerArgs(kenya));
      assert.equal(acceptedScope.country, 'KE');
      assert.equal((await User.findById(staff._id)).country, 'UG');
      assert.equal((await User.findById(staff._id)).role, 'customer', 'active grant must authorize independently of compatibility role');
      await assert.rejects(offerShipment(offerArgs(tanzania)), { code: 'SHIPMENT_NOT_FOUND' });
      assert.equal(await DeliveryOffer.countDocuments({ shipmentId: tanzania.shipment._id }), 0);
      await PlatformGrant.updateOne({ _id: grant._id }, { $set: { warehouseScopes: [warehouse.publicId] } });
      await assert.rejects(offerShipment(offerArgs(kenya)), { code: 'WAREHOUSE_SCOPE' });
      await PlatformGrant.updateOne({ _id: grant._id }, { $set: { warehouseScopes: [warehouse.publicId, kenya.warehouse.publicId] } });
      const findOne = Shipment.findOne;
      let revoked = false;
      t.mock.method(Shipment, 'findOne', function (...args) {
        const query = findOne.apply(this, args), exec = query.exec;
        query.exec = async function (...execArgs) {
          const document = await exec.apply(this, execArgs);
          if (!revoked && String(args[0]?._id) === String(kenya.shipment._id) && this.getOptions().session) {
            revoked = true;
            // Revoke after the transaction read its grant. The grant write
            // fence must conflict and retry instead of creating another offer.
            await PlatformGrant.updateOne({ _id: grant._id }, { $set: { status: 'revoked', revokedAt: new Date() } });
          }
          return document;
        };
        return query;
      });
      const before = await DeliveryOffer.findById(acceptedScope._id);
      try { await assert.rejects(offerShipment({ ...offerArgs(kenya), earningMinor: 200 }), { code: 'DELIVERY_OFFER_FORBIDDEN' }); } finally { t.mock.restoreAll(); }
      assert.equal(revoked, true);
      assert.equal((await DeliveryOffer.findById(acceptedScope._id)).earningMinor, before.earningMinor);
      await User.updateOne({ _id: staff._id }, { $set: { role: 'super_admin', operationalCountries: ['UG', 'KE', 'TZ'] } });
      await assert.rejects(offerShipment(offerArgs(kenya)), { code: 'DELIVERY_OFFER_FORBIDDEN' });
    });

    await t.test('warehouse tasks join caller transactions and retain legacy owned-session inventory behavior', async () => {
      const f = await fixture(), session = await mongoose.startSession();
      try {
        await assert.rejects(session.withTransaction(async () => {
          const task = await taskFor(f, 'pick', {}, session);
          await executeWarehouseTask({ task, actorUserId: operator._id, session });
          assert.equal(session.inTransaction(), true);
          assert.equal((await Parcel.findById(f.parcel._id).session(session)).status, 'picked');
          throw new Error('Mandatory downstream audit rejected');
        }), /Mandatory downstream audit rejected/);
        assert.equal(await WarehouseTask.countDocuments({ parcelId: f.parcel._id }), 0);
        assert.equal((await Parcel.findById(f.parcel._id)).status, 'created');
        assert.equal((await SellerShipment.findById(f.sellerShipment._id)).status, 'created');
        assert.equal(session.hasEnded, false);
      } finally { await session.endSession(); }
      const received = await executeWarehouseTask({ task: await taskFor(f, 'receive', { quantity: 3 }), actorUserId: operator._id });
      assert.equal(received.status, 'completed');
      assert.equal((await StockItem.findById(f.stock._id)).onHand, 11);
      const putAway = await executeWarehouseTask({ task: await taskFor(f, 'put_away', { binCode: 'A-10' }), actorUserId: operator._id });
      assert.equal(putAway.result.binCode, 'A-10');
      assert.equal((await StockItem.findById(f.stock._id)).binCode, 'A-10');
      assert.equal(await InventoryMovement.countDocuments({ stockItemId: f.stock._id }), 2);
      await assert.rejects(executeWarehouseTask({ task: received, actorUserId: operator._id }), { code: 'WAREHOUSE_TASK_NOT_OWNED' });
      const badTask = await taskFor(f, 'pick', { shipmentId: objectId() });
      await assert.rejects(executeWarehouseTask({ task: badTask, actorUserId: operator._id }), { code: 'WAREHOUSE_PARCEL_SCOPE' });
      assert.equal((await Parcel.findById(f.parcel._id)).status, 'created');
      const validTask = await taskFor(f, 'pick');
      await User.updateOne({ _id: operator._id }, { $set: { status: 'suspended' } });
      await assert.rejects(executeWarehouseTask({ task: validTask, actorUserId: operator._id }), { code: 'WAREHOUSE_ACTOR_INVALID' });
      await User.updateOne({ _id: operator._id }, { $set: { status: 'active' } });
      await Order.updateOne({ _id: f.order._id }, { $set: { status: 'pending_payment', paymentState: 'unpaid' } });
      await assert.rejects(ensureShipmentForOrder(f.order, owner._id), { code: 'ORDER_NOT_READY' });
      await assert.rejects(executeWarehouseTask({ task: validTask, actorUserId: operator._id }), { code: 'ORDER_NOT_READY' });
      assert.equal((await Parcel.findById(f.parcel._id)).status, 'created');
    });

    await t.test('fresh offer ownership, expiry, approval and country are required to claim or transition', async () => {
      const f = await fixture();
      await handOver(f);
      const offer = await offerShipment({ shipment: f.shipment, deliveryUserId: driver._id, earningMinor: 100, currency: 'UGX', actorUserId: operator._id });
      await assert.rejects(acceptDeliveryOffer({ offer, actorUserId: otherDriver._id }), { code: 'OFFER_UNAVAILABLE' });
      await DeliveryOffer.updateOne({ _id: offer._id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
      await assert.rejects(acceptDeliveryOffer({ offer, actorUserId: driver._id }), { code: 'OFFER_UNAVAILABLE' });
      const refreshed = await offerShipment({ shipment: f.shipment, deliveryUserId: driver._id, earningMinor: 100, currency: 'UGX', actorUserId: operator._id });
      await DeliveryProfile.updateOne({ _id: profile._id }, { $set: { verificationStatus: 'suspended' } });
      await assert.rejects(acceptDeliveryOffer({ offer: refreshed, actorUserId: driver._id }), { code: 'DELIVERY_NOT_AVAILABLE' });
      await DeliveryProfile.updateOne({ _id: profile._id }, { $set: { verificationStatus: 'approved' } });
      const shipment = await acceptDeliveryOffer({ offer: refreshed, actorUserId: driver._id });
      const proof = await Shipment.findById(shipment._id).select('+pickupCodeEncrypted');
      const pickup = decryptSensitive(proof.pickupCodeEncrypted);
      await assert.rejects(transitionShipment({ shipment, actorUserId: otherDriver._id, nextStatus: 'picked_up', proofCode: pickup }), { code: 'SHIPMENT_NOT_FOUND' });
      assert.equal((await Shipment.findById(shipment._id)).pickupProofAttempts, 0);
      await User.updateOne({ _id: driver._id }, { $set: { status: 'suspended' } });
      await assert.rejects(transitionShipment({ shipment, actorUserId: driver._id, nextStatus: 'picked_up', proofCode: pickup }), { code: 'DELIVERY_ACTOR_INVALID' });
      await User.updateOne({ _id: driver._id }, { $set: { status: 'active', country: 'KE' } });
      await assert.rejects(transitionShipment({ shipment, actorUserId: driver._id, nextStatus: 'picked_up', proofCode: pickup }), { code: 'DELIVERY_NOT_APPROVED' });
      await User.updateOne({ _id: driver._id }, { $set: { country: 'UG' } });
      await DeliveryProfile.updateOne({ _id: profile._id }, { $set: { codEnabled: false } });
      await assert.rejects(transitionShipment({ shipment, actorUserId: driver._id, nextStatus: 'picked_up', proofCode: pickup }), { code: 'DELIVERY_COD_NOT_ALLOWED' });
      await DeliveryProfile.updateOne({ _id: profile._id }, { $set: { codEnabled: true } });
      await transitionShipment({ shipment, actorUserId: driver._id, nextStatus: 'picked_up', proofCode: pickup });
      assert.equal((await Shipment.findById(shipment._id)).status, 'picked_up');
    });

    await t.test('rejected proof attempts persist, lock out valid codes and serialize competing failures', async () => {
      const f = await fixture();
      await handOver(f);
      let { shipment } = await assign(f);
      const proof = await Shipment.findById(shipment._id).select('+pickupCodeEncrypted +deliveryCodeEncrypted');
      const pickup = decryptSensitive(proof.pickupCodeEncrypted), delivery = decryptSensitive(proof.deliveryCodeEncrypted);
      for (let i = 1; i <= 4; i++) {
        await assert.rejects(transitionShipment({ shipment, actorUserId: driver._id, nextStatus: 'picked_up', proofCode: 'incorrect-proof' }), { code: 'PROOF_INVALID' });
        const current = await Shipment.findById(shipment._id);
        assert.equal(current.pickupProofAttempts, i);
        assert.equal(current.status, 'assigned');
        assert.equal((await Parcel.findById(f.parcel._id)).status, 'handed_over');
      }
      await assert.rejects(transitionShipment({ shipment, actorUserId: driver._id, nextStatus: 'picked_up', proofCode: 'incorrect-proof' }), { code: 'PROOF_INVALID' });
      assert.ok((await Shipment.findById(shipment._id)).proofLockedUntil > new Date());
      await assert.rejects(transitionShipment({ shipment, actorUserId: driver._id, nextStatus: 'picked_up', proofCode: pickup }), { code: 'PROOF_LOCKED' });
      await Shipment.updateOne({ _id: shipment._id }, { $set: { proofLockedUntil: new Date(Date.now() - 1) } });
      shipment = await transitionShipment({ shipment, actorUserId: driver._id, nextStatus: 'picked_up', proofCode: pickup });
      assert.equal(shipment.pickupProofAttempts, 0);
      assert.equal(shipment.proofLockedUntil, null);
      shipment = await transitionShipment({ shipment, actorUserId: driver._id, nextStatus: 'in_transit' });
      await assert.rejects(transitionShipment({ shipment, actorUserId: driver._id, nextStatus: 'delivered', proofCode: 'incorrect-proof' }), { code: 'PROOF_INVALID' });
      assert.equal((await Shipment.findById(shipment._id)).deliveryProofAttempts, 1);
      await transitionShipment({ shipment, actorUserId: driver._id, nextStatus: 'delivered', proofCode: delivery });
      assert.equal((await Shipment.findById(shipment._id)).status, 'delivered');
      assert.equal((await Parcel.findById(f.parcel._id)).status, 'delivered');
      assert.equal((await SellerShipment.findById(f.sellerShipment._id)).status, 'delivered');
      assert.equal((await Order.findById(f.order._id)).fulfillmentState, 'delivered');
      assert.equal((await SellerOrder.findById(f.sellerOrder._id)).status, 'fulfilled');
      await assert.rejects(cancelOrder(buyerRequest, f.order.publicId), { code: 'ORDER_ALREADY_IN_TRANSIT' });
      assert.equal((await SellerShipment.findById(f.sellerShipment._id)).status, 'delivered');

      const competingFixture = await fixture();
      await handOver(competingFixture);
      const assigned = await assign(competingFixture);
      const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => transitionShipment({ shipment: assigned.shipment, actorUserId: driver._id, nextStatus: 'picked_up', proofCode: 'incorrect-proof' })));
      assert.equal(attempts.filter(row => row.status === 'rejected' && row.reason.code === 'PROOF_INVALID').length, 5);
      assert.equal(attempts.filter(row => row.status === 'rejected' && row.reason.code === 'PROOF_LOCKED').length, 1);
      const locked = await Shipment.findById(assigned.shipment._id);
      assert.ok(locked.proofLockedUntil > new Date());
      assert.equal(locked.status, 'assigned');
    });

    await t.test('buyer cancellation synchronizes shipment, parcel and seller shipment and restores stock once', async () => {
      const f = await fixture();
      await handOver(f);
      const { offer, shipment } = await assign(f);
      await cancelOrder(buyerRequest, f.order.publicId);
      await cancelOrder(buyerRequest, f.order.publicId);
      assert.equal((await Order.findById(f.order._id)).cancellationState, 'cancelled');
      assert.equal((await SellerOrder.findById(f.sellerOrder._id)).status, 'cancelled');
      assert.equal((await Shipment.findById(shipment._id)).status, 'cancelled');
      assert.equal((await Parcel.findById(f.parcel._id)).status, 'cancelled');
      const sellerShipment = await SellerShipment.findById(f.sellerShipment._id);
      assert.equal(sellerShipment.status, 'cancelled');
      assert.equal(sellerShipment.timeline.filter(entry => entry.type === 'order.cancelled').length, 1);
      assert.equal((await StockItem.findById(f.stock._id)).onHand, 10);
      assert.equal(await InventoryMovement.countDocuments({ stockItemId: f.stock._id, type: 'return' }), 1);
      await assert.rejects(acceptDeliveryOffer({ offer, actorUserId: driver._id }), { code: 'OFFER_UNAVAILABLE' });
      await assert.rejects(transitionShipment({ shipment, actorUserId: driver._id, nextStatus: 'picked_up', proofCode: 'incorrect-proof' }), { code: 'SHIPMENT_TRANSITION_INVALID' });
    });

    await t.test('cancellation retries classify the latest captured payment and roll back preliminary stock restoration', async () => {
      const f = await fixture();
      await Order.updateOne({ _id: f.order._id }, { $set: { paymentMethod: 'wallet', paymentState: 'pending', status: 'pending_payment' } });
      const findById = Order.findById;
      let injected = false;
      t.mock.method(Order, 'findById', function (...args) {
        const query = findById.apply(this, args), exec = query.exec;
        query.exec = async function (...execArgs) {
          const document = await exec.apply(this, execArgs);
          if (!injected && String(args[0]) === String(f.order._id) && this.getOptions().session) {
            injected = true;
            // A real write outside the cancellation transaction simulates the
            // payment commit and causes MongoDB to retry the stale snapshot.
            await Order.updateOne({ _id: f.order._id }, { $set: { paymentState: 'paid', status: 'paid' }, $inc: { __v: 1 } });
          }
          return document;
        };
        return query;
      });
      try { await cancelOrder(buyerRequest, f.order.publicId); } finally { t.mock.restoreAll(); }
      assert.equal(injected, true);
      const cancelled = await Order.findById(f.order._id);
      assert.equal(cancelled.cancellationState, 'processing');
      assert.equal(cancelled.refundState, 'pending');
      assert.ok(cancelled.timeline.some(entry => entry.type === 'cancellation.refund_required'));
      assert.equal((await SellerOrder.findById(f.sellerOrder._id)).status, 'cancellation_pending');
      assert.equal((await SellerShipment.findById(f.sellerShipment._id)).status, 'cancelled');
      assert.equal((await StockItem.findById(f.stock._id)).onHand, 10);
      assert.equal(await InventoryMovement.countDocuments({ stockItemId: f.stock._id, type: 'return' }), 1);
    });

    await t.test('free exchange replacements cancel without requesting a nonexistent provider refund', async () => {
      const f = await fixture();
      await Order.updateOne({ _id: f.order._id }, { $set: { paymentMethod: 'exchange', paymentState: 'paid', status: 'confirmed', 'totals.subtotalMinor': 0, 'totals.totalMinor': 0 } });
      await cancelOrder(buyerRequest, f.order.publicId);
      const cancelled = await Order.findById(f.order._id);
      assert.equal(cancelled.cancellationState, 'cancelled');
      assert.equal(cancelled.refundState, 'none');
      assert.ok(!cancelled.timeline.some(entry => entry.type.startsWith('cancellation.refund')));
      assert.equal((await SellerShipment.findById(f.sellerShipment._id)).status, 'cancelled');
      assert.equal((await StockItem.findById(f.stock._id)).onHand, 10);
    });
  } finally {
    t.mock.restoreAll();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

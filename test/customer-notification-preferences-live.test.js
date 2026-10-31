import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const close = server => server?.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();

test('saved Customer notification choices affect real queued email and push while required notices remain available', { skip: !uri, timeout: 180_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /test|verification/i);
  const suffix = crypto.randomBytes(7).toString('hex'), dbName = `classicmart_notification_preferences_test_${suffix}`;
  const pushes = [], sent = [];
  let web, gateway;
  try {
    gateway = createServer(async (incoming, response) => {
      let body = '';
      for await (const chunk of incoming) body += chunk;
      pushes.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"accepted":true}');
    });
    await listen(gateway);
    process.env.PUSH_GATEWAY_URL = `http://127.0.0.1:${gateway.address().port}`;
    process.env.PUSH_GATEWAY_SECRET = 'notification-preference-owned-local-provider-fixture';
    await mongoose.connect(uri, { dbName });
    const models = await import('../src/models/index.js');
    const { User, CountrySetting, Store, StoreMember, Category, Product, ProductVariant, Warehouse, StockItem, ProductAlert,
      CustomerCatalogueState, StoreBroadcast, Order, SellerOrder, Notification, OutboxEvent, PrivacyRequest, PushDevice } = models;
    const { createApp } = await import('../src/app.js');
    const { hashPassword } = await import('../src/core/crypto.js');
    const { queuePushNotification, processPushOutbox, registerPushDevice } = await import('../src/services/stage11.js');
    const { evaluateProductAlerts } = await import('../src/services/maintenance.js');
    const { createStoreBroadcast, queueStoreBroadcast } = await import('../src/services/seller-growth.js');
    const { processNotificationOutbox, addOutboxEvent } = await import('../src/services/outbox.js');
    const { customerNotificationEnabled } = await import('../src/services/customer-notification-policy.js');
    for (const Model of Object.values(mongoose.models)) await Model.init();
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256' });
    let sequence = 0;
    const id = prefix => `${prefix}_np_${suffix}_${++sequence}`;
    const password = `Preferences-${suffix}-A1!`, passwordHash = await hashPassword(password);
    async function identity(role = 'customer', { verifiedEmail = true } = {}) {
      const email = `${id('email')}@example.com`, phone = '+25670' + String(++sequence).padStart(7, '0');
      return User.create({ publicId: id('usr'), name: 'Notification fixture', email, emailNormalized: email, phone, phoneNormalized: phone,
        passwordHash, role, country: 'UG', currency: 'UGX', emailVerifiedAt: verifiedEmail ? new Date() : undefined, phoneVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
        consents: { terms: true, privacy: true, marketing: true, recordedAt: new Date() } });
    }
    const buyer = await identity(), seller = await identity('seller');
    web = createServer(createApp(null)); await listen(web);
    const client = request.agent(`http://127.0.0.1:${web.address().port}`);
    const login = await client.get('/login').expect(200);
    await client.post('/login').type('form').send({ email: buyer.email, password, _csrf: csrf(login.text) }).expect(302);
    async function preferences(enabled) {
      const shown = await client.get('/notifications').expect(200);
      await client.post('/notifications/preferences').type('form').send({ ...Object.fromEntries(enabled.map(name => [name, 'on'])), _csrf: csrf(shown.text) }).expect(302);
      return User.findById(buyer._id);
    }
    const deliver = () => processNotificationOutbox({ limit: 100, sendEmail: async message => { sent.push(message); return { messageId: id('local_message') }; } });
    const store = await Store.create({ publicId: id('str'), ownerUserId: seller._id, name: 'Preference Store', slug: id('store'), country: 'UG', currency: 'UGX', status: 'verified' });
    await StoreMember.create({ publicId: id('stm'), storeId: store._id, userId: seller._id, role: 'owner', status: 'active', invitedByUserId: seller._id, acceptedAt: new Date() });
    await CustomerCatalogueState.create({ userId: buyer._id, followedStoreIds: [store._id] });
    const sellerRequest = { user: seller, store, id: id('req'), get: () => '', ip: '127.0.0.1' };
    const broadcast = () => createStoreBroadcast(sellerRequest, { subject: 'Followed store news', body: 'A current opted-in store offer.' });

    await t.test('the real form saves four independent choices without changing marketing consent or another account', async () => {
      assert.equal(customerNotificationEnabled({}, 'orders'), true);
      assert.equal(customerNotificationEnabled({}, 'wishlist'), true);
      assert.equal(customerNotificationEnabled({}, 'offers'), false);
      assert.equal(customerNotificationEnabled({}, 'club'), true);
      await client.post('/notifications/preferences').type('form').send({ offers: 'on' }).expect(403);
      const saved = await preferences([]);
      assert.deepEqual(saved.preferences.notifications.toObject(), { orders: false, wishlist: false, offers: false, club: false });
      assert.equal(saved.consents.marketing, true);
      assert.equal((await User.findById(seller._id)).preferences.notifications.orders, true);
      const shown = await client.get('/notifications').expect(200);
      for (const name of ['orders', 'wishlist', 'offers', 'club']) assert.match(shown.text, new RegExp(`name="${name}"\\s*>`));
      assert.match(shown.text, /Essential account, security, receipts and support notices/);
    });

    await t.test('muted wishlist and Club push do not create outbox work; current wishlist alerts remain pending until enabled', async () => {
      const before = await OutboxEvent.countDocuments({ type: 'mobile.push' });
      for (const category of ['wishlist', 'offers', 'club']) assert.equal(await queuePushNotification({ userId: buyer._id, category, title: 'Muted category', body: category }), null);
      assert.equal(await OutboxEvent.countDocuments({ type: 'mobile.push' }), before);
      const category = await Category.create({ publicId: id('cat'), name: 'Alert Products', slug: id('category'), countries: ['UG'] });
      const product = await Product.create({ publicId: id('prd'), storeId: store._id, ownerUserId: seller._id, categoryId: category._id,
        title: 'Wishlist alert product', slug: id('product'), description: 'Actual saved product alert source.', countries: ['UG'], status: 'published' });
      const variant = await ProductVariant.create({ publicId: id('var'), storeId: store._id, productId: product._id, sku: id('sku'), title: 'Standard', priceMinor: 1000, currency: 'UGX' });
      const warehouse = await Warehouse.create({ publicId: id('wh'), storeId: store._id, ownerUserId: seller._id, name: 'Alert warehouse', country: 'UG', city: 'Kampala', address: 'Owned test warehouse' });
      await StockItem.create({ publicId: id('stk'), storeId: store._id, warehouseId: warehouse._id, variantId: variant._id, onHand: 2 });
      const alert = await ProductAlert.create({ publicId: id('alt'), userId: buyer._id, productId: product._id, productPublicId: product.publicId, country: 'UG', type: 'restock' });
      assert.equal((await evaluateProductAlerts()).triggered, 0);
      assert.equal((await ProductAlert.findById(alert._id)).status, 'active');
      await preferences(['wishlist', 'club']);
      await registerPushDevice(buyer, { platform: 'web', token: 'owned-notification-preferences-push-token', label: 'Owned test browser' });
      assert.equal((await evaluateProductAlerts()).triggered, 1);
      const queued = await OutboxEvent.findOne({ type: 'mobile.push', 'payload.notificationCategory': 'wishlist' }); assert.ok(queued);
      await preferences([]);
      await processPushOutbox(); assert.equal(pushes.length, 0);
      assert.equal((await OutboxEvent.findById(queued._id)).payload.deliveryStatus, 'cancelled');
      await preferences(['club']);
      await queuePushNotification({ userId: buyer._id, category: 'club', title: 'Club opt-in', body: 'Current Club update' });
      await processPushOutbox(); assert.equal(pushes.length, 1); assert.equal(pushes[0].title, 'Club opt-in');
      assert.equal(pushes[0].token, 'owned-notification-preferences-push-token');
      await preferences(['wishlist']);
      const second = await ProductAlert.create({ publicId: id('alt'), userId: buyer._id, productId: product._id, productPublicId: product.publicId,
        country: 'UG', type: 'price_drop', targetPriceMinor: 2000, lastKnownPriceMinor: 3000 });
      const originalCreate = OutboxEvent.create, beforeFailure = await OutboxEvent.countDocuments({ type: 'mobile.push' });
      OutboxEvent.create = function (documents, ...args) {
        if (documents.some?.(entry => entry.type === 'mobile.push')) throw new Error('Required product alert outbox unavailable');
        return originalCreate.call(this, documents, ...args);
      };
      try { await assert.rejects(evaluateProductAlerts(), /Required product alert outbox unavailable/); }
      finally { OutboxEvent.create = originalCreate; }
      assert.equal((await ProductAlert.findById(second._id)).status, 'active');
      assert.equal(await OutboxEvent.countDocuments({ type: 'mobile.push' }), beforeFailure);
      const originalUpdate = User.updateOne; let changed = false;
      User.updateOne = async function (filter, update, options) {
        if (!changed && options?.session && String(filter._id) === String(buyer._id) && update.$inc?.__v === 1) {
          changed = true;
          await originalUpdate.call(this, { _id: buyer._id }, { $set: { 'preferences.notifications.wishlist': false }, $inc: { __v: 1 } });
        }
        return originalUpdate.call(this, filter, update, options);
      };
      try { assert.equal((await evaluateProductAlerts()).triggered, 0); }
      finally { User.updateOne = originalUpdate; }
      assert.equal(changed, true); assert.equal((await ProductAlert.findById(second._id)).status, 'active');
      assert.equal(await OutboxEvent.countDocuments({ type: 'mobile.push' }), beforeFailure);
      await preferences(['wishlist']);
      const outcomes = await Promise.all([evaluateProductAlerts(), evaluateProductAlerts()]);
      assert.equal(outcomes.reduce((total, result) => total + result.triggered, 0), 1);
      assert.equal(await OutboxEvent.countDocuments({ type: 'mobile.push' }), beforeFailure + 1);
      assert.equal((await ProductAlert.findById(second._id)).status, 'triggered');
      await processPushOutbox(); assert.equal(pushes.length, 2);
      await preferences(['club']);
      const lateMuted = await queuePushNotification({ userId: buyer._id, category: 'club', title: 'Muted while devices load', body: 'Do not retry an intentional opt-out.' });
      const originalDevices = PushDevice.find;
      PushDevice.find = function (...args) {
        const query = originalDevices.apply(this, args), originalLean = query.lean;
        query.lean = async function (...leanArgs) {
          const rows = await originalLean.apply(this, leanArgs);
          await User.updateOne({ _id: buyer._id }, { $set: { 'preferences.notifications.club': false }, $inc: { __v: 1 } });
          return rows;
        };
        return query;
      };
      try {
        const result = await processPushOutbox(); assert.equal(result.processed, 1); assert.equal(result.failed, 0);
      } finally { PushDevice.find = originalDevices; }
      assert.equal(pushes.length, 2);
      const lateSaved = await OutboxEvent.findById(lateMuted._id); assert.equal(lateSaved.status, 'processed'); assert.equal(lateSaved.payload.deliveryStatus, 'cancelled');
    });

    await t.test('offers require both the saved preference and marketing consent at audience selection and actual email dispatch', async () => {
      await preferences([]);
      let row = await broadcast(); await queueStoreBroadcast(sellerRequest, row.publicId);
      assert.equal((await StoreBroadcast.findById(row._id)).recipientCount, 0);
      assert.equal((await StoreBroadcast.findById(row._id)).status, 'sent');
      assert.equal(await OutboxEvent.countDocuments({ aggregatePublicId: row.publicId }), 0);
      await preferences(['offers']); row = await broadcast(); await queueStoreBroadcast(sellerRequest, row.publicId);
      assert.equal((await StoreBroadcast.findById(row._id)).recipientCount, 1);
      await preferences([]); await deliver(); assert.equal(sent.length, 0);
      assert.equal((await OutboxEvent.findOne({ aggregatePublicId: row.publicId })).payload.deliveryStatus, 'cancelled');
      await preferences(['offers']); row = await broadcast(); await queueStoreBroadcast(sellerRequest, row.publicId); await deliver();
      assert.equal(sent.length, 1); assert.equal(sent[0].email, buyer.email); assert.equal(sent[0].subject, 'Followed store news');
      row = await broadcast(); await queueStoreBroadcast(sellerRequest, row.publicId);
      await User.updateOne({ _id: buyer._id }, { $set: { 'consents.marketing': false } });
      await deliver(); assert.equal(sent.length, 1);
      assert.equal((await OutboxEvent.findOne({ aggregatePublicId: row.publicId })).payload.deliveryStatus, 'cancelled');
      row = await broadcast(); await queueStoreBroadcast(sellerRequest, row.publicId);
      assert.equal((await StoreBroadcast.findById(row._id)).recipientCount, 0);
      await User.updateOne({ _id: buyer._id }, { $set: { 'consents.marketing': true } });
      const unverified = await identity('customer', { verifiedEmail: false });
      await User.updateOne({ _id: unverified._id }, { $set: { 'preferences.notifications.offers': true } });
      await CustomerCatalogueState.create({ userId: unverified._id, followedStoreIds: [store._id] });
      await preferences([]); row = await broadcast(); await queueStoreBroadcast(sellerRequest, row.publicId);
      assert.equal((await StoreBroadcast.findById(row._id)).recipientCount, 0);
      assert.equal(await OutboxEvent.countDocuments({ aggregatePublicId: row.publicId }), 0);
      assert.equal(await OutboxEvent.countDocuments({ 'payload.userPublicId': unverified.publicId }), 0);
      await preferences(['offers']); row = await broadcast(); await queueStoreBroadcast(sellerRequest, row.publicId);
      assert.equal((await StoreBroadcast.findById(row._id)).recipientCount, 1);
      await User.updateOne({ _id: buyer._id }, { $unset: { emailVerifiedAt: 1 } });
      try {
        await deliver(); assert.equal(sent.length, 1);
        assert.equal((await OutboxEvent.findOne({ aggregatePublicId: row.publicId })).payload.deliveryStatus, 'cancelled');
      } finally { await User.updateOne({ _id: buyer._id }, { $set: { emailVerifiedAt: new Date() } }); }
    });

    await t.test('queued order progress checks the current owned source, recipient and preference; required service records remain visible', async () => {
      const productId = new mongoose.Types.ObjectId(), variantId = new mongoose.Types.ObjectId();
      const order = await Order.create({ publicId: id('ord'), idempotencyKey: id('key'), checkoutId: id('chk'), cartPublicId: id('crt'), sessionKey: id('session'), userId: buyer._id,
        country: 'UG', status: 'paid', paymentState: 'paid', fulfillmentState: 'ready', deliveryMethod: 'standard', paymentMethod: 'card', reservationExpiresAt: new Date(Date.now() + 60_000),
        contact: { fullName: buyer.name, email: buyer.email, phone: buyer.phone, address: 'Owned order street', city: 'Kampala', country: 'UG' },
        totals: { subtotalMinor: 1000, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 1000, currency: 'UGX' },
        items: [{ linePublicId: id('line'), productId, variantId, storeId: store._id, reservationPublicId: id('rsv'), productPublicId: id('prd'), variantPublicId: id('var'), storePublicId: store.publicId,
          title: 'Purchased goods', variantTitle: 'Standard', sku: id('sku'), quantity: 1, unitPriceMinor: 1000, lineTotalMinor: 1000, currency: 'UGX' }] });
      const sellerOrder = await SellerOrder.create({ publicId: id('sord'), orderId: order._id, orderPublicId: order.publicId, storeId: store._id, storePublicId: store.publicId, country: 'UG', currency: 'UGX', status: 'ready', subtotalMinor: 1000, items: [] });
      const enqueue = (overrides = {}) => addOutboxEvent({ type: 'seller.order_notification', aggregateType: 'seller_order', aggregatePublicId: sellerOrder.publicId,
        payload: { notificationCategory: 'orders', userPublicId: buyer.publicId, orderPublicId: order.publicId, country: 'UG', subject: 'Routine order progress', body: 'Actual saved order progress.', email: 'stale-untrusted@example.com', ...overrides } });
      await preferences(['orders']); const muted = await enqueue();
      await preferences([]); const before = sent.length; await deliver(); assert.equal(sent.length, before);
      assert.equal((await OutboxEvent.findById(muted._id)).payload.deliveryStatus, 'cancelled');
      await preferences(['orders']);
      for (const bad of [{ userPublicId: seller.publicId }, { orderPublicId: id('other_order') }, { country: 'KE' }]) {
        const event = await enqueue(bad); await deliver(); assert.equal(sent.length, before);
        assert.equal((await OutboxEvent.findById(event._id)).payload.deliveryStatus, 'cancelled');
      }
      await enqueue(); await deliver(); assert.equal(sent.length, before + 1); assert.equal(sent.at(-1).email, buyer.email);
      const historical = () => addOutboxEvent({ type: 'seller.order_notification', aggregateType: 'seller_order', aggregatePublicId: sellerOrder.publicId,
        payload: { email: 'cached-stranger@example.com', subject: 'Your Classic Mart order is ready for carrier pickup', body: `A seller has completed preparation for order ${order.publicId}. Sign in to Classic Mart to view tracking.` } });
      await historical(); await deliver(); assert.equal(sent.length, before + 2); assert.equal(sent.at(-1).email, buyer.email);
      for (const [Model, source, patch, restore] of [
        [SellerOrder, sellerOrder, { status: 'fulfilled' }, { status: 'ready' }],
        [Order, order, { status: 'cancelled', cancellationState: 'cancelled' }, { status: 'paid', cancellationState: 'none' }],
        [Order, order, { fulfillmentState: 'delivered' }, { fulfillmentState: 'ready' }],
        [Order, order, { cancellationState: 'requested' }, { cancellationState: 'none' }],
      ]) {
        await Model.updateOne({ _id: source._id }, { $set: patch });
        for (const queue of [enqueue, historical]) {
          const obsolete = await queue(); await deliver(); assert.equal(sent.length, before + 2);
          assert.equal((await OutboxEvent.findById(obsolete._id)).payload.deliveryStatus, 'cancelled');
        }
        await Model.updateOne({ _id: source._id }, { $set: restore });
      }
      await preferences([]);
      const oldMuted = await historical(); await deliver(); assert.equal(sent.length, before + 2);
      assert.equal((await OutboxEvent.findById(oldMuted._id)).payload.deliveryStatus, 'cancelled');
      const unknown = await addOutboxEvent({ type: 'seller.order_notification', aggregateType: 'seller_order', aggregatePublicId: sellerOrder.publicId,
        payload: { email: 'unknown-stranger@example.com', subject: 'Unknown old work', body: 'No recognized order source envelope.' } });
      await deliver(); assert.equal(sent.length, before + 2); assert.equal((await OutboxEvent.findById(unknown._id)).payload.deliveryStatus, 'cancelled');
      for (const notificationCategory of [undefined, 'service']) {
        await addOutboxEvent({ type: 'seller.order_notification', aggregateType: 'seller_order', aggregatePublicId: sellerOrder.publicId,
          payload: { notificationCategory, orderPublicId: order.publicId, country: 'UG', email: 'stale-service@example.com',
            subject: `${store.name}: Requested order support`, body: `About order ${order.publicId}\n\nA required reply concerning the saved purchase.` } });
        await deliver(); assert.equal(sent.at(-1).subject, `${store.name}: Requested order support`); assert.equal(sent.at(-1).email, buyer.email);
      }
      assert.equal(sent.length, before + 4);
      const notice = await Notification.create({ publicId: id('ntf'), userId: buyer._id, country: 'UG', type: 'order.fulfilment', title: 'Required order record', body: 'Your recorded order state remains accessible.', href: '/track-order?order=' + order.publicId });
      assert.match((await client.get('/notifications').expect(200)).text, /Required order record/);
      assert.ok(await Notification.findById(notice._id));
      await addOutboxEvent({ type: 'guest.order_access_code', aggregateType: 'order', aggregatePublicId: order.publicId, payload: { email: buyer.email, subject: 'Required access challenge', body: 'Requested order access challenge.' } });
      await deliver(); assert.equal(sent.at(-1).subject, 'Required access challenge');
    });

    await t.test('a later privacy restriction still overrides optional notification opt-in and cancels queued delivery', async () => {
      await preferences(['wishlist', 'offers', 'club']);
      const queued = await queuePushNotification({ userId: buyer._id, category: 'wishlist', title: 'Restricted later', body: 'Must not reach the local gateway.' });
      await PrivacyRequest.create({ publicId: id('prv'), userId: buyer._id, userPublicId: buyer.publicId, country: 'UG', type: 'restriction', status: 'completed', restrictionActive: true, identityVerifiedAt: new Date() });
      const before = pushes.length; await processPushOutbox(); assert.equal(pushes.length, before);
      assert.equal((await OutboxEvent.findById(queued._id)).payload.deliveryStatus, 'cancelled');
      await assert.rejects(queuePushNotification({ userId: buyer._id, category: 'club', title: 'Restricted now', body: 'Must not queue.' }), error => error.code === 'PRIVACY_PROCESSING_RESTRICTED');
    });
  } finally {
    await close(web); await close(gateway);
    if (mongoose.connection.readyState) {
      assert.equal(mongoose.connection.name, dbName);
      for (const Model of Object.values(mongoose.models)) await Model.init();
      await mongoose.connection.dropDatabase(); await mongoose.disconnect();
    }
  }
});

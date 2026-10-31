import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';

// This file owns its database and app. It never submits a provider payment.
process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;

test('HTTP checkout preserves reviewed identity, real reward funding and recoverable retries', { skip: !uri, timeout: 120_000 }, async t => {
  const target = new URL(uri);
  assert.equal(target.hostname, '127.0.0.1');
  assert.match(target.pathname, /test|verification/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: `classicmart_checkout_recovery_test_${suffix}` });
  const models = await import('../src/models/index.js');
  const { User, Device, CountrySetting, Category, Store, Warehouse, Product, ProductVariant, StockItem,
    CustomerAddress, CustomerReward, Cart, Order, SellerOrder, InventoryReservation, PaymentIntent, LedgerAccount,
    LedgerTransaction, FinancialDocument, Shipment, LoyaltyEntry, ShippingZone, Refund, PlatformGrant,
    Brand, PickupPoint, SellerPromotion } = models;
  const { createApp } = await import('../src/app.js');
  const { addLoyaltyPoints } = await import('../src/services/loyalty.js');
  const { redeemCustomerReward } = await import('../src/services/customer-rewards.js');
  const { ensureLedgerAccount, postLedgerTransaction, accountBalanceMinor } = await import('../src/services/money.js');
  const { createRefund } = await import('../src/services/payments.js');
  const { hashToken } = await import('../src/core/crypto.js');
  const { cancelOrder } = await import('../src/services/checkout.js');
  const app = createApp(null), browser = request.agent(app);
  let sequence = 0, csrf, buyer, password, product, first, second, stock, owner, issued, wallet, financeRequest, buyerRequest;
  const id = prefix => `${prefix}_${suffix}_${++sequence}`;
  const csrfFrom = html => {
    const value = html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/);
    assert.ok(value, 'server must issue a CSRF token');
    return value[1];
  };
  const transaction = async work => {
    const session = await mongoose.startSession();
    try { return await session.withTransaction(() => work(session)); }
    finally { await session.endSession(); }
  };
  async function seedActor(role) {
    const publicId = id('usr'), email = publicId + '@example.com', phone = '+2567' + crypto.randomInt(10_000_000, 99_999_999);
    return User.create({ publicId, name: `Checkout ${role}`, email, emailNormalized: email, phone, phoneNormalized: phone,
      passwordHash: crypto.randomBytes(32).toString('hex'), role, country: 'UG', currency: 'UGX',
      emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
      consents: { terms: true, privacy: true, recordedAt: new Date() } });
  }
  const post = (path, body) => browser.post(path).set('Accept', 'application/json').set('x-csrf-token', csrf).send(body);
  const contact = () => ({ fullName: buyer.name, email: buyer.email, phone: buyer.phone,
    address: '10 Recovery Street', city: 'Kampala', country: 'Uganda', note: 'Use the front gate' });
  const input = (extra = {}) => ({ deliveryMethod: 'standard', paymentMethod: 'cod', city: 'Kampala', contact: contact(), ...extra });
  async function cartWith(variant = first) {
    await browser.delete('/api/v1/cart').set('x-csrf-token', csrf).expect(200);
    await post('/api/v1/cart/items', { productId: product.publicId, variantId: variant.publicId, quantity: 2 }).expect(200);
  }
  async function reviewed(extra = {}) {
    const body = input(extra), response = await post('/api/v1/checkout/review', body).expect(200);
    return { ...body, checkoutId: response.body.checkoutId, idempotencyKey: id('order-key') };
  }
  async function assertNoReservation() {
    assert.equal(await InventoryReservation.countDocuments({ status: 'active' }), 0);
    assert.equal((await StockItem.findById(stock._id)).reserved, 0);
  }
  // Apply a genuine database write after the transaction has read its snapshot
  // but before it writes this source. Do not change __v or updatedAt: checkout
  // must conflict with the actual source edit rather than a cooperative writer.
  function editBeforeSourceFence(Model, row, update) {
    const original = Model.updateOne;
    let edited = false;
    const interceptor = t.mock.method(Model, 'updateOne', function(filter, change, options) {
      if (!edited && change?.$inc?.checkoutReadRevision === 1 && String(filter._id) === String(row._id)) {
        edited = true;
        return Model.collection.updateOne({ _id: row._id }, update)
          .then(() => original.call(this, filter, change, options));
      }
      return original.call(this, filter, change, options);
    });
    return { restore: () => interceptor.mock.restore(), edited: () => edited };
  }
  function afterOrderRead(orderPublicId, change, transactional = false) {
    const original = mongoose.Query.prototype.exec;
    let edited = false;
    const interceptor = t.mock.method(mongoose.Query.prototype, 'exec', async function(...args) {
      const row = await original.apply(this, args);
      if (!edited && this.model === Order && this.op === 'findOne'
        && this.getQuery().publicId === orderPublicId && Boolean(this.getOptions().session) === transactional) {
        edited = true;
        await change();
      }
      return row;
    });
    return { restore: () => interceptor.mock.restore(), edited: () => edited };
  }
  async function serviceRequest(user, requiredOperationalWorkspace) {
    const sessionID = id('session'), device = await Device.create({ publicId: id('dev'), userId: user._id,
      sessionHash: hashToken(sessionID), label: 'Actual checkout test session', ipHash: hashToken('127.0.0.1'),
      userAgent: 'Checkout recovery regression', lastSeenAt: new Date() });
    return { id: id('request'), user, device, sessionID, session: { userId: String(user._id), tokenVersion: user.security.tokenVersion },
      country: { code: 'UG', name: 'Uganda', currency: 'UGX' }, ip: '127.0.0.1', query: {}, get: () => '',
      ...(requiredOperationalWorkspace ? { requiredOperationalWorkspace } : {}) };
  }
  const postingNet = ledgers => {
    const net = new Map();
    for (const ledger of ledgers) for (const entry of ledger.entries) net.set(String(entry.accountId),
      (net.get(String(entry.accountId)) || 0) + Number(entry.debitMinor) - Number(entry.creditMinor));
    return [...net.values()];
  };
  async function fundedPaidOrder() {
    await cartWith();
    const details = input({ paymentMethod: 'wallet', rewardPublicId: issued.publicId });
    const review = (await post('/api/v1/checkout/review', details).expect(200)).body;
    const body = { ...details, checkoutId: review.checkoutId, idempotencyKey: id('order-key') };
    const placed = (await post('/api/v1/orders', body).expect(201)).body.order;
    const payment = (await post(`/api/v1/orders/${placed.id}/payment-intents`, { idempotencyKey: id('wallet-payment') }).expect(201)).body.payment;
    const order = await Order.findOne({ publicId: placed.id }).lean(), sellerOrder = await SellerOrder.findOne({ orderId: order._id }).lean();
    return { order, sellerOrder, payment, review, original: await LedgerTransaction.findOne({ idempotencyKey: `payment:${payment.id}` }).lean() };
  }
  const partialRefund = f => createRefund(financeRequest, { orderId: f.order.publicId, amountMinor: 1001,
    reason: 'Independently reviewed pre-fulfilment line refund', idempotencyKey: id('partial-refund'),
    allocations: [{ storePublicId: f.sellerOrder.storePublicId, orderLineId: f.sellerOrder.items[0].orderLineId, grossMinor: 1001 }] });
  try {
    for (const Model of Object.values(models)) if (Model.init) await Model.init();
    const setting = await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG',
      timeZone: 'Africa/Kampala', phonePrefix: '+256', taxBps: 0, platformFeeBps: 500,
      growth: { loyaltyEnabled: true, referralEnabled: false, loyaltyPointsPer1000Minor: 10,
        rewardCatalogue: [{ key: 'goods', label: 'Reviewed goods voucher', kind: 'voucher', pointsCost: 100, valueMinor: 1999, validDays: 30 }],
        clubBenefits: [{ tier: 'silver', multiplierBps: 20000, standardShippingDiscountBps: 5000 }] } });
    const zone = await ShippingZone.create({ publicId: id('zone'), country: 'UG', name: 'Recovery Kampala', cities: ['Kampala'],
      standardFeeMinor: 2000, expressFeeMinor: 4000, currency: 'UGX' });
    const pickup = await PickupPoint.create({ publicId: id('pickup'), country: 'UG', name: 'Recovery collection', city: 'Kampala', address: 'Recovery pickup road' });
    owner = await seedActor('seller');
    const reviewerA = await seedActor('moderator'), reviewerB = await seedActor('moderator');
    const store = await Store.create({ publicId: id('sto'), ownerUserId: owner._id, name: 'Recovery supplier',
      slug: id('supplier'), country: 'UG', currency: 'UGX', status: 'verified', verifiedAt: new Date() });
    const warehouse = await Warehouse.create({ publicId: id('wh'), storeId: store._id, ownerUserId: owner._id,
      name: 'Recovery warehouse', country: 'UG', city: 'Kampala', address: 'Warehouse Recovery Road', active: true });
    const category = await Category.create({ publicId: id('cat'), name: 'Reviewed recovery goods', slug: id('category'),
      countries: ['UG'], active: true, restricted: true });
    const brand = await Brand.create({ publicId: id('brand'), name: 'Reviewed recovery brand', slug: id('brand'), status: 'approved' });
    product = await Product.create({ publicId: id('prd'), storeId: store._id, ownerUserId: owner._id, categoryId: category._id, brandId: brand._id,
      title: 'Reviewed checkout goods', slug: id('goods'), description: 'Isolated checkout regression product',
      countries: ['UG'], status: 'published', publishedAt: new Date(), moderation: { riskLevel: 'high', secondReviewRequired: false,
        firstApprovalByUserId: reviewerA._id, firstApprovalAt: new Date(), reviewedByUserId: reviewerB._id, reviewedAt: new Date() } });
    [first, second] = await ProductVariant.create(['FIRST', 'SECOND'].map(label => ({ publicId: id('var'), productId: product._id,
      storeId: store._id, title: label, sku: id(label), priceMinor: 5000, costMinor: 700, currency: 'UGX', active: true })));
    const stocks = await StockItem.create([first, second].map(variant => ({ publicId: id('stk'), storeId: store._id,
      warehouseId: warehouse._id, variantId: variant._id, onHand: 50, reserved: 0 })));
    stock = stocks[0];
    const signup = await browser.get('/signup').expect(200), email = id('buyer') + '@example.com';
    password = `Recovery-${suffix}A1!`;
    await browser.post('/signup').type('form').send({ name: 'Checkout Recovery Buyer', email,
      phone: '+2567' + crypto.randomInt(10_000_000, 99_999_999), password, confirmPassword: password,
      acceptTerms: 'on', _csrf: csrfFrom(signup.text) }).expect(302);
    buyer = await User.findOne({ emailNormalized: email });
    assert.ok(buyer, 'signup must create the actual customer');
    await User.updateOne({ _id: buyer._id }, { $set: { emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), onboardingCompletedAt: new Date() } });
    buyer = await User.findById(buyer._id);
    assert.equal(await Device.countDocuments({ userId: buyer._id, revokedAt: null }), 1);
    buyerRequest = await serviceRequest(buyer);
    const finance = await seedActor('finance');
    await User.updateOne({ _id: finance._id }, { $set: { platformAccessManagedAt: new Date(), operationalCountries: ['UG'] } });
    await PlatformGrant.create({ publicId: id('pgr'), userId: finance._id, role: 'finance', operationalCountries: ['UG'], status: 'active',
      startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000),
      reason: 'Isolated checkout refund verification', approvalPublicId: id('approval'), approvedByUserId: reviewerA._id });
    financeRequest = await serviceRequest(await User.findById(finance._id), 'finance');
    const cartResponse = await browser.get('/api/v1/cart').expect(200); csrf = cartResponse.body.csrfToken;

    await t.test('unauthenticated checkout requires sign in and CSRF protects the browser API', async () => {
      await request(app).get('/checkout/profile').set('Accept', 'application/json').expect(401);
      await browser.post('/api/v1/checkout/review').set('Accept', 'application/json').send(input()).expect(403);
    });
    await t.test('changing only the selected SKU at the same price invalidates review without reserving stock', async () => {
      await cartWith(); const body = await reviewed();
      await cartWith(second);
      const changed = await post('/api/v1/orders', body).expect(409);
      assert.equal(changed.body.error.code, 'CHECKOUT_CART_CHANGED');
      assert.equal(await Order.countDocuments({ userId: buyer._id }), 0);
      assert.equal((await Cart.findOne({ userId: buyer._id })).items[0].variantId.toString(), second._id.toString());
      await assertNoReservation();
    });
    await t.test('contact edits, stale owned addresses and a foreign saved address cannot reuse review', async () => {
      await cartWith();
      const address = await CustomerAddress.create({ publicId: id('addr'), userId: buyer._id, ...contact(), country: 'UG', isDefault: true });
      const extra = { addressPublicId: address.publicId, addressVersion: address.__v || 0 }, body = await reviewed(extra);
      const changed = await post('/api/v1/orders', { ...body, contact: { ...body.contact, note: 'An unreviewed gate' } }).expect(409);
      assert.equal(changed.body.error.code, 'CHECKOUT_REVIEW_REQUIRED');
      await CustomerAddress.updateOne({ _id: address._id }, { $set: { note: 'Changed in another tab' }, $inc: { __v: 1 } });
      assert.equal((await post('/api/v1/orders', body).expect(409)).body.error.code, 'CHECKOUT_ADDRESS_CHANGED');
      await CustomerAddress.updateOne({ _id: address._id }, { $set: { userId: owner._id } });
      assert.equal((await post('/api/v1/checkout/review', input(extra)).expect(409)).body.error.code, 'CHECKOUT_ADDRESS_CHANGED');
      await assertNoReservation();
    });
    await t.test('changed catalogue prices invalidate review and roll back stock', async () => {
      await cartWith(); const body = await reviewed();
      await ProductVariant.updateOne({ _id: first._id }, { $inc: { priceMinor: 1, __v: 1 } });
      assert.equal((await post('/api/v1/orders', body).expect(409)).body.error.code, 'CHECKOUT_CART_CHANGED');
      await ProductVariant.updateOne({ _id: first._id }, { $set: { priceMinor: 5000 }, $inc: { __v: 1 } });
      await assertNoReservation();
    });
    await t.test('source edits after the checkout snapshot force retry and reject stale reviewed sources', async sourceTest => {
      const cases = [
        { Model: ProductVariant, row: first, field: 'priceMinor', changed: 5001, restored: 5000, code: 'CHECKOUT_CART_CHANGED' },
        { Model: Product, row: product, field: 'status', changed: 'suspended', restored: 'published', code: 'CART_CHANGED' },
        { Model: Product, row: product, field: 'moderation.secondReviewRequired', changed: true, restored: false, code: 'CART_CHANGED' },
        { Model: Store, row: store, field: 'status', changed: 'suspended', restored: 'verified', code: 'CART_CHANGED' },
        { Model: Category, row: category, field: 'active', changed: false, restored: true, code: 'CART_CHANGED' },
        { Model: Brand, row: brand, field: 'status', changed: 'rejected', restored: 'approved', code: 'CART_CHANGED' },
        { Model: Warehouse, row: warehouse, field: 'active', changed: false, restored: true, code: 'INSUFFICIENT_STOCK' },
        { Model: ShippingZone, row: zone, field: 'active', changed: false, restored: true, code: 'DELIVERY_AREA_UNAVAILABLE' },
        { Model: ShippingZone, row: zone, field: 'standardFeeMinor', changed: 2001, restored: 2000, code: 'CHECKOUT_TOTAL_CHANGED' },
        { Model: PickupPoint, row: pickup, field: 'active', changed: false, restored: true, code: 'PICKUP_POINT_UNAVAILABLE',
          input: { deliveryMethod: 'pickup', pickupPointId: pickup.publicId } },
        { Model: CountrySetting, row: setting, field: 'taxBps', changed: 100, restored: 0, code: 'CHECKOUT_TOTAL_CHANGED' },
      ];
      for (const scenario of cases) await sourceTest.test(`${scenario.Model.modelName}.${scenario.field}`, async () => {
        await cartWith(); const body = await reviewed(scenario.input);
        const hook = editBeforeSourceFence(scenario.Model, scenario.row, { $set: { [scenario.field]: scenario.changed } });
        try {
          const response = await post('/api/v1/orders', body).expect(409);
          assert.equal(response.body.error.code, scenario.code);
          assert.equal(hook.edited(), true, 'the edit must land between the snapshot read and its write fence');
          assert.equal(await Order.countDocuments({ idempotencyKey: body.idempotencyKey }), 0);
          assert.equal((await Cart.findOne({ userId: buyer._id })).items.length, 1);
          await assertNoReservation();
        } finally {
          hook.restore();
          await scenario.Model.collection.updateOne({ _id: scenario.row._id }, { $set: { [scenario.field]: scenario.restored } });
        }
      });
    });
    await t.test('checkout source fences stay private and preserve catalogue UI versions', async () => {
      const sources = [[Product, product], [ProductVariant, first], [Store, store], [Category, category],
        [Brand, brand], [Warehouse, warehouse], [ShippingZone, zone], [CountrySetting, setting]];
      const before = [];
      for (const [Model, row] of sources) before.push(await Model.findById(row._id).lean());
      await cartWith(); const body = await reviewed();
      const placed = (await post('/api/v1/orders', body).expect(201)).body.order;
      for (let index = 0; index < sources.length; index++) {
        const [Model, row] = sources[index], current = await Model.findById(row._id).lean();
        assert.equal(current.checkoutReadRevision, undefined);
        assert.equal(current.__v, before[index].__v);
        assert.equal(current.updatedAt.getTime(), before[index].updatedAt.getTime());
        assert.ok((await Model.findById(row._id).select('+checkoutReadRevision').lean()).checkoutReadRevision > 0);
      }
      await post(`/api/v1/orders/${placed.id}/cancel`, { reason: 'Release catalogue version fixture' }).expect(200);
      await assertNoReservation();
    });
    await t.test('cancellation rechecks a revoked customer device after its initial order read', async () => {
      await cartWith(); const placed = (await post('/api/v1/orders', await reviewed()).expect(201)).body.order;
      const hook = afterOrderRead(placed.id, () => Device.updateOne({ _id: buyerRequest.device._id }, { $set: { revokedAt: new Date() } }));
      try {
        await assert.rejects(cancelOrder(buyerRequest, placed.id), error => error.code === 'ACCOUNT_UNAVAILABLE');
        assert.equal(hook.edited(), true);
        assert.equal((await Order.findOne({ publicId: placed.id })).cancellationState, 'none');
        assert.equal((await StockItem.findById(stock._id)).reserved, 2);
      } finally {
        hook.restore();
        await Device.updateOne({ _id: buyerRequest.device._id }, { $set: { revokedAt: null } });
      }
      await post(`/api/v1/orders/${placed.id}/cancel`, { reason: 'Release revoked device fixture' }).expect(200);
      await assertNoReservation();
    });
    await t.test('cancellation does not reuse a tracked-order grant removed after its initial read', async () => {
      await cartWith(); const placed = (await post('/api/v1/orders', await reviewed()).expect(201)).body.order;
      const tracked = { session: { orderGrants: { [placed.id]: { level: 'mutate', expiresAt: Date.now() + 60_000 } } }, country: buyerRequest.country };
      const hook = afterOrderRead(placed.id, async () => { delete tracked.session.orderGrants[placed.id]; });
      try {
        await assert.rejects(cancelOrder(tracked, placed.id), error => error.code === 'ORDER_NOT_FOUND');
        assert.equal(hook.edited(), true);
        assert.equal((await Order.findOne({ publicId: placed.id })).cancellationState, 'none');
        assert.equal((await StockItem.findById(stock._id)).reserved, 2);
      } finally { hook.restore(); }
      await post(`/api/v1/orders/${placed.id}/cancel`, { reason: 'Release removed grant fixture' }).expect(200);
      await assertNoReservation();
    });
    await t.test('wallet payment funds seller proceeds from actual customer cash plus platform expense and cancels exactly once', async () => {
      await transaction(session => addLoyaltyPoints({ userId: buyer._id, country: 'UG', points: 1000,
        idempotencyKey: id('seed-points'), type: 'manual_adjustment', reason: 'Isolated checkout verification' }, session));
      issued = await redeemCustomerReward({ user: buyer, country: 'UG', currency: 'UGX', rewardKey: 'goods', idempotencyKey: id('reward-key') });
      await transaction(async session => {
        wallet = await ensureLedgerAccount({ code: 'customer_wallet', type: 'liability', ownerType: 'customer', ownerId: buyer._id,
          ownerPublicId: buyer.publicId, country: 'UG', currency: 'UGX' }, session);
        const cash = await ensureLedgerAccount({ code: 'test_checkout_cash', type: 'asset', ownerType: 'platform',
          ownerPublicId: 'checkout-verification', country: 'UG', currency: 'UGX' }, session);
        await postLedgerTransaction({ idempotencyKey: id('fund-wallet'), referenceType: 'test_funding', referencePublicId: buyer.publicId,
          country: 'UG', currency: 'UGX', description: 'Actual isolated wallet funding', entries: [
            { account: cash, debitMinor: 20000, creditMinor: 0 }, { account: wallet, debitMinor: 0, creditMinor: 20000 }] }, session);
      });
      await cartWith(); const body = await reviewed({ paymentMethod: 'wallet', rewardPublicId: issued.publicId });
      const placed = (await post('/api/v1/orders', body).expect(201)).body.order;
      assert.equal((await CustomerReward.findById(issued._id)).status, 'reserved');
      const replay = (await post('/api/v1/orders', body).expect(201)).body.order; assert.equal(replay.id, placed.id);
      const paymentBody = { idempotencyKey: id('payment-key') }, path = `/api/v1/orders/${placed.id}/payment-intents`;
      const paid = (await post(path, paymentBody).expect(201)).body.payment;
      assert.equal(paid.status, 'succeeded');
      const order = await Order.findOne({ publicId: placed.id }).lean();
      assert.equal(order.fundingSnapshot.rewardGoodsMinor, 1999);
      assert.equal(order.fundingSnapshot.clubShippingMinor, 1000);
      const sellerOrder = await SellerOrder.findOne({ orderId: order._id }).lean(), line = sellerOrder.items[0];
      assert.equal(line.customerPaidMinor + line.platformContributionMinor, 10000);
      assert.equal(line.platformFeeMinor + line.sellerReceivableMinor, 10000);
      assert.equal(line.platformContributionMinor, 1999);
      const ledger = await LedgerTransaction.findOne({ idempotencyKey: `payment:${paid.id}` }).lean();
      const expense = await LedgerAccount.findOne({ code: 'platform_rewards_expense', country: 'UG', currency: 'UGX' });
      assert.equal(ledger.entries.find(entry => String(entry.accountId) === String(wallet._id)).debitMinor, order.totals.totalMinor);
      assert.equal(ledger.entries.find(entry => String(entry.accountId) === String(expense._id)).debitMinor, 2999);
      assert.equal(await accountBalanceMinor(wallet._id), 20000 - order.totals.totalMinor);
      await post(path, paymentBody).expect(201);
      assert.equal(await LedgerTransaction.countDocuments({ idempotencyKey: `payment:${paid.id}` }), 1);
      assert.equal(await Shipment.countDocuments({ orderId: order._id }), 1);
      assert.equal((await CustomerReward.findById(issued._id)).status, 'used');
      assert.equal(await FinancialDocument.countDocuments({ orderId: order._id, type: 'payment_receipt' }), 1);
      assert.ok(await LoyaltyEntry.exists({ idempotencyKey: `order:${order.publicId}:loyalty` }));
      await post(`/api/v1/orders/${placed.id}/cancel`, { reason: 'Cancel before carrier collection' }).expect(200);
      await post(`/api/v1/orders/${placed.id}/cancel`, { reason: 'Replay original cancellation' }).expect(200);
      assert.equal(await accountBalanceMinor(wallet._id), 20000);
      assert.equal((await CustomerReward.findById(issued._id)).status, 'issued');
      assert.equal((await StockItem.findById(stock._id)).onHand, 50);
      assert.equal((await Order.findById(order._id)).refundState, 'complete');
    });
    await t.test('COD commits inventory before collection and unpaid cancellation releases its reward', async () => {
      await cartWith(); const body = await reviewed({ rewardPublicId: issued.publicId });
      const placed = (await post('/api/v1/orders', body).expect(201)).body.order;
      const payment = (await post(`/api/v1/orders/${placed.id}/payment-intents`, { idempotencyKey: id('cod-key') }).expect(201)).body.payment;
      assert.equal(payment.status, 'pending_collection');
      assert.equal((await StockItem.findById(stock._id)).onHand, 48);
      assert.equal((await CustomerReward.findById(issued._id)).status, 'reserved');
      assert.equal(await LedgerTransaction.countDocuments({ idempotencyKey: `payment:${payment.id}` }), 0);
      await post(`/api/v1/orders/${placed.id}/cancel`, { reason: 'Cancel unpaid COD before carrier pickup' }).expect(200);
      assert.equal((await CustomerReward.findById(issued._id)).status, 'issued');
      assert.equal((await StockItem.findById(stock._id)).onHand, 50);
      assert.equal((await PaymentIntent.findOne({ publicId: payment.id })).status, 'cancelled');
    });
    await t.test('funded review preserves tax after seller promotions and charges only the remaining customer cash', async () => {
      await CountrySetting.updateOne({ code: 'UG' }, { $set: { taxBps: 1500 }, $inc: { __v: 1 } });
      const promotion = await SellerPromotion.create({ publicId: id('spr'), storeId: store._id, storePublicId: store.publicId,
        country: 'UG', currency: 'UGX', type: 'quantity_break', name: 'Seller-funded quantity promotion',
        minQuantity: 2, fixedDiscountMinor: 1000, status: 'active', startsAt: new Date(Date.now() - 60_000), createdByUserId: owner._id });
      try {
        const opening = await accountBalanceMinor(wallet._id), f = await fundedPaidOrder();
        assert.equal(f.review.delivery.taxMinor, 1650);
        assert.equal(f.review.totals.taxMinor, 1650, 'tax uses 9000 seller-net goods plus 2000 gross delivery');
        assert.equal(f.order.totals.taxMinor, 1650);
        assert.equal(f.order.totals.totalMinor, 9651);
        assert.equal(f.order.totals.discountMinor, 2999);
        const line = f.sellerOrder.items[0];
        assert.equal(line.customerPaidMinor, 7001);
        assert.equal(line.platformContributionMinor, 1999);
        assert.equal(line.sellerReceivableMinor + line.platformFeeMinor, 9000);
        const debit = f.original.entries.reduce((sum, entry) => sum + entry.debitMinor, 0);
        const credit = f.original.entries.reduce((sum, entry) => sum + entry.creditMinor, 0);
        assert.equal(debit, f.order.totals.totalMinor + 2999);
        assert.equal(credit, 9000 + 2000 + 1650);
        assert.equal(debit, credit);
        assert.equal(await accountBalanceMinor(wallet._id), opening - 9651);
        await post(`/api/v1/orders/${f.order.publicId}/cancel`, { reason: 'Release seller and platform funding tax fixture' }).expect(200);
        assert.equal(await accountBalanceMinor(wallet._id), opening);
        assert.equal((await CustomerReward.findById(issued._id)).status, 'issued');
      } finally { await SellerPromotion.updateOne({ _id: promotion._id }, { $set: { status: 'paused' } }); }
    });
    await t.test('partial refund followed by cancellation reverses exactly the remaining original tax, shipping, fee, seller and subsidy', async () => {
      await CountrySetting.updateOne({ code: 'UG' }, { $set: { taxBps: 1500 }, $inc: { __v: 1 } });
      const opening = await accountBalanceMinor(wallet._id), f = await fundedPaidOrder();
      assert.equal(f.review.totals.taxMinor, 1800);
      assert.equal(f.order.totals.taxMinor, 1800, 'platform goods and shipping funding preserve the 12000 taxable base');
      assert.equal(f.order.totals.totalMinor, 10801);
      const originalDebits = f.original.entries.reduce((sum, entry) => sum + entry.debitMinor, 0);
      const originalCredits = f.original.entries.reduce((sum, entry) => sum + entry.creditMinor, 0);
      assert.equal(originalDebits, f.order.totals.totalMinor + 2999);
      assert.equal(originalCredits, 10000 + 2000 + 1800, 'cash plus platform expense funds goods, gross shipping and original tax');
      assert.equal(originalDebits, originalCredits);
      const partial = await partialRefund(f);
      assert.equal(partial.status, 'completed');
      await assert.rejects(createRefund(financeRequest, { orderId: f.order.publicId, amountMinor: 1,
        reason: 'Reject an unallocated ordinary partial refund', idempotencyKey: id('unallocated') }),
      error => error.code === 'PARTIAL_REFUND_ALLOCATION_REQUIRED');
      const cancelled = (await post(`/api/v1/orders/${f.order.publicId}/cancel`, { reason: 'Cancel after reviewed partial reimbursement' }).expect(200)).body.order;
      assert.equal(cancelled.paymentState, 'refunded');
      assert.equal(cancelled.cancellationState, 'cancelled');
      const remaining = await Refund.findOne({ idempotencyKey: `cancel:${f.order.publicId}` }).lean();
      assert.equal(remaining.status, 'completed');
      assert.equal(remaining.amountMinor, f.order.totals.totalMinor - partial.amountMinor);
      assert.equal(remaining.settlementMode, 'cancellation_remainder');
      assert.equal(remaining.allocations.length, 0);
      assert.equal(remaining.cancellationSettlement.originalLedgerPublicId, f.original.publicId);
      assert.deepEqual(remaining.cancellationSettlement.completedRefunds.map(row => row.refundPublicId), [partial.publicId]);
      const refunds = await LedgerTransaction.find({ idempotencyKey: { $in: [`refund:${partial.publicId}`, `refund:${remaining.publicId}`] } }).lean();
      assert.equal(refunds.length, 2);
      assert.ok(postingNet([f.original, ...refunds]).every(value => value === 0));
      assert.equal(await accountBalanceMinor(wallet._id), opening);
      assert.equal((await CustomerReward.findById(issued._id)).status, 'issued');
      assert.equal((await StockItem.findById(stock._id)).onHand, 50);
      const replay = await createRefund(buyerRequest, { orderId: f.order.publicId, reason: remaining.reason, idempotencyKey: remaining.idempotencyKey });
      assert.equal(replay.publicId, remaining.publicId);
      assert.equal(await LedgerTransaction.countDocuments({ idempotencyKey: `refund:${remaining.publicId}` }), 1);
      assert.equal(await accountBalanceMinor(wallet._id), opening);
    });
    await t.test('a real refund reserved after the cancellation transaction snapshot forces a fresh-state retry', async () => {
      const opening = await accountBalanceMinor(wallet._id), f = await fundedPaidOrder();
      const refundInput = { orderId: f.order.publicId, amountMinor: 1001, reason: 'Independent refund reserved before customer cancellation',
        idempotencyKey: id('concurrent-partial'), allocations: [{ storePublicId: f.sellerOrder.storePublicId,
          orderLineId: f.sellerOrder.items[0].orderLineId, grossMinor: 1001 }] };
      const hook = afterOrderRead(f.order.publicId, async () => {
        const failure = t.mock.method(FinancialDocument, 'create', async () => { throw new Error('Concurrent refund document temporarily unavailable'); });
        try { await assert.rejects(createRefund(financeRequest, refundInput), /temporarily unavailable/); }
        finally { failure.mock.restore(); }
      }, true);
      try {
        await assert.rejects(cancelOrder(buyerRequest, f.order.publicId), error => error.code === 'ORDER_CANCELLATION_STATE');
        assert.equal(hook.edited(), true);
        const held = await Order.findById(f.order._id).lean();
        assert.equal(held.refundState, 'processing');
        assert.equal(held.cancellationState, 'none');
        assert.equal(held.fulfillmentState, 'unfulfilled');
        assert.equal((await StockItem.findById(stock._id)).onHand, 48);
        assert.notEqual((await Shipment.findOne({ orderId: f.order._id })).status, 'cancelled');
        assert.equal((await Refund.findOne({ idempotencyKey: refundInput.idempotencyKey })).status, 'processing');
      } finally { hook.restore(); }
      await createRefund(financeRequest, refundInput);
      await post(`/api/v1/orders/${f.order.publicId}/cancel`, { reason: 'Release concurrent partial refund fixture' }).expect(200);
      assert.equal(await accountBalanceMinor(wallet._id), opening);
      assert.equal((await CustomerReward.findById(issued._id)).status, 'issued');
      assert.equal((await StockItem.findById(stock._id)).onHand, 50);
    });
    await t.test('a crashed remaining-refund attempt retains its hold and rejects altered source lineage before a safe retry', async () => {
      const opening = await accountBalanceMinor(wallet._id), f = await fundedPaidOrder(), partial = await partialRefund(f);
      const failure = t.mock.method(FinancialDocument, 'create', async () => { throw new Error('Credit note storage temporarily unavailable'); });
      try { await post(`/api/v1/orders/${f.order.publicId}/cancel`, { reason: 'Retain cancellation refund while accounting retries' }).expect(200); }
      finally { failure.mock.restore(); }
      const held = await Refund.findOne({ idempotencyKey: `cancel:${f.order.publicId}` }).lean();
      assert.equal(held.status, 'processing');
      assert.equal(await LedgerTransaction.countDocuments({ idempotencyKey: `refund:${held.publicId}` }), 0);
      assert.equal((await PaymentIntent.findOne({ publicId: f.payment.id })).refundReservedMinor, held.amountMinor);
      const retry = { orderId: f.order.publicId, idempotencyKey: held.idempotencyKey, reason: held.reason };
      const heldBalance = await accountBalanceMinor(wallet._id);
      await Refund.collection.updateOne({ _id: held._id }, { $set: { 'cancellationSettlement.sourceHash': '0'.repeat(64) } });
      await assert.rejects(createRefund(buyerRequest, retry), error => error.code === 'REFUND_CANCELLATION_SOURCE_CHANGED');
      assert.equal(await accountBalanceMinor(wallet._id), heldBalance);
      assert.equal(await LedgerTransaction.countDocuments({ idempotencyKey: `refund:${held.publicId}` }), 0);
      await Refund.collection.updateOne({ _id: held._id }, { $set: { cancellationSettlement: held.cancellationSettlement } });
      const completed = await createRefund(buyerRequest, retry);
      assert.equal(completed.status, 'completed');
      const refundLedgers = await LedgerTransaction.find({ idempotencyKey: { $in: [`refund:${partial.publicId}`, `refund:${held.publicId}`] } }).lean();
      assert.ok(postingNet([f.original, ...refundLedgers]).every(value => value === 0));
      assert.equal(await accountBalanceMinor(wallet._id), opening);
      assert.equal((await CustomerReward.findById(issued._id)).status, 'issued');
      assert.equal((await PaymentIntent.findOne({ publicId: f.payment.id })).refundReservedMinor, 0);
    });
    await t.test('simultaneous same-key placement returns one order to both callers', async () => {
      await cartWith(); const body = await reviewed();
      const responses = await Promise.all([post('/api/v1/orders', body), post('/api/v1/orders', body)]);
      for (const response of responses) assert.equal(response.status, 201, JSON.stringify(response.body));
      assert.equal(responses[0].body.order.id, responses[1].body.order.id);
      assert.equal(await Order.countDocuments({ userId: buyer._id, idempotencyKey: body.idempotencyKey }), 1);
      assert.equal((await StockItem.findById(stock._id)).reserved, 2);
      await post(`/api/v1/orders/${responses[0].body.order.id}/cancel`, { reason: 'Release concurrent checkout fixture' }).expect(200);
      await assertNoReservation();
    });
    await t.test('mobile checkout returns the created identifier needed for payment', async () => {
      const login = await request(app).post('/api/v1/mobile/auth/login').send({ identity: buyer.email, password,
        deviceName: 'Recovery mobile client', platform: 'android' }).expect(201);
      const authorization = `Bearer ${login.body.accessToken}`;
      const mobilePost = (path, body) => request(app).post(path).set('Authorization', authorization).send(body);
      await mobilePost('/api/v1/mobile/cart/items', { productId: product.publicId, variantId: second.publicId, quantity: 1 }).expect(201);
      const body = input(), review = await mobilePost('/api/v1/mobile/checkout/review', body).expect(200);
      const response = await mobilePost('/api/v1/mobile/orders', { ...body, checkoutId: review.body.review.checkoutId,
        idempotencyKey: id('mobile-order') }).expect(201);
      assert.ok(response.body.order.id, 'mobile create response must identify its committed order');
      const order = await Order.findOne({ publicId: response.body.order.id, userId: buyer._id });
      assert.ok(order);
      const payment = await mobilePost(`/api/v1/mobile/orders/${order.publicId}/payment-intents`, { idempotencyKey: id('mobile-payment') }).expect(201);
      assert.equal(payment.body.payment.status, 'pending_collection');
    });
  } finally {
    try { await mongoose.connection.dropDatabase(); }
    finally { await mongoose.disconnect(); }
  }
});

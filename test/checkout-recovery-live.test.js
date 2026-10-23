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
    LedgerTransaction, FinancialDocument, Shipment, LoyaltyEntry, ShippingZone, Refund, PlatformGrant } = models;
  const { createApp } = await import('../src/app.js');
  const { addLoyaltyPoints } = await import('../src/services/loyalty.js');
  const { redeemCustomerReward } = await import('../src/services/customer-rewards.js');
  const { ensureLedgerAccount, postLedgerTransaction, accountBalanceMinor } = await import('../src/services/money.js');
  const { createRefund } = await import('../src/services/payments.js');
  const { hashToken } = await import('../src/core/crypto.js');
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
  async function serviceRequest(user, requiredOperationalWorkspace) {
    const sessionID = id('session'), device = await Device.create({ publicId: id('dev'), userId: user._id,
      sessionHash: hashToken(sessionID), label: 'Actual checkout test session', ipHash: hashToken('127.0.0.1'),
      userAgent: 'Checkout recovery regression', lastSeenAt: new Date() });
    return { user, device, sessionID, session: { userId: String(user._id), tokenVersion: user.security.tokenVersion },
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
    const body = await reviewed({ paymentMethod: 'wallet', rewardPublicId: issued.publicId });
    const placed = (await post('/api/v1/orders', body).expect(201)).body.order;
    const payment = (await post(`/api/v1/orders/${placed.id}/payment-intents`, { idempotencyKey: id('wallet-payment') }).expect(201)).body.payment;
    const order = await Order.findOne({ publicId: placed.id }).lean(), sellerOrder = await SellerOrder.findOne({ orderId: order._id }).lean();
    return { order, sellerOrder, payment, original: await LedgerTransaction.findOne({ idempotencyKey: `payment:${payment.id}` }).lean() };
  }
  const partialRefund = f => createRefund(financeRequest, { orderId: f.order.publicId, amountMinor: 1001,
    reason: 'Independently reviewed pre-fulfilment line refund', idempotencyKey: id('partial-refund'),
    allocations: [{ storePublicId: f.sellerOrder.storePublicId, orderLineId: f.sellerOrder.items[0].orderLineId, grossMinor: 1001 }] });
  try {
    for (const Model of Object.values(models)) if (Model.init) await Model.init();
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG',
      timeZone: 'Africa/Kampala', phonePrefix: '+256', taxBps: 0, platformFeeBps: 500,
      growth: { loyaltyEnabled: true, referralEnabled: false, loyaltyPointsPer1000Minor: 10,
        rewardCatalogue: [{ key: 'goods', label: 'Reviewed goods voucher', kind: 'voucher', pointsCost: 100, valueMinor: 1999, validDays: 30 }],
        clubBenefits: [{ tier: 'silver', multiplierBps: 20000, standardShippingDiscountBps: 5000 }] } });
    await ShippingZone.create({ publicId: id('zone'), country: 'UG', name: 'Recovery Kampala', cities: ['Kampala'],
      standardFeeMinor: 2000, expressFeeMinor: 4000, currency: 'UGX' });
    owner = await seedActor('seller');
    const reviewerA = await seedActor('moderator'), reviewerB = await seedActor('moderator');
    const store = await Store.create({ publicId: id('sto'), ownerUserId: owner._id, name: 'Recovery supplier',
      slug: id('supplier'), country: 'UG', currency: 'UGX', status: 'verified', verifiedAt: new Date() });
    const warehouse = await Warehouse.create({ publicId: id('wh'), storeId: store._id, ownerUserId: owner._id,
      name: 'Recovery warehouse', country: 'UG', city: 'Kampala', address: 'Warehouse Recovery Road', active: true });
    const category = await Category.create({ publicId: id('cat'), name: 'Reviewed recovery goods', slug: id('category'),
      countries: ['UG'], active: true, restricted: true });
    product = await Product.create({ publicId: id('prd'), storeId: store._id, ownerUserId: owner._id, categoryId: category._id,
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
    await t.test('partial refund followed by cancellation reverses exactly the remaining original tax, shipping, fee, seller and subsidy', async () => {
      await CountrySetting.updateOne({ code: 'UG' }, { $set: { taxBps: 1500 }, $inc: { __v: 1 } });
      const opening = await accountBalanceMinor(wallet._id), f = await fundedPaidOrder();
      assert.ok(f.order.totals.taxMinor > 0);
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

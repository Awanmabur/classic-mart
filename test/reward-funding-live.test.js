import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
test('funded rewards use actual wallet cash, immutable seller economics and exact confirmed refund accounting', { skip: !uri, timeout: 120_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /test|verification/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: 'classicmart_reward_funding_test_' + suffix });
  const models = await import('../src/models/index.js');
  const { User, CountrySetting, PlatformGrant, Device, Store, Warehouse, StockItem, InventoryReservation, Order, SellerOrder,
    PaymentIntent, Refund, LedgerAccount, LedgerTransaction, LoyaltyAccount, LoyaltyEntry, CustomerReward, FinancialDocument } = models;
  const { hashToken } = await import('../src/core/crypto.js');
  const { initiatePayment, createRefund } = await import('../src/services/payments.js');
  const { quoteCheckoutBenefits, allocateRewardGoodsMinor } = await import('../src/services/checkout-benefits.js');
  const { redeemCustomerReward, reserveOrderReward } = await import('../src/services/customer-rewards.js');
  const { addLoyaltyPoints } = await import('../src/services/loyalty.js');
  const { ensureLedgerAccount, postLedgerTransaction, accountBalanceMinor, allocateSellerLineSettlement } = await import('../src/services/money.js');
  let sequence = 0;
  const id = prefix => `${prefix}_${suffix}_${++sequence}`;
  const transaction = async work => { const session = await mongoose.startSession(); try { return await session.withTransaction(() => work(session)); } finally { await session.endSession(); } };
  async function actor(role = 'customer') {
    const publicId = id('usr'), email = publicId + '@example.com', phone = '+2567' + crypto.randomInt(10_000_000, 99_999_999);
    const user = await User.create({ publicId, name: 'Reward ' + role, email, emailNormalized: email, phone, phoneNormalized: phone,
      passwordHash: crypto.randomBytes(32).toString('hex'), role, country: 'UG', currency: 'UGX', emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(),
      onboardingCompletedAt: new Date(), security: { mfaEnabled: role === 'finance' },
      ...(role === 'finance' ? { platformAccessManagedAt: new Date(), operationalCountries: ['UG', 'KE'] } : {}),
      consents: { terms: true, privacy: true, recordedAt: new Date() } });
    if (role === 'finance') await PlatformGrant.create({ publicId: id('pgr'), userId: user._id, role, operationalCountries: ['UG', 'KE'], status: 'active',
      startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000), reason: 'Isolated funded reward verification',
      approvalPublicId: id('approval'), approvedByUserId: new mongoose.Types.ObjectId() });
    const sessionID = id('session');
    const device = await Device.create({ publicId: id('dev'), userId: user._id, sessionHash: hashToken(sessionID), label: 'Isolated reward test',
      userAgent: 'Reward regression', ipHash: hashToken('127.0.0.1'), lastSeenAt: new Date() });
    return { user, device, sessionID, session: { userId: String(user._id), tokenVersion: user.security.tokenVersion, mfaVerifiedAt: Date.now() },
      id: id('request'), ip: '127.0.0.1', query: {}, get: () => '', ...(role === 'finance' ? { requiredOperationalWorkspace: 'finance' } : {}) };
  }
  let finance;
  async function fixture({ country = 'UG', currency = 'UGX', reward = true } = {}) {
    const request = await actor(); request.country = { code: country, currency, name: country === 'UG' ? 'Uganda' : 'Kenya' };
    const owner = (await actor('seller')).user;
    const store = await Store.create({ publicId: id('sto'), ownerUserId: owner._id, name: 'Funded test supplier', slug: id('supplier'), country, currency, status: 'verified', verifiedAt: new Date() });
    const warehouse = await Warehouse.create({ publicId: id('wh'), ownerUserId: owner._id, storeId: store._id, name: 'Funded stock', country, city: 'Kampala', address: '10 Test Road' });
    await transaction(session => addLoyaltyPoints({ userId: request.user._id, country, points: 1000, idempotencyKey: id('seed-points'), type: 'manual_adjustment' }, session));
    const issued = reward ? await redeemCustomerReward({ user: request.user, country, currency, rewardKey: 'goods', idempotencyKey: id('redeem') }) : null;
    const benefits = await quoteCheckoutBenefits({ user: request.user, country, currency, subtotalMinor: 10000, shippingMinor: 2000,
      rewardPublicId: issued?.publicId || '', goodsCashFloorMinor: 3 });
    const expiresAt = new Date(Date.now() + 600_000), orderPublicId = id('ord'), orderId = new mongoose.Types.ObjectId();
    const lines = [];
    for (const [quantity, price] of [[2, 3000], [1, 4000]]) {
      const variantId = new mongoose.Types.ObjectId(), stock = await StockItem.create({ publicId: id('stk'), storeId: store._id, warehouseId: warehouse._id, variantId, onHand: 20, reserved: quantity });
      const reservation = await InventoryReservation.create({ publicId: id('rsv'), idempotencyKey: id('reserve'), storeId: store._id,
        stockItemId: stock._id, variantId, quantity, expiresAt, actorUserId: request.user._id });
      lines.push({ linePublicId: id('line'), productId: new mongoose.Types.ObjectId(), variantId, storeId: store._id,
        reservationPublicId: reservation.publicId, productPublicId: id('prd'), variantPublicId: id('var'), storePublicId: store.publicId,
        title: 'Funded product', variantTitle: 'Standard', sku: id('SKU'), quantity, unitPriceMinor: price, unitCostMinor: 700,
        costSnapshotStatus: 'captured', lineTotalMinor: quantity * price, currency });
    }
    const funding = allocateRewardGoodsMinor(benefits.fundingSnapshot.rewardGoodsMinor, lines);
    const settlement = allocateSellerLineSettlement(lines, { discountMinor: benefits.fundingSnapshot.rewardGoodsMinor,
      lineDiscounts: funding, linePlatformContributions: funding, platformFeeMinor: 500 });
    const shippingMinor = 2000 - benefits.fundingSnapshot.rewardShippingMinor - benefits.fundingSnapshot.clubShippingMinor;
    const totals = { subtotalMinor: 10000, discountMinor: benefits.fundingSnapshot.rewardGoodsMinor, shippingMinor, taxMinor: 0,
      totalMinor: 10000 - benefits.fundingSnapshot.rewardGoodsMinor + shippingMinor, currency };
    const order = await Order.create({ _id: orderId, publicId: orderPublicId, idempotencyKey: id('order-key'), checkoutId: id('checkout'), cartPublicId: id('cart'),
      sessionKey: id('cart-session'), userId: request.user._id, country, paymentMethod: 'wallet', deliveryMethod: 'standard',
      contact: { fullName: request.user.name, email: request.user.email, phone: request.user.phone, address: '10 Test Road', city: 'Kampala', country },
      totals, items: lines, fundingSnapshot: benefits.fundingSnapshot, loyaltySnapshot: benefits.loyaltySnapshot, reservationExpiresAt: expiresAt });
    const sellerOrder = await SellerOrder.create({ publicId: id('sord'), orderId, orderPublicId, storeId: store._id, storePublicId: store.publicId,
      country, currency, subtotalMinor: 10000, discountMinor: totals.discountMinor, shippingMinor, platformFeeMinor: 500,
      items: settlement.map(line => ({ ...line, orderLineId: line.linePublicId })) });
    await transaction(session => reserveOrderReward(order, session));
    let wallet;
    await transaction(async session => {
      const clearing = await ensureLedgerAccount({ code: 'provider_clearing', type: 'asset', ownerType: 'provider', ownerPublicId: 'pesapal', country, currency }, session);
      wallet = await ensureLedgerAccount({ code: 'customer_wallet', type: 'liability', ownerType: 'customer', ownerId: request.user._id,
        ownerPublicId: request.user.publicId, country, currency }, session);
      await postLedgerTransaction({ idempotencyKey: id('wallet-seed'), referenceType: 'wallet_topup', referencePublicId: id('wtu'), country, currency,
        description: 'Isolated verified wallet funding', entries: [{ account: clearing, debitMinor: 20000, creditMinor: 0 }, { account: wallet, debitMinor: 0, creditMinor: 20000 }] }, session);
    });
    const paymentKey = id('payment-key');
    return { request, order, sellerOrder, wallet, issued, pay: () => initiatePayment(request, { orderId: order.publicId, idempotencyKey: paymentKey }) };
  }
  const net = transactions => {
    const values = new Map();
    for (const tx of transactions) for (const row of tx.entries) values.set(String(row.accountId), (values.get(String(row.accountId)) || 0) + row.debitMinor - row.creditMinor);
    return [...values.values()];
  };
  try {
    for (const Model of Object.values(models)) if (Model.init) await Model.init();
    for (const [code, currency, name, locale, timeZone, phonePrefix] of [['UG', 'UGX', 'Uganda', 'en-UG', 'Africa/Kampala', '+256'], ['KE', 'KES', 'Kenya', 'en-KE', 'Africa/Nairobi', '+254']]) {
      await CountrySetting.create({ code, currency, name, locale, timeZone, phonePrefix, growth: { referralEnabled: false, loyaltyEnabled: true, loyaltyPointsPer1000Minor: 10,
        rewardCatalogue: [{ key: 'goods', label: 'Reviewed goods voucher', kind: 'voucher', pointsCost: 100, valueMinor: 1999, validDays: 30 }],
        clubBenefits: [{ tier: 'silver', multiplierBps: 20000, standardShippingDiscountBps: 5000 }] } });
    }
    finance = await actor('finance');
    await t.test('only actual cash is debited; expense funds goods and shipping and full refund reverses every original account', async () => {
      const f = await fixture(), payment = await f.pay();
      assert.equal(payment.status, 'succeeded');
      const original = await LedgerTransaction.findOne({ idempotencyKey: 'payment:' + payment.id }).lean();
      const walletEntry = original.entries.find(row => String(row.accountId) === String(f.wallet._id));
      assert.equal(walletEntry.debitMinor, f.order.totals.totalMinor);
      assert.equal(await accountBalanceMinor(f.wallet._id), 20000 - f.order.totals.totalMinor);
      const expense = await LedgerAccount.findOne({ code: 'platform_rewards_expense', country: 'UG', currency: 'UGX' });
      assert.equal(original.entries.find(row => String(row.accountId) === String(expense._id)).debitMinor, 2999);
      assert.equal((await CustomerReward.findById(f.issued._id)).status, 'used');
      assert.equal((await LoyaltyEntry.findOne({ idempotencyKey: `order:${f.order.publicId}:loyalty` })).earnedPoints, 160);
      const input = { orderId: f.order.publicId, reason: 'Independently reviewed full refund', idempotencyKey: id('refund-key') };
      const refunded = await createRefund(finance, input);
      assert.equal(refunded.status, 'completed');
      const reverse = await LedgerTransaction.findOne({ idempotencyKey: 'refund:' + refunded.publicId }).lean();
      assert.ok(net([original, reverse]).every(value => value === 0));
      assert.equal(await accountBalanceMinor(f.wallet._id), 20000);
      assert.equal((await CustomerReward.findById(f.issued._id)).status, 'issued');
      assert.equal((await LoyaltyAccount.findOne({ userId: f.request.user._id, country: 'UG' })).points, 900);
      assert.equal(await FinancialDocument.countDocuments({ refundPublicId: refunded.publicId, type: 'refund_credit_note' }), 1);
      await createRefund(finance, input);
      assert.equal(await LedgerTransaction.countDocuments({ idempotencyKey: 'refund:' + refunded.publicId }), 1);
    });
    await t.test('later loyalty debt does not block reconciliation of an already reserved reward order', async () => {
      const f = await fixture();
      await LoyaltyAccount.updateOne({ userId: f.request.user._id, country: 'UG' }, { $set: { points: 0, reversalDebtPoints: 500 } });
      const payment = await f.pay();
      assert.equal(payment.status, 'succeeded');
      assert.equal((await CustomerReward.findById(f.issued._id)).status, 'used');
      assert.equal(await accountBalanceMinor(f.wallet._id), 20000 - f.order.totals.totalMinor);
      assert.equal((await LoyaltyAccount.findOne({ userId: f.request.user._id, country: 'UG' })).reversalDebtPoints, 340);
    });
    await t.test('sequential small partial refunds reverse original subsidy and fee rounding without restoring consumed shipping benefits', async () => {
      const f = await fixture(), payment = await f.pay(), line = f.sellerOrder.items[0];
      const requestRefund = amount => createRefund(finance, { orderId: f.order.publicId, amountMinor: amount, reason: 'Reviewed funded item refund',
        idempotencyKey: id('partial-refund'), allocations: [{ storePublicId: f.sellerOrder.storePublicId, orderLineId: line.orderLineId, grossMinor: amount }] });
      const first = await requestRefund(1), second = await requestRefund(line.customerPaidMinor - 1);
      assert.equal(first.allocations[0].sourceCashOffsetMinor, 0);
      assert.equal(second.allocations[0].sourceCashOffsetMinor, 1);
      for (const field of ['platformContributionMinor', 'platformFeeMinor', 'sellerReceivableMinor']) assert.equal(first.allocations[0][field] + second.allocations[0][field], line[field]);
      assert.equal((await CustomerReward.findById(f.issued._id)).status, 'used');
      const intent = await PaymentIntent.findOne({ publicId: payment.id });
      assert.equal(intent.refundedMinor, line.customerPaidMinor); assert.equal(intent.refundReservedMinor, 0);
      await assert.rejects(requestRefund(1), error => error.code === 'REFUND_ALLOCATION_EXHAUSTED');
    });
    await t.test('the selected market wallet is used even when the customer home market differs', async () => {
      const f = await fixture({ country: 'KE', currency: 'KES', reward: false });
      assert.equal(f.request.user.country, 'UG');
      await f.pay();
      assert.equal(await accountBalanceMinor(f.wallet._id), 20000 - f.order.totals.totalMinor);
      assert.equal(await LedgerAccount.countDocuments({ code: 'customer_wallet', ownerPublicId: f.request.user.publicId, country: 'UG' }), 0);
    });
    await t.test('revoked sessions and corrupt subsidy snapshots cannot debit cash or commit reserved stock', async () => {
      const revoked = await fixture(); await Device.updateOne({ _id: revoked.request.device._id }, { $set: { revokedAt: new Date() } });
      await assert.rejects(revoked.pay(), error => error.code === 'ACCOUNT_UNAVAILABLE');
      assert.equal(await accountBalanceMinor(revoked.wallet._id), 20000);
      assert.equal(await LedgerTransaction.countDocuments({ referenceType: 'payment', referencePublicId: { $in: (await PaymentIntent.find({ orderId: revoked.order._id }).lean()).map(row => row.publicId) } }), 0);
      const corrupt = await fixture();
      // Deliberately corrupt persisted storage; ordinary model updates correctly
      // protect this immutable settlement field and cannot inject this failure.
      const changed = await SellerOrder.collection.updateOne({ _id: corrupt.sellerOrder._id }, { $inc: { 'items.0.platformContributionMinor': 1 } });
      assert.equal(changed.modifiedCount, 1);
      await assert.rejects(corrupt.pay(), error => ['ORDER_FUNDING_INVALID', 'ORDER_FUNDING_UNBALANCED', 'SELLER_SETTLEMENT_SNAPSHOT_MISSING'].includes(error.code));
      assert.equal(await accountBalanceMinor(corrupt.wallet._id), 20000);
      assert.equal(await InventoryReservation.countDocuments({ publicId: { $in: corrupt.order.items.map(row => row.reservationPublicId) }, status: 'active' }), 2);
    });
    await t.test('reversal debt blocks new rewards and trial benefits while a normal purchase can repay it', async () => {
      const request = await actor();
      await LoyaltyAccount.create({ publicId: id('loy'), userId: request.user._id, country: 'UG', lifetimeEarned: 6000, points: 2000, reversalDebtPoints: 400, tier: 'gold' });
      const quote = await quoteCheckoutBenefits({ user: request.user, country: 'UG', currency: 'UGX', subtotalMinor: 10000, shippingMinor: 2000 });
      assert.equal(quote.fundingSnapshot.totalMinor, 0); assert.equal(quote.loyaltySnapshot.multiplierBps, 10000);
      assert.equal(quote.loyaltySnapshot.enabled, true); assert.equal(quote.benefitsPaused, true);
      await assert.rejects(redeemCustomerReward({ user: request.user, country: 'UG', currency: 'UGX', rewardKey: 'goods', idempotencyKey: id('debt-redeem') }), error => error.code === 'LOYALTY_REVERSAL_DEBT');
      await assert.rejects(quoteCheckoutBenefits({ user: request.user, country: 'UG', currency: 'UGX', subtotalMinor: 10000, shippingMinor: 2000, rewardPublicId: id('rwd') }), error => error.code === 'LOYALTY_REVERSAL_DEBT');
      assert.equal(await CustomerReward.countDocuments({ userId: request.user._id }), 0);
    });
  } finally {
    t.mock.restoreAll(); try { await mongoose.connection.dropDatabase(); } finally { await mongoose.disconnect(); }
  }
});

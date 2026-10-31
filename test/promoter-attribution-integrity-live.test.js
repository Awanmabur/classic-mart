import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
for (const name of ['SESSION_SECRET', 'TOKEN_PEPPER', 'SECURITY_INTEGRITY_KEY', 'DATA_ENCRYPTION_KEY']) process.env[name] = crypto.randomBytes(32).toString('hex');
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;

test('Promoter attribution binds real journeys, current eligibility and commission accounting', { skip: !uri, timeout: 180000 }, async t => {
  const endpoint = new URL(uri);
  assert.equal(endpoint.hostname, '127.0.0.1');
  assert.match(endpoint.pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: `classicmart_promoter_attribution_test_${suffix}` });
  const models = await import('../src/models/index.js');
  const { Device, PlatformGrant, User, Store, StoreMember, CountrySetting, Campaign, CampaignApplication, PromoterVerification, PromoterLink,
    AttributionTouch, CommissionEntry, Order, Refund, LedgerTransaction, AuditLog, Category, Product, ProductVariant, Warehouse, StockItem, ShippingZone, InventoryReservation } = models;
  const { recordTouch, redeemPromoterCoupon, attributeOrder, makeOrderCommissionsPayable, reverseOrderCommissions, settlePromoterCommissions,
    appealCommissionReversal, reviewCommissionAppeal } = await import('../src/services/promoters.js');
  const { ensureLedgerAccount, accountBalanceMinor } = await import('../src/services/money.js');
  const { hashPassword, hashToken } = await import('../src/core/crypto.js');
  const { marketplacePromoterCampaignPublicId } = await import('../src/services/seller-growth.js');
  const campaignOperations = await import('../src/services/promoters.js');
  const { beginMfaEnrollment, confirmMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
  let sequence = 0;
  const id = prefix => `${prefix}_pa_${suffix}_${++sequence}`;
  const transports = [];
  async function actor(role) {
    const publicId = id('usr'), email = publicId + '@example.com', phone = '+25670' + String(sequence).padStart(7, '0');
    const operational = ['seller', 'country_admin'].includes(role), password = `Attribution-actor-${suffix}-A1!`;
    let user = await User.create({ publicId, name: `Attribution ${role}`, email, emailNormalized: email, phone, phoneNormalized: phone,
      passwordHash: operational ? await hashPassword(password) : crypto.randomBytes(32).toString('hex'), role: role === 'country_admin' ? 'customer' : role,
      country: 'UG', currency: 'UGX', emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
      ...(role === 'country_admin' ? { platformAccessManagedAt: new Date(), operationalCountries: ['UG'] } : {}),
      consents: { terms: true, privacy: true, recordedAt: new Date() } });
    if (role === 'country_admin') await PlatformGrant.create({ publicId: id('pgr'), userId: user._id, role, operationalCountries: ['UG'], status: 'active',
      startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000), reason: 'Independent scoped campaign reviewer fixture',
      approvalPublicId: id('apr'), approvedByUserId: new mongoose.Types.ObjectId() });
    if (operational) {
      const enrollment = await beginMfaEnrollment(user._id, password);
      await confirmMfaEnrollment(user._id, totpCode(enrollment.secret));
      user = await User.findById(user._id);
    }
    return user;
  }
  const shoppingRequest = (user = null, session = {}) => ({ id: id('req'), user, country: { code: 'UG', currency: 'UGX' }, session,
    ip: '127.0.0.' + (sequence % 200 + 20), get: name => name === 'user-agent' ? 'ClassicMartAttributionTest/1.0' : 'https://example.com/' });
  async function currentRequest(actor, selectedStore = null) {
    const current = await User.findById(actor._id), sessionID = crypto.randomUUID();
    const device = await Device.create({ publicId: id('dev'), userId: current._id, sessionHash: hashToken(sessionID),
      label: 'Current attribution campaign fixture', userAgent: 'Attribution fixture', ipHash: hashToken('127.0.0.1'), lastSeenAt: new Date() });
    return { ...shoppingRequest(current), device, sessionID, store: selectedStore, session: { userId: String(current._id), tokenVersion: current.security.tokenVersion,
      activeStorePublicId: selectedStore?.publicId, mfaVerifiedAt: Date.now() } };
  }
  let promoter, buyer, store, product, variant, campaign, application, verification, link;
  async function pendingOrder(req, { items = null, country = 'UG', currency = 'UGX' } = {}) {
    const selected = items || [line(product, variant, store, 10000)];
    const totalMinor = selected.reduce((sum, row) => sum + row.lineTotalMinor, 0);
    return Order.create({ publicId: id('ord'), idempotencyKey: id('order_key'), checkoutId: id('checkout'), cartPublicId: id('cart'),
      sessionKey: req.user ? `account:${req.user._id}:${country}` : req.session.cartKey, userId: req.user?._id, country,
      deliveryMethod: 'standard', paymentMethod: 'cod', reservationExpiresAt: new Date(Date.now() + 600000),
      contact: { fullName: 'Attribution buyer', email: 'buyer@example.com', phone: '+256700000001', address: '10 Test Road', city: 'Kampala', country: 'Uganda' },
      totals: { subtotalMinor: totalMinor, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor, currency }, items: selected });
  }
  function line(selectedProduct, selectedVariant, selectedStore, amount, currency = 'UGX') {
    return { linePublicId: id('line'), productId: selectedProduct._id, variantId: selectedVariant._id, storeId: selectedStore._id,
      reservationPublicId: id('rsv'), productPublicId: selectedProduct.publicId, variantPublicId: selectedVariant.publicId, storePublicId: selectedStore.publicId,
      title: 'Attribution item', variantTitle: 'Standard', sku: 'ATTRIBUTION-SKU', quantity: 1, unitPriceMinor: amount, lineTotalMinor: amount, currency };
  }
  const commissionFor = order => CommissionEntry.findOne({ orderId: order._id });
  async function convertedOrder(options = {}) {
    const req = shoppingRequest(await actor('customer')), visit = await recordTouch(req, link.token), order = await pendingOrder(req, options);
    await attributeOrder(req, order.publicId);
    return { req, visit, order, commission: await commissionFor(order) };
  }
  async function refundFor(order, amountMinor, { allocated = true, productId = product.publicId, storeId = store.publicId } = {}) {
    return Refund.create({ publicId: id('ref'), idempotencyKey: id('refund_key'), orderId: order._id, paymentIntentId: new mongoose.Types.ObjectId(),
      amountMinor, currency: order.totals.currency, reason: 'Verified fixture refund', status: 'completed', completedAt: new Date(),
      allocations: allocated ? [{ productPublicId: productId, storePublicId: storeId, grossMinor: amountMinor }] : [] });
  }
  async function balance() {
    const account = await ensureLedgerAccount({ code: 'promoter_payable', type: 'liability', ownerType: 'promoter', ownerId: promoter._id,
      ownerPublicId: String(promoter._id), country: 'UG', currency: 'UGX' });
    return accountBalanceMinor(account._id);
  }
  try {
    await Promise.all(Object.values(mongoose.models).map(Model => Model.init()));
    await CountrySetting.create([{ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', growth: { promoterCommissionBps: 300 } },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254' },
      { code: 'GH', name: 'Same-currency isolation fixture', currency: 'UGX', locale: 'en-GH', timeZone: 'Africa/Accra', phonePrefix: '+233' }]);
    promoter = await actor('promoter'); buyer = await actor('customer');
    const seller = await actor('seller');
    store = await Store.create({ publicId: id('sto'), ownerUserId: seller._id, name: 'Attribution seller', slug: id('store'), country: 'UG', currency: 'UGX', status: 'verified' });
    await StoreMember.create({ publicId: id('stm'), storeId: store._id, userId: seller._id, role: 'owner', status: 'active', acceptedAt: new Date(), invitedByUserId: seller._id });
    const reviewer = await actor('country_admin');
    const category = await Category.create({ publicId: id('cat'), name: 'Attribution products', slug: id('category'), countries: ['UG'], active: true });
    product = await Product.create({ publicId: id('prd'), storeId: store._id, ownerUserId: seller._id, categoryId: category._id,
      title: 'Attribution product', slug: id('product'), description: 'A real published product used for attribution verification.', countries: ['UG'], status: 'published' });
    variant = await ProductVariant.create({ publicId: id('var'), productId: product._id, storeId: store._id, sku: 'ATTRIBUTION', title: 'Standard', currency: 'UGX', priceMinor: 10000, active: true });
    verification = await PromoterVerification.create({ publicId: id('prv'), userId: promoter._id, country: 'UG', status: 'verified' });
    campaign = await Campaign.create({ publicId: marketplacePromoterCampaignPublicId('UG'), scope: 'marketplace', systemManaged: true, country: 'UG', name: 'Marketplace test programme', status: 'active', commissionBps: 300, attributionDays: 30 });
    application = await CampaignApplication.create({ publicId: id('cap'), campaignId: campaign._id, campaignPublicId: campaign.publicId, promoterUserId: promoter._id, country: 'UG', status: 'approved' });
    link = await PromoterLink.create({ publicId: id('plk'), campaignId: campaign._id, promoterUserId: promoter._id, token: crypto.randomBytes(18).toString('base64url'), destination: '/products', couponCode: 'TRACK_' + suffix.toUpperCase() });

    await t.test('public links and coupons recheck account, programme, campaign, application and local destination', async () => {
      const checks = [
        [PromoterVerification, verification._id, { status: 'rejected' }, { status: 'verified' }],
        [CampaignApplication, application._id, { status: 'revoked' }, { status: 'approved' }],
        [Campaign, campaign._id, { endsAt: new Date(Date.now() - 1000) }, { endsAt: null }],
        [Campaign, campaign._id, { startsAt: new Date(Date.now() + 60000) }, { startsAt: null }],
        [User, promoter._id, { role: 'customer' }, { role: 'promoter' }],
        [User, promoter._id, { platformAccessManagedAt: new Date() }, { platformAccessManagedAt: null }],
        [User, promoter._id, { status: 'suspended' }, { status: 'active' }],
        [CountrySetting, (await CountrySetting.findOne({ code: 'UG' }))._id, { active: false }, { active: true }],
        [PromoterLink, link._id, { destination: '//evil.example.com' }, { destination: '/products' }],
      ];
      for (const [Model, _id, revoke, restore] of checks) {
        await Model.updateOne({ _id }, { $set: revoke });
        const req = shoppingRequest();
        await assert.rejects(recordTouch(req, link.token));
        await assert.rejects(redeemPromoterCoupon(req, link.couponCode));
        assert.equal(await AttributionTouch.countDocuments({ sessionKey: req.session.cartKey }), 0);
        await Model.updateOne({ _id }, { $set: restore });
      }
      const foreign = shoppingRequest(); foreign.country = { code: 'KE', currency: 'KES' };
      await assert.rejects(recordTouch(foreign, link.token), error => error.code === 'COUNTRY_SCOPE');
      await assert.rejects(recordTouch(shoppingRequest(), { $ne: '' }));
    });

    await t.test('a repeated landing is counted once and self referral is blocked', async () => {
      const req = shoppingRequest();
      const first = await recordTouch(req, link.token), second = await recordTouch(req, link.token);
      assert.equal(first.touch.publicId, second.touch.publicId);
      assert.equal(await AttributionTouch.countDocuments({ sessionKey: req.session.cartKey }), 1);
      const self = await recordTouch(shoppingRequest(promoter), link.token);
      assert.equal(self.touch.status, 'blocked'); assert.equal(self.touch.blockReason, 'self_referral');
    });

    await t.test('product links recheck current product, merchant, category and offer approvals', async () => {
      const created = await campaignOperations.createCampaign(await currentRequest(seller, store), { name: 'Approved seller promotion', visibility: 'public',
        commissionBps: 500, attributionDays: 30, allowedChannels: ['whatsapp'], productPublicIds: [product.publicId],
        facts: ['Approved product details'], disclosureText: 'Sponsored Seller affiliate link.' });
      let sellerCampaign = await Campaign.findOne({ publicId: created.publicId });
      await campaignOperations.submitCampaign(await currentRequest(seller, store), sellerCampaign.publicId, { version: sellerCampaign.__v });
      sellerCampaign = await Campaign.findById(sellerCampaign._id);
      await campaignOperations.reviewCampaign(await currentRequest(reviewer), sellerCampaign.publicId, { version: sellerCampaign.__v, decision: 'approve', reason: 'Independent review of this exact store campaign.' });
      let applied = await campaignOperations.applyToCampaign(await currentRequest(promoter), sellerCampaign.publicId, 'Independent audience application.');
      assert.equal(applied.status, 'pending');
      await campaignOperations.reviewCampaignApplication(await currentRequest(seller, store), applied.publicId, { version: applied.__v, decision: 'approve', reason: 'Seller verified the independent promoter audience.' });
      applied = await CampaignApplication.findById(applied._id);
      assert.equal(String(applied.reviewedByUserId), String(seller._id));
      const productLink = await campaignOperations.createPromoterLink(await currentRequest(promoter), { campaignId: sellerCampaign.publicId,
        destination: '/products/' + product.publicId, channel: 'whatsapp' });
      assert.equal((await recordTouch(shoppingRequest(), productLink.token)).touch.status, 'valid');
      for (const [Model, _id, revoke, restore] of [[Product, product._id, { status: 'archived' }, { status: 'published' }],
        [Store, store._id, { status: 'suspended' }, { status: 'verified' }], [Category, category._id, { active: false }, { active: true }],
        [ProductVariant, variant._id, { active: false }, { active: true }], [Campaign, sellerCampaign._id, { allowedChannels: ['youtube'] }, { allowedChannels: ['whatsapp'] }]]) {
        await Model.updateOne({ _id }, { $set: revoke }); await assert.rejects(recordTouch(shoppingRequest(), productLink.token));
        await Model.updateOne({ _id }, { $set: restore });
      }
    });

    await t.test('a copied touch cannot be attributed by a different browser or another account', async () => {
      const original = shoppingRequest(), visit = await recordTouch(original, link.token);
      const thief = shoppingRequest(); thief.session.cartKey = id('other_session'); thief.session.promoterTouchId = visit.touch.publicId;
      const stolen = await pendingOrder(thief);
      assert.equal(await attributeOrder(thief, stolen.publicId), undefined); assert.equal(await commissionFor(stolen), null);
      const customerReq = shoppingRequest(buyer); await recordTouch(customerReq, link.token);
      const otherUser = await actor('customer'), foreignReq = shoppingRequest(otherUser, customerReq.session);
      const own = await pendingOrder(customerReq);
      assert.equal(await attributeOrder(foreignReq, own.publicId), undefined); assert.equal(await commissionFor(own), null);
      assert.equal((await AttributionTouch.findById(visit.touch._id)).status, 'valid');
    });

    await t.test('the server-owned guest journey survives login while a copied touch ID does not', async () => {
      const req = shoppingRequest(), visit = await recordTouch(req, link.token);
      req.user = buyer; req.session.cartKey = `account:${buyer._id}:UG`;
      // Checkout clears cartMergeKey; the attribution continuity key is separate.
      delete req.session.cartMergeKey;
      const order = await pendingOrder(req); await attributeOrder(req, order.publicId);
      assert.ok(await commissionFor(order)); assert.equal((await AttributionTouch.findById(visit.touch._id)).sessionKey, req.session.cartKey);
    });

    await t.test('revocation after a landing prevents checkout commission and conversion', async () => {
      for (const [Model, _id, revoke, restore] of [[PromoterVerification, verification._id, { status: 'rejected' }, { status: 'verified' }],
        [CampaignApplication, application._id, { status: 'revoked' }, { status: 'approved' }], [PromoterLink, link._id, { active: false }, { active: true }]]) {
        const req = shoppingRequest(await actor('customer')), visit = await recordTouch(req, link.token), order = await pendingOrder(req);
        await Model.updateOne({ _id }, { $set: revoke }); await attributeOrder(req, order.publicId);
        assert.equal(await commissionFor(order), null); assert.equal((await AttributionTouch.findById(visit.touch._id)).status, 'valid');
        await Model.updateOne({ _id }, { $set: restore });
      }
    });

    await t.test('expired visits and cancelled orders cannot become conversions', async () => {
      const expiredReq = shoppingRequest(await actor('customer')), expired = await recordTouch(expiredReq, link.token), order = await pendingOrder(expiredReq);
      await AttributionTouch.updateOne({ _id: expired.touch._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      await attributeOrder(expiredReq, order.publicId); assert.equal(await commissionFor(order), null);
      const req = shoppingRequest(await actor('customer')), visit = await recordTouch(req, link.token), cancelled = await pendingOrder(req);
      cancelled.status = 'cancelled'; await cancelled.save(); await attributeOrder(req, cancelled.publicId);
      assert.equal(await commissionFor(cancelled), null); assert.equal((await AttributionTouch.findById(visit.touch._id)).status, 'valid');
    });

    await t.test('same-product lines aggregate correctly and preserve the recorded commission policy', async () => {
      const req = shoppingRequest(await actor('customer')), visit = await recordTouch(req, link.token);
      const order = await pendingOrder(req, { items: [line(product, variant, store, 333), line(product, variant, store, 333)] });
      await Campaign.updateOne({ _id: campaign._id }, { $set: { commissionBps: 900 } });
      await CountrySetting.updateOne({ code: 'UG' }, { $set: { 'growth.promoterCommissionBps': 900 } });
      await attributeOrder(req, order.publicId); await attributeOrder(req, order.publicId);
      const rows = await CommissionEntry.find({ orderId: order._id });
      assert.equal(rows.length, 1); assert.equal(rows[0].amountMinor, 19); assert.equal(rows[0].commissionBps, 300);
      assert.equal((await AttributionTouch.findById(visit.touch._id)).status, 'converted');
      await Campaign.updateOne({ _id: campaign._id }, { $set: { commissionBps: 300 } });
      await CountrySetting.updateOne({ code: 'UG' }, { $set: { 'growth.promoterCommissionBps': 300 } });
    });

    await t.test('own-store, mismatched currency and zero-rate orders leave the touch unconverted', async () => {
      const ownStore = await Store.create({ publicId: id('sto'), ownerUserId: promoter._id, name: 'Own store', slug: id('own_store'), country: 'UG', currency: 'UGX', status: 'verified' });
      for (const options of [{ items: [line(product, variant, ownStore, 10000)] }, { currency: 'KES', items: [line(product, variant, store, 10000, 'KES')] }]) {
        const f = await convertedOrder(options); assert.equal(f.commission, null);
        assert.equal((await AttributionTouch.findById(f.visit.touch._id)).status, 'valid');
      }
      const member = await StoreMember.create({ publicId: id('stm'), storeId: store._id, userId: promoter._id, invitedByUserId: store.ownerUserId, role: 'catalogue', status: 'active' });
      const staffed = await convertedOrder(); assert.equal(staffed.commission, null); assert.equal((await AttributionTouch.findById(staffed.visit.touch._id)).status, 'valid');
      await StoreMember.updateOne({ _id: member._id }, { $set: { status: 'revoked' } });
      const req = shoppingRequest(await actor('customer')), visit = await recordTouch(req, link.token);
      await AttributionTouch.updateOne({ _id: visit.touch._id }, { $set: { commissionBps: 0 } });
      const order = await pendingOrder(req); await attributeOrder(req, order.publicId);
      assert.equal(await commissionFor(order), null); assert.equal((await AttributionTouch.findById(visit.touch._id)).status, 'valid');
    });

    await t.test('failed transactional audit leaves no visit or commission', async () => {
      const req = shoppingRequest(); t.mock.method(AuditLog, 'create', async () => { throw new Error('Audit sink unavailable'); });
      await assert.rejects(recordTouch(req, link.token), /Audit sink unavailable/); t.mock.restoreAll();
      assert.equal(await AttributionTouch.countDocuments({ sessionKey: req.session.cartKey }), 0);
      const buyerReq = shoppingRequest(await actor('customer')), visit = await recordTouch(buyerReq, link.token), order = await pendingOrder(buyerReq);
      t.mock.method(AuditLog, 'create', async () => { throw new Error('Audit sink unavailable'); });
      await assert.rejects(attributeOrder(buyerReq, order.publicId), /Audit sink unavailable/); t.mock.restoreAll();
      assert.equal(await commissionFor(order), null); assert.equal((await AttributionTouch.findById(visit.touch._id)).status, 'valid');
    });

    await t.test('pre-payment partial refunds stay estimates and only their remaining net becomes payable once', async () => {
      const f = await convertedOrder(), refund = await refundFor(f.order, 4000), before = await balance();
      await reverseOrderCommissions(f.order, refund); await reverseOrderCommissions(f.order, refund);
      let row = await CommissionEntry.findById(f.commission._id);
      assert.equal(row.reversedAmountMinor, 120); assert.equal(row.payableAt, undefined); assert.equal(await balance(), before);
      await makeOrderCommissionsPayable(f.order); assert.equal(await balance(), before);
      f.order.paymentState = 'partially_refunded';
      await makeOrderCommissionsPayable(f.order); await makeOrderCommissionsPayable(f.order);
      row = await CommissionEntry.findById(row._id); assert.ok(row.payableAt); assert.equal(row.status, 'partially_reversed');
      assert.equal(await balance(), before + 180); assert.equal(await LedgerTransaction.countDocuments({ idempotencyKey: `commission:${row.publicId}` }), 1);
    });

    await t.test('completed cumulative refunds reverse only their product and replay without another debit', async () => {
      const f = await convertedOrder(), before = await balance(); f.order.paymentState = 'paid'; await makeOrderCommissionsPayable(f.order);
      const first = await refundFor(f.order, 3333); await reverseOrderCommissions(f.order, first); await reverseOrderCommissions(f.order, first);
      assert.equal((await commissionFor(f.order)).reversedAmountMinor, 99); assert.equal(await balance(), before + 201);
      const second = await refundFor(f.order, 6667); await reverseOrderCommissions(f.order, second); await reverseOrderCommissions(f.order, first);
      assert.equal((await commissionFor(f.order)).status, 'reversed'); assert.equal(await balance(), before);
      assert.equal(await LedgerTransaction.countDocuments({ referenceType: 'commission_reversal', referencePublicId: f.commission.publicId }), 2);
    });

    await t.test('legacy allocation-free refunds are cumulative and idempotent', async () => {
      const f = await convertedOrder(), before = await balance(); f.order.paymentState = 'paid'; await makeOrderCommissionsPayable(f.order);
      const first = await refundFor(f.order, 2000, { allocated: false }); await reverseOrderCommissions(f.order, first); await reverseOrderCommissions(f.order, first);
      assert.equal((await commissionFor(f.order)).reversedAmountMinor, 60);
      const second = await refundFor(f.order, 8000, { allocated: false }); await reverseOrderCommissions(f.order, second); await reverseOrderCommissions(f.order, second);
      assert.equal((await commissionFor(f.order)).reversedAmountMinor, 300); assert.equal(await balance(), before);
    });

    await t.test('accepted appeals preserve their refund baseline when another refund completes', async () => {
      const { beginMfaEnrollment, confirmMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
      const finance = await actor('finance'), password = `Finance-${suffix}-A1!`;
      finance.passwordHash = await hashPassword(password); await finance.save();
      const enrollment = await beginMfaEnrollment(finance._id, password), confirmed = await confirmMfaEnrollment(finance._id, totpCode(enrollment.secret));
      const financeRequest = shoppingRequest(confirmed.user, { tokenVersion: confirmed.user.security.tokenVersion });
      for (const posted of [false, true]) {
        const f = await convertedOrder(), before = await balance();
        if (posted) { f.order.paymentState = 'paid'; await makeOrderCommissionsPayable(f.order); }
        const first = await refundFor(f.order, 4000); await reverseOrderCommissions(f.order, first);
        if (!posted) await CommissionEntry.collection.updateOne({ _id: f.commission._id }, { $unset: { refundedCommissionMinor: '' } });
        await appealCommissionReversal(shoppingRequest(promoter, { tokenVersion: promoter.security.tokenVersion }), f.commission.publicId, 'The documented promotion qualifies for an approved refund exception.');
        await reviewCommissionAppeal(financeRequest, f.commission.publicId, { decision: 'accept', reason: 'Approved documented exception for the prior partial refund.' });
        let row = await commissionFor(f.order);
        assert.equal(row.refundedCommissionMinor, 120); assert.equal(row.reversedAmountMinor, 0);
        assert.equal(await balance(), before + (posted ? 300 : 0));
        await reverseOrderCommissions(f.order, first); assert.equal((await commissionFor(f.order)).reversedAmountMinor, 0);
        const second = await refundFor(f.order, 2000); await reverseOrderCommissions(f.order, second); await reverseOrderCommissions(f.order, second);
        row = await commissionFor(f.order); assert.equal(row.refundedCommissionMinor, 180); assert.equal(row.reversedAmountMinor, 60);
        assert.equal(await balance(), before + (posted ? 240 : 0));
        if (!posted) { f.order.paymentState = 'partially_refunded'; await makeOrderCommissionsPayable(f.order); assert.equal(await balance(), before + 240); }
      }
    });

    await t.test('settlement pays only posted commissions for the payout country and currency', async () => {
      const f = await convertedOrder(); f.order.paymentState = 'paid'; await makeOrderCommissionsPayable(f.order);
      const foreignOrder = await pendingOrder(shoppingRequest(buyer), { country: 'GH', currency: 'UGX' });
      const foreignCampaign = await Campaign.create({ publicId: marketplacePromoterCampaignPublicId('GH'), scope: 'marketplace', systemManaged: true, country: 'GH', name: 'Foreign market', status: 'active', commissionBps: 300 });
      const foreign = await CommissionEntry.create({ publicId: id('com'), orderId: foreignOrder._id, orderPublicId: foreignOrder.publicId,
        campaignId: foreignCampaign._id, promoterUserId: promoter._id, touchId: f.visit.touch._id, storePublicId: store.publicId, productPublicId: product.publicId,
        amountMinor: 50000, currency: 'UGX', commissionBps: 300, policyVersion: 'fixture', status: 'payable', payableAt: new Date(0) });
      const estimate = await convertedOrder(); await CommissionEntry.updateOne({ _id: estimate.commission._id }, { $set: { status: 'partially_reversed', reversedAmountMinor: 1 } });
      await assert.rejects(settlePromoterCommissions(promoter._id, 1.5, null, { country: 'UG', currency: 'UGX' }));
      const result = await settlePromoterCommissions(promoter._id, 100, null, { country: 'UG', currency: 'UGX' });
      assert.equal(result.appliedMinor, 100); assert.equal((await CommissionEntry.findById(foreign._id)).paidAmountMinor, 0);
      assert.equal((await CommissionEntry.findById(estimate.commission._id)).paidAmountMinor, 0);
      const noCurrency = await settlePromoterCommissions(promoter._id, 100, null, { country: 'UG', currency: 'KES' });
      assert.equal(noCurrency.appliedMinor, 0); assert.equal(noCurrency.unappliedMinor, 100);
    });

    await t.test('real guest landing, login, cart merge and checkout create exactly one pending commission', async () => {
      const { createApp } = await import('../src/app.js');
      const password = `Attribution-${suffix}-A1!`; buyer.passwordHash = await hashPassword(password); await buyer.save();
      const warehouse = await Warehouse.create({ publicId: id('wh'), storeId: store._id, ownerUserId: store.ownerUserId,
        name: 'Attribution warehouse', country: 'UG', city: 'Kampala', address: 'Test Road', active: true });
      await StockItem.create({ publicId: id('stk'), storeId: store._id, warehouseId: warehouse._id, variantId: variant._id, onHand: 20, reserved: 0 });
      await ShippingZone.create({ publicId: id('zone'), country: 'UG', name: 'Kampala attribution', cities: ['Kampala'], standardFeeMinor: 0, currency: 'UGX' });
      const transport = new http.Agent({ localAddress: '127.0.0.210', keepAlive: false }); transports.push(transport);
      const client = request.agent(createApp(null)).use(req => req.agent(transport));
      await client.get('/r/' + link.token).set('user-agent', 'ClassicMartRealJourney/1.0').expect(302).expect('location', /^\/products\?/);
      let cart = await client.get('/api/v1/cart').expect(200);
      await client.post('/api/v1/cart/items').set('x-csrf-token', cart.body.csrfToken).send({ productId: product.publicId, variantId: variant.publicId, quantity: 1 }).expect(200);
      const login = await client.get('/login').expect(200), token = login.text.match(/name="_csrf"[^>]*value="([^"]+)"/)[1];
      await client.post('/login').type('form').send({ email: buyer.email, password, _csrf: token }).expect(302);
      cart = await client.get('/api/v1/cart').expect(200); assert.equal(cart.body.cart.items.length, 1);
      const contact = { fullName: buyer.name, email: buyer.email, phone: buyer.phone, address: '10 Test Road', city: 'Kampala', country: 'UG', note: '' };
      const review = await client.post('/api/v1/checkout/review').set('x-csrf-token', cart.body.csrfToken).send({ city: 'Kampala', deliveryMethod: 'standard', paymentMethod: 'cod', pickupPointId: '', contact }).expect(200);
      const input = { checkoutId: review.body.checkoutId, idempotencyKey: id('real_checkout'), city: 'Kampala', deliveryMethod: 'standard', paymentMethod: 'cod', pickupPointId: '',
        contact };
      const previousOrders = await Order.countDocuments(), previousCommissions = await CommissionEntry.countDocuments(), previousReservations = await InventoryReservation.countDocuments();
      const createAudit = AuditLog.create;
      t.mock.method(AuditLog, 'create', async function (documents, ...args) {
        if ((Array.isArray(documents) ? documents : [documents]).some(row => row.action === 'promoter.order_attributed')) throw new Error('Attribution audit deliberately unavailable');
        return createAudit.call(this, documents, ...args);
      });
      await client.post('/api/v1/orders').set('x-csrf-token', cart.body.csrfToken).send(input)
        .expect(response => assert.equal(response.status, 500, response.text));
      t.mock.restoreAll();
      assert.equal(await Order.countDocuments(), previousOrders); assert.equal(await CommissionEntry.countDocuments(), previousCommissions);
      assert.equal(await InventoryReservation.countDocuments(), previousReservations);
      assert.equal((await StockItem.findOne({ variantId: variant._id })).reserved, 0);
      assert.equal((await client.get('/api/v1/cart').expect(200)).body.cart.items.length, 1);
      const placed = await client.post('/api/v1/orders').set('x-csrf-token', cart.body.csrfToken).send(input).expect(201);
      const order = await Order.findOne({ publicId: placed.body.order.id }), rows = await CommissionEntry.find({ orderId: order._id });
      assert.equal(rows.length, 1); assert.equal(rows[0].amountMinor, 300); assert.equal(rows[0].status, 'pending');
      assert.equal((await AttributionTouch.findById(rows[0].touchId)).status, 'converted');
    });
  } finally {
    t.mock.restoreAll(); for (const transport of transports) transport.destroy();
    await Promise.all(Object.values(mongoose.models).map(Model => Model.init()));
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
  }
});

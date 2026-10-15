import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';
import { chromium } from '@playwright/test';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
process.env.PESAPAL_BASE_URL = 'https://refund-review-test.invalid';
process.env.PESAPAL_CONSUMER_KEY = crypto.randomBytes(16).toString('hex');
process.env.PESAPAL_CONSUMER_SECRET = crypto.randomBytes(32).toString('hex');
for (const name of ['SESSION_SECRET', 'TOKEN_PEPPER', 'SECURITY_INTEGRITY_KEY', 'DATA_ENCRYPTION_KEY']) {
  process.env[name] = crypto.randomBytes(32).toString('hex');
}
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;
function csrf(html) {
  const token = html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/);
  assert.ok(token, 'The real page must provide a CSRF token.');
  return token[1];
}
const plain = value => JSON.parse(JSON.stringify(value));
const operational = value => JSON.parse(JSON.stringify(value), (key, item) => ['__v', 'updatedAt'].includes(key) ? undefined : item);

test('independent Finance no-payment reviews record evidence without releasing or resubmitting uncertain refunds', { skip: !uri, timeout: 240_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex'), transports = [];
  await mongoose.connect(uri, { dbName: `classicmart_refund_review_test_${suffix}` });
  let server, browser;
  const { User, CountrySetting, PlatformGrant, Order, PaymentIntent, Refund, ReturnRequest, Warehouse, WarehouseTask,
    EvidenceDocument, SellerReturnCase, LedgerTransaction, FinancialDocument, AuditLog, Notification } = await import('../src/models/index.js');
  const { createApp } = await import('../src/app.js');
  const { hashPassword } = await import('../src/core/crypto.js');
  const { beginMfaEnrollment, confirmMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
  const { ensureLedgerAccount, postLedgerTransaction } = await import('../src/services/money.js');
  const { recordRefundNonDisbursementReview, completeManualRefund, createRefund } = await import('../src/services/payments.js');
  const app = createApp(null), password = `Refund-Review-${suffix}-A1!`, passwordHash = await hashPassword(password);
  let sequence = 0, providerCalls = 0;
  const id = prefix => `${prefix}_${suffix}_${++sequence}`;
  const context = entry => ({ user: entry.user, session: { tokenVersion: entry.user.security.tokenVersion }, query: {},
    id: id('req'), ip: '127.0.0.1', get: () => '' });
  const evidence = (f, changes = {}) => ({ version: f.refund.__v || 0, reference: `portal-review-${f.refund.publicId}`,
    reason: 'Independent merchant portal review confirms the terminal no-disbursement outcome.', terminalOutcomeConfirmed: true, ...changes });
  const route = f => `/finance/refunds/${f.refund.publicId}/review-no-payment`;
  const recordUrl = f => `/finance/refunds?record=${f.refund.publicId}`;
  const auditAction = 'finance.refund_non_disbursement_review_recorded';

  async function actor({ role = 'finance', countries = ['UG'], enroll = true } = {}) {
    const index = ++sequence, publicId = id('usr'), email = `${publicId}@example.com`, phone = '+25670' + String(index).padStart(7, '0');
    let user = await User.create({ publicId, name: `Refund Reviewer ${index}`, email, emailNormalized: email, phone, phoneNormalized: phone,
      passwordHash, role: role === 'finance' ? 'customer' : role, country: 'UG', currency: 'UGX', locale: 'en-UG',
      operationalCountries: countries, platformAccessManagedAt: new Date(), emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
      consents: { terms: true, privacy: true, recordedAt: new Date() } });
    const grant = await PlatformGrant.create({ publicId: id('pgr'), userId: user._id, role, operationalCountries: countries, status: 'active',
      startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000), reason: 'Isolated refund review verification.',
      approvalPublicId: id('approval'), approvedByUserId: new mongoose.Types.ObjectId() });
    let codes;
    if (enroll) {
      const pending = await beginMfaEnrollment(user._id, password);
      const confirmed = await confirmMfaEnrollment(user._id, totpCode(pending.secret));
      user = confirmed.user; codes = confirmed.codes;
    }
    return { user, grant, codes };
  }
  async function login(entry) {
    const transport = new http.Agent({ localAddress: `127.0.0.${transports.length + 150}`, keepAlive: false }); transports.push(transport);
    const client = request.agent(app).use(req => req.agent(transport));
    const page = await client.get('/login').expect(200);
    const result = await client.post('/login').type('form').send({ email: entry.user.email, password, _csrf: csrf(page.text) }).expect(302);
    if (entry.codes) {
      assert.equal(result.headers.location, '/mfa');
      const challenge = await client.get('/mfa').expect(200);
      await client.post('/mfa').type('form').send({ code: entry.codes.shift(), _csrf: csrf(challenge.text) }).expect(302);
    }
    return client;
  }
  let requester, reviewer;
  async function fixture({ country = 'UG', currency = 'UGX', returnBinding = false } = {}) {
    const orderPublicId = id('ord'), paymentPublicId = id('pay'), linePublicId = id('line'), storePublicId = id('sto');
    const customerId = new mongoose.Types.ObjectId(), storeId = new mongoose.Types.ObjectId(), productId = new mongoose.Types.ObjectId(), variantId = new mongoose.Types.ObjectId();
    const order = await Order.create({ publicId: orderPublicId, idempotencyKey: id('order-key'), checkoutId: id('checkout'), cartPublicId: id('cart'),
      sessionKey: id('session'), userId: customerId, country, status: 'paid', paymentState: 'paid', refundState: 'processing',
      deliveryMethod: 'standard', paymentMethod: 'card', reservationExpiresAt: new Date(Date.now() + 86_400_000),
      contact: { fullName: 'BUYER_PRIVATE', email: 'buyer-private@example.com', phone: '+256700111222', address: 'BUYER_ADDRESS_PRIVATE', city: 'Kampala', country },
      totals: { subtotalMinor: 10_000, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 10_000, currency },
      items: [{ linePublicId, productId, variantId, storeId, reservationPublicId: id('reservation'), productPublicId: id('prd'),
        variantPublicId: id('var'), storePublicId, title: 'Purchased item', variantTitle: 'Standard', sku: id('SKU'), quantity: 1,
        unitPriceMinor: 10_000, lineTotalMinor: 10_000, currency, returnedQuantity: returnBinding ? 1 : 0, refundedQuantity: 0 }] });
    const intent = await PaymentIntent.create({ publicId: paymentPublicId, orderId: order._id, orderPublicId, country, currency,
      idempotencyKey: id('payment-key'), provider: 'pesapal', method: 'card', status: 'succeeded', amountMinor: 10_000,
      refundReservedMinor: 10_000, refundedMinor: 0, paidAt: new Date(), providerTrackingId: id('PRIVATE_tracking'),
      providerReference: paymentPublicId, providerConfirmationCode: id('PRIVATE_confirmation'), providerStatus: 'COMPLETED', lastVerifiedAt: new Date() });
    const clearing = await ensureLedgerAccount({ code: 'provider_clearing', type: 'asset', ownerType: 'provider', ownerPublicId: 'pesapal', country, currency });
    const revenue = await ensureLedgerAccount({ code: 'platform_revenue', type: 'revenue', ownerType: 'platform', ownerPublicId: 'classic-mart', country, currency });
    const payable = await ensureLedgerAccount({ code: 'seller_payable', type: 'liability', ownerType: 'store', ownerPublicId: storePublicId, country, currency });
    await postLedgerTransaction({ idempotencyKey: `payment:${intent.publicId}`, referenceType: 'payment', referencePublicId: intent.publicId,
      country, currency, description: 'Original immutable settlement with separate fee and seller shares',
      entries: [{ account: clearing, debitMinor: 10_000, creditMinor: 0 }, { account: revenue, debitMinor: 0, creditMinor: 2_000 }, { account: payable, debitMinor: 0, creditMinor: 8_000 }] });
    let returned, task;
    const refundPublicId = id('rfd');
    if (returnBinding) {
      const returnId = new mongoose.Types.ObjectId(), returnPublicId = id('ret'), receiptPublicId = id('evd');
      const warehouse = await Warehouse.create({ publicId: id('whs'), storeId, ownerUserId: requester.user._id, name: id('Inspection warehouse'), country,
        city: 'Kampala', address: 'Isolated inspection location' });
      task = await WarehouseTask.create({ publicId: id('wht'), warehouseId: warehouse._id, storeId, orderId: order._id, returnRequestId: returnId,
        returnOrderLineId: linePublicId, variantId, quantity: 1, type: 'return_inspection', status: 'completed', result: { disposition: 'good' }, completedAt: new Date() });
      const receipt = await EvidenceDocument.create({ publicId: receiptPublicId, ownerUserId: requester.user._id, country, contextType: 'return',
        contextPublicId: returnPublicId, contextLinePublicId: linePublicId, documentType: 'return_receipt', storageKey: id('PRIVATE_storage'),
        mimeType: 'image/webp', size: 100, status: 'ready' });
      const line = order.items[0];
      returned = await ReturnRequest.create({ _id: returnId, publicId: returnPublicId, orderId: order._id, orderPublicId, userId: customerId, country,
        status: 'refund_processing', reason: 'damaged', details: 'Inspected returned item awaiting reserved refund outcome.', resolution: 'refund', returnMethod: 'dropoff',
        evidenceDocumentIds: [receipt._id], eligibleUntil: new Date(Date.now() + 86_400_000), policyVersion: 'test-v1', refundPublicId,
        inspection: { condition: 'good', notes: 'Physical goods verified.', inspectedByUserId: requester.user._id, inspectedAt: new Date() },
        financeReferral: { requestedAt: new Date(), requestedByUserId: requester.user._id, note: 'Independent Finance review requested.' },
        items: [{ orderLineId: linePublicId, productId, variantId, storeId, storePublicId, productPublicId: line.productPublicId,
          variantPublicId: line.variantPublicId, sku: line.sku, title: line.title, quantity: 1, unitPriceMinor: 10_000, requestedRefundMinor: 10_000,
          warehouseTaskPublicId: task.publicId, warehouseInspectionStatus: 'completed', stockDisposition: 'good', inspectedQuantity: 1,
          warehouseInspectedByUserId: requester.user._id, warehouseInspectedAt: new Date(), intakeWarehousePublicId: warehouse.publicId,
          intakeEvidencePublicId: receiptPublicId, intakeReceivedByUserId: requester.user._id, intakeReceivedAt: new Date() }] });
    }
    const refund = await Refund.create({ publicId: refundPublicId, idempotencyKey: id('refund-key'), orderId: order._id, paymentIntentId: intent._id,
      ...(returned ? { returnRequestId: returned._id, returnPublicId: returned.publicId,
        allocations: [{ storePublicId, productPublicId: order.items[0].productPublicId, orderLineId: linePublicId, grossMinor: 10_000, platformFeeMinor: 2_000, sellerReceivableMinor: 8_000 }] } : {}),
      amountMinor: 10_000, currency, reason: 'Reserved refund awaiting provider reconciliation', provider: 'pesapal', requestedByUserId: requester.user._id,
      status: 'processing', providerStatus: 'UNKNOWN', providerMessage: 'Private provider response must not be copied into the review DTO.' });
    return { order, intent, refund, returned, task, revenue, payable };
  }
  async function moneySnapshot(f) {
    return { order: operational(await Order.findById(f.order._id).lean()), payment: operational(await PaymentIntent.findById(f.intent._id).lean()),
      returned: f.returned ? operational(await ReturnRequest.findById(f.returned._id).lean()) : null,
      tasks: operational(await WarehouseTask.find({ orderId: f.order._id }).lean()),
      sellerReturns: operational(await SellerReturnCase.find({ orderId: f.order._id }).lean()),
      ledger: plain(await LedgerTransaction.find({ referencePublicId: { $in: [f.intent.publicId, f.refund.publicId] } }).sort({ publicId: 1 }).lean()),
      documents: plain(await FinancialDocument.find({ refundPublicId: f.refund.publicId }).lean()) };
  }
  async function assertHeld(f, before) {
    assert.deepEqual(await moneySnapshot(f), before, 'Attesting a no-payment review must not alter any funds, settlement, returned quantities or fulfilment state.');
    const saved = await Refund.findById(f.refund._id).lean();
    assert.equal(saved.status, 'processing'); assert.equal(saved.providerStatus, 'UNKNOWN');
    assert.equal(saved.manualReference, ''); assert.equal(saved.completedAt, undefined); assert.equal(saved.completedByUserId, undefined);
    assert.equal(saved.amountMinor, 10_000); assert.deepEqual(plain(saved.allocations), plain(f.refund.allocations));
    assert.equal(String(saved.returnRequestId || ''), String(f.refund.returnRequestId || ''));
    assert.equal(saved.returnPublicId, f.refund.returnPublicId);
    assert.equal(providerCalls, 0, 'A review must never contact or retry the payment provider.');
  }
  const forbiddenNetwork = t.mock.method(globalThis, 'fetch', async () => {
    providerCalls += 1;
    throw new Error('This no-disbursement review must not contact a provider.');
  });
  try {
    for (const Model of Object.values(mongoose.connection.models)) await Model.init();
    await CountrySetting.create([
      { code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254', active: true },
    ]);
    requester = await actor(); reviewer = await actor();

    await t.test('independent evidence is recorded once, with a held immutable bound return and no resubmission', async () => {
      const f = await fixture({ returnBinding: true }), before = await moneySnapshot(f), input = evidence(f);
      const result = await recordRefundNonDisbursementReview(context(reviewer), f.refund.publicId, input);
      assert.equal(String(result.nonDisbursementReview.actorUserId), String(reviewer.user._id));
      assert.equal(result.nonDisbursementReview.reference, input.reference); assert.equal(result.nonDisbursementReview.reason, input.reason);
      assert.equal(result.nonDisbursementReview.sourceVersion, input.version); assert.ok(result.nonDisbursementReview.recordedAt instanceof Date);
      const savedReview = plain(result.nonDisbursementReview), savedVersion = result.__v;
      await assertHeld(f, before);
      const alerts = await Notification.countDocuments({ href: recordUrl(f) });
      const replay = await recordRefundNonDisbursementReview(context(reviewer), f.refund.publicId, input);
      assert.deepEqual(plain(replay.nonDisbursementReview), savedReview); assert.equal(replay.__v, savedVersion);
      assert.equal(await AuditLog.countDocuments({ action: auditAction, targetPublicId: f.refund.publicId }), 1);
      assert.equal(await Notification.countDocuments({ href: recordUrl(f) }), alerts);
      await assert.rejects(createRefund(context(requester), { orderId: f.order.publicId, reason: 'Another refund cannot consume held funds.', idempotencyKey: id('another-key') }), error => error.code === 'REFUND_EXHAUSTED');
      await assertHeld(f, before);
      for (const changes of [{ reference: input.reference + '-changed' }, { reason: input.reason + ' Changed.' }, { version: savedVersion }]) {
        await assert.rejects(recordRefundNonDisbursementReview(context(reviewer), f.refund.publicId, { ...input, ...changes }), error => error.code === 'REFUND_REVIEW_CONFLICT');
      }
      const other = await actor();
      await assert.rejects(recordRefundNonDisbursementReview(context(other), f.refund.publicId, input), error => error.code === 'REFUND_REVIEW_CONFLICT');
      await assertHeld(f, before);
    });

    await t.test('the original requester cannot attest to their own unknown refund', async () => {
      const f = await fixture(), before = await moneySnapshot(f);
      await assert.rejects(recordRefundNonDisbursementReview(context(requester), f.refund.publicId, evidence(f)), error => error.code === 'FOUR_EYES_REQUIRED');
      assert.equal((await Refund.findById(f.refund._id)).nonDisbursementReview?.recordedAt, undefined);
      await assertHeld(f, before);
    });

    await t.test('mandatory version, bounded evidence and explicit terminal attestation reject malformed requests', async () => {
      const f = await fixture(), before = await moneySnapshot(f);
      for (const [changes, code] of [
        [{ version: undefined }, 'REFUND_VERSION_INVALID'], [{ version: -1 }, 'REFUND_VERSION_INVALID'], [{ version: 0.5 }, 'REFUND_VERSION_INVALID'],
        [{ reference: 'abc' }, 'REFUND_REFERENCE_REQUIRED'], [{ reference: 'r'.repeat(181) }, 'REFUND_REFERENCE_REQUIRED'],
        [{ reason: 'too short' }, 'REFUND_REVIEW_REASON_REQUIRED'], [{ reason: 'r'.repeat(401) }, 'REFUND_REVIEW_REASON_REQUIRED'],
        [{ terminalOutcomeConfirmed: false }, 'REFUND_TERMINAL_OUTCOME_CONFIRMATION_REQUIRED'], [{ terminalOutcomeConfirmed: 'true' }, 'REFUND_TERMINAL_OUTCOME_CONFIRMATION_REQUIRED'],
      ]) await assert.rejects(recordRefundNonDisbursementReview(context(reviewer), f.refund.publicId, evidence(f, changes)), error => error.code === code);
      await assert.rejects(recordRefundNonDisbursementReview(context(reviewer), f.refund.publicId, evidence(f, { version: 999 })), error => error.code === 'REFUND_VERSION_CONFLICT');
      await assertHeld(f, before);
    });

    await t.test('country, primary Finance workspace, active grants and enrolled MFA are authorized afresh', async () => {
      const f = await fixture(), foreign = await actor({ countries: ['KE'] }), admin = await actor({ role: 'country_admin' }), revoked = await actor(), unenrolled = await actor({ enroll: false });
      await PlatformGrant.updateOne({ _id: revoked.grant._id }, { $set: { status: 'revoked' } });
      await assert.rejects(recordRefundNonDisbursementReview(context(foreign), f.refund.publicId, evidence(f)), error => ['FINANCE_COUNTRY_FORBIDDEN', 'REFUND_NOT_FOUND'].includes(error.code));
      await assert.rejects(recordRefundNonDisbursementReview(context(admin), f.refund.publicId, evidence(f)), error => error.code === 'FINANCE_WORKSPACE_FORBIDDEN');
      const adminContext = context(admin); adminContext.requiredOperationalWorkspace = 'admin';
      await assert.rejects(recordRefundNonDisbursementReview(adminContext, f.refund.publicId, evidence(f)), error => error.code === 'REFUND_NON_DISBURSEMENT_WORKSPACE_FORBIDDEN');
      await assert.rejects(recordRefundNonDisbursementReview(context(revoked), f.refund.publicId, evidence(f)), error => error.code === 'FINANCE_GRANT_UNAVAILABLE');
      await assert.rejects(recordRefundNonDisbursementReview(context(unenrolled), f.refund.publicId, evidence(f)), error => error.code === 'MFA_ENROLLMENT_REQUIRED');
      await recordRefundNonDisbursementReview(context(reviewer), f.refund.publicId, evidence(f));
      await PlatformGrant.updateOne({ _id: reviewer.grant._id }, { $set: { status: 'revoked' } });
      try { await assert.rejects(recordRefundNonDisbursementReview(context(reviewer), f.refund.publicId, evidence(f)), error => error.code === 'FINANCE_GRANT_UNAVAILABLE'); }
      finally { await PlatformGrant.updateOne({ _id: reviewer.grant._id }, { $set: { status: 'active' } }); }
    });

    await t.test('non-unknown outcomes, non-Pesapal refunds and completed records cannot be reviewed', async () => {
      for (const change of [{ providerStatus: '200' }, { provider: 'external_manual' }, { status: 'completed', providerStatus: 'COMPLETED' }]) {
        const f = await fixture(); await Refund.updateOne({ _id: f.refund._id }, { $set: change });
        await assert.rejects(recordRefundNonDisbursementReview(context(reviewer), f.refund.publicId, evidence(f)), error => error.code === (change.provider ? 'REFUND_ACCOUNTING_MISMATCH' : 'REFUND_REVIEW_STATE_CONFLICT'));
        assert.equal((await Refund.findById(f.refund._id)).nonDisbursementReview?.recordedAt, undefined);
      }
    });

    await t.test('mismatched payment or immutable return bindings cannot receive an attestation', async () => {
      const payment = await fixture(); await PaymentIntent.updateOne({ _id: payment.intent._id }, { $set: { orderPublicId: id('wrong-order') } });
      await assert.rejects(recordRefundNonDisbursementReview(context(reviewer), payment.refund.publicId, evidence(payment)), error => error.code === 'REFUND_ACCOUNTING_MISMATCH');
      const bound = await fixture({ returnBinding: true }); await ReturnRequest.updateOne({ _id: bound.returned._id }, { $set: { refundPublicId: id('wrong-refund') } });
      await assert.rejects(recordRefundNonDisbursementReview(context(reviewer), bound.refund.publicId, evidence(bound)), error => error.code === 'RETURN_REFUND_BINDING_CONFLICT');
      assert.equal((await Refund.findById(bound.refund._id)).nonDisbursementReview?.recordedAt, undefined);
    });

    await t.test('transactional audit failure rolls back evidence, authorization fences and every financial effect', async () => {
      const f = await fixture({ returnBinding: true }), before = await moneySnapshot(f), actorBefore = plain(await User.findById(reviewer.user._id).lean());
      const original = AuditLog.create;
      const stub = t.mock.method(AuditLog, 'create', function (documents, ...args) {
        if (documents?.[0]?.action === auditAction) throw new Error('Injected review audit persistence failure');
        return original.call(this, documents, ...args);
      });
      try { await assert.rejects(recordRefundNonDisbursementReview(context(reviewer), f.refund.publicId, evidence(f)), /Injected review audit persistence failure/); }
      finally { stub.mock.restore(); }
      assert.equal((await Refund.findById(f.refund._id)).nonDisbursementReview?.recordedAt, undefined);
      assert.equal(await AuditLog.countDocuments({ action: auditAction, targetPublicId: f.refund.publicId }), 0);
      assert.deepEqual(plain(await User.findById(reviewer.user._id).lean()), actorBefore);
      await assertHeld(f, before);
    });

    await t.test('a payment source changed before its transaction fence cannot commit stale evidence', async () => {
      const f = await fixture(), original = PaymentIntent.updateOne; let raced = false;
      const stub = t.mock.method(PaymentIntent, 'updateOne', async function (filter, update, options) {
        if (!raced && options?.session && String(filter?._id) === String(f.intent._id)) {
          raced = true;
          await original.call(this, { _id: f.intent._id }, { $set: { currency: 'KES' }, $inc: { __v: 1 } });
        }
        return original.call(this, filter, update, options);
      });
      try { await assert.rejects(recordRefundNonDisbursementReview(context(reviewer), f.refund.publicId, evidence(f)), error => ['REFUND_ACCOUNTING_MISMATCH', 'REFUND_VERSION_CONFLICT'].includes(error.code)); }
      finally { stub.mock.restore(); }
      assert.equal(raced, true, 'The source must be fenced inside the transaction.');
      assert.equal((await Refund.findById(f.refund._id)).nonDisbursementReview?.recordedAt, undefined);
      assert.equal(await AuditLog.countDocuments({ action: auditAction, targetPublicId: f.refund.publicId }), 0);
      assert.equal((await PaymentIntent.findById(f.intent._id)).refundReservedMinor, 10_000);
      assert.equal(await LedgerTransaction.countDocuments({ referencePublicId: f.refund.publicId }), 0);
    });

    await t.test('subsequent verified paid completion reverses the original settlement once and preserves the earlier review', async () => {
      const f = await fixture(), review = await recordRefundNonDisbursementReview(context(reviewer), f.refund.publicId, evidence(f));
      const savedReview = plain(review.nonDisbursementReview), original = await LedgerTransaction.findOne({ idempotencyKey: `payment:${f.intent.publicId}` }).lean();
      const input = { version: review.__v, reference: 'later-independently-verified-paid-proof' };
      await completeManualRefund(context(reviewer), f.refund.publicId, input);
      await completeManualRefund(context(reviewer), f.refund.publicId, input);
      const saved = await Refund.findById(f.refund._id), intent = await PaymentIntent.findById(f.intent._id), reversal = await LedgerTransaction.findOne({ idempotencyKey: `refund:${f.refund.publicId}` }).lean();
      assert.equal(saved.status, 'completed'); assert.deepEqual(plain(saved.nonDisbursementReview), savedReview);
      assert.equal(intent.refundReservedMinor, 0); assert.equal(intent.refundedMinor, 10_000);
      assert.equal(await LedgerTransaction.countDocuments({ idempotencyKey: `refund:${f.refund.publicId}` }), 1);
      assert.equal(await FinancialDocument.countDocuments({ refundPublicId: f.refund.publicId, type: 'refund_credit_note' }), 1);
      assert.equal(await AuditLog.countDocuments({ action: 'finance.refund_completed', targetPublicId: f.refund.publicId }), 1);
      for (const credit of original.entries.filter(row => row.creditMinor > 0)) assert.equal(reversal.entries.filter(row => String(row.accountId) === String(credit.accountId)).reduce((sum, row) => sum + row.debitMinor, 0), credit.creditMinor);
      assert.equal(providerCalls, 0);
    });

    await t.test('real authenticated HTML and JSON requests enforce CSRF, evidence validation and workspace isolation', async () => {
      const client = await login(reviewer), ownClient = await login(requester), f = await fixture(), before = await moneySnapshot(f);
      const page = await client.get(recordUrl(f)).expect(200), token = csrf(page.text), body = { ...evidence(f), terminalOutcomeConfirmed: 'true', _csrf: token };
      assert.match(page.text, /Record no-payment review/); assert.match(page.headers['cache-control'], /no-store/); assert.match(page.headers['x-robots-tag'], /noindex/);
      await client.post(route(f)).set('Accept', 'application/json').type('form').send(evidence(f)).expect(403);
      await client.post(route(f)).set('Accept', 'application/json').type('form').send({ ...body, terminalOutcomeConfirmed: 'false' }).expect(422);
      const ownPage = await ownClient.get(recordUrl(f)).expect(200);
      assert.doesNotMatch(ownPage.text, /action="[^"]+\/review-no-payment"/);
      await ownClient.post(route(f)).set('Accept', 'application/json').type('form').send({ ...body, _csrf: csrf(ownPage.text) }).expect(403);
      const response = await client.post(route(f)).set('Accept', 'application/json').type('form').send(body).expect(200);
      assert.equal(response.body.refund.status, 'processing'); assert.equal(response.body.refund.canReviewNonDisbursement, false);
      assert.equal(response.body.refund.nonDisbursementReview.reference, body.reference);
      for (const field of ['actorUserId', 'requestedByUserId', 'paymentIntentId', 'providerTrackingId', 'providerMessage', 'BUYER_PRIVATE']) assert.ok(!JSON.stringify(response.body).includes(field), field);
      await client.post(route(f)).set('Accept', 'application/json').type('form').send(body).expect(200);
      const htmlFixture = await fixture(), htmlPage = await client.get(recordUrl(htmlFixture)).expect(200);
      await client.post(route(htmlFixture)).type('form').send({ ...evidence(htmlFixture), terminalOutcomeConfirmed: 'true', _csrf: csrf(htmlPage.text) }).expect(302).expect('location', recordUrl(htmlFixture));
      const after = await client.get(recordUrl(htmlFixture)).expect(200); assert.ok(after.text.includes(evidence(htmlFixture).reference));
      assert.doesNotMatch(after.text, /action="[^"]+\/review-no-payment"/); assert.match(after.text, /\/complete"/);
      const admin = await actor({ role: 'country_admin' }), adminClient = await login(admin), adminPage = await adminClient.get('/account/security').expect(200);
      await adminClient.post(route(f)).set('Accept', 'application/json').type('form').send({ ...body, _csrf: csrf(adminPage.text) }).expect(403);
      const revoked = await actor(), revokedClient = await login(revoked), revokePage = await revokedClient.get(recordUrl(f)).expect(200);
      await PlatformGrant.updateOne({ _id: revoked.grant._id }, { $set: { status: 'revoked' } });
      await revokedClient.post(route(f)).set('Accept', 'application/json').type('form').send({ ...body, _csrf: csrf(revokePage.text) }).expect(403);
      await assertHeld(f, before);
    });

    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    for (const width of [1366, 390]) await t.test(`the approved Finance layout submits a genuine no-payment review at ${width}px`, async () => {
      const entry = await actor(), f = await fixture(), before = await moneySnapshot(f);
      const browserContext = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      try {
        const page = await browserContext.newPage();
        await page.goto(base + '/login'); await page.locator('input[name="email"]').fill(entry.user.email); await page.locator('input[name="password"]').fill(password);
        await Promise.all([page.waitForURL(base + '/mfa'), page.locator('form[action="/login"] button[type="submit"]').click()]);
        await page.locator('form[action="/mfa"] input[name="code"]').fill(entry.codes.shift());
        await Promise.all([page.waitForURL(base + '/finance/overview'), page.locator('form[action="/mfa"] button[type="submit"]').click()]);
        const response = await page.goto(base + recordUrl(f)); assert.equal(response.status(), 200);
        const form = page.locator('form[action$="/review-no-payment"]'), completion = page.locator('form[action$="/complete"]');
        assert.equal(await form.count(), 1); assert.equal(await completion.count(), 1);
        assert.equal(await page.locator('body').getAttribute('data-dashboard-workspace'), 'finance');
        assert.equal(await page.locator('#roleSwitcher').count(), 0);
        const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
          gap: getComputedStyle(document.querySelector('.role-metric-grid')).gap,
          columns: getComputedStyle(document.querySelector('.role-content-grid')).gridTemplateColumns }));
        assert.ok(geometry.scrollWidth <= width + 1, JSON.stringify(geometry));
        assert.equal(geometry.gap, width === 1366 ? '12px' : '9px'); if (width === 1366) assert.match(geometry.columns, /292px$/);
        const styles = await form.locator('button[type="submit"]').evaluate(button => {
          const style = getComputedStyle(button), sibling = document.querySelector('form[action$="/complete"] button[type="submit"]'), other = getComputedStyle(sibling);
          const keys = ['borderRadius', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontSize', 'lineHeight', 'display', 'alignItems', 'justifyContent'];
          return { actual: Object.fromEntries(keys.map(key => [key, style[key]])), existing: Object.fromEntries(keys.map(key => [key, other[key]])) };
        });
        assert.deepEqual(styles.actual, styles.existing, 'The new action retains the existing approved primary-button geometry.');
        const checkbox = form.locator('input[name="terminalOutcomeConfirmed"]');
        const box = await checkbox.evaluate(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, padding: getComputedStyle(node).padding }));
        assert.equal(box.width, 16); assert.equal(box.height, 16); assert.equal(box.padding, '0px');
        await form.locator('input[name="reference"]').fill(evidence(f).reference); await form.locator('textarea[name="reason"]').fill(evidence(f).reason); await checkbox.check();
        await Promise.all([page.waitForNavigation(), form.getByRole('button', { name: 'Record no-payment review', exact: true }).click()]);
        assert.equal(page.url(), base + recordUrl(f));
        assert.equal(await page.locator('form[action$="/review-no-payment"]').count(), 0);
        assert.equal(await page.getByText(evidence(f).reference, { exact: true }).count(), 1);
        assert.equal(await page.locator('form[action$="/complete"]').count(), 1);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        assert.equal(await AuditLog.countDocuments({ action: auditAction, targetPublicId: f.refund.publicId }), 1);
        await assertHeld(f, before);
      } finally { await browserContext.close(); }
    });
  } finally {
    forbiddenNetwork.mock.restore();
    if (browser) await browser.close();
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const transport of transports) transport.destroy();
    t.mock.restoreAll();
    for (const Model of Object.values(mongoose.connection.models)) await Model.init();
    await mongoose.connection.db.dropDatabase(); await mongoose.disconnect();
  }
});

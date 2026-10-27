import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { fixtureTotpSecurity } from './helpers/mfa-fixtures.js';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
process.env.PESAPAL_BASE_URL = 'https://refund-ambiguity-test.invalid';
process.env.PESAPAL_CONSUMER_KEY = crypto.randomBytes(16).toString('hex');
process.env.PESAPAL_CONSUMER_SECRET = crypto.randomBytes(32).toString('hex');
for (const name of ['SESSION_SECRET', 'TOKEN_PEPPER', 'SECURITY_INTEGRITY_KEY', 'DATA_ENCRYPTION_KEY']) {
  process.env[name] = crypto.randomBytes(32).toString('hex');
}
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;

test('uncertain Pesapal refund submissions retain their funds until independent reconciliation', { skip: !uri, timeout: 120_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: `classicmart_refund_ambiguity_test_${suffix}` });
  const { User, PlatformGrant, CountrySetting, Order, PaymentIntent, Refund, LedgerTransaction, AuditLog, FinancialDocument } = await import('../src/models/index.js');
  const { createRefund, completeManualRefund } = await import('../src/services/payments.js');
  const { ensureLedgerAccount, postLedgerTransaction } = await import('../src/services/money.js');
  let sequence = 0, refundCalls = 0;
  const id = prefix => `${prefix}_${suffix}_${++sequence}`;
  let actor, independent;
  const context = (user = actor) => ({ user, session: { tokenVersion: user.security.tokenVersion }, query: {}, id: id('req'), ip: '127.0.0.1', get: () => '' });

  async function fixture({ settlement = false } = {}) {
    const orderId = id('ord'), paymentId = id('pay');
    const order = await Order.create({ publicId: orderId, idempotencyKey: id('order-key'), checkoutId: id('checkout'), cartPublicId: id('cart'),
      sessionKey: id('session'), country: 'UG', status: 'paid', paymentState: 'paid', deliveryMethod: 'standard', paymentMethod: 'card',
      contact: { fullName: 'Refund Buyer', email: 'refund-buyer@example.com', phone: '+256700111222', address: '10 Test Road', city: 'Kampala', country: 'UG' },
      totals: { subtotalMinor: 10_000, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 10_000, currency: 'UGX' },
      items: [{ linePublicId: id('line'), productId: new mongoose.Types.ObjectId(), variantId: new mongoose.Types.ObjectId(), storeId: new mongoose.Types.ObjectId(),
        reservationPublicId: id('reservation'), productPublicId: id('product'), variantPublicId: id('variant'), storePublicId: id('store'),
        title: 'Refund Test Item', variantTitle: 'Standard', sku: id('sku'), quantity: 1, unitPriceMinor: 10_000, lineTotalMinor: 10_000, currency: 'UGX' }],
      reservationExpiresAt: new Date(Date.now() + 86_400_000) });
    const intent = await PaymentIntent.create({ publicId: paymentId, orderId: order._id, orderPublicId: orderId, country: 'UG', currency: 'UGX',
      idempotencyKey: id('payment-key'), provider: 'pesapal', method: 'card', status: 'succeeded', amountMinor: 10_000, paidAt: new Date(),
      providerTrackingId: id('tracking'), providerReference: paymentId, providerConfirmationCode: id('confirmation'), providerPaymentMethod: 'Visa Card',
      providerStatus: 'COMPLETED', lastVerifiedAt: new Date() });
    if (settlement) {
      const clearing = await ensureLedgerAccount({ code: 'provider_clearing', type: 'asset', ownerType: 'provider', ownerPublicId: 'pesapal', country: 'UG', currency: 'UGX' });
      const revenue = await ensureLedgerAccount({ code: 'platform_revenue', type: 'revenue', ownerType: 'platform', ownerPublicId: 'classic-mart', country: 'UG', currency: 'UGX' });
      await postLedgerTransaction({ idempotencyKey: `payment:${intent.publicId}`, referenceType: 'payment', referencePublicId: intent.publicId,
        country: 'UG', currency: 'UGX', description: 'Immutable paid refund fixture',
        entries: [{ account: clearing, debitMinor: 10_000, creditMinor: 0 }, { account: revenue, debitMinor: 0, creditMinor: 10_000 }] });
    }
    return { order, intent, input: { orderId, reason: 'Approved refund after independent review', idempotencyKey: id('refund-key') } };
  }

  async function financeActor(phone) {
    const publicId = id('usr'), email = `${publicId}@example.com`;
    const user = await User.create({ publicId, name: 'Refund Finance', email, emailNormalized: email, phone, phoneNormalized: phone,
      passwordHash: crypto.randomBytes(32).toString('hex'), role: 'finance', country: 'UG', currency: 'UGX', operationalCountries: ['UG'],
      platformAccessManagedAt: new Date(), emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), security: await fixtureTotpSecurity(),
      consents: { terms: true, privacy: true, recordedAt: new Date() } });
    await PlatformGrant.create({ publicId: id('pgr'), userId: user._id, role: 'finance', operationalCountries: ['UG'], status: 'active',
      startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000), reason: 'Isolated refund regression grant',
      approvalPublicId: id('approval'), approvedByUserId: new mongoose.Types.ObjectId() });
    return user;
  }

  function provider(response) {
    return t.mock.method(globalThis, 'fetch', async (url, options) => {
      const target = new URL(url);
      assert.equal(target.origin, 'https://refund-ambiguity-test.invalid');
      if (target.pathname === '/api/Auth/RequestToken') {
        return Response.json({ token: 'isolated-refund-test-token', expiryDate: new Date(Date.now() + 600_000).toISOString() });
      }
      assert.equal(target.pathname, '/api/Transactions/RefundRequest');
      assert.equal(options.method, 'POST');
      assert.equal(JSON.parse(options.body).amount, 10_000);
      refundCalls += 1;
      return response();
    });
  }

  async function retained(f, { error, result, calls, unknown = true }) {
    const current = await PaymentIntent.findById(f.intent._id), saved = await Refund.findOne({ idempotencyKey: f.input.idempotencyKey });
    assert.equal(current.refundReservedMinor, 10_000, 'uncertain external disbursement must retain its full reservation');
    assert.equal(current.refundedMinor, 0);
    assert.equal(current.status, 'succeeded');
    assert.ok(saved && ['pending', 'processing'].includes(saved.status), 'the reserved refund must remain available for reconciliation');
    assert.equal(await LedgerTransaction.countDocuments({ referencePublicId: saved.publicId }), 0);
    if (unknown) {
      assert.equal(error?.code, undefined, 'an uncertain provider response is a recorded reconciliation outcome');
      assert.equal(result?.status, 'processing');
      assert.equal(saved.providerStatus, 'UNKNOWN');
      assert.doesNotMatch(saved.providerMessage, /PROVIDER_PRIVATE|TRANSPORT_PRIVATE/);
    } else {
      assert.ok(error, 'a failed local persistence attempt must be reported without releasing the reservation');
      assert.doesNotMatch(error.message, /PERSISTENCE_PRIVATE/);
      assert.equal(saved.status, 'processing');
      assert.equal(saved.providerStatus, 'UNKNOWN');
    }
    const replay = await createRefund(context(), f.input);
    assert.equal(replay.publicId, saved.publicId);
    assert.equal(refundCalls, calls, 'replaying the original key must not submit another refund');
    await assert.rejects(createRefund(context(), { ...f.input, idempotencyKey: id('different-refund-key') }), value => value.code === 'REFUND_EXHAUSTED');
    assert.equal(refundCalls, calls, 'a different key must not make the held money refundable again');
    assert.equal(await Refund.countDocuments({ paymentIntentId: f.intent._id }), 1);
  }

  try {
    for (const Model of Object.values(mongoose.connection.models)) await Model.init();
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true });
    actor = await financeActor('+256700333444');
    independent = await financeActor('+256700333445');

    await t.test('authentication failure before dispatch releases the unused reservation without exposing provider details', async () => {
      const f = await fixture(), calls = refundCalls;
      let authenticationCalls = 0;
      const stub = t.mock.method(globalThis, 'fetch', async url => {
        const target = new URL(url);
        assert.equal(target.origin, 'https://refund-ambiguity-test.invalid');
        assert.equal(target.pathname, '/api/Auth/RequestToken', 'failed authentication must never dispatch RefundRequest');
        authenticationCalls += 1;
        return Response.json({ error: { code: 'INVALID_CREDENTIALS', message: 'PROVIDER_PRIVATE authentication failed' } }, { status: 401 });
      });
      try {
        await assert.rejects(createRefund(context(), f.input), error => {
          assert.equal(error.code, 'PESAPAL_REFUND_NOT_SUBMITTED');
          assert.doesNotMatch(error.message, /PROVIDER_PRIVATE|INVALID_CREDENTIALS/);
          return true;
        });
        assert.equal(authenticationCalls, 1);
        assert.equal(refundCalls, calls);
        const saved = await Refund.findOne({ idempotencyKey: f.input.idempotencyKey }), current = await PaymentIntent.findById(f.intent._id);
        assert.equal(saved.status, 'failed');
        assert.equal(saved.providerStatus, 'NOT_SUBMITTED');
        assert.equal(current.refundReservedMinor, 0);
        assert.equal(current.refundedMinor, 0);
        assert.equal((await Order.findById(f.order._id)).refundState, 'none');
        assert.equal(await LedgerTransaction.countDocuments({ referencePublicId: saved.publicId }), 0);
        assert.equal((await createRefund(context(), f.input)).publicId, saved.publicId);
        assert.equal(authenticationCalls, 1, 'the same rejected request key must not authenticate or submit again');
        assert.equal(refundCalls, calls);
      } finally { stub.mock.restore(); }
    });

    const uncertain = [
      ['gateway HTTP 502', () => Response.json({ message: 'PROVIDER_PRIVATE gateway failure' }, { status: 502 })],
      ['empty HTTP 200', () => new Response('', { status: 200 })],
      ['malformed HTTP 200', () => new Response('PROVIDER_PRIVATE malformed response', { status: 200 })],
      ['unrecognized HTTP 200', () => Response.json({ status: '202', message: 'PROVIDER_PRIVATE unexpected status' })],
      ['contradictory accepted status and rejected error', () => Response.json({ status: '200', error: 500, message: 'PROVIDER_PRIVATE contradictory response' })],
      ['contradictory rejected status and accepted error', () => Response.json({ status: '500', error: 200, message: 'PROVIDER_PRIVATE contradictory response' })],
      ['provider error object after submission', () => Response.json({ error: { code: 'SERVER_ERROR', message: 'PROVIDER_PRIVATE uncertain provider error' } })],
      ['transport failure after submission', () => { throw new Error('TRANSPORT_PRIVATE response lost'); }],
    ];
    for (const [name, response] of uncertain) {
      await t.test(name, async () => {
        const f = await fixture(), stub = provider(response);
        let error, result;
        try { result = await createRefund(context(), f.input); } catch (value) { error = value; }
        try { await retained(f, { error, result, calls: refundCalls }); } finally { stub.mock.restore(); }
      });
    }

    await t.test('accepted provider response followed by local save failure preserves the hold', async () => {
      const f = await fixture({ settlement: true }), stub = provider(() => Response.json({ status: '200', message: 'Accepted' }));
      const original = Refund.prototype.save;
      let failed = false, error;
      const save = t.mock.method(Refund.prototype, 'save', function (...args) {
        if (!failed && this.idempotencyKey === f.input.idempotencyKey && this.status === 'processing' && this.providerStatus === '200') {
          failed = true;
          throw new Error('PERSISTENCE_PRIVATE accepted outcome could not be saved');
        }
        return original.apply(this, args);
      });
      try {
        try { await createRefund(context(), f.input); } catch (value) { error = value; }
        assert.equal(failed, true);
        await retained(f, { error, calls: refundCalls, unknown: false });
        const saved = await Refund.findOne({ idempotencyKey: f.input.idempotencyKey }), calls = refundCalls;
        await assert.rejects(completeManualRefund(context(), saved.publicId, { reference: 'verified-refund-reference-1' }), value => value.code === 'FOUR_EYES_REQUIRED');
        const completed = await completeManualRefund(context(independent), saved.publicId, { reference: 'verified-refund-reference-1', version: saved.__v });
        assert.equal(completed.status, 'completed');
        assert.equal((await PaymentIntent.findById(f.intent._id)).refundReservedMinor, 0);
        assert.equal((await PaymentIntent.findById(f.intent._id)).refundedMinor, 10_000);
        await completeManualRefund(context(independent), saved.publicId, { reference: 'verified-refund-reference-1' });
        assert.equal(await LedgerTransaction.countDocuments({ idempotencyKey: `refund:${saved.publicId}` }), 1);
        assert.equal(await FinancialDocument.countDocuments({ refundPublicId: saved.publicId, type: 'refund_credit_note' }), 1);
        assert.equal(refundCalls, calls, 'independent reconciliation must not call the refund API again');
      } finally { save.mock.restore(); stub.mock.restore(); }
    });

    await t.test('pre-dispatch persistence failure never contacts the refund provider or frees the reserved money', async () => {
      const f = await fixture({ settlement: true }), stub = provider(() => Response.json({ status: '200', message: 'Accepted' })), calls = refundCalls;
      const original = Refund.prototype.save;
      const save = t.mock.method(Refund.prototype, 'save', function (...args) {
        if (!this.isNew && this.idempotencyKey === f.input.idempotencyKey && this.status === 'processing' && this.providerStatus === 'UNKNOWN') {
          throw new Error('PERSISTENCE_PRIVATE pre-dispatch save unavailable');
        }
        return original.apply(this, args);
      });
      try {
        await assert.rejects(createRefund(context(), f.input), error => {
          assert.doesNotMatch(error.message, /PERSISTENCE_PRIVATE/);
          return true;
        });
        assert.equal(refundCalls, calls);
        const saved = await Refund.findOne({ idempotencyKey: f.input.idempotencyKey });
        assert.equal(saved.status, 'processing');
        assert.equal(saved.providerStatus, 'UNKNOWN');
        assert.equal((await Order.findById(f.order._id)).refundState, 'processing');
        assert.equal((await PaymentIntent.findById(f.intent._id)).refundReservedMinor, 10_000);
        assert.equal(await LedgerTransaction.countDocuments({ referencePublicId: saved.publicId }), 0);
        assert.equal((await createRefund(context(), f.input)).publicId, saved.publicId);
        await assert.rejects(createRefund(context(), { ...f.input, idempotencyKey: id('different-refund-key') }), value => value.code === 'REFUND_EXHAUSTED');
        assert.equal(refundCalls, calls);
        await assert.rejects(completeManualRefund(context(), saved.publicId, { reference: 'verified-external-refund-reference-2' }), value => value.code === 'FOUR_EYES_REQUIRED');
        // The independent operator verifies an actual external disbursement;
        // this recovery path never automatically retries the refund API.
        const completed = await completeManualRefund(context(independent), saved.publicId, { reference: 'verified-external-refund-reference-2', version: saved.__v });
        assert.equal(completed.status, 'completed');
        assert.equal((await PaymentIntent.findById(f.intent._id)).refundReservedMinor, 0);
        assert.equal((await PaymentIntent.findById(f.intent._id)).refundedMinor, 10_000);
        await completeManualRefund(context(independent), saved.publicId, { reference: 'verified-external-refund-reference-2' });
        assert.equal(await LedgerTransaction.countDocuments({ idempotencyKey: `refund:${saved.publicId}` }), 1);
        assert.equal(await FinancialDocument.countDocuments({ refundPublicId: saved.publicId, type: 'refund_credit_note' }), 1);
        assert.equal(await AuditLog.countDocuments({ action: 'finance.refund_completed', targetPublicId: saved.publicId }), 1);
        assert.equal(refundCalls, calls);
      } finally { save.mock.restore(); stub.mock.restore(); }
    });

    await t.test('recognized acceptance keeps the reservation and does not pretend disbursement is complete', async () => {
      const f = await fixture(), stub = provider(() => Response.json({ status: '200', message: 'Accepted' }));
      try {
        const result = await createRefund(context(), f.input), before = refundCalls;
        assert.equal(result.status, 'processing');
        assert.equal(result.providerStatus, '200');
        assert.equal((await PaymentIntent.findById(f.intent._id)).refundReservedMinor, 10_000);
        assert.equal(await LedgerTransaction.countDocuments({ referencePublicId: result.publicId }), 0);
        assert.equal((await createRefund(context(), f.input)).publicId, result.publicId);
        assert.equal(refundCalls, before);
      } finally { stub.mock.restore(); }
    });

    await t.test('explicit consistent rejection releases its reservation and exposes no provider details', async () => {
      const f = await fixture(), stub = provider(() => Response.json({ status: '500', message: 'PROVIDER_PRIVATE rejected by provider' }));
      try {
        await assert.rejects(createRefund(context(), f.input), error => {
          assert.equal(error.code, 'PESAPAL_REFUND_REJECTED');
          assert.doesNotMatch(error.message, /PROVIDER_PRIVATE/);
          return true;
        });
        const saved = await Refund.findOne({ idempotencyKey: f.input.idempotencyKey }), current = await PaymentIntent.findById(f.intent._id);
        assert.equal(saved.status, 'failed');
        assert.equal(current.refundReservedMinor, 0);
        assert.equal(current.refundedMinor, 0);
        assert.equal((await Order.findById(f.order._id)).refundState, 'none');
        assert.equal(await LedgerTransaction.countDocuments({ referencePublicId: saved.publicId }), 0);
        assert.equal(await AuditLog.countDocuments({ action: 'finance.refund_submission_failed', targetPublicId: saved.publicId }), 1);
        const before = refundCalls;
        assert.equal((await createRefund(context(), f.input)).publicId, saved.publicId);
        assert.equal(refundCalls, before, 'a rejected idempotent request must not be submitted again');
      } finally { stub.mock.restore(); }
    });
  } finally {
    t.mock.restoreAll();
    for (const Model of Object.values(mongoose.connection.models)) await Model.init();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

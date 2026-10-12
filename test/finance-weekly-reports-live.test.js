import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;

test('Weekly Finance reports use Monday at 08:00 in the configured calendar', async () => {
  const { financeWeeklyWindow } = await import('../src/services/finance-weekly-reports.js');
  assert.equal(financeWeeklyWindow(new Date('2026-10-12T04:59:59Z'), 'Africa/Kampala'), null);
  assert.equal(financeWeeklyWindow(new Date('2026-10-12T06:00:00Z'), 'Africa/Kampala'), null);
  assert.equal(financeWeeklyWindow(new Date('2026-10-13T05:30:00Z'), 'Africa/Kampala'), null);
  const window = financeWeeklyWindow(new Date('2026-10-12T05:30:00Z'), 'Africa/Kampala');
  assert.equal(window.weekKey, '2026-10-12'); assert.equal(window.start.toISOString(), '2026-10-04T21:00:00.000Z'); assert.equal(window.end.toISOString(), '2026-10-11T21:00:00.000Z');
  const dst = financeWeeklyWindow(new Date('2026-03-09T12:30:00Z'), 'America/New_York');
  assert.equal(dst.start.toISOString(), '2026-03-02T05:00:00.000Z'); assert.equal(dst.end.toISOString(), '2026-03-09T04:00:00.000Z');
});

test('Finance weekly jobs persist real reports, progress fairly and recheck delivery permission', { skip: !uri, timeout: 180_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1'); assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: `classicmart_finance_weekly_test_${suffix}` });
  try {
    const { User, CountrySetting, PlatformGrant, Order, PaymentIntent, FinanceDigest, OutboxEvent, AuditLog, MaintenanceScanCursor, LedgerAccount, Store, LoyaltyAccount } = await import('../src/models/index.js');
    const { queueWeeklyFinanceReports, prepareFinanceDigestDelivery, finishFinanceDigestDelivery } = await import('../src/services/finance-weekly-reports.js');
    const { processNotificationOutbox } = await import('../src/services/outbox.js');
    for (const Model of Object.values(mongoose.models)) await Model.init();
    await CountrySetting.create([{ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256' },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254' },
      { code: 'TZ', name: 'PRIVATE_UNASSIGNED_COUNTRY', currency: 'TZS', locale: 'en-TZ', timeZone: 'Africa/Dar_es_Salaam', phonePrefix: '+255' }]);
    let sequence = 0;
    async function actor({ managed = false, country = 'UG', defaultCountry = 'UG', scope = ['UG', 'KE'], enabled = true } = {}) {
      const index = ++sequence, email = `finance-weekly-${suffix}-${index}@example.com`, phone = '+25670' + String(index).padStart(7, '0');
      const user = await User.create({ publicId: `usr_fw_${suffix}_${index}`, name: `Finance weekly ${index}`, email, emailNormalized: email, phone, phoneNormalized: phone,
        passwordHash: 'not-used-by-background-fixture', role: managed ? 'customer' : 'finance', country, operationalCountries: scope, currency: 'UGX',
        emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), platformAccessManagedAt: managed ? new Date() : undefined, security: { mfaEnabled: true },
        preferences: { financeWeeklyReport: enabled, financeDefaultCountry: defaultCountry }, consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const grant = managed ? await PlatformGrant.create({ publicId: `pgr_fw_${suffix}_${index}`, userId: user._id, role: 'finance', operationalCountries: scope, status: 'active',
        startsAt: new Date(Date.now() - 86400_000), expiresAt: new Date(Date.now() + 7 * 86400_000), reason: 'Weekly scoped report fixture', approvalPublicId: `apr_fw_${suffix}_${index}`, approvedByUserId: new mongoose.Types.ObjectId() }) : null;
      return { user, grant };
    }
    const tick = new Date('2026-10-12T05:30:00Z'), multiTick = new Date('2026-10-12T08:30:00Z');
    const resetScan = () => MaintenanceScanCursor.updateOne({ scanName: 'finance_weekly_reports' }, { $set: { lastId: null } }, { upsert: true });
    const disableAll = () => User.updateMany({}, { $set: { 'preferences.financeWeeklyReport': false } });
    const eventFor = entry => OutboxEvent.findOne({ type: 'finance.weekly_report', 'payload.userId': String(entry.user._id) });
    for (const [country, currency, amountMinor] of [['UG', 'UGX', 50000], ['KE', 'KES', 25000], ['TZ', 'TZS', 999999]]) {
      const _id = new mongoose.Types.ObjectId(), publicId = `ord_fw_${suffix}_${country}`, paidAt = new Date('2026-10-07T12:00:00Z');
      await Order.collection.insertOne({ _id, publicId, country, totals: { currency, totalMinor: amountMinor }, sessionKey: 'VISITOR_SESSION_PRIVATE', idempotencyKey: `order_fw_${suffix}_${country}`, contact: { email: 'BUYER_CONTACT_PRIVATE' }, createdAt: paidAt });
      await PaymentIntent.create({ publicId: `pay_fw_${suffix}_${country}`, orderId: _id, orderPublicId: publicId, country, currency, idempotencyKey: `payment_fw_${suffix}_${country}`, provider: 'wallet', method: 'wallet', status: 'succeeded', amountMinor, paidAt, createdAt: paidAt });
    }

    await t.test('bounded maintenance scans progress past the first batch and scheduling is idempotent', async () => {
      const first = await actor(), second = await actor(), third = await actor();
      const batch1 = await queueWeeklyFinanceReports({ now: tick, limit: 1 }), batch2 = await queueWeeklyFinanceReports({ now: tick, limit: 1 }), batch3 = await queueWeeklyFinanceReports({ now: tick, limit: 1 });
      assert.equal(batch1.queued, 1); assert.equal(batch2.queued, 1); assert.equal(batch3.queued, 1);
      assert.equal(await FinanceDigest.countDocuments({ userId: { $in: [first.user._id, second.user._id, third.user._id] } }), 3);
      await queueWeeklyFinanceReports({ now: tick, limit: 1 }); await queueWeeklyFinanceReports({ now: tick, limit: 20 });
      assert.equal(await FinanceDigest.countDocuments(), 3); assert.equal(await OutboxEvent.countDocuments({ type: 'finance.weekly_report' }), 3);
      assert.equal(await AuditLog.countDocuments({ action: 'finance.weekly_report_queued' }), 3);
      const digest = await FinanceDigest.findOne({ userId: third.user._id }).select('+groups');
      assert.equal(digest.periodStart.toISOString(), '2026-10-04T21:00:00.000Z'); assert.equal(digest.groups.length, 1); assert.equal(digest.groups[0].capturedMinor, 50000);
      const message = await prepareFinanceDigestDelivery(await eventFor(third)); assert.ok(message.text.includes('\n')); assert.ok(!message.text.includes('\\n')); assert.ok(message.text.includes('UG UGX | 50000')); assert.ok(!message.text.includes('BUYER_CONTACT_PRIVATE'));
      assert.equal(await LedgerAccount.countDocuments(), 0); assert.equal(await Store.countDocuments(), 0); assert.equal(await LoyaltyAccount.countDocuments(), 0);
      await disableAll(); await processNotificationOutbox({ limit: 100 });
    });
    await t.test('concurrent schedulers create one transactionally audited digest per actor and week', async () => {
      const entry = await actor(); await resetScan();
      await Promise.all([queueWeeklyFinanceReports({ now: tick, limit: 50 }), queueWeeklyFinanceReports({ now: tick, limit: 50 })]);
      assert.equal(await FinanceDigest.countDocuments({ userId: entry.user._id }), 1); assert.equal(await OutboxEvent.countDocuments({ 'payload.userId': String(entry.user._id) }), 1);
      const audit = await AuditLog.findOne({ action: 'finance.weekly_report_queued', actorId: entry.user._id }); assert.ok(audit);
      await disableAll(); await processNotificationOutbox({ limit: 100 });
    });
    await t.test('multiple assigned markets keep amounts separate and never include unassigned countries', async () => {
      const entry = await actor({ managed: true, defaultCountry: '' }); await resetScan();
      assert.equal((await queueWeeklyFinanceReports({ now: tick })).queued, 0, 'all-market reports use UTC rather than the registration country');
      await resetScan(); assert.equal((await queueWeeklyFinanceReports({ now: multiTick })).queued, 1);
      const digest = await FinanceDigest.findOne({ userId: entry.user._id }).select('+groups'); assert.deepEqual(digest.scopeCountries, ['KE', 'UG']);
      assert.deepEqual(digest.groups.map(row => [row.country, row.currency, row.capturedMinor]), [['KE', 'KES', 25000], ['UG', 'UGX', 50000]]);
      const message = await prepareFinanceDigestDelivery(await eventFor(entry)); assert.ok(message.text.includes('KE KES | 25000')); assert.ok(message.text.includes('UG UGX | 50000')); assert.ok(!message.text.includes('999999'));
      await finishFinanceDigestDelivery(await eventFor(entry), { delivered: false, developmentSink: true }); assert.equal((await FinanceDigest.findById(digest._id)).status, 'development_sink');
      assert.equal(await prepareFinanceDigestDelivery(await eventFor(entry)), null); await disableAll(); await processNotificationOutbox({ limit: 100 });
    });
    await t.test('delivery rechecks opt-in, email, token, grant, authenticator and scope changes', async () => {
      for (const mutation of ['optout', 'email', 'token', 'grant', 'mfa', 'scope', 'currency']) {
        const entry = await actor({ managed: true }); await resetScan(); await queueWeeklyFinanceReports({ now: tick }); const event = await eventFor(entry); assert.ok(event);
        if (mutation === 'optout') await User.updateOne({ _id: entry.user._id }, { $set: { 'preferences.financeWeeklyReport': false } });
        if (mutation === 'email') await User.updateOne({ _id: entry.user._id }, { $set: { email: `changed-${entry.user.email}` } });
        if (mutation === 'token') await User.updateOne({ _id: entry.user._id }, { $inc: { 'security.tokenVersion': 1 } });
        if (mutation === 'grant') await PlatformGrant.updateOne({ _id: entry.grant._id }, { $set: { status: 'revoked' } });
        if (mutation === 'mfa') await User.updateOne({ _id: entry.user._id }, { $set: { 'security.mfaEnabled': false } });
        if (mutation === 'scope') await PlatformGrant.updateOne({ _id: entry.grant._id }, { $set: { operationalCountries: ['KE'] } });
        if (mutation === 'currency') await CountrySetting.updateOne({ code: 'UG' }, { $set: { currency: 'USD' } });
        assert.equal(await prepareFinanceDigestDelivery(event), null, mutation); assert.equal((await FinanceDigest.findOne({ userId: entry.user._id })).status, 'cancelled');
        if (mutation === 'currency') await CountrySetting.updateOne({ code: 'UG' }, { $set: { currency: 'UGX' } });
        await disableAll(); await processNotificationOutbox({ limit: 100 }); assert.equal((await OutboxEvent.findById(event._id)).status, 'processed');
      }
    });
    await t.test('an audit failure rolls the digest, outbox, user fence and market fence back together', async () => {
      const entry = await actor(), beforeActor = await User.findById(entry.user._id), beforeCountry = await CountrySetting.findOne({ code: 'UG' }); await resetScan();
      const original = AuditLog.create;
      AuditLog.create = function (documents, ...args) { if (Array.isArray(documents) && documents.some(row => row.action === 'finance.weekly_report_queued')) throw new Error('Injected transactional audit failure'); return original.call(this, documents, ...args); };
      try { await assert.rejects(queueWeeklyFinanceReports({ now: tick }), /Injected transactional audit failure/); } finally { AuditLog.create = original; }
      assert.equal(await FinanceDigest.countDocuments({ userId: entry.user._id }), 0); assert.equal(await OutboxEvent.countDocuments({ 'payload.userId': String(entry.user._id) }), 0);
      assert.equal((await User.findById(entry.user._id)).__v, beforeActor.__v); assert.equal((await CountrySetting.findOne({ code: 'UG' })).__v, beforeCountry.__v);
      await disableAll();
    });
    await t.test('the real outbox records development delivery and retries configuration failures without contacting a provider', async () => {
      const entry = await actor(); await resetScan(); await queueWeeklyFinanceReports({ now: tick }); const event = await eventFor(entry); assert.ok(event);
      const failed = await processNotificationOutbox({ limit: 100, sendEmail: async () => { throw new Error('Injected SMTP delivery failure'); } }); assert.equal(failed.failed, 1);
      const pending = await OutboxEvent.findById(event._id); assert.equal(pending.status, 'failed'); assert.ok(pending.availableAt > new Date()); assert.equal((await FinanceDigest.findOne({ userId: entry.user._id })).status, 'queued');
      await OutboxEvent.updateOne({ _id: event._id }, { $set: { availableAt: new Date(Date.now() - 1000) } });
      const retried = await processNotificationOutbox({ limit: 100 }); assert.equal(retried.failed, 0); assert.equal(retried.processed, 1);
      assert.equal((await OutboxEvent.findById(event._id)).attempts, 2); assert.equal((await FinanceDigest.findOne({ userId: entry.user._id })).status, 'development_sink');
      assert.equal((await processNotificationOutbox({ limit: 100 })).checked, 0);
      await assert.rejects(finishFinanceDigestDelivery(event, { delivered: false, developmentSink: false }), error => error.code === 'FINANCE_DIGEST_DELIVERY_UNCONFIRMED');
    });
  } finally { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('Finance reporting periods use calendar boundaries and spreadsheet cells remain inert', async () => {
  const { financeReportingWindow, financeCsvCell } = await import('../src/services/finance-report-pages.js');
  assert.equal(financeReportingWindow('year', 'Africa/Kampala', new Date('2026-10-10T22:00:00Z')).start.toISOString(), '2025-12-31T21:00:00.000Z');
  assert.equal(financeReportingWindow('year', 'America/New_York', new Date('2026-03-10T12:00:00Z')).buckets[2].start.toISOString(), '2026-03-01T05:00:00.000Z');
  assert.throws(() => financeReportingWindow('forever', 'UTC'));
  for (const value of ['=IMPORTXML("private")', '  +SUM(1,2)', '\t@cmd', '-2+3', '\uFEFF=HYPERLINK("x")']) assert.ok(financeCsvCell(value).startsWith('"\''));
  assert.equal(financeCsvCell('quoted "value"'), '"quoted ""value"""');
});

test('Finance overview, reports and audit use complete scoped financial records and private exports', { skip: !uri, timeout: 180_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1'); assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex'), transports = [];
  await mongoose.connect(uri, { dbName: `classicmart_finance_reports_test_${suffix}` });
  try {
    const models = await import('../src/models/index.js');
    const { User, PlatformGrant, CountrySetting, Order, PaymentIntent, Refund, Payout, PayoutAccount, LedgerAccount, LedgerTransaction, AuditLog, ProviderEvent, ReconciliationRun, Chargeback, Shipment, Store, LoyaltyAccount } = models;
    const { createApp } = await import('../src/app.js');
    const { hashPassword } = await import('../src/core/crypto.js');
    const { encryptSensitive } = await import('../src/core/sensitive.js');
    const { totpCode } = await import('../src/services/mfa.js');
    const { loadFinanceReportPage, loadFinanceSidebar, streamFinanceReportCsv } = await import('../src/services/finance-report-pages.js');
    const { financeAccess } = await import('../src/services/finance-workspace-access.js');
    for (const Model of Object.values(mongoose.models)) await Model.init();
    await CountrySetting.create([{ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256' },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254' },
      { code: 'TZ', name: 'UNASSIGNED_MARKET_PRIVATE', currency: 'TZS', locale: 'en-TZ', timeZone: 'Africa/Dar_es_Salaam', phonePrefix: '+255' }]);
    const password = `FinanceReport-${suffix}-A1!`, passwordHash = await hashPassword(password), secret = 'JBSWY3DPEHPK3PXP', app = createApp(null);
    let sequence = 0;
    async function actor(role, { managed = false, login = false, countries = ['UG', 'KE'] } = {}) {
      const index = ++sequence, email = `finance-report-${suffix}-${index}@example.com`, phone = '+25670' + String(index).padStart(7, '0');
      const user = await User.create({ publicId: `usr_fr_${suffix}_${index}`, name: `Finance report ${index}`, email, emailNormalized: email, phone, phoneNormalized: phone,
        passwordHash, role, country: 'UG', currency: 'UGX', operationalCountries: countries, platformAccessManagedAt: managed ? new Date() : undefined,
        emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), security: { mfaEnabled: true, mfaSecretEncrypted: encryptSensitive(secret) }, consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const grant = managed ? await PlatformGrant.create({ publicId: `pgr_fr_${suffix}_${index}`, userId: user._id, role: 'finance', operationalCountries: countries, status: 'active',
        startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86400_000), reason: 'Scoped finance report fixture', approvalPublicId: `apr_fr_${suffix}_${index}`, approvedByUserId: new mongoose.Types.ObjectId() }) : null;
      let client;
      if (login) {
        const transport = new http.Agent({ localAddress: `127.0.0.${index + 90}`, keepAlive: false }); transports.push(transport);
        client = request.agent(app).use(req => req.agent(transport));
        const page = await client.get('/login').expect(200);
        await client.post('/login').type('form').send({ email, password, _csrf: csrf(page.text) }).expect(302).expect('location', '/mfa');
        const challenge = await client.get('/mfa').expect(200);
        await client.post('/mfa').type('form').send({ code: totpCode(secret), _csrf: csrf(challenge.text) }).expect(302);
      }
      return { user, grant, client };
    }
    const owner = await actor('customer', { managed: true, login: true }), customer = await actor('customer'), single = await actor('finance', { countries: ['UG'] });
    const scoped = (entry = owner, query = {}) => ({ id: `req_fr_${suffix}_${++sequence}`, ip: '127.0.0.1', get: () => 'FinanceReportTest/1.0', user: entry.user, session: { tokenVersion: entry.user.security.tokenVersion }, query });
    const now = new Date(Date.now() - 60_000), old = new Date(now.getTime() - 400 * 86400_000);
    const roots = [], payments = [];
    for (const [country, currency, count, amountMinor] of [['UG', 'UGX', 64, 10000], ['KE', 'KES', 3, 20000], ['TZ', 'TZS', 2, 77777]]) {
      for (let index = 0; index < count; index += 1) {
        const id = `${country}_${index}`, _id = new mongoose.Types.ObjectId(), publicId = `ord_fr_${suffix}_${id}`;
        await Order.collection.insertOne({ _id, publicId, country, totals: { currency, totalMinor: amountMinor }, createdAt: now, sessionKey: `SESSION_PRIVATE_${id}`, idempotencyKey: `order_fr_${suffix}_${id}`, contact: { email: 'BUYER_CONTACT_PRIVATE', phone: 'BUYER_PHONE_PRIVATE' }, items: [{ title: 'BUYER_ORDER_ITEM_PRIVATE' }] });
        roots.push({ _id, publicId, country, currency });
        payments.push(await PaymentIntent.create({ publicId: `pay_fr_${suffix}_${id}`, orderId: _id, orderPublicId: publicId, country, currency, idempotencyKey: `payment_fr_${suffix}_${id}`, provider: 'pesapal', method: 'pesapal', status: 'succeeded', amountMinor, paidAt: now, createdAt: now, providerTrackingId: `tracking_fr_${suffix}_${id}` }));
      }
    }
    const ug = roots[0], ugPayment = payments[0];
    await PaymentIntent.create({ publicId: `pay_mismatch_fr_${suffix}`, orderId: ug._id, orderPublicId: 'MISMATCH_ORDER_PRIVATE', country: 'UG', currency: 'UGX', idempotencyKey: `payment_mismatch_fr_${suffix}`, provider: 'wallet', method: 'wallet', status: 'succeeded', paidAt: now, amountMinor: 999999, createdAt: now });
    await PaymentIntent.create({ publicId: `pay_old_fr_${suffix}`, orderId: ug._id, orderPublicId: ug.publicId, country: 'UG', currency: 'UGX', idempotencyKey: `payment_old_fr_${suffix}`, provider: 'wallet', method: 'wallet', status: 'succeeded', paidAt: old, amountMinor: 999999, createdAt: old });
    const account = await PayoutAccount.create({ publicId: `poa_fr_${suffix}`, ownerUserId: owner.user._id, ownerType: 'promoter', country: 'UG', currency: 'UGX', method: 'bank', label: 'ACCOUNT_LABEL_PRIVATE', destinationEncrypted: 'BANK_DESTINATION_PRIVATE', status: 'verified' });
    for (let index = 0; index < 60; index += 1) {
      await Refund.create({ publicId: `ref_fr_${suffix}_${index}`, idempotencyKey: `refund_fr_${suffix}_${index}`, orderId: ug._id, paymentIntentId: ugPayment._id, amountMinor: 100, currency: 'UGX', reason: 'REFUND_REASON_PRIVATE', provider: 'pesapal', status: 'completed', completedAt: now, createdAt: now });
      await Payout.create({ publicId: `pyo_fr_${suffix}_${index}`, idempotencyKey: `payout_fr_${suffix}_${index}`, ownerUserId: owner.user._id, requestedByUserId: owner.user._id, payoutAccountId: account._id, amountMinor: 200, currency: 'UGX', status: 'paid', completedAt: now, createdAt: now });
    }
    const cash = await LedgerAccount.create({ publicId: `lac_cash_fr_${suffix}`, code: 'cash', type: 'asset', ownerType: 'platform', ownerPublicId: 'classic-mart', country: 'UG', currency: 'UGX' });
    const revenue = await LedgerAccount.create({ publicId: `lac_revenue_fr_${suffix}`, code: 'revenue', type: 'revenue', ownerType: 'platform', ownerPublicId: 'classic-mart', country: 'UG', currency: 'UGX' });
    for (let index = 0; index < 60; index += 1) await LedgerTransaction.create({ publicId: `ltx_fr_${suffix}_${index}`, idempotencyKey: `ledger_fr_${suffix}_${index}`, country: 'UG', currency: 'UGX', referenceType: 'order_payment', referencePublicId: ug.publicId, description: index === 0 ? '  =IMPORTXML("private")' : 'Verified payment', postedAt: now, createdAt: now,
      entries: [{ accountId: cash._id, accountPublicId: cash.publicId, debitMinor: 10000, creditMinor: 0, memo: 'LEDGER_MEMO_PRIVATE' }, { accountId: revenue._id, accountPublicId: revenue.publicId, debitMinor: 0, creditMinor: 10000 }] });
    await LedgerTransaction.collection.insertOne({ _id: new mongoose.Types.ObjectId(), publicId: `ltx_bad_fr_${suffix}`, country: 'UG', currency: 'UGX', idempotencyKey: `ledger_bad_fr_${suffix}`, referenceType: 'fixture', referencePublicId: 'MISMATCH_ACCOUNT_PRIVATE', description: 'MISMATCH_LEDGER_PRIVATE', postedAt: now, createdAt: now,
      entries: [{ accountId: cash._id, accountPublicId: 'MISMATCH_ACCOUNT_PRIVATE', debitMinor: 999999, creditMinor: 0 }, { accountId: revenue._id, accountPublicId: revenue.publicId, debitMinor: 0, creditMinor: 999999 }] });
    for (let index = 0; index < 75; index += 1) await AuditLog.create({ requestId: `req_audit_fr_${suffix}_${index}`, actorId: owner.user._id, actorPublicId: owner.user.publicId, action: 'finance.payment_verified', targetType: 'payment', targetPublicId: index === 0 ? '  =AUDIT_FORMULA' : ugPayment.publicId, country: 'UG', result: index % 2 ? 'success' : 'denied', createdAt: now,
      metadata: { privateContact: 'AUDIT_METADATA_PRIVATE', headers: 'COOKIE_HEADERS_PRIVATE', session: 'SESSION_TOKEN_PRIVATE' }, ipHash: 'IP_HASH_PRIVATE', userAgentHash: 'UA_HASH_PRIVATE' });
    await AuditLog.create({ requestId: `req_foreign_fr_${suffix}`, actorPublicId: 'FOREIGN_ACTOR_PRIVATE', action: 'finance.payment_verified', country: 'TZ', result: 'success', createdAt: now });
    await AuditLog.create({ requestId: `req_nonfinance_fr_${suffix}`, action: 'identity.login', country: 'UG', result: 'success', metadata: { email: 'NONFINANCE_EMAIL_PRIVATE' }, createdAt: now });
    await Refund.create({ publicId: `ref_stale_fr_${suffix}`, idempotencyKey: `refund_stale_fr_${suffix}`, orderId: ug._id, paymentIntentId: ugPayment._id, amountMinor: 100, currency: 'UGX', reason: 'Stale refund', status: 'processing', createdAt: now, updatedAt: new Date(now.getTime() - 3 * 60 * 60 * 1000) });
    // Mongoose refreshes updatedAt when creating a timestamped document. Preserve
    // the actual three-hour processing age rather than changing the exception rule.
    await Refund.updateOne({ publicId: `ref_stale_fr_${suffix}` }, { $set: { updatedAt: new Date(now.getTime() - 3 * 60 * 60 * 1000) } }, { timestamps: false });
    await Payout.create({ publicId: `pyo_unknown_fr_${suffix}`, idempotencyKey: `payout_unknown_fr_${suffix}`, ownerUserId: owner.user._id, requestedByUserId: owner.user._id, payoutAccountId: account._id, amountMinor: 200, currency: 'UGX', status: 'unknown', createdAt: now });
    await ProviderEvent.create({ publicId: `pev_fr_${suffix}`, provider: 'pesapal', eventId: `event_fr_${suffix}`, eventType: 'ipn', country: 'UG', rawHash: 'RAW_HASH_PRIVATE', rawEncrypted: 'RAW_PAYLOAD_PRIVATE', verifiedAt: now, status: 'dead', createdAt: now });
    await ReconciliationRun.create([{ publicId: `rec_done_fr_${suffix}`, country: 'UG', provider: 'pesapal', startedByUserId: owner.user._id, status: 'completed', checked: 200, matched: 198, failed: 0, createdAt: now },
      { publicId: `rec_failed_fr_${suffix}`, country: 'UG', currency: 'UGX', provider: 'cod', startedByUserId: owner.user._id, status: 'failed', checked: 3, matched: 1, failed: 2, errorMessages: ['STACK_TRACE_PRIVATE'], createdAt: now }]);
    await Chargeback.create({ publicId: `chb_fr_${suffix}`, orderId: ug._id, orderPublicId: ug.publicId, paymentIntentId: ugPayment._id, paymentIntentPublicId: ugPayment.publicId, country: 'UG', currency: 'UGX', amountMinor: 10000, status: 'open' });
    await Shipment.create({ publicId: `shp_fr_${suffix}`, orderId: ug._id, orderPublicId: ug.publicId, country: 'UG', mode: 'standard', status: 'delivered', deliveredAt: now, cod: { required: true, amountMinor: 10000, collectedMinor: 10000, currency: 'UGX' } });

    await t.test('three canonical pages show complete totals, separate currencies and no private fields', async () => {
      for (const slug of ['overview', 'reports', 'audit']) {
        const result = await owner.client.get('/finance/' + slug).set('Accept', 'application/json').expect(200);
        assert.deepEqual(result.body.context.countries.map(row => row.code).sort(), ['KE', 'UG']); assert.equal(result.body.context.country, '');
        assert.equal(result.body.totals.capturedCount, 67); assert.equal(result.body.totals.refundCount, 60); assert.equal(result.body.totals.payoutCount, 60); assert.equal(result.body.totals.ledgerCount, 60);
        const ugGroup = result.body.groups.find(row => row.country === 'UG'), keGroup = result.body.groups.find(row => row.country === 'KE');
        assert.equal(ugGroup.capturedMinor, 640000); assert.equal(keGroup.capturedMinor, 60000); assert.equal(ugGroup.refundedMinor, 6000); assert.equal(ugGroup.payoutMinor, 12000); assert.equal(ugGroup.ledgerDebitMinor, 600000);
        for (const hidden of ['UNASSIGNED_MARKET_PRIVATE', 'BUYER_CONTACT_PRIVATE', 'BUYER_ORDER_ITEM_PRIVATE', 'BANK_DESTINATION_PRIVATE', 'AUDIT_METADATA_PRIVATE', 'COOKIE_HEADERS_PRIVATE', 'IP_HASH_PRIVATE', 'RAW_PAYLOAD_PRIVATE', 'STACK_TRACE_PRIVATE', 'MISMATCH_LEDGER_PRIVATE', 'MISMATCH_ORDER_PRIVATE', 'FOREIGN_ACTOR_PRIVATE', 'LEDGER_MEMO_PRIVATE']) assert.ok(!JSON.stringify(result.body).includes(hidden), hidden);
        assert.match(result.headers['cache-control'], /no-store/); assert.match(result.headers['x-robots-tag'], /noindex/);
        const html = await owner.client.get('/finance/' + slug).expect(200); assert.match(html.text, /data-role="finance"/); assert.ok(!html.text.includes('99.7%'));
      }
      const overview = (await owner.client.get('/finance/overview').set('Accept', 'application/json')).body;
      assert.equal(overview.trend.reduce((sum, row) => sum + row.value, 0), 67);
      assert.equal(overview.exceptionCount, 6); assert.equal(overview.exceptions.pendingCod, 1);
      assert.equal(await Store.countDocuments(), 0); assert.equal(await LoyaltyAccount.countDocuments(), 0); assert.equal(await LedgerAccount.countDocuments(), 2);
    });
    await t.test('market filters cannot add unauthorized countries or combine currencies', async () => {
      const ugResult = await owner.client.get('/finance/overview?country=UG').set('Accept', 'application/json').expect(200);
      assert.equal(ugResult.body.context.currency, 'UGX'); assert.equal(ugResult.body.groups.length, 1); assert.equal(ugResult.body.totals.capturedCount, 64);
      await owner.client.get('/finance/reports?country=TZ').set('Accept', 'application/json').expect(403);
      const singleFlow = await loadFinanceReportPage(scoped(single), 'finance-overview'); assert.equal(singleFlow.country, 'UG'); assert.equal(singleFlow.totals.capturedCount, 64);
      await owner.client.get('/finance/reports?country=UG&country=KE').set('Accept', 'application/json').expect(422);
      await owner.client.get('/finance/reports?report[$ne]=summary').set('Accept', 'application/json').expect(422);
      await owner.client.get('/finance/audit?after=bad-cursor').set('Accept', 'application/json').expect(422);
      await owner.client.get('/finance/reports?period=forever').set('Accept', 'application/json').expect(422);
    });
    await t.test('each record report counts all rows while keyset pages remain bounded', async () => {
      for (const [report, total] of [['payments', 64], ['refunds', 61], ['payouts', 61], ['ledger', 60], ['reconciliation', 2]]) {
        const first = await owner.client.get(`/finance/reports?country=UG&report=${report}`).set('Accept', 'application/json').expect(200);
        assert.equal(first.body.page.total, total); assert.equal(first.body.page.count, Math.min(25, total)); assert.equal(first.body.items.length, Math.min(25, total));
        if (total > 25) { const second = await owner.client.get(`/finance/reports?country=UG&report=${report}&after=${first.body.page.next}`).set('Accept', 'application/json').expect(200); assert.equal(second.body.page.total, total); assert.ok(!first.body.items.some(row => second.body.items.some(other => other.publicId === row.publicId))); }
      }
    });
    await t.test('CSV exports contain all matching financial records and inert formulas without sensitive fields', async () => {
      const paymentsCsv = await owner.client.get('/finance/reports/export.csv?country=UG&report=payments').expect(200);
      assert.equal(paymentsCsv.text.trim().split('\r\n').length, 65); assert.ok(!paymentsCsv.text.includes('MISMATCH_ORDER_PRIVATE')); assert.ok(!paymentsCsv.text.includes('BUYER_CONTACT_PRIVATE'));
      for (const [report, count] of [['refunds', 61], ['payouts', 61], ['ledger', 60], ['reconciliation', 2]]) {
        const csv = await owner.client.get(`/finance/reports/export.csv?country=UG&report=${report}`).expect(200); assert.equal(csv.text.trim().split('\r\n').length, count + 1);
        assert.match(csv.headers['content-type'], /text\/csv/); assert.match(csv.headers['cache-control'], /no-store/);
        assert.ok(!csv.text.includes('BANK_DESTINATION_PRIVATE')); assert.ok(!csv.text.includes('LEDGER_MEMO_PRIVATE')); assert.ok(!csv.text.includes('STACK_TRACE_PRIVATE'));
        if (report === 'ledger') assert.match(csv.text, /"'  =IMPORTXML/);
      }
      const summary = await owner.client.get('/finance/reports/export.csv?report=summary').expect(200); assert.equal(summary.text.trim().split('\r\n').length, 3); assert.match(summary.text, /"UG","UGX","64","640000"/); assert.match(summary.text, /"KE","KES","3","60000"/);
      assert.equal(await AuditLog.countDocuments({ action: 'finance.report_exported', actorId: owner.user._id }), 6);
    });
    await t.test('audit results and CSV project only scoped finance evidence', async () => {
      const result = await owner.client.get('/finance/audit?country=UG&status=denied').set('Accept', 'application/json').expect(200); assert.equal(result.body.page.total, 38); assert.equal(result.body.page.count, 25);
      assert.ok(result.body.items.every(row => row.result === 'denied' && row.country === 'UG')); assert.ok(result.body.items.every(row => !Object.hasOwn(row, 'metadata') && !Object.hasOwn(row, 'ipHash')));
      const csv = await owner.client.get('/finance/audit/export.csv?country=UG&status=denied').expect(200); assert.equal(csv.text.trim().split('\r\n').length, 39); assert.match(csv.text, /"'  =AUDIT_FORMULA"/); assert.ok(!csv.text.includes('SESSION_TOKEN_PRIVATE'));
      const sidebar = await loadFinanceSidebar(await financeAccess(scoped())); assert.equal(sidebar.matchingRate, 99); assert.equal(sidebar.exceptionCount, 6);
    });
    await t.test('summary and record CSV streams stop when grants or settlement currencies change', async () => {
      for (const report of ['summary', 'ledger']) {
        const output = new EventEmitter(), chunks = []; let ended = false;
        output.destroyed = false; output.set = () => output; output.end = () => { ended = true; };
        output.write = text => {
          chunks.push(text);
          if (chunks.length === 2) {
            const mutation = report === 'summary' ? PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { status: 'revoked' } }) : CountrySetting.updateOne({ code: 'UG' }, { $set: { currency: 'USD' } });
            Promise.resolve(mutation).then(() => output.emit('drain'), error => output.emit('error', error));
            return false;
          }
          return true;
        };
        try {
          await assert.rejects(streamFinanceReportCsv(scoped(owner, { report }), output, 'finance-reports'), error => error.status === 403);
          assert.equal(chunks.length, 2); assert.equal(ended, false);
          if (report === 'summary') assert.ok(!chunks.join('').includes('"UG","UGX","64"'), 'revocation stops the next market group');
        } finally {
          await PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { status: 'active' } });
          await CountrySetting.updateOne({ code: 'UG' }, { $set: { currency: 'UGX' } });
        }
      }
    });
    await t.test('current grants, account status and authenticator are rechecked for direct and HTTP report access', async () => {
      await assert.rejects(loadFinanceReportPage(scoped(customer), 'finance-reports'), error => error.status === 403);
      await User.updateOne({ _id: owner.user._id }, { $set: { 'security.mfaEnabled': false } });
      await assert.rejects(loadFinanceReportPage(scoped(), 'finance-reports'), error => error.code === 'MFA_ENROLLMENT_REQUIRED');
      await User.updateOne({ _id: owner.user._id }, { $set: { 'security.mfaEnabled': true } });
      await PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { status: 'revoked' } });
      await assert.rejects(loadFinanceReportPage(scoped(), 'finance-reports'), error => error.code === 'FINANCE_GRANT_UNAVAILABLE');
      await owner.client.get('/finance/reports').set('Accept', 'application/json').expect(403);
      await PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { status: 'active' } });
    });
    await t.test('saved report defaults choose a real market calendar and valid period', async () => {
      await User.updateOne({ _id: owner.user._id }, { $set: { 'preferences.financeReportingPeriod': 'year', 'preferences.financeDefaultCountry': 'UG' } });
      const flow = await loadFinanceReportPage(scoped(), 'finance-overview'); assert.equal(flow.period, 'year'); assert.equal(flow.timeZone, 'Africa/Kampala'); assert.equal(flow.country, 'UG'); assert.equal(flow.trend.reduce((sum, row) => sum + row.value, 0), 64);
    });
  } finally { for (const transport of transports) transport.destroy(); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
});

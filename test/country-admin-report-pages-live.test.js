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

test('Country Admin reporting calendars use the configured market and CSV formulas remain inert', async () => {
  const { countryAdminReportingWindow, countryAdminCsvCell } = await import('../src/services/country-admin-report-pages.js');
  assert.equal(countryAdminReportingWindow('year', 'Africa/Kampala', new Date('2026-10-10T22:00:00Z')).start.toISOString(), '2025-12-31T21:00:00.000Z');
  assert.equal(countryAdminReportingWindow('year', 'America/New_York', new Date('2026-03-10T12:00:00Z')).buckets[2].start.toISOString(), '2026-03-01T05:00:00.000Z');
  assert.throws(() => countryAdminReportingWindow('forever', 'UTC'));
  for (const value of ['=IMPORTXML("private")', '  +SUM(1,2)', '\t@cmd', '-2+3', '\uFEFF=HYPERLINK("x")', '\u0000=HYPERLINK("x")']) assert.ok(countryAdminCsvCell(value).startsWith('"\''), value);
  assert.equal(countryAdminCsvCell('quoted "value"'), '"quoted ""value"""');
  assert.equal(countryAdminCsvCell(null), '""');
});

test('Country Admin reports join real source markets, currencies and ledger evidence with accountable exports', { skip: !uri, timeout: 180_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1'); assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex'), transports = [];
  await mongoose.connect(uri, { dbName: `classicmart_country_reports_test_${suffix}` });
  try {
    const { User, PlatformGrant, CountrySetting, Category, Store, StoreMember, Product, PromoterVerification, SellerVerification, Order, PaymentIntent, Refund, ReturnRequest, EvidenceDocument, ProviderEvent, ReconciliationRun, Campaign, LedgerAccount, LedgerTransaction, SupportTicket, AuditLog } = await import('../src/models/index.js');
    const { createApp } = await import('../src/app.js');
    const { hashPassword } = await import('../src/core/crypto.js');
    const { encryptSensitive } = await import('../src/core/sensitive.js');
    const { totpCode } = await import('../src/services/mfa.js');
    const { loadCountryAdminReportPage, streamCountryAdminReportCsv } = await import('../src/services/country-admin-report-pages.js');
    for (const Model of Object.values(mongoose.models)) await Model.init();
    await CountrySetting.create([{ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256' }, { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254' }, { code: 'TZ', name: 'UNASSIGNED_MARKET_PRIVATE', currency: 'TZS', locale: 'en-TZ', timeZone: 'Africa/Dar_es_Salaam', phonePrefix: '+255' }]);
    const password = `CountryReports-${suffix}-A1!`, passwordHash = await hashPassword(password), secret = 'JBSWY3DPEHPK3PXP', app = createApp(null);
    let sequence = 0;
    async function actor(role = 'customer', { managed = false, country = 'UG', login = false, countries = ['UG', 'KE'] } = {}) {
      const index = ++sequence, email = `country-reports-${suffix}-${index}@example.com`, phone = '+25670' + String(index).padStart(7, '0');
      const user = await User.create({ publicId: `usr_cr_${suffix}_${index}`, name: 'PRIVATE_CUSTOMER_NAME', email, emailNormalized: email, phone, phoneNormalized: phone, passwordHash, role, country, shoppingCountry: country === 'UG' ? 'TZ' : 'UG', currency: 'TZS', operationalCountries: countries, platformAccessManagedAt: managed ? new Date() : undefined, emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), onboardingCompletedAt: new Date(), security: { mfaEnabled: true, mfaSecretEncrypted: encryptSensitive(secret) }, consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const grant = managed ? await PlatformGrant.create({ publicId: `pgr_cr_${suffix}_${index}`, userId: user._id, role: 'country_admin', operationalCountries: countries, status: 'active', startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86400_000), reason: 'Country reporting fixture', approvalPublicId: `apr_cr_${suffix}_${index}`, approvedByUserId: new mongoose.Types.ObjectId() }) : null;
      let client;
      if (login) { const transport = new http.Agent({ localAddress: `127.0.0.${index + 170}`, keepAlive: false }); transports.push(transport); client = request.agent(app).use(req => req.agent(transport)); const page = await client.get('/login').expect(200); await client.post('/login').type('form').send({ email, password, _csrf: csrf(page.text) }).expect(302).expect('location', '/mfa'); const challenge = await client.get('/mfa').expect(200); await client.post('/mfa').type('form').send({ code: totpCode(secret), _csrf: csrf(challenge.text) }).expect(302).expect('location', '/admin/overview'); }
      return { user, grant, client };
    }
    const owner = await actor('customer', { managed: true, login: true }), customer = await actor(), fakePromoter = await actor(), promoter = await actor('promoter', { country: 'TZ' });
    const scoped = (query = {}, entry = owner) => ({ id: `req_cr_${suffix}_${++sequence}`, ip: '127.0.0.1', get: () => 'CountryReports/1.0', user: entry.user, session: { tokenVersion: entry.user.security.tokenVersion }, query });
    const now = new Date(), createdAt = new Date(now.getTime() - 2 * 86400_000), paidAt = new Date(createdAt.getTime() + 60_000);
    const category = await Category.create({ publicId: `cat_cr_${suffix}`, name: 'Country reports', slug: `cr-${suffix}`, countries: ['UG', 'KE', 'TZ'] });
    const stores = {}, products = {}, orders = {}, intents = {};
    for (const [country, currency, total] of [['UG', 'UGX', 1000], ['KE', 'KES', 200], ['TZ', 'TZS', 600]]) {
      const seller = await actor('seller', { country }); stores[country] = await Store.create({ publicId: `str_cr_${suffix}_${country}`, ownerUserId: seller.user._id, name: 'PRIVATE_SELLER_NAME', slug: `cr-${suffix}-${country}`, country, currency, status: country === 'UG' ? 'pending_verification' : 'verified' }); products[country] = [];
      for (let index = 0; index < ({ UG: 31, KE: 3, TZ: 2 })[country]; index++) {
        const product = await Product.create({ publicId: country === 'UG' && index === 0 ? '  =COUNTRY_REPORT_FORMULA' : `prd_cr_${suffix}_${country}_${index}`, storeId: stores[country]._id, ownerUserId: seller.user._id, categoryId: category._id, title: 'PRIVATE_PRODUCT_TITLE', slug: `cr-product-${suffix}-${country}-${index}`, description: 'PRIVATE_PRODUCT_BODY', countries: ['UG', 'KE', 'TZ'], status: 'submitted', createdAt, moderation: { submittedAt: createdAt } }); products[country].push(product);
        await AuditLog.create({ requestId: `req_source_cr_${suffix}_${country}_${index}`, actorId: owner.user._id, actorPublicId: owner.user.publicId, action: 'catalogue.product_approve', targetType: 'product', targetPublicId: product.publicId, country, result: 'success', createdAt: paidAt, metadata: { note: 'PRIVATE_AUDIT_NOTE', contact: 'PRIVATE_AUDIT_CONTACT', token: 'PRIVATE_API_SECRET' } });
      }
      const item = { linePublicId: `line_cr_${suffix}_${country}`, productId: products[country][0]._id, variantId: new mongoose.Types.ObjectId(), storeId: stores[country]._id, reservationPublicId: `res_cr_${suffix}_${country}`, productPublicId: products[country][0].publicId, variantPublicId: `var_cr_${suffix}_${country}`, storePublicId: stores[country].publicId, title: 'PRIVATE_ORDER_ITEM', variantTitle: 'PRIVATE_VARIANT', sku: 'PRIVATE_SKU', quantity: 1, unitPriceMinor: total, lineTotalMinor: total, currency };
      orders[country] = await Order.create({ publicId: `ord_cr_${suffix}_${country}`, idempotencyKey: `cr-${suffix}-${country}`, checkoutId: `checkout_cr_${suffix}_${country}`, cartPublicId: `cart_cr_${suffix}_${country}`, sessionKey: `PRIVATE_SESSION_${country}`, userId: customer.user._id, country, status: 'paid', deliveryMethod: 'standard', paymentMethod: 'card', paymentState: 'paid', contact: { fullName: 'PRIVATE_ORDER_CONTACT', email: 'private-contact@example.com', phone: '+256700000000', address: 'PRIVATE_ADDRESS', city: 'PRIVATE_CITY', country }, totals: { subtotalMinor: total, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: total, currency }, items: [item], reservationExpiresAt: new Date(now.getTime() + 3600_000), createdAt });
      intents[country] = await PaymentIntent.create({ publicId: `pay_cr_${suffix}_${country}`, orderId: orders[country]._id, orderPublicId: orders[country].publicId, country, idempotencyKey: `payment_cr_${suffix}_${country}`, provider: 'sandbox', method: 'card', status: 'succeeded', amountMinor: total, currency, providerReference: 'PRIVATE_PROVIDER_REFERENCE', checkoutUrl: 'PRIVATE_CHECKOUT_URL', paidAt, createdAt });
    }
    const usdOrder = await Order.create({ ...orders.UG.toObject(), _id: undefined, __v: undefined, publicId: `ord_cr_${suffix}_USD`, idempotencyKey: `usd_cr_${suffix}`, checkoutId: `usd_checkout_${suffix}`, totals: { subtotalMinor: 700, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 700, currency: 'USD' }, items: orders.UG.items.map(item => ({ ...item.toObject(), currency: 'USD', unitPriceMinor: 700, lineTotalMinor: 700 })) });
    await PaymentIntent.create({ publicId: `pay_cr_${suffix}_USD`, orderId: usdOrder._id, orderPublicId: usdOrder.publicId, country: 'UG', idempotencyKey: `pay_usd_cr_${suffix}`, provider: 'sandbox', method: 'card', status: 'failed', amountMinor: 700, currency: 'USD', createdAt });
    await PaymentIntent.create({ publicId: `pay_forged_cr_${suffix}`, orderId: orders.TZ._id, orderPublicId: orders.TZ.publicId, country: 'UG', idempotencyKey: `pay_forged_cr_${suffix}`, provider: 'sandbox', method: 'card', status: 'pending', amountMinor: 600, currency: 'TZS', createdAt });
    const ledger = async (type, reference, amount) => {
      const accountA = await LedgerAccount.create({ publicId: `acc_cr_${suffix}_${++sequence}`, code: `source_a_${sequence}`, type: 'asset', ownerType: 'platform', ownerPublicId: 'classic-mart', country: 'UG', currency: 'UGX' }), accountB = await LedgerAccount.create({ publicId: `acc_cr_${suffix}_${++sequence}`, code: `source_b_${sequence}`, type: 'liability', ownerType: 'platform', ownerPublicId: 'classic-mart', country: 'UG', currency: 'UGX' });
      return LedgerTransaction.create({ publicId: `txn_cr_${suffix}_${++sequence}`, idempotencyKey: `ledger_cr_${suffix}_${sequence}`, referenceType: type, referencePublicId: reference, country: 'UG', currency: 'UGX', description: 'PRIVATE_LEDGER_DESCRIPTION', entries: [{ accountId: accountA._id, accountPublicId: accountA.publicId, debitMinor: amount, creditMinor: 0, memo: 'PRIVATE_LEDGER_MEMO' }, { accountId: accountB._id, accountPublicId: accountB.publicId, debitMinor: 0, creditMinor: amount }], postedAt: paidAt });
    };
    await ledger('payment', intents.UG.publicId, 1000);
    const refund = await Refund.create({ publicId: `ref_cr_${suffix}_complete`, idempotencyKey: `ref_complete_cr_${suffix}`, orderId: orders.UG._id, paymentIntentId: intents.UG._id, amountMinor: 100, currency: 'UGX', reason: 'PRIVATE_REFUND_REASON', status: 'completed', completedAt: paidAt, createdAt }); await ledger('refund', refund.publicId, 100);
    await Refund.create([{ publicId: `ref_cr_${suffix}_pending`, idempotencyKey: `ref_pending_cr_${suffix}`, orderId: orders.UG._id, paymentIntentId: intents.UG._id, amountMinor: 50, currency: 'UGX', reason: 'PRIVATE_REFUND_REASON', status: 'pending', createdAt }, { publicId: `ref_forged_cr_${suffix}`, idempotencyKey: `ref_forged_cr_${suffix}`, orderId: orders.UG._id, paymentIntentId: intents.TZ._id, amountMinor: 100, currency: 'UGX', reason: 'PRIVATE_FOREIGN_REFUND', status: 'pending', createdAt }]);
    await SellerVerification.create({ publicId: `svr_cr_${suffix}`, storeId: stores.UG._id, userId: stores.UG.ownerUserId, sellerType: 'individual', legalName: 'PRIVATE_LEGAL_NAME', status: 'submitted', submittedAt: createdAt });
    await PromoterVerification.create([{ publicId: `prv_cr_${suffix}`, userId: promoter.user._id, country: 'UG', status: 'submitted', submittedAt: createdAt }, { publicId: `prv_fake_cr_${suffix}`, userId: fakePromoter.user._id, country: 'UG', status: 'submitted' }]);
    await Product.create({ publicId: `prd_forged_owner_cr_${suffix}`, storeId: stores.UG._id, ownerUserId: customer.user._id, categoryId: category._id, title: 'PRIVATE_FORGED_PRODUCT', slug: `forged-cr-${suffix}`, description: 'PRIVATE_FORGED_PRODUCT', countries: ['UG'], status: 'submitted', createdAt });
    const ticket = (country, key, extra = {}) => ({ publicId: `tkt_cr_${suffix}_${key}`, userId: customer.user._id, country, category: 'order', subject: 'PRIVATE_SUPPORT_SUBJECT', status: 'open', priority: 'normal', queue: 'orders', slaDueAt: new Date(now.getTime() + 3600_000), notes: [{ message: 'PRIVATE_CUSTOMER_NOTE', actorUserId: customer.user._id, at: createdAt }], createdAt, ...extra });
    await SupportTicket.create([ticket('UG', 'responded', { status: 'resolved', resolvedAt: paidAt, slaDueAt: new Date(paidAt.getTime() + 3600_000), notes: [{ message: 'PRIVATE_CUSTOMER_NOTE', actorUserId: customer.user._id, at: createdAt }, { message: 'PRIVATE_STAFF_REPLY', actorUserId: owner.user._id, at: paidAt }, { message: 'PRIVATE_INTERNAL_NOTE', actorUserId: owner.user._id, internal: true, at: createdAt }] }), ticket('UG', 'overdue', { slaDueAt: new Date(now.getTime() - 3600_000) }), ticket('KE', 'future')]);
    await SupportTicket.collection.insertOne(ticket('UG', 'missing_deadline', { slaDueAt: undefined }));
    await AuditLog.create([{ requestId: `req_forged_country_cr_${suffix}`, actorId: owner.user._id, actorPublicId: owner.user.publicId, action: 'catalogue.product_approve', targetType: 'product', targetPublicId: products.TZ[0].publicId, country: 'UG', result: 'success', createdAt: paidAt }, { requestId: `req_forged_actor_cr_${suffix}`, actorId: customer.user._id, actorPublicId: 'PRIVATE_FORGED_OPERATOR', action: 'catalogue.product_approve', targetType: 'product', targetPublicId: products.UG[0].publicId, country: 'UG', result: 'success', createdAt: paidAt }, { requestId: `req_unrelated_cr_${suffix}`, actorId: owner.user._id, actorPublicId: owner.user.publicId, action: 'auth.login', targetType: 'user', targetPublicId: owner.user.publicId, country: 'UG', result: 'success', createdAt: paidAt }]);

    await t.test('complete scoped counts exceed one page and preserve registration/verification/store boundaries', async () => {
      for (const slug of ['overview', 'reports']) {
        const flow = await owner.client.get('/admin/' + slug).set('Accept', 'application/json').expect(200);
        assert.equal(flow.body.summary.customerCount, 2); assert.equal(flow.body.summary.sellerCount, 2); assert.equal(flow.body.summary.productCount, 34); assert.equal(flow.body.summary.promoterCount, 1); assert.equal(flow.body.summary.orderCount, 3); assert.equal(flow.body.summary.backlogCount, 41); assert.equal(flow.body.summary.supportServiceLevel, 66.7);
        assert.equal(flow.body.sidebar.sourceCounts.products, 34); assert.equal(flow.body.sidebar.backlog.overdueTickets, 1); assert.equal(flow.body.sidebar.supportSlaObservedCount, 3);
        assert.equal(flow.body.financialGroups.length, 3); assert.equal(flow.body.financialGroups.find(row => row.country === 'UG' && row.currency === 'UGX').settledPaymentMinor, 1000); assert.equal(flow.body.financialGroups.find(row => row.country === 'UG' && row.currency === 'UGX').completedRefundMinor, 100); assert.equal(flow.body.financialGroups.find(row => row.country === 'KE').settledPaymentMinor, 0); assert.ok(!Object.hasOwn(flow.body.summary, 'settledPaymentMinor'));
        for (const hidden of ['PRIVATE_CUSTOMER_NAME', 'PRIVATE_SELLER_NAME', 'PRIVATE_PRODUCT_TITLE', 'PRIVATE_PRODUCT_BODY', 'PRIVATE_ORDER_CONTACT', 'PRIVATE_ADDRESS', 'PRIVATE_AUDIT_NOTE', 'PRIVATE_API_SECRET', 'PRIVATE_INTERNAL_NOTE', 'PRIVATE_STAFF_REPLY', 'PRIVATE_LEDGER_MEMO', 'PRIVATE_PROVIDER_REFERENCE', 'PRIVATE_LEGAL_NAME', 'UNASSIGNED_MARKET_PRIVATE']) assert.ok(!JSON.stringify(flow.body).includes(hidden), hidden);
        assert.match(flow.headers['cache-control'], /no-store/); assert.match(flow.headers['x-robots-tag'], /noindex/);
        const html = await owner.client.get('/admin/' + slug).expect(200); assert.match(html.text, /data-role="admin"/); assert.match(html.text, /Country reports/);
      }
      const ug = (await owner.client.get('/admin/reports?country=UG').set('Accept', 'application/json').expect(200)).body; assert.equal(ug.summary.productCount, 31); assert.equal(ug.timeZone, 'Africa/Kampala'); assert.equal(ug.context.currency, 'UGX');
      const empty = (await owner.client.get('/admin/reports?country=KE').set('Accept', 'application/json').expect(200)).body; assert.equal(empty.summary.customerCount, 0);
      await owner.client.get('/admin/reports?country=TZ').set('Accept', 'application/json').expect(403);
      for (const query of ['country=UG&country=KE', 'report[$ne]=summary', 'after=invalid', 'period=forever', 'report=summary&status=pending', 'report=audit&status=submitted']) await owner.client.get('/admin/reports?' + query).set('Accept', 'application/json').expect(422);
    });
    await t.test('operational and audit records use 25-row keysets while CSV retains all matching rows', async () => {
      for (const [report, total] of [['audit', 34], ['operational', 41]]) {
        const path = '/admin/reports?report=' + report, first = await owner.client.get(path).set('Accept', 'application/json').expect(200); assert.equal(first.body.page.total, total); assert.equal(first.body.page.count, 25);
        const second = await owner.client.get(path + '&after=' + encodeURIComponent(first.body.page.next)).set('Accept', 'application/json').expect(200); assert.equal(second.body.page.total, total); assert.equal(second.body.page.count, total - 25); assert.equal(new Set([...first.body.items, ...second.body.items].map(row => row.publicId || row.requestId)).size, total);
        const csv = await owner.client.get('/admin/reports/export.csv?report=' + report).expect(200); assert.equal(csv.text.trim().split('\r\n').length, total + 1); assert.match(csv.text, /"'  =COUNTRY_REPORT_FORMULA"/); assert.match(csv.headers['content-type'], /text\/csv/); assert.match(csv.headers['cache-control'], /no-store/); for (const hidden of ['PRIVATE_AUDIT_NOTE', 'PRIVATE_AUDIT_CONTACT', 'PRIVATE_API_SECRET', 'PRIVATE_PROVIDER_REFERENCE', 'PRIVATE_CUSTOMER_NOTE']) assert.ok(!csv.text.includes(hidden), hidden);
      }
      const summaryCsv = await owner.client.get('/admin/overview/export.csv').expect(200); assert.equal(summaryCsv.text.trim().split('\r\n').length, 4); assert.match(summaryCsv.text, /"UG","USD"/); assert.equal(await AuditLog.countDocuments({ action: 'country_admin.report_exported' }), 3);
      const audit = await loadCountryAdminReportPage(scoped({ report: 'audit', search: 'req_forged_' }), 'admin-reports'); assert.equal(audit.page.total, 0);
    });
    await t.test('missing deadlines and missing ledger evidence never become observed success', async () => {
      const ug = await loadCountryAdminReportPage(scoped({ country: 'UG' }), 'admin-reports'); assert.equal(ug.summary.openTicketCount, 2); assert.equal(ug.summary.overdueTicketCount, 1); assert.equal(ug.summary.supportSlaObservedCount, 2); assert.equal(ug.summary.supportServiceLevel, 50);
      const selfAccount = await LedgerAccount.create({ publicId: `acc_self_cr_${suffix}`, code: `self_cr_${suffix}`, type: 'asset', ownerType: 'platform', ownerPublicId: 'classic-mart', country: 'KE', currency: 'KES' });
      await LedgerTransaction.create({ publicId: `txn_self_cr_${suffix}`, idempotencyKey: `self_cr_${suffix}`, referenceType: 'payment', referencePublicId: intents.KE.publicId, country: 'KE', currency: 'KES', description: 'A same-account debit and credit is not settlement.', entries: [{ accountId: selfAccount._id, accountPublicId: selfAccount.publicId, debitMinor: 200, creditMinor: 0 }, { accountId: selfAccount._id, accountPublicId: selfAccount.publicId, debitMinor: 0, creditMinor: 200 }], postedAt: paidAt });
      await SupportTicket.updateOne({ publicId: `tkt_cr_${suffix}_future` }, { $unset: { slaDueAt: 1 } }); const ke = await loadCountryAdminReportPage(scoped({ country: 'KE' }), 'admin-reports'); assert.equal(ke.summary.supportServiceLevel, null); assert.equal(ke.metrics[3].value, '—'); assert.equal(ke.metrics[3].detail, 'No observations');
      assert.equal(ke.financialGroups.find(row => row.currency === 'KES').settledPaymentMinor, 0);
      await SupportTicket.updateOne({ publicId: `tkt_cr_${suffix}_future` }, { $set: { slaDueAt: new Date(now.getTime() + 3600_000) } });
      const operations = await loadCountryAdminReportPage(scoped({ report: 'operational', search: 'missing_deadline' }), 'admin-reports'); assert.equal(operations.items[0].slaState, 'unknown');
    });
    await t.test('current appeals and refund links lead to the matching operational workspace', async () => {
      await PromoterVerification.updateOne({ publicId: `prv_cr_${suffix}` }, { $set: { status: 'appealed' } });
      try {
        const summary = await loadCountryAdminReportPage(scoped(), 'admin-overview'); assert.equal(summary.summary.promoterVerificationCount, 1);
        const appeals = await loadCountryAdminReportPage(scoped({ report: 'operational', status: 'appealed' }), 'admin-reports'); assert.equal(appeals.page.total, 1); assert.equal(appeals.items[0].type, 'promoter_verification');
        const refunds = await loadCountryAdminReportPage(scoped({ report: 'operational', search: `ref_cr_${suffix}_pending` }), 'admin-reports'); assert.equal(refunds.page.total, 1);
        const link = new URL(refunds.rows[0].href, 'http://localhost'); assert.equal(link.pathname, '/admin/payments'); assert.equal(link.searchParams.get('view'), 'refunds'); assert.equal(link.searchParams.get('record'), refunds.items[0].publicId);
      } finally { await PromoterVerification.updateOne({ publicId: `prv_cr_${suffix}` }, { $set: { status: 'submitted' } }); }
    });
    await t.test('administrative commerce evidence and replay audits require the actual attached source chain', async () => {
      const returned = await ReturnRequest.create({ publicId: `ret_new_cr_${suffix}`, orderId: orders.UG._id, orderPublicId: orders.UG.publicId, userId: customer.user._id, country: 'UG', reason: 'damaged', details: 'PRIVATE_RETURN_DETAILS', resolution: 'refund', status: 'refunded', eligibleUntil: now, policyVersion: '2026-07', items: [{ orderLineId: orders.UG.items[0].linePublicId, productId: products.UG[0]._id, variantId: orders.UG.items[0].variantId, productPublicId: products.UG[0].publicId, variantPublicId: orders.UG.items[0].variantPublicId, title: 'PRIVATE_RETURN_TITLE', quantity: 1, unitPriceMinor: 1000, requestedRefundMinor: 100 }] });
      const evidenceValues = { ownerUserId: owner.user._id, country: 'UG', contextType: 'return', contextPublicId: returned.publicId, storageKey: 'PRIVATE_EVIDENCE_STORAGE', mimeType: 'image/webp', size: 100, status: 'ready', description: 'PRIVATE_EVIDENCE_DESCRIPTION' };
      const evidence = await EvidenceDocument.create({ ...evidenceValues, publicId: `evd_PRIVATE_ATTACHED_${suffix}` }), detached = await EvidenceDocument.create({ ...evidenceValues, publicId: `evd_PRIVATE_DETACHED_${suffix}` }); await ReturnRequest.updateOne({ _id: returned._id }, { $push: { evidenceDocumentIds: evidence._id } });
      const payment = await PaymentIntent.create({ publicId: `pay_new_cr_${suffix}`, orderId: orders.UG._id, orderPublicId: orders.UG.publicId, country: 'UG', idempotencyKey: `payment_new_cr_${suffix}`, provider: 'pesapal', method: 'card', status: 'pending', amountMinor: 1000, currency: 'UGX', providerReference: `PRIVATE_MERCHANT_${suffix}`, providerTrackingId: `PRIVATE_TRACKING_${suffix}` });
      const eventValues = { provider: 'pesapal', eventType: 'IPNCHANGE', merchantReference: payment.providerReference, providerTrackingId: payment.providerTrackingId, paymentIntentPublicId: payment.publicId, orderPublicId: orders.UG.publicId, country: 'UG', rawHash: 'b'.repeat(64), rawEncrypted: 'PRIVATE_PROVIDER_PAYLOAD', verifiedAt: now, status: 'received' };
      const event = await ProviderEvent.create({ ...eventValues, publicId: `evt_new_cr_${suffix}`, eventId: `event_new_cr_${suffix}` }), forgedEvent = await ProviderEvent.create({ ...eventValues, publicId: `evt_forged_new_cr_${suffix}`, eventId: `event_forged_new_cr_${suffix}`, providerTrackingId: 'PRIVATE_FORGED_TRACKING' });
      const run = await ReconciliationRun.create({ publicId: `rec_new_cr_${suffix}`, country: 'UG', currency: 'UGX', provider: 'pesapal', startedByUserId: owner.user._id, status: 'completed', startedAt: now, completedAt: now });
      const campaign = await Campaign.create({ publicId: `cam_new_cr_${suffix}`, scope: 'seller', ownerUserId: stores.UG.ownerUserId, storeId: stores.UG._id, country: 'UG', name: 'PRIVATE_AFFILIATE_NAME', status: 'active' });
      const forgedCampaign = await Campaign.create({ publicId: `cam_forged_new_cr_${suffix}`, scope: 'seller', ownerUserId: stores.KE.ownerUserId, storeId: stores.KE._id, country: 'UG', name: 'PRIVATE_FORGED_AFFILIATE', status: 'active' });
      const records = [
        ['refund', `ref_cr_${suffix}_pending`, 'finance.refund_submission_failed'], ['return', returned.publicId, 'finance.return_refund_completed'], ['return', returned.publicId, 'support.return_exchanged'],
        ['evidence', evidence.publicId, 'admin.commerce_evidence_opened'], ['provider_event', event.publicId, 'finance.provider_event_requeued'], ['reconciliation_run', run.publicId, 'finance.reconciliation_started'], ['campaign', campaign.publicId, 'country_admin.affiliate_campaign_decided'],
      ];
      for (const [index, [targetType, targetPublicId, action]] of [...records, ['evidence', detached.publicId, 'admin.commerce_evidence_opened'], ['provider_event', forgedEvent.publicId, 'finance.provider_event_requeued'], ['campaign', forgedCampaign.publicId, 'country_admin.affiliate_campaign_decided']].entries()) await AuditLog.create({ requestId: `req_new_cr_${suffix}_${index}`, actorId: owner.user._id, actorPublicId: owner.user.publicId, action, targetType, targetPublicId, country: 'UG', result: 'success', metadata: { returnPublicId: returned.publicId, private: 'PRIVATE_AUDIT_PAYLOAD' } });
      const audit = await loadCountryAdminReportPage(scoped({ country: 'UG', report: 'audit', search: `req_new_cr_${suffix}` }), 'admin-reports'); assert.equal(audit.page.total, records.length); assert.deepEqual(new Set(audit.items.map(row => row.action)), new Set(records.map(row => row[2])));
      const opened = audit.items.find(row => row.action === 'admin.commerce_evidence_opened'); assert.equal(opened.targetType, 'return'); assert.equal(opened.targetPublicId, returned.publicId);
      for (const privateValue of [evidence.publicId, detached.publicId, forgedEvent.publicId, forgedCampaign.publicId, 'PRIVATE_PROVIDER_PAYLOAD', payment.providerReference, payment.providerTrackingId, 'PRIVATE_AUDIT_PAYLOAD', 'PRIVATE_RETURN_DETAILS']) assert.ok(!JSON.stringify(audit).includes(privateValue), privateValue);
    });
    await t.test('personal identity counts and seller backlog match the actionable source queues', async () => {
      const staffMirror = await actor(), merchantPromoter = await actor('promoter');
      await PlatformGrant.create({ publicId: `pgr_mirror_cr_${suffix}`, userId: staffMirror.user._id, role: 'support', operationalCountries: ['UG'], status: 'expired', startsAt: new Date(now.getTime() - 86400_000), expiresAt: new Date(now.getTime() - 3600_000), reason: 'Historical platform identity remains outside personal account administration.', approvalPublicId: `apr_mirror_cr_${suffix}`, approvedByUserId: owner.user._id });
      await StoreMember.create({ publicId: `stm_cr_${suffix}`, userId: merchantPromoter.user._id, storeId: stores.UG._id, role: 'support', status: 'invited', invitedByUserId: stores.UG.ownerUserId });
      await PromoterVerification.create({ publicId: `prv_merchant_cr_${suffix}`, userId: merchantPromoter.user._id, country: 'UG', status: 'submitted', submittedAt: now });
      await SellerVerification.create({ publicId: `svr_unactionable_cr_${suffix}`, storeId: stores.KE._id, userId: stores.KE.ownerUserId, sellerType: 'individual', legalName: 'PRIVATE_UNACTIONABLE_LEGAL_NAME', status: 'submitted', submittedAt: now });
      const summary = await loadCountryAdminReportPage(scoped(), 'admin-overview'); assert.equal(summary.summary.customerCount, 2); assert.equal(summary.summary.promoterCount, 1); assert.equal(summary.summary.promoterVerificationCount, 1); assert.equal(summary.summary.sellerVerificationCount, 1);
      for (const value of ['prv_merchant_cr_' + suffix, 'svr_unactionable_cr_' + suffix]) { const queue = await loadCountryAdminReportPage(scoped({ report: 'operational', search: value }), 'admin-reports'); assert.equal(queue.page.total, 0); }
    });
    const output = () => { const response = new EventEmitter(); response.destroyed = false; response.chunks = []; response.set = () => response; response.write = chunk => { response.chunks.push(chunk); return true; }; response.end = () => { response.ended = true; }; return response; };
    await t.test('export audit failure rolls actor, grant and market fences back and emits no response', async () => {
      const beforeActor = await User.findById(owner.user._id), beforeGrant = await PlatformGrant.findById(owner.grant._id), beforeMarkets = await CountrySetting.find({ code: { $in: ['UG', 'KE'] } }).sort({ code: 1 }), audits = await AuditLog.countDocuments(), originalCreate = AuditLog.create, response = output();
      AuditLog.create = function (documents, ...args) { if ((Array.isArray(documents) ? documents : [documents]).some(row => row.action === 'country_admin.report_exported')) throw new Error('Injected country report audit failure'); return originalCreate.call(this, documents, ...args); };
      try { await assert.rejects(streamCountryAdminReportCsv(scoped(), response, 'admin-reports'), /Injected country report audit failure/); } finally { AuditLog.create = originalCreate; }
      assert.equal(response.chunks.length, 0); assert.equal(response.ended, undefined); assert.equal(await AuditLog.countDocuments(), audits); assert.equal((await User.findById(owner.user._id)).__v, beforeActor.__v); assert.equal((await PlatformGrant.findById(owner.grant._id)).__v, beforeGrant.__v); assert.deepEqual((await CountrySetting.find({ code: { $in: ['UG', 'KE'] } }).sort({ code: 1 })).map(row => row.__v), beforeMarkets.map(row => row.__v));
    });
    await t.test('closed exports and source-query errors produce no success audit or response', async () => {
      const count = await AuditLog.countDocuments(), closed = output(); closed.destroyed = true; await assert.rejects(streamCountryAdminReportCsv(scoped(), closed, 'admin-reports'), error => error.code === 'EXPORT_CLOSED'); assert.equal(await AuditLog.countDocuments(), count);
      const originalAggregate = Product.aggregate, response = output(); Product.aggregate = function () { throw new Error('Injected source product join failure'); }; try { await assert.rejects(streamCountryAdminReportCsv(scoped({ report: 'operational' }), response, 'admin-reports'), /Injected source product join failure/); } finally { Product.aggregate = originalAggregate; } assert.equal(await AuditLog.countDocuments(), count); assert.equal(response.chunks.length, 0);
    });
    await t.test('streaming honors backpressure and stops on changed grant, device or market before another row', async () => {
      for (const mutation of [() => PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { status: 'revoked' } }), () => CountrySetting.updateOne({ code: 'UG' }, { $set: { timeZone: 'UTC' } })]) {
        const response = output(); response.write = chunk => { response.chunks.push(chunk); if (response.chunks.length === 2) { Promise.resolve(mutation()).then(() => response.emit('drain'), error => response.emit('error', error)); return false; } return true; };
        try { await assert.rejects(streamCountryAdminReportCsv(scoped({ report: 'operational' }), response, 'admin-reports'), error => [403, 409].includes(error.status)); assert.equal(response.chunks.length, 2); assert.equal(response.ended, undefined); } finally { await PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { status: 'active' } }); await CountrySetting.updateOne({ code: 'UG' }, { $set: { timeZone: 'Africa/Kampala' } }); }
      }
      const response = output(); response.write = chunk => { response.chunks.push(chunk); response.destroyed = true; queueMicrotask(() => response.emit('close')); return false; }; await assert.rejects(streamCountryAdminReportCsv(scoped({ report: 'operational' }), response, 'admin-reports'), error => error.code === 'EXPORT_CLOSED'); assert.equal(response.chunks.length, 1); assert.equal(response.ended, undefined);
    });
    await t.test('current primary role, grant, MFA, token and saved country calendar govern reporting', async () => {
      await assert.rejects(loadCountryAdminReportPage(scoped({}, customer), 'admin-reports'), error => error.status === 403);
      await User.updateOne({ _id: owner.user._id }, { $set: { 'security.mfaEnabled': false } }); await assert.rejects(loadCountryAdminReportPage(scoped(), 'admin-reports'), error => error.code === 'MFA_ENROLLMENT_REQUIRED'); await User.updateOne({ _id: owner.user._id }, { $set: { 'security.mfaEnabled': true } });
      await PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { status: 'revoked' } }); await assert.rejects(loadCountryAdminReportPage(scoped(), 'admin-reports'), error => error.status === 403); await owner.client.get('/admin/reports').set('Accept', 'application/json').expect(403); await PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { status: 'active' } });
      await User.updateOne({ _id: owner.user._id }, { $set: { 'preferences.countryAdminReportingPeriod': 'year', 'preferences.countryAdminDefaultCountry': 'UG' } }); const preferred = await loadCountryAdminReportPage(scoped(), 'admin-overview'); assert.equal(preferred.period, 'year'); assert.equal(preferred.country, 'UG'); assert.equal(preferred.timeZone, 'Africa/Kampala'); assert.equal(preferred.context.currency, 'UGX');
      await User.updateOne({ _id: owner.user._id }, { $inc: { 'security.tokenVersion': 1 } }); await assert.rejects(loadCountryAdminReportPage(scoped(), 'admin-reports'), error => error.code === 'ACCOUNT_UNAVAILABLE');
    });
  } finally { for (const transport of transports) transport.destroy(); try { await Promise.all(Object.values(mongoose.models).map(Model => Model.init())); await mongoose.connection.dropDatabase(); } finally { await mongoose.disconnect(); } }
});

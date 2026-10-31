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
for (const name of ['SESSION_SECRET', 'TOKEN_PEPPER', 'SECURITY_INTEGRITY_KEY', 'DATA_ENCRYPTION_KEY']) process.env[name] = crypto.randomBytes(32).toString('hex');
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;
const csrf = html => {
  const token = html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/);
  assert.ok(token, 'The real page must provide a CSRF token.');
  return token[1];
};

test('all ten Finance destinations use current grants, real MFA and the approved responsive workspace', { skip: !uri, timeout: 300_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex'), transports = [];
  await mongoose.connect(uri, { dbName: `classicmart_finance_navigation_test_${suffix}` });
  let server, browser;
  try {
    const { createApp } = await import('../src/app.js');
    const { User, Store, CountrySetting, PlatformGrant, PaymentIntent, Order, Refund, Payout, PayoutAccount, Chargeback,
      ReconciliationRun, AuditLog, LedgerAccount, LoyaltyAccount } = await import('../src/models/index.js');
    const { hashPassword } = await import('../src/core/crypto.js');
    const { beginMfaEnrollment, confirmMfaEnrollment, pendingMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
    const { FINANCE_LIVE_ROUTES } = await import('../src/dashboard/finance-routes.js');
    await Promise.all(Object.values(mongoose.models).map(Model => Model.init()));
    await CountrySetting.create([
      { code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254', active: true },
      { code: 'TZ', name: 'Unassigned Finance navigation market', currency: 'TZS', locale: 'en-TZ', timeZone: 'Africa/Dar_es_Salaam', phonePrefix: '+255', active: true },
    ]);
    const password = `Finance-Navigation-${suffix}-A1!`, passwordHash = await hashPassword(password), app = createApp(null);
    let sequence = 0;
    async function actor(role, { managed = false, enroll = false, countries = ['UG', 'KE'] } = {}) {
      const index = ++sequence, email = `finance-navigation-${suffix}-${index}@example.com`, phone = '+25670' + String(index).padStart(7, '0');
      const user = await User.create({ publicId: `usr_fnav_${suffix}_${index}`, name: `Navigation Finance Actor ${index}`, email, emailNormalized: email,
        phone, phoneNormalized: phone, passwordHash, role, country: 'UG', currency: 'UGX', shoppingCountry: 'TZ', operationalCountries: countries,
        platformAccessManagedAt: managed ? new Date() : undefined, emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
        consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const grant = managed ? await PlatformGrant.create({ publicId: `pgr_fnav_${suffix}_${index}`, userId: user._id, role: 'finance', operationalCountries: countries,
        status: 'active', startsAt: new Date(Date.now() - 60000), expiresAt: new Date(Date.now() + 86400000), reason: 'Isolated Finance workspace navigation verification.',
        approvalPublicId: `apr_fnav_${suffix}_${index}`, approvedByUserId: new mongoose.Types.ObjectId() }) : null;
      let secret, codes;
      if (enroll) {
        const enrollment = await beginMfaEnrollment(user._id, password); secret = enrollment.secret;
        // Enrollment accepts the immediately previous authenticator window. The real
        // login below consumes the current code, exercising replay protection without sleeps.
        const confirmed = await confirmMfaEnrollment(user._id, totpCode(secret, { time: Date.now() - 30000 })); codes = confirmed.codes;
      }
      return { user, grant, secret, codes };
    }
    function agent() {
      const transport = new http.Agent({ localAddress: `127.0.0.${transports.length + 110}`, keepAlive: false }); transports.push(transport);
      return request.agent(app).use(req => req.agent(transport));
    }
    async function login(entry, { challenge = true } = {}) {
      const client = agent(), form = await client.get('/login').expect(200);
      const response = await client.post('/login').type('form').send({ email: entry.user.email, password, _csrf: csrf(form.text) }).expect(302);
      if (challenge) {
        assert.equal(response.headers.location, '/mfa');
        const challengePage = await client.get('/mfa').expect(200);
        await client.post('/mfa').type('form').send({ code: totpCode(entry.secret), _csrf: csrf(challengePage.text) }).expect(302);
      }
      return { client, response };
    }
    const owner = await actor('customer', { managed: true });
    const initial = await login(owner, { challenge: false }), client = initial.client;
    assert.equal(initial.response.headers.location, '/finance/overview', 'The active Finance grant controls landing despite a customer compatibility mirror.');
    const securityPath = '/account/security?next=%2Ffinance%2Foverview';

    await t.test('real enrollment preserves Finance continuation, recovery codes and the current grant', async () => {
      await client.get('/finance/overview').expect(302).expect('location', securityPath);
      await client.get('/finance/overview').set('Accept', 'application/json').expect(403);
      let page = await client.get(securityPath).expect(200);
      assert.match(page.text, /data-dashboard-workspace="finance"/);
      assert.match(page.text, /name="next" value="\/finance\/overview"/);
      await client.post('/account/mfa/begin').type('form').send({ currentPassword: password, next: '/finance/overview' }).expect(403);
      assert.equal(await pendingMfaEnrollment(owner.user._id), null);
      await client.post('/account/mfa/begin').type('form').send({ currentPassword: password, next: '/finance/overview', _csrf: csrf(page.text) })
        .expect(302).expect('location', securityPath);
      const enrollment = await pendingMfaEnrollment(owner.user._id); owner.secret = enrollment.secret;
      page = await client.get(securityPath).expect(200);
      await client.post('/account/mfa/confirm').type('form').send({ code: 'invalid', next: '/finance/overview', _csrf: csrf(page.text) }).expect(302).expect('location', securityPath);
      assert.equal((await User.findById(owner.user._id)).security.mfaEnabled, false);
      page = await client.get(securityPath).expect(200);
      owner.enrollmentCode = totpCode(owner.secret, { time: Date.now() - 30000 });
      await client.post('/account/mfa/confirm').type('form').send({ code: owner.enrollmentCode, next: '/finance/overview', _csrf: csrf(page.text) })
        .expect(302).expect('location', securityPath);
      page = await client.get(securityPath).expect(200);
      assert.match(page.text, /href="\/finance\/overview">Continue to Finance workspace<\/a>/);
      owner.codes = [...page.text.matchAll(/<code>([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})<\/code>/g)].map(match => match[1]);
      assert.equal(owner.codes.length, 10);
      assert.equal((await User.findById(owner.user._id)).role, 'customer', 'Enrollment does not rewrite the account identity mirror.');
      assert.equal(await Store.countDocuments({ ownerUserId: owner.user._id }), 0);
      const repeat = await client.get(securityPath).expect(200);
      assert.equal([...repeat.text.matchAll(/<code>([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})<\/code>/g)].length, 0);
      await client.post('/logout').type('form').send({ _csrf: csrf(repeat.text) }).expect(302);
      const loginPage = await client.get('/login').expect(200);
      await client.post('/login').type('form').send({ email: owner.user.email, password, _csrf: csrf(loginPage.text) }).expect(302).expect('location', '/mfa');
      const challenge = await client.get('/mfa').expect(200);
      await client.post('/mfa').type('form').send({ code: owner.enrollmentCode, _csrf: csrf(challenge.text) }).expect(422);
      await client.post('/mfa').type('form').send({ code: totpCode(owner.secret), _csrf: csrf(challenge.text) }).expect(302).expect('location', '/finance/overview');
    });

    const payoutOwner = await actor('promoter');
    const now = new Date(), fixtures = {};
    for (const [country, currency, amountMinor] of [['UG', 'UGX', 12000], ['KE', 'KES', 3400], ['TZ', 'TZS', 990000]]) {
      const orderId = new mongoose.Types.ObjectId(), orderPublicId = `ord_fnav_${country.toLowerCase()}_${suffix}_persisted_order_reference`;
      await Order.collection.insertOne({ _id: orderId, publicId: orderPublicId, country, sessionKey: `fnav_order_${country}_${suffix}`,
        idempotencyKey: `fnav-order-${country}-${suffix}`, totals: { currency, totalMinor: amountMinor }, createdAt: now,
        paymentState: 'paid', status: 'paid', fulfillmentState: 'delivered', refundState: 'none', contact: { email: 'FINANCE_BUYER_PRIVATE', phone: 'FINANCE_PHONE_PRIVATE' } });
      const payment = await PaymentIntent.create({ publicId: `pay_fnav_${country.toLowerCase()}_${suffix}_persisted_payment_reference`, orderId, orderPublicId, country, currency,
        idempotencyKey: `payment_fnav_${country}_${suffix}`, provider: 'pesapal', method: 'pesapal', status: 'succeeded', amountMinor, paidAt: now, providerTrackingId: `tracking_fnav_${country}_${suffix}` });
      const refund = await Refund.create({ publicId: `rfd_fnav_${country.toLowerCase()}_${suffix}_persisted_refund_reference`, idempotencyKey: `refund_fnav_${country}_${suffix}`,
        orderId, paymentIntentId: payment._id, amountMinor: 100, currency, reason: 'Persisted navigation refund', provider: 'external_manual', status: 'completed', completedAt: now });
      const account = await PayoutAccount.create({ publicId: `poa_fnav_${country.toLowerCase()}_${suffix}`, ownerUserId: payoutOwner.user._id, ownerType: 'promoter', country, currency,
        method: 'bank', label: 'Persisted programme destination', destinationEncrypted: 'FINANCE_DESTINATION_CIPHERTEXT_PRIVATE', status: 'verified', verifiedAt: now });
      const payout = await Payout.create({ publicId: `pyo_fnav_${country.toLowerCase()}_${suffix}_persisted_payout_reference`, idempotencyKey: `payout_fnav_${country}_${suffix}`,
        ownerUserId: payoutOwner.user._id, requestedByUserId: payoutOwner.user._id, payoutAccountId: account._id, amountMinor: 300, currency, status: 'paid', completedAt: now });
      const run = await ReconciliationRun.create({ publicId: `rec_fnav_${country.toLowerCase()}_${suffix}_persisted_reconciliation_reference`, country, currency, provider: 'pesapal',
        startedByUserId: owner.user._id, status: 'completed', checked: 1, matched: 1, updated: 0, failed: 0, completedAt: now, errorMessages: ['FINANCE_RECONCILIATION_PRIVATE'] });
      const dispute = await Chargeback.create({ publicId: `cbk_fnav_${country.toLowerCase()}_${suffix}_persisted_dispute_reference`, orderId, orderPublicId, paymentIntentId: payment._id,
        paymentIntentPublicId: payment.publicId, country, currency, amountMinor, status: 'open', providerPayloadHash: 'FINANCE_PROVIDER_PAYLOAD_PRIVATE' });
      const auditTarget = `fnav_${country.toLowerCase()}_${suffix}_persisted_financial_audit_reference`;
      await AuditLog.create({ requestId: `req_fnav_${country}_${suffix}`, actorId: owner.user._id, actorPublicId: owner.user.publicId, action: 'finance.navigation_verified',
        targetType: 'finance_record', targetPublicId: auditTarget, country, result: 'success', metadata: { private: 'FINANCE_AUDIT_METADATA_PRIVATE' } });
      fixtures[country] = { payment, refund, payout, run, dispute, auditTarget };
    }

    await t.test('all ten private live pages have canonical aliases and approved Finance navigation', async () => {
      assert.equal(Object.keys(FINANCE_LIVE_ROUTES).length, 10);
      for (const [id, href] of Object.entries(FINANCE_LIVE_ROUTES)) {
        const page = await client.get(href).set('Accept', 'text/html').expect(200);
        assert.match(page.text, /data-dashboard-workspace="finance"/);
        assert.ok(page.text.includes(`data-dashboard-page="${id}"`), id);
        assert.match(page.text, /finance-live\.css/);
        assert.doesNotMatch(page.text, /Development preview|Not available yet|id="roleSwitcher"|<h3>Classic Club<\/h3>|FINANCE_(?:DESTINATION_CIPHERTEXT|AUDIT_METADATA|PROVIDER_PAYLOAD|BUYER|PHONE)_PRIVATE/);
        assert.match(page.headers['cache-control'], /no-store/);
        assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
        await client.get('/dashboard/' + id + '?country=UG&search=retained%20query').expect(308).expect('location', href + '?country=UG&search=retained%20query');
      }
    });

    await t.test('country filters retain separate currency groups and reject foreign or ambiguous scope', async () => {
      const overview = (await client.get('/finance/overview').set('Accept', 'application/json').expect(200)).body;
      assert.deepEqual(overview.context.countries.map(row => row.code).sort(), ['KE', 'UG']);
      assert.deepEqual(overview.groups.map(row => [row.country, row.currency, row.capturedMinor]), [['KE', 'KES', 3400], ['UG', 'UGX', 12000]]);
      for (const href of ['/finance/payments', '/finance/refunds', '/finance/payouts', '/finance/reconciliation', '/finance/disputes', '/finance/reports', '/finance/audit']) {
        const response = await client.get(href + '?country=UG').set('Accept', 'application/json').expect(200);
        assert.equal(response.body.context.country, 'UG'); assert.equal(response.body.context.currency, 'UGX');
        const text = JSON.stringify(response.body);
        for (const record of Object.values(fixtures.TZ)) assert.ok(!text.includes(typeof record === 'string' ? record : record.publicId), href + ' unassigned record');
        for (const record of Object.values(fixtures.KE)) assert.ok(!text.includes(typeof record === 'string' ? record : record.publicId), href + ' selected-country record');
        await client.get(href + '?country=TZ').set('Accept', 'application/json').expect(403);
      }
      await client.get('/finance/payments?country=UG&country=KE').set('Accept', 'application/json').expect(422);
      await client.get('/finance/reports?country[bad]=UG').set('Accept', 'application/json').expect(422);
      const reports = await client.get('/finance/reports?country=UG&report=payments').set('Accept', 'application/json').expect(200);
      assert.ok(reports.body.rows.some(row => row.id === fixtures.UG.payment.publicId));
      assert.equal(await LedgerAccount.countDocuments({ ownerType: 'customer', ownerPublicId: owner.user.publicId }), 0);
      assert.equal(await LoyaltyAccount.countDocuments({ userId: owner.user._id }), 0);
    });

    await t.test('other primary workspaces cannot render any Finance page even with administrative finance permissions', async () => {
      for (const role of ['customer', 'seller', 'promoter', 'country_admin', 'super_admin']) {
        const other = await actor(role, { enroll: true, countries: role === 'super_admin' ? ['*'] : ['UG', 'KE'] });
        const { client: otherClient } = await login(other);
        for (const href of Object.values(FINANCE_LIVE_ROUTES)) await otherClient.get(href).set('Accept', 'application/json').expect(403);
        assert.equal(await Store.countDocuments({ ownerUserId: other.user._id }), 0, role + ' read does not provision a store.');
      }
    });

    await t.test('personal account pages keep all ten Finance menu destinations and real account security', async () => {
      for (const href of ['/account/security', '/account/messages']) {
        const page = await client.get(href).expect(200);
        assert.match(page.text, /data-dashboard-workspace="finance"/);
        assert.doesNotMatch(page.text, /<h3>Classic Club<\/h3>|id="roleSwitcher"|Development preview/);
        for (const destination of Object.values(FINANCE_LIVE_ROUTES)) assert.ok(page.text.includes(`href="${destination}"`), href + ':' + destination);
      }
      assert.equal(await Store.countDocuments({ ownerUserId: owner.user._id }), 0);
      assert.equal(await LedgerAccount.countDocuments({ ownerType: 'customer', ownerPublicId: owner.user.publicId }), 0);
    });

    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    for (const width of [1366, 390]) await t.test(`all approved Finance pages and settings sections show readable actual records at ${width}px`, async () => {
      const browserActor = await actor('customer', { managed: true, enroll: true });
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      try {
        const page = await context.newPage();
        await page.goto(base + '/login');
        await page.locator('input[name="email"]').fill(browserActor.user.email);
        await page.locator('input[name="password"]').fill(password);
        await Promise.all([page.waitForURL(base + '/mfa'), page.locator('form[action="/login"] button[type="submit"]').click()]);
        await page.locator('form[action="/mfa"] input[name="code"]').fill(totpCode(browserActor.secret));
        await Promise.all([page.waitForURL(base + '/finance/overview'), page.locator('form[action="/mfa"] button[type="submit"]').click()]);
        for (const [id, href] of Object.entries(FINANCE_LIVE_ROUTES)) {
          const response = await page.goto(base + href + (id === 'finance-reports' ? '?country=UG&report=payments' : '?country=UG'));
          assert.equal(response.status(), 200, href);
          assert.equal(await page.locator('body').getAttribute('data-dashboard-workspace'), 'finance');
          assert.equal(await page.locator('body').getAttribute('data-dashboard-page'), id);
          assert.equal(await page.locator('.side-navigation a[href^="/finance/"]').count(), 10);
          assert.equal(await page.locator('#roleSwitcher').count(), 0);
          const layout = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
            overflowing: [...document.querySelectorAll('.role-page *')].map(node => { const box = node.getBoundingClientRect(); return { tag: node.tagName, classes: node.className,
              right: Math.round(box.right), width: Math.round(box.width), text: node.textContent.trim().slice(0, 100) }; }).filter(node => node.width > 0 && node.right > innerWidth + 1).slice(0, 8) }));
          if (layout.scrollWidth > width + 1) await page.screenshot({ path: `/tmp/classicmart-${id}-${width}-overflow.png`, fullPage: true, animations: 'disabled' });
          assert.ok(layout.scrollWidth <= width + 1, href + ' page overflow: ' + JSON.stringify(layout));
          assert.equal(await page.locator('.role-page h1').isVisible(), true, href + ' heading');
          if (id === 'finance-settings') {
            assert.equal(await page.locator('.role-settings-nav a').count(), 5);
            for (const section of ['profile', 'business', 'payments', 'notifications', 'security']) {
              const tab = page.locator(`.role-settings-nav a[href*="section=${section}"]`);
              assert.equal(await tab.count(), 1, 'Real settings section: ' + section);
              await tab.scrollIntoViewIfNeeded();
              await Promise.all([page.waitForNavigation(), tab.click()]);
              assert.equal(new URL(page.url()).searchParams.get('section'), section);
              assert.equal(await page.locator('.role-settings-panel.active').count(), 1);
              assert.equal(await page.locator('.role-settings-panel.active').isVisible(), true);
              assert.equal(await page.locator('.role-settings-panel.active').getAttribute('data-role-settings-panel'), section);
              assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Finance settings ' + section + ' overflow');
            }
          } else {
            assert.equal(await page.locator('.role-metric-grid .role-metric').count(), 4, href + ' metrics');
            assert.equal(await page.locator('.role-metric-grid').evaluate(node => getComputedStyle(node).gap), width === 1366 ? '12px' : '9px');
            if (id === 'finance-overview') {
              assert.equal(await page.locator('.role-welcome').count(), 1); assert.equal(await page.locator('.role-overview-grid').count(), 1); assert.equal(await page.locator('.role-bottom-grid').count(), 1);
              const status = await page.locator('.role-welcome-score strong').evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth,
                height: node.getBoundingClientRect().height, lineHeight: Number.parseFloat(getComputedStyle(node).lineHeight) }));
              assert.ok(status.scrollWidth <= status.width + 1, 'Finance control status stays inside its approved circle.');
              assert.ok(status.height <= status.lineHeight + 1, 'Finance control status remains on one readable line.');
            } else {
              assert.equal(await page.locator('.role-content-grid').count(), 1);
              assert.equal(await page.locator('.role-progress-card').count(), 1); assert.equal(await page.locator('.role-activity-panel').count(), 1);
              if (width === 1366) assert.match(await page.locator('.role-content-grid').evaluate(node => getComputedStyle(node).gridTemplateColumns), /292px$/);
            }
          }
          const recordValue = ({ 'finance-payments': fixtures.UG.payment.publicId, 'finance-refunds': fixtures.UG.refund.publicId,
            'finance-payouts': fixtures.UG.payout.publicId, 'finance-reconciliation': fixtures.UG.run.publicId, 'finance-disputes': fixtures.UG.dispute.publicId,
            'finance-reports': fixtures.UG.payment.publicId, 'finance-audit': fixtures.UG.auditTarget })[id];
          if (recordValue) {
            const record = page.locator('.role-table tbody td').filter({ hasText: recordValue }).first();
            assert.equal(await record.count(), 1, href + ' actual persisted sample'); assert.equal(await record.isVisible(), true);
            if (width === 390) {
              const readability = await record.evaluate(node => { const box = node.getBoundingClientRect(), style = getComputedStyle(node); return { width: box.width,
                height: box.height, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, whiteSpace: style.whiteSpace }; });
              assert.ok(readability.width > 200 && readability.height >= 20, href + ' mobile record uses readable card space');
              assert.ok(readability.scrollWidth <= readability.clientWidth + 1, href + ' full record text wraps without clipping');
              assert.notEqual(readability.whiteSpace, 'nowrap');
            }
          }
          if (['finance-overview', 'finance-payments', 'finance-payouts', 'finance-settings'].includes(id)) await page.screenshot({ path: `/tmp/classicmart-${id}-${width}.png`, fullPage: true, animations: 'disabled' });
        }
        await page.goto(base + '/account/security');
        assert.equal(await page.locator('body').getAttribute('data-dashboard-workspace'), 'finance');
        assert.equal(await page.locator('.side-navigation a[href^="/finance/"]').count(), 10);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Finance personal security overflow');
        assert.equal((await User.findById(browserActor.user._id)).role, 'customer');
        assert.equal(await LedgerAccount.countDocuments({ ownerType: 'customer', ownerPublicId: browserActor.user.publicId }), 0);
      } finally { await context.close(); }
    });

    await t.test('grant scope changes and revocation take effect in the existing authenticated session', async () => {
      const { loadFinanceReportPage } = await import('../src/services/finance-report-pages.js');
      const { renderFinancePage } = await import('../src/dashboard/finance-page-view.js');
      const currentActor = await User.findById(owner.user._id);
      const readRequest = { user: currentActor, session: { tokenVersion: currentActor.security.tokenVersion }, query: {}, accepts: () => 'json' };
      const oldReport = await loadFinanceReportPage(readRequest, 'finance-overview');
      assert.ok(oldReport.groups.some(row => row.country === 'KE'), 'The report snapshot initially contains an authorized Kenya group.');
      await PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { operationalCountries: ['UG'] } });
      await assert.rejects(renderFinancePage(readRequest, { json: () => assert.fail('A report loaded before scope narrowing must not be sent.') }, 'finance-overview', oldReport),
        error => [403, 409].includes(error.status), 'Final rendering must reject financial rows produced under an obsolete broader grant.');
      const scoped = (await client.get('/finance/overview').set('Accept', 'application/json').expect(200)).body;
      assert.deepEqual(scoped.context.countries.map(row => row.code), ['UG']);
      assert.equal(scoped.groups.length, 1); assert.equal(scoped.groups[0].currency, 'UGX');
      for (const href of Object.values(FINANCE_LIVE_ROUTES)) await client.get(href + '?country=KE').set('Accept', 'application/json').expect(403);
      await PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { status: 'revoked', revokedAt: new Date() } });
      await User.updateOne({ _id: owner.user._id }, { $set: { role: 'finance' } });
      for (const href of Object.values(FINANCE_LIVE_ROUTES)) await client.get(href).set('Accept', 'application/json').expect(403);
      const account = await client.get('/account/security').expect(200);
      assert.match(account.text, /data-dashboard-workspace="customer"/);
      assert.ok(!account.text.includes('href="/finance/overview"'), 'A revoked Finance mirror does not preserve Finance navigation.');
      assert.equal(await Store.countDocuments({ ownerUserId: owner.user._id }), 0);
    });
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    for (const transport of transports) transport.destroy();
    try { await Promise.all(Object.values(mongoose.models).map(Model => Model.init())); await mongoose.connection.dropDatabase(); }
    finally { await mongoose.disconnect(); }
  }
});

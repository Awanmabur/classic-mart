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
for (const name of ['SESSION_SECRET', 'TOKEN_PEPPER', 'SECURITY_INTEGRITY_KEY', 'DATA_ENCRYPTION_KEY']) {
  process.env[name] = crypto.randomBytes(32).toString('hex');
}
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;
const csrf = html => {
  const token = html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/);
  assert.ok(token, 'The real login page must supply a CSRF token.');
  return token[1];
};

test('all Promoter navigation destinations preserve the approved UI and personal workspace isolation', { skip: !uri, timeout: 240_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: `classicmart_promoter_navigation_test_${suffix}` });
  let server, browser;
  const transports = [];
  try {
    const { createApp } = await import('../src/app.js');
    const { User, Store, StoreMember, CountrySetting, Product, Category, ProductVariant, Campaign, CampaignApplication,
      PromoterVerification, PromoterLink, AttributionTouch, CommissionEntry, LedgerAccount, LoyaltyAccount, Order, AiJob } = await import('../src/models/index.js');
    const { hashPassword } = await import('../src/core/crypto.js');
    const { PROMOTER_LIVE_ROUTES } = await import('../src/dashboard/promoter-routes.js');
    const { ensureLedgerAccount, postLedgerTransaction } = await import('../src/services/money.js');
    // Model initialization also starts background indexes in unrelated imported models.
    // Let them finish before fixtures and, later, before dropping this private database.
    await Promise.all(Object.values(mongoose.models).map(model => model.init()));
    await CountrySetting.create([
      { code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254', active: true },
    ]);
    const password = `Navigation-${suffix}-A1!`, passwordHash = await hashPassword(password);
    let sequence = 0;
    async function actor(role, extras = {}) {
      const index = ++sequence, email = `promoter-navigation-${suffix}-${index}@example.com`, phone = '+25670' + String(index).padStart(7, '0');
      return User.create({ publicId: `usr_pnav_${suffix}_${index}`, name: role === 'promoter' ? 'Navigation Promoter' : `Navigation ${role}`,
        email, emailNormalized: email, phone, phoneNormalized: phone, passwordHash, role, country: 'UG', currency: 'UGX', locale: 'en-UG',
        emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), consents: { terms: true, privacy: true, recordedAt: new Date() }, ...extras });
    }
    const promoter = await actor('promoter', { shoppingCountry: 'KE', currency: 'KES' });
    const seller = await actor('seller'), customer = await actor('customer'), administrator = await actor('super_admin');
    await PromoterVerification.create({ publicId: `prv_pnav_${suffix}`, userId: promoter._id, country: 'UG', status: 'verified',
      channels: ['whatsapp'], niches: ['Home'], audienceSize: 1200, audienceLocation: 'Kampala', disclosureAcceptedAt: new Date() });
    const storeName = 'Navigation verified seller with a real approved campaign';
    const store = await Store.create({ publicId: `str_pnav_${suffix}`, ownerUserId: seller._id, name: storeName, slug: `promoter-navigation-${suffix}`,
      country: 'UG', currency: 'UGX', status: 'verified', verifiedAt: new Date() });
    await StoreMember.create({ publicId: `stm_pnav_${suffix}`, storeId: store._id, userId: seller._id, role: 'owner', status: 'active', invitedByUserId: seller._id, acceptedAt: new Date() });
    const category = await Category.create({ publicId: `cat_pnav_${suffix}`, name: 'Navigation category', slug: `promoter-navigation-${suffix}`, active: true, countries: ['UG'] });
    const product = await Product.create({ publicId: `prd_pnav_${suffix}`, ownerUserId: seller._id, storeId: store._id, categoryId: category._id,
      title: 'Approved navigation product', slug: `approved-navigation-${suffix}`, description: 'A persisted approved product for the real campaign workspace.', countries: ['UG'], status: 'published', publishedAt: new Date() });
    await ProductVariant.create({ publicId: `var_pnav_${suffix}`, storeId: store._id, productId: product._id, sku: `PNAV-${suffix}`, title: 'Standard', priceMinor: 12000, currency: 'UGX' });
    const campaignName = 'Navigation campaign with an approved product and persisted tracking records';
    const campaign = await Campaign.create({ publicId: `cmp_pnav_${suffix}`, scope: 'seller', ownerUserId: seller._id, storeId: store._id, country: 'UG',
      name: campaignName, status: 'active', commissionBps: 500, productPublicIds: [product.publicId], allowedChannels: ['whatsapp'], facts: ['Approved navigation product.'] });
    await CampaignApplication.create({ publicId: `cap_pnav_${suffix}`, campaignId: campaign._id, campaignPublicId: campaign.publicId,
      promoterUserId: promoter._id, country: 'UG', status: 'approved', reviewedAt: new Date() });
    const longLinkId = `plk_pnav_${suffix}_` + 'persisted_link_reference_'.repeat(2);
    const link = await PromoterLink.create({ publicId: longLinkId, campaignId: campaign._id, promoterUserId: promoter._id,
      token: crypto.randomBytes(18).toString('base64url'), destination: '/products/' + product.publicId, channel: 'whatsapp' });
    const now = new Date();
    const touch = await AttributionTouch.create({ publicId: `tch_pnav_${suffix}`, campaignId: campaign._id, linkId: link._id, promoterUserId: promoter._id,
      country: 'UG', sessionKey: 'NAVIGATION_VISITOR_SESSION_PRIVATE', ipHash: 'NAVIGATION_IP_PRIVATE', userAgentHash: 'NAVIGATION_UA_PRIVATE',
      expiresAt: new Date(now.getTime() + 86400000), landedAt: now, status: 'converted' });
    const orderId = new mongoose.Types.ObjectId(), orderPublicId = `ord_pnav_${suffix}_` + 'persisted_order_reference_'.repeat(2);
    await Order.collection.insertOne({ _id: orderId, publicId: orderPublicId, country: 'UG', totals: { currency: 'UGX', totalMinor: 12000 },
      paymentState: 'paid', status: 'paid', fulfillmentState: 'delivered', refundState: 'none', createdAt: now,
      contact: { email: 'NAVIGATION_BUYER_EMAIL_PRIVATE', phone: 'NAVIGATION_BUYER_PHONE_PRIVATE' } });
    const commissionId = `com_pnav_${suffix}_` + 'persisted_commission_reference_'.repeat(2);
    const commission = await CommissionEntry.create({ publicId: commissionId, orderId, orderPublicId, campaignId: campaign._id, promoterUserId: promoter._id,
      touchId: touch._id, productPublicId: product.publicId, storePublicId: store.publicId, currency: 'UGX', amountMinor: 600,
      commissionBps: 500, policyVersion: 'navigation-fixture', status: 'payable', payableAt: now });
    const payable = await ensureLedgerAccount({ code: 'promoter_payable', type: 'liability', ownerType: 'promoter', ownerPublicId: String(promoter._id), country: 'UG', currency: 'UGX' });
    const cash = await ensureLedgerAccount({ code: 'navigation_cash', type: 'asset', ownerType: 'platform', ownerPublicId: 'classic-mart', country: 'UG', currency: 'UGX' });
    await postLedgerTransaction({ country: 'UG', currency: 'UGX', idempotencyKey: `navigation_ledger_${suffix}`, referenceType: 'commission',
      referencePublicId: commission.publicId, description: 'Persisted approved campaign commission', entries: [
        { account: cash, debitMinor: 600, creditMinor: 0 }, { account: payable, debitMinor: 0, creditMinor: 600 },
      ] });
    await AiJob.create({ publicId: `aij_pnav_${suffix}`, type: 'promoter_content', actorUserId: promoter._id, country: 'UG', status: 'completed',
      resultSchemaKey: 'promoter_content_kit', provider: 'deterministic', model: 'approved-campaign-facts', completedAt: now,
      result: { campaignId: campaign.publicId, campaignName, channel: 'whatsapp', caption: 'Approved product. Sponsored/affiliate promotion for Classic Mart.',
        disclosure: campaign.disclosureText, trackedUrl: '/r/' + link.token, linkPublicId: link.publicId, generator: 'approved-campaign-facts', assets: [] } });
    const app = createApp(null);
    async function login(user) {
      const transport = new http.Agent({ localAddress: `127.0.0.${transports.length + 10}`, keepAlive: false });
      transports.push(transport);
      const client = request.agent(app).use(req => req.agent(transport));
      const page = await client.get('/login').expect(200);
      const response = await client.post('/login').type('form').send({ email: user.email, password, _csrf: csrf(page.text) }).expect(302);
      return { client, response };
    }
    const authenticated = await login(promoter), client = authenticated.client;
    assert.equal(authenticated.response.headers.location, '/promoter/overview', 'A Promoter login must land in its own workspace.');

    await t.test('every Promoter menu destination uses a private live page and a canonical query-preserving alias', async () => {
      assert.equal(Object.keys(PROMOTER_LIVE_ROUTES).length, 15);
      for (const [id, href] of Object.entries(PROMOTER_LIVE_ROUTES)) {
        const page = await client.get(href).set('Accept', 'text/html').expect(200);
        assert.match(page.text, /data-dashboard-workspace="promoter"/);
        assert.ok(page.text.includes(`data-dashboard-page="${id}"`), id);
        assert.match(page.text, /promoter-live\.css/);
        assert.doesNotMatch(page.text, /Development preview|Not available yet|id="roleSwitcher"|<h3>Classic Club<\/h3>|NAVIGATION_(?:BUYER_EMAIL|BUYER_PHONE|VISITOR_SESSION|IP|UA)_PRIVATE/);
        assert.match(page.headers['cache-control'], /no-store/);
        assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
        const alias = await client.get('/dashboard/' + id + '?search=retained%20query').expect(308);
        assert.equal(alias.headers.location, href + '?search=retained%20query');
      }
    });

    await t.test('campaign, finance and profile data use the programme market instead of shopping preferences', async () => {
      const overview = (await client.get('/promoter/overview').set('Accept', 'application/json').expect(200)).body;
      assert.equal(overview.market.country, 'UG'); assert.equal(overview.currency, 'UGX'); assert.equal(overview.availableMinor, 600);
      assert.equal(overview.activeCampaigns, 1); assert.equal(overview.analytics.eligibleVisits, 1);
      const campaigns = (await client.get('/promoter/campaigns').set('Accept', 'application/json').expect(200)).body;
      assert.equal(campaigns.market.country, 'UG'); assert.ok(campaigns.rows.some(row => row.id === campaign.publicId));
      const links = (await client.get('/promoter/links').set('Accept', 'application/json').expect(200)).body;
      assert.ok(links.rows.some(row => row.id === longLinkId));
      const commissions = (await client.get('/promoter/commissions').set('Accept', 'application/json').expect(200)).body;
      assert.equal(commissions.currency, 'UGX'); assert.ok(commissions.rows.some(row => row.id === commissionId));
      assert.equal(await LedgerAccount.countDocuments({ code: 'customer_wallet', ownerType: 'customer', ownerPublicId: promoter.publicId }), 0);
      assert.equal(await LoyaltyAccount.countDocuments({ userId: promoter._id }), 0);
    });

    await t.test('customer, Seller and platform accounts cannot enter any canonical Promoter page', async () => {
      for (const user of [customer, seller, administrator]) {
        const other = await login(user);
        const before = await Store.countDocuments({ ownerUserId: user._id });
        for (const href of Object.values(PROMOTER_LIVE_ROUTES)) {
          await other.client.get(href).set('Accept', 'application/json').expect(403);
        }
        assert.equal(await Store.countDocuments({ ownerUserId: user._id }), before, user.role + ' reads must not provision a store.');
      }
      assert.equal(await Store.countDocuments({ ownerUserId: promoter._id }), 0);
    });

    await t.test('personal security and messages retain all fifteen Promoter destinations without creating customer funds', async () => {
      for (const href of ['/account/security', '/account/messages']) {
        const page = await client.get(href).expect(200);
        assert.match(page.text, /data-dashboard-workspace="promoter"/);
        assert.doesNotMatch(page.text, /<h3>Classic Club<\/h3>|id="roleSwitcher"|Development preview/);
        for (const destination of Object.values(PROMOTER_LIVE_ROUTES)) assert.ok(page.text.includes(`href="${destination}"`), href + ':' + destination);
      }
      assert.equal(await LedgerAccount.countDocuments({ code: 'customer_wallet', ownerType: 'customer', ownerPublicId: promoter.publicId }), 0);
      assert.equal(await LoyaltyAccount.countDocuments({ userId: promoter._id }), 0);
    });

    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    for (const width of [1366, 390]) await t.test(`all approved Promoter pages render readable persisted records at ${width}px`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      try {
        const page = await context.newPage();
        await page.goto(base + '/login');
        await page.locator('input[name="email"]').fill(promoter.email);
        await page.locator('input[name="password"]').fill(password);
        await Promise.all([page.waitForURL(base + '/promoter/overview'), page.locator('form[action="/login"] button[type="submit"]').click()]);
        for (const [id, href] of Object.entries(PROMOTER_LIVE_ROUTES)) {
          const response = await page.goto(base + href);
          assert.equal(response.status(), 200, href);
          assert.equal(await page.locator('body').getAttribute('data-dashboard-workspace'), 'promoter');
          assert.equal(await page.locator('body').getAttribute('data-dashboard-page'), id);
          assert.equal(await page.locator('.side-navigation a[href^="/promoter/"]').count(), 15);
          assert.equal(await page.locator('#roleSwitcher').count(), 0);
          const layout = await page.evaluate(() => {
            const overflowing = [...document.querySelectorAll('.role-page *')].map(node => {
              const box = node.getBoundingClientRect();
              return { tag: node.tagName, classes: node.className, right: Math.round(box.right), width: Math.round(box.width),
                text: node.textContent.trim().slice(0, 120) };
            }).filter(node => node.width > 0 && node.right > innerWidth + 1).slice(0, 10);
            return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, overflowing };
          });
          if (layout.scrollWidth > width + 1) await page.screenshot({ path: `/tmp/classicmart-${id}-${width}-overflow.png`, fullPage: true, animations: 'disabled' });
          assert.ok(layout.scrollWidth <= width + 1, href + ' page overflow: ' + JSON.stringify(layout));
          assert.equal(await page.locator('.role-page h1').isVisible(), true, href + ' heading');
          if (id === 'promoter-profile') {
            assert.equal(await page.locator('.role-settings-nav a').count(), 5);
            assert.deepEqual(await page.locator('.role-settings-nav a').allTextContents(), ['Personal information', 'Channels & audience', 'Payments', 'Communication', 'Password & Security']);
            assert.equal(await page.locator('.role-settings-panel.active').isVisible(), true);
            for (const section of ['business', 'notifications', 'security']) {
              const link = page.locator(`.role-settings-nav a[href="/promoter/profile?section=${section}"]`);
              await link.scrollIntoViewIfNeeded();
              await Promise.all([page.waitForURL(base + '/promoter/profile?section=' + section), link.click()]);
              assert.equal(await page.locator('.role-settings-panel.active').isVisible(), true, section + ' settings are reachable');
            }
          } else {
            assert.equal(await page.locator('.role-metric-grid .role-metric').count(), 4, href + ' metrics');
            assert.equal(await page.locator('.role-metric-grid').evaluate(node => getComputedStyle(node).gap), width === 1366 ? '12px' : '9px');
          }
          if (id === 'promoter-overview') {
            assert.equal(await page.locator('.role-welcome').count(), 1);
            assert.equal(await page.locator('.role-overview-grid').count(), 1);
            assert.equal(await page.locator('.role-bottom-grid').count(), 1);
            assert.equal(await page.locator('.role-welcome-score strong').evaluate(node => {
              const range = document.createRange(); range.selectNodeContents(node);
              return range.getClientRects().length === 1 && node.getBoundingClientRect().width <= node.parentElement.clientWidth;
            }), true, 'verification status fits its approved welcome indicator');
          } else if (id !== 'promoter-profile') {
            const grid = page.locator(['promoter-traffic', 'promoter-analytics'].includes(id) ? '.role-analytics-top' : '.role-content-grid');
            assert.equal(await grid.count(), 1, href + ' approved content layout');
            assert.equal(await page.locator('.role-progress-card').count(), 1);
            assert.equal(await page.locator('.role-activity-panel').count(), 1);
            if (width === 1366) assert.match(await grid.evaluate(node => getComputedStyle(node).gridTemplateColumns), /292px$/);
          }
          const expectedRecord = id === 'promoter-links' ? longLinkId : id === 'promoter-commissions' ? commissionId : id === 'promoter-conversions' ? orderPublicId
            : ['promoter-marketplace', 'promoter-campaigns'].includes(id) ? campaignName : id === 'promoter-brands' ? storeName : '';
          if (expectedRecord) {
            const record = page.locator('.role-table tbody td').filter({ hasText: expectedRecord }).first();
            assert.equal(await record.count(), 1, href + ' persisted sample');
            assert.equal(await record.isVisible(), true, href + ' record visibility');
            if (width === 390) {
              const readability = await record.evaluate(node => {
                const box = node.getBoundingClientRect(), style = getComputedStyle(node);
                return { width: box.width, height: box.height, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, display: style.display, whiteSpace: style.whiteSpace };
              });
              assert.ok(readability.width > 200, href + ' record uses the mobile card width');
              assert.ok(readability.height >= 20, href + ' record has visible text height');
              assert.ok(readability.scrollWidth <= readability.clientWidth + 1, href + ' complete record text must wrap without clipping');
              assert.notEqual(readability.whiteSpace, 'nowrap', href + ' records wrap');
            }
          }
          if (['promoter-overview', 'promoter-commissions', 'promoter-profile'].includes(id)) {
            await page.screenshot({ path: `/tmp/classicmart-${id}-${width}.png`, fullPage: true, animations: 'disabled' });
          }
        }
        await page.goto(base + '/account/security');
        assert.equal(await page.locator('body').getAttribute('data-dashboard-workspace'), 'promoter');
        assert.equal(await page.locator('.side-navigation a[href^="/promoter/"]').count(), 15);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Personal security overflow');
        if (width === 1366) {
          await Promise.all([page.waitForURL(base + '/promoter/links'), page.locator('.side-navigation a[href="/promoter/links"]').click()]);
          assert.equal(await page.locator('body').getAttribute('data-dashboard-page'), 'promoter-links');
        }
      } finally { await context.close(); }
    });
    assert.equal(await LedgerAccount.countDocuments({ code: 'customer_wallet', ownerType: 'customer', ownerPublicId: promoter.publicId }), 0);
    assert.equal(await Store.countDocuments({ ownerUserId: promoter._id }), 0);
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    for (const transport of transports) transport.destroy();
    try {
      await Promise.all(Object.values(mongoose.models).map(model => model.init()));
      await mongoose.connection.dropDatabase();
    } finally { await mongoose.disconnect(); }
  }
});

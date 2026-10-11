import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { chromium } from '@playwright/test';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'false';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('all Seller navigation destinations serve live approved layouts on desktop and mobile', { skip: !uri, timeout: 180_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: `classicmart_seller_navigation_test_${suffix}` });
  let server, browser;
  try {
    const { createApp } = await import('../src/app.js');
    const { User, Store, StoreMember, CountrySetting, Product, Category, ProductVariant } = await import('../src/models/index.js');
    const { hashPassword } = await import('../src/core/crypto.js');
    const { SELLER_LIVE_ROUTES } = await import('../src/dashboard/seller-routes.js');
    await Promise.all(Object.values(mongoose.models).map(model => model.init()));
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true });
    const password = `Navigation-${suffix}-A1!`, email = `navigation-${suffix}@example.com`;
    const user = await User.create({ publicId: `usr_nav_${suffix}`, name: 'Navigation Seller', email, emailNormalized: email,
      phone: '+256701223456', phoneNormalized: '+256701223456', passwordHash: await hashPassword(password), role: 'seller', country: 'UG', currency: 'UGX', locale: 'en-UG',
      emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), consents: { terms: true, privacy: true, recordedAt: new Date() } });
    const store = await Store.create({ publicId: `str_nav_${suffix}`, ownerUserId: user._id, name: 'Navigation Store', slug: `navigation-${suffix}`, country: 'UG', currency: 'UGX', status: 'verified', verifiedAt: new Date() });
    await StoreMember.create({ publicId: `stm_nav_${suffix}`, storeId: store._id, userId: user._id, role: 'owner', status: 'active', invitedByUserId: user._id, acceptedAt: new Date() });
    const app = createApp(null), client = request.agent(app);
    const login = await client.get('/login').expect(200);
    await client.post('/login').type('form').send({ email, password, _csrf: csrf(login.text) }).expect(302).expect('location', '/seller/overview');

    await t.test('every owner menu destination is connected, scoped and has a canonical alias', async () => {
      assert.equal(Object.keys(SELLER_LIVE_ROUTES).length, 17);
      for (const [id, href] of Object.entries(SELLER_LIVE_ROUTES)) {
        const page = await client.get(href).set('Accept', 'text/html').expect(200);
        assert.match(page.text, /data-dashboard-workspace="seller"/);
        assert.ok(page.text.includes(`data-dashboard-page="${id}"`), id);
        assert.doesNotMatch(page.text, /Development preview|Not available yet|id="roleSwitcher"|<h3>Classic Club<\/h3>/);
        assert.match(page.headers['cache-control'], /no-store/);
        assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
        assert.match(page.text, /seller-fidelity\.css/);
        const alias = await client.get('/dashboard/' + id + '?search=retained').expect(308);
        assert.equal(alias.headers.location, href + '?search=retained');
      }
    });

    await t.test('the approved product export is real, scoped and formula-safe', async () => {
      const category = await Category.create({ publicId: `cat_nav_${suffix}`, name: 'Navigation category', slug: `nav-${suffix}`, active: true });
      const product = await Product.create({ publicId: `prd_nav_${suffix}`, ownerUserId: user._id, storeId: store._id, categoryId: category._id,
        title: '  =FORMULA()', slug: `formula-${suffix}`, description: 'A product used to verify exported data protection.', countries: ['UG'] });
      await ProductVariant.create({ publicId: `var_nav_${suffix}`, storeId: store._id, productId: product._id, sku: `NAV-${suffix}`, title: 'Standard', priceMinor: 1200, currency: 'UGX' });
      const exported = await client.get('/seller/products/export.csv').expect(200);
      assert.match(exported.headers['content-type'], /text\/csv/);
      assert.match(exported.text, /Product,Store,PriceMinor,Currency,AvailableStock,Status/);
      assert.match(exported.text, /"'=FORMULA\(\)"/);
      assert.match(exported.text, /Navigation Store/);
      assert.equal(await Store.countDocuments({ ownerUserId: user._id }), 1);
    });

    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    for (const width of [1366, 390]) await t.test(`all rendered Seller pages preserve approved structure and navigation at ${width}px`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      try {
        const page = await context.newPage();
        await page.goto(base + '/login');
        await page.locator('input[name="email"]').fill(email);
        await page.locator('input[name="password"]').fill(password);
        await Promise.all([page.waitForURL(base + '/seller/overview'), page.locator('form[action="/login"] button[type="submit"]').click()]);
        for (const [id, href] of Object.entries(SELLER_LIVE_ROUTES)) {
          const response = await page.goto(base + href);
          assert.equal(response.status(), 200, href);
          assert.equal(await page.locator('body').getAttribute('data-dashboard-workspace'), 'seller');
          assert.equal(await page.locator('body').getAttribute('data-dashboard-page'), id);
          assert.equal(await page.locator('.side-navigation a[href^="/seller/"]').count(), 17);
          assert.equal(await page.locator('#roleSwitcher').count(), 0);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, href + ' overflow');
          assert.equal(await page.locator('.role-page h1').isVisible(), true, href + ' heading');
          if (!['seller-store', 'seller-add-product'].includes(id)) {
            assert.equal(await page.locator('.role-metric-grid .role-metric').count(), 4, href + ' metrics');
            assert.equal(await page.locator('.role-page .role-metric-grid').evaluate(node => getComputedStyle(node).gap), width === 1366 ? '12px' : '9px');
          }
          if (!['seller-store', 'seller-add-product', 'seller-overview'].includes(id)) {
            assert.equal(await page.locator('.role-content-grid').count(), 1, href + ' content grid');
            assert.equal(await page.locator('.role-progress-card').count(), 1, href + ' health');
            assert.equal(await page.locator('.role-activity-panel').count(), 1, href + ' workflow');
            if (width === 1366) assert.match(await page.locator('.role-content-grid').evaluate(node => getComputedStyle(node).gridTemplateColumns), /292px$/);
          }
        }
        await page.goto(base + '/seller/inventory');
        if (width === 1366) {
          await Promise.all([page.waitForURL(base + '/seller/coupons'), page.locator('.side-navigation a[href="/seller/coupons"]').click()]);
          assert.equal(await page.locator('body').getAttribute('data-dashboard-page'), 'seller-coupons');
        }
        await page.screenshot({ path: `/tmp/classicmart-seller-navigation-${width}.png`, fullPage: true, animations: 'disabled' });
      } finally { await context.close(); }
    });
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    try { await mongoose.connection.dropDatabase(); } finally { await mongoose.disconnect(); }
  }
});

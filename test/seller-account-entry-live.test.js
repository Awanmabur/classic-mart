import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';
import { chromium } from '@playwright/test';
import { dashboardLanding, hasSellerSignupIntent, loginDestination, signupDestination } from '../src/dashboard/landing.js';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'false';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const csrf = html => html.match(/name="_csrf"[^>]*value="([^"]+)"/)[1];

test('generic account destinations select the assigned dashboard while explicit buyer pages stay accessible', () => {
  const seller = { role: 'seller', status: 'active' }, customer = { role: 'customer', status: 'active' };
  for (const next of ['/', '/dashboard', '/dashboard?from=account', '/account', '/account/profile', '/\\evil.example', '/\t/evil.example', '//evil.example']) {
    assert.equal(loginDestination(seller, next), '/seller/store');
  }
  for (const path of ['/orders', '/cart', '/profile', '/account/security']) assert.equal(loginDestination(seller, path), path);
  assert.equal(dashboardLanding(customer), '/dashboard');
  assert.equal(loginDestination(customer, '/account/profile'), '/account/profile', 'customer account-profile behavior stays unchanged');
  for (const path of ['/onboarding/seller', '/onboarding?role=seller', '/seller/store', '/signup?role=seller']) {
    assert.equal(hasSellerSignupIntent(path), true);
    assert.equal(signupDestination(path), '/signup?role=seller');
    assert.equal(loginDestination(customer, path), '/onboarding/seller');
  }
  for (const path of ['/onboarding?role=super_admin', '//evil.example/seller', '/\t/evil.example/seller', '/seller-imitation', '/orders']) assert.equal(signupDestination(path), '/signup');
  assert.equal(loginDestination({ ...customer, platformAccessManagedAt: new Date() }, '/seller/store'), '/seller/store', 'staff access is still checked by the protected destination');
});

test('public account and seller links preserve the intended journey in the real application', { skip: !uri }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: `classicmart_seller_entry_test_${suffix}` });
  const { createApp } = await import('../src/app.js');
  const models = await import('../src/models/index.js');
  const { User, CountrySetting } = models;
  const { hashPassword } = await import('../src/core/crypto.js');
  const app = createApp(null);
  app.set('trust proxy', 1);
  const password = `Entry-${suffix}-A1!`, passwordHash = await hashPassword(password);
  let sequence = 0, server, browser;
  function agent() {
    const ip = `192.0.2.${++sequence}`;
    return request.agent(app).use(req => req.set('X-Forwarded-For', ip));
  }
  async function actor(role = 'customer', verified = true) {
    const number = ++sequence;
    return User.create({ publicId: `usr_entry_${suffix}_${number}`, name: 'Entry Account', email: `entry-${suffix}-${number}@example.com`,
      emailNormalized: `entry-${suffix}-${number}@example.com`, phone: `+25670${String(number).padStart(7, '0')}`, phoneNormalized: `+25670${String(number).padStart(7, '0')}`,
      passwordHash, role, country: 'UG', currency: 'UGX', locale: 'en-UG', emailVerifiedAt: verified ? new Date() : undefined,
      onboardingCompletedAt: new Date(), roleProfile: { publicName: 'Entry Account', businessName: 'Entry Store', location: 'Kampala' },
      consents: { terms: true, privacy: true, recordedAt: new Date() } });
  }
  async function login(client, user, next = '/dashboard') {
    const form = await client.get('/login').query({ next }).expect(200);
    return client.post('/login').type('form').send({ email: user.email, password, next, _csrf: csrf(form.text) })
      .expect(302).expect('location', user.emailVerifiedAt ? loginDestination(user, next) : '/verify-email');
  }
  try {
    await Promise.all(Object.values(models).filter(model => typeof model?.init === 'function').map(model => model.init()));
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true });

    await t.test('seller public Account entries and saved profile URLs open the seller workspace', async () => {
      const user = await actor('seller'), client = agent();
      await login(client, user);
      const home = await client.get('/').expect(200);
      assert.match(home.text, /class="header-action header-action-link" href="\/account\/profile"/);
      assert.match(home.text, /<a href="\/account\/profile">My Account<\/a>/);
      await client.get('/dashboard').expect(302).expect('location', '/seller/store');
      await client.get('/account/profile').expect(302).expect('location', '/seller/store');
      await client.get('/profile').expect(302).expect('location', '/seller/store');
      await client.get('/dashboard/profile').expect(308).expect('location', '/profile');
      const store = await client.get('/seller/store').expect(200);
      assert.match(store.text, /data-dashboard-workspace="seller"/);
      assert.match(store.text, /<small>Seller<\/small>/);
      const security = await client.get('/account/security').expect(200);
      assert.match(security.text, /<small>Seller<\/small>/);
      assert.ok(csrf(security.text));
      const buyerOrders = await client.get('/orders').expect(200);
      assert.match(buyerOrders.text, /data-dashboard-page="orders"/);
      assert.equal((await User.findById(user._id)).role, 'seller');
    });

    await t.test('guest seller paths preserve intent through the existing login Create Account link', async () => {
      const client = agent();
      await client.get('/onboarding?role=seller').expect(302).expect('location', '/signup?role=seller');
      const gate = await client.get('/onboarding/seller').expect(302);
      assert.equal(gate.headers.location, '/login?next=%2Fonboarding%2Fseller');
      const form = await client.get(gate.headers.location).expect(200);
      assert.match(form.text, /href="\/signup\?role=seller">Create your free account/);
      const failed = await client.post('/login').type('form').send({ email: 'missing@example.com', password, next: '/onboarding/seller', _csrf: csrf(form.text) }).expect(401);
      assert.match(failed.text, /href="\/signup\?role=seller">Create your free account/);
      const signup = await client.get('/signup?role=seller').expect(200);
      assert.match(signup.text, /name="accountType" type="hidden" value="seller"/);
    });

    await t.test('legacy seller onboarding links enrol completed customers without changing their identity on GET', async () => {
      const user = await actor(), client = agent();
      await login(client, user);
      const original = await User.findById(user._id);
      await client.get('/onboarding?role=seller').expect(302).expect('location', '/onboarding/seller');
      const page = await client.get('/onboarding/seller').expect(200);
      assert.match(page.text, /Start your seller account/);
      const fresh = await User.findById(user._id);
      assert.equal(fresh.role, 'customer');
      assert.equal(fresh.__v, original.__v);
      assert.equal(fresh.onboardingCompletedAt.getTime(), user.onboardingCompletedAt.getTime());
      await client.post('/onboarding/seller').type('form').send({ role: 'seller', confirmSeller: 'on', version: String(fresh.__v), publicName: 'Entry Account',
        businessName: 'Enrolled Store', location: 'Kampala', _csrf: csrf(page.text) }).expect(302).expect('location', '/seller/store');
      assert.equal((await User.findById(user._id)).role, 'seller');
    });

    await t.test('existing customer Account aliases retain their personal profile destination', async () => {
      const user = await actor(), client = agent();
      await login(client, user, '/account/profile');
      await client.get('/account/profile').expect(302).expect('location', '/profile');
      const profile = await client.get('/profile').expect(200);
      assert.match(profile.text, /data-dashboard-page="profile"/);
      assert.match(profile.text, /<small>Customer<\/small>/);
      assert.equal((await User.findById(user._id)).role, 'customer');
    });

    await t.test('an existing customer keeps seller intent when email verification is required first', async () => {
      const user = await actor('customer', false), client = agent();
      await login(client, user, '/onboarding/seller');
      const page = await client.get('/verify-email').expect(200);
      await client.post('/verify-email/resend').type('form').send({ _csrf: csrf(page.text) }).expect(302).expect('location', '/verify-email');
      const codePage = await client.get('/verify-email').expect(200), code = codePage.text.match(/Development verification code: (\d{6})/)[1];
      await client.post('/verify-email').type('form').send({ code, _csrf: csrf(codePage.text) }).expect(302).expect('location', '/onboarding/seller');
      await client.get('/onboarding/seller').expect(200);
      assert.equal((await User.findById(user._id)).role, 'customer', 'verification does not itself grant seller access');
    });

    await t.test('unverified customers retain direct legacy and canonical seller-entry intentions', async () => {
      for (const entry of ['/onboarding?role=seller', '/onboarding/seller']) {
        const user = await actor('customer', false), client = agent();
        await login(client, user);
        await client.get(entry).expect(302).expect('location', '/verify-email');
        const page = await client.get('/verify-email').expect(200);
        await client.post('/verify-email/resend').type('form').send({ _csrf: csrf(page.text) }).expect(302);
        const codePage = await client.get('/verify-email').expect(200), code = codePage.text.match(/Development verification code: (\d{6})/)[1];
        await client.post('/verify-email').type('form').send({ code, _csrf: csrf(codePage.text) }).expect(302).expect('location', '/onboarding/seller');
        await client.get('/onboarding/seller').expect(200);
        assert.equal((await User.findById(user._id)).role, 'customer');
      }
    });

    await t.test('a verified customer without a completed profile continues intentional seller enrolment', async () => {
      const user = await actor(), client = agent();
      user.onboardingCompletedAt = undefined;
      await user.save();
      await login(client, user, '/onboarding?role=seller');
      await client.get('/onboarding/seller').expect(200);
      assert.equal((await User.findById(user._id)).role, 'customer');
      // Choosing Back to marketplace does not force seller enrollment forever.
      await client.get('/').expect(200);
      await client.get('/dashboard').expect(302).expect('location', '/onboarding');
      const ordinarySetup = await client.get('/onboarding').expect(200);
      assert.match(ordinarySetup.text, /<input checked name="role" required type="radio" value="customer"/);
      assert.equal((await User.findById(user._id)).role, 'customer');
    });

    await t.test('MFA login preserves incomplete-customer seller intent and later seller login returns to its workspace', async () => {
      const { beginMfaEnrollment, confirmMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
      const user = await actor();
      user.onboardingCompletedAt = undefined;
      await user.save();
      const enrollment = await beginMfaEnrollment(user._id, password);
      const enabled = await confirmMfaEnrollment(user._id, totpCode(enrollment.secret));
      assert.equal(enabled.user.security.mfaEnabled, true);
      const client = agent(), form = await client.get('/login?next=%2Fonboarding%3Frole%3Dseller').expect(200);
      await client.post('/login').type('form').send({ email: user.email, password, next: '/onboarding?role=seller', _csrf: csrf(form.text) })
        .expect(302).expect('location', '/mfa');
      await client.get('/onboarding/seller').expect(302).expect('location', '/login?next=%2Fonboarding%2Fseller');
      const challenge = await client.get('/mfa').expect(200);
      await client.post('/mfa').type('form').send({ code: enabled.codes[0] }).expect(403);
      await client.post('/mfa').type('form').send({ code: enabled.codes[0], _csrf: 'invalid-token' }).expect(403);
      await client.post('/mfa').type('form').send({ code: enabled.codes[0], _csrf: csrf(challenge.text) })
        .expect(302).expect('location', '/onboarding/seller');
      const page = await client.get('/onboarding/seller').expect(200), fresh = await User.findById(user._id);
      assert.equal(fresh.role, 'customer');
      await client.post('/onboarding/seller').type('form').send({ role: 'seller', confirmSeller: 'on', version: String(fresh.__v), publicName: 'MFA Seller',
        businessName: 'MFA Verified Store', location: 'Kampala', _csrf: csrf(page.text) }).expect(302).expect('location', '/seller/store');
      const store = await client.get('/seller/store').expect(200);
      assert.match(store.text, /data-dashboard-workspace="seller"/);
      await client.post('/logout').type('form').send({ _csrf: csrf(store.text) }).expect(302).expect('location', '/login');
      const returning = agent(), returningForm = await returning.get('/login?next=%2Fdashboard').expect(200);
      await returning.post('/login').type('form').send({ email: user.email, password, next: '/dashboard', _csrf: csrf(returningForm.text) })
        .expect(302).expect('location', '/mfa');
      const nextChallenge = await returning.get('/mfa').expect(200);
      await returning.post('/mfa').type('form').send({ code: enabled.codes[1], _csrf: csrf(nextChallenge.text) })
        .expect(302).expect('location', '/seller/store');
      const returned = await returning.get('/seller/store').expect(200);
      assert.match(returned.text, /<small>Seller<\/small>/);
      assert.equal((await User.findById(user._id)).security.mfaEnabled, true);
    });

    await t.test('real desktop and mobile home links finish seller signup and return to the same seller dashboard', async () => {
      server = http.createServer(app);
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
      for (const width of [390, 1366]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': width === 390 ? '192.0.2.230' : '192.0.2.231' } });
        const page = await context.newPage(), number = ++sequence, email = `browser-entry-${suffix}-${number}@example.com`;
        try {
          await page.goto(base + '/');
          await (width === 390 ? page.locator('.mobile-bottom-nav__sell') : page.getByRole('link', { name: 'Sell on Classic Mart', exact: true }).first()).click();
          await page.waitForURL(base + '/signup?role=seller');
          assert.equal(await page.locator('input[name="accountType"]').inputValue(), 'seller');
          await page.locator('#signUpName').fill('Public Link Seller');
          await page.locator('#signUpEmail').fill(email);
          await page.locator('select[name="phoneCountry"]').selectOption('UG');
          await page.locator('#signUpPhone').fill(`070${String(number).padStart(7, '0')}`);
          await page.locator('#signUpPassword').fill(password);
          await page.locator('#signUpConfirmPassword').fill(password);
          await page.locator('#acceptTerms').check();
          await Promise.all([page.waitForURL(base + '/verify-email'), page.locator('.auth-submit').click()]);
          const code = (await page.locator('body').innerText()).match(/Development verification code: (\d{6})/)[1];
          await page.locator('input[name="code"]').fill(code);
          await Promise.all([page.waitForURL(base + '/onboarding'), page.locator('form[action="/verify-email"] button[type="submit"]').click()]);
          assert.equal(await page.locator('input[name="role"][value="seller"]').isChecked(), true);
          await page.locator('input[name="businessName"]').fill(`Public Seller ${width}`);
          await Promise.all([page.waitForURL(base + '/seller/store'), page.locator('form[action="/onboarding"] button[type="submit"]').click()]);
          assert.equal(await page.locator('body').getAttribute('data-dashboard-workspace'), 'seller');
          await page.goto(base + '/');
          await page.locator('.header-action-link').click();
          await page.waitForURL(base + '/seller/store');
          assert.match(await page.locator('#profileButton small').textContent(), /Seller/);
          await page.goto(base + '/profile');
          await page.waitForURL(base + '/seller/store');
          const searchButton = await page.locator('.search button').boundingBox();
          assert.ok(searchButton.x >= 0 && searchButton.x + searchButton.width <= width, 'the approved search action stays inside the viewport');
          await page.screenshot({ path: `/tmp/classicmart-public-entry-seller-${width}.png`, fullPage: true, animations: 'disabled' });
          assert.equal((await User.findOne({ emailNormalized: email })).role, 'seller');
        } finally { await context.close(); }
      }
    });
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    try { if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase(); }
    finally { await mongoose.disconnect(); }
  }
});

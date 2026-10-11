import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';
import { chromium } from '@playwright/test';
import { mfaContinuation, mfaSecurityPath } from '../src/dashboard/mfa-continuation.js';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];
const sellerView = {
  workspace: 'seller',
  accountNavigation: [
    { id: 'seller-overview', href: '/seller/overview', ready: true },
    { id: 'seller-store', href: '/seller/store', ready: true },
    { id: 'seller-products', href: '/seller/products', ready: true },
    { id: 'seller-orders', href: '/seller/orders', ready: true },
  ],
};

test('MFA continuations accept only current ready navigation and canonical local read destinations', () => {
  for (const value of ['https://evil.example', '//evil.example', '/\\evil.example', '/%2f%2fevil.example',
    '/seller%2fstore', '/seller/store#evil', '/seller/store\n', '/seller/store extra',
    '/logout', '/account/mfa/disable', '/seller/orders/export.csv', '/seller/orders/sor_test/dispatch',
    '/warehouse', '/dashboard', '/dashboard/super-users', ['/seller/store'], { next: '/seller/store' }]) {
    const continuation = mfaContinuation(value, null, sellerView);
    assert.equal(continuation.next, '', String(value));
    assert.equal(continuation.url, '/seller/overview');
    assert.equal(mfaSecurityPath(continuation), '/account/security');
  }
  const target = '/seller/orders/sor_test?status=processing';
  assert.equal(mfaContinuation(target, null, sellerView).next, target);
  assert.equal(mfaContinuation('/dashboard/seller-store', null, sellerView).next, '/seller/store');
  assert.equal(mfaContinuation('/seller', null, sellerView).next, '/seller/overview');
  const staff = { workspace: 'seller', accountNavigation: [{ id: 'seller-orders', href: '/seller/orders', ready: true }] };
  assert.equal(mfaContinuation('/seller/store', null, staff).next, '');
  assert.equal(mfaContinuation('/seller/orders/sor_test', null, staff).next, '/seller/orders/sor_test');
  assert.equal(mfaContinuation('/seller/orders/sor_test', null, { workspace: 'customer', accountNavigation: [] }).next, '');
});

test('seller MFA enrollment keeps its destination, recovery codes and role shell through real HTTP and browser navigation', { skip: !uri, timeout: 180_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: `classicmart_seller_mfa_continuation_test_${suffix}` });
  const { createApp } = await import('../src/app.js');
  const { User, Store, StoreMember, Device, CountrySetting } = await import('../src/models/index.js');
  const { hashPassword } = await import('../src/core/crypto.js');
  const { pendingMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
  const app = createApp(null);
  const password = `Continue-${suffix}-A1!`, passwordHash = await hashPassword(password);
  const transports = [];
  let sequence = 0, browser, server;
  async function actor(role = 'seller') {
    const number = ++sequence, email = `mfa-continue-${suffix}-${number}@example.com`, phone = `+25671${String(number).padStart(7, '0')}`;
    const user = await User.create({ publicId: `usr_continue_${suffix}_${number}`, name: `Continuation Actor ${number}`, email,
      emailNormalized: email, phone, phoneNormalized: phone, passwordHash, role, country: 'UG', currency: 'UGX', locale: 'en-UG',
      emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), roleProfile: { businessName: `Continuation Store ${number}` },
      consents: { terms: true, privacy: true, recordedAt: new Date() } });
    const transport = new http.Agent({ localAddress: `127.0.0.${number + 90}`, keepAlive: false });
    transports.push(transport);
    const client = request.agent(app).use(req => req.agent(transport));
    const form = await client.get('/login').expect(200);
    await client.post('/login').type('form').send({ email, password, _csrf: csrf(form.text) }).expect(302);
    return { user, client };
  }
  try {
    await Promise.all([User.init(), Store.init(), StoreMember.init(), Device.init(), CountrySetting.init()]);
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true });
    const seller = await actor();
    const target = '/seller/store', securityPath = '/account/security?next=%2Fseller%2Fstore';
    let recoveryCodes;

    await t.test('failed password/code retain the destination; confirmation shows codes before the seller store', async () => {
      await seller.client.get(target).expect(302).expect('location', securityPath);
      let page = await seller.client.get(securityPath).expect(200);
      assert.match(page.text, /data-dashboard-workspace="seller"/);
      assert.match(page.text, /name="next" value="\/seller\/store"/);
      assert.equal(await Store.countDocuments({ ownerUserId: seller.user._id }), 0);
      await seller.client.post('/account/mfa/begin').type('form').send({ currentPassword: password, next: target }).expect(403);
      assert.equal(await pendingMfaEnrollment(seller.user._id), null);
      await seller.client.post('/account/mfa/begin').type('form').send({ currentPassword: 'wrong-password', next: target, _csrf: csrf(page.text) })
        .expect(302).expect('location', securityPath);
      page = await seller.client.get(securityPath).expect(200);
      assert.match(page.text, /current password is incorrect/);
      assert.match(page.text, /name="next" value="\/seller\/store"/);
      await seller.client.post('/account/mfa/begin').type('form').send({ currentPassword: password, next: target, _csrf: csrf(page.text) })
        .expect(302).expect('location', securityPath);
      const pending = await pendingMfaEnrollment(seller.user._id);
      page = await seller.client.get(securityPath).expect(200);
      await seller.client.post('/account/mfa/confirm').type('form').send({ code: 'invalid', next: target, _csrf: csrf(page.text) })
        .expect(302).expect('location', securityPath);
      page = await seller.client.get(securityPath).expect(200);
      assert.match(page.text, /authenticator code is invalid/);
      assert.equal((await User.findById(seller.user._id)).security.mfaEnabled, false);
      await seller.client.post('/account/mfa/confirm').type('form').send({ code: totpCode(pending.secret), next: target, _csrf: csrf(page.text) })
        .expect(302).expect('location', securityPath);
      page = await seller.client.get(securityPath).expect(200);
      assert.match(page.text, /data-dashboard-workspace="seller"/);
      assert.match(page.text, /href="\/seller\/store">Continue to Seller workspace<\/a>/);
      assert.match(page.text, /Save these recovery codes offline before continuing/);
      recoveryCodes = [...page.text.matchAll(/<code>([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})<\/code>/g)].map(match => match[1]);
      assert.equal(recoveryCodes.length, 10);
      assert.equal(await Store.countDocuments({ ownerUserId: seller.user._id }), 0, 'security GET/POST must not provision stores');
      assert.equal((await User.findById(seller.user._id)).role, 'seller');
      const repeat = await seller.client.get(securityPath).expect(200);
      assert.equal([...repeat.text.matchAll(/<code>([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})<\/code>/g)].length, 0);
      await seller.client.get(target).expect(200);
      await seller.client.post('/account/mfa/disable').type('form').send({ currentPassword: password, code: recoveryCodes[0], next: target, _csrf: csrf(repeat.text) })
        .expect(403);
      assert.equal((await User.findById(seller.user._id)).security.mfaEnabled, true);
    });

    await t.test('malicious and unrelated destinations do not enter forms or become redirect targets', async () => {
      for (const target of ['https://evil.example', '//evil.example', '/%2f%2fevil.example', '/logout', '/warehouse', '/dashboard/super-users']) {
        const page = await seller.client.get('/account/security').query({ next: target }).expect(200);
        assert.doesNotMatch(page.text, /name="next"/);
        assert.match(page.text, /href="\/seller\/overview">Continue to Seller workspace<\/a>/);
        await seller.client.post('/account/mfa/begin').type('form').send({ currentPassword: 'wrong', next: target, _csrf: csrf(page.text) })
          .expect(302).expect('location', '/account/security');
      }
    });

    await t.test('membership revoked during enrollment removes the operational continuation without changing the account role', async () => {
      const staff = await actor('customer'), store = await Store.findOne({ ownerUserId: seller.user._id });
      const member = await StoreMember.create({ publicId: `stm_continue_${staff.user.publicId}`, storeId: store._id, userId: staff.user._id,
        role: 'fulfilment', status: 'active', invitedByUserId: seller.user._id, acceptedAt: new Date() });
      const staffPath = '/account/security?next=%2Fseller%2Forders';
      await staff.client.get('/seller/orders').expect(302).expect('location', staffPath);
      let page = await staff.client.get(staffPath).expect(200);
      assert.match(page.text, /data-dashboard-workspace="seller"/);
      assert.match(page.text, /name="next" value="\/seller\/orders"/);
      await staff.client.post('/account/mfa/begin').type('form').send({ currentPassword: password, next: '/seller/orders', _csrf: csrf(page.text) })
        .expect(302).expect('location', staffPath);
      const pending = await pendingMfaEnrollment(staff.user._id);
      await staff.client.post('/account/mfa/disable').type('form').send({ currentPassword: password, code: 'invalid', next: '/seller/orders', _csrf: csrf(page.text) })
        .expect(403);
      member.status = 'revoked'; member.revokedAt = new Date(); await member.save();
      page = await staff.client.get(staffPath).expect(200);
      assert.match(page.text, /data-dashboard-workspace="customer"/);
      assert.doesNotMatch(page.text, /name="next"/);
      await staff.client.post('/account/mfa/confirm').type('form').send({ code: totpCode(pending.secret), next: '/seller/orders', _csrf: csrf(page.text) })
        .expect(302).expect('location', '/account/security');
      page = await staff.client.get('/account/security').expect(200);
      assert.doesNotMatch(page.text, /Continue to Seller workspace/);
      assert.equal((await User.findById(staff.user._id)).role, 'customer');
      assert.equal(await Store.countDocuments({ ownerUserId: staff.user._id }), 0);
      await staff.client.get('/seller/orders').expect(403);
    });

    await t.test('desktop and mobile login, enrollment and Continue open the real Seller store without Customer navigation', async () => {
      server = http.createServer(app);
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
      for (const width of [390, 1366]) {
        const seller = await actor(), context = await browser.newContext({ viewport: { width, height: 900 } });
        const page = await context.newPage();
        try {
          await page.goto(base + '/login?next=%2Fseller%2Fstore');
          await page.locator('input[name="email"]').fill(seller.user.email);
          await page.locator('input[name="password"]').fill(password);
          await Promise.all([page.waitForURL(base + securityPath), page.locator('form[action="/login"] button[type="submit"]').click()]);
          assert.equal(await page.locator('body').getAttribute('data-dashboard-workspace'), 'seller');
          const begin = page.locator('form[action="/account/mfa/begin"]');
          await begin.locator('input[name="currentPassword"]').fill(password);
          await Promise.all([page.waitForNavigation(), begin.locator('button[type="submit"]').click()]);
          assert.equal(new URL(page.url()).searchParams.get('next'), target);
          const pending = await pendingMfaEnrollment(seller.user._id);
          const confirm = page.locator('form[action="/account/mfa/confirm"]');
          await confirm.locator('input[name="code"]').fill(totpCode(pending.secret));
          await Promise.all([page.waitForNavigation(), confirm.locator('button[type="submit"]').click()]);
          const continuation = page.getByRole('link', { name: 'Continue to Seller workspace', exact: true });
          await continuation.waitFor({ state: 'visible' });
          assert.equal(await page.locator('.choice-grid code').count(), 10);
          assert.equal(await Store.countDocuments({ ownerUserId: seller.user._id }), 0);
          await Promise.all([page.waitForURL(base + target), continuation.click()]);
          assert.equal(await page.locator('body').getAttribute('data-dashboard-workspace'), 'seller');
          assert.equal(await page.locator('#sidebar').getByText('Classic Club', { exact: true }).count(), 0);
          assert.equal(await page.locator('#sidebar').getByText('My Orders', { exact: true }).count(), 0);
          assert.equal(await page.getByRole('heading', { name: 'Store Settings', exact: true }).count(), 1);
          await page.screenshot({ path: `/tmp/classicmart-seller-mfa-continue-${width}.png`, fullPage: true, animations: 'disabled' });
        } finally { await context.close(); }
      }
    });
  } finally {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const transport of transports) transport.destroy();
    try { if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase(); }
    finally { await mongoose.disconnect(); }
  }
});

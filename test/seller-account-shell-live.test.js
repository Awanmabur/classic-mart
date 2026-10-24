import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';
import { chromium } from '@playwright/test';
import sharp from 'sharp';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];
const sidebar = html => html.match(/<aside class="sidebar"[^>]*>([\s\S]*?)<\/aside>/)[1];

function assertSellerShell(page) {
  assert.match(page.text, /data-dashboard-workspace="seller"/);
  assert.match(page.text, /<small>Seller<\/small>/);
  for (const label of ['Overview', 'Products', 'Orders', 'Store Settings']) assert.match(sidebar(page.text), new RegExp(`<span>${label}<\/span>`));
  assert.doesNotMatch(sidebar(page.text), /Classic Club|My Orders|Wishlist|Rewards|Profile Settings/);
  assert.doesNotMatch(page.text, /aria-label="Wishlist"|aria-label="Cart"|Development preview|role-workspaces\.js/);
  assert.match(page.headers['cache-control'], /private/);
  assert.match(page.headers['cache-control'], /no-store/);
  assert.ok(csrf(page.text));
}

test('seller personal account pages use the authorized store shell while customer pages and protection remain intact', { skip: !uri, timeout: 180_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: `classicmart_seller_account_shell_test_${suffix}` });
  const { createApp } = await import('../src/app.js');
  const { User, Store, StoreMember, Device, CountrySetting, PrivacyRequest, SellerContactRequest, Notification, PlatformGrant } = await import('../src/models/index.js');
  const { hashPassword } = await import('../src/core/crypto.js');
  const { pendingMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
  const { getOrCreateStore } = await import('../src/services/store.js');
  const app = createApp(null);
  const password = `Shell-${suffix}-A1!`, passwordHash = await hashPassword(password);
  const transports = [];
  let sequence = 0, browser, server;
  async function actor(role = 'customer') {
    const number = ++sequence, email = `shell-${suffix}-${number}@example.com`, phone = `+25670${String(number).padStart(7, '0')}`;
    const user = await User.create({ publicId: `usr_shell_${suffix}_${number}`, name: `Shell Actor ${number}`, email, emailNormalized: email,
      phone, phoneNormalized: phone, passwordHash, role, country: 'UG', currency: 'UGX', locale: 'en-UG', emailVerifiedAt: new Date(),
      onboardingCompletedAt: new Date(), roleProfile: { businessName: `Shell Store ${number}` },
      consents: { terms: true, privacy: true, recordedAt: new Date() },
      ...(role === 'super_admin' ? { platformAccessManagedAt: new Date(), operationalCountries: ['*'] } : {}) });
    if (role === 'super_admin') await PlatformGrant.create({ publicId: `pgr_shell_${suffix}_${number}`, userId: user._id, role,
      operationalCountries: ['*'], startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000),
      reason: 'Independently approved account shell fixture.', approvalPublicId: `apr_shell_${suffix}_${number}`,
      approvedByUserId: new mongoose.Types.ObjectId(), status: 'active' });
    const transport = new http.Agent({ localAddress: `127.0.0.${number + 2}`, keepAlive: false });
    transports.push(transport);
    const client = request.agent(app).use(req => req.agent(transport));
    const form = await client.get('/login').expect(200);
    await client.post('/login').type('form').send({ email, password, _csrf: csrf(form.text) }).expect(302);
    return { user, client };
  }
  try {
    await Promise.all([User.init(), Store.init(), StoreMember.init(), Device.init(), CountrySetting.init(), PlatformGrant.init()]);
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true });
    const seller = await actor('seller'), customer = await actor();
    let recoveryCodes;

    await t.test('security uses actual seller navigation before MFA and does not create store ownership on an account read', async () => {
      assert.equal(await Store.countDocuments({ ownerUserId: seller.user._id }), 0);
      const security = await seller.client.get('/account/security').expect(200);
      assertSellerShell(security);
      assert.match(security.text, /action="\/account\/password"/);
      assert.match(security.text, /action="\/account\/mfa\/begin"/);
      assert.doesNotMatch(security.text, /id="sellerIdentity"|id="sellerOperations"/);
      assert.equal(await Store.countDocuments({ ownerUserId: seller.user._id }), 0);
      await seller.client.get('/seller/products').expect(302).expect('location', '/account/security?next=%2Fseller%2Fproducts');
      await seller.client.post('/account/mfa/begin').type('form').send({ currentPassword: password }).expect(403);
      assert.equal((await User.findById(seller.user._id)).security.mfaEnabled, false);
      await seller.client.post('/account/mfa/begin').type('form').send({ currentPassword: password, _csrf: csrf(security.text) }).expect(302);
      const pending = await pendingMfaEnrollment(seller.user._id);
      const enrollment = await seller.client.get('/account/security').expect(200);
      assertSellerShell(enrollment);
      await seller.client.post('/account/mfa/confirm').type('form').send({ code: totpCode(pending.secret), _csrf: csrf(enrollment.text) }).expect(302);
      const enabled = await seller.client.get('/account/security').expect(200);
      assertSellerShell(enabled);
      recoveryCodes = [...enabled.text.matchAll(/<code>([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})<\/code>/g)].map(match => match[1]);
      assert.equal(recoveryCodes.length, 10);
      assert.equal((await User.findById(seller.user._id)).security.mfaEnabled, true);
      await seller.client.get('/seller/products').expect(200);
    });

    await t.test('shared privacy, messages and app data stay private to the seller identity within its seller shell', async () => {
      const store = await Store.findOne({ ownerUserId: seller.user._id });
      for (const identity of [seller.user, customer.user]) {
        await PrivacyRequest.create({ publicId: `prv_shell_${identity.publicId}`, userId: identity._id, userPublicId: identity.publicId,
          country: 'UG', type: 'correction', identityVerifiedAt: new Date(), details: `PRIVATE_CORRECTION_${identity.publicId}` });
        await SellerContactRequest.create({ publicId: `scr_shell_${identity.publicId}`, customerUserId: identity._id, storeId: store._id,
          country: 'UG', subject: `PRIVATE_SUBJECT_${identity.publicId}`, message: `Private message for ${identity.publicId}` });
      }
      const messages = await seller.client.get('/account/messages').expect(200);
      assertSellerShell(messages);
      assert.match(messages.text, new RegExp(`PRIVATE_SUBJECT_${seller.user.publicId}`));
      assert.doesNotMatch(messages.text, new RegExp(`PRIVATE_SUBJECT_${customer.user.publicId}`));
      const privacy = await seller.client.get('/account/privacy').expect(200);
      assertSellerShell(privacy);
      assert.match(privacy.text, new RegExp(`prv_shell_${seller.user.publicId}`));
      assert.doesNotMatch(privacy.text, new RegExp(`prv_shell_${customer.user.publicId}`));
      const apps = await seller.client.get('/account/apps').expect(200);
      assertSellerShell(apps);
      assert.match(apps.text, /Mobile/);
      for (const path of ['/account/rewards', '/account/returns']) {
        assertSellerShell(await seller.client.get(path).expect(200));
      }
      assert.equal((await User.findById(seller.user._id)).role, 'seller');
    });

    await t.test('personal profile and photo changes stay in the seller shell and never expose another account', async () => {
      const before = await User.findById(seller.user._id).lean();
      const peer = await User.findById(customer.user._id).lean();
      const profile = await seller.client.get('/account/profile').expect(200);
      assertSellerShell(profile);
      assert.match(profile.text, /<h1>Profile Settings<\/h1>/);
      assert.match(profile.text, /id="profilePhotoForm"/);
      assert.match(profile.text, new RegExp(`name="name" value="${seller.user.name}"`));
      assert.doesNotMatch(profile.text, new RegExp(customer.user.email));
      const personalForm = profile.text.match(/<form[^>]*action="\/account\/profile"[\s\S]*?<\/form>/)?.[0];
      assert.ok(personalForm, 'The approved personal profile has a working account form.');
      assert.match(personalForm, /name="returnTo" value="\/account\/profile"/);
      await seller.client.post('/account/profile').type('form').send({ _csrf: csrf(profile.text), returnTo: '/account/profile',
        name: 'Updated Seller Identity', phone: before.phone, country: 'UG', currency: 'UGX', locale: 'en-UG' })
        .expect(302).expect('location', '/account/profile');
      const saved = await seller.client.get('/account/profile').expect(200);
      assertSellerShell(saved);
      assert.match(saved.text, /name="name" value="Updated Seller Identity"/);
      assert.equal((await User.findById(seller.user._id)).role, 'seller');
      assert.equal((await User.findById(customer.user._id)).name, peer.name);

      const avatar = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#ed6c16' } }).png().toBuffer();
      await seller.client.post('/account/avatar').field('_csrf', csrf(saved.text)).field('returnTo', '/account/profile')
        .attach('avatar', avatar, { filename: 'seller-avatar.png', contentType: 'image/png' })
        .expect(302).expect('location', '/account/profile');
      const withPhoto = await seller.client.get('/account/profile').expect(200);
      assertSellerShell(withPhoto);
      const photoUrl = withPhoto.text.match(/id="customerAvatarPreview" src="([^"]+)"/)?.[1];
      assert.match(photoUrl, /^\/account\/avatar\?v=/);
      assert.ok(withPhoto.text.includes(`<img src="${photoUrl}"`), 'The shell header uses the same owned personal photo.');
      const security = await seller.client.get('/account/security').expect(200);
      assert.ok(security.text.includes(`<img src="${photoUrl}"`));
      const photo = await seller.client.get(photoUrl).expect(200).expect('content-type', /image\/webp/);
      assert.match(photo.headers['cache-control'], /private, no-store/);
      assert.equal((await sharp(photo.body).metadata()).width, 320);
      await customer.client.get(photoUrl).expect(404);
      await seller.client.post('/account/avatar/delete').type('form').send({ _csrf: csrf(withPhoto.text), returnTo: '/account/profile' })
        .expect(302).expect('location', '/account/profile');
      const withoutPhoto = await seller.client.get('/account/profile').expect(200);
      assertSellerShell(withoutPhoto);
      assert.match(withoutPhoto.text.match(/id="customerAvatarPreview" src="([^"]+)"/)?.[1],
        /^\/approved-dashboard\/assets\/avatar\.svg(?:\?v=[a-f0-9]{16})?$/);
      await seller.client.get(photoUrl).expect(404);
    });

    await t.test('seller notification navigation and read actions retain the Seller shell and expose only its own account alerts', async () => {
      const own = await Notification.create({ publicId: `ntf_shell_${seller.user.publicId}`, userId: seller.user._id,
        country: 'UG', type: 'account', title: 'SELLER_PRIVATE_ACCOUNT_NOTICE', body: 'Seller account notice.' });
      const peer = await Notification.create({ publicId: `ntf_shell_${customer.user.publicId}`, userId: customer.user._id,
        country: 'UG', type: 'account', title: 'CUSTOMER_PRIVATE_ACCOUNT_NOTICE', body: 'Customer account notice.' });
      const notifications = await seller.client.get('/notifications').expect(200);
      assertSellerShell(notifications);
      assert.match(notifications.text, /<h1>Notifications<\/h1>/);
      assert.match(notifications.text, /SELLER_PRIVATE_ACCOUNT_NOTICE/);
      assert.doesNotMatch(notifications.text, /CUSTOMER_PRIVATE_ACCOUNT_NOTICE/);
      await seller.client.post(`/notifications/${peer.publicId}/read`).type('form').send({ _csrf: csrf(notifications.text) }).expect(404);
      await seller.client.post(`/notifications/${own.publicId}/read`).type('form').send({ _csrf: csrf(notifications.text) }).expect(302).expect('location', '/notifications');
      const read = await seller.client.get('/notifications').expect(200);
      assertSellerShell(read);
      assert.ok((await Notification.findById(own._id)).readAt);
      assert.equal((await Notification.findById(peer._id)).readAt, undefined);
    });

    await t.test('other operational roles keep their authorized personal security layout instead of Customer shopping navigation', async () => {
      for (const [role, workspace, label] of [['warehouse', 'warehouse', 'Warehouse'], ['moderator', 'moderator', 'Moderation'], ['finance', 'finance', 'Finance'], ['country_admin', 'admin', 'Admin'], ['super_admin', 'superadmin', 'Super Admin']]) {
        const identity = await actor(role);
        const security = await identity.client.get('/account/security').expect(200);
        assert.match(security.text, new RegExp(`data-dashboard-workspace="${workspace}"`));
        assert.match(security.text, new RegExp(`<small>${label}<\/small>`));
        assert.doesNotMatch(sidebar(security.text), /Classic Club|My Orders|Wishlist|Rewards|Profile Settings/);
        assert.doesNotMatch(security.text, /aria-label="Wishlist"|aria-label="Cart"|Development preview|role-workspaces\.js/);
        assert.match(security.text, /action="\/account\/mfa\/begin"/);
        const profile = await identity.client.get('/account/profile').expect(200);
        assert.match(profile.text, new RegExp(`data-dashboard-workspace="${workspace}"`));
        assert.match(profile.text, new RegExp(`<small>${label}<\/small>`));
        assert.match(profile.text, /<h1>Profile Settings<\/h1>/);
        assert.match(profile.text, new RegExp(`name="name" value="${identity.user.name}"`));
        assert.doesNotMatch(sidebar(profile.text), /Classic Club|My Orders|Wishlist|Rewards|Profile Settings/);
        assert.doesNotMatch(profile.text, /aria-label="Wishlist"|aria-label="Cart"/);
        assert.equal(await Store.countDocuments({ ownerUserId: identity.user._id }), 0);
      }
    });

    await t.test('ordinary customers retain their approved shopping shell while sellers keep Seller navigation on their personal purchases', async () => {
      const security = await customer.client.get('/account/security').expect(200);
      assert.match(security.text, /data-dashboard-workspace="customer"/);
      assert.match(security.text, /<small>Customer<\/small>/);
      assert.match(sidebar(security.text), /Classic Club|My Orders|Wishlist|Rewards|Profile Settings/);
      assert.doesNotMatch(sidebar(security.text), /seller-overview|seller-products|Store health/);
      assert.match(security.text, /aria-label="Wishlist"/);
      assert.match(security.text, /aria-label="Cart"/);
      const orders = await seller.client.get('/orders').expect(200);
      assertSellerShell(orders);
      assert.match(orders.text, /<h1>My Orders<\/h1>/);
      assert.equal((await User.findById(seller.user._id)).role, 'seller');
    });

    await t.test('explicitly selected fulfilment membership keeps the correct MFA shell without promoting customer access and revocation takes effect immediately', async () => {
      const currentSeller = await User.findById(seller.user._id).select('+security.tokenVersion');
      const staff = await actor(), access = await getOrCreateStore(currentSeller);
      const membership = await StoreMember.create({ publicId: `stm_shell_${staff.user.publicId}`, storeId: access.store._id, userId: staff.user._id,
        role: 'fulfilment', status: 'active', invitedByUserId: seller.user._id, acceptedAt: new Date() });
      // Acceptance alone does not switch a Customer into an operational shell.
      // Complete personal MFA, then make the same explicit store selection the
      // recipient makes from the accepted invitation's Open store action.
      await staff.client.get('/seller/orders').expect(403);
      const personalSecurity = await staff.client.get('/account/security').expect(200);
      assert.match(personalSecurity.text, /data-dashboard-workspace="customer"/);
      await staff.client.post('/account/mfa/begin').type('form').send({ currentPassword: password, _csrf: csrf(personalSecurity.text) }).expect(302);
      const pending = await pendingMfaEnrollment(staff.user._id);
      const enrollment = await staff.client.get('/account/security').expect(200);
      await staff.client.post('/account/mfa/confirm').type('form').send({ code: totpCode(pending.secret), _csrf: csrf(enrollment.text) }).expect(302);
      const enrolledSecurity = await staff.client.get('/account/security').expect(200);
      await staff.client.post('/seller/workspace').type('form').send({ storePublicId: access.store.publicId, _csrf: csrf(enrolledSecurity.text) })
        .expect(302).expect('location', '/seller/orders');
      const security = await staff.client.get('/account/security').expect(200);
      assertSellerShell(security);
      assert.match(security.text, /Enabled for this account/);
      assert.doesNotMatch(security.text, /action="\/account\/mfa\/disable"/);
      assert.match(sidebar(security.text), /href="\/seller\/orders"/);
      assert.doesNotMatch(sidebar(security.text), /href="\/seller\/products"|href="\/seller\/store"/);
      assert.equal((await User.findById(staff.user._id)).role, 'customer');
      const currentMembership = await StoreMember.findById(membership._id);
      currentMembership.status = 'revoked';
      currentMembership.revokedAt = new Date();
      await currentMembership.save();
      const revoked = await staff.client.get('/account/security').expect(200);
      assert.match(revoked.text, /data-dashboard-workspace="customer"/);
      await staff.client.get('/seller/orders').expect(403);
      assert.equal((await User.findById(staff.user._id)).role, 'customer');
    });

    await t.test('an owned store alone does not silently reclassify a customer account', async () => {
      await Store.create({ publicId: `str_shell_legacy_${suffix}`, ownerUserId: customer.user._id, name: 'Legacy customer-owned store',
        slug: `legacy-customer-${suffix}`, country: 'UG', currency: 'UGX' });
      const security = await customer.client.get('/account/security').expect(200);
      assert.match(security.text, /data-dashboard-workspace="customer"/);
      assert.equal((await User.findById(customer.user._id)).role, 'customer');
      assert.equal(await StoreMember.countDocuments({ userId: customer.user._id }), 0);
    });

    await t.test('desktop and mobile seller security links navigate actual seller products, orders, overview and settings without customer panels', async () => {
      // The account-shell fixture starts with a pending store. Fulfilment remains
      // blocked until the independently approved store state is supplied here.
      await Store.updateOne({ ownerUserId: seller.user._id }, { $set: { status: 'verified', verifiedAt: new Date() } });
      server = http.createServer(app);
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
      for (const [index, width] of [390, 1366].entries()) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        const page = await context.newPage();
        try {
          await page.goto(base + '/login');
          await page.locator('input[name="email"]').fill(seller.user.email);
          await page.locator('input[name="password"]').fill(password);
          await Promise.all([page.waitForURL(base + '/mfa'), page.locator('form[action="/login"] button[type="submit"]').click()]);
          await page.locator('input[name="code"]').fill(recoveryCodes[index]);
          await Promise.all([page.waitForURL(base + '/seller/overview'), page.locator('form[action="/mfa"] button[type="submit"]').click()]);
          await page.goto(base + '/account/security');
          assert.equal(await page.locator('body').getAttribute('data-dashboard-workspace'), 'seller');
          assert.equal(await page.getByRole('heading', { name: 'Password & security', exact: true }).count(), 1);
          assert.equal(await page.locator('#sidebar').getByText('Classic Club', { exact: true }).count(), 0);
          await page.locator('#profileButton').click();
          await page.locator('#profileMenu [data-page-target="seller-store"]:not([data-profile-tab])').click();
          await page.waitForURL(base + '/seller/store');
          assert.equal(await page.locator('body').getAttribute('data-dashboard-workspace'), 'seller');
          await page.locator('#profileButton').click();
          await page.locator('#profileMenu [data-profile-tab="security"]').click();
          await page.waitForURL(base + '/account/security');
          await page.goto(base + '/account/profile');
          assert.equal(await page.getByRole('heading', { name: 'Profile Settings', exact: true }).count(), 1);
          assert.equal(await page.locator('body').getAttribute('data-dashboard-workspace'), 'seller');
          await page.goto(base + '/account/security');
          // The approved mobile header hides the bell; keep that design and
          // verify the same personal notifications route directly on mobile.
          if (width === 1366) await page.getByRole('button', { name: 'Notifications', exact: true }).click();
          else await page.goto(base + '/notifications');
          await page.waitForURL(base + '/notifications');
          assert.equal(await page.locator('body').getAttribute('data-dashboard-workspace'), 'seller');
          assert.equal(await page.getByRole('heading', { name: 'Notifications', exact: true }).count(), 1);
          await page.goto(base + '/account/security');
          for (const [name, route] of [['Products', '/seller/products'], ['Orders', '/seller/orders'], ['Overview', '/seller/overview'], ['Store Settings', '/seller/store']]) {
            if (width === 390) await page.locator('#mobileMenuBtn').click();
            await page.locator('#sidebar').getByRole('link', { name, exact: true }).click();
            await page.waitForURL(base + route);
            assert.equal(await page.locator('body').getAttribute('data-dashboard-workspace'), 'seller', `${route}: ${await page.locator('main').innerText()}`);
            assert.equal(await page.locator('#sidebar').getByText('Classic Club', { exact: true }).count(), 0);
            await page.goto(base + '/account/security');
          }
          await page.screenshot({ path: `/tmp/classicmart-seller-account-shell-${width}.png`, fullPage: true, animations: 'disabled' });
        } finally { await context.close(); }
      }
    });
  } finally {
    for (const transport of transports) transport.destroy();
    await Promise.allSettled([
      browser?.close(),
      server && new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
    ]);
    try { if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase(); }
    finally { await mongoose.disconnect(); }
  }
});

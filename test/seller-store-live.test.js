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
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('seller store settings persist through authenticated forms, reject stale edits and isolate staff and stores', { skip: !uri, timeout: 180_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  const isolatedDatabase = `classicmart_seller_store_test_${suffix}`;
  await mongoose.connect(uri, { dbName: isolatedDatabase });
  const { createApp } = await import('../src/app.js');
  const { User, Store, StoreMember, AuditLog, CountrySetting, Device } = await import('../src/models/index.js');
  const { hashPassword, hashToken } = await import('../src/core/crypto.js');
  const { pendingMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
  const { saveSellerStoreSettings } = await import('../src/services/seller-store-settings.js');
  const { getOrCreateStore, sellerStoreAccesses } = await import('../src/services/store.js');
  const password = `Store-${suffix}A1!`;
  const users = [];
  const transports = [];
  let server, browser;
  const app = createApp(null);
  async function actor(role = 'seller', onboarded = true) {
    const index = users.length;
    const email = `seller-store-${suffix}-${index}@example.com`;
    const phone = '+2567' + crypto.randomInt(10000000, 99999999);
    const user = await User.create({ publicId: `usr_store_${suffix}_${index}`, name: `Store Member ${index}`, email, emailNormalized: email, phone, phoneNormalized: phone,
      passwordHash: await hashPassword(password), role, emailVerifiedAt: new Date(), onboardingCompletedAt: onboarded ? new Date() : undefined, country: 'UG', currency: 'UGX', consents: { terms: true, privacy: true, recordedAt: new Date() } });
    users.push(user);
    const transport = new http.Agent({ localAddress: `127.0.0.${index + 50}`, keepAlive: false });
    transports.push(transport);
    const agent = request.agent(app).use(req => req.agent(transport));
    const form = await agent.get('/login').expect(200);
    await agent.post('/login').type('form').send({ email, password, _csrf: csrf(form.text) }).expect(302);
    return { user, agent };
  }
  async function enroll(agent, user) {
    const security = await agent.get('/account/security').expect(200);
    await agent.post('/account/mfa/begin').type('form').send({ currentPassword: password, _csrf: csrf(security.text) }).expect(302);
    const pending = await pendingMfaEnrollment(user._id);
    assert.ok(pending?.secret);
    await agent.post('/account/mfa/confirm').type('form').send({ code: totpCode(pending.secret), _csrf: csrf((await agent.get('/account/security')).text) }).expect(302);
    assert.equal((await User.findById(user._id)).security.mfaEnabled, true);
    // Enrollment revokes the previous token version; direct service calls must
    // carry the same refreshed identity as the authenticated browser session.
    Object.assign(user, await User.findById(user._id));
  }
  async function serviceRequest(user, store, body) {
    const sessionID = crypto.randomUUID();
    const device = await Device.create({ publicId: `dev_store_${suffix}_${crypto.randomBytes(5).toString('hex')}`, userId: user._id,
      sessionHash: hashToken(sessionID), label: 'Current store settings fixture', userAgent: 'Seller store fixture', ipHash: hashToken('127.0.0.1'), lastSeenAt: new Date() });
    return { user, store, body, device, sessionID, session: { userId: String(user._id), tokenVersion: user.security.tokenVersion,
      activeStorePublicId: store.publicId, mfaVerifiedAt: Date.now() }, country: { code: 'UG', currency: 'UGX' }, ip: '127.0.0.1', get: () => '' };
  }
  try {
    // Importing the application registers all models and automatically starts
    // their collection/index initialization. Wait for that work before this
    // isolated fixture can later drop its database; dropping during a queued
    // index build can crash MongoDB itself rather than report a test failure.
    await Promise.all(Object.values(mongoose.models).map(model => model.init()));
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', returnWindowDays: 14, platformFeeBps: 700, taxBps: 1800 });
    await request(app).get('/seller/store').expect(302).expect('location', '/login?next=%2Fseller%2Fstore');
    const customer = await actor('customer');
    const customerProfile = await customer.agent.get('/profile').expect(200);
    await customer.agent.get('/seller/store').expect(403);
    await customer.agent.post('/seller/store/identity').type('form').send({ _csrf: csrf(customerProfile.text), name: 'Unauthorized' }).expect(403);
    const owner = await actor('customer', false);
    await owner.agent.get('/seller/store').expect(302).expect('location', '/onboarding');
    const onboarding = await owner.agent.get('/onboarding').expect(200);
    await owner.agent.post('/onboarding').type('form').send({ role: 'seller', publicName: 'Seller Owner', businessName: `Live Store ${suffix}`, location: 'Kampala', _csrf: csrf(onboarding.text) }).expect(302).expect('location', '/seller/overview');
    owner.user = await User.findById(owner.user._id);
    assert.equal(owner.user.role, 'seller');
    await owner.agent.get('/seller/store').expect(302).expect('location', '/account/security?next=%2Fseller%2Fstore');
    assert.equal(await Store.countDocuments({ ownerUserId: owner.user._id }), 0);
    await enroll(owner.agent, owner.user);
    const firstVisits = await Promise.all(Array.from({ length: 20 }, () => getOrCreateStore(owner.user)));
    assert.equal(new Set(firstVisits.map(visit => visit.store.publicId)).size, 1);
    assert.equal(await Store.countDocuments({ ownerUserId: owner.user._id }), 1);
    let page = await owner.agent.get('/seller/store').expect(200);
    const store = await Store.findOne({ ownerUserId: owner.user._id });
    assert.equal(store.status, 'pending_verification');
    const ownerMembership = await StoreMember.findOne({ storeId: store._id, userId: owner.user._id }).lean();
    assert.ok(ownerMembership);
    await getOrCreateStore(owner.user);
    assert.deepEqual(await StoreMember.findById(ownerMembership._id).lean(), ownerMembership, 'ordinary reads preserve owner membership versions and timestamps');
    for (const override of [{ status: 'revoked' }, { status: 'invited' }, { role: 'admin' }]) {
      await StoreMember.updateOne({ _id: ownerMembership._id }, { $set: { status: 'active', role: 'owner', ...override } });
      const deniedMembership = await StoreMember.findById(ownerMembership._id).lean();
      assert.equal((await sellerStoreAccesses(owner.user)).some(row => row.store.publicId === store.publicId), false);
      await assert.rejects(getOrCreateStore(owner.user), error => error.status === 403 && error.code === 'SELLER_WORKSPACE_FORBIDDEN');
      const denied = await owner.agent.get('/seller/store').set('accept', 'application/json').expect(403);
      assert.equal(denied.body.error.code, 'SELLER_WORKSPACE_FORBIDDEN');
      assert.deepEqual(await StoreMember.findById(ownerMembership._id).lean(), deniedMembership, 'a request cannot reactivate or upgrade the existing owner row');
      assert.equal(await Store.countDocuments({ ownerUserId: owner.user._id }), 1);
    }
    await StoreMember.updateOne({ _id: ownerMembership._id }, { $set: { status: 'active', role: 'owner' }, $unset: { acceptedAt: 1 } });
    const legacyMembership = await StoreMember.findById(ownerMembership._id).lean();
    assert.equal((await getOrCreateStore(owner.user)).membership.role, 'owner');
    assert.deepEqual(await StoreMember.findById(ownerMembership._id).lean(), legacyMembership, 'a valid legacy owner row remains usable without a read rewriting it');
    await StoreMember.updateOne({ _id: ownerMembership._id }, { $set: { acceptedAt: ownerMembership.acceptedAt } });
    assert.match(page.text, /Uganda \(\+256\)/);
    assert.match(page.text, /seller-store-live\.js/);
    assert.doesNotMatch(page.text, /Development preview|Stanbic|9421|hello@classicmart.example|\/approved-dashboard\/role-workspaces\.js/);
    assert.match(page.headers['cache-control'], /private/);
    assert.match(page.headers['cache-control'], /no-store/);
    assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
    await owner.agent.get('/dashboard/seller-store?section=operations').expect(308).expect('location', '/seller/store?section=operations');
    await owner.agent.post('/seller/store/identity').type('form').send({ name: 'No CSRF' }).expect(403);
    const identity = { version: store.__v, name: `Approved Store ${suffix}`, description: 'A real saved store profile.', supportEmail: 'SUPPORT@example.com', supportPhoneCountry: 'UG', supportPhone: '0781977217', _csrf: csrf(page.text), country: 'KE', currency: 'KES', status: 'verified', ownerUserId: customer.user._id.toString() };
    const invalidPhone = await owner.agent.post('/seller/store/identity').type('form').send({ ...identity, supportPhone: '123' }).expect(422);
    assert.match(invalidPhone.text, /seller-store-error/);
    assert.match(invalidPhone.text, /name="supportPhone" type="tel" value="123"/);
    assert.match(invalidPhone.text, /seller-store-live\.js/);
    await owner.agent.post('/seller/store/identity').type('form').send({ ...identity, supportPhone: '+256781977217999999' }).expect(422);
    await owner.agent.post('/seller/store/identity').type('form').send(identity).expect(302).expect('location', '/seller/store?section=identity');
    let saved = await Store.findById(store._id);
    assert.equal(saved.name, identity.name);
    assert.equal(saved.operations.supportPhone, '+256781977217');
    assert.equal(saved.operations.supportEmail, 'support@example.com');
    assert.equal(saved.country, 'UG'); assert.equal(saved.currency, 'UGX');
    assert.equal(saved.status, 'pending_verification'); assert.equal(String(saved.ownerUserId), String(owner.user._id));
    assert.equal(saved.__v, store.__v + 1);
    const operations = { version: store.__v, primaryCategory: 'Electronics', pickupCity: 'Kampala', fulfillmentMode: 'hybrid', _csrf: csrf(page.text) };
    await owner.agent.post('/seller/store/operations').type('form').send(operations).expect(409);
    page = await owner.agent.get('/seller/store').expect(200);
    assert.match(page.text, new RegExp(identity.name));
    await owner.agent.post('/seller/store/operations').type('form').send({ ...operations, version: saved.__v, _csrf: csrf(page.text) }).expect(302);
    saved = await Store.findById(store._id);
    assert.equal(saved.operations.pickupCity, 'Kampala'); assert.equal(saved.operations.fulfillmentMode, 'hybrid');
    assert.equal(saved.operations.supportPhone, '+256781977217');
    assert.equal(await AuditLog.countDocuments({ actorId: owner.user._id, action: 'seller.store_settings_updated' }), 2);

    const other = await actor(); await enroll(other.agent, other.user);
    const otherPage = await other.agent.get('/seller/store?storePublicId=' + store.publicId).expect(200);
    assert.doesNotMatch(otherPage.text, new RegExp(identity.name));
    await other.agent.post('/seller/store/identity').type('form').send({ ...identity, _csrf: csrf(otherPage.text), storeId: String(store._id) }).expect(302);
    assert.equal((await Store.findById(store._id)).__v, saved.__v);
    const staff = await actor('customer'); await enroll(staff.agent, staff.user);
    const member = await StoreMember.create({ publicId: `stm_store_${suffix}`, storeId: store._id, userId: staff.user._id, invitedByUserId: owner.user._id, role: 'catalogue', status: 'active', acceptedAt: new Date() });
    const staffSecurity = await staff.agent.get('/account/security').expect(200);
    await staff.agent.post('/seller/workspace').set('accept', 'application/json').type('form').send({ storePublicId: store.publicId, _csrf: csrf(staffSecurity.text) }).expect(200);
    await staff.agent.get('/seller/store').expect(403);
    const staffWrite = await staff.agent.post('/seller/store/identity').set('accept', 'application/json').type('form').send({ ...identity, _csrf: csrf(staffSecurity.text) }).expect(403);
    assert.equal(staffWrite.body.error.code, 'STORE_PERMISSION_DENIED');
    await StoreMember.updateOne({ _id: member._id }, { $set: { status: 'revoked' } });
    saved = await Store.findById(store._id);
    await assert.rejects(saveSellerStoreSettings(await serviceRequest(staff.user, store, { ...identity, version: saved.__v }), 'identity'), { code: 'STORE_PERMISSION_DENIED' });
    const previousName = saved.name;
    t.mock.method(AuditLog, 'create', async () => { throw new Error('Audit unavailable'); });
    await assert.rejects(saveSellerStoreSettings(await serviceRequest(owner.user, store, { ...identity, name: 'Must roll back', version: saved.__v }), 'identity'), /Audit unavailable/);
    t.mock.restoreAll();
    assert.equal((await Store.findById(store._id)).name, previousName);
    await Store.updateOne({ _id: store._id }, { $set: { status: 'suspended' } });
    const suspendedPage = await owner.agent.get('/seller/store');
    assert.equal(suspendedPage.status, 200, `Suspended settings read: ${JSON.stringify(suspendedPage.body?.error || suspendedPage.text.slice(0, 400))}`);
    await owner.agent.get('/seller/store/').expect(200);
    await owner.agent.post('/seller/store/identity').type('form').send({ ...identity, version: saved.__v, _csrf: csrf(suspendedPage.text) }).expect(409);
    assert.match((await owner.agent.get('/seller/store')).text, /Settings cannot be changed/);
    await Store.updateOne({ _id: store._id }, { $set: { status: 'pending_verification' } });

    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
      server = app.listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
      const browserPage = await browser.newPage();
      const errors = []; browserPage.on('pageerror', error => errors.push(error.message));
      const cookie = (await owner.agent.get('/seller/store')).headers['set-cookie'].find(value => value.startsWith('cm.sid=')).split(';')[0];
      const split = cookie.indexOf('=');
      await browserPage.context().addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: base }]);
      for (const width of [1366, 390]) {
        await browserPage.setViewportSize({ width, height: 950 });
        const browserResponse = await browserPage.goto(base + '/seller/store');
        await browserPage.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
        await browserPage.screenshot({ path: `/tmp/classic-mart-seller-store-initial-${width}.png`, fullPage: true });
        assert.equal(browserResponse.status(), 200, `Browser reached ${new URL(browserPage.url()).pathname}`);
        assert.equal(await browserPage.locator('#sellerIdentity').count(), 1, `Browser rendered ${await browserPage.title()}`);
        assert.equal(new URL(browserPage.url()).hash, '');
        assert.ok(await browserPage.locator('#sellerIdentity').isVisible());
        const phoneCountry = browserPage.getByRole('combobox', { name: 'Phone country code', exact: true });
        assert.equal(await phoneCountry.evaluate(element => getComputedStyle(element).fontWeight), '400');
        assert.equal(await phoneCountry.evaluate(element => getComputedStyle(element).color), 'rgba(0, 0, 0, 0)');
        assert.equal(await phoneCountry.evaluate(element => getComputedStyle(element).borderWidth), '0px');
        assert.equal(await browserPage.locator('.phone-country-display').textContent(), '+256');
        await phoneCountry.selectOption('KE');
        assert.equal(await browserPage.locator('.phone-country-display').textContent(), '+254');
        assert.equal(await browserPage.locator('#sellerIdentity [name="supportPhone"]').inputValue(), '781977217');
        await phoneCountry.selectOption('UG');
        await browserPage.locator('#sellerIdentity button[type="submit"]').click();
        await browserPage.waitForURL('**/seller/store?section=identity');
        assert.equal((await Store.findById(store._id)).operations.supportPhone, '+256781977217');
        await browserPage.locator('[data-seller-settings-tab="operations"]').click();
        assert.ok(await browserPage.locator('#sellerOperations').isVisible());
        assert.equal(await browserPage.locator('#sellerIdentity').isVisible(), false);
        await browserPage.locator('[name="pickupCity"]').fill(width === 390 ? 'Entebbe' : 'Jinja');
        await browserPage.locator('#sellerOperations button[type="submit"]').click();
        await browserPage.waitForURL('**/seller/store?section=operations');
        assert.equal((await Store.findById(store._id)).operations.pickupCity, width === 390 ? 'Entebbe' : 'Jinja');
        assert.equal(await browserPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await browserPage.screenshot({ path: `/tmp/classic-mart-seller-store-${width}.png`, fullPage: true });
      }
      assert.deepEqual(errors, []);
    }
  } finally {
    t.mock.restoreAll();
    for (const transport of transports) transport.destroy();
    await Promise.allSettled([
      browser?.close(),
      server && new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
    ]);
    try {
      await Promise.all(Object.values(mongoose.models).map(model => model.init()));
      assert.equal(mongoose.connection.name, isolatedDatabase);
      await mongoose.connection.dropDatabase();
    } finally { await mongoose.disconnect(); }
  }
});

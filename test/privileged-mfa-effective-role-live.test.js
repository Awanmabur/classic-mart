import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
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

test('personal layouts and MFA policy follow real active platform grants instead of stale role mirrors', { skip: !uri, timeout: 120_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: `classicmart_effective_mfa_role_test_${suffix}` });
  const transport = new http.Agent({ localAddress: '127.0.0.180', keepAlive: false });
  const transports = [transport];
  try {
    const { createApp } = await import('../src/app.js');
    const models = await import('../src/models/index.js');
    const { User, PlatformGrant, Device, CountrySetting, Store } = models;
    const { hashPassword } = await import('../src/core/crypto.js');
    const { pendingMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
    await Promise.all(Object.values(models).filter(model => typeof model?.init === 'function').map(model => model.init()));
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG',
      timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true });
    const password = `Effective-${suffix}-A1!`, email = `effective-${suffix}@example.com`;
    const user = await User.create({ publicId: `usr_effective_${suffix}`, name: 'Grant Actor', email,
      emailNormalized: email, phone: '+256701234567', phoneNormalized: '+256701234567',
      passwordHash: await hashPassword(password), role: 'customer', country: 'UG', currency: 'UGX', locale: 'en-UG',
      platformAccessManagedAt: new Date(), emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
      consents: { terms: true, privacy: true, recordedAt: new Date() } });
    const grant = await PlatformGrant.create({ publicId: `pgr_effective_${suffix}`, userId: user._id,
      role: 'finance', operationalCountries: ['UG'], startsAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 86_400_000), status: 'active', reason: 'Isolated effective-role verification.',
      approvalPublicId: `apr_effective_${suffix}`, approvedByUserId: user._id });
    const client = request.agent(createApp(null)).use(req => req.agent(transport));
    const login = await client.get('/login').expect(200);
    await client.post('/login').type('form').send({ email, password, _csrf: csrf(login.text) })
      .expect(302).expect('location', '/finance/overview');
    let recoveryCodes;

    await t.test('active Finance grant supplies the Finance shell and privileged MFA boundary with a customer mirror', async () => {
      assert.equal((await User.findById(user._id)).role, 'customer');
      const security = await client.get('/account/security').expect(200);
      assert.match(security.text, /data-dashboard-workspace="finance"/);
      assert.match(security.text, /<small>Finance<\/small>/);
      assert.doesNotMatch(security.text, /<small>Customer<\/small>|<h3>Classic Club<\/h3>|aria-label="Wishlist"/);
      await client.get('/finance').expect(302).expect('location', '/account/security?next=%2Ffinance');
      await client.get('/FiNaNcE').expect(302).expect('location', '/account/security?next=%2FFiNaNcE');
      const blocked = await client.get('/api/v1/finance/refunds').set('Accept', 'application/json').expect(403);
      assert.match(blocked.text, /MFA_ENROLLMENT_REQUIRED/);
      const uppercaseApi = await client.get('/API/v1/FINANCE/refunds').set('Accept', 'application/json').expect(403);
      assert.match(uppercaseApi.text, /MFA_ENROLLMENT_REQUIRED/);
      assert.equal(await Store.countDocuments({ ownerUserId: user._id }), 0);
      await client.post('/account/mfa/begin').type('form').send({ currentPassword: password, _csrf: csrf(security.text) }).expect(302);
      const pending = await pendingMfaEnrollment(user._id);
      const enrollment = await client.get('/account/security').expect(200);
      await client.post('/account/mfa/confirm').type('form').send({ code: totpCode(pending.secret), _csrf: csrf(enrollment.text) }).expect(302);
      const enabled = await client.get('/account/security').expect(200);
      assert.match(enabled.text, /data-dashboard-workspace="finance"/);
      const codes = [...enabled.text.matchAll(/<code>([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})<\/code>/g)].map(match => match[1]);
      assert.equal(codes.length, 10);
      recoveryCodes = codes;
      assert.equal((await User.findById(user._id)).role, 'customer');
    });

    await t.test('successful MFA login resolves the current grant before choosing its landing page', async () => {
      const security = await client.get('/account/security').expect(200);
      await client.post('/logout').type('form').send({ _csrf: csrf(security.text) }).expect(302);
      const form = await client.get('/login').expect(200);
      await client.post('/login').type('form').send({ email, password, _csrf: csrf(form.text) })
        .expect(302).expect('location', '/mfa');
      const challenge = await client.get('/mfa').expect(200);
      await client.post('/mfa').type('form').send({ code: recoveryCodes[1], _csrf: csrf(challenge.text) })
        .expect(302).expect('location', '/finance/overview');
      const resumed = await client.get('/account/security').expect(200);
      assert.match(resumed.text, /data-dashboard-workspace="finance"/);
    });

    await t.test('alternate-case Seller routes cannot bypass enrollment or provision a store before MFA', async () => {
      const sellerEmail = `case-seller-${suffix}@example.com`;
      const seller = await User.create({ publicId: `usr_case_seller_${suffix}`, name: 'Case Seller', email: sellerEmail,
        emailNormalized: sellerEmail, phone: '+256702234567', phoneNormalized: '+256702234567',
        passwordHash: await hashPassword(password), role: 'seller', country: 'UG', currency: 'UGX', locale: 'en-UG',
        emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), roleProfile: { businessName: 'Case Store' },
        consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const sellerTransport = new http.Agent({ localAddress: '127.0.0.181', keepAlive: false });
      transports.push(sellerTransport);
      const sellerClient = request.agent(createApp(null)).use(req => req.agent(sellerTransport));
      const form = await sellerClient.get('/login').expect(200);
      await sellerClient.post('/login').type('form').send({ email: sellerEmail, password, _csrf: csrf(form.text) })
        .expect(302).expect('location', '/seller/overview');
      for (const path of ['/seller/store', '/Seller/store', '/SELLER/products', '/SELLER/overview']) {
        await sellerClient.get(path).expect(302).expect('location', '/account/security?next=' + encodeURIComponent(path));
      }
      const blocked = await sellerClient.get('/API/v1/SELLER/inventory').set('Accept', 'application/json').expect(403);
      assert.match(blocked.text, /MFA_ENROLLMENT_REQUIRED/);
      const security = await sellerClient.get('/account/security').expect(200);
      const mutation = '/SELLER/store/identity';
      await sellerClient.post(mutation).type('form').send({ name: 'Forbidden Update', _csrf: csrf(security.text) })
        .expect(302).expect('location', '/account/security?next=' + encodeURIComponent(mutation));
      assert.equal((await User.findById(seller._id)).security.mfaEnabled, false);
      assert.equal(await Store.countDocuments({ ownerUserId: seller._id }), 0);
    });

    await t.test('active operational grant prevents disabling MFA before consuming any recovery code', async () => {
      const security = await client.get('/account/security').expect(200);
      assert.doesNotMatch(security.text, /action="\/account\/mfa\/disable"/);
      await client.post('/account/mfa/disable').type('form').send({ currentPassword: password,
        code: recoveryCodes[0], _csrf: csrf(security.text) }).expect(403);
      const retained = await User.findById(user._id).select('+security.mfaRecoveryCodeHashes');
      assert.equal(retained.security.mfaEnabled, true);
      assert.equal(retained.security.mfaRecoveryCodeHashes.length, 9);
    });

    await t.test('revocation overrides a stale Finance mirror immediately and removes operational privilege', async () => {
      await PlatformGrant.updateOne({ _id: grant._id }, { $set: { status: 'revoked', revokedAt: new Date() } });
      await User.updateOne({ _id: user._id }, { $set: { role: 'finance' } });
      let security = await client.get('/account/security').expect(200);
      assert.match(security.text, /data-dashboard-workspace="customer"/);
      assert.match(security.text, /<small>Customer<\/small>/);
      assert.match(security.text, /action="\/account\/mfa\/disable"/);
      await client.get('/finance').expect(403);
      await client.get('/seller/products').expect(403);
      await client.get('/onboarding/seller').expect(403);
      assert.equal(await Store.countDocuments({ ownerUserId: user._id }), 0);
      await client.post('/logout').type('form').send({ _csrf: csrf(security.text) }).expect(302);
      const form = await client.get('/login').expect(200);
      await client.post('/login').type('form').send({ email, password, _csrf: csrf(form.text) })
        .expect(302).expect('location', '/mfa');
      const challenge = await client.get('/mfa').expect(200);
      await client.post('/mfa').type('form').send({ code: recoveryCodes[2], _csrf: csrf(challenge.text) })
        .expect(302).expect('location', '/dashboard');
      const landing = await client.get('/dashboard').expect(200);
      assert.match(landing.text, /data-dashboard-workspace="customer"/);
      security = await client.get('/account/security').expect(200);
      await client.post('/account/mfa/disable').type('form').send({ currentPassword: password,
        code: recoveryCodes[0], _csrf: csrf(security.text) }).expect(302).expect('location', '/account/security');
      assert.equal((await User.findById(user._id)).security.mfaEnabled, false);
      const personal = await client.get('/account/security').expect(200);
      assert.match(personal.text, /data-dashboard-workspace="customer"/);
    });
  } finally {
    for (const connection of transports) connection.destroy();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

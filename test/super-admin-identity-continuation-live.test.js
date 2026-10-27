import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';

// Development login may simplify customer journeys, but it must not bypass
// Super Admin identity or leave a legitimate administrator at a dead-end 403.
process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'true';
process.env.PRIVILEGED_MFA_REQUIRED = 'false';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;
const csrf = html => {
  const token = html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/);
  assert.ok(token, 'The actual page supplies CSRF protection.');
  return token[1];
};

test('Super Admin setup guides the current global grant to its own missing identity step even in simple login', { skip: !uri, timeout: 120_000 }, async t => {
  const target = new URL(uri);
  assert.equal(target.hostname, '127.0.0.1');
  assert.match(target.pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex'), transports = [];
  await mongoose.connect(uri, { dbName: 'classicmart_super_identity_test_' + suffix });
  try {
    const { createApp } = await import('../src/app.js');
    const models = await import('../src/models/index.js');
    const { User, PlatformGrant, CountrySetting } = models;
    const { hashPassword } = await import('../src/core/crypto.js');
    const { pendingMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
    await Promise.all(Object.values(models).filter(model => typeof model?.init === 'function').map(model => model.init()));
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true });
    const app = createApp(null), password = 'Super-identity-' + suffix + '-A1!', passwordHash = await hashPassword(password);
    let sequence = 0;
    async function identity({ role = 'super_admin', managed = true, ...overrides } = {}) {
      const index = ++sequence, email = `super-identity-${suffix}-${index}@example.com`, phone = '+25670' + String(index).padStart(7, '0');
      const user = await User.create({ publicId: `usr_super_identity_${suffix}_${index}`, name: 'Super identity fixture', email, emailNormalized: email,
        phone, phoneNormalized: phone, passwordHash, role, status: 'active', country: 'UG', currency: 'UGX', locale: 'en-UG',
        emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
        ...(managed ? { platformAccessManagedAt: new Date() } : {}),
        consents: { terms: true, privacy: true, recordedAt: new Date() }, ...overrides });
      if (managed) await PlatformGrant.create({ publicId: `pgr_super_identity_${suffix}_${index}`, userId: user._id, role,
        operationalCountries: role === 'super_admin' ? ['*'] : ['UG'], startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000),
        status: 'active', reason: 'Actual isolated identity setup verification.', approvalPublicId: `apr_super_identity_${suffix}_${index}`, approvedByUserId: new mongoose.Types.ObjectId() });
      const transport = new http.Agent({ localAddress: '127.0.0.' + (190 + index), keepAlive: false });
      transports.push(transport);
      const client = request.agent(app).use(req => req.agent(transport));
      const login = await client.get('/login').expect(200);
      await client.post('/login').type('form').send({ email, password, _csrf: csrf(login.text) }).expect(302);
      return { user, client };
    }

    await t.test('missing email, onboarding and phone go to their real setup screens without redirect loops', async () => {
      for (const [field, destination] of [['emailVerifiedAt', '/verify-email'], ['onboardingCompletedAt', '/onboarding'], ['phoneVerifiedAt', '/verify-phone']]) {
        const { client } = await identity({ [field]: null });
        await client.get('/super/overview?country=UG').expect(302).expect('location', destination);
        await client.get(destination).expect(200);
        const denied = await client.get('/super/overview').set('Accept', 'application/json').expect(403);
        assert.equal(denied.body.error.code, 'SUPER_ADMIN_IDENTITY_REQUIRED');
      }
    });

    await t.test('real MFA enrollment keeps the Super Admin shell and exact safe continuation before opening its dashboard', async () => {
      const { client, user } = await identity();
      const destination = '/super/settings?tab=countries&country=UG';
      const securityPath = '/account/security?next=' + encodeURIComponent(destination);
      await client.get(destination).expect(302).expect('location', securityPath);
      await client.head('/super/overview').expect(302).expect('location', '/account/security?next=%2Fsuper%2Foverview');
      const denied = await client.get('/super/overview').set('Accept', 'application/json').expect(403);
      assert.equal(denied.body.error.code, 'SUPER_ADMIN_IDENTITY_REQUIRED');
      const security = await client.get(securityPath).expect(200);
      assert.match(security.text, /data-dashboard-workspace="superadmin"/);
      assert.match(security.text, /<span class="status-pill warn">Required<\/span>/);
      assert.match(security.text, /This operational account requires a passkey or authenticator for protected work\./);
      assert.doesNotMatch(security.text, /action="\/account\/mfa\/sms\/begin"/);
      assert.doesNotMatch(security.text, /action="\/account\/mfa\/disable"/);
      await client.post('/account/mfa/begin').type('form').send({ _csrf: csrf(security.text), currentPassword: password, next: destination })
        .expect(302).expect('location', securityPath);
      const pending = await pendingMfaEnrollment(user._id);
      assert.ok(pending?.secret);
      const enrollment = await client.get(securityPath).expect(200);
      await client.post('/account/mfa/confirm').type('form').send({ _csrf: csrf(enrollment.text), code: totpCode(pending.secret), next: destination })
        .expect(302).expect('location', securityPath);
      const completed = await client.get(securityPath).expect(200);
      assert.match(completed.text, /Continue to Super Admin workspace/);
      assert.equal([...completed.text.matchAll(/<code>[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}<\/code>/g)].length, 10);
      assert.doesNotMatch(completed.text, /action="\/account\/mfa\/disable"/);
      await client.get(destination).expect(200);
      await client.get('/super/overview').set('Accept', 'application/json').expect(200);
      const disable = await client.post('/account/mfa/disable').type('form').send({ _csrf: csrf(completed.text), currentPassword: password, code: '000000', next: destination }).expect(403);
      assert.match(disable.text, /MFA REQUIRED/);
      assert.equal((await User.findById(user._id)).security.mfaEnabled, true);
    });

    await t.test('ordinary customers and raw Super Admin roles receive no staff setup redirect or data', async () => {
      for (const options of [{ role: 'customer', managed: false }, { managed: false }]) {
        const { client } = await identity(options);
        const response = await client.get('/super/overview').expect(403);
        assert.equal(response.headers.location, undefined);
        assert.doesNotMatch(response.text, /data-dashboard-workspace="superadmin"/);
      }
    });
  } finally {
    for (const transport of transports) transport.destroy();
    try { await mongoose.connection.dropDatabase(); } finally { await mongoose.disconnect(); }
  }
});

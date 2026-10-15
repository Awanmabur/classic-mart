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
const secret = () => Array.from(crypto.randomBytes(32), byte => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[byte % 32]).join('');

test('MFA enrollment cannot replace an active factor or revive stale account authority', { skip: !uri, timeout: 120_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: `classicmart_mfa_enrollment_authority_test_${suffix}` });
  const transports = [];
  try {
    const models = await import('../src/models/index.js');
    const { User, Device, CountrySetting } = models;
    const { createApp } = await import('../src/app.js');
    const { hashPassword, hashToken } = await import('../src/core/crypto.js');
    const { encryptSensitive, decryptSensitive } = await import('../src/core/sensitive.js');
    const { beginMfaEnrollment, confirmMfaEnrollment, pendingMfaEnrollment, disableMfa, verifyMfa, totpCode } = await import('../src/services/mfa.js');
    const { settleModelInitialization } = await import('../scripts/live-test-model-lifecycle.js');
    await settleModelInitialization(mongoose.connection);
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true });
    const password = `Enrollment-${suffix}-A1!`, passwordHash = await hashPassword(password);
    const app = createApp(null);
    let sequence = 0;
    const recoveryCode = 'ABCD-EFGH-IJKL';
    const recoveryHash = hashToken(`mfa-recovery:${recoveryCode.replaceAll('-', '')}`);
    async function actor({ enabled = false, pending = false, status = 'active' } = {}) {
      const number = ++sequence, activeSecret = secret(), pendingSecret = secret();
      const email = `enrollment-${suffix}-${number}@example.test`, phone = `+2567${String(number).padStart(8, '0')}`;
      const user = await User.create({ publicId: `usr_enrollment_${suffix}_${number}`, name: 'Enrollment Authority Fixture', email, emailNormalized: email,
        phone, phoneNormalized: phone, passwordHash, role: 'customer', status, country: 'UG', currency: 'UGX', locale: 'en-UG',
        emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), consents: { terms: true, privacy: true, recordedAt: new Date() },
        security: { mfaEnabled: enabled, mfaLastCounter: -1,
          ...(enabled ? { mfaSecretEncrypted: encryptSensitive(activeSecret), mfaRecoveryCodeHashes: [recoveryHash], mfaEnrolledAt: new Date() } : {}),
          ...(pending ? { mfaPendingSecretEncrypted: encryptSensitive(pendingSecret) } : {}) } });
      await Device.create({ publicId: `dev_enrollment_${suffix}_${number}`, userId: user._id, sessionHash: hashToken(`fixture-${number}`),
        label: 'Unrelated session', userAgent: 'EnrollmentAuthorityTest/1.0', ipHash: hashToken('127.0.0.1'), lastSeenAt: new Date() });
      return { user, activeSecret, pendingSecret };
    }
    const snapshot = async owner => ({ user: await User.collection.findOne({ _id: owner._id }),
      devices: await Device.collection.find({ userId: owner._id }).sort({ publicId: 1 }).toArray() });
    async function login(owner) {
      const transport = new http.Agent({ localAddress: `127.0.0.${100 + sequence}`, keepAlive: false });
      transports.push(transport);
      const client = request.agent(app).use(req => req.agent(transport));
      const form = await client.get('/login').expect(200);
      await client.post('/login').type('form').send({ email: owner.email, password, _csrf: csrf(form.text) }).expect(302);
      const challenge = await client.get('/mfa').expect(200);
      await client.post('/mfa').type('form').send({ code: recoveryCode, _csrf: csrf(challenge.text) }).expect(302);
      return client;
    }
    async function denyAtWrite(owner, operation, mutation) {
      const methods = ['updateOne', 'findOneAndUpdate'];
      const originals = Object.fromEntries(methods.map(method => [method, User.collection[method]]));
      let changed = false, expected;
      for (const method of methods) {
        User.collection[method] = async function (filter, ...args) {
          if (!changed && String(filter?._id) === String(owner._id)) {
            changed = true;
            await originals.updateOne.call(User.collection, { _id: owner._id }, mutation);
            expected = await snapshot(owner);
          }
          return originals[method].call(this, filter, ...args);
        };
      }
      try { await assert.rejects(operation); }
      finally { for (const method of methods) User.collection[method] = originals[method]; }
      assert.equal(changed, true, 'the account change must happen at the real MongoDB write boundary');
      assert.deepEqual(await snapshot(owner), expected, 'a stale enrollment must not change account or device state');
    }

    await t.test('first enrollment activates its verified secret, issues single-use recovery codes and revokes other devices', async () => {
      const entry = await actor();
      const enrollment = await beginMfaEnrollment(entry.user._id, password);
      assert.equal((await pendingMfaEnrollment(entry.user._id)).secret, enrollment.secret);
      const { user, codes } = await confirmMfaEnrollment(entry.user._id, totpCode(enrollment.secret, { time: Date.now() - 30_000 }));
      assert.equal(user.security.mfaEnabled, true);
      assert.equal(user.security.tokenVersion, 1);
      assert.equal(codes.length, 10);
      assert.equal(new Set(codes).size, 10);
      const stored = await User.collection.findOne({ _id: user._id });
      assert.equal(decryptSensitive(stored.security.mfaSecretEncrypted), enrollment.secret);
      assert.equal(stored.security.mfaPendingSecretEncrypted, undefined);
      assert.equal(await pendingMfaEnrollment(user._id), null);
      assert.ok((await Device.findOne({ userId: user._id })).revokedAt);
      assert.equal((await verifyMfa(user._id, codes[0])).method, 'recovery');
      await assert.rejects(verifyMfa(user._id, codes[0]), { code: 'MFA_CODE_INVALID' });
    });

    await t.test('legacy missing security defaults and document version permit a genuine first enrollment', async () => {
      const { user } = await actor();
      await User.collection.updateOne({ _id: user._id }, { $unset: { 'security.mfaEnabled': 1, 'security.tokenVersion': 1, __v: 1 } });
      const raw = await User.collection.findOne({ _id: user._id });
      assert.equal(Object.hasOwn(raw.security, 'mfaEnabled'), false);
      assert.equal(Object.hasOwn(raw.security, 'tokenVersion'), false);
      assert.equal(Object.hasOwn(raw, '__v'), false);
      const hydrated = await User.findById(user._id);
      assert.equal(hydrated.security.mfaEnabled, false);
      assert.equal(hydrated.security.tokenVersion, 0);
      assert.equal(hydrated.$isDefault('security.mfaEnabled'), true);
      assert.equal(hydrated.$isDefault('security.tokenVersion'), true);
      const enrollment = await beginMfaEnrollment(user._id, password);
      const confirmed = await confirmMfaEnrollment(user._id, totpCode(enrollment.secret));
      assert.equal(confirmed.user.security.mfaEnabled, true);
      assert.equal(confirmed.user.security.tokenVersion, 1);
      assert.equal(decryptSensitive((await User.collection.findOne({ _id: user._id })).security.mfaSecretEncrypted), enrollment.secret);
      assert.equal(await pendingMfaEnrollment(user._id), null);
    });

    for (const operationName of ['begin', 'confirm']) {
      await t.test(`${operationName} rejects a legacy proof when missing security defaults are explicitly initialized before its write`, async () => {
        const { user, pendingSecret } = await actor({ pending: true });
        await User.collection.updateOne({ _id: user._id }, { $unset: { 'security.mfaEnabled': 1, 'security.tokenVersion': 1, __v: 1 } });
        const raw = await User.collection.findOne({ _id: user._id });
        assert.equal(Object.hasOwn(raw.security, 'mfaEnabled'), false);
        assert.equal(Object.hasOwn(raw.security, 'tokenVersion'), false);
        assert.equal(Object.hasOwn(raw, '__v'), false);
        const hydrated = await User.findById(user._id);
        assert.equal(hydrated.security.mfaEnabled, false);
        assert.equal(hydrated.security.tokenVersion, 0);
        assert.equal(hydrated.$isDefault('security.mfaEnabled'), true);
        assert.equal(hydrated.$isDefault('security.tokenVersion'), true);
        // Keep __v missing so its separate fence cannot conceal a weakened
        // predicate that treats absent and explicitly initialized values alike.
        await denyAtWrite(user, () => operationName === 'begin' ? beginMfaEnrollment(user._id, password)
          : confirmMfaEnrollment(user._id, totpCode(pendingSecret)),
        { $set: { 'security.mfaEnabled': false, 'security.tokenVersion': 0 } });
      });
    }

    await t.test('an enabled account cannot start a replacement using its password alone', async () => {
      const { user } = await actor({ enabled: true });
      const before = await snapshot(user);
      await assert.rejects(beginMfaEnrollment(user._id, password), { code: 'MFA_ALREADY_ENABLED' });
      assert.deepEqual(await snapshot(user), before);
    });

    await t.test('a stale pending secret cannot replace an enabled authenticator or its recovery codes', async () => {
      const { user, pendingSecret } = await actor({ enabled: true, pending: true });
      const before = await snapshot(user);
      await assert.rejects(confirmMfaEnrollment(user._id, totpCode(pendingSecret)), { code: 'MFA_ALREADY_ENABLED' });
      assert.equal(await pendingMfaEnrollment(user._id), null);
      assert.deepEqual(await snapshot(user), before);
    });

    await t.test('direct authenticated POSTs cannot expose setup or replace an enabled factor', async () => {
      const { user, pendingSecret } = await actor({ enabled: true, pending: true });
      const client = await login(user);
      let page = await client.get('/account/security').expect(200);
      assert.doesNotMatch(page.text, /form[^>]*action="\/account\/mfa\/(?:begin|confirm)"/);
      assert.ok(!page.text.includes(pendingSecret));
      const before = await snapshot(user);
      await client.post('/account/mfa/begin').type('form').send({ currentPassword: password, _csrf: csrf(page.text) })
        .expect(302).expect('location', '/account/security');
      assert.deepEqual(await snapshot(user), before);
      page = await client.get('/account/security').expect(200);
      assert.match(page.text, /already enabled/i);
      await client.post('/account/mfa/confirm').type('form').send({ code: totpCode(pendingSecret), _csrf: csrf(page.text) })
        .expect(302).expect('location', '/account/security');
      assert.deepEqual(await snapshot(user), before);
      page = await client.get('/account/security').expect(200);
      assert.match(page.text, /already enabled/i);
      assert.ok(!page.text.includes(pendingSecret));
    });

    for (const status of ['suspended', 'pending_deletion', 'deleted']) {
      await t.test(`${status} accounts cannot begin or confirm enrollment`, async () => {
        const { user, pendingSecret } = await actor({ pending: true, status });
        const before = await snapshot(user);
        await assert.rejects(beginMfaEnrollment(user._id, password), { code: 'ACCOUNT_UNAVAILABLE' });
        await assert.rejects(confirmMfaEnrollment(user._id, totpCode(pendingSecret)), { code: 'ACCOUNT_UNAVAILABLE' });
        assert.equal(await pendingMfaEnrollment(user._id), null);
        assert.deepEqual(await snapshot(user), before);
      });
    }

    await t.test('simultaneous confirmations activate one factor and return one recovery-code set', async () => {
      const { user, pendingSecret } = await actor({ pending: true });
      const outcomes = await Promise.allSettled([0, 1].map(() => confirmMfaEnrollment(user._id, totpCode(pendingSecret))));
      const success = outcomes.filter(result => result.status === 'fulfilled');
      assert.equal(success.length, 1);
      assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
      const stored = await User.collection.findOne({ _id: user._id });
      assert.equal(stored.security.tokenVersion, 1);
      assert.equal(stored.security.mfaEnabled, true);
      assert.deepEqual(stored.security.mfaRecoveryCodeHashes, success[0].value.codes.map(code => hashToken(`mfa-recovery:${code.replaceAll('-', '')}`)));
    });

    for (const operationName of ['begin', 'confirm']) {
      for (const [change, mutation] of [
        ['account suspension', { $set: { status: 'suspended' } }],
        ['session revocation', { $inc: { 'security.tokenVersion': 1 } }],
        ['factor activation', { $set: { 'security.mfaEnabled': true, 'security.mfaSecretEncrypted': encryptSensitive(secret()), 'security.mfaRecoveryCodeHashes': [recoveryHash] } }],
      ]) {
        await t.test(`${operationName} cannot overwrite ${change} committed before its write`, async () => {
          const { user, pendingSecret } = await actor({ pending: true });
          await denyAtWrite(user, () => operationName === 'begin' ? beginMfaEnrollment(user._id, password)
            : confirmMfaEnrollment(user._id, totpCode(pendingSecret)), mutation);
        });
      }
    }

    await t.test('confirmation cannot promote a pending secret that was replaced before its write', async () => {
      const { user, pendingSecret } = await actor({ pending: true });
      await denyAtWrite(user, () => confirmMfaEnrollment(user._id, totpCode(pendingSecret)),
        { $set: { 'security.mfaPendingSecretEncrypted': encryptSensitive(secret()) } });
    });

    await t.test('a password change committed during setup prevents enrollment using the old password proof', async () => {
      const { user } = await actor();
      const replacementHash = await hashPassword(`Changed-${suffix}-A2!`);
      await denyAtWrite(user, () => beginMfaEnrollment(user._id, password), { $set: { passwordHash: replacementHash } });
    });

    await t.test('explicit disable requires the existing factor before a new initial enrollment is allowed', async () => {
      const { user, activeSecret } = await actor({ enabled: true });
      const before = await snapshot(user);
      await assert.rejects(disableMfa(user._id, password, 'not-a-valid-factor'), { code: 'MFA_CODE_INVALID' });
      assert.deepEqual(await snapshot(user), before);
      await disableMfa(user._id, password, totpCode(activeSecret));
      const enrollment = await beginMfaEnrollment(user._id, password);
      const confirmed = await confirmMfaEnrollment(user._id, totpCode(enrollment.secret));
      assert.equal(confirmed.user.security.mfaEnabled, true);
      assert.equal(confirmed.user.security.tokenVersion, 2);
      assert.equal(decryptSensitive((await User.collection.findOne({ _id: user._id })).security.mfaSecretEncrypted), enrollment.secret);
      assert.notEqual(enrollment.secret, activeSecret);
    });
  } finally {
    for (const transport of transports) transport.destroy();
    try { if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase(); }
    finally { await mongoose.disconnect(); }
  }
});

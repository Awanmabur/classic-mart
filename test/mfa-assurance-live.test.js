import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { fixtureTotpSecurity } from './helpers/mfa-fixtures.js';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;

test('strong session classification rejects SMS and low-assurance recovery while preserving legacy sessions', async () => {
  const { strongSessionMethod, hasCurrentStrongSessionMfa } = await import('../src/services/mfa-assurance.js');
  assert.equal(strongSessionMethod({ session: {} }), true);
  assert.equal(strongSessionMethod({ session: { mfaVerifiedStrong: false } }), false);
  for (const method of ['sms', '', 'unknown', null]) {
    assert.equal(strongSessionMethod({ session: { mfaVerifiedMethod: method, mfaVerifiedStrong: true } }), false);
  }
  for (const method of ['totp', 'passkey']) {
    assert.equal(strongSessionMethod({ session: { mfaVerifiedMethod: method, mfaVerifiedStrong: true } }), true);
    assert.equal(strongSessionMethod({ session: { mfaVerifiedMethod: method, mfaVerifiedStrong: false } }), false);
  }
  assert.equal(strongSessionMethod({ session: { mfaVerifiedMethod: 'recovery' } }), false);
  assert.equal(strongSessionMethod({ session: { mfaVerifiedMethod: 'recovery', mfaVerifiedStrong: false } }), false);
  assert.equal(strongSessionMethod({ session: { mfaVerifiedMethod: 'recovery', mfaVerifiedStrong: true } }), true);
  assert.equal(await hasCurrentStrongSessionMfa({ session: { mfaVerifiedMethod: 'sms' } }), false);
});

test('staff assurance requires current real factor records and never trusts SMS flags or orphaned passkey counts', {
  skip: !uri, timeout: 120_000,
}, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: `classicmart_mfa_assurance_test_${suffix}` });
  try {
    const { User, PasskeyCredential } = await import('../src/models/index.js');
    const { hasCurrentStrongMfa, hasCurrentStrongSessionMfa, clearRequestMfaAssurance } = await import('../src/services/mfa-assurance.js');
    const { businessActor } = await import('../src/services/business-access.js');
    const { isoCBOR } = await import('@simplewebauthn/server/helpers');
    for (const Model of Object.values(mongoose.models)) await Model.init();
    let sequence = 0;
    async function actor(security, role = 'customer') {
      const index = ++sequence, email = `mfa-assurance-${suffix}-${index}@example.test`, phone = '+25670' + String(index).padStart(7, '0');
      return User.create({ publicId: `usr_mfa_assurance_${suffix}_${index}`, name: 'Assurance fixture', email, emailNormalized: email,
        phone, phoneNormalized: phone, passwordHash: 'not-used-by-domain-guard-fixture', role, status: 'active',
        country: 'UG', currency: 'UGX', emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), security,
        consents: { terms: true, privacy: true, recordedAt: new Date() } });
    }
    const fresh = user => User.findById(user._id);
    const signed = (user, method = 'totp', strong = true) => ({ user, session: {
      tokenVersion: user.security.tokenVersion, mfaVerifiedMethod: method, mfaVerifiedStrong: strong,
    }, query: {} });

    await t.test('an enabled bit and SMS enrollment do not establish a strong factor', async () => {
      const flag = await actor({ mfaEnabled: true });
      assert.equal(await hasCurrentStrongMfa(flag), false);
      const sms = await actor({ mfaEnabled: true, mfaMethods: ['sms'], mfaRecoveryStrong: false });
      assert.equal(await hasCurrentStrongMfa(sms), false);
      assert.equal(await hasCurrentStrongSessionMfa(signed(sms, 'sms', false)), false);
      assert.equal(await hasCurrentStrongSessionMfa(signed(sms, 'recovery', false)), false);
    });

    const totp = await actor(await fixtureTotpSecurity(), 'business');
    await t.test('real current authenticator state works without selecting its secret into the actor', async () => {
      const current = await fresh(totp);
      assert.equal(current.security.mfaSecretEncrypted, undefined);
      assert.equal(await hasCurrentStrongMfa(current), true);
      assert.equal(await hasCurrentStrongSessionMfa(signed(current)), true);
      const enabled = await businessActor(signed(current));
      assert.equal(String(enabled.actor._id), String(current._id));
      assert.equal(enabled.actor.security.mfaSecretEncrypted, undefined);
      assert.ok(!JSON.stringify(enabled.actor).includes('mfaSecretEncrypted'));
    });

    await t.test('SMS sessions cannot borrow an enrolled authenticator for privileged operations', async () => {
      const current = await fresh(totp);
      assert.equal(await hasCurrentStrongSessionMfa(signed(current, 'sms', false)), false);
      await assert.rejects(businessActor(signed(current, 'sms', false)), error => error.code === 'MFA_ENROLLMENT_REQUIRED');
      await assert.rejects(businessActor(signed(current, 'recovery', false)), error => error.code === 'MFA_ENROLLMENT_REQUIRED');
    });

    await t.test('legacy actual TOTP remains valid but malformed method metadata fails closed', async () => {
      await User.collection.updateOne({ _id: totp._id }, { $unset: { 'security.mfaMethods': '' } });
      assert.equal(await hasCurrentStrongMfa(await fresh(totp)), true);
      for (const invalid of ['totp', { method: 'totp' }, null, []]) {
        await User.collection.updateOne({ _id: totp._id }, { $set: { 'security.mfaMethods': invalid } });
        assert.equal(await hasCurrentStrongMfa(await fresh(totp)), false);
      }
      await User.collection.updateOne({ _id: totp._id }, { $set: { 'security.mfaMethods': ['totp'] } });
    });

    await t.test('revoked identity and token versions cannot reuse a previous strong actor', async () => {
      const baseline = await fresh(totp);
      await User.updateOne({ _id: totp._id }, { $inc: { 'security.tokenVersion': 1 } });
      assert.equal(await hasCurrentStrongMfa(baseline), false);
      assert.equal(await hasCurrentStrongMfa(await fresh(totp)), true);
      await User.updateOne({ _id: totp._id }, { $set: { status: 'suspended' } });
      assert.equal(await hasCurrentStrongMfa(await fresh(totp)), false);
      await User.updateOne({ _id: totp._id }, { $set: { status: 'active' } });
    });

    const passkey = await actor({ mfaEnabled: true, mfaMethods: ['passkey'], mfaPasskeyCount: 1 });
    const other = await actor({ mfaEnabled: true, mfaMethods: ['passkey'], mfaPasskeyCount: 1 });
    const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const cose = Buffer.from(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))], [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))]])));
    let credential;
    await t.test('passkey metadata requires a real active credential owned by that account', async () => {
      assert.equal(await hasCurrentStrongMfa(passkey), false);
      credential = await PasskeyCredential.create({ publicId: `pky_assurance_${suffix}`, userId: other._id,
        credentialId: crypto.randomBytes(32).toString('base64url'), publicKey: cose, counter: 0,
        name: 'Independent valid P-256 credential fixture', transports: ['internal'], deviceType: 'singleDevice', backedUp: false });
      assert.equal(await hasCurrentStrongMfa(passkey), false);
      assert.equal(await hasCurrentStrongMfa(other), true);
      await PasskeyCredential.updateOne({ _id: credential._id }, { $set: { revokedAt: new Date() } });
      assert.equal(await hasCurrentStrongMfa(other), false);
      await PasskeyCredential.updateOne({ _id: credential._id }, { $set: { revokedAt: null } });
      await User.collection.updateOne({ _id: other._id }, { $set: { 'security.mfaMethods': 'passkey' } });
      assert.equal(await hasCurrentStrongMfa(await fresh(other)), false);
      await User.collection.updateOne({ _id: other._id }, { $set: { 'security.mfaMethods': ['passkey'] } });
    });

    await t.test('per-request memoization is bounded to that request and explicit fresh checks observe revocation', async () => {
      const current = await fresh(other), request = signed(current, 'passkey');
      let reads = 0;
      const original = User.aggregate;
      const mock = t.mock.method(User, 'aggregate', function (...args) { reads++; return original.apply(this, args); });
      try {
        assert.equal(await hasCurrentStrongSessionMfa(request), true);
        assert.equal(await hasCurrentStrongSessionMfa(request), true);
        assert.equal(reads, 1);
        await PasskeyCredential.updateOne({ _id: credential._id }, { $set: { revokedAt: new Date() } });
        assert.equal(await hasCurrentStrongSessionMfa(request, current, { fresh: true }), false);
        assert.equal(await hasCurrentStrongSessionMfa(signed(current, 'passkey')), false);
        clearRequestMfaAssurance(request);
        assert.equal(await hasCurrentStrongSessionMfa(request), false);
        assert.equal(reads, 4);
      } finally { mock.mock.restore(); }
    });
  } finally {
    try { await mongoose.connection.dropDatabase(); }
    finally { await mongoose.disconnect(); }
  }
});

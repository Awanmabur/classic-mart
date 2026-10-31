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

test('operator recovery proof retains its enrollment assurance and is fenced and consumed exactly once', {
  skip: !uri, timeout: 120_000,
}, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: `classicmart_operator_assurance_test_${suffix}` });
  try {
    const { User, PlatformGrant, PasskeyCredential } = await import('../src/models/index.js');
    const { hashPassword, hashToken } = await import('../src/core/crypto.js');
    const { authenticateOperator, fenceOperatorAuthentication } = await import('../src/services/operator-auth.js');
    for (const Model of Object.values(mongoose.models)) await Model.init();
    const password = `Operator-assurance-${suffix}-A1!`, code = 'ABCD-EFGH-IJKL';
    const codeHash = hashToken('mfa-recovery:ABCDEFGHIJKL');
    const email = `operator-assurance-${suffix}@example.test`, now = new Date();
    const user = await User.create({ publicId: `usr_operator_assurance_${suffix}`, name: 'Operator assurance fixture',
      email, emailNormalized: email, phone: '+256700100707', phoneNormalized: '+256700100707',
      passwordHash: await hashPassword(password), role: 'customer', status: 'active', country: 'UG', currency: 'UGX',
      platformAccessManagedAt: now, emailVerifiedAt: now, phoneVerifiedAt: now, onboardingCompletedAt: now,
      security: { ...await fixtureTotpSecurity(), mfaRecoveryStrong: false, mfaRecoveryCodeHashes: [codeHash] },
      consents: { terms: true, privacy: true, recordedAt: now } });
    await PlatformGrant.create({ publicId: `pgr_operator_assurance_${suffix}`, userId: user._id, role: 'super_admin',
      operationalCountries: ['*'], status: 'active', startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000),
      reason: 'Isolated operator recovery assurance verification.', approvalPublicId: `apr_operator_assurance_${suffix}`,
      approvedByUserId: new mongoose.Types.ObjectId() });
    const credentials = { actorPublicId: user.publicId, password, code };

    await t.test('an SMS-origin recovery code cannot borrow the account authenticator', async () => {
      await assert.rejects(authenticateOperator(credentials), { code: 'OPERATOR_AUTH_FAILED' });
      const persisted = await User.findById(user._id).select('+security.mfaRecoveryCodeHashes');
      assert.deepEqual(persisted.security.mfaRecoveryCodeHashes, [codeHash]);
    });

    await t.test('a later assurance downgrade invalidates an already checked operator proof', async () => {
      await User.updateOne({ _id: user._id }, { $set: { 'security.mfaRecoveryStrong': true } });
      const baseline = await authenticateOperator(credentials);
      assert.equal(baseline.authenticationMethod, 'recovery');
      await User.updateOne({ _id: user._id }, { $set: { 'security.mfaRecoveryStrong': false } });
      const session = await mongoose.startSession();
      try {
        await assert.rejects(session.withTransaction(() => fenceOperatorAuthentication(baseline, { session, code })), { code: 'OPERATOR_AUTH_FAILED' });
      } finally { await session.endSession(); }
      assert.deepEqual((await User.findById(user._id).select('+security.mfaRecoveryCodeHashes')).security.mfaRecoveryCodeHashes, [codeHash]);
    });

    await t.test('a strong recovery proof is consumed by the committed transaction and cannot replay', async () => {
      await User.updateOne({ _id: user._id }, { $set: { 'security.mfaRecoveryStrong': true } });
      const baseline = await authenticateOperator(credentials), session = await mongoose.startSession();
      try {
        const result = await session.withTransaction(() => fenceOperatorAuthentication(baseline, { session, code }));
        assert.equal(result.method, 'recovery');
      } finally { await session.endSession(); }
      assert.deepEqual((await User.findById(user._id).select('+security.mfaRecoveryCodeHashes')).security.mfaRecoveryCodeHashes, []);
      await assert.rejects(authenticateOperator(credentials), { code: 'OPERATOR_AUTH_FAILED' });
    });

    await t.test('legacy authenticator recovery remains valid without accepting new unmarked passkey recovery', async () => {
      await User.collection.updateOne({ _id: user._id }, { $set: { 'security.mfaRecoveryCodeHashes': [codeHash] },
        $unset: { 'security.mfaRecoveryStrong': '', 'security.mfaMethods': '' } });
      assert.equal((await authenticateOperator(credentials)).authenticationMethod, 'recovery');
      await User.collection.updateOne({ _id: user._id }, { $set: { 'security.mfaMethods': ['totp'] } });
      await assert.rejects(authenticateOperator(credentials), { code: 'OPERATOR_AUTH_FAILED' });
    });

    await t.test('a disabled authenticator cannot borrow an active passkey to accept its stale secret', async () => {
      const { isoCBOR } = await import('@simplewebauthn/server/helpers');
      const { decryptSensitive } = await import('../src/core/sensitive.js');
      const { totpCode } = await import('../src/services/mfa.js');
      const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const jwk = publicKey.export({ format: 'jwk' });
      const cose = Buffer.from(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1],
        [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))], [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))]])));
      await PasskeyCredential.create({ publicId: `pky_operator_assurance_${suffix}`, userId: user._id,
        credentialId: crypto.randomBytes(32).toString('base64url'), publicKey: cose, counter: 0,
        name: 'Independent valid operator credential fixture', transports: ['internal'], deviceType: 'singleDevice', backedUp: false });
      await User.updateOne({ _id: user._id }, { $set: { 'security.mfaMethods': ['passkey'],
        'security.mfaPasskeyCount': 1, 'security.mfaRecoveryStrong': false, 'security.mfaRecoveryCodeHashes': [] } });
      const current = await User.findById(user._id).select('+security.mfaSecretEncrypted');
      const staleCode = totpCode(decryptSensitive(current.security.mfaSecretEncrypted));
      await assert.rejects(authenticateOperator({ ...credentials, code: staleCode }), { code: 'OPERATOR_AUTH_FAILED' });
    });
  } finally {
    try { await mongoose.connection.dropDatabase(); }
    finally { await mongoose.disconnect(); }
  }
});

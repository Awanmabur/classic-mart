import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.SMS_MODE = 'log';
process.env.MAIL_MODE = 'log';
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;

test('SMS MFA enrollment preserves current authority, single-use ownership and transactional evidence', { skip: !uri, timeout: 120_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: `classicmart_mfa_methods_authority_test_${suffix}` });
  const { User, Device, AuditLog, MfaChallenge } = await import('../src/models/index.js');
  const { hashPassword, hashToken, hashValue } = await import('../src/core/crypto.js');
  const { encryptSensitive } = await import('../src/core/sensitive.js');
  const { settleModelInitialization } = await import('../scripts/live-test-model-lifecycle.js');
  const { beginSmsMfaEnrollment, confirmSmsMfaEnrollment, beginPasskeyEnrollment, verifyAccountMfaProof } = await import('../src/services/mfa-methods.js');
  const { verifyMfa, totpCode, beginMfaEnrollment, confirmMfaEnrollment, pendingMfaEnrollment } = await import('../src/services/mfa.js');
  const { changePassword, requestPasswordReset, resetPassword } = await import('../src/services/auth.js');
  const password = `Methods-${suffix}-A1!`, passwordHash = await hashPassword(password);
  let sequence = 0;
  const nextId = prefix => `${prefix}_mfa_methods_${suffix}_${++sequence}`;
  async function fixture() {
    const number = ++sequence, email = `methods-${suffix}-${number}@example.test`, phone = `+2567${String(number).padStart(8, '0')}`;
    const user = await User.create({ publicId: nextId('usr'), name: 'MFA Authority Fixture', email, emailNormalized: email,
      phone, phoneNormalized: phone, passwordHash, role: 'seller', status: 'active', country: 'UG', currency: 'UGX',
      emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), consents: { terms: true, privacy: true, recordedAt: new Date() } });
    const sessionID = crypto.randomUUID();
    const device = await Device.create({ publicId: nextId('dev'), userId: user._id, sessionHash: hashToken(sessionID),
      label: 'MFA current device', userAgent: 'MfaAuthority/1.0', ipHash: hashToken('127.0.0.1'), lastSeenAt: new Date() });
    const request = { user, device, sessionID, body: {}, session: { userId: String(user._id), tokenVersion: user.security.tokenVersion },
      id: nextId('req'), country: { code: 'UG' }, ip: '127.0.0.1', get: () => 'MfaAuthority/1.0' };
    return { user, device, request };
  }
  function accept(request, result) {
    request.user = result.user;
    request.session.tokenVersion = result.user.security.tokenVersion;
    request.session.mfaVerifiedAt = Date.now();
    request.session.mfaVerifiedMethod = 'sms';
    request.session.mfaVerifiedStrong = false;
    request.session.mfaPhoneHash = hashValue(result.user.phone);
  }
  const actorState = owner => User.collection.findOne({ _id: owner._id });
  try {
    await settleModelInitialization(mongoose.connection);
    await t.test('one setup code confirms the current phone and factor, issues low-assurance backup codes and cannot replay', async () => {
      const { user, request } = await fixture();
      const prepared = await beginSmsMfaEnrollment(request, password);
      assert.match(prepared.developmentCode, /^\d{6}$/);
      const raw = await MfaChallenge.collection.findOne({ publicId: prepared.challengeId });
      assert.notEqual(raw.tokenHash, prepared.developmentCode);
      assert.ok(!JSON.stringify(raw).includes(prepared.developmentCode), 'A database challenge must not retain the plaintext code.');
      const result = await confirmSmsMfaEnrollment(request, prepared.challengeId, prepared.developmentCode);
      assert.equal(result.user.security.mfaEnabled, true);
      assert.deepEqual([...result.user.security.mfaMethods], ['sms']);
      assert.ok(result.user.phoneVerifiedAt, 'The same bound ownership proof must not require a redundant phone OTP.');
      assert.equal(result.user.security.mfaRecoveryStrong, false);
      assert.equal(result.codes.length, 10);
      assert.equal(new Set(result.codes).size, 10);
      assert.equal(await AuditLog.countDocuments({ actorId: user._id, action: 'account.mfa_method_added' }), 1);
      accept(request, result);
      await assert.rejects(confirmSmsMfaEnrollment(request, prepared.challengeId, prepared.developmentCode), { code: 'MFA_CHALLENGE_INVALID' });
      const recovery = await verifyMfa(user._id, result.codes[0]);
      assert.equal(recovery.method, 'recovery');
      assert.equal(recovery.strong, false);
      await assert.rejects(verifyMfa(user._id, result.codes[0]), { code: 'MFA_CODE_INVALID' });
    });
    await t.test('only one concurrent confirmation can activate a factor and write its audit', async () => {
      const { user, request } = await fixture();
      const prepared = await beginSmsMfaEnrollment(request, password);
      const results = await Promise.allSettled([1, 2].map(() => confirmSmsMfaEnrollment(request, prepared.challengeId, prepared.developmentCode)));
      assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
      assert.equal(await AuditLog.countDocuments({ actorId: user._id, action: 'account.mfa_method_added' }), 1);
      assert.equal((await actorState(user)).security.tokenVersion, 1);
    });
    await t.test('sending has an account-level cooldown across new sessions', async () => {
      const { request } = await fixture();
      await beginSmsMfaEnrollment(request, password);
      await assert.rejects(beginSmsMfaEnrollment(request, password), { code: 'MFA_SMS_COOLDOWN' });
    });
    await t.test('five incorrect guesses exhaust a code even if a later guess is correct', async () => {
      const { request } = await fixture();
      const prepared = await beginSmsMfaEnrollment(request, password);
      const incorrect = prepared.developmentCode === '111111' ? '222222' : '111111';
      for (let i = 0; i < 5; i++) await assert.rejects(confirmSmsMfaEnrollment(request, prepared.challengeId, incorrect), { code: 'MFA_CODE_INVALID' });
      await assert.rejects(confirmSmsMfaEnrollment(request, prepared.challengeId, prepared.developmentCode), { code: 'MFA_CODE_INVALID' });
      assert.equal((await MfaChallenge.findOne({ publicId: prepared.challengeId })).attempts, 5);
    });
    for (const [name, mutation, errorCode] of [
      ['phone changed', async current => User.updateOne({ _id: current.user._id }, { $set: { phone: '+256788112233' } }), 'MFA_CHALLENGE_INVALID'],
      ['password replaced', async current => User.updateOne({ _id: current.user._id }, { $set: { passwordHash: await hashPassword('Replacement-current-password-A1!') } }), 'MFA_CHALLENGE_INVALID'],
      ['token revoked', async current => User.updateOne({ _id: current.user._id }, { $inc: { 'security.tokenVersion': 1 } }), 'ACCOUNT_UNAVAILABLE'],
      ['device revoked', async current => Device.updateOne({ _id: current.device._id }, { $set: { revokedAt: new Date() } }), 'ACCOUNT_UNAVAILABLE'],
      ['account suspended', async current => User.updateOne({ _id: current.user._id }, { $set: { status: 'suspended' } }), 'ACCOUNT_UNAVAILABLE'],
      ['staff role assigned', async current => User.updateOne({ _id: current.user._id }, { $set: { role: 'support' } }), 'MFA_STRONG_REQUIRED'],
    ]) {
      await t.test(`an issued SMS cannot enroll after its ${name}`, async () => {
        const current = await fixture(), prepared = await beginSmsMfaEnrollment(current.request, password);
        await mutation(current);
        await assert.rejects(confirmSmsMfaEnrollment(current.request, prepared.challengeId, prepared.developmentCode), { code: errorCode });
        assert.equal((await actorState(current.user)).security.mfaEnabled, false);
      });
    }
    await t.test('expired setup requests and another owned device cannot consume the original code', async () => {
      const current = await fixture(), prepared = await beginSmsMfaEnrollment(current.request, password);
      const sessionID = crypto.randomUUID();
      const device = await Device.create({ publicId: nextId('dev'), userId: current.user._id, sessionHash: hashToken(sessionID),
        label: 'Another real device', userAgent: 'MfaAuthority/1.0', ipHash: hashToken('127.0.0.1'), lastSeenAt: new Date() });
      const other = { ...current.request, sessionID, device };
      await assert.rejects(confirmSmsMfaEnrollment(other, prepared.challengeId, prepared.developmentCode), { code: 'MFA_CHALLENGE_INVALID' });
      await MfaChallenge.updateOne({ publicId: prepared.challengeId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      await assert.rejects(confirmSmsMfaEnrollment(current.request, prepared.challengeId, prepared.developmentCode), { code: 'MFA_CHALLENGE_INVALID' });
    });
    await t.test('a weak SMS session cannot add or alter a strong factor already protected by an authenticator', async () => {
      const current = await fixture();
      await User.updateOne({ _id: current.user._id }, { $set: { 'security.mfaEnabled': true, 'security.mfaMethods': ['sms', 'totp'],
        'security.mfaSecretEncrypted': encryptSensitive('JBSWY3DPEHPK3PXP') } });
      current.request.user = await User.findById(current.user._id);
      current.request.session.mfaVerifiedAt = Date.now();
      current.request.session.mfaVerifiedMethod = 'sms';
      current.request.session.mfaVerifiedStrong = false;
      current.request.session.mfaPhoneHash = hashValue(current.user.phone);
      await assert.rejects(beginPasskeyEnrollment(current.request, password, 'Unauthorized new passkey'), { code: 'MFA_STRONG_REQUIRED' });
      current.request.body = { currentPassword: password, mfaMethod: 'sms', code: '123456' };
      await assert.rejects(verifyAccountMfaProof(current.request, 'disable'), { code: 'MFA_STRONG_REQUIRED' });
      assert.equal(await MfaChallenge.countDocuments({ userId: current.user._id, purpose: 'passkey_enroll' }), 0);
    });
    await t.test('stale authenticator ciphertext cannot override explicit enabled methods', async () => {
      const current = await fixture(), secret = 'JBSWY3DPEHPK3PXP';
      await User.updateOne({ _id: current.user._id }, { $set: { 'security.mfaEnabled': true,
        'security.mfaMethods': ['sms'], 'security.mfaSecretEncrypted': encryptSensitive(secret) } });
      await assert.rejects(verifyMfa(current.user._id, totpCode(secret)), { code: 'MFA_CODE_INVALID' });
      await User.updateOne({ _id: current.user._id }, { $set: { 'security.mfaMethods': ['totp'] } });
      assert.equal((await verifyMfa(current.user._id, totpCode(secret))).strong, true);
    });
    await t.test('only legacy authenticator metadata can infer unmarked recovery-code assurance', async () => {
      const secret = encryptSensitive('JBSWY3DPEHPK3PXP');
      for (const [methods, expectedStrong] of [[['sms'], false], [['totp'], false], [undefined, true]]) {
        const current = await fixture(), code = 'ABCDEF-123456-789ABC';
        await User.collection.updateOne({ _id: current.user._id }, { $set: { 'security.mfaEnabled': true,
          'security.mfaSecretEncrypted': secret, 'security.mfaRecoveryCodeHashes': [hashToken('mfa-recovery:ABCDEF123456789ABC')],
          ...(methods ? { 'security.mfaMethods': methods } : {}) },
        $unset: { 'security.mfaRecoveryStrong': '', ...(methods ? {} : { 'security.mfaMethods': '' }) } });
        assert.equal((await verifyMfa(current.user._id, code)).strong, expectedStrong);
      }
    });
    await t.test('a concurrent method removal cannot consume or authenticate a stale TOTP proof', async () => {
      const current = await fixture(), secret = 'JBSWY3DPEHPK3PXP';
      await User.updateOne({ _id: current.user._id }, { $set: { 'security.mfaEnabled': true,
        'security.mfaMethods': ['totp'], 'security.mfaSecretEncrypted': encryptSensitive(secret) } });
      const original = User.updateOne;
      let changed = false;
      User.updateOne = function (filter, ...args) {
        if (!changed && String(filter._id) === String(current.user._id) && filter['security.mfaSecretEncrypted']) {
          changed = true;
          return User.collection.updateOne({ _id: current.user._id }, { $set: { 'security.mfaMethods': ['sms'] } })
            .then(() => original.call(this, filter, ...args));
        }
        return original.call(this, filter, ...args);
      };
      try { await assert.rejects(verifyMfa(current.user._id, totpCode(secret)), { code: 'MFA_REPLAY' }); }
      finally { User.updateOne = original; }
      assert.equal(changed, true);
      assert.equal((await actorState(current.user)).security.mfaLastCounter, -1);
    });
    await t.test('a concurrent recovery assurance downgrade cannot return strong proof or consume the code', async () => {
      const current = await fixture(), code = 'ABCDEF-123456-789ABC', codeHash = hashToken('mfa-recovery:ABCDEF123456789ABC');
      await User.updateOne({ _id: current.user._id }, { $set: { 'security.mfaEnabled': true,
        'security.mfaMethods': ['totp'], 'security.mfaSecretEncrypted': encryptSensitive('JBSWY3DPEHPK3PXP'),
        'security.mfaRecoveryStrong': true, 'security.mfaRecoveryCodeHashes': [codeHash] } });
      const original = User.updateOne;
      let changed = false;
      User.updateOne = function (filter, ...args) {
        if (!changed && String(filter._id) === String(current.user._id) && filter['security.mfaRecoveryCodeHashes'] === codeHash) {
          changed = true;
          return User.collection.updateOne({ _id: current.user._id }, { $set: { 'security.mfaRecoveryStrong': false } })
            .then(() => original.call(this, filter, ...args));
        }
        return original.call(this, filter, ...args);
      };
      try { await assert.rejects(verifyMfa(current.user._id, code), { code: 'MFA_CODE_INVALID' }); }
      finally { User.updateOne = original; }
      assert.equal(changed, true);
      assert.deepEqual((await actorState(current.user)).security.mfaRecoveryCodeHashes, [codeHash]);
    });
    for (const operation of ['change', 'reset']) {
      await t.test(`a password ${operation} cancels previous pending authenticator material`, async () => {
        const current = await fixture(), enrollment = await beginMfaEnrollment(current.user._id, password);
        assert.ok(await pendingMfaEnrollment(current.user._id));
        const replacement = `Replacement-${suffix}-${operation}-A1!`;
        if (operation === 'change') await changePassword(current.user._id, password, replacement);
        else {
          const reset = await requestPasswordReset(current.user.email, current.request);
          assert.match(reset.developmentCode, /^\d{6}$/);
          await resetPassword(reset.publicId, reset.developmentCode, replacement);
        }
        assert.equal((await actorState(current.user)).security.mfaPendingSecretEncrypted, undefined);
        assert.equal(await pendingMfaEnrollment(current.user._id), null);
        await assert.rejects(confirmMfaEnrollment(current.user._id, totpCode(enrollment.secret), current.device.publicId), { code: 'MFA_SETUP_REQUIRED' });
      });
    }
    await t.test('audit failure rolls back activation and the single-use claim, allowing a later genuine retry', async () => {
      const current = await fixture(), prepared = await beginSmsMfaEnrollment(current.request, password);
      const originalInsert = AuditLog.collection.insertOne;
      AuditLog.collection.insertOne = async function (document, ...args) {
        if (document.action === 'account.mfa_method_added' && String(document.actorId) === String(current.user._id)) throw new Error('Fixture audit unavailable');
        return originalInsert.call(this, document, ...args);
      };
      try { await assert.rejects(confirmSmsMfaEnrollment(current.request, prepared.challengeId, prepared.developmentCode), /Fixture audit unavailable/); }
      finally { AuditLog.collection.insertOne = originalInsert; }
      assert.equal((await actorState(current.user)).security.mfaEnabled, false);
      assert.equal((await MfaChallenge.findOne({ publicId: prepared.challengeId })).consumedAt, undefined);
      assert.equal(await AuditLog.countDocuments({ actorId: current.user._id, action: 'account.mfa_method_added' }), 0);
      const result = await confirmSmsMfaEnrollment(current.request, prepared.challengeId, prepared.developmentCode);
      assert.equal(result.user.security.mfaEnabled, true);
    });
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

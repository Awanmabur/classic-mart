import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const evidence = (key = 'load-test', changes = {}) => ({
  key, expectedVersion: null, status: 'passed', reason: 'Operator reviewed the attached isolated test exercise.',
  source: { key, url: `https://evidence.example.com/reviews/${key}`, description: 'Recorded measurements and observations for this isolated verification exercise.', performedAt: new Date(Date.now() - 60_000).toISOString() },
  validUntil: new Date(Date.now() + 3_600_000).toISOString(), ...changes,
});

test('launch evidence validates source binding, measured recovery policy and expiry without database access', async () => {
  const { validateLaunchEvidence } = await import('../src/services/launch-evidence.js');
  const { env } = await import('../src/config/env.js');
  assert.equal(validateLaunchEvidence(evidence()).key, 'load-test');
  assert.throws(() => validateLaunchEvidence(evidence('made-up-gate')));
  assert.throws(() => validateLaunchEvidence(evidence('load-test', { source: { ...evidence().source, key: 'legal-review' } })));
  assert.throws(() => validateLaunchEvidence(evidence('load-test', { expectedVersion: -1 })));
  assert.throws(() => validateLaunchEvidence(evidence('load-test', { validUntil: new Date(Date.now() - 1).toISOString() })));
  assert.throws(() => validateLaunchEvidence(evidence('load-test', { source: { ...evidence().source, url: 'https://example.com/review?access_token=private' } })));
  assert.throws(() => validateLaunchEvidence(evidence('load-test', { source: { ...evidence().source, performedAt: new Date(Date.now() + 3_600_000).toISOString() } })));
  assert.throws(() => validateLaunchEvidence(evidence('pitr')));
  const metrics = { rpoMinutes: env.disasterRecovery.maxRpoMinutes, drillId: 'test-drill', provider: 'isolated MongoDB', scope: 'Disposable local verification database.' };
  assert.equal(validateLaunchEvidence(evidence('pitr', { recoveryMetrics: metrics })).recoveryMetrics.rpoMinutes, env.disasterRecovery.maxRpoMinutes);
  assert.throws(() => validateLaunchEvidence(evidence('pitr', { recoveryMetrics: { ...metrics, rpoMinutes: env.disasterRecovery.maxRpoMinutes + 1 } })));
  assert.throws(() => validateLaunchEvidence(evidence('load-test', { recoveryMetrics: metrics })));
  assert.match(validateLaunchEvidence(evidence()).evidence, /not fetched or independently verified/);
});

test('CLI dry-run accesses no database and operator input is bounded and excludes credential files', async () => {
  const { readBoundedJsonFile, readOperatorCredentials } = await import('../scripts/operator-input.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'launch-evidence-test-'));
  try {
    const file = path.join(directory, 'evidence.json');
    await fs.writeFile(file, JSON.stringify(evidence()));
    assert.equal((await readBoundedJsonFile(file)).key, 'load-test');
    const result = spawnSync(process.execPath, ['scripts/launch-evidence.js', `--file=${file}`], {
      cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, NODE_ENV: 'test', MONGO_URI: 'mongodb://127.0.0.1:1/never_connect_test' },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.mode, 'dry-run');
    assert.equal(output.databaseAccessed, false);
    assert.equal(output.independentVerificationPerformed, false);
    assert.ok(!result.stdout.includes(evidence().source.description));
    const envelope = { actorPublicId: 'usr_test_operator', password: 'test-password-not-printed', code: 'ABCD-EFGH-IJKL' };
    assert.deepEqual(await readOperatorCredentials({ input: Readable.from([JSON.stringify(envelope)]) }), envelope);
    await assert.rejects(readOperatorCredentials({ input: Readable.from(['"not an envelope"']) }));
    await assert.rejects(readOperatorCredentials({ input: Readable.from(['x'.repeat(16385)]) }));
    await fs.writeFile(file, 'x'.repeat(16385));
    await assert.rejects(readBoundedJsonFile(file));
    await fs.symlink(file, path.join(directory, 'alias.json'));
    await assert.rejects(readBoundedJsonFile(path.join(directory, 'alias.json')));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('operator launch evidence commits current authority, single-use MFA, versioned source evidence and audit atomically', { skip: !uri, timeout: 120_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: `classicmart_launch_evidence_test_${suffix}` });
  try {
    const { User, PlatformGrant, LaunchEvidence, AuditLog } = await import('../src/models/index.js');
    const { hashPassword, hashToken } = await import('../src/core/crypto.js');
    const { encryptSensitive } = await import('../src/core/sensitive.js');
    const { totpCode } = await import('../src/services/mfa.js');
    const { applyLaunchEvidence, listLaunchEvidence } = await import('../src/services/launch-evidence.js');
    const { authenticateOperator, authorizeOperator } = await import('../src/services/operator-auth.js');
    for (const Model of [User, PlatformGrant, LaunchEvidence, AuditLog]) await Model.init();
    const password = `Launch-${suffix}-A1!`, secret = 'JBSWY3DPEHPK3PXP';
    const codes = Array.from({ length: 20 }, (_, index) => `${suffix.slice(0, 4)}-TEST-${String(index).padStart(4, '0')}`.toUpperCase());
    const recoveryHash = (code) => hashToken(`mfa-recovery:${code.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`);
    const base = { name: 'Isolated Operator', email: `launch-${suffix}@example.com`, emailNormalized: `launch-${suffix}@example.com`,
      phone: '+256701234567', phoneNormalized: '+256701234567', passwordHash: await hashPassword(password), country: 'UG',
      emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), platformAccessManagedAt: new Date(), onboardingCompletedAt: new Date(), consents: { terms: true, privacy: true, recordedAt: new Date() },
      security: { mfaEnabled: true, mfaSecretEncrypted: encryptSensitive(secret), mfaLastCounter: -1, mfaRecoveryCodeHashes: codes.map(recoveryHash), tokenVersion: 7 } };
    const actor = await User.create({ ...base, publicId: `usr_launch_${suffix}`, role: 'super_admin' });
    const grant = await PlatformGrant.create({ publicId: `pgr_launch_${suffix}`, userId: actor._id, role: 'super_admin', operationalCountries: ['*'],
      startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 3_600_000), status: 'active', reason: 'Isolated operator evidence verification.', approvalPublicId: `apr_launch_${suffix}`, approvedByUserId: actor._id });
    const credentials = (index) => ({ actorPublicId: actor.publicId, password, code: codes[index] });
    const hashes = async () => (await User.findById(actor._id).select('+security.mfaRecoveryCodeHashes')).security.mfaRecoveryCodeHashes;

    await t.test('read-only listing reports all 19 gates without inserting missing evidence or consuming MFA', async () => {
      const before = await User.findById(actor._id);
      const report = await listLaunchEvidence();
      assert.equal(report.length, 19);
      assert.ok(report.every((row) => row.status === 'missing' && row.expectedVersion === null));
      assert.equal(await LaunchEvidence.countDocuments(), 0);
      assert.equal(await AuditLog.countDocuments(), 0);
      const authenticated = await authenticateOperator(credentials(0));
      assert.equal(authenticated.role, 'super_admin');
      assert.equal(authenticated.authenticationMethod, 'recovery');
      assert.equal((await hashes()).length, 20);
      assert.equal((await User.findById(actor._id)).__v, before.__v);
    });

    await t.test('password, MFA and role denial leave evidence, audit and recovery codes unchanged', async () => {
      await assert.rejects(applyLaunchEvidence(evidence(), { ...credentials(0), password: 'wrong' }), { code: 'OPERATOR_AUTH_FAILED' });
      await assert.rejects(applyLaunchEvidence(evidence(), { ...credentials(0), code: 'XXXX-XXXX-XXXX' }), { code: 'OPERATOR_AUTH_FAILED' });
      await PlatformGrant.updateOne({ _id: grant._id }, { $set: { role: 'country_admin', operationalCountries: ['UG'] } });
      await assert.rejects(applyLaunchEvidence(evidence(), credentials(0)), { code: 'OPERATOR_AUTH_FAILED' });
      await PlatformGrant.updateOne({ _id: grant._id }, { $set: { role: 'super_admin', operationalCountries: ['*'] } });
      await User.updateOne({ _id: actor._id }, { $unset: { platformAccessManagedAt: 1 } });
      await assert.rejects(applyLaunchEvidence(evidence(), credentials(0)), { code: 'OPERATOR_AUTH_FAILED' });
      await User.updateOne({ _id: actor._id }, { $set: { platformAccessManagedAt: new Date(), status: 'suspended' } });
      await assert.rejects(applyLaunchEvidence(evidence(), credentials(0)), { code: 'OPERATOR_AUTH_FAILED' });
      await User.updateOne({ _id: actor._id }, { $set: { status: 'active' }, $unset: { phoneVerifiedAt: 1 } });
      await assert.rejects(applyLaunchEvidence(evidence(), credentials(0)), { code: 'OPERATOR_AUTH_FAILED' });
      await User.updateOne({ _id: actor._id }, { $set: { phoneVerifiedAt: new Date(), 'security.mfaEnabled': false } });
      await assert.rejects(applyLaunchEvidence(evidence(), credentials(0)), { code: 'OPERATOR_AUTH_FAILED' });
      await User.updateOne({ _id: actor._id }, { $set: { 'security.mfaEnabled': true } });
      await PlatformGrant.updateOne({ _id: grant._id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
      await assert.rejects(applyLaunchEvidence(evidence(), credentials(0)), { code: 'OPERATOR_AUTH_FAILED' });
      await PlatformGrant.updateOne({ _id: grant._id }, { $set: { expiresAt: new Date(Date.now() + 3_600_000) } });
      assert.equal(await LaunchEvidence.countDocuments(), 0);
      assert.equal(await AuditLog.countDocuments(), 0);
      assert.equal((await hashes()).length, 20);
    });

    await t.test('an explicit submission commits one source-bound gate, one audit and one recovery consumption', async () => {
      const saved = await applyLaunchEvidence(evidence(), credentials(0));
      assert.equal(saved.key, 'load-test');
      assert.equal(saved.status, 'passed');
      assert.equal(saved.independentVerificationPerformed, false);
      const stored = await LaunchEvidence.findOne({ key: 'load-test' });
      assert.equal(String(stored.verifiedByUserId), String(actor._id));
      assert.equal(JSON.parse(stored.evidence).source.key, stored.key);
      assert.equal(stored.__v, 0);
      assert.equal((await hashes()).length, 19);
      const audit = await AuditLog.findOne({ targetPublicId: 'load-test' }).lean();
      assert.equal(audit.actorPublicId, actor.publicId);
      assert.equal(audit.metadata.independentVerificationPerformed, false);
      assert.match(audit.metadata.evidenceSha256, /^[a-f0-9]{64}$/);
      assert.ok(!JSON.stringify(audit).includes(password));
      assert.ok(!JSON.stringify(audit).includes(codes[0]));
      assert.ok(!JSON.stringify(audit).includes(secret));
      assert.equal((await listLaunchEvidence()).filter((row) => row.satisfiesStatusGate).length, 1);
    });

    await t.test('read-only listing rejects expired non-recovery proof and readiness exposes the same expiry', async () => {
      const { launchReadiness } = await import('../src/services/launch.js');
      const record = await LaunchEvidence.findOne({ key: 'load-test' });
      await LaunchEvidence.updateOne({ _id: record._id }, { $set: { validUntil: new Date(Date.now() - 1) } });
      try {
        const listing = (await listLaunchEvidence()).find(row => row.key === 'load-test');
        assert.equal(listing.status, 'passed');
        assert.equal(listing.satisfiesStatusGate, false);
        const readiness = await launchReadiness();
        assert.equal(readiness.ready, false);
        assert.ok(readiness.evidenceIssues.some(issue => issue.startsWith('load-test: evidence expired')));
      } finally {
        await LaunchEvidence.updateOne({ _id: record._id }, { $set: { validUntil: record.validUntil } });
        // launchReadiness initializes absent gates; remove only these missing
        // records in this test's disposable database before later scenarios.
        await LaunchEvidence.deleteMany({ key: { $ne: 'load-test' }, status: 'missing', verifiedAt: { $exists: false } });
      }
    });

    await t.test('replayed MFA and stale evidence versions cannot alter the signed gate', async () => {
      await assert.rejects(applyLaunchEvidence(evidence('legal-review'), credentials(0)), { code: 'OPERATOR_AUTH_FAILED' });
      await assert.rejects(applyLaunchEvidence(evidence(), credentials(1)), { code: 'LAUNCH_EVIDENCE_CHANGED' });
      assert.equal((await hashes()).length, 19);
      const updated = await applyLaunchEvidence(evidence('load-test', { expectedVersion: 0, status: 'failed' }), credentials(1));
      assert.equal(updated.version, 1);
      assert.equal(updated.satisfiesStatusGate, false);
      assert.equal(updated.validUntil, null);
      assert.equal((await hashes()).length, 18);
    });

    await t.test('audit storage failure rolls evidence and MFA consumption back', async () => {
      const before = await User.findById(actor._id);
      const original = AuditLog.create;
      AuditLog.create = async () => { throw new Error('isolated audit write failure'); };
      try { await assert.rejects(applyLaunchEvidence(evidence('legal-review'), credentials(2)), /isolated audit write failure/); }
      finally { AuditLog.create = original; }
      assert.equal(await LaunchEvidence.countDocuments({ key: 'legal-review' }), 0);
      assert.equal((await hashes()).length, 18);
      assert.equal((await User.findById(actor._id)).__v, before.__v);
    });

    await t.test('current session invalidation is checked again inside the transaction', async () => {
      const baseline = await authenticateOperator(credentials(2));
      await User.updateOne({ _id: actor._id }, { $inc: { 'security.tokenVersion': 1 } });
      const session = await mongoose.startSession();
      try { await assert.rejects(session.withTransaction(() => authorizeOperator(baseline, { session })), { code: 'OPERATOR_AUTH_FAILED' }); }
      finally { await session.endSession(); }
      assert.equal((await hashes()).length, 18);
    });

    await t.test('a current global grant authorizes a customer mirror and revocation overrides a stale super-admin mirror', async () => {
      await User.updateOne({ _id: actor._id }, { $set: { role: 'customer', platformAccessManagedAt: new Date() } });
      await applyLaunchEvidence(evidence('legal-review', { status: 'failed' }), credentials(2));
      assert.equal((await User.findById(actor._id)).role, 'customer');
      const baseline = await authenticateOperator(credentials(3));
      await PlatformGrant.updateOne({ _id: grant._id }, { $set: { status: 'revoked' } });
      await User.updateOne({ _id: actor._id }, { $set: { role: 'super_admin' } });
      await assert.rejects(applyLaunchEvidence(evidence('privacy-review'), credentials(3)), { code: 'OPERATOR_AUTH_FAILED' });
      const session = await mongoose.startSession();
      try { await assert.rejects(session.withTransaction(() => authorizeOperator(baseline, { session })), { code: 'OPERATOR_AUTH_FAILED' }); }
      finally { await session.endSession(); }
      await PlatformGrant.updateOne({ _id: grant._id }, { $set: { status: 'active' } });
      assert.equal((await hashes()).length, 17);
    });

    await t.test('TOTP is consumed exactly once and cannot be replayed for another gate', async () => {
      const code = totpCode(secret);
      const auth = { actorPublicId: actor.publicId, password, code };
      await applyLaunchEvidence(evidence('privacy-review', { status: 'failed' }), auth);
      await assert.rejects(applyLaunchEvidence(evidence('tax-review', { status: 'failed' }), auth), { code: 'MFA_REPLAY' });
      assert.equal(await LaunchEvidence.countDocuments({ key: 'tax-review' }), 0);
    });
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

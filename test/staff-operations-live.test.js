import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;

test('staff operations use real step-up authentication, independent approval and atomic invitation delivery', { skip: !uri, timeout: 300_000 }, async t => {
  const destination = new URL(uri);
  assert.equal(destination.hostname, '127.0.0.1');
  assert.match(destination.pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  const dbName = `classicmart_staff_operations_test_${suffix}`;
  await mongoose.connect(uri, { dbName });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'classicmart-staff-operations-'));
  try {
    const { User, PlatformGrant, CountrySetting, Warehouse, PlatformStaffInvitation, OutboxEvent, AuditLog, ApprovalRequest } = await import('../src/models/index.js');
    const { hashPassword } = await import('../src/core/crypto.js');
    const { beginMfaEnrollment, confirmMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
    const { runStaffOperation } = await import('../src/services/staff-operations.js');
    const { acceptPlatformStaffInvitation } = await import('../src/services/staff-access.js');
    const { applyApproval, createApproval } = await import('../src/services/stage9.js');
    for (const model of Object.values(mongoose.models)) await model.init();
    await CountrySetting.create([
      { code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256' },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254' },
      { code: 'TZ', name: 'Inactive country', currency: 'TZS', locale: 'en-TZ', timeZone: 'Africa/Dar_es_Salaam', phonePrefix: '+255', active: false },
    ]);
    let sequence = 0;
    const id = prefix => `${prefix}_staffops_${suffix}_${++sequence}`;
    const password = `Staff-operations-${suffix}-A1!`, passwordHash = await hashPassword(password);
    async function actor(role = 'super_admin', countries = role === 'super_admin' ? ['*'] : ['UG']) {
      const number = ++sequence, email = `staff-operations-${suffix}-${number}@example.test`, phone = `+25670${String(number).padStart(7, '0')}`;
      const user = await User.create({ publicId: id('usr'), name: `Staff operator ${number}`, email, emailNormalized: email, phone, phoneNormalized: phone, passwordHash,
        role: 'customer', status: 'active', country: 'UG', currency: 'UGX', operationalCountries: [], emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
        platformAccessManagedAt: role === 'customer' ? undefined : new Date(), consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const grant = role === 'customer' ? null : await PlatformGrant.create({ publicId: id('pgr'), userId: user._id, role, operationalCountries: countries, status: 'active', startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000), reason: 'Isolated staff operations authorization.', approvalPublicId: id('apr'), approvedByUserId: new mongoose.Types.ObjectId() });
      const enrollment = await beginMfaEnrollment(user._id, password);
      const confirmed = await confirmMfaEnrollment(user._id, totpCode(enrollment.secret, { time: Date.now() - 30_000 }));
      return { user: confirmed.user, grant, codes: confirmed.codes, secret: enrollment.secret };
    }
    const requester = await actor(), decider = await actor(), countryAdmin = await actor('country_admin'), recipient = await actor('customer');
    const credentials = (entry, index = 0) => ({ actorPublicId: entry.user.publicId, password, code: entry.codes[index] });
    const counts = async () => ({ invitations: await PlatformStaffInvitation.countDocuments(), outbox: await OutboxEvent.countDocuments(), audits: await AuditLog.countDocuments(), grants: await PlatformGrant.countDocuments(), approvals: await ApprovalRequest.countDocuments() });
    const baseInvite = { action: 'invite', email: recipient.user.email, role: 'support', operationalCountries: ['UG'], reason: 'Dedicated staff invitation for isolated launch verification.' };
    const warehouse = await Warehouse.create({ publicId: id('wh'), storeId: new mongoose.Types.ObjectId(), ownerUserId: requester.user._id, name: 'Isolated warehouse', country: 'UG', city: 'Kampala', address: 'Isolated local fixture' });
    const otherWarehouse = await Warehouse.create({ publicId: id('wh'), storeId: new mongoose.Types.ObjectId(), ownerUserId: requester.user._id, name: 'Other market warehouse', country: 'KE', city: 'Nairobi', address: 'Isolated local fixture' });
    let invitation, accepted;

    await t.test('read-only preview requires real password and unused MFA but creates no records or proof consumption', async () => {
      const before = await counts();
      await assert.rejects(runStaffOperation({ ...credentials(requester), password: 'wrong-private-password' }, baseInvite), { code: 'OPERATOR_AUTH_FAILED' });
      await assert.rejects(runStaffOperation({ ...credentials(requester), code: 'INVALID-PRIVATE-CODE' }, baseInvite), { code: 'OPERATOR_AUTH_FAILED' });
      const preview = await runStaffOperation(credentials(requester), baseInvite);
      assert.equal(preview.mode, 'dry-run'); assert.equal(preview.operator.role, 'super_admin');
      assert.equal(preview.activationRequiresIndependentApproval, true);
      assert.equal(preview.invitation.publicId, undefined);
      assert.equal((await User.findById(requester.user._id)).role, 'customer', 'grant authority does not rewrite the stored role mirror');
      assert.deepEqual(await counts(), before);
      assert.doesNotMatch(JSON.stringify(preview), /password|tokenHash|mfaSecret|mfaRecovery|staff\/invitations/);
      assert.ok(!JSON.stringify(preview).includes(password)); assert.ok(!JSON.stringify(preview).includes(requester.codes[0]));
    });

    await t.test('dedicated country and warehouse scopes are validated before invitation creation', async () => {
      const before = await counts();
      for (const override of [
        { role: 'finance' }, { role: 'country_admin' }, { operationalCountries: ['KE'] }, { operationalCountries: ['UG', 'KE'] },
      ]) await assert.rejects(runStaffOperation(credentials(countryAdmin), { ...baseInvite, ...override }), { code: 'STAFF_ROLE_SCOPE' });
      await assert.rejects(runStaffOperation(credentials(requester), { ...baseInvite, operationalCountries: ['TZ'] }), { code: 'STAFF_COUNTRY_INVALID' });
      await assert.rejects(runStaffOperation(credentials(requester), { ...baseInvite, warehouseScopes: [warehouse.publicId] }), { code: 'STAFF_WAREHOUSE_SCOPE_ROLE' });
      await assert.rejects(runStaffOperation(credentials(requester), { ...baseInvite, role: 'warehouse' }), { code: 'STAFF_WAREHOUSE_SCOPE_ROLE' });
      await assert.rejects(runStaffOperation(credentials(requester), { ...baseInvite, role: 'warehouse', warehouseScopes: [otherWarehouse.publicId] }), { code: 'STAFF_WAREHOUSE_SCOPE_INVALID' });
      const preview = await runStaffOperation(credentials(countryAdmin), { ...baseInvite, role: 'warehouse', warehouseScopes: [warehouse.publicId] });
      assert.equal(preview.invitation.role, 'warehouse');
      assert.deepEqual(preview.invitation.warehouseScopes, [warehouse.publicId]);
      assert.deepEqual(await counts(), before);
    });

    await t.test('applying invitation atomically queues delivery and audit, consumes proof once and grants no access', async () => {
      const result = await runStaffOperation(credentials(requester), { ...baseInvite, apply: true });
      assert.equal(result.mode, 'applied'); invitation = result.invitation;
      assert.equal(await PlatformGrant.countDocuments({ userId: recipient.user._id }), 0);
      assert.equal((await User.findById(recipient.user._id)).role, 'customer');
      const persisted = await PlatformStaffInvitation.findOne({ publicId: invitation.publicId }).select('+tokenHash +emailEncrypted');
      assert.equal(persisted.status, 'pending');
      assert.equal(await OutboxEvent.countDocuments({ type: 'platform.staff_invitation', aggregatePublicId: invitation.publicId }), 1);
      assert.equal(await AuditLog.countDocuments({ action: 'admin.staff_invited', targetPublicId: invitation.publicId }), 1);
      assert.ok(!JSON.stringify(result).includes(persisted.tokenHash)); assert.ok(!JSON.stringify(result).includes(password));
      await assert.rejects(runStaffOperation(credentials(requester), { action: 'list' }), { code: 'OPERATOR_AUTH_FAILED' });
      const mail = await OutboxEvent.findOne({ aggregatePublicId: invitation.publicId });
      const token = mail.payload.body.match(/\/staff\/invitations\/([A-Za-z0-9_-]+)/)[1];
      assert.ok(!JSON.stringify(result).includes(token));
      const request = { user: await User.findById(recipient.user._id), id: id('req'), ip: '', get: () => 'StaffOperationsLive/1.0' };
      accepted = await acceptPlatformStaffInvitation(request, token);
      assert.equal(accepted.invitation.status, 'accepted');
      assert.equal(await PlatformGrant.countDocuments({ userId: recipient.user._id }), 0, 'acceptance alone never activates staff');
    });

    await t.test('only scoped staff approvals can be listed; a different administrator must approve real activation', async () => {
      const before = await counts();
      const listing = await runStaffOperation(credentials(decider), { action: 'list' });
      assert.equal(listing.mode, 'read-only'); assert.equal(listing.approvals.length, 1);
      assert.equal(listing.approvals[0].publicId, accepted.approval.publicId);
      assert.deepEqual((await runStaffOperation(credentials(countryAdmin), { action: 'list' })).approvals, [], 'country staff cannot read global approvals');
      await assert.rejects(runStaffOperation(credentials(requester, 1), { action: 'approve', approvalPublicId: accepted.approval.publicId, expectedVersion: 0 }), { code: 'FOUR_EYES_REQUIRED' });
      const cms = await createApproval({ user: requester.user, type: 'feature_flag', targetType: 'feature_flag', payload: { key: 'isolated.flag' }, reason: 'Unrelated approval must remain outside the staff CLI.' });
      await assert.rejects(runStaffOperation(credentials(decider), { action: 'approve', approvalPublicId: cms.publicId, expectedVersion: 0 }), { code: 'STAFF_APPROVAL_NOT_FOUND' });
      await assert.rejects(runStaffOperation(credentials(decider), { action: 'approve', apply: true, approvalPublicId: accepted.approval.publicId }), { name: 'ZodError' });
      await assert.rejects(runStaffOperation(credentials(decider), { action: 'approve', apply: true, approvalPublicId: accepted.approval.publicId, expectedVersion: 1 }), { code: 'APPROVAL_VERSION_CONFLICT' });
      const preview = await runStaffOperation(credentials(decider), { action: 'approve', approvalPublicId: accepted.approval.publicId, expectedVersion: 0 });
      assert.equal(preview.mode, 'dry-run'); assert.equal(preview.result.role, 'support'); assert.equal(preview.result.grantPublicId, undefined);
      assert.equal(await PlatformGrant.countDocuments({ userId: recipient.user._id }), 0);
      assert.equal((await ApprovalRequest.findById(accepted.approval._id)).status, 'requested');
      assert.equal((await counts()).grants, before.grants);
      const result = await runStaffOperation(credentials(decider), { action: 'approve', apply: true, approvalPublicId: accepted.approval.publicId, expectedVersion: 0 });
      assert.equal(result.mode, 'applied'); assert.equal(result.result.status, 'active');
      const active = await PlatformGrant.findOne({ userId: recipient.user._id, status: 'active' });
      assert.equal(active.role, 'support'); assert.deepEqual([...active.operationalCountries], ['UG']);
      assert.equal(String(active.approvedByUserId), String(decider.user._id));
      assert.equal(active.approvalPublicId, accepted.approval.publicId);
      assert.equal((await ApprovalRequest.findById(accepted.approval._id)).status, 'applied');
      assert.equal((await User.findById(recipient.user._id)).role, 'support');
    });

    await t.test('invitation outbox and audit failures roll back invitation, proof and authority fences', async subtest => {
      for (const Model of [OutboxEvent, AuditLog]) {
        const operator = await actor();
        const proofBefore = await User.findById(operator.user._id).select('+security.mfaRecoveryCodeHashes');
        const grantBefore = await PlatformGrant.findById(operator.grant._id).lean();
        const before = await counts();
        const failure = subtest.mock.method(Model, 'create', async () => { throw new Error('Forced isolated transactional failure.'); });
        try { await assert.rejects(runStaffOperation(credentials(operator), { ...baseInvite, email: `rollback-${id('mail')}@example.test`, apply: true }), /Forced isolated transactional failure/); }
        finally { failure.mock.restore(); }
        assert.deepEqual(await counts(), before);
        const proofAfter = await User.findById(operator.user._id).select('+security.mfaRecoveryCodeHashes');
        assert.deepEqual([...proofAfter.security.mfaRecoveryCodeHashes], [...proofBefore.security.mfaRecoveryCodeHashes]);
        assert.equal(proofAfter.__v, proofBefore.__v);
        assert.equal((await PlatformGrant.findById(operator.grant._id)).__v, grantBefore.__v);
      }
    });

    await t.test('authority changed between authentication and transaction blocks writes without consuming MFA', async subtest => {
      const operator = await actor(); const before = await counts();
      const startSession = mongoose.startSession.bind(mongoose);
      const patch = subtest.mock.method(mongoose, 'startSession', async (...args) => {
        await User.updateOne({ _id: operator.user._id }, { $inc: { 'security.tokenVersion': 1 } });
        return startSession(...args);
      });
      try { await assert.rejects(runStaffOperation(credentials(operator), { ...baseInvite, email: `changed-${id('mail')}@example.test`, apply: true }), { code: 'OPERATOR_AUTH_FAILED' }); }
      finally { patch.mock.restore(); }
      assert.deepEqual(await counts(), before);
      await PlatformGrant.updateOne({ _id: operator.grant._id }, { $set: { status: 'revoked' } });
      await assert.rejects(runStaffOperation(credentials(operator), { action: 'list' }), { code: 'OPERATOR_AUTH_FAILED' });
    });

    await t.test('throwing internal approval hook rolls back the complete transaction', async () => {
      const candidate = await actor('customer'), operator = await actor();
      const approval = await createApproval({ user: requester.user, type: 'platform_staff_access', targetType: 'user', targetPublicId: candidate.user.publicId, payload: { action: 'grant', role: 'finance', operationalCountries: ['UG'], grantDurationDays: 30 }, reason: 'Isolated hook rollback verification.' });
      const before = await counts();
      await assert.rejects(applyApproval(approval, operator.user, { beforeApply: async ({ session }) => {
        await User.updateOne({ _id: candidate.user._id }, { $set: { name: 'Temporary uncommitted mutation' } }, { session });
        throw new Error('Forced approval hook rollback.');
      } }), /Forced approval hook rollback/);
      assert.deepEqual(await counts(), before);
      assert.notEqual((await User.findById(candidate.user._id)).name, 'Temporary uncommitted mutation');
      assert.equal((await ApprovalRequest.findById(approval._id)).status, 'requested');
    });

    await t.test('approval audit failure rolls back consumed MFA, activated grant, actor fences and approval state', async subtest => {
      const candidate = await actor('customer'), operator = await actor();
      const approval = await createApproval({ user: requester.user, type: 'platform_staff_access', targetType: 'user', targetPublicId: candidate.user.publicId, payload: { action: 'grant', role: 'finance', operationalCountries: ['UG'], grantDurationDays: 30 }, reason: 'Isolated full activation rollback verification.' });
      const before = await counts();
      const userBefore = await User.findById(operator.user._id).select('+security.mfaRecoveryCodeHashes');
      const candidateBefore = await User.findById(candidate.user._id);
      const grantBefore = await PlatformGrant.findById(operator.grant._id);
      const auditFailure = subtest.mock.method(AuditLog, 'create', async () => { throw new Error('Forced activation audit rollback.'); });
      try { await assert.rejects(runStaffOperation(credentials(operator), { action: 'approve', apply: true, approvalPublicId: approval.publicId, expectedVersion: 0 }), /Forced activation audit rollback/); }
      finally { auditFailure.mock.restore(); }
      assert.deepEqual(await counts(), before);
      const userAfter = await User.findById(operator.user._id).select('+security.mfaRecoveryCodeHashes');
      assert.deepEqual([...userAfter.security.mfaRecoveryCodeHashes], [...userBefore.security.mfaRecoveryCodeHashes]);
      assert.equal(userAfter.__v, userBefore.__v);
      assert.equal((await PlatformGrant.findById(operator.grant._id)).__v, grantBefore.__v);
      const candidateAfter = await User.findById(candidate.user._id);
      assert.equal(candidateAfter.role, 'customer'); assert.equal(candidateAfter.security.tokenVersion, candidateBefore.security.tokenVersion);
      assert.equal((await ApprovalRequest.findById(approval._id)).status, 'requested');
    });

    await t.test('real CLI dry-run prints only its safe plan and generic failures, never supplied credentials or invitation tokens', async () => {
      const filename = path.join(directory, 'invitation.json');
      await fs.writeFile(filename, JSON.stringify({ email: `cli-${suffix}@example.test`, role: 'finance', operationalCountries: ['UG'], reason: 'Isolated safe CLI output verification.' }), { mode: 0o600 });
      const isolatedUri = new URL(uri); isolatedUri.pathname = '/' + dbName;
      const env = { ...process.env, NODE_ENV: 'test', MONGO_URI: isolatedUri.href, CLASSIC_MART_TEST_MONGO_OVERRIDE: '1', LOG_LEVEL: 'silent' };
      const output = spawnSync(process.execPath, ['scripts/staff-access.js', 'invite', '--input-file', filename], { cwd: process.cwd(), env, input: JSON.stringify(credentials(requester, 2)), encoding: 'utf8', timeout: 30_000 });
      assert.equal(output.status, 0, output.stderr); assert.equal(JSON.parse(output.stdout).mode, 'dry-run');
      assert.ok(!output.stdout.includes(password)); assert.ok(!output.stdout.includes(requester.codes[2]));
      assert.doesNotMatch(output.stdout, /tokenHash|mfaSecret|passwordHash|staff\/invitations/);
      const applied = spawnSync(process.execPath, ['scripts/staff-access.js', 'invite', '--input-file', filename, '--apply'], { cwd: process.cwd(), env, input: JSON.stringify(credentials(requester, 2)), encoding: 'utf8', timeout: 30_000 });
      assert.equal(applied.status, 0, applied.stderr);
      const result = JSON.parse(applied.stdout); assert.equal(result.mode, 'applied');
      const queued = await OutboxEvent.findOne({ aggregatePublicId: result.invitation.publicId });
      const rawToken = queued.payload.body.match(/\/staff\/invitations\/([A-Za-z0-9_-]+)/)[1];
      assert.ok(!applied.stdout.includes(rawToken)); assert.ok(!applied.stdout.includes(password)); assert.ok(!applied.stdout.includes(requester.codes[2]));
      const invalid = spawnSync(process.execPath, ['scripts/staff-access.js', 'invite', '--password', 'private-password-argument'], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 10_000 });
      assert.equal(invalid.status, 1); assert.doesNotMatch(invalid.stdout + invalid.stderr, /private-password-argument/);
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

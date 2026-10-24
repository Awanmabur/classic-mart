import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;

test('seller settings require current account, session and store-staff authority at commit', { skip: !uri, timeout: 120_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/iu);
  const suffix = crypto.randomBytes(8).toString('hex');
  const database = `classicmart_seller_settings_authority_test_${suffix}`;
  await mongoose.connect(uri, { dbName: database });
  const { User, Store, StoreMember, AuditLog, CountrySetting, Device } = await import('../src/models/index.js');
  const { hashToken } = await import('../src/core/crypto.js');
  const { saveSellerStoreSettings } = await import('../src/services/seller-store-settings.js');
  const { settleModelInitialization } = await import('../scripts/live-test-model-lifecycle.js');
  let sequence = 0;
  const nextId = prefix => `${prefix}_settings_${suffix}_${++sequence}`;
  async function user(role = 'customer') {
    const index = ++sequence, email = `settings-${suffix}-${index}@example.test`;
    const phone = `+2567${String(index).padStart(8, '0')}`;
    return User.create({ publicId: nextId('usr'), name: 'Isolated Settings Administrator', email, emailNormalized: email,
      phone, phoneNormalized: phone, passwordHash: 'isolated-settings-fixture-not-used-for-login', role,
      status: 'active', country: 'UG', currency: 'UGX', emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
      security: { tokenVersion: 0, mfaEnabled: true }, consents: { terms: true, privacy: true, recordedAt: new Date() } });
  }
  async function fixture(section = 'identity') {
    const owner = await user('seller'), admin = await user();
    const store = await Store.create({ publicId: nextId('str'), ownerUserId: owner._id, name: 'Original Store Identity',
      slug: `settings-${suffix}-${sequence}`, country: 'UG', currency: 'UGX', status: 'verified' });
    await StoreMember.create({ publicId: nextId('stm'), storeId: store._id, userId: owner._id,
      role: 'owner', status: 'active', invitedByUserId: owner._id, acceptedAt: new Date() });
    const membership = await StoreMember.create({ publicId: nextId('stm'), storeId: store._id, userId: admin._id,
      role: 'admin', status: 'active', invitedByUserId: owner._id, acceptedAt: new Date() });
    const body = section === 'identity'
      ? { version: store.__v, name: 'Permitted Store Identity', description: 'Current store administrator update.',
        supportEmail: 'SUPPORT@example.test', supportPhoneCountry: 'UG', supportPhone: '+256781977217' }
      : { version: store.__v, primaryCategory: 'Electronics', pickupCity: 'Kampala', fulfillmentMode: 'hybrid' };
    const sessionID = crypto.randomUUID();
    const device = await Device.create({ publicId: nextId('dev'), userId: admin._id, sessionHash: hashToken(sessionID),
      label: 'Current settings test device', userAgent: 'Settings authority fixture', ipHash: hashToken('127.0.0.1'), lastSeenAt: new Date() });
    const request = { user: admin, store, body, device, sessionID,
      session: { userId: String(admin._id), tokenVersion: admin.security.tokenVersion, activeStorePublicId: store.publicId, mfaVerifiedAt: Date.now() },
      id: nextId('req'), country: { code: 'UG' }, ip: '127.0.0.1', get: () => '' };
    return { owner, admin, store, membership, device, request, section };
  }
  const snapshot = async store => ({
    store: await Store.collection.findOne({ _id: store._id }),
    audits: await AuditLog.collection.find({ targetPublicId: store.publicId }).sort({ _id: 1 }).toArray(),
  });
  async function rejectedUnchanged(current, code) {
    const before = await snapshot(current.store);
    await assert.rejects(saveSellerStoreSettings(current.request, current.section), { code });
    assert.deepEqual(await snapshot(current.store), before, 'a denied settings write changes neither store nor audit evidence');
  }
  try {
    await settleModelInitialization(mongoose.connection);
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', returnWindowDays: 14, platformFeeBps: 700, taxBps: 1800 });
    for (const section of ['identity', 'operations']) {
      await t.test(`current delegated administrator can save ${section} with one atomic audit`, async () => {
        const current = await fixture(section);
        const saved = await saveSellerStoreSettings(current.request, section);
        assert.equal(saved.__v, current.store.__v + 1);
        const stored = await Store.findById(current.store._id).lean();
        if (section === 'identity') {
          assert.equal(stored.name, current.request.body.name);
          assert.equal(stored.operations.supportEmail, 'support@example.test');
          assert.equal(stored.operations.supportPhone, '+256781977217');
        } else {
          assert.equal(stored.operations.pickupCity, 'Kampala');
          assert.equal(stored.operations.fulfillmentMode, 'hybrid');
        }
        const audits = await AuditLog.find({ targetPublicId: current.store.publicId }).lean();
        assert.equal(audits.length, 1);
        assert.equal(String(audits[0].actorId), String(current.admin._id));
        assert.equal(audits[0].action, 'seller.store_settings_updated');
        assert.equal(audits[0].metadata.section, section);
      });
    }
    await t.test('account suspended after request authentication cannot edit its store', async () => {
      const current = await fixture();
      await User.updateOne({ _id: current.admin._id }, { $set: { status: 'suspended' } });
      await rejectedUnchanged(current, 'ACCOUNT_UNAVAILABLE');
    });
    await t.test('revoked account token version rejects the previously authenticated request', async () => {
      const current = await fixture('operations');
      await User.updateOne({ _id: current.admin._id }, { $inc: { 'security.tokenVersion': 1 } });
      await rejectedUnchanged(current, 'ACCOUNT_UNAVAILABLE');
    });
    await t.test('sparse legacy account security fails closed without an internal error', async () => {
      const current = await fixture();
      await User.collection.updateOne({ _id: current.admin._id }, { $unset: { security: 1 } });
      await rejectedUnchanged(current, 'ACCOUNT_UNAVAILABLE');
    });
    await t.test('session token version must agree with the current account', async () => {
      const current = await fixture();
      current.request.session.tokenVersion += 1;
      await rejectedUnchanged(current, 'ACCOUNT_UNAVAILABLE');
    });
    await t.test('revoked current device cannot save a still-active account', async () => {
      const current = await fixture();
      await Device.updateOne({ _id: current.device._id }, { $set: { revokedAt: new Date() } });
      await rejectedUnchanged(current, 'ACCOUNT_UNAVAILABLE');
    });
    await t.test('an active staff row without recipient acceptance grants no settings authority', async () => {
      const current = await fixture();
      await StoreMember.updateOne({ _id: current.membership._id }, { $unset: { acceptedAt: 1 } });
      await rejectedUnchanged(current, 'STORE_PERMISSION_DENIED');
    });
    await t.test('platform-managed identities cannot exercise a Customer store membership', async () => {
      const current = await fixture();
      await User.updateOne({ _id: current.admin._id }, { $set: { platformAccessManagedAt: new Date() } });
      await rejectedUnchanged(current, 'SELLER_IDENTITY_FORBIDDEN');
    });
    await t.test('delegated access stops when the real Seller owner becomes unavailable', async () => {
      const current = await fixture();
      await User.updateOne({ _id: current.owner._id }, { $set: { status: 'suspended' } });
      await rejectedUnchanged(current, 'STORE_PERMISSION_DENIED');
    });
    await t.test('removed authenticator enrollment fails closed for delegated staff with a Customer role', async () => {
      const current = await fixture('operations');
      await User.updateOne({ _id: current.admin._id }, { $set: { 'security.mfaEnabled': false } });
      await rejectedUnchanged(current, 'MFA_ENROLLMENT_REQUIRED');
    });
    for (const field of ['emailVerifiedAt', 'onboardingCompletedAt']) {
      await t.test(`removed ${field} cannot be trusted from the request snapshot`, async () => {
        const current = await fixture();
        await User.updateOne({ _id: current.admin._id }, { $unset: { [field]: 1 } });
        await rejectedUnchanged(current, 'ACCOUNT_UNAVAILABLE');
      });
    }
    await t.test('membership revoked after its transaction read cannot commit settings or audit', async () => {
      const current = await fixture('operations');
      const originalFind = StoreMember.collection.findOne;
      let revoked = false;
      // Revoke outside the transaction immediately after its permitted read.
      // A read-only authorization check admits this stale snapshot; a real
      // membership write fence conflicts, retries and rejects the revoked staff.
      t.mock.method(StoreMember.collection, 'findOne', async function (...args) {
        const result = await originalFind.apply(this, args);
        if (!revoked && args[1]?.session && String(result?._id) === String(current.membership._id)) {
          revoked = true;
          await StoreMember.collection.updateOne({ _id: current.membership._id },
            { $set: { status: 'revoked', revokedAt: new Date() }, $inc: { __v: 1 } });
        }
        return result;
      });
      try { await rejectedUnchanged(current, 'STORE_PERMISSION_DENIED'); }
      finally { t.mock.restoreAll(); }
      assert.equal(revoked, true, 'the concurrent revocation occurred after a real permitted membership read');
      assert.equal((await StoreMember.findById(current.membership._id)).status, 'revoked');
    });
  } finally {
    t.mock.restoreAll();
    try {
      await settleModelInitialization(mongoose.connection);
      assert.equal(mongoose.connection.name, database);
      await mongoose.connection.dropDatabase();
    } finally { await mongoose.disconnect(); }
  }
});

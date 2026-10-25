import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;

test('current browser identity and device reads overlap without hashing an invalid session', { timeout: 5_000 }, async t => {
  const { User, Device } = await import('../src/models/index.js');
  const { currentCustomerAccess } = await import('../src/services/customer-access.js');
  const { hashToken } = await import('../src/core/crypto.js');
  const actor = { _id: 'current-actor', status: 'active', security: { tokenVersion: 0 },
    emailVerifiedAt: new Date(), onboardingCompletedAt: new Date() };
  const gate = Promise.withResolvers();
  const chain = promise => ({ where() { return this; }, session() { return this; }, select() { return this; },
    lean() { return this; }, then(resolve, reject) { return promise.then(resolve, reject); } });
  t.mock.method(User, 'findById', () => chain(gate.promise));
  const devices = t.mock.method(Device, 'findOne', scope => {
    assert.equal(scope.userId, actor._id);
    assert.equal(scope.sessionHash, hashToken('current-browser-session'));
    assert.equal(scope.revokedAt, null);
    // The identity read deliberately waits for this independent device read.
    // A sequential implementation cannot complete this access check.
    gate.resolve(actor);
    return chain(Promise.resolve({ _id: 'current-device' }));
  });
  const browser = { user: actor, sessionID: 'current-browser-session',
    session: { userId: actor._id, tokenVersion: 0 }, device: { _id: 'current-device' } };
  assert.equal(await currentCustomerAccess(browser), actor);
  assert.equal(devices.mock.callCount(), 1);
  await assert.rejects(currentCustomerAccess({ ...browser, sessionID: {} }), error => error.code === 'ACCOUNT_UNAVAILABLE');
  assert.equal(devices.mock.callCount(), 1, 'invalid session identity never reaches hashing or a device lookup');
  await assert.rejects(currentCustomerAccess({ ...browser, session: { userId: 'different-actor', tokenVersion: 0 } }),
    error => error.code === 'ACCOUNT_UNAVAILABLE');
  assert.equal(devices.mock.callCount(), 1);
});

test('Seller read optimization retains current authority and transaction fences', { skip: !uri, timeout: 120_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  const dbName = `classicmart_seller_read_performance_test_${suffix}`;
  await mongoose.connect(uri, { dbName, monitorCommands: true });
  const models = await import('../src/models/index.js');
  const { User, Store, StoreMember, CountrySetting, Device, PlatformGrant } = models;
  const { hashPassword, hashToken } = await import('../src/core/crypto.js');
  const { getOrCreateStore, sellerStoreAccesses } = await import('../src/services/store.js');
  const { sellerOperationsAccess, sellerTransaction } = await import('../src/services/seller-operations-access.js');
  const { hydrateSellerAuthorization } = await import('../src/services/seller-authorization.js');
  const { sellerEntitlements } = await import('../src/services/seller-entitlements.js');
  let sequence = 0;
  const id = prefix => `${prefix}_${suffix}_${++sequence}`;
  const events = [];
  const listener = event => {
    if (event.databaseName === dbName && ['find', 'aggregate', 'update', 'insert', 'delete'].includes(event.commandName)) {
      events.push({ operation: event.commandName, collection: event.command[event.commandName] });
    }
  };
  const client = mongoose.connection.getClient();
  client.on('commandStarted', listener);
  async function measured(work) {
    events.length = 0;
    const value = await work();
    return { value, commands: events.slice() };
  }
  try {
    await Promise.all(Object.values(mongoose.models).map(model => model.init()));
    const country = await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG',
      timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true });
    const passwordHash = await hashPassword(`Seller-${suffix}-A1!`);
    async function actor(role) {
      const publicId = id('usr'), email = publicId + '@example.com', phone = '+25670' + String(sequence).padStart(7, '0');
      const user = await User.create({ publicId, name: 'Seller read fixture', email, emailNormalized: email,
        phone, phoneNormalized: phone, passwordHash, role, country: 'UG', currency: 'UGX',
        emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), security: { mfaEnabled: true },
        consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const sessionID = crypto.randomUUID();
      const device = await Device.create({ publicId: id('dev'), userId: user._id, sessionHash: hashToken(sessionID),
        label: 'Seller read fixture', userAgent: 'Seller read fixture', ipHash: hashToken('127.0.0.1'), lastSeenAt: new Date() });
      return { user, device, sessionID, session: { userId: String(user._id), tokenVersion: user.security.tokenVersion } };
    }
    const owner = await actor('seller'), staff = await actor('customer');
    const initial = await getOrCreateStore(owner.user);
    owner.store = initial.store;
    owner.session.activeStorePublicId = initial.store.publicId;
    staff.store = initial.store;
    staff.session.activeStorePublicId = initial.store.publicId;
    const member = await StoreMember.create({ publicId: id('stm'), storeId: initial.store._id,
      userId: staff.user._id, role: 'admin', status: 'active', acceptedAt: new Date(), invitedByUserId: owner.user._id });

    await t.test('owner workspace and operational reads avoid duplicate identity and owner queries', async () => {
      const workspace = await measured(() => getOrCreateStore(owner.user));
      assert.equal(workspace.value.store.publicId, initial.store.publicId);
      assert.equal(workspace.commands.length, 7);
      const operation = await measured(() => sellerOperationsAccess(owner, 'staff'));
      assert.equal(String(operation.value.owner?._id || operation.value.actor._id), String(owner.user._id));
      assert.equal(operation.commands.length, 6);
      assert.equal(operation.commands.filter(row => row.collection === User.collection.name).length, 1);
      assert.equal(operation.commands.filter(row => row.collection === PlatformGrant.collection.name).length, 1);
      const navigation = await measured(() => hydrateSellerAuthorization(owner));
      assert.equal(navigation.value.role, 'owner');
      assert.equal(navigation.commands.length, 4);
      const benefits = await measured(() => sellerEntitlements(initial.store));
      assert.ok(benefits.value.analyticsDays > 0);
      assert.equal(benefits.commands.length, 1, 'an empty enrollment set cannot have linked charges');
    });

    await t.test('staff owner identity and grants remain separately checked', async () => {
      const access = await measured(() => sellerOperationsAccess(staff, 'staff'));
      assert.equal(access.value.member.role, 'admin');
      assert.equal(access.commands.filter(row => row.collection === User.collection.name).length, 2);
      assert.equal(access.commands.filter(row => row.collection === PlatformGrant.collection.name).length, 2);
      await User.updateOne({ _id: owner.user._id }, { $set: { status: 'suspended' } });
      await assert.rejects(sellerOperationsAccess(staff, 'staff'), error => error.code === 'STORE_PERMISSION_DENIED');
      assert.equal(await hydrateSellerAuthorization(staff), null);
      assert.deepEqual(await sellerStoreAccesses(staff.user), []);
      await User.updateOne({ _id: owner.user._id }, { $set: { status: 'active' } });
    });

    await t.test('subsequent reads see revoked membership, device and market without cached authority', async () => {
      await StoreMember.updateOne({ _id: member._id }, { $set: { status: 'revoked' } });
      await assert.rejects(sellerOperationsAccess(staff, 'staff'), error => error.code === 'STORE_PERMISSION_DENIED');
      assert.equal(await hydrateSellerAuthorization(staff), null);
      await StoreMember.updateOne({ _id: member._id }, { $set: { status: 'active' } });
      await Device.updateOne({ _id: staff.device._id }, { $set: { revokedAt: new Date() } });
      await assert.rejects(sellerOperationsAccess(staff, 'staff'), error => error.code === 'ACCOUNT_UNAVAILABLE');
      await Device.updateOne({ _id: staff.device._id }, { $set: { revokedAt: null } });
      await CountrySetting.updateOne({ _id: country._id }, { $set: { active: false } });
      await assert.rejects(sellerOperationsAccess(owner, 'staff'), error => error.code === 'STORE_MARKET_UNAVAILABLE');
      assert.equal(await hydrateSellerAuthorization(owner), null);
      await CountrySetting.updateOne({ _id: country._id }, { $set: { active: true } });
      const current = await sellerOperationsAccess(staff, 'staff');
      assert.equal(current.member.role, 'admin');
    });

    await t.test('transactional changes retain identity, membership, store and market write fences', async () => {
      const currentMember = await StoreMember.findOne({ storeId: initial.store._id, userId: owner.user._id });
      const facts = [[User, owner.user._id], [StoreMember, currentMember._id], [Store, initial.store._id], [CountrySetting, country._id]];
      const before = await Promise.all(facts.map(async ([Model, recordId]) => (await Model.findById(recordId)).__v || 0));
      await sellerTransaction(session => sellerOperationsAccess(owner, 'staff', { session, write: true }));
      const after = await Promise.all(facts.map(async ([Model, recordId]) => (await Model.findById(recordId)).__v || 0));
      assert.deepEqual(after, before.map(version => version + 1));
    });
  } finally {
    client.off('commandStarted', listener);
    assert.equal(mongoose.connection.name, dbName);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

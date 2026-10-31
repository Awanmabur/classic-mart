import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;

test('legacy platform-grant migration preserves approval, expiry and account-state boundaries atomically', { skip: !uri, timeout: 120_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: `classicmart_grant_migration_test_${suffix}` });
  try {
    const models = await import('../src/models/index.js');
    const { User, PlatformGrant, CountrySetting } = models;
    const { migratePlatformGrants } = await import('../scripts/migrate-production.js');
    const { settleModelInitialization } = await import('../scripts/live-test-model-lifecycle.js');
    await settleModelInitialization(mongoose.connection);
    let sequence = 0;
    const user = async (changes = {}) => {
      const index = ++sequence;
      return User.create({ publicId: `usr_migration_${suffix}_${index}`, name: 'Isolated Migration Fixture',
        email: `migration-${suffix}-${index}@example.test`, emailNormalized: `migration-${suffix}-${index}@example.test`,
        phone: `+2567${String(index).padStart(8, '0')}`, phoneNormalized: `+2567${String(index).padStart(8, '0')}`,
        passwordHash: 'isolated-test-password-hash', role: 'support', status: 'active', country: 'UG', operationalCountries: ['UG'],
        consents: { terms: true, privacy: true, recordedAt: new Date() }, ...changes });
    };
    const grant = async (owner, changes = {}) => PlatformGrant.create({ publicId: `pgr_fixture_${suffix}_${++sequence}`, userId: owner._id,
      role: owner.role, operationalCountries: owner.role === 'super_admin' ? ['*'] : ['UG'], startsAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 3_600_000), status: 'active', reason: 'Isolated migration authorization regression.',
      approvalPublicId: `apr_fixture_${suffix}`, approvedByUserId: owner._id, ...changes });
    let sponsor;
    const reset = async () => {
      await PlatformGrant.deleteMany({});
      await User.deleteMany({});
      await CountrySetting.deleteMany({});
      await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true });
      sponsor = await user({ role: 'super_admin', operationalCountries: ['*'], platformAccessManagedAt: new Date() });
      await grant(sponsor);
    };
    const snapshot = async owner => ({ user: await User.collection.findOne({ _id: owner._id }), grants: await PlatformGrant.collection.find({ userId: owner._id }).toArray() });
    const deniedUnchanged = async (owner, reason) => {
      const before = await snapshot(owner);
      const result = await migratePlatformGrants();
      assert.equal(result.changed, 0);
      assert.equal(result.failed, 1);
      assert.deepEqual(result.reconciliation, [{ userPublicId: owner.publicId, reason }]);
      assert.deepEqual(await snapshot(owner), before);
    };

    await t.test('active unmanaged legacy staff without grant history receives one scoped grant and becomes managed', async () => {
      await reset();
      const owner = await user();
      const result = await migratePlatformGrants();
      assert.equal(result.changed, 1);
      assert.equal(result.synchronized, 1);
      assert.equal(result.failed, 0);
      assert.deepEqual(result.reconciliation, []);
      const stored = await User.findById(owner._id).select('+operationalCountries').lean();
      const saved = await PlatformGrant.findOne({ userId: owner._id }).lean();
      assert.ok(stored.platformAccessManagedAt instanceof Date);
      assert.equal(stored.role, 'support');
      assert.deepEqual(stored.operationalCountries, ['UG']);
      assert.equal(saved.status, 'active');
      assert.equal(saved.role, 'support');
      assert.deepEqual(saved.operationalCountries, ['UG']);
      assert.equal(String(saved.approvedByUserId), String(sponsor._id));
      assert.equal(saved.expiresAt - saved.startsAt, 180 * 86_400_000);
      const again = await migratePlatformGrants();
      assert.equal(again.changed, 0);
      assert.equal(again.failed, 0);
      assert.equal(await PlatformGrant.countDocuments({ userId: owner._id }), 1);
    });

    await t.test('managed account missing a grant cannot acquire privilege from its stale role mirror', async () => {
      await reset();
      await deniedUnchanged(await user({ platformAccessManagedAt: new Date() }), 'managed_account_without_current_grant');
    });

    await t.test('an explicit null management marker cannot be mistaken for never-managed legacy access', async () => {
      await reset();
      await deniedUnchanged(await user({ platformAccessManagedAt: null }), 'managed_account_without_current_grant');
    });

    await t.test('genuine active unmanaged legacy Super Admin receives the existing explicit global scope', async () => {
      await reset();
      const owner = await user({ role: 'super_admin', operationalCountries: ['*'] });
      const result = await migratePlatformGrants();
      assert.equal(result.changed, 1);
      assert.equal(result.failed, 0);
      const saved = await PlatformGrant.findOne({ userId: owner._id }).lean();
      assert.equal(saved.role, 'super_admin');
      assert.deepEqual(saved.operationalCountries, ['*']);
      assert.equal(String(saved.approvedByUserId), String(owner._id));
    });

    await t.test('staff preceding the only legacy Super Admin with missing scopes upgrades in one pass', async () => {
      await reset();
      await PlatformGrant.deleteMany({});
      await User.deleteMany({});
      const owner = await user({ _id: new mongoose.Types.ObjectId('000000000000000000000001') });
      const legacy = await user({ _id: new mongoose.Types.ObjectId('000000000000000000000002'), role: 'super_admin', operationalCountries: undefined });
      assert.equal(Object.hasOwn(await User.collection.findOne({ _id: legacy._id }), 'operationalCountries'), false);
      const result = await migratePlatformGrants();
      assert.equal(result.changed, 2);
      assert.equal(result.failed, 0);
      assert.deepEqual(result.reconciliation, []);
      const staffGrant = await PlatformGrant.findOne({ userId: owner._id }).lean();
      const superGrant = await PlatformGrant.findOne({ userId: legacy._id }).lean();
      assert.equal(String(staffGrant.approvedByUserId), String(legacy._id));
      assert.equal(staffGrant.role, 'support');
      assert.deepEqual(superGrant.operationalCountries, ['*']);
      assert.ok((await User.findById(owner._id)).platformAccessManagedAt);
      assert.ok((await User.findById(legacy._id)).platformAccessManagedAt);
    });

    await t.test('managed global Super Admin can sponsor through current grant despite its Customer mirror', async () => {
      await reset();
      await User.updateOne({ _id: sponsor._id }, { $set: { role: 'customer', operationalCountries: [] } });
      const owner = await user();
      const result = await migratePlatformGrants();
      assert.equal(result.changed, 1);
      assert.equal(result.failed, 0);
      assert.deepEqual(result.reconciliation, []);
      const saved = await PlatformGrant.findOne({ userId: owner._id }).lean();
      assert.equal(String(saved.approvedByUserId), String(sponsor._id));
      assert.equal((await User.findById(sponsor._id)).role, 'customer');
    });

    for (const marker of ['missing', 'null']) {
      await t.test(`Customer mirror with ${marker} management marker cannot sponsor using a stray global grant`, async () => {
        await reset();
        const change = marker === 'missing' ? { $set: { role: 'customer' }, $unset: { platformAccessManagedAt: 1 } }
          : { $set: { role: 'customer', platformAccessManagedAt: null } };
        await User.updateOne({ _id: sponsor._id }, change);
        await deniedUnchanged(await user(), 'active_super_admin_sponsor_required');
      });
    }

    await t.test('concurrent sponsor grant revocation rolls the target legacy upgrade back', async () => {
      await reset();
      await User.updateOne({ _id: sponsor._id }, { $set: { role: 'customer' } });
      const authority = await PlatformGrant.findOne({ userId: sponsor._id }).lean();
      const owner = await user();
      const before = await snapshot(owner);
      const update = PlatformGrant.collection.updateOne;
      let raced = false;
      PlatformGrant.collection.updateOne = async function (filter, change, options) {
        if (!raced && String(filter._id) === String(authority._id) && options?.session) {
          raced = true;
          await update.call(this, { _id: authority._id }, { $set: { status: 'revoked' }, $inc: { __v: 1 } });
        }
        return update.call(this, filter, change, options);
      };
      let result;
      try { result = await migratePlatformGrants(); }
      finally { PlatformGrant.collection.updateOne = update; }
      assert.equal(raced, true);
      assert.equal(result.changed, 0);
      assert.equal(result.failed, 1);
      assert.ok(result.reconciliation.some(row => row.userPublicId === owner.publicId && row.reason === 'active_super_admin_sponsor_required'));
      assert.deepEqual(await snapshot(owner), before);
      assert.equal((await PlatformGrant.findById(authority._id)).status, 'revoked');
    });

    for (const status of ['expired', 'revoked', 'suspended', 'active']) {
      await t.test(`managed ${status} historical grant is preserved without renewal`, async () => {
        await reset();
        const owner = await user({ platformAccessManagedAt: new Date() });
        await grant(owner, { status, startsAt: new Date(Date.now() - 3_600_000), expiresAt: new Date(Date.now() - 60_000) });
        await deniedUnchanged(owner, 'managed_account_without_current_grant');
      });
    }

    await t.test('unmanaged mirror with revoked grant history cannot be treated as a legacy identity', async () => {
      await reset();
      const owner = await user();
      await grant(owner, { status: 'revoked' });
      await deniedUnchanged(owner, 'existing_grant_history');
    });

    for (const status of ['suspended', 'pending_deletion', 'deleted']) {
      await t.test(`${status} legacy account is never activated or migrated`, async () => {
        await reset();
        await deniedUnchanged(await user({ status }), 'inactive_account');
      });
    }

    await t.test('current authoritative grant synchronizes only its existing role and scopes', async () => {
      await reset();
      const owner = await user({ role: 'finance', platformAccessManagedAt: new Date() });
      const existing = await grant(owner, { role: 'support', warehouseScopes: ['whs_existing'], capabilities: ['support.read'] });
      const result = await migratePlatformGrants();
      assert.equal(result.changed, 0);
      assert.equal(result.synchronized, 2);
      assert.equal(result.failed, 0);
      const stored = await User.findById(owner._id).select('+operationalCountries').lean();
      const saved = await PlatformGrant.findById(existing._id).lean();
      assert.equal(stored.role, 'support');
      assert.deepEqual(stored.operationalCountries, ['UG']);
      assert.deepEqual(saved.warehouseScopes, ['whs_existing']);
      assert.deepEqual(saved.capabilities, ['support.read']);
      assert.equal(saved.expiresAt.getTime(), existing.expiresAt.getTime());
      assert.equal(await PlatformGrant.countDocuments({ userId: owner._id }), 1);
    });

    await t.test('no active sponsor leaves the entire legacy identity unchanged', async () => {
      await reset();
      await User.updateOne({ _id: sponsor._id }, { $set: { status: 'suspended' } });
      const owner = await user();
      const before = await snapshot(owner);
      const result = await migratePlatformGrants();
      assert.equal(result.changed, 0);
      assert.equal(result.failed, 2);
      assert.ok(result.reconciliation.some(row => row.userPublicId === owner.publicId && row.reason === 'active_super_admin_sponsor_required'));
      assert.deepEqual(await snapshot(owner), before);
    });

    await t.test('grant insertion failure rolls the managed identity claim back', async () => {
      await reset();
      const owner = await user();
      const before = await snapshot(owner);
      const create = PlatformGrant.create;
      PlatformGrant.create = async function (documents, ...args) {
        if (documents.some(document => String(document.userId) === String(owner._id))) throw new Error('isolated grant insertion failure');
        return create.call(this, documents, ...args);
      };
      try { await assert.rejects(migratePlatformGrants(), /isolated grant insertion failure/); }
      finally { PlatformGrant.create = create; }
      assert.deepEqual(await snapshot(owner), before);
    });

    await t.test('concurrent staff revocation wins over migration of a stale legacy mirror', async () => {
      await reset();
      const owner = await user();
      const update = User.collection.updateOne;
      let raced = false;
      User.collection.updateOne = async function (filter, change, options) {
        if (!raced && String(filter._id) === String(owner._id) && options?.session && change.$set?.platformAccessManagedAt) {
          raced = true;
          await update.call(this, { _id: owner._id }, { $set: { platformAccessManagedAt: new Date(), role: 'customer', operationalCountries: [] }, $inc: { __v: 1, 'security.tokenVersion': 1 } });
          await grant(owner, { status: 'revoked' });
        }
        return update.call(this, filter, change, options);
      };
      let result;
      try { result = await migratePlatformGrants(); }
      finally { User.collection.updateOne = update; }
      assert.equal(raced, true);
      assert.equal(result.changed, 0);
      assert.equal(result.failed, 1);
      assert.ok(result.reconciliation.some(row => row.userPublicId === owner.publicId && row.reason === 'identity_changed'));
      const stored = await User.findById(owner._id).select('+operationalCountries').lean();
      assert.equal(stored.role, 'customer');
      assert.deepEqual(stored.operationalCountries, []);
      assert.equal(await PlatformGrant.countDocuments({ userId: owner._id, status: 'active' }), 0);
      assert.equal(await PlatformGrant.countDocuments({ userId: owner._id, status: 'revoked' }), 1);
    });

    await t.test('concurrent grant revocation cannot be overwritten while synchronizing a role mirror', async () => {
      await reset();
      const owner = await user({ platformAccessManagedAt: new Date() });
      const existing = await grant(owner);
      const update = PlatformGrant.collection.updateOne;
      let raced = false;
      PlatformGrant.collection.updateOne = async function (filter, change, options) {
        if (!raced && String(filter._id) === String(existing._id) && options?.session) {
          raced = true;
          await update.call(this, { _id: existing._id }, { $set: { status: 'revoked' }, $inc: { __v: 1 } });
        }
        return update.call(this, filter, change, options);
      };
      let result;
      try { result = await migratePlatformGrants(); }
      finally { PlatformGrant.collection.updateOne = update; }
      assert.equal(raced, true);
      assert.equal(result.changed, 0);
      assert.equal(result.failed, 1);
      assert.ok(result.reconciliation.some(row => row.userPublicId === owner.publicId && row.reason === 'managed_account_without_current_grant'));
      assert.equal((await PlatformGrant.findById(existing._id)).status, 'revoked');
      assert.equal(await PlatformGrant.countDocuments({ userId: owner._id }), 1);
    });

    await t.test('CLI planning leaves a fresh isolated database schema empty', async () => {
      const planDbName = `classicmart_grant_plan_test_${suffix}`;
      const planDb = mongoose.connection.getClient().db(planDbName);
      const isolatedUri = new URL(uri); isolatedUri.pathname = '/' + planDbName;
      const { spawnSync } = await import('node:child_process');
      try {
        assert.equal((await planDb.listCollections({}, { nameOnly: true }).toArray()).length, 0);
        const planned = spawnSync(process.execPath, ['scripts/migrate-production.js'], {
          cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 60_000,
          env: { ...process.env, NODE_ENV: 'test', MONGO_URI: isolatedUri.href, CLASSIC_MART_TEST_MONGO_OVERRIDE: '1', LOG_LEVEL: 'silent' },
        });
        assert.equal(planned.status, 0, planned.stderr);
        assert.match(planned.stdout, /No data changed/);
        assert.equal((await planDb.listCollections({}, { nameOnly: true }).toArray()).length, 0);
      } finally { await planDb.dropDatabase(); }
    });

    await t.test('CLI apply prepares a missing grant collection outside transactions while planning creates nothing', async () => {
      await reset();
      await PlatformGrant.collection.drop();
      await User.deleteMany({});
      const owner = await user({ _id: new mongoose.Types.ObjectId('000000000000000000000001') });
      const legacy = await user({ _id: new mongoose.Types.ObjectId('000000000000000000000002'), role: 'super_admin', operationalCountries: undefined });
      const exists = async () => (await mongoose.connection.db.listCollections({ name: PlatformGrant.collection.name }, { nameOnly: true }).toArray()).length > 0;
      assert.equal(await exists(), false);
      const { mongoUriWithDatabase } = await import('../src/core/mongo-uri.js');
      const commandEnv = { ...process.env, NODE_ENV: 'test', CLASSIC_MART_TEST_MONGO_OVERRIDE: '1',
        MONGO_URI: mongoUriWithDatabase(uri, mongoose.connection.name), LOG_LEVEL: 'silent', MAIL_MODE: 'log', SMS_MODE: 'disabled', AI_ENABLED: 'false' };
      const plan = spawnSync(process.execPath, ['scripts/migrate-production.js'], {
        cwd: new URL('../', import.meta.url), env: commandEnv, encoding: 'utf8', timeout: 60_000,
      });
      assert.equal(plan.status, 0, plan.stderr);
      assert.equal(await exists(), false, 'read-only planning must not prepare collections');
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'classicmart-grant-ddl-'));
      try {
        const hookFile = path.join(directory, 'observe-ddl.mjs');
        const traceFile = path.join(directory, 'ordering.json');
        const mongooseModule = new URL('../node_modules/mongoose/index.js', import.meta.url).href;
        // Observe actual DDL and transaction boundaries in the real CLI child.
        // This local replica-set check does not simulate a sharded mongos.
        await fs.writeFile(hookFile, `
          import assert from 'node:assert/strict';
          import fs from 'node:fs';
          import mongoose from ${JSON.stringify(mongooseModule)};
          const events=[]; let transactionDepth=0;
          const createCollection=mongoose.Model.createCollection;
          mongoose.Model.createCollection=async function(...args){
            if(this.modelName==='PlatformGrant'){
              assert.equal(transactionDepth,0);
              assert.equal(Boolean(args[0]?.session?.inTransaction()),false);
              events.push({type:'createCollection',transactionActive:false});
            }
            return createCollection.apply(this,args);
          };
          const startSession=mongoose.startSession;
          mongoose.startSession=async function(...args){
            const session=await startSession.apply(this,args);
            const withTransaction=session.withTransaction;
            session.withTransaction=async function(...options){
              const found=await mongoose.connection.db.listCollections({name:'platformgrants'},{nameOnly:true}).toArray();
              events.push({type:'transaction',collectionPresent:found.length===1});
              transactionDepth+=1;
              try{return await withTransaction.apply(this,options);}
              finally{transactionDepth-=1;}
            };
            return session;
          };
          process.on('exit',()=>fs.writeFileSync(${JSON.stringify(traceFile)},JSON.stringify(events),{mode:0o600}));
        `, { mode: 0o600 });
        const applied = spawnSync(process.execPath, ['--import', hookFile, 'scripts/migrate-production.js', '--apply'], {
          cwd: new URL('../', import.meta.url), env: commandEnv, encoding: 'utf8', timeout: 60_000,
        });
        assert.equal(applied.status, 0, applied.stderr);
        const events = JSON.parse(await fs.readFile(traceFile, 'utf8'));
        assert.equal(events[0]?.type, 'createCollection');
        assert.ok(events.some(event => event.type === 'transaction'));
        assert.ok(events.filter(event => event.type === 'transaction').every(event => event.collectionPresent));
        assert.ok(events.filter(event => event.type === 'createCollection').every(event => event.transactionActive === false));
        const reportOffset = applied.stdout.indexOf('{\n  "applied": true,');
        assert.ok(reportOffset >= 0);
        const report = JSON.parse(applied.stdout.slice(reportOffset));
        assert.equal(report.result.platformGrants.changed, 2);
        assert.equal(report.result.platformGrants.failed, 0);
        assert.equal(await exists(), true);
        assert.equal(await PlatformGrant.countDocuments(), 2);
        assert.equal(String((await PlatformGrant.findOne({ userId: owner._id })).approvedByUserId), String(legacy._id));
        assert.ok((await User.findById(owner._id)).platformAccessManagedAt);
        assert.ok((await User.findById(legacy._id)).platformAccessManagedAt);
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    });

    await t.test('CLI planning changes no identities and apply exits 2 with reconciliation instead of renewing expired access', async () => {
      await reset();
      const owner = await user({ platformAccessManagedAt: new Date() });
      await grant(owner, { startsAt: new Date(Date.now() - 3_600_000), expiresAt: new Date(Date.now() - 60_000) });
      const { mongoUriWithDatabase } = await import('../src/core/mongo-uri.js');
      const commandEnv = { ...process.env, NODE_ENV: 'test', CLASSIC_MART_TEST_MONGO_OVERRIDE: '1',
        MONGO_URI: mongoUriWithDatabase(uri, mongoose.connection.name), MAIL_MODE: 'log', SMS_MODE: 'disabled', AI_ENABLED: 'false',
        SESSION_SECRET: crypto.randomBytes(32).toString('hex'), TOKEN_PEPPER: crypto.randomBytes(32).toString('hex'),
        DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), SECURITY_INTEGRITY_KEY: crypto.randomBytes(32).toString('hex') };
      const before = await snapshot(owner);
      const allUsers = await User.collection.find({}).sort({ _id: 1 }).toArray();
      const allGrants = await PlatformGrant.collection.find({}).sort({ _id: 1 }).toArray();
      const plan = spawnSync(process.execPath, ['scripts/migrate-production.js'], {
        cwd: new URL('../', import.meta.url), env: commandEnv, encoding: 'utf8', timeout: 60_000,
      });
      assert.equal(plan.status, 0, plan.stderr);
      assert.match(plan.stdout, /"mode": "dry-run"/);
      assert.match(plan.stdout, /No data changed/);
      assert.deepEqual(await User.collection.find({}).sort({ _id: 1 }).toArray(), allUsers);
      assert.deepEqual(await PlatformGrant.collection.find({}).sort({ _id: 1 }).toArray(), allGrants);
      const applied = spawnSync(process.execPath, ['scripts/migrate-production.js', '--apply'], {
        cwd: new URL('../', import.meta.url), env: commandEnv, encoding: 'utf8', timeout: 60_000,
      });
      assert.equal(applied.status, 2, applied.stderr);
      assert.match(applied.stderr, /release certification failed/);
      assert.match(applied.stderr, /privileged user\(s\) could not be migrated to authoritative PlatformGrant access/);
      const reportOffset = applied.stdout.indexOf('{\n  "applied": true,');
      assert.ok(reportOffset >= 0, 'CLI must return its actual migration report');
      const report = JSON.parse(applied.stdout.slice(reportOffset));
      assert.equal(report.result.platformGrants.changed, 0);
      assert.equal(report.result.platformGrants.failed, 1);
      assert.deepEqual(report.result.platformGrants.reconciliation, [{ userPublicId: owner.publicId, reason: 'managed_account_without_current_grant' }]);
      assert.deepEqual(await snapshot(owner), before);
    });
  } finally {
    const { settleModelInitialization } = await import('../scripts/live-test-model-lifecycle.js');
    await settleModelInitialization(mongoose.connection);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

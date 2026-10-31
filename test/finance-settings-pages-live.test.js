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

test('Finance settings persist scoped defaults without changing policy, privilege or another workspace', { skip: !uri, timeout: 150_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1'); assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex'), transports = [];
  await mongoose.connect(uri, { dbName: `classicmart_finance_settings_test_${suffix}` });
  try {
    const { createApp } = await import('../src/app.js');
    const { User, PlatformGrant, CountrySetting, AuditLog, Store, LedgerAccount, LoyaltyAccount, Notification } = await import('../src/models/index.js');
    const { hashPassword } = await import('../src/core/crypto.js');
    const { encryptSensitive } = await import('../src/core/sensitive.js');
    const { totpCode } = await import('../src/services/mfa.js');
    const { financeAccess } = await import('../src/services/finance-workspace-access.js');
    const { loadFinanceSettingsPage, saveFinanceSettings } = await import('../src/services/finance-settings-pages.js');
    const { queueFinanceAlert } = await import('../src/services/finance-notifications.js');
    const { dashboardLanding } = await import('../src/dashboard/landing.js');
    await Promise.all(Object.values(mongoose.models).map(Model => Model.init()));
    await CountrySetting.create([{ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256' },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254' },
      { code: 'TZ', name: 'Private unassigned market', currency: 'TZS', locale: 'en-TZ', timeZone: 'Africa/Dar_es_Salaam', phonePrefix: '+255' }]);
    const password = `Finance-${suffix}-A1!`, passwordHash = await hashPassword(password), app = createApp(null);
    let sequence = 0;
    async function actor(role, { managed = false, login = false } = {}) {
      const index = ++sequence, email = `finance-settings-${suffix}-${index}@example.com`, phone = '+25670' + String(index).padStart(7, '0');
      const secret = 'JBSWY3DPEHPK3PXP';
      const user = await User.create({ publicId: `usr_fs_${suffix}_${index}`, name: `Finance settings ${index}`, email, emailNormalized: email, phone, phoneNormalized: phone,
        passwordHash, role, country: 'UG', currency: 'UGX', operationalCountries: ['UG', 'KE'], emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
        platformAccessManagedAt: managed ? new Date() : undefined, security: { mfaEnabled: true, mfaSecretEncrypted: encryptSensitive(secret) },
        consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const grant = managed ? await PlatformGrant.create({ publicId: `pgr_fs_${suffix}_${index}`, userId: user._id, role: 'finance', operationalCountries: ['UG', 'KE'], status: 'active',
        startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86400_000), reason: 'Scoped fixture authorization', approvalPublicId: `apr_fs_${suffix}_${index}`, approvedByUserId: new mongoose.Types.ObjectId() }) : null;
      let client;
      if (login) {
        const transport = new http.Agent({ localAddress: `127.0.0.${index + 40}`, keepAlive: false }); transports.push(transport);
        client = request.agent(app).use(req => req.agent(transport));
        const page = await client.get('/login').expect(200);
        await client.post('/login').type('form').send({ email, password, _csrf: csrf(page.text) }).expect(302).expect('location', '/mfa');
        const challenge = await client.get('/mfa').expect(200);
        await client.post('/mfa').type('form').send({ code: totpCode(secret), _csrf: csrf(challenge.text) }).expect(302);
      }
      return { user, grant, client };
    }
    const owner = await actor('customer', { managed: true, login: true });
    const originalRole = (await User.findById(owner.user._id)).role;
    const scoped = (entry = owner, query = {}) => ({ id: `req_fs_${suffix}_${++sequence}`, ip: '127.0.0.1', get: () => 'FinanceSettingsTest/1.0', user: entry.user, session: { tokenVersion: entry.user.security.tokenVersion }, query });
    const fresh = () => loadFinanceSettingsPage(scoped());
    const submission = flow => ({ version: flow.preferences.version, defaultCountry: 'UG', reportingPeriod: '7months' });

    await t.test('real settings use the authoritative grant and expose only assigned public market controls', async () => {
      const response = await owner.client.get('/finance/settings').set('Accept', 'application/json').expect(200);
      assert.equal(response.body.context.country, ''); assert.equal(response.body.context.currency, null);
      assert.deepEqual(response.body.context.countries.map(row => row.code).sort(), ['KE', 'UG']);
      assert.equal(response.body.rows.length, 12); assert.equal(response.body.page.total, 12);
      assert.ok(!JSON.stringify(response.body).includes('Private unassigned market'));
      assert.ok(!JSON.stringify(response.body).includes('mfaSecretEncrypted'));
      assert.match(response.headers['cache-control'], /no-store/); assert.equal(response.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
      assert.equal((await User.findById(owner.user._id)).role, originalRole, 'reading a grant does not rewrite its compatibility mirror');
      assert.equal(await Store.countDocuments(), 0); assert.equal(await LedgerAccount.countDocuments(), 0); assert.equal(await LoyaltyAccount.countDocuments(), 0);
    });
    await t.test('HTML forms save actual defaults with CSRF and preserve server-owned policy and identity', async () => {
      const before = await CountrySetting.find().lean(), page = await owner.client.get('/finance/settings').expect(200), flow = await fresh();
      await owner.client.post('/finance/settings').type('form').send(submission(flow)).expect(403);
      await owner.client.post('/finance/settings').type('form').send({ ...submission(flow), _csrf: csrf(page.text), role: 'super_admin', currency: 'TZS', platformFeeBps: 0 }).expect(302).expect('location', '/finance/settings?section=business');
      const user = await User.findById(owner.user._id);
      assert.equal(user.preferences.financeDefaultCountry, 'UG'); assert.equal(user.preferences.financeReportingPeriod, '7months');
      assert.equal(user.role, originalRole); assert.equal(user.currency, 'UGX'); assert.deepEqual(await CountrySetting.find().select('code currency platformFeeBps').lean().then(rows => rows.map(row => [row.code, row.currency, row.platformFeeBps])), before.map(row => [row.code, row.currency, row.platformFeeBps]));
      const context = await financeAccess(scoped()); assert.equal(context.country, 'UG'); assert.equal(context.currency, 'UGX');
      assert.equal(await AuditLog.countDocuments({ action: 'finance.preferences_saved', actorId: owner.user._id }), 1);
    });
    await t.test('stale saves and invalid periods or foreign countries leave persisted preferences unchanged', async () => {
      const flow = await fresh(), valid = submission(flow);
      await assert.rejects(saveFinanceSettings(scoped(), { ...valid, defaultCountry: 'TZ' }), error => error.status === 403);
      await assert.rejects(saveFinanceSettings(scoped(), { ...valid, reportingPeriod: 'forever' }), error => error.name === 'ZodError');
      await saveFinanceSettings(scoped(), valid);
      await assert.rejects(saveFinanceSettings(scoped(), valid), error => error.code === 'FINANCE_SETTINGS_VERSION_CONFLICT');
      assert.equal((await User.findById(owner.user._id)).preferences.financeReportingPeriod, '7months');
      await owner.client.get('/finance/settings?country=UG&country=KE').set('Accept', 'application/json').expect(422);
      await owner.client.get('/finance/settings?country[bad]=UG').set('Accept', 'application/json').expect(422);
    });
    await t.test('the five settings sections persist a real profile, landing queue and communication choices', async () => {
      const security = await owner.client.get('/finance/settings?section=security').expect(200);
      assert.match(security.text, /Password &amp; Security/); assert.match(security.text, /href="\/account\/security"/);
      let flow = await fresh();
      const profile = await owner.client.post('/finance/settings/profile').set('Accept', 'application/json').set('x-csrf-token', csrf(security.text))
        .send({ version: flow.preferences.version, name: 'Verified Finance Operator', teamName: 'Actual Finance Team', bio: 'Payment control team', email: 'unauthorized-change@example.com', role: 'super_admin' }).expect(200);
      const saved = await User.findById(owner.user._id);
      assert.equal(profile.body.version, saved.__v);
      assert.equal(saved.name, 'Verified Finance Operator'); assert.equal(saved.roleProfile.businessName, 'Actual Finance Team'); assert.equal(saved.email, owner.user.email); assert.equal(saved.role, originalRole);
      await owner.client.post('/finance/settings/profile').set('x-csrf-token', csrf(security.text)).send({ version: flow.preferences.version, name: 'Stale change' }).expect(409);
      flow = await fresh(); await saveFinanceSettings(scoped(), { ...submission(flow), landingPage: 'finance-refunds' });
      const current = await financeAccess(scoped()); assert.equal(dashboardLanding(current.actor), '/finance/refunds');
      await assert.rejects(saveFinanceSettings(scoped(), { ...submission(await fresh()), landingPage: 'seller-overview' }), error => error.name === 'ZodError');
      flow = await fresh();
      await owner.client.post('/finance/settings/communication').set('Accept', 'application/json').set('x-csrf-token', csrf(security.text))
        .send({ version: flow.preferences.version, priorityAlerts: false, escalationAlerts: true, weeklyReport: true }).expect(200);
      const preferences = (await User.findById(owner.user._id)).preferences;
      assert.equal(preferences.financePriorityAlerts, false); assert.equal(preferences.financeEscalationAlerts, true); assert.equal(preferences.financeWeeklyReport, true);
      for (const section of ['profile', 'business', 'payments', 'notifications', 'security']) {
        const page = await owner.client.get('/finance/settings?section=' + section).expect(200); assert.match(page.text, /data-dashboard-workspace="finance"/); assert.doesNotMatch(page.text, /hello@classicmart\.example|Stanbic Bank|92%|3 signed-in devices/);
      }
    });
    await t.test('ordinary Finance alerts honor saved preferences and current market grants without exposing beneficiary data', async () => {
      const emit = async kind => {
        const session = await mongoose.startSession();
        try { await session.withTransaction(async () => queueFinanceAlert({ country: 'UG', kind, href: '/finance/payouts' }, session)); } finally { await session.endSession(); }
      };
      const before = await Notification.countDocuments({ userId: owner.user._id, type: 'finance_work' });
      await emit('priority'); assert.equal(await Notification.countDocuments({ userId: owner.user._id, type: 'finance_work' }), before);
      await emit('escalation'); assert.equal(await Notification.countDocuments({ userId: owner.user._id, type: 'finance_work' }), before + 1);
      const outsider = await actor('finance'); await User.updateOne({ _id: outsider.user._id }, { $set: { country: 'TZ', operationalCountries: ['TZ'] } });
      await emit('escalation'); assert.equal(await Notification.countDocuments({ userId: outsider.user._id, type: 'finance_work' }), 0);
      const record = await Notification.findOne({ userId: owner.user._id, type: 'finance_work' }).lean();
      assert.equal(record.country, 'UG'); assert.equal(record.href, '/finance/payouts'); assert.doesNotMatch(record.body, /account_number|bank account|payment credentials/i);
      await PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { status: 'suspended' } });
      const current = await Notification.countDocuments({ userId: owner.user._id, type: 'finance_work' }); await emit('escalation');
      assert.equal(await Notification.countDocuments({ userId: owner.user._id, type: 'finance_work' }), current);
      await PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { status: 'active' } });
    });
    await t.test('competing current saves have one winner and audit failure rolls every write back', async () => {
      const flow = await fresh(), body = submission(flow);
      const results = await Promise.allSettled(['UG', 'KE'].map(defaultCountry => saveFinanceSettings(scoped(), { ...body, defaultCountry })));
      assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
      assert.equal(results.filter(row => row.status === 'rejected' && row.reason.code === 'FINANCE_SETTINGS_VERSION_CONFLICT').length, 1);
      const before = await User.findById(owner.user._id).lean(), grant = await PlatformGrant.findById(owner.grant._id).lean(), settings = await CountrySetting.find().lean();
      t.mock.method(AuditLog, 'create', async () => { throw new Error('Finance audit unavailable'); });
      await assert.rejects(saveFinanceSettings(scoped(), submission(await fresh())), /Finance audit unavailable/); t.mock.restoreAll();
      assert.equal((await User.findById(owner.user._id)).__v, before.__v); assert.equal((await PlatformGrant.findById(owner.grant._id)).__v, grant.__v);
      assert.deepEqual((await CountrySetting.find().lean()).map(row => row.__v), settings.map(row => row.__v));
    });
    await t.test('current MFA, identity, session and grant state protect direct services and country selection', async () => {
      const denied = await actor('customer', { managed: true });
      for (const patch of [{ status: 'suspended' }, { 'security.mfaEnabled': false }, { 'security.tokenVersion': 1 }, { emailVerifiedAt: null }, { onboardingCompletedAt: null }]) {
        await User.updateOne({ _id: denied.user._id }, { $set: patch });
        await assert.rejects(financeAccess(scoped(denied)), error => error.status === 403);
        await User.updateOne({ _id: denied.user._id }, { $set: { status: 'active', 'security.mfaEnabled': true, 'security.tokenVersion': 0, emailVerifiedAt: new Date(), onboardingCompletedAt: new Date() } });
      }
      await PlatformGrant.updateOne({ _id: denied.grant._id }, { $set: { status: 'revoked' } });
      await assert.rejects(financeAccess(scoped(denied)), error => error.code === 'FINANCE_GRANT_UNAVAILABLE');
      for (const role of ['customer', 'seller', 'promoter', 'country_admin', 'super_admin']) {
        const other = await actor(role); await assert.rejects(loadFinanceSettingsPage(scoped(other)), error => error.status === 403);
        if (['country_admin', 'super_admin'].includes(role)) assert.ok(await financeAccess(scoped(other), { workspace: false, country: 'UG' }));
      }
      await assert.rejects(financeAccess(scoped(), { write: true }), error => error.code === 'FINANCE_TRANSACTION_REQUIRED');
    });
    await t.test('exports are real scoped CSV and shopping preferences cannot alter operational authorization', async () => {
      await User.updateOne({ _id: owner.user._id }, { $set: { shoppingCountry: 'TZ', currency: 'TZS' } });
      const exportResponse = await owner.client.get('/finance/settings/export.csv?country=KE').expect(200);
      assert.match(exportResponse.headers['content-type'], /text\/csv/); assert.match(exportResponse.text, /"KE","KES"/); assert.ok(!exportResponse.text.includes('"UG"')); assert.ok(!exportResponse.text.includes('"TZ"'));
      const page = await owner.client.get('/finance/settings?country=UG').set('Accept', 'application/json').expect(200);
      assert.equal(page.body.context.currency, 'UGX'); assert.equal((await User.findById(owner.user._id)).currency, 'TZS');
      await owner.client.get('/finance/settings?country=TZ').set('Accept', 'application/json').expect(403);
    });
  } finally {
    t.mock.restoreAll(); for (const transport of transports) transport.destroy();
    await Promise.all(Object.values(mongoose.models).map(Model => Model.init()));
    try { await mongoose.connection.dropDatabase(); } finally { await mongoose.disconnect(); }
  }
});

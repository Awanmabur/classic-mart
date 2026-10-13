import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import mongoose from 'mongoose';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
for (const name of ['SESSION_SECRET', 'TOKEN_PEPPER', 'SECURITY_INTEGRITY_KEY', 'DATA_ENCRYPTION_KEY']) process.env[name] = crypto.randomBytes(32).toString('hex');
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('Moderation settings persist scoped defaults without changing policy, privilege or another workspace', { skip: !uri, timeout: 300_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1'); assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex'), transports = [];
  await mongoose.connect(uri, { dbName: `classicmart_moderation_settings_test_${suffix}` });
  try {
    const { createApp } = await import('../src/app.js');
    const { User, PlatformGrant, CountrySetting, AuditLog, Store, LedgerAccount, LoyaltyAccount, Notification } = await import('../src/models/index.js');
    const { hashPassword } = await import('../src/core/crypto.js');
    const { encryptSensitive } = await import('../src/core/sensitive.js');
    const { totpCode } = await import('../src/services/mfa.js');
    const { moderationAccess } = await import('../src/services/moderation-workspace-access.js');
    const { loadModerationSettingsPage, saveModerationSettings, saveModerationProfile, saveModerationCommunication } = await import('../src/services/moderation-settings-pages.js');
    const { queueModerationAlert } = await import('../src/services/moderation-notifications.js');
    const { dashboardLanding } = await import('../src/dashboard/landing.js');
    await Promise.all(Object.values(mongoose.models).map(Model => Model.init()));
    await CountrySetting.create([{ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256' },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254' },
      { code: 'TZ', name: 'Private unassigned market', currency: 'TZS', locale: 'en-TZ', timeZone: 'Africa/Dar_es_Salaam', phonePrefix: '+255' }]);
    const password = `Moderation-${suffix}-A1!`, passwordHash = await hashPassword(password), app = createApp(null);
    let sequence = 0;
    async function actor(role, { managed = false, login = false } = {}) {
      const index = ++sequence, email = `moderation-settings-${suffix}-${index}@example.com`, phone = '+25670' + String(index).padStart(7, '0');
      const secret = 'JBSWY3DPEHPK3PXP';
      const user = await User.create({ publicId: `usr_ss_${suffix}_${index}`, name: `Moderation settings ${index}`, email, emailNormalized: email, phone, phoneNormalized: phone,
        passwordHash, role, country: 'UG', currency: 'UGX', operationalCountries: ['UG', 'KE'], emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
        platformAccessManagedAt: managed ? new Date() : undefined, security: { mfaEnabled: true, mfaSecretEncrypted: encryptSensitive(secret) },
        consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const grant = managed ? await PlatformGrant.create({ publicId: `pgr_ss_${suffix}_${index}`, userId: user._id, role: 'moderator', operationalCountries: ['UG', 'KE'], status: 'active',
        startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86400_000), reason: 'Scoped fixture authorization', approvalPublicId: `apr_ss_${suffix}_${index}`, approvedByUserId: new mongoose.Types.ObjectId() }) : null;
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
    await User.updateOne({ _id: owner.user._id }, { $set: { role: 'customer', 'preferences.financeReportingPeriod': 'year', 'preferences.supportDefaultQueue': 'returns' } });
    const originalRole = 'customer';
    const scoped = (entry = owner, query = {}) => ({ id: `req_ss_${suffix}_${++sequence}`, ip: '127.0.0.1', get: () => 'ModerationSettingsTest/1.0', user: entry.user, session: { tokenVersion: entry.user.security.tokenVersion }, query });
    const fresh = () => loadModerationSettingsPage(scoped());
    const submission = flow => ({ version: flow.preferences.version, defaultCountry: 'UG', reportingPeriod: '7months', landingPage: 'moderator-overview', density: 'compact', idleReminderMinutes: 30 });

    await t.test('real settings use the authoritative grant and expose only assigned public market controls', async () => {
      const response = await owner.client.get('/moderation/settings').set('Accept', 'application/json').expect(200);
      assert.equal(response.body.context.country, ''); assert.equal(response.body.context.currency, null);
      assert.deepEqual(response.body.context.countries.map(row => row.code).sort(), ['KE', 'UG']);
      assert.ok(response.body.rows.length > 0, 'Assigned workspace controls must be available.');
      assert.equal(response.body.page.total, response.body.rows.length);
      assert.ok(!JSON.stringify(response.body).includes('Private unassigned market'));
      assert.ok(!JSON.stringify(response.body).includes('mfaSecretEncrypted'));
      assert.match(response.headers['cache-control'], /no-store/); assert.equal(response.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
      assert.equal((await User.findById(owner.user._id)).role, originalRole, 'reading a grant does not rewrite its compatibility mirror');
      assert.equal(await Store.countDocuments(), 0); assert.equal(await LedgerAccount.countDocuments(), 0); assert.equal(await LoyaltyAccount.countDocuments(), 0);
    });
    await t.test('HTML forms save actual defaults with CSRF and preserve server-owned policy and identity', async () => {
      const before = await CountrySetting.find().lean(), page = await owner.client.get('/moderation/settings').expect(200), flow = await fresh();
      await owner.client.post('/moderation/settings').type('form').send(submission(flow)).expect(403);
      await owner.client.post('/moderation/settings').type('form').send({ ...submission(flow), _csrf: csrf(page.text), role: 'super_admin', currency: 'TZS', platformFeeBps: 0 }).expect(302).expect('location', '/moderation/settings?section=business');
      const user = await User.findById(owner.user._id);
      assert.equal(user.preferences.moderationDefaultCountry, 'UG'); assert.equal(user.preferences.moderationReportingPeriod, '7months');
      assert.equal(user.preferences.moderationDensity, 'compact'); assert.equal(user.preferences.moderationIdleReminderMinutes, 30);
      assert.equal(user.preferences.financeReportingPeriod, 'year'); assert.equal(user.preferences.supportDefaultQueue, 'returns');
      assert.equal(user.role, originalRole); assert.equal(user.currency, 'UGX'); assert.deepEqual(await CountrySetting.find().select('code currency platformFeeBps').lean().then(rows => rows.map(row => [row.code, row.currency, row.platformFeeBps])), before.map(row => [row.code, row.currency, row.platformFeeBps]));
      const context = await moderationAccess(scoped()); assert.equal(context.country, 'UG'); assert.equal(context.currency, 'UGX');
      assert.equal(await AuditLog.countDocuments({ action: 'moderation.preferences_saved', actorId: owner.user._id }), 1);
    });
    await t.test('stale saves and invalid periods or foreign countries leave persisted preferences unchanged', async () => {
      const flow = await fresh(), valid = submission(flow);
      await assert.rejects(saveModerationSettings(scoped(), { ...valid, defaultCountry: 'TZ' }), error => error.status === 403);
      for (const invalid of [{ reportingPeriod: 'forever' }, { density: 'tight' }, { idleReminderMinutes: 5 }, { landingPage: 'finance-overview' }]) {
        await assert.rejects(saveModerationSettings(scoped(), { ...valid, ...invalid }), error => error.name === 'ZodError');
      }
      await saveModerationSettings(scoped(), valid);
      await assert.rejects(saveModerationSettings(scoped(), valid), error => error.code === 'MODERATION_SETTINGS_VERSION_CONFLICT');
      assert.equal((await User.findById(owner.user._id)).preferences.moderationReportingPeriod, '7months');
      await owner.client.get('/moderation/settings?country=UG&country=KE').set('Accept', 'application/json').expect(422);
      await owner.client.get('/moderation/settings?country[bad]=UG').set('Accept', 'application/json').expect(422);
    });
    await t.test('the five settings sections persist a real profile, landing page and communication choices', async () => {
      const security = await owner.client.get('/moderation/settings?section=security').expect(200);
      assert.match(security.text, /Password &amp; Security/); assert.match(security.text, /href="\/account\/security"/);
      let flow = await fresh();
      const profile = await owner.client.post('/moderation/settings/profile').set('Accept', 'application/json').set('x-csrf-token', csrf(security.text))
        .send({ version: flow.preferences.version, name: 'Verified Moderation Operator', teamName: 'Actual Moderation Team', bio: 'Recorded customer moderation team', email: 'unauthorized-change@example.com', phone: '+254711111111', country: 'KE', operationalCountries: ['TZ'], role: 'super_admin' }).expect(200);
      const saved = await User.findById(owner.user._id);
      assert.equal(profile.body.version, saved.__v);
      assert.equal(saved.name, 'Verified Moderation Operator'); assert.equal(saved.roleProfile.businessName, 'Actual Moderation Team'); assert.equal(saved.email, owner.user.email); assert.equal(saved.phone, owner.user.phone); assert.equal(saved.country, 'UG'); assert.equal(saved.role, originalRole);
      assert.deepEqual((await User.findById(owner.user._id).select('+operationalCountries')).operationalCountries, ['UG', 'KE']);
      await owner.client.post('/moderation/settings/profile').set('x-csrf-token', csrf(security.text)).send({ version: flow.preferences.version, name: 'Stale change' }).expect(409);
      flow = await fresh(); await saveModerationSettings(scoped(), { ...submission(flow), landingPage: 'moderator-reports' });
      const current = await moderationAccess(scoped()); assert.equal(dashboardLanding(current.actor), '/moderation/reports');
      await assert.rejects(saveModerationSettings(scoped(), { ...submission(await fresh()), landingPage: 'seller-overview' }), error => error.name === 'ZodError');
      flow = await fresh();
      await owner.client.post('/moderation/settings/communication').set('Accept', 'application/json').set('x-csrf-token', csrf(security.text))
        .send({ version: flow.preferences.version, highRiskAlerts: false, escalationAlerts: true }).expect(200);
      const preferences = (await User.findById(owner.user._id)).preferences;
      assert.equal(preferences.moderationHighRiskAlerts, false); assert.equal(preferences.moderationEscalationAlerts, true);
      for (const section of ['profile', 'business', 'payments', 'notifications', 'security']) {
        const page = await owner.client.get('/moderation/settings?section=' + section).expect(200); assert.match(page.text, /data-dashboard-workspace="moderator"/);
        assert.match(page.text, /data-moderation-density="compact"/); assert.match(page.text, /data-moderation-idle-minutes="30"/);
        assert.match(page.text, /\/approved-dashboard\/moderation-preferences\.js/);
        assert.equal((page.text.match(/aria-label="Profile settings sections"/g) || []).length, 1);
        assert.ok(!page.text.includes('role-metric-grid'), 'Moderation settings retain the approved profile layout.'); assert.doesNotMatch(page.text, /hello@classicmart\.example|Stanbic Bank|92%|3 signed-in devices/);
      }
    });
    await t.test('ordinary Moderation alerts honor saved preferences and current market grants without exposing customer conversations', async () => {
      const emit = async kind => {
        const session = await mongoose.startSession();
        try { await session.withTransaction(async () => queueModerationAlert({ country: 'UG', kind, href: '/moderation/risk-cases' }, session)); } finally { await session.endSession(); }
      };
      const before = await Notification.countDocuments({ userId: owner.user._id, type: 'moderation_work' });
      await emit('priority'); assert.equal(await Notification.countDocuments({ userId: owner.user._id, type: 'moderation_work' }), before);
      await emit('escalation'); assert.equal(await Notification.countDocuments({ userId: owner.user._id, type: 'moderation_work' }), before + 1);
      const outsider = await actor('moderator'); await User.updateOne({ _id: outsider.user._id }, { $set: { country: 'TZ', operationalCountries: ['TZ'] } });
      await emit('escalation'); assert.equal(await Notification.countDocuments({ userId: outsider.user._id, type: 'moderation_work' }), 0);
      const record = await Notification.findOne({ userId: owner.user._id, type: 'moderation_work' }).lean();
      assert.equal(record.country, 'UG'); assert.equal(record.href, '/moderation/risk-cases'); assert.doesNotMatch(record.body, /customer email|private message|mfaSecret/i);
      await PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { status: 'suspended' } });
      const current = await Notification.countDocuments({ userId: owner.user._id, type: 'moderation_work' }); await emit('escalation');
      assert.equal(await Notification.countDocuments({ userId: owner.user._id, type: 'moderation_work' }), current);
      await PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { status: 'active' } });
    });
    await t.test('alerts reject unsafe references and roll back with the domain transition', async () => {
      await assert.rejects(queueModerationAlert({ country: 'UG', href: '/moderation/risk-cases' }), error => error.code === 'MODERATION_TRANSACTION_REQUIRED');
      const session = await mongoose.startSession();
      const before = await Notification.countDocuments({ type: 'moderation_work' });
      try {
        for (const href of ['https://evil.invalid/moderation/risk-cases', '/moderation/risk-cases#secret', '/moderation/risk-cases?country=KE', '/moderation/risk-cases?record=public&record=other', '/moderation/risk-cases?search=customer%40example.com', '/moderation/risk-cases?secret=private']) {
          await assert.rejects(session.withTransaction(async () => queueModerationAlert({ country: 'UG', href }, session)), error => error.code === 'MODERATION_ALERT_INVALID');
        }
        await assert.rejects(session.withTransaction(async () => {
          await queueModerationAlert({ country: 'UG', kind: 'escalation', href: '/moderation/risk-cases?record=tcs_public&country=UG' }, session);
          throw new Error('Domain transition rejected');
        }), /Domain transition rejected/);
        await CountrySetting.updateOne({ code: 'UG' }, { $set: { active: false } });
        await assert.rejects(session.withTransaction(async () => queueModerationAlert({ country: 'UG', kind: 'escalation', href: '/moderation/risk-cases' }, session)), error => error.code === 'MODERATION_MARKET_UNAVAILABLE');
      } finally {
        await CountrySetting.updateOne({ code: 'UG' }, { $set: { active: true } });
        await session.endSession();
      }
      assert.equal(await Notification.countDocuments({ type: 'moderation_work' }), before);
    });
    await t.test('work alerts do not notify stale, unverified, unenrolled or foreign-grant recipients', async () => {
      const recipient = await actor('customer', { managed: true });
      const emit = async () => {
        const session = await mongoose.startSession();
        try { await session.withTransaction(async () => queueModerationAlert({ country: 'UG', kind: 'escalation', href: '/moderation/risk-cases' }, session)); }
        finally { await session.endSession(); }
      };
      for (const patch of [{ status: 'suspended' }, { emailVerifiedAt: null }, { onboardingCompletedAt: null }, { 'security.mfaEnabled': false }]) {
        await User.updateOne({ _id: recipient.user._id }, { $set: patch });
        await emit(); assert.equal(await Notification.countDocuments({ userId: recipient.user._id, type: 'moderation_work' }), 0);
        await User.updateOne({ _id: recipient.user._id }, { $set: { status: 'active', emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), 'security.mfaEnabled': true } });
      }
      for (const patch of [{ status: 'revoked' }, { expiresAt: new Date(Date.now() - 1) }, { role: 'finance' }, { operationalCountries: ['KE'] }]) {
        await PlatformGrant.updateOne({ _id: recipient.grant._id }, { $set: patch });
        await emit(); assert.equal(await Notification.countDocuments({ userId: recipient.user._id, type: 'moderation_work' }), 0);
        await PlatformGrant.updateOne({ _id: recipient.grant._id }, { $set: { status: 'active', role: 'moderator', expiresAt: new Date(Date.now() + 86400_000), operationalCountries: ['UG', 'KE'] } });
      }
      await emit(); assert.equal(await Notification.countDocuments({ userId: recipient.user._id, type: 'moderation_work' }), 1);
      assert.equal((await User.findById(recipient.user._id)).role, 'customer', 'Grant recipients never gain an elevated stored compatibility role.');
    });
    await t.test('competing current saves have one winner and audit failure rolls every write back', async () => {
      const flow = await fresh(), body = submission(flow);
      const results = await Promise.allSettled(['UG', 'KE'].map(defaultCountry => saveModerationSettings(scoped(), { ...body, defaultCountry })));
      assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
      assert.equal(results.filter(row => row.status === 'rejected' && row.reason.code === 'MODERATION_SETTINGS_VERSION_CONFLICT').length, 1);
      const before = await User.findById(owner.user._id).lean(), grant = await PlatformGrant.findById(owner.grant._id).lean(), settings = await CountrySetting.find().lean();
      t.mock.method(AuditLog, 'create', async () => { throw new Error('Moderation audit unavailable'); });
      await assert.rejects(saveModerationSettings(scoped(), submission(await fresh())), /Moderation audit unavailable/); t.mock.restoreAll();
      const after = await User.findById(owner.user._id).lean(); assert.deepEqual(after.preferences, before.preferences);
      assert.equal(after.__v, before.__v); assert.equal((await PlatformGrant.findById(owner.grant._id)).__v, grant.__v);
      assert.deepEqual((await CountrySetting.find().lean()).map(row => row.__v), settings.map(row => row.__v));
    });
    await t.test('profile and alert saves also require atomic audit evidence', async () => {
      const before = await User.findById(owner.user._id).lean();
      t.mock.method(AuditLog, 'create', async () => { throw new Error('Profile audit unavailable'); });
      try {
        await assert.rejects(saveModerationProfile(scoped(), { version: before.__v, name: 'Unrecorded operator', teamName: 'Unrecorded team', bio: 'Unrecorded biography' }), /Profile audit unavailable/);
        await assert.rejects(saveModerationCommunication(scoped(), { version: before.__v, highRiskAlerts: true, escalationAlerts: false }), /Profile audit unavailable/);
      } finally { t.mock.restoreAll(); }
      const after = await User.findById(owner.user._id).lean();
      assert.equal(after.name, before.name); assert.deepEqual(after.roleProfile, before.roleProfile);
      assert.deepEqual(after.preferences, before.preferences); assert.equal(after.__v, before.__v);
    });
    await t.test('current MFA, identity, session and grant state protect direct services and country selection', async () => {
      const denied = await actor('customer', { managed: true });
      for (const patch of [{ status: 'suspended' }, { 'security.mfaEnabled': false }, { 'security.tokenVersion': 1 }, { emailVerifiedAt: null }, { onboardingCompletedAt: null }]) {
        await User.updateOne({ _id: denied.user._id }, { $set: patch });
        await assert.rejects(moderationAccess(scoped(denied)), error => error.status === 403);
        await assert.rejects(saveModerationSettings(scoped(denied), { ...submission({ preferences: { version: denied.user.__v } }) }), error => error.status === 403);
        await assert.rejects(saveModerationProfile(scoped(denied), { version: denied.user.__v, name: 'Unauthorized profile change' }), error => error.status === 403);
        await assert.rejects(saveModerationCommunication(scoped(denied), { version: denied.user.__v, highRiskAlerts: false }), error => error.status === 403);
        await User.updateOne({ _id: denied.user._id }, { $set: { status: 'active', 'security.mfaEnabled': true, 'security.tokenVersion': 0, emailVerifiedAt: new Date(), onboardingCompletedAt: new Date() } });
      }
      await PlatformGrant.updateOne({ _id: denied.grant._id }, { $set: { status: 'revoked' } });
      await assert.rejects(moderationAccess(scoped(denied)), error => error.code === 'MODERATION_GRANT_UNAVAILABLE');
      await assert.rejects(saveModerationSettings(scoped(denied), submission({ preferences: { version: denied.user.__v } })), error => error.code === 'MODERATION_GRANT_UNAVAILABLE');
      assert.equal((await User.findById(denied.user._id)).name, denied.user.name);
      for (const role of ['customer', 'seller', 'promoter', 'finance', 'warehouse', 'support', 'country_admin', 'super_admin']) {
        const other = await actor(role); await assert.rejects(loadModerationSettingsPage(scoped(other)), error => error.status === 403);
        if (['country_admin', 'super_admin'].includes(role)) assert.ok(await moderationAccess(scoped(other), { workspace: false, country: 'UG' }));
      }
      await assert.rejects(moderationAccess(scoped(), { write: true }), error => error.code === 'MODERATION_TRANSACTION_REQUIRED');
    });
    await t.test('exports are real scoped CSV and shopping preferences cannot alter operational authorization', async () => {
      await User.updateOne({ _id: owner.user._id }, { $set: { shoppingCountry: 'TZ', currency: 'TZS' } });
      const exportResponse = await owner.client.get('/moderation/settings/export.csv?country=KE').expect(200);
      assert.match(exportResponse.headers['content-type'], /text\/csv/); assert.match(exportResponse.text, /"Reporting calendar","KE","Africa\/Nairobi"/); assert.ok(!exportResponse.text.includes('"UG"')); assert.ok(!exportResponse.text.includes('"TZ"'));
      assert.ok(!exportResponse.text.includes(owner.user.email)); assert.ok(!exportResponse.text.includes(owner.user.phone));
      assert.match(exportResponse.headers['cache-control'], /no-store/); assert.equal(exportResponse.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
      const page = await owner.client.get('/moderation/settings?country=UG').set('Accept', 'application/json').expect(200);
      assert.equal(page.body.context.currency, 'UGX'); assert.equal((await User.findById(owner.user._id)).currency, 'TZS');
      await owner.client.get('/moderation/settings?country=TZ').set('Accept', 'application/json').expect(403);
    });
  } finally {
    t.mock.restoreAll(); for (const transport of transports) transport.destroy();
    await Promise.all(Object.values(mongoose.models).map(Model => Model.init()));
    try { await mongoose.connection.dropDatabase(); } finally { await mongoose.disconnect(); }
  }
});

test('Moderation idle reminder uses real elapsed inactivity, preserves controls and stays outside other workspaces', { timeout: 60_000 }, async () => {
  const asset = fs.readFileSync(new URL('../public/approved-dashboard/moderation-preferences.js', import.meta.url), 'utf8');
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'");
    if (req.url === '/approved-dashboard/moderation-preferences.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(asset); return;
    }
    if (['/approved-dashboard/styles.css', '/approved-dashboard/moderation-live.css'].includes(req.url)) {
      res.writeHead(200, { 'Content-Type': 'text/css' }); res.end(fs.readFileSync(new URL('../public' + req.url, import.meta.url))); return;
    }
    if (req.url === '/account/security') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><h1>Session review fixture</h1>'); return; }
    const role = req.url === '/seller' ? 'seller' : 'moderator';
    const minutes = req.url === '/invalid' ? '999' : '15';
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/approved-dashboard/styles.css"><link rel="stylesheet" href="/approved-dashboard/moderation-live.css"><script defer src="/approved-dashboard/moderation-preferences.js"></script></head><body data-dashboard-workspace="${role}" data-moderation-idle-minutes="${minutes}"><h1>Active workspace</h1><input id="work" aria-label="Work field"><div id="spacer">${'<p>Saved workspace context.</p>'.repeat(200)}</div></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    const executablePath = process.env.CLASSIC_MART_LIVE_TEST_CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
    browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }), failures = [];
    page.on('pageerror', error => failures.push(error.message));
    await page.clock.install({ time: new Date('2026-10-13T06:00:00.000Z') });
    await page.goto(origin + '/moderation'); await page.locator('#work').focus();
    await page.clock.fastForward(14 * 60_000 + 59_000);
    assert.equal(await page.locator('.moderation-idle-reminder').count(), 0);
    await page.clock.fastForward(1_000);
    const notice = page.locator('.moderation-idle-reminder');
    assert.equal(await notice.count(), 1); assert.equal(await notice.getAttribute('role'), 'status'); assert.equal(await notice.getAttribute('aria-live'), 'polite');
    assert.match(await notice.textContent(), /inactive for 15 minutes/);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'work', 'The reminder must not take keyboard focus.');
    assert.equal(new URL(page.url()).pathname, '/moderation', 'Idle reminders must not navigate or log out.');
    await page.keyboard.press('A'); assert.equal(await notice.count(), 0);
    await page.clock.fastForward(14 * 60_000 + 59_000); assert.equal(await notice.count(), 0);
    await page.clock.fastForward(1_000); assert.equal(await notice.count(), 1);
    await notice.getByRole('button', { name: 'Dismiss' }).click(); assert.equal(await notice.count(), 0);
    await page.clock.fastForward(15 * 60_000); assert.equal(await notice.count(), 1);
    await notice.getByRole('link', { name: 'Review sessions' }).focus(); assert.equal(await notice.count(), 1, 'The reminder must keep its focused actions usable.');
    await page.locator('#work').focus(); assert.equal(await notice.count(), 0);
    await page.clock.fastForward(15 * 60_000); assert.equal(await notice.count(), 1);
    await page.locator('#work').click(); assert.equal(await notice.count(), 0);
    await page.clock.fastForward(15 * 60_000); assert.equal(await notice.count(), 1);
    await page.evaluate(() => window.scrollTo(0, 300)); await page.clock.runFor(50); assert.equal(await notice.count(), 0);
    await page.clock.fastForward(15 * 60_000); assert.equal(await notice.count(), 1);
    assert.equal(await notice.getByRole('link', { name: 'Review sessions' }).getAttribute('href'), '/account/security');
    await notice.getByRole('link', { name: 'Review sessions' }).click();
    assert.equal(new URL(page.url()).pathname, '/account/security', 'Activity must preserve the default link activation.');
    assert.deepEqual(failures, []);
    for (const path of ['/seller', '/invalid']) {
      const isolated = await browser.newPage();
      await isolated.clock.install({ time: new Date('2026-10-13T06:00:00.000Z') }); await isolated.goto(origin + path);
      await isolated.clock.fastForward(60 * 60_000); assert.equal(await isolated.locator('.moderation-idle-reminder').count(), 0);
      await isolated.close();
    }
    assert.ok(!seen.some(path => path.includes('logout')));
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});

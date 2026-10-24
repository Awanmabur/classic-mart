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
if (uri) process.env.MONGO_URI = uri;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('Country Admin settings use actual staff identity, devices, grant scope and atomic source alerts', { skip: !uri, timeout: 300_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex'), transports = [];
  await mongoose.connect(uri, { dbName: `classicmart_country_settings_test_${suffix}` });
  try {
    const { createApp } = await import('../src/app.js');
    const { User, PlatformGrant, CountrySetting, AuditLog, Device, Store, Category, Product, PromoterVerification, SellerVerification, Notification, LedgerAccount, LoyaltyAccount } = await import('../src/models/index.js');
    const { hashPassword, hashToken } = await import('../src/core/crypto.js');
    const { decryptSensitive } = await import('../src/core/sensitive.js');
    const { beginMfaEnrollment, confirmMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
    const { countryAdminAccess } = await import('../src/services/country-admin-workspace-access.js');
    const { loadCountryAdminSettingsPage, saveCountryAdminSettings, saveCountryAdminProfile, saveCountryAdminCommunication } = await import('../src/services/country-admin-settings-pages.js');
    const { queueCountryAdminAlert } = await import('../src/services/country-admin-notifications.js');
    const { appealCountryAdminPromoterVerification } = await import('../src/services/country-admin-people-actions.js');
    const { dashboardLanding } = await import('../src/dashboard/landing.js');
    for (const Model of Object.values(mongoose.models)) await Model.init();
    await CountrySetting.create([
      { code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256' },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254' },
      { code: 'TZ', name: 'Unassigned market', currency: 'TZS', locale: 'en-TZ', timeZone: 'Africa/Dar_es_Salaam', phonePrefix: '+255' },
    ]);
    const password = `Country-settings-${suffix}-A1!`, passwordHash = await hashPassword(password), app = createApp(null);
    let sequence = 0;
    const id = prefix => `${prefix}_cs_${suffix}_${++sequence}`;
    async function actor({ role = 'customer', managed = false, countries = ['UG', 'KE'], login = false, mfa = managed } = {}) {
      const number = ++sequence, email = `country-settings-${suffix}-${number}@example.com`, phone = '+25670' + String(number).padStart(7, '0');
      let user = await User.create({ publicId: id('usr'), name: `Country settings ${number}`, email, emailNormalized: email, phone, phoneNormalized: phone,
        passwordHash, role, country: 'UG', currency: 'UGX', operationalCountries: countries,
        emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
        platformAccessManagedAt: managed ? new Date() : undefined, consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const grant = managed ? await PlatformGrant.create({ publicId: id('pgr'), userId: user._id, role: 'country_admin', operationalCountries: countries, status: 'active',
        startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86400_000), reason: 'Isolated Country Admin settings authorization', approvalPublicId: id('apr'), approvedByUserId: new mongoose.Types.ObjectId() }) : null;
      const entry = { user, grant };
      let enrollment;
      if (mfa) {
        enrollment = await beginMfaEnrollment(user._id, password);
        await confirmMfaEnrollment(user._id, totpCode(enrollment.secret, { time: Date.now() - 30_000 }));
        user = await User.findById(user._id).select('+security.mfaSecretEncrypted +security.mfaRecoveryCodeHashes');
        assert.notEqual(user.security.mfaSecretEncrypted, enrollment.secret);
        assert.equal(decryptSensitive(user.security.mfaSecretEncrypted), enrollment.secret);
        assert.equal(user.security.mfaRecoveryCodeHashes.length, 10);
        entry.user = await User.findById(user._id);
      }
      if (login) {
        const transport = new http.Agent({ localAddress: `127.0.0.${40 + transports.length}`, keepAlive: false });
        transports.push(transport);
        entry.client = request.agent(app).use(req => req.agent(transport));
        const form = await entry.client.get('/login').expect(200);
        const primary = await entry.client.post('/login').type('form').send({ email, password, _csrf: csrf(form.text) }).expect(302);
        let authenticated = primary;
        if (mfa) {
          assert.equal(primary.headers.location, '/mfa');
          const challenge = await entry.client.get('/mfa').expect(200);
          authenticated = await entry.client.post('/mfa').type('form').send({ code: totpCode(enrollment.secret), _csrf: csrf(challenge.text) }).expect(302);
        }
        const cookie = authenticated.headers['set-cookie'].find(value => value.startsWith('cm.sid='));
        const signed = decodeURIComponent(cookie.split(';')[0].slice('cm.sid='.length));
        entry.sessionID = signed.slice(2, signed.lastIndexOf('.'));
        entry.device = await Device.findOne({ userId: user._id, revokedAt: null }).select('+sessionHash');
        assert.ok(entry.device); assert.equal(entry.device.sessionHash, hashToken(entry.sessionID));
        entry.user = await User.findById(user._id);
      }
      return entry;
    }
    const owner = await actor({ managed: true, login: true });
    await User.updateOne({ _id: owner.user._id }, { $set: { 'preferences.financeReportingPeriod': 'year', 'preferences.supportDefaultQueue': 'returns' } });
    const scoped = (entry = owner, query = {}) => ({ id: id('req'), ip: '127.0.0.1', get: () => 'CountryAdminSettingsLive/1.0', user: entry.user,
      session: { userId: String(entry.user._id), tokenVersion: entry.user.security.tokenVersion }, ...(entry.sessionID ? { sessionID: entry.sessionID, device: entry.device } : {}), query });
    const fresh = () => loadCountryAdminSettingsPage(scoped());
    const submission = flow => ({ version: flow.preferences.version, defaultCountry: 'UG', reportingPeriod: '7months', landingPage: 'admin-overview', density: 'compact', idleReminderMinutes: 30 });

    await t.test('settings return only authorized markets and real sessions with private operational response headers', async () => {
      const response = await owner.client.get('/admin/settings').set('Accept', 'application/json').expect(200);
      assert.equal(response.body.context.country, ''); assert.equal(response.body.context.currency, null);
      assert.deepEqual(response.body.context.countries.map(row => row.code).sort(), ['KE', 'UG']);
      assert.equal(response.body.page.total, 6); assert.equal(response.body.security.activeSessions, 1);
      assert.equal(response.body.security.mfaEnabled, true); assert.equal(response.body.landingOptions.length, 17);
      assert.ok(response.body.landingOptions.some(option => option.id === 'admin-order-cases'), 'Order-case navigation is a real saved landing option.');
      assert.ok(!JSON.stringify(response.body).includes('Unassigned market'));
      assert.doesNotMatch(JSON.stringify(response.body), /mfaSecret|mfaRecoveryCode|sessionHash|passwordHash/);
      assert.match(response.headers['cache-control'], /no-store/);
      assert.equal(response.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
      assert.equal((await User.findById(owner.user._id)).role, 'customer');
      assert.equal(await Store.countDocuments(), 0); assert.equal(await LedgerAccount.countDocuments(), 0); assert.equal(await LoyaltyAccount.countDocuments(), 0);
    });
    await t.test('saving workspace defaults needs CSRF and cannot change policy, account identity or another workspace', async () => {
      const page = await owner.client.get('/admin/settings').expect(200), flow = await fresh();
      await owner.client.post('/admin/settings').set('Accept', 'application/json').send(submission(flow)).expect(403);
      await owner.client.post('/admin/settings').set('Accept', 'application/json').set('x-csrf-token', csrf(page.text)).send({ ...submission(flow), role: 'super_admin', currency: 'TZS', platformFeeBps: 0 }).expect(422);
      const beforeMarkets = await CountrySetting.find().sort({ code: 1 }).lean();
      await owner.client.post('/admin/settings').type('form').send({ ...submission(flow), _csrf: csrf(page.text) }).expect(303).expect('location', '/admin/settings?section=business');
      const saved = await User.findById(owner.user._id);
      assert.equal(saved.preferences.countryAdminDefaultCountry, 'UG'); assert.equal(saved.preferences.countryAdminReportingPeriod, '7months');
      assert.equal(saved.preferences.countryAdminDensity, 'compact'); assert.equal(saved.preferences.countryAdminIdleReminderMinutes, 30);
      assert.equal(saved.preferences.financeReportingPeriod, 'year'); assert.equal(saved.preferences.supportDefaultQueue, 'returns');
      assert.equal(saved.role, 'customer'); assert.equal(saved.currency, 'UGX');
      assert.deepEqual((await CountrySetting.find().sort({ code: 1 })).map(row => [row.code, row.currency, row.platformFeeBps]), beforeMarkets.map(row => [row.code, row.currency, row.platformFeeBps]));
      assert.equal((await countryAdminAccess(scoped())).country, 'UG');
      assert.equal(await AuditLog.countDocuments({ action: 'country_admin.preferences_saved', actorId: owner.user._id }), 1);
    });
    await t.test('stale revisions, foreign countries, unsupported values and duplicate filters fail without persisted changes', async () => {
      const flow = await fresh(), valid = submission(flow), before = await User.findById(owner.user._id).lean();
      await assert.rejects(saveCountryAdminSettings(scoped(), { ...valid, defaultCountry: 'TZ' }), error => error.code === 'COUNTRY_ADMIN_COUNTRY_FORBIDDEN');
      for (const patch of [{ reportingPeriod: 'forever' }, { density: 'tight' }, { idleReminderMinutes: 5 }, { idleReminderMinutes: [15] }, { landingPage: 'seller-overview' }, { defaultCountry: ['UG'] }, { version: '' }]) {
        await assert.rejects(saveCountryAdminSettings(scoped(), { ...valid, ...patch }), error => error.name === 'ZodError');
      }
      await assert.rejects(saveCountryAdminSettings(scoped(), { version: valid.version }), error => error.code === 'COUNTRY_ADMIN_SETTINGS_EMPTY');
      assert.deepEqual((await User.findById(owner.user._id).lean()).preferences, before.preferences);
      await saveCountryAdminSettings(scoped(), valid);
      await assert.rejects(saveCountryAdminSettings(scoped(), valid), error => error.code === 'COUNTRY_ADMIN_SETTINGS_VERSION_CONFLICT');
      await owner.client.get('/admin/settings?country=UG&country=KE').set('Accept', 'application/json').expect(422);
      await owner.client.get('/admin/settings?country[bad]=UG').set('Accept', 'application/json').expect(422);
    });
    await t.test('profile changes use actual optimistic versions and reject protected contact or privilege fields', async () => {
      const page = await owner.client.get('/admin/settings').expect(200), flow = await fresh();
      for (const forbidden of [{ email: 'changed@example.com' }, { phone: '+254711111111' }, { role: 'super_admin' }, { operationalCountries: ['TZ'] }, { 'security.mfaEnabled': false }]) {
        const unsafePath = Object.keys(forbidden).some(key => key.includes('.'));
        const denied = await owner.client.post('/admin/settings/profile').set('Accept', 'application/json').set('x-csrf-token', csrf(page.text)).send({ version: flow.preferences.version, name: 'Authorized Country Operator', ...forbidden }).expect(unsafePath ? 400 : 422);
        if (unsafePath) assert.equal(denied.body.error.code, 'UNSAFE_INPUT_KEY');
      }
      const profile = await owner.client.post('/admin/settings/profile').set('Accept', 'application/json').set('x-csrf-token', csrf(page.text))
        .send({ version: flow.preferences.version, name: 'Verified Country Operator', teamName: 'Recorded country operations', bio: 'Recorded public administrator profile.' }).expect(200);
      const saved = await User.findById(owner.user._id);
      assert.equal(profile.body.version, saved.__v); assert.equal(saved.name, 'Verified Country Operator'); assert.equal(saved.roleProfile.businessName, 'Recorded country operations');
      assert.equal(saved.roleProfile.bio, 'Recorded public administrator profile.'); assert.equal(saved.email, owner.user.email); assert.equal(saved.phone, owner.user.phone); assert.equal(saved.country, 'UG'); assert.equal(saved.role, 'customer');
      await owner.client.post('/admin/settings/profile').set('Accept', 'application/json').set('x-csrf-token', csrf(page.text)).send({ version: flow.preferences.version, name: 'Stale profile' }).expect(409);
      const current = await fresh(); await saveCountryAdminSettings(scoped(), { ...submission(current), landingPage: 'admin-reports' });
      assert.equal(dashboardLanding((await countryAdminAccess(scoped())).actor), '/admin/reports');
    });
    await t.test('all five approved settings sections render working forms and real account security controls', async () => {
      for (const section of ['profile', 'business', 'payments', 'notifications', 'security']) {
        const page = await owner.client.get('/admin/settings?section=' + section).expect(200);
        assert.match(page.text, /data-dashboard-workspace="admin"/); assert.match(page.text, /data-country-admin-density="compact"/);
        assert.match(page.text, /data-country-admin-idle-minutes="30"/); assert.match(page.text, /\/approved-dashboard\/country-admin-live\.js/);
        assert.equal((page.text.match(/aria-label="Profile settings sections"/g) || []).length, 1);
        assert.ok(!page.text.includes('role-metric-grid')); assert.doesNotMatch(page.text, /hello@classicmart\.example|Stanbic Bank|92%|3 signed-in devices|weekly report/i);
        assert.match(page.text, new RegExp(`data-role-settings-panel="${section}"`));
        if (section === 'security') { assert.match(page.text, /href="\/account\/security"/); assert.match(page.text, /1 signed-in devices/); }
      }
      await owner.client.get('/admin/settings?section=unknown').set('Accept', 'application/json').expect(422);
    });
    await t.test('communication saves honor unchecked controls and cannot enable pretend email reports', async () => {
      const page = await owner.client.get('/admin/settings?section=notifications').expect(200), flow = await fresh();
      await owner.client.post('/admin/settings/communication').set('Accept', 'application/json').set('x-csrf-token', csrf(page.text))
        .send({ version: flow.preferences.version, highRiskAlerts: false, escalationAlerts: true }).expect(200);
      const preferences = (await User.findById(owner.user._id)).preferences;
      assert.equal(preferences.countryAdminHighRiskAlerts, false); assert.equal(preferences.countryAdminEscalationAlerts, true);
      await assert.rejects(saveCountryAdminCommunication(scoped(), { version: (await fresh()).preferences.version, weeklyReport: true }), error => error.code === 'COUNTRY_ADMIN_SETTINGS_FIELD_FORBIDDEN');
      await assert.rejects(saveCountryAdminCommunication(scoped(), { version: (await fresh()).preferences.version, highRiskAlerts: 'sometimes' }), error => error.name === 'ZodError');
      for (const country of ['', 'KE']) {
        await owner.client.post('/admin/settings/communication?country=' + country).type('form')
          .send({ version: (await fresh()).preferences.version, escalationAlerts: 'on', _csrf: csrf(page.text) })
          .expect(303).expect('location', '/admin/settings?section=notifications&country=' + country);
        const current = await owner.client.get('/admin/settings?section=notifications&country=' + country).set('Accept', 'application/json').expect(200);
        assert.equal(current.body.context.country, country);
      }
    });

    const seller = await actor({ role: 'seller' });
    const sourceStore = await Store.create({ publicId: id('str'), ownerUserId: seller.user._id, name: 'Actual source store', slug: id('store'), country: 'UG', currency: 'UGX', status: 'verified' });
    const category = await Category.create({ publicId: id('cat'), name: 'Restricted recorded source', slug: id('category'), countries: ['UG'], restricted: true });
    const product = await Product.create({ publicId: id('prd'), storeId: sourceStore._id, ownerUserId: seller.user._id, categoryId: category._id,
      title: 'Genuine source priority product', slug: id('product'), description: 'Recorded product submitted for independent review.', status: 'submitted', countries: ['UG'], moderation: { submittedAt: new Date(), riskLevel: 'high', secondReviewRequired: true } });
    const emit = async (options = {}) => {
      const session = await mongoose.startSession();
      try { let result; await session.withTransaction(async () => { result = await queueCountryAdminAlert({ country: 'UG', sourceType: 'product', sourcePublicId: product.publicId, ...options }, session); }); return result; }
      finally { await session.endSession(); }
    };
    await t.test('priority alerts depend on genuine source facts and the saved preference, never caller-supplied links', async () => {
      const count = await Notification.countDocuments({ userId: owner.user._id, type: 'country_admin_work' });
      await emit(); assert.equal(await Notification.countDocuments({ userId: owner.user._id, type: 'country_admin_work' }), count);
      await saveCountryAdminCommunication(scoped(), { version: (await fresh()).preferences.version, highRiskAlerts: true, escalationAlerts: true });
      await emit(); assert.equal(await Notification.countDocuments({ userId: owner.user._id, type: 'country_admin_work' }), count + 1);
      const alert = await Notification.findOne({ userId: owner.user._id, type: 'country_admin_work' }).lean();
      assert.equal(alert.country, 'UG'); assert.equal(alert.href, '/admin/products?' + new URLSearchParams({ record: product.publicId, country: 'UG' }));
      assert.doesNotMatch(alert.body, /customer email|private message|mfaSecret/i);
      assert.equal((await fresh()).unreadAlerts, count + 1);
      await emit({ sourcePublicId: id('missing') }); await emit({ country: 'KE' }); await emit({ kind: 'escalation' });
      assert.equal(await Notification.countDocuments({ userId: owner.user._id, type: 'country_admin_work' }), count + 1);
      await Product.updateOne({ _id: product._id }, { $set: { status: 'published' } }); await emit();
      assert.equal(await Notification.countDocuments({ userId: owner.user._id, type: 'country_admin_work' }), count + 1);
      await Product.updateOne({ _id: product._id }, { $set: { status: 'submitted' } });
    });
    await t.test('seller and promoter escalation alerts refer to persisted owner appeals in the actual source country', async () => {
      const applicant = await actor({ role: 'seller' }), pending = await Store.create({ publicId: id('str'), ownerUserId: applicant.user._id, name: 'Recorded applicant', slug: id('store'), country: 'UG', currency: 'UGX', status: 'pending_verification' });
      const verification = await SellerVerification.create({ publicId: id('kyc'), storeId: pending._id, userId: applicant.user._id, sellerType: 'business', legalName: 'Recorded applicant', status: 'appealed', submittedAt: new Date(), declarationAcceptedAt: new Date(), appeal: { message: 'Recorded owner appeal for independent review.', submittedAt: new Date() } });
      const before = await Notification.countDocuments({ userId: owner.user._id, type: 'country_admin_work' });
      await emit({ kind: 'escalation', sourceType: 'seller_verification', sourcePublicId: verification.publicId });
      assert.equal(await Notification.countDocuments({ userId: owner.user._id, type: 'country_admin_work' }), before + 1);
      const promoter = await actor({ role: 'promoter' });
      const promoterVerification = await PromoterVerification.create({ publicId: id('prv'), userId: promoter.user._id, country: 'UG', status: 'rejected', channels: ['https://example.com/actual-channel'], niches: ['Household'], audienceSize: 1200,
        disclosureAcceptedAt: new Date(), submittedAt: new Date(), reviewedAt: new Date(), reviewedByUserId: owner.user._id, reason: 'Provide evidence supporting the recorded programme channels.' });
      const appealRequest = scoped(promoter); appealRequest.body = { version: promoterVerification.__v, message: 'The recorded programme source now supports this independent appeal.' };
      await appealCountryAdminPromoterVerification(appealRequest);
      const saved = await PromoterVerification.findById(promoterVerification._id);
      assert.equal(saved.status, 'appealed'); assert.equal(String(saved.appeal.originalReviewerUserId), String(owner.user._id));
      assert.equal(await Notification.countDocuments({ userId: owner.user._id, type: 'country_admin_work' }), before + 2);
      assert.equal(await AuditLog.countDocuments({ action: 'promoter.verification_appealed', targetPublicId: promoterVerification.publicId }), 1);
      assert.equal((await User.findById(promoter.user._id)).role, 'promoter');
    });
    await t.test('source transitions and work alerts roll back together when notification persistence fails', async () => {
      const promoter = await actor({ role: 'promoter' });
      const source = await PromoterVerification.create({ publicId: id('prv'), userId: promoter.user._id, country: 'UG', status: 'rejected', channels: ['https://example.com/another-channel'], niches: ['Household'],
        audienceSize: 1400, disclosureAcceptedAt: new Date(), submittedAt: new Date(), reviewedAt: new Date(), reviewedByUserId: owner.user._id, reason: 'Independent source review required.' });
      const before = await User.findById(promoter.user._id), market = await CountrySetting.findOne({ code: 'UG' }), count = await Notification.countDocuments(), auditCount = await AuditLog.countDocuments();
      const originalCreate = Notification.create;
      Notification.create = function (documents, ...args) {
        if ((Array.isArray(documents) ? documents : [documents]).some(row => row.type === 'country_admin_work')) throw new Error('Injected Country Admin notification failure');
        return originalCreate.call(this, documents, ...args);
      };
      try {
        const appealRequest = scoped(promoter); appealRequest.body = { version: source.__v, message: 'An actual appeal must remain atomic with its source and notifications.' };
        await assert.rejects(appealCountryAdminPromoterVerification(appealRequest), /Injected Country Admin notification failure/);
      } finally { Notification.create = originalCreate; }
      assert.equal((await PromoterVerification.findById(source._id)).status, 'rejected');
      assert.equal((await User.findById(promoter.user._id)).__v, before.__v); assert.equal((await CountrySetting.findOne({ code: 'UG' })).__v, market.__v);
      assert.equal(await Notification.countDocuments(), count); assert.equal(await AuditLog.countDocuments(), auditCount);
    });
    await t.test('alerts exclude unverified or revoked recipients and the grant index rejects ambiguous authority', async () => {
      const recipient = await actor({ managed: true });
      const excluded = async () => { await emit(); assert.equal(await Notification.countDocuments({ userId: recipient.user._id, type: 'country_admin_work' }), 0); };
      for (const patch of [{ status: 'suspended' }, { emailVerifiedAt: null }, { phoneVerifiedAt: null }, { onboardingCompletedAt: null }, { 'security.mfaEnabled': false }]) {
        await User.updateOne({ _id: recipient.user._id }, { $set: patch }); await excluded();
        await User.updateOne({ _id: recipient.user._id }, { $set: { status: 'active', emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), onboardingCompletedAt: new Date(), 'security.mfaEnabled': true } });
      }
      for (const patch of [{ status: 'revoked' }, { expiresAt: new Date(Date.now() - 1) }, { role: 'finance' }, { operationalCountries: ['KE'] }]) {
        await PlatformGrant.updateOne({ _id: recipient.grant._id }, { $set: patch }); await excluded();
        await PlatformGrant.updateOne({ _id: recipient.grant._id }, { $set: { status: 'active', role: 'country_admin', expiresAt: new Date(Date.now() + 86400_000), operationalCountries: ['UG', 'KE'] } });
      }
      await assert.rejects(PlatformGrant.create({ publicId: id('pgr'), userId: recipient.user._id, role: 'finance', operationalCountries: ['UG'], status: 'active', startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86400_000), reason: 'Ambiguous authority negative fixture', approvalPublicId: id('apr'), approvedByUserId: new mongoose.Types.ObjectId() }), error => error.code === 11000);
      assert.equal(await PlatformGrant.countDocuments({ userId: recipient.user._id, status: 'active' }), 1);
      assert.equal((await PlatformGrant.findById(recipient.grant._id)).role, 'country_admin');
      await emit(); assert.equal(await Notification.countDocuments({ userId: recipient.user._id, type: 'country_admin_work' }), 1);
      assert.equal((await User.findById(recipient.user._id)).role, 'customer');
    });
    await t.test('alerts cannot commit outside their source transaction or accept unsafe source references', async () => {
      await assert.rejects(queueCountryAdminAlert({ country: 'UG', sourceType: 'product', sourcePublicId: product.publicId }), error => error.code === 'COUNTRY_ADMIN_TRANSACTION_REQUIRED');
      for (const patch of [{ sourceType: 'unknown' }, { sourceType: 'toString' }, { sourcePublicId: 'https://evil.invalid/source' }, { sourcePublicId: [product.publicId] }, { country: 'UG&country=TZ' }, { country: ['UG'] }, { kind: 'weekly' }]) {
        await assert.rejects(emit(patch), error => error.code === 'COUNTRY_ADMIN_ALERT_INVALID');
      }
      const count = await Notification.countDocuments({ type: 'country_admin_work' }), sourceVersion = (await Product.findById(product._id)).__v, session = await mongoose.startSession();
      try {
        await assert.rejects(session.withTransaction(async () => {
          await queueCountryAdminAlert({ country: 'UG', kind: 'priority', sourceType: 'product', sourcePublicId: product.publicId }, session);
          throw new Error('Recorded source transition aborted');
        }), /Recorded source transition aborted/);
      } finally { await session.endSession(); }
      assert.equal(await Notification.countDocuments({ type: 'country_admin_work' }), count); assert.equal((await Product.findById(product._id)).__v, sourceVersion);
      await CountrySetting.updateOne({ code: 'UG' }, { $set: { active: false } });
      try { assert.equal(await emit(), 0); } finally { await CountrySetting.updateOne({ code: 'UG' }, { $set: { active: true } }); }
    });
    await t.test('competing settings revisions have one winner and audit failure restores all authorization fences', async () => {
      const body = submission(await fresh());
      const results = await Promise.allSettled(['UG', 'KE'].map(defaultCountry => saveCountryAdminSettings(scoped(), { ...body, defaultCountry })));
      assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
      assert.equal(results.filter(row => row.status === 'rejected' && row.reason.code === 'COUNTRY_ADMIN_SETTINGS_VERSION_CONFLICT').length, 1);
      const before = await User.findById(owner.user._id).lean(), grant = await PlatformGrant.findById(owner.grant._id), device = await Device.findById(owner.device._id), markets = await CountrySetting.find().sort({ code: 1 });
      const originalCreate = AuditLog.create;
      AuditLog.create = async () => { throw new Error('Injected Country Admin settings audit failure'); };
      try {
        await assert.rejects(saveCountryAdminSettings(scoped(), submission(await fresh())), /Injected Country Admin settings audit failure/);
        await assert.rejects(saveCountryAdminProfile(scoped(), { version: (await fresh()).preferences.version, name: 'Must not survive rollback' }), /Injected Country Admin settings audit failure/);
        await assert.rejects(saveCountryAdminCommunication(scoped(), { version: (await fresh()).preferences.version, highRiskAlerts: false }), /Injected Country Admin settings audit failure/);
      } finally { AuditLog.create = originalCreate; }
      const after = await User.findById(owner.user._id).lean();
      assert.deepEqual(after.preferences, before.preferences); assert.equal(after.name, before.name); assert.equal(after.__v, before.__v);
      assert.equal((await PlatformGrant.findById(owner.grant._id)).__v, grant.__v); assert.equal((await Device.findById(owner.device._id)).__v, device.__v);
      assert.deepEqual((await CountrySetting.find().sort({ code: 1 })).map(row => row.__v), markets.map(row => row.__v));
    });
    await t.test('CSV reflects assigned market calendars and audits export without exposing account contacts', async () => {
      await User.updateOne({ _id: owner.user._id }, { $set: { shoppingCountry: 'TZ', currency: 'TZS' } });
      const response = await owner.client.get('/admin/settings/export.csv?country=KE').expect(200);
      assert.match(response.headers['content-type'], /text\/csv/); assert.match(response.text, /"Reporting calendar","KE","Africa\/Nairobi"/);
      assert.ok(!response.text.includes('"UG"')); assert.ok(!response.text.includes('"TZ"'));
      assert.ok(!response.text.includes(owner.user.email)); assert.ok(!response.text.includes(owner.user.phone));
      assert.match(response.headers['cache-control'], /no-store/); assert.equal(response.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
      assert.equal(await AuditLog.countDocuments({ action: 'country_admin.settings_exported', actorId: owner.user._id }), 1);
      const page = await owner.client.get('/admin/settings?country=UG').set('Accept', 'application/json').expect(200);
      assert.equal(page.body.context.currency, 'UGX'); assert.equal((await User.findById(owner.user._id)).currency, 'TZS');
      await owner.client.get('/admin/settings?country=TZ').set('Accept', 'application/json').expect(403);
    });
    await t.test('settings and saves reject every different primary workspace including unrestricted Super Admin', async () => {
      for (const role of ['customer', 'business', 'seller', 'promoter', 'delivery', 'warehouse', 'support', 'moderator', 'finance', 'country_admin', 'super_admin']) {
        const other = await actor({ role });
        await assert.rejects(loadCountryAdminSettingsPage(scoped(other)), error => error.status === 403);
        await assert.rejects(saveCountryAdminSettings(scoped(other), { ...submission({ preferences: { version: other.user.__v } }) }), error => error.status === 403);
      }
      const changed = await actor({ managed: true });
      await PlatformGrant.updateOne({ _id: changed.grant._id }, { $set: { role: 'finance' } });
      await assert.rejects(loadCountryAdminSettingsPage(scoped(changed)), error => error.status === 403);
      await assert.rejects(saveCountryAdminProfile(scoped(changed), { version: changed.user.__v, name: 'Wrong workspace profile' }), error => error.status === 403);
    });
    await t.test('fresh identity, grant, token and Device state remain mandatory throughout settings work', async () => {
      const denied = await actor({ managed: true });
      for (const patch of [{ status: 'suspended' }, { emailVerifiedAt: null }, { phoneVerifiedAt: null }, { onboardingCompletedAt: null }, { 'security.mfaEnabled': false }, { 'security.tokenVersion': denied.user.security.tokenVersion + 1 }]) {
        await User.updateOne({ _id: denied.user._id }, { $set: patch });
        await assert.rejects(loadCountryAdminSettingsPage(scoped(denied)), error => error.status === 403);
        await assert.rejects(saveCountryAdminProfile(scoped(denied), { version: denied.user.__v, name: 'Unauthorized profile' }), error => error.status === 403);
        await User.updateOne({ _id: denied.user._id }, { $set: { status: 'active', emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), onboardingCompletedAt: new Date(), 'security.mfaEnabled': true, 'security.tokenVersion': denied.user.security.tokenVersion } });
      }
      await PlatformGrant.updateOne({ _id: denied.grant._id }, { $set: { status: 'revoked' } });
      await assert.rejects(loadCountryAdminSettingsPage(scoped(denied)), error => error.code === 'COUNTRY_ADMIN_GRANT_UNAVAILABLE');
      const current = await fresh();
      await Device.updateOne({ _id: owner.device._id }, { $set: { revokedAt: new Date() } });
      await assert.rejects(loadCountryAdminSettingsPage(scoped()), error => error.code === 'ACCOUNT_UNAVAILABLE');
      await assert.rejects(saveCountryAdminSettings(scoped(), submission(current)), error => error.code === 'ACCOUNT_UNAVAILABLE');
      await Device.updateOne({ _id: owner.device._id }, { $set: { revokedAt: null } });
      await assert.rejects(countryAdminAccess(scoped(), { write: true }), error => error.code === 'COUNTRY_ADMIN_TRANSACTION_REQUIRED');
    });
  } finally {
    for (const transport of transports) transport.destroy();
    try { for (const Model of Object.values(mongoose.models)) await Model.init(); await mongoose.connection.dropDatabase(); }
    finally { await mongoose.disconnect(); }
  }
});

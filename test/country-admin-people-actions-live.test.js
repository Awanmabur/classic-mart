import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';

const suffix = crypto.randomBytes(8).toString('hex');
process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
for (const key of ['SESSION_SECRET', 'TOKEN_PEPPER', 'SECURITY_INTEGRITY_KEY', 'DATA_ENCRYPTION_KEY']) process.env[key] = crypto.randomBytes(32).toString('hex');
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;
const csrf = html => {
  const match = html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/);
  assert.ok(match, 'The real authenticated page provides CSRF.');
  return match[1];
};

test('Country Admin promoter review, genuine independent owner appeals and customer sessions use current authoritative sources', { skip: !uri, timeout: 240_000 }, async t => {
  const parsed = new URL(uri);
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.port, '27019');
  assert.match(parsed.pathname, /verification|test/i);
  await mongoose.connect(uri, { dbName: `classicmart_country_people_test_${suffix}` });
  const transports = [];
  try {
    const { createApp } = await import('../src/app.js');
    const { User, PlatformGrant, CountrySetting, PromoterVerification, Device, MobileSession, AuditLog, Notification, StoreMember } = await import('../src/models/index.js');
    const { hashPassword, hashToken } = await import('../src/core/crypto.js');
    const { beginMfaEnrollment, confirmMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
    const people = await import('../src/services/country-admin-people-actions.js');
    const { secureSubmitPromoterVerification } = await import('../src/services/promoter-campaign-pages.js');
    const { reviewPromoterVerification } = await import('../src/services/promoters.js');
    await Promise.all(Object.values(mongoose.models).map(Model => Model.init()));
    await CountrySetting.create([
      { code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254', active: true },
      { code: 'TZ', name: 'Unassigned market', currency: 'TZS', locale: 'en-TZ', timeZone: 'Africa/Dar_es_Salaam', phonePrefix: '+255', active: true },
    ]);
    const app = createApp(null), password = `Country-People-${suffix}-A1!`, passwordHash = await hashPassword(password);
    let sequence = 0, requestSequence = 0;
    async function actor({ role = 'customer', grantRole = null, countries = ['UG'], country = 'UG', shoppingCountry = 'TZ', mfa = Boolean(grantRole) } = {}) {
      const index = ++sequence, email = `country-people-${suffix}-${index}@example.com`, phone = '+25670' + String(index).padStart(7, '0');
      let user = await User.create({ publicId: `usr_cpeople_${suffix}_${index}`, name: `Country People ${index}`, email, emailNormalized: email,
        phone, phoneNormalized: phone, passwordHash, role, country, shoppingCountry,
        platformAccessManagedAt: grantRole ? new Date() : undefined, operationalCountries: ['TZ'],
        emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
        consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const grant = grantRole ? await PlatformGrant.create({ publicId: `pgr_cpeople_${suffix}_${index}`, userId: user._id, role: grantRole,
        operationalCountries: countries, status: 'active', startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000),
        reason: 'Genuine isolated Country Admin people validation.', approvalPublicId: `apr_cpeople_${suffix}_${index}`, approvedByUserId: new mongoose.Types.ObjectId() }) : null;
      let secret;
      if (mfa) {
        secret = (await beginMfaEnrollment(user._id, password)).secret;
        await confirmMfaEnrollment(user._id, totpCode(secret, { time: Date.now() - 30_000 }));
        const enrolled = await User.findById(user._id).select('+security.mfaSecretEncrypted');
        assert.ok(enrolled.security.mfaEnabled); assert.match(enrolled.security.mfaSecretEncrypted, /^v1:/);
      }
      const transport = new http.Agent({ localAddress: `127.0.0.${index + 60}`, keepAlive: false }); transports.push(transport);
      const agent = request.agent(app).use(req => req.agent(transport)), page = await agent.get('/login').expect(200);
      let signedIn = await agent.post('/login').type('form').send({ email, password, _csrf: csrf(page.text) }).expect(302);
      if (mfa) {
        assert.equal(signedIn.headers.location, '/mfa');
        const challenge = await agent.get('/mfa').expect(200);
        signedIn = await agent.post('/mfa').type('form').send({ code: totpCode(secret), _csrf: csrf(challenge.text) }).expect(302);
      }
      const cookie = (signedIn.headers['set-cookie'] || []).find(value => value.startsWith('cm.sid='));
      assert.ok(cookie);
      const signedCookie = decodeURIComponent(cookie.split(';')[0].slice('cm.sid='.length));
      const sessionID = signedCookie.slice(2, signedCookie.lastIndexOf('.'));
      const device = await Device.findOne({ userId: user._id, revokedAt: null }).select('+sessionHash');
      assert.ok(device); assert.equal(device.sessionHash, hashToken(sessionID));
      user = await User.findById(user._id);
      return { user, grant, agent, sessionID, device };
    }
    async function core(entry, { publicId, body = {}, country } = {}) {
      const user = await User.findById(entry.user._id);
      return { id: `req_cpeople_${suffix}_${++requestSequence}`, user, sessionID: entry.sessionID, device: entry.device,
        session: { userId: String(user._id), tokenVersion: user.security.tokenVersion }, query: country === undefined ? {} : { country },
        params: publicId ? { publicId } : {}, body, ip: '127.0.0.61', get: () => 'CountryPeopleLive/1.0' };
    }
    async function promoter(entry, country = 'UG', state = 'submitted') {
      return PromoterVerification.create({ publicId: `prv_cpeople_${suffix}_${++sequence}`, userId: entry.user._id, country, status: state,
        channels: ['Instagram', 'WhatsApp'], niches: ['Technology'], audienceSize: 430, audienceLocation: 'Kampala',
        disclosureAcceptedAt: new Date(), submittedAt: new Date() });
    }
    async function action(entry, row, mode, extra = {}) {
      const current = await PromoterVerification.findById(row._id);
      return people.actCountryAdminPromoter(await core(entry, { publicId: current.publicId, body: { version: current.__v, ...extra } }), mode);
    }
    const admin = await actor({ grantRole: 'country_admin' }), contender = await actor({ grantRole: 'country_admin' });
    const foreign = await actor({ grantRole: 'country_admin', countries: ['KE'] });
    const superAdmin = await actor({ grantRole: 'super_admin', countries: ['*'] });
    const owner = await actor({ role: 'promoter', country: 'KE' }), customer = await actor();
    const verification = await promoter(owner);

    await t.test('safe detail and scope use actual programme and home sources, with no invented documents or hidden auth data', async () => {
      const detail = await people.loadCountryAdminPromoterDetail(await core(admin), verification.publicId);
      assert.equal(detail.record.country, 'UG'); assert.equal(detail.record.name, owner.user.name);
      assert.deepEqual(detail.record.channels, ['Instagram', 'WhatsApp']); assert.deepEqual(detail.record.documents, []);
      assert.ok(detail.record.emailVerified); assert.ok(detail.record.phoneVerified);
      const json = JSON.stringify(detail);
      for (const forbidden of ['passwordHash', 'security', 'tokenVersion', 'sessionHash', 'storageKey', String(owner.user._id), owner.user.email, owner.user.phone]) assert.ok(!json.includes(forbidden), forbidden);
      await assert.rejects(people.loadCountryAdminPromoterDetail(await core(foreign), verification.publicId), error => error.status === 404);
      await assert.rejects(people.loadCountryAdminPromoterDetail(await core(admin, { country: 'KE' }), verification.publicId), error => [403, 404].includes(error.status));
      await assert.rejects(people.loadCountryAdminPromoterDetail(await core(superAdmin), verification.publicId), error => error.code === 'COUNTRY_ADMIN_WORKSPACE_FORBIDDEN');
      const customers = await people.loadCountryAdminCustomerDetail(await core(admin), customer.user.publicId);
      assert.equal(customers.record.country, 'UG'); assert.equal(customer.user.shoppingCountry, 'TZ');
      const managedCustomer = await actor({ grantRole: 'support' });
      await assert.rejects(people.loadCountryAdminCustomerDetail(await core(admin), managedCustomer.user.publicId), error => error.status === 404);
      const disguisedStaff = await actor();
      await StoreMember.create({ publicId: `stm_cpeople_${suffix}`, storeId: new mongoose.Types.ObjectId(), userId: disguisedStaff.user._id,
        role: 'admin', status: 'active', invitedByUserId: admin.user._id });
      await assert.rejects(people.loadCountryAdminCustomerDetail(await core(admin), disguisedStaff.user.publicId), error => error.status === 404);
    });

    await t.test('claims have one winner, stale requests fail, release requires ownership and audit gates decisions atomically', async () => {
      const requests = await Promise.all(Array.from({ length: 6 }, (_, index) => core(index % 2 ? admin : contender,
        { publicId: verification.publicId, body: { version: verification.__v } })));
      const claims = await Promise.allSettled(requests.map(req => people.actCountryAdminPromoter(req, 'claim')));
      assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1);
      const claimed = await PromoterVerification.findById(verification._id);
      assert.equal(claimed.reviewHistory.filter(entry => entry.action === 'claim').length, 1);
      const winner = String(claimed.assignedUserId) === String(admin.user._id) ? admin : contender;
      const loser = winner === admin ? contender : admin;
      await assert.rejects(people.actCountryAdminPromoter(await core(winner, { publicId: claimed.publicId, body: { version: verification.__v } }), 'release'),
        error => error.code === 'COUNTRY_ADMIN_PEOPLE_VERSION_CONFLICT');
      await assert.rejects(action(loser, claimed, 'release'), error => error.code === 'COUNTRY_ADMIN_PROMOTER_CLAIM_REQUIRED');
      const beforeAudit = await AuditLog.countDocuments({ targetPublicId: claimed.publicId }), beforeNotices = await Notification.countDocuments({ userId: owner.user._id });
      const originalCreate = AuditLog.create;
      AuditLog.create = async () => { throw new Error('Required audit unavailable'); };
      try { await assert.rejects(action(winner, claimed, 'decision', { decision: 'approve', reason: 'The genuine current programme evidence is complete.' }), /Required audit unavailable/); }
      finally { AuditLog.create = originalCreate; }
      const unchanged = await PromoterVerification.findById(claimed._id);
      assert.equal(unchanged.status, 'submitted'); assert.equal(unchanged.__v, claimed.__v);
      assert.equal(await AuditLog.countDocuments({ targetPublicId: claimed.publicId }), beforeAudit);
      assert.equal(await Notification.countDocuments({ userId: owner.user._id }), beforeNotices);
      await action(winner, claimed, 'release');
      await action(admin, claimed, 'claim');
      await action(admin, claimed, 'decision', { decision: 'reject', reason: 'Please explain how your current channels fit the declared audience.' });
      const rejected = await PromoterVerification.findById(claimed._id);
      assert.equal(rejected.status, 'rejected'); assert.equal(rejected.assignedUserId, null);
      assert.equal((await User.findById(owner.user._id)).role, 'promoter');
    });

    await t.test('real owner appeal requires CSRF and current version, preserves the decision, and enforces an independent reviewer', async () => {
      const page = await owner.agent.get('/promoter/profile?section=business').expect(200);
      assert.match(page.text, /action="\/promoter\/verification\/appeal"/);
      const rejected = await PromoterVerification.findById(verification._id);
      await owner.agent.post('/promoter/verification/appeal').type('form').send({ version: rejected.__v, message: 'My channels reach the declared audience with the accepted disclosure.' }).expect(403);
      const appeal = await owner.agent.post('/promoter/verification/appeal').type('form').send({ _csrf: csrf(page.text), version: rejected.__v,
        message: 'My channels reach the declared audience with the accepted disclosure.' }).expect(302);
      assert.equal(appeal.headers.location, '/promoter/profile?section=business');
      const appealed = await PromoterVerification.findById(rejected._id);
      assert.equal(appealed.status, 'appealed'); assert.equal(appealed.country, 'UG'); assert.equal(String(appealed.appeal.originalReviewerUserId), String(admin.user._id));
      assert.equal(appealed.reason, rejected.reason); assert.equal(appealed.reviewedAt.getTime(), rejected.reviewedAt.getTime());
      await assert.rejects(action(admin, appealed, 'claim'), error => error.code === 'COUNTRY_ADMIN_PROMOTER_APPEAL_INDEPENDENCE');
      await assert.rejects(people.appealCountryAdminPromoterVerification(await core(owner, { body: { version: rejected.__v, message: 'A repeated stale appeal cannot replace the original submission.' } })), error => error.code === 'COUNTRY_ADMIN_PEOPLE_VERSION_CONFLICT');
      await action(contender, appealed, 'claim');
      const approved = await action(contender, appealed, 'decision', { decision: 'approve', reason: 'The genuine source evidence and submitted appeal meet programme requirements.' });
      assert.equal(approved.status, 'verified');
      const detail = await people.loadCountryAdminPromoterDetail(await core(admin), appealed.publicId);
      assert.equal(detail.record.appeal.message, appealed.appeal.message); assert.ok(detail.record.reviewHistory.some(entry => entry.action === 'appeal'));
      assert.equal(await Notification.countDocuments({ userId: owner.user._id, type: 'promoter_verification' }), 3);
      assert.ok(await AuditLog.exists({ targetPublicId: appealed.publicId, action: 'promoter.verification_appealed', country: 'UG' }));
    });

    await t.test('new submission clears an old claim and review but keeps history; approvals require genuine current evidence and role', async () => {
      const current = await PromoterVerification.findById(verification._id);
      await secureSubmitPromoterVerification(await core(owner), { verificationVersion: current.__v, channels: ['Instagram'], niches: ['Technology'],
        audienceSize: 700, audienceLocation: 'Kampala', disclosureAccepted: true });
      const submitted = await PromoterVerification.findById(current._id);
      assert.equal(submitted.status, 'submitted'); assert.equal(submitted.reviewedByUserId, null); assert.equal(submitted.assignedUserId, null);
      assert.equal(submitted.appeal?.submittedAt, undefined); assert.ok(submitted.reviewHistory.some(entry => entry.action === 'appeal'));
      await action(admin, submitted, 'claim');
      await secureSubmitPromoterVerification(await core(owner), { verificationVersion: (await PromoterVerification.findById(submitted._id)).__v,
        channels: ['WhatsApp'], niches: ['Technology'], audienceSize: 800, disclosureAccepted: true });
      const reset = await PromoterVerification.findById(submitted._id);
      assert.equal(reset.assignedUserId, null);
      await assert.rejects(action(admin, reset, 'decision', { decision: 'approve', reason: 'A resubmitted record needs a new independent claim.' }), error => error.code === 'COUNTRY_ADMIN_PROMOTER_CLAIM_REQUIRED');
      await action(admin, reset, 'claim');
      await PromoterVerification.updateOne({ _id: reset._id }, { $unset: { disclosureAcceptedAt: 1 }, $inc: { __v: 1 } });
      await assert.rejects(action(admin, reset, 'decision', { decision: 'approve', reason: 'A missing real disclosure prevents programme approval.' }), error => error.code === 'COUNTRY_ADMIN_PROMOTER_EVIDENCE_REQUIRED');
      await User.updateOne({ _id: owner.user._id }, { $set: { role: 'customer' }, $inc: { __v: 1 } });
      await assert.rejects(action(admin, reset, 'decision', { decision: 'approve', reason: 'A customer cannot be escalated into a promoter by review.' }), error => error.status === 404);
      assert.equal((await User.findById(owner.user._id)).role, 'customer');
    });

    await t.test('customer suspend and reactivate revoke genuine browser/mobile sessions with no identity or role changes', async () => {
      const before = await User.findById(customer.user._id);
      const browser = await Device.findOne({ userId: before._id, revokedAt: null });
      const mobile = await MobileSession.create({ publicId: `mss_cpeople_${suffix}`, familyId: `family_cpeople_${suffix}`, userId: before._id,
        userTokenVersion: before.security.tokenVersion, cartKey: `account:${before._id}:UG`, deviceName: 'People live mobile', platform: 'android',
        accessTokenHash: hashToken('people-mobile-access-' + suffix), refreshTokenHash: hashToken('people-mobile-refresh-' + suffix),
        accessExpiresAt: new Date(Date.now() + 60_000), refreshExpiresAt: new Date(Date.now() + 86_400_000) });
      const req = await core(admin, { publicId: before.publicId, body: { version: before.__v, reason: 'Account restriction for a documented current customer issue.', role: 'super_admin', emailVerifiedAt: new Date().toISOString(), country: 'TZ' } });
      const result = await people.actCountryAdminCustomer(req, 'suspend');
      assert.equal(result.status, 'suspended');
      const suspended = await User.findById(before._id);
      assert.equal(suspended.role, 'customer'); assert.equal(suspended.country, 'UG'); assert.equal(suspended.emailVerifiedAt.getTime(), before.emailVerifiedAt.getTime());
      assert.equal(suspended.security.tokenVersion, before.security.tokenVersion + 1);
      assert.ok((await Device.findById(browser._id)).revokedAt); assert.ok((await MobileSession.findById(mobile._id)).revokedAt);
      await assert.rejects(people.actCountryAdminCustomer(req, 'reactivate'), error => error.code === 'COUNTRY_ADMIN_PEOPLE_VERSION_CONFLICT');
      const reactivated = await people.actCountryAdminCustomer(await core(admin, { publicId: before.publicId, body: { version: suspended.__v,
        reason: 'The documented restriction has been reviewed and resolved.' } }), 'reactivate');
      assert.equal(reactivated.status, 'active'); assert.equal((await User.findById(before._id)).security.tokenVersion, before.security.tokenVersion + 2);
      assert.ok((await Device.findById(browser._id)).revokedAt); assert.ok((await MobileSession.findById(mobile._id)).revokedAt);
      await customer.agent.get('/account/security').expect(302);
      assert.equal(await Notification.countDocuments({ userId: before._id, type: 'customer_account' }), 2);
    });

    await t.test('revoked devices and grants, changed token versions and disabled source countries fail closed', async () => {
      const freshOwner = await actor({ role: 'promoter' }), fresh = await promoter(freshOwner);
      const staleDevice = await actor({ grantRole: 'country_admin' });
      const deviceReq = await core(staleDevice, { publicId: fresh.publicId, body: { version: fresh.__v } });
      await Device.updateOne({ _id: staleDevice.device._id }, { $set: { revokedAt: new Date() } });
      await assert.rejects(people.actCountryAdminPromoter(deviceReq, 'claim'), error => error.code === 'ACCOUNT_UNAVAILABLE');
      const staleGrant = await actor({ grantRole: 'country_admin' });
      const grantReq = await core(staleGrant, { publicId: fresh.publicId, body: { version: fresh.__v } });
      await PlatformGrant.updateOne({ _id: staleGrant.grant._id }, { $set: { status: 'revoked' } });
      await assert.rejects(people.actCountryAdminPromoter(grantReq, 'claim'), error => error.code === 'COUNTRY_ADMIN_GRANT_UNAVAILABLE');
      const staleToken = await core(admin, { publicId: fresh.publicId, body: { version: fresh.__v } });
      await User.updateOne({ _id: admin.user._id }, { $inc: { 'security.tokenVersion': 1 } });
      await assert.rejects(people.actCountryAdminPromoter(staleToken, 'claim'), error => error.code === 'ACCOUNT_UNAVAILABLE');
      const strict = await actor({ grantRole: 'country_admin', countries: ['UG', 'KE'] });
      await CountrySetting.updateOne({ code: 'UG' }, { $set: { active: false }, $inc: { __v: 1 } });
      await assert.rejects(people.actCountryAdminPromoter(await core(strict, { publicId: fresh.publicId, body: { version: fresh.__v } }), 'claim'), error => [403, 404, 409].includes(error.status));
      assert.equal((await PromoterVerification.findById(fresh._id)).status, 'submitted');
      await CountrySetting.updateOne({ code: 'UG' }, { $set: { active: true }, $inc: { __v: 1 } });
      await reviewPromoterVerification(await core(superAdmin), fresh.publicId, { decision: 'approve', reason: 'Trusted core Super review retains genuine source safeguards.' });
      assert.equal((await PromoterVerification.findById(fresh._id)).status, 'verified');
    });
  } finally {
    for (const transport of transports) transport.destroy();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

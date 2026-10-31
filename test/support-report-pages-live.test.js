import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
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

test('Support report calendars and spreadsheet cells handle local boundaries and inert formulas', async () => {
  const { supportReportingWindow, supportCsvCell } = await import('../src/services/support-report-pages.js');
  assert.equal(supportReportingWindow('year', 'Africa/Kampala', new Date('2026-10-10T22:00:00Z')).start.toISOString(), '2025-12-31T21:00:00.000Z');
  assert.equal(supportReportingWindow('year', 'America/New_York', new Date('2026-03-10T12:00:00Z')).buckets[2].start.toISOString(), '2026-03-01T05:00:00.000Z');
  assert.throws(() => supportReportingWindow('forever', 'UTC'));
  for (const value of ['=IMPORTXML("private")', '  +SUM(1,2)', '\t@cmd', '-2+3', '\uFEFF=HYPERLINK("x")', '\u0000=HYPERLINK("x")', '\u0001+SUM(1,2)']) assert.ok(supportCsvCell(value).startsWith('"\''));
  assert.equal(supportCsvCell('quoted "value"'), '"quoted ""value"""');
});

test('Support overview and reports aggregate complete scoped evidence and stream private exports', { skip: !uri, timeout: 180_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1'); assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex'), transports = [];
  await mongoose.connect(uri, { dbName: `classicmart_support_reports_test_${suffix}` });
  try {
    const { User, PlatformGrant, CountrySetting, SupportTicket, SatisfactionSurvey, AuditLog, Store, LoyaltyAccount, LedgerAccount } = await import('../src/models/index.js');
    const { createApp } = await import('../src/app.js');
    const { hashPassword } = await import('../src/core/crypto.js');
    const { encryptSensitive } = await import('../src/core/sensitive.js');
    const { totpCode } = await import('../src/services/mfa.js');
    const { loadSupportReportPage, loadSupportSidebar, streamSupportReportCsv } = await import('../src/services/support-report-pages.js');
    const { supportAccess } = await import('../src/services/support-workspace-access.js');
    for (const Model of Object.values(mongoose.models)) await Model.init();
    await CountrySetting.create([{ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256' },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254' },
      { code: 'TZ', name: 'UNASSIGNED_MARKET_PRIVATE', currency: 'TZS', locale: 'en-TZ', timeZone: 'Africa/Dar_es_Salaam', phonePrefix: '+255' }]);
    const password = `SupportReport-${suffix}-A1!`, passwordHash = await hashPassword(password), secret = 'JBSWY3DPEHPK3PXP', app = createApp(null);
    let sequence = 0;
    async function actor(role, { managed = false, login = false, countries = ['UG', 'KE'] } = {}) {
      const index = ++sequence, email = `support-report-${suffix}-${index}@example.com`, phone = '+25670' + String(index).padStart(7, '0');
      const user = await User.create({ publicId: `usr_sr_${suffix}_${index}`, name: `Support report ${index}`, email, emailNormalized: email, phone, phoneNormalized: phone,
        passwordHash, role, country: 'UG', currency: 'UGX', operationalCountries: countries, platformAccessManagedAt: managed ? new Date() : undefined,
        emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), security: { mfaEnabled: true, mfaSecretEncrypted: encryptSensitive(secret) }, consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const grant = managed ? await PlatformGrant.create({ publicId: `pgr_sr_${suffix}_${index}`, userId: user._id, role: 'support', operationalCountries: countries, status: 'active',
        startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86400_000), reason: 'Scoped Support report fixture', approvalPublicId: `apr_sr_${suffix}_${index}`, approvedByUserId: new mongoose.Types.ObjectId() }) : null;
      let client;
      if (login) {
        const transport = new http.Agent({ localAddress: `127.0.0.${index + 90}`, keepAlive: false }); transports.push(transport);
        client = request.agent(app).use(req => req.agent(transport));
        const page = await client.get('/login').expect(200);
        await client.post('/login').type('form').send({ email, password, _csrf: csrf(page.text) }).expect(302).expect('location', '/mfa');
        const challenge = await client.get('/mfa').expect(200);
        await client.post('/mfa').type('form').send({ code: totpCode(secret), _csrf: csrf(challenge.text) }).expect(302);
      }
      return { user, grant, client };
    }
    const owner = await actor('customer', { managed: true, login: true }), customer = await actor('customer'), single = await actor('support', { countries: ['UG'] });
    const scoped = (entry = owner, query = {}) => ({ id: `req_sr_${suffix}_${++sequence}`, ip: '127.0.0.1', get: () => 'SupportReportTest/1.0', user: entry.user, session: { tokenVersion: entry.user.security.tokenVersion }, query });
    const now = new Date(), createdAt = new Date(now.getTime() - 2 * 86400_000), tickets = [];
    for (const [country, count] of [['UG', 64], ['KE', 3], ['TZ', 2]]) {
      for (let index = 0; index < count; index += 1) {
        const resolved = country === 'UG' ? index >= 40 : index >= 1;
        const responseAt = new Date(createdAt.getTime() + (country === 'UG' ? 10 : 20) * 60_000), resolvedAt = resolved ? new Date(createdAt.getTime() + (country === 'UG' ? 60 : 120) * 60_000) : undefined;
        const ticket = await SupportTicket.create({ publicId: country === 'UG' && index === 0 ? '  =SUPPORT_FORMULA' : `tkt_sr_${suffix}_${country}_${index}`, userId: customer.user._id, country, category: 'account', subject: 'BUYER_SUBJECT_PRIVATE', status: resolved ? 'resolved' : 'open', queue: 'accounts', priority: 'normal',
          assignedUserId: country === 'UG' ? owner.user._id : undefined, assignedAt: createdAt, slaDueAt: new Date(now.getTime() + (country === 'UG' && index < 20 ? -1 : 1) * 86400_000),
          requesterName: 'BUYER_IDENTITY_PRIVATE', requesterEmailMasked: 'BUYER_CONTACT_PRIVATE', requesterEmailEncrypted: 'BUYER_ENCRYPTED_PRIVATE', createdAt, resolvedAt,
          notes: [{ message: 'STAFF_INTAKE_PRIVATE', actorUserId: owner.user._id, internal: false, at: createdAt }, { message: 'INTERNAL_NOTE_PRIVATE', actorUserId: owner.user._id, internal: true, at: new Date(createdAt.getTime() + 60_000) },
            { message: 'CUSTOMER_MESSAGE_PRIVATE', actorUserId: customer.user._id, internal: false, at: new Date(createdAt.getTime() + 120_000) }, { message: 'STAFF_RESPONSE_PRIVATE', actorUserId: owner.user._id, internal: false, at: responseAt }],
          assignmentHistory: index === 0 ? [{ action: 'transfer', actorUserId: owner.user._id, assignedUserId: single.user._id, at: createdAt }] : [] });
        tickets.push(ticket);
        if (resolved) await SatisfactionSurvey.create({ publicId: `sat_sr_${suffix}_${country}_${index}`, ticketId: ticket._id, ticketPublicId: ticket.publicId, country, userId: customer.user._id,
          rating: country === 'UG' ? index === 40 ? 1 : 5 : index === 1 ? 1 : 5, comment: 'SURVEY_COMMENT_PRIVATE', createdAt: new Date(resolvedAt.getTime() + 1000) });
      }
    }
    await SupportTicket.create({ publicId: `tkt_merged_sr_${suffix}`, userId: customer.user._id, country: 'UG', category: 'account', subject: 'MERGED_DUPLICATE_PRIVATE', status: 'closed', queue: 'accounts', priority: 'normal', slaDueAt: now, createdAt, resolvedAt: now, mergedIntoPublicId: tickets[0].publicId });
    const malformedSurveys = [
      { publicId: `sat_wrong_reference_sr_${suffix}`, ticketId: tickets[0]._id, ticketPublicId: 'BAD_REFERENCE_PRIVATE', country: 'UG', userId: customer.user._id, rating: 5 },
      { publicId: `sat_wrong_owner_sr_${suffix}`, ticketId: tickets[1]._id, ticketPublicId: tickets[1].publicId, country: 'UG', userId: owner.user._id, rating: 5 },
      { publicId: `sat_wrong_country_sr_${suffix}`, ticketId: tickets[64]._id, ticketPublicId: tickets[64].publicId, country: 'UG', userId: customer.user._id, rating: 5 },
      { publicId: `sat_fractional_sr_${suffix}`, ticketId: tickets[2]._id, ticketPublicId: tickets[2].publicId, country: 'UG', userId: customer.user._id, rating: 4.5 },
    ];
    await SatisfactionSurvey.create(malformedSurveys.map(row => ({ ...row, createdAt, comment: 'MALFORMED_SURVEY_PRIVATE' })));
    await AuditLog.create([{ requestId: `req_audit_sr_${suffix}`, actorId: owner.user._id, actorPublicId: owner.user.publicId, action: 'support.ticket_replied', country: 'UG', result: 'success', createdAt, metadata: { message: 'AUDIT_NOTE_PRIVATE', contact: 'AUDIT_CONTACT_PRIVATE' }, ipHash: 'IP_HASH_PRIVATE' },
      { requestId: `req_foreign_sr_${suffix}`, action: 'support.ticket_replied', country: 'TZ', result: 'success', createdAt, metadata: { message: 'FOREIGN_AUDIT_PRIVATE' } }]);

    await t.test('canonical overview and reports use all records, weighted CSAT and real public-response timing', async () => {
      for (const slug of ['overview', 'reports']) {
        const result = await owner.client.get('/support/' + slug).set('Accept', 'application/json').expect(200);
        assert.deepEqual(result.body.context.countries.map(row => row.code).sort(), ['KE', 'UG']); assert.equal(result.body.context.country, '');
        assert.equal(result.body.summary.createdCount, 67); assert.equal(result.body.summary.resolvedCount, 26); assert.equal(result.body.summary.openCount, 41); assert.equal(result.body.summary.mineCount, 40);
        assert.equal(result.body.summary.overdueCount, 20); assert.equal(result.body.summary.slaObservedCount, 41); assert.equal(result.body.summary.slaCompliance, 51.2);
        assert.equal(result.body.summary.surveyCount, 26); assert.equal(result.body.summary.csatAverage, 4.7); assert.equal(result.body.summary.csatPercent, 92.3);
        assert.equal(result.body.summary.responseCount, 67); assert.equal(result.body.summary.averageResponseMinutes, 10.4); assert.equal(result.body.summary.averageResolutionMinutes, 64.6); assert.equal(result.body.summary.transferCount, 2);
        for (const hidden of ['UNASSIGNED_MARKET_PRIVATE', 'BUYER_CONTACT_PRIVATE', 'BUYER_SUBJECT_PRIVATE', 'BUYER_IDENTITY_PRIVATE', 'BUYER_ENCRYPTED_PRIVATE', 'INTERNAL_NOTE_PRIVATE', 'CUSTOMER_MESSAGE_PRIVATE', 'STAFF_RESPONSE_PRIVATE', 'STAFF_INTAKE_PRIVATE', 'SURVEY_COMMENT_PRIVATE', 'AUDIT_NOTE_PRIVATE', 'AUDIT_CONTACT_PRIVATE', 'IP_HASH_PRIVATE', 'MERGED_DUPLICATE_PRIVATE', 'MALFORMED_SURVEY_PRIVATE', 'FOREIGN_AUDIT_PRIVATE']) assert.ok(!JSON.stringify(result.body).includes(hidden), hidden);
        assert.match(result.headers['cache-control'], /no-store/); assert.match(result.headers['x-robots-tag'], /noindex/);
        const html = await owner.client.get('/support/' + slug).expect(200); assert.match(html.text, /data-role="support"/);
      }
      const overview = (await owner.client.get('/support/overview').set('Accept', 'application/json')).body;
      assert.equal(overview.trend.reduce((sum, row) => sum + row.value, 0), 67); assert.equal(overview.trend.reduce((sum, row) => sum + row.resolved, 0), 26);
      assert.equal(await Store.countDocuments(), 0); assert.equal(await LoyaltyAccount.countDocuments(), 0); assert.equal(await LedgerAccount.countDocuments(), 0);
    });
    await t.test('market and reporting filters cannot add foreign countries, inject operators or accept invalid cursors', async () => {
      const result = await owner.client.get('/support/reports?country=UG').set('Accept', 'application/json').expect(200);
      assert.equal(result.body.groups.length, 1); assert.equal(result.body.summary.createdCount, 64); assert.equal(result.body.timeZone, 'Africa/Kampala');
      const singleFlow = await loadSupportReportPage(scoped(single), 'support-overview'); assert.equal(singleFlow.country, 'UG'); assert.equal(singleFlow.summary.createdCount, 64);
      await owner.client.get('/support/reports?country=TZ').set('Accept', 'application/json').expect(403);
      for (const path of ['country=UG&country=KE', 'report[$ne]=summary', 'after=bad-cursor', 'period=forever', 'status=deleted']) await owner.client.get('/support/reports?' + path).set('Accept', 'application/json').expect(422);
    });
    await t.test('cursor tickets and anonymous surveys stay bounded while totals and queue counts cover all matches', async () => {
      const first = await owner.client.get('/support/reports?country=UG&report=tickets').set('Accept', 'application/json').expect(200);
      assert.equal(first.body.page.total, 64); assert.equal(first.body.page.count, 25);
      const second = await owner.client.get('/support/reports?country=UG&report=tickets&after=' + first.body.page.next).set('Accept', 'application/json').expect(200);
      assert.equal(second.body.page.total, 64); assert.ok(!first.body.items.some(row => second.body.items.some(other => other.publicId === row.publicId)));
      const csatReport = await owner.client.get('/support/reports?report=csat').set('Accept', 'application/json').expect(200); assert.equal(csatReport.body.page.total, 26); assert.equal(csatReport.body.page.count, 25);
      assert.ok(csatReport.body.items.every(row => !Object.hasOwn(row, 'userId') && !Object.hasOwn(row, 'comment') && !Object.hasOwn(row, 'ticket')));
      const queues = await owner.client.get('/support/reports?report=queues').set('Accept', 'application/json').expect(200); assert.equal(queues.body.items.reduce((sum, row) => sum + row.count, 0), 41); assert.equal(queues.body.items.reduce((sum, row) => sum + row.unassigned, 0), 1);
      const resolved = await owner.client.get('/support/reports?country=UG&report=tickets&status=resolved').set('Accept', 'application/json').expect(200); assert.equal(resolved.body.page.total, 24);
    });
    await t.test('CSV exports contain complete anonymous evidence and recorded export audit', async () => {
      for (const [report, count] of [['tickets', 67], ['csat', 26], ['summary', 2], ['queues', 2]]) {
        const csv = await owner.client.get('/support/reports/export.csv?report=' + report).expect(200); assert.equal(csv.text.trim().split('\r\n').length, count + 1);
        assert.match(csv.headers['content-type'], /text\/csv/); assert.match(csv.headers['cache-control'], /no-store/);
        if (report === 'tickets') assert.match(csv.text, /"'  =SUPPORT_FORMULA"/);
        for (const privateValue of ['BUYER_CONTACT_PRIVATE', 'BUYER_SUBJECT_PRIVATE', 'INTERNAL_NOTE_PRIVATE', 'SURVEY_COMMENT_PRIVATE', 'BAD_REFERENCE_PRIVATE']) assert.ok(!csv.text.includes(privateValue), privateValue);
      }
      assert.equal(await AuditLog.countDocuments({ action: 'support.report_exported', actorId: owner.user._id }), 4);
      const sidebar = await loadSupportSidebar(await supportAccess(scoped())); assert.equal(sidebar.openCount, 41); assert.equal(sidebar.slaCompliance, 51.2); assert.equal(sidebar.averageResponseMinutes, 10.4);
    });
    await t.test('report streaming stops before the next row when grants or market configuration change', async () => {
      for (const report of ['summary', 'tickets']) {
        const output = new EventEmitter(), chunks = []; let ended = false;
        output.destroyed = false; output.set = () => output; output.end = () => { ended = true; };
        output.write = text => { chunks.push(text); if (chunks.length === 2) { const mutation = report === 'summary' ? PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { status: 'revoked' } }) : CountrySetting.updateOne({ code: 'UG' }, { $set: { timeZone: 'UTC' } }); Promise.resolve(mutation).then(() => output.emit('drain'), error => output.emit('error', error)); return false; } return true; };
        try { await assert.rejects(streamSupportReportCsv(scoped(owner, { report }), output, 'support-reports'), error => error.status === 403); assert.equal(chunks.length, 2); assert.equal(ended, false); }
        finally { await PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { status: 'active' } }); await CountrySetting.updateOne({ code: 'UG' }, { $set: { timeZone: 'Africa/Kampala' } }); }
      }
    });
    await t.test('empty scopes have unknown SLA, satisfaction and response averages rather than invented perfect scores', async () => {
      await SupportTicket.updateMany({ country: 'KE', status: 'open' }, { $set: { status: 'closed' } });
      const empty = await loadSupportReportPage(scoped(owner, { country: 'KE', period: '30days' }), 'support-reports'); assert.equal(empty.summary.openCount, 0); assert.equal(empty.summary.slaCompliance, null);
      await SatisfactionSurvey.deleteMany({ country: 'KE' }); await SupportTicket.deleteMany({ country: 'KE' });
      const none = await loadSupportReportPage(scoped(owner, { country: 'KE' }), 'support-reports'); assert.equal(none.summary.csatAverage, null); assert.equal(none.summary.averageResponseMinutes, null); assert.equal(none.summary.averageResolutionMinutes, null); assert.equal(none.summary.createdCount, 0);
    });
    await t.test('authorization uses current grant, account and authenticator for direct and HTTP paths', async () => {
      await assert.rejects(loadSupportReportPage(scoped(customer), 'support-reports'), error => error.status === 403);
      await User.updateOne({ _id: owner.user._id }, { $set: { 'security.mfaEnabled': false } }); await assert.rejects(loadSupportReportPage(scoped(), 'support-reports'), error => error.code === 'MFA_ENROLLMENT_REQUIRED');
      await User.updateOne({ _id: owner.user._id }, { $set: { 'security.mfaEnabled': true } });
      await PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { status: 'revoked' } }); await assert.rejects(loadSupportReportPage(scoped(), 'support-reports'), error => error.code === 'SUPPORT_GRANT_UNAVAILABLE');
      await owner.client.get('/support/reports').set('Accept', 'application/json').expect(403); await PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { status: 'active' } });
    });
    await t.test('saved defaults use the authorized operational calendar independently of shopping currency', async () => {
      await User.updateOne({ _id: owner.user._id }, { $set: { 'preferences.supportReportingPeriod': 'year', 'preferences.supportDefaultCountry': 'UG', currency: 'TZS' } });
      const flow = await loadSupportReportPage(scoped(), 'support-overview'); assert.equal(flow.period, 'year'); assert.equal(flow.timeZone, 'Africa/Kampala'); assert.equal(flow.country, 'UG'); assert.equal(flow.summary.createdCount, 64);
    });
  } finally { for (const transport of transports) transport.destroy(); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
});

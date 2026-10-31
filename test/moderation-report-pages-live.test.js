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

test('Moderation reporting calendars and CSV cells preserve local dates and inert spreadsheet formulas', async () => {
  const { moderationReportingWindow, moderationCsvCell } = await import('../src/services/moderation-report-pages.js');
  assert.equal(moderationReportingWindow('year', 'Africa/Kampala', new Date('2026-10-10T22:00:00Z')).start.toISOString(), '2025-12-31T21:00:00.000Z');
  assert.equal(moderationReportingWindow('year', 'America/New_York', new Date('2026-03-10T12:00:00Z')).buckets[2].start.toISOString(), '2026-03-01T05:00:00.000Z');
  assert.throws(() => moderationReportingWindow('forever', 'UTC'));
  for (const value of ['=IMPORTXML("private")', '  +SUM(1,2)', '\t@cmd', '-2+3', '\uFEFF=HYPERLINK("x")', '\u0000=HYPERLINK("x")', '\u0001+SUM(1,2)']) assert.ok(moderationCsvCell(value).startsWith('"\''), value);
  assert.equal(moderationCsvCell('quoted "value"'), '"quoted ""value"""');
  assert.equal(moderationCsvCell(null), '""');
});

test('Moderation reports join scoped source evidence and independent QA outcomes, with durable accountable changes', { skip: !uri, timeout: 180_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1'); assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex'), transports = [];
  await mongoose.connect(uri, { dbName: `classicmart_moderation_reports_test_${suffix}` });
  try {
    const { User, PlatformGrant, CountrySetting, Category, Store, StoreMember, Product, SellerVerification, VerificationDocument, TrustCase, RiskSignal, ModerationQaReview, AuditLog, Notification, LedgerAccount, LoyaltyAccount } = await import('../src/models/index.js');
    const { createApp } = await import('../src/app.js');
    const { hashPassword } = await import('../src/core/crypto.js');
    const { encryptSensitive } = await import('../src/core/sensitive.js');
    const { totpCode } = await import('../src/services/mfa.js');
    const { loadModerationReportPage, streamModerationReportCsv, actModerationQa } = await import('../src/services/moderation-report-pages.js');
    const { saveModerationCommunication } = await import('../src/services/moderation-settings-pages.js');
    for (const Model of Object.values(mongoose.models)) await Model.init();
    await CountrySetting.create([{ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256' },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254' },
      { code: 'TZ', name: 'UNASSIGNED_MARKET_PRIVATE', currency: 'TZS', locale: 'en-TZ', timeZone: 'Africa/Dar_es_Salaam', phonePrefix: '+255' }]);
    const password = `ModerationReport-${suffix}-A1!`, passwordHash = await hashPassword(password), secret = 'JBSWY3DPEHPK3PXP', app = createApp(null);
    let sequence = 0;
    async function actor(role = 'customer', { managed = false, login = false, countries = ['UG', 'KE'] } = {}) {
      const index = ++sequence, email = `moderation-report-${suffix}-${index}@example.com`, phone = '+25670' + String(index).padStart(7, '0');
      const user = await User.create({ publicId: `usr_mr_${suffix}_${index}`, name: `Moderation report ${index}`, email, emailNormalized: email, phone, phoneNormalized: phone,
        passwordHash, role, country: 'UG', currency: 'UGX', operationalCountries: countries, platformAccessManagedAt: managed ? new Date() : undefined,
        emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), security: { mfaEnabled: true, mfaSecretEncrypted: encryptSensitive(secret) }, consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const grant = managed ? await PlatformGrant.create({ publicId: `pgr_mr_${suffix}_${index}`, userId: user._id, role: 'moderator', operationalCountries: countries, status: 'active',
        startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86400_000), reason: 'Scoped Moderation report fixture', approvalPublicId: `apr_mr_${suffix}_${index}`, approvedByUserId: new mongoose.Types.ObjectId() }) : null;
      let client;
      if (login) {
        const transport = new http.Agent({ localAddress: `127.0.0.${index + 100}`, keepAlive: false }); transports.push(transport);
        client = request.agent(app).use(req => req.agent(transport));
        const page = await client.get('/login').expect(200);
        await client.post('/login').type('form').send({ email, password, _csrf: csrf(page.text) }).expect(302).expect('location', '/mfa');
        const challenge = await client.get('/mfa').expect(200);
        await client.post('/mfa').type('form').send({ code: totpCode(secret), _csrf: csrf(challenge.text) }).expect(302).expect('location', '/moderation/overview');
      }
      return { user, grant, client };
    }
    const owner = await actor('customer', { managed: true, login: true }), second = await actor('customer', { managed: true, login: true });
    const original = await actor('customer', { managed: true, login: true }), storeOwner = await actor('customer', { managed: true, login: true });
    const activeMember = await actor('customer', { managed: true }), invitedMember = await actor('customer', { managed: true }), customer = await actor();
    const single = await actor('moderator', { countries: ['UG'] });
    const scoped = (entry = owner, query = {}) => ({ id: `req_mr_${suffix}_${++sequence}`, ip: '127.0.0.1', get: () => 'ModerationReportTest/1.0', user: entry.user, session: { tokenVersion: entry.user.security.tokenVersion }, query });
    const now = new Date(), createdAt = new Date(now.getTime() - 2 * 86400_000), decisionAt = new Date(createdAt.getTime() + 60_000), sampledAt = new Date(decisionAt.getTime() + 1000);
    const category = await Category.create({ publicId: `cat_mr_${suffix}`, name: 'Moderation report catalogue', slug: `mr-${suffix}`, active: true, countries: ['UG', 'KE', 'TZ'] });
    const stores = {}, qa = {}, products = {};
    for (const [country, currency] of [['UG', 'UGX'], ['KE', 'KES'], ['TZ', 'TZS']]) {
      const seller = country === 'UG' ? storeOwner : await actor('seller');
      stores[country] = await Store.create({ publicId: `str_mr_${suffix}_${country}`, ownerUserId: seller.user._id, name: `Moderation Store ${country}`, slug: `mr-${suffix}-${country}`, country, currency, status: 'verified', verifiedAt: createdAt });
      products[country] = []; qa[country] = [];
      for (let index = 0; index < ({ UG: 31, KE: 3, TZ: 2 })[country]; index += 1) await Product.create({ publicId: `prd_pending_mr_${suffix}_${country}_${index}`, storeId: stores[country]._id, ownerUserId: seller.user._id,
        categoryId: category._id, title: 'CATALOGUE_TITLE_PRIVATE', slug: `pending-${index}`, description: 'CATALOGUE_BODY_PRIVATE', countries: ['UG', 'KE', 'TZ'], status: 'submitted', createdAt,
        moderation: { submittedAt: createdAt, riskLevel: country === 'UG' && index < 7 ? 'high' : 'standard' } });
      for (let index = 0; index < ({ UG: 29, KE: 3, TZ: 2 })[country]; index += 1) {
        const target = await Product.create({ publicId: country === 'UG' && index === 0 ? '  =MODERATION_FORMULA' : `prd_decided_mr_${suffix}_${country}_${index}`, storeId: stores[country]._id, ownerUserId: seller.user._id,
          categoryId: category._id, title: `Decided moderation product ${country} ${index}`, slug: `decided-${index}`, description: 'CATALOGUE_BODY_PRIVATE', countries: ['UG', 'KE', 'TZ'], status: 'submitted', createdAt,
          moderation: { submittedAt: createdAt } });
        target.status = 'approved'; target.moderation.reviewedAt = decisionAt; target.moderation.reviewedByUserId = original.user._id;
        target.moderation.reason = 'Recorded independent catalogue decision.';
        target.moderation.reviewHistory.push({ action: 'approve', actorUserId: original.user._id, reason: target.moderation.reason, at: decisionAt });
        target.increment(); await target.save();
        products[country].push(target);
        qa[country].push(await ModerationQaReview.create({ publicId: `mqa_mr_${suffix}_${country}_${index}`, targetType: 'product', targetObjectId: target._id, targetPublicId: target.publicId, country,
          decision: 'approved', decisionReason: target.moderation.reason, decisionVersionSnapshot: target.__v, decisionEventAt: decisionAt, originalReviewerUserId: original.user._id, sampledAt, createdAt: sampledAt }));
        await AuditLog.create({ requestId: `req_decision_mr_${suffix}_${country}_${index}`, actorId: original.user._id, actorPublicId: original.user.publicId, action: 'catalogue.product_approved', targetType: 'product', targetPublicId: target.publicId,
          country, result: 'success', createdAt: decisionAt, metadata: { decision: 'approve', note: 'AUDIT_NOTE_PRIVATE', contact: 'AUDIT_CONTACT_PRIVATE', document: 'IDENTITY_DOCUMENT_PRIVATE' }, ipHash: 'IP_HASH_PRIVATE' });
      }
    }
    await StoreMember.create([{ publicId: `stm_active_mr_${suffix}`, storeId: stores.UG._id, userId: activeMember.user._id, role: 'catalogue', status: 'active', invitedByUserId: storeOwner.user._id },
      { publicId: `stm_invited_mr_${suffix}`, storeId: stores.UG._id, userId: invitedMember.user._id, role: 'catalogue', status: 'invited', invitedByUserId: storeOwner.user._id }]);
    const applicant = await actor('seller'), verificationStore = await Store.create({ publicId: `str_verification_mr_${suffix}`, ownerUserId: applicant.user._id, name: 'Verification applicant', slug: `mr-applicant-${suffix}`, country: 'UG', currency: 'UGX', status: 'pending_verification' });
    await SellerVerification.create({ publicId: `svr_pending_mr_${suffix}`, storeId: verificationStore._id, userId: applicant.user._id, sellerType: 'business', legalName: 'SELLER_LEGAL_NAME_PRIVATE', status: 'submitted', submittedAt: createdAt,
      registrationNumber: encryptSensitive('REGISTRATION_PRIVATE'), taxNumber: encryptSensitive('TAX_NUMBER_PRIVATE'), documents: [{ type: 'identity', mediaPublicId: 'IDENTITY_DOCUMENT_PRIVATE' }] });
    await TrustCase.create({ publicId: `trc_pending_mr_${suffix}`, reporterUserId: customer.user._id, country: 'UG', type: 'unsafe_product', productId: products.UG[0]._id, productPublicId: products.UG[0].publicId,
      storeId: stores.UG._id, storePublicId: stores.UG.publicId, description: 'TRUST_DESCRIPTION_PRIVATE', status: 'open', createdAt });
    await RiskSignal.create({ publicId: `rsk_pending_mr_${suffix}`, country: 'UG', subjectType: 'store', subjectPublicId: stores.UG.publicId, type: 'recorded_report_fixture', severity: 'high', score: 75,
      status: 'open', evidence: ['RISK_EVIDENCE_PRIVATE'], createdBy: 'operator', createdAt });
    const latest = publicId => ModerationQaReview.findOne({ publicId });
    async function act(entry, review, action, extra = {}) { return actModerationQa(scoped(entry, { country: review.country }), review.publicId, { version: (await latest(review.publicId)).__v || 0, action, ...extra }); }
    const completion = outcome => ({ outcome, note: 'Independent QA evidence reviewed against the stored decision.' });

    await t.test('overview counts all authoritative queues and decisions beyond one page, without inventing quality', async () => {
      for (const slug of ['overview', 'reports']) {
        const result = await owner.client.get('/moderation/' + slug).set('Accept', 'application/json').expect(200);
        assert.deepEqual(result.body.context.countries.map(row => row.code).sort(), ['KE', 'UG']); assert.equal(result.body.country, '');
        assert.equal(result.body.summary.openCount, 37); assert.equal(result.body.summary.highRiskCount, 10); assert.equal(result.body.summary.decisionCount, 32);
        assert.equal(result.body.summary.pendingQaCount, 32); assert.equal(result.body.summary.completedQaCount, 0); assert.equal(result.body.summary.decisionQuality, null);
        assert.equal(result.body.verification.detail, 'No observations'); assert.equal(result.body.verification.value, '—');
        for (const hidden of ['UNASSIGNED_MARKET_PRIVATE', 'CATALOGUE_TITLE_PRIVATE', 'CATALOGUE_BODY_PRIVATE', 'SELLER_LEGAL_NAME_PRIVATE', 'REGISTRATION_PRIVATE', 'TAX_NUMBER_PRIVATE', 'IDENTITY_DOCUMENT_PRIVATE', 'AUDIT_NOTE_PRIVATE', 'AUDIT_CONTACT_PRIVATE', 'IP_HASH_PRIVATE', 'TRUST_DESCRIPTION_PRIVATE', 'RISK_EVIDENCE_PRIVATE']) assert.ok(!JSON.stringify(result.body).includes(hidden), hidden);
        assert.match(result.headers['cache-control'], /no-store/); assert.match(result.headers['x-robots-tag'], /noindex/);
        const html = await owner.client.get('/moderation/' + slug).expect(200); assert.match(html.text, /data-role="moderator"/); assert.match(html.text, /No observations/);
      }
      const overview = (await owner.client.get('/moderation/overview').set('Accept', 'application/json')).body;
      assert.equal(overview.trend.reduce((sum, row) => sum + row.value, 0), 32);
      assert.equal(overview.queues.reduce((sum, row) => sum + row.count, 0), 37);
      assert.equal(await Store.countDocuments({ ownerUserId: owner.user._id }), 0); assert.equal(await LoyaltyAccount.countDocuments(), 0); assert.equal(await LedgerAccount.countDocuments(), 0);
    });
    await t.test('market, operator, cursor and status filters cannot expand the authorized evidence', async () => {
      const result = await owner.client.get('/moderation/reports?country=UG').set('Accept', 'application/json').expect(200);
      assert.equal(result.body.groups.length, 1); assert.equal(result.body.summary.openCount, 34); assert.equal(result.body.summary.decisionCount, 29); assert.equal(result.body.timeZone, 'Africa/Kampala');
      const singleFlow = await loadModerationReportPage(scoped(single), 'moderator-overview'); assert.equal(singleFlow.country, 'UG'); assert.equal(singleFlow.summary.openCount, 34);
      await owner.client.get('/moderation/reports?country=TZ').set('Accept', 'application/json').expect(403);
      for (const query of ['country=UG&country=KE', 'report[$ne]=summary', 'after=bad-cursor', 'period=forever', 'status=deleted', 'report=qa&status=success', 'report=decisions&status=completed']) await owner.client.get('/moderation/reports?' + query).set('Accept', 'application/json').expect(422);
      await owner.client.get('/moderation/reports?report=qa&country=UG&record=' + qa.TZ[0].publicId).set('Accept', 'application/json').expect(404);
    });
    await t.test('decision, audit and QA tables paginate while complete totals and exports retain every source record', async () => {
      for (const path of ['/moderation/reports?report=decisions', '/moderation/audit', '/moderation/reports?report=qa']) {
        const first = await owner.client.get(path).set('Accept', 'application/json').expect(200); assert.equal(first.body.page.total, 32); assert.equal(first.body.page.count, 25);
        const secondPage = await owner.client.get(path + (path.includes('?') ? '&' : '?') + 'after=' + encodeURIComponent(first.body.page.next)).set('Accept', 'application/json').expect(200);
        assert.equal(secondPage.body.page.total, 32); assert.equal(secondPage.body.page.count, 7);
        const key = path.includes('qa') ? 'publicId' : 'requestId'; assert.equal(new Set([...first.body.items, ...secondPage.body.items].map(row => row[key])).size, 32);
      }
      const before = await AuditLog.countDocuments({ action: 'moderation.report_exported', actorId: owner.user._id });
      for (const [path, count] of [['/moderation/reports/export.csv?report=decisions', 32], ['/moderation/reports/export.csv?report=qa', 32], ['/moderation/reports/export.csv', 2], ['/moderation/overview/export.csv', 2]]) {
        const csv = await owner.client.get(path).expect(200); assert.equal(csv.text.trim().split('\r\n').length, count + 1);
        assert.match(csv.headers['content-type'], /text\/csv/); assert.match(csv.headers['cache-control'], /no-store/); assert.match(csv.headers['x-robots-tag'], /noindex/);
        if (path.includes('report=')) assert.match(csv.text, /"'  =MODERATION_FORMULA"/);
        for (const hidden of ['AUDIT_NOTE_PRIVATE', 'AUDIT_CONTACT_PRIVATE', 'IDENTITY_DOCUMENT_PRIVATE', 'CATALOGUE_BODY_PRIVATE', 'TRUST_DESCRIPTION_PRIVATE']) assert.ok(!csv.text.includes(hidden), hidden);
      }
      const auditFlow = await loadModerationReportPage(scoped(), 'moderator-audit');
      const previousExportIds = new Set((await AuditLog.find({ action: 'moderation.report_exported', actorId: owner.user._id }).select('_id').lean()).map(row => String(row._id)));
      const auditCsv = await owner.client.get('/moderation/audit/export.csv').expect(200);
      // The export freezes its reporting end before recording its own request.
      assert.equal(auditCsv.text.trim().split('\r\n').length, auditFlow.page.total + 1, 'Every source row from the pre-export report plus one CSV header is retained.');
      const newExports = (await AuditLog.find({ action: 'moderation.report_exported', actorId: owner.user._id }).lean()).filter(row => !previousExportIds.has(String(row._id)));
      assert.equal(newExports.length, 1); assert.equal(newExports[0].targetPublicId, 'audit');
      assert.ok(newExports[0].createdAt >= new Date(auditFlow.range.end)); assert.ok(!auditCsv.text.includes(newExports[0].requestId), 'The current export request belongs to the next reporting snapshot.');
      const afterExport = await loadModerationReportPage(scoped(), 'moderator-audit'); assert.equal(afterExport.page.total, auditFlow.page.total + 1);
      assert.equal(await AuditLog.countDocuments({ action: 'moderation.report_exported', actorId: owner.user._id }), before + 5);
    });
    await t.test('a declared country, target reference or decision snapshot cannot forge report provenance', async () => {
      const forged = await ModerationQaReview.create({ publicId: `mqa_foreign_mr_${suffix}`, targetType: 'product', targetObjectId: products.TZ[0]._id, targetPublicId: products.TZ[0].publicId,
        country: 'UG', decision: 'approved', decisionReason: products.TZ[0].moderation.reason, decisionVersionSnapshot: 2, decisionEventAt: decisionAt, originalReviewerUserId: original.user._id, sampledAt });
      const impossible = await ModerationQaReview.create({ publicId: `mqa_snapshot_mr_${suffix}`, targetType: 'product', targetObjectId: products.UG[3]._id, targetPublicId: products.UG[3].publicId,
        country: 'UG', decision: 'rejected', decisionReason: 'Invented decision snapshot must not be trusted.', decisionVersionSnapshot: 99, decisionEventAt: decisionAt, originalReviewerUserId: original.user._id, sampledAt });
      await AuditLog.create([{ requestId: `req_foreign_mr_${suffix}`, actorId: original.user._id, actorPublicId: 'FOREIGN_ACTOR_PRIVATE', action: 'catalogue.product_approved', targetType: 'product', targetPublicId: products.TZ[0].publicId, country: 'UG', result: 'success', createdAt: decisionAt },
        { requestId: `req_missing_mr_${suffix}`, action: 'catalogue.product_approved', targetType: 'product', targetPublicId: 'MISSING_TARGET_PRIVATE', country: 'UG', result: 'success', createdAt: decisionAt }]);
      const qaReport = await loadModerationReportPage(scoped(owner, { report: 'qa' }), 'moderator-reports'); assert.equal(qaReport.page.total, 32);
      const audit = await owner.client.get('/moderation/audit?search=FOREIGN_ACTOR_PRIVATE').set('Accept', 'application/json').expect(200); assert.equal(audit.body.page.total, 0);
      const summary = await loadModerationReportPage(scoped(), 'moderator-overview'); assert.equal(summary.summary.decisionCount, 32); assert.equal(summary.summary.pendingQaCount, 32);
      for (const review of [forged, impossible]) await assert.rejects(act(owner, review, 'claim'), error => [404, 409].includes(error.status));
      for (const review of [forged, impossible]) await owner.client.get('/moderation/reports?report=qa&record=' + review.publicId).set('Accept', 'application/json').expect(404);
    });
    await t.test('independent QA requires four eyes and excludes affected owners, active members and invited members', async () => {
      await assert.rejects(act(original, qa.UG[4], 'claim'), error => error.status === 403 && error.code === 'MODERATION_QA_FOUR_EYES');
      for (const entry of [storeOwner, activeMember, invitedMember]) await assert.rejects(act(entry, qa.UG[4], 'claim'), error => error.status === 403 && error.code === 'MODERATION_QA_CONFLICT_OF_INTEREST');
      assert.equal((await latest(qa.UG[4].publicId)).assignedUserId, null);
      await owner.client.post('/moderation/reports/qa/' + qa.UG[4].publicId + '/action?country=UG').send({ version: 0, action: 'claim' }).expect(403);
      const detail = await original.client.get('/moderation/reports?report=qa&country=UG&record=' + qa.UG[4].publicId).expect(200);
      await original.client.post('/moderation/reports/qa/' + qa.UG[4].publicId + '/action?country=UG').set('x-csrf-token', csrf(detail.text)).set('Accept', 'application/json').send({ version: 0, action: 'claim' }).expect(403);
    });
    await t.test('document-access and catalogue-export audit entries retain public targets and trusted market evidence', async () => {
      const verification = await SellerVerification.findOne({ storeId: verificationStore._id });
      const document = await VerificationDocument.create({ publicId: `doc_mr_${suffix}_PRIVATE`, verificationId: verification._id, storeId: verificationStore._id, userId: applicant.user._id,
        documentType: 'identity', storageKey: 'PROVIDER_DOCUMENT_KEY_PRIVATE', mimeType: 'image/webp', sizeBytes: 100, width: 10, height: 10, checksumSha256: 'a'.repeat(64) });
      const forgedDocument = await VerificationDocument.create({ publicId: `doc_forged_mr_${suffix}_PRIVATE`, verificationId: verification._id, storeId: stores.TZ._id, userId: applicant.user._id,
        documentType: 'identity', storageKey: 'FOREIGN_DOCUMENT_KEY_PRIVATE', mimeType: 'image/webp', sizeBytes: 100, width: 10, height: 10, checksumSha256: 'b'.repeat(64) });
      await AuditLog.create([{ requestId: `req_document_mr_${suffix}`, actorId: owner.user._id, actorPublicId: owner.user.publicId, country: 'UG', result: 'success', action: 'seller.verification_document_viewed', targetType: 'verification_document', targetPublicId: document.publicId },
        { requestId: `req_document_forged_mr_${suffix}`, actorId: owner.user._id, actorPublicId: owner.user.publicId, country: 'UG', result: 'success', action: 'seller.verification_document_viewed', targetType: 'verification_document', targetPublicId: forgedDocument.publicId },
        { requestId: `req_catalogue_mr_${suffix}`, actorId: owner.user._id, actorPublicId: owner.user.publicId, country: 'UG', result: 'success', action: 'moderation.catalogue_exported', targetType: 'moderation_export', metadata: { pageId: 'moderator-products', private: 'AUDIT_NOTE_PRIVATE' } }]);
      const audit = await loadModerationReportPage(scoped(owner, { search: `req_document_mr_${suffix}` }), 'moderator-audit');
      assert.equal(audit.page.total, 1); assert.equal(audit.items[0].targetPublicId, verification.publicId); assert.equal(audit.items[0].targetType, 'seller_verification');
      assert.ok(!JSON.stringify(audit.items).includes(document.publicId));
      const forged = await loadModerationReportPage(scoped(owner, { search: `req_document_forged_mr_${suffix}` }), 'moderator-audit'); assert.equal(forged.page.total, 0);
      const exported = await loadModerationReportPage(scoped(owner, { search: `req_catalogue_mr_${suffix}` }), 'moderator-audit'); assert.equal(exported.page.total, 1); assert.equal(exported.items[0].targetPublicId, 'moderator-products');
      const csv = await owner.client.get('/moderation/audit/export.csv?search=' + `req_document_mr_${suffix}`).expect(200);
      assert.ok(csv.text.includes(verification.publicId));
      for (const hidden of [document.publicId, forgedDocument.publicId, 'PROVIDER_DOCUMENT_KEY_PRIVATE', 'FOREIGN_DOCUMENT_KEY_PRIVATE', 'AUDIT_NOTE_PRIVATE']) assert.ok(!csv.text.includes(hidden), hidden);
    });
    await t.test('saved versions arbitrate claim races and keep release and completion with the current reviewer', async () => {
      const review = qa.UG[5], version = (await latest(review.publicId)).__v || 0;
      const results = await Promise.allSettled([owner, second].map(entry => actModerationQa(scoped(entry, { country: 'UG' }), review.publicId, { version, action: 'claim' })));
      assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); const failure = results.find(row => row.status === 'rejected'); assert.equal(failure.reason.status, 409);
      const claimed = await latest(review.publicId), winner = String(claimed.assignedUserId) === String(owner.user._id) ? owner : second, loser = winner === owner ? second : owner;
      await assert.rejects(act(loser, review, 'release'), error => [403, 409].includes(error.status));
      await assert.rejects(actModerationQa(scoped(winner, { country: 'UG' }), review.publicId, { version, action: 'complete', ...completion('upheld') }), error => error.status === 409);
      await act(winner, review, 'release'); assert.equal((await latest(review.publicId)).assignedUserId, null);
      await assert.rejects(act(winner, review, 'complete', completion('upheld')), error => [403, 409].includes(error.status));
    });
    await t.test('real claimed QA outcomes produce weighted quality and escalations own durable trust cases', async () => {
      const foreignOperator = await actor('moderator', { countries: ['TZ'] });
      await saveModerationCommunication(scoped(second), { version: (await User.findById(second.user._id)).__v, highRiskAlerts: true, escalationAlerts: false });
      assert.equal((await User.findById(second.user._id)).preferences.moderationEscalationAlerts, false);
      for (const [index, outcome] of ['upheld', 'coaching', 'escalated'].entries()) {
        const review = qa.UG[index], originalTarget = await Product.findById(review.targetObjectId).lean();
        const detail = await owner.client.get('/moderation/reports?report=qa&country=UG&record=' + review.publicId).expect(200);
        assert.match(detail.text, /name="version"/);
        await owner.client.post('/moderation/reports/qa/' + review.publicId + '/action?country=UG').set('x-csrf-token', csrf(detail.text)).set('Accept', 'application/json').send({ version: 0, action: 'claim' }).expect(200);
        await assert.rejects(act(owner, review, 'complete', { outcome, note: 'short' }), error => error.status === 422 || error.name === 'ZodError');
        await act(owner, review, 'complete', completion(outcome));
        const completed = await latest(review.publicId); assert.equal(completed.status, 'completed'); assert.equal(completed.outcome, outcome); assert.equal(String(completed.qaReviewerUserId), String(owner.user._id));
        const completedTarget = await Product.findById(review.targetObjectId).lean();
        assert.equal(completedTarget.status, originalTarget.status); assert.equal(completedTarget.title, originalTarget.title); assert.equal(completedTarget.description, originalTarget.description);
        assert.deepEqual(completedTarget.moderation, originalTarget.moderation);
        assert.equal(completedTarget.__v, originalTarget.__v + 2);
        const audit = await AuditLog.findOne({ action: 'moderation.qa_reviewed', targetPublicId: review.publicId }).lean(); assert.equal(audit.metadata.outcome, outcome); assert.ok(!JSON.stringify(audit.metadata).includes(completion(outcome).note));
        await assert.rejects(act(owner, review, 'complete', completion(outcome)), error => error.status === 409);
        if (outcome === 'escalated') {
          const durable = await TrustCase.findOne({ qaReviewId: review._id }); assert.ok(durable); assert.equal(durable.publicId, completed.escalationCasePublicId); assert.equal(durable.qaReviewPublicId, review.publicId);
          assert.equal(durable.type, 'moderation_quality'); assert.equal(durable.status, 'open'); assert.equal(durable.country, 'UG'); assert.equal(String(durable.productId), String(review.targetObjectId)); assert.equal(String(durable.storeId), String(stores.UG._id));
          assert.equal(await TrustCase.countDocuments({ qaReviewId: review._id }), 1);
          const href = '/moderation/risk-cases?record=' + durable.publicId + '&country=UG';
          const alerts = await Notification.find({ type: 'moderation_work', href }).lean(), recipients = new Set(alerts.map(row => String(row.userId)));
          assert.ok(recipients.has(String(owner.user._id))); assert.ok(recipients.has(String(single.user._id)));
          for (const excluded of [second, foreignOperator, customer]) assert.ok(!recipients.has(String(excluded.user._id)), 'Saved preferences and current market roles govern QA escalation alerts.');
          assert.ok(alerts.length > 0); assert.ok(alerts.every(row => row.country === 'UG' && row.importance === 'normal'));
          for (const alert of alerts) assert.ok(!JSON.stringify(alert).includes(completion(outcome).note), 'QA notes stay out of work alerts.');
        }
      }
      const summary = await loadModerationReportPage(scoped(), 'moderator-reports'); assert.equal(summary.summary.completedQaCount, 3); assert.equal(summary.summary.upheldQaCount, 1); assert.equal(summary.summary.coachingQaCount, 1); assert.equal(summary.summary.escalatedQaCount, 1); assert.equal(summary.summary.decisionQuality, 33.3);
      const empty = await loadModerationReportPage(scoped(owner, { country: 'KE' }), 'moderator-overview'); assert.equal(empty.summary.completedQaCount, 0); assert.equal(empty.summary.decisionQuality, null);
      const escalations = await owner.client.get('/moderation/reports?report=qa&status=escalated').set('Accept', 'application/json').expect(200); assert.equal(escalations.body.page.total, 1); assert.equal(escalations.body.items[0].escalationCasePublicId, (await latest(qa.UG[2].publicId)).escalationCasePublicId);
    });
    await t.test('seller verification QA joins the actual store owner and preserves the original reviewed evidence', async () => {
      const verification = await SellerVerification.findOne({ storeId: verificationStore._id });
      verification.status = 'approved'; verification.reviewedAt = decisionAt; verification.reviewedByUserId = original.user._id; verification.reviewReason = 'Recorded seller identity decision.';
      verification.reviewHistory.push({ action: 'approve', actorUserId: original.user._id, reason: verification.reviewReason, at: decisionAt });
      verification.increment(); await verification.save();
      const review = await ModerationQaReview.create({ publicId: `mqa_verification_mr_${suffix}`, targetType: 'seller_verification', targetObjectId: verification._id, targetPublicId: verification.publicId,
        country: 'UG', decision: 'approved', decisionReason: verification.reviewReason, decisionVersionSnapshot: verification.__v, decisionEventAt: decisionAt, originalReviewerUserId: original.user._id, sampledAt });
      const selected = await loadModerationReportPage(scoped(owner, { report: 'qa', country: 'UG', record: review.publicId }), 'moderator-reports'); assert.equal(selected.selectedQa.provenanceVerified, true); assert.equal(selected.selectedQa.storePublicId, verificationStore.publicId);
      await act(owner, review, 'claim'); await act(owner, review, 'complete', completion('upheld'));
      const after = await SellerVerification.findById(verification._id); assert.equal(after.reviewReason, verification.reviewReason); assert.deepEqual(after.reviewHistory.toObject(), verification.reviewHistory.toObject());
      const completed = await latest(review.publicId); assert.equal(completed.status, 'completed'); assert.equal(completed.outcome, 'upheld');
      const forgedOwner = await actor('seller'), forgedStore = await Store.create({ publicId: `str_forged_verification_mr_${suffix}`, ownerUserId: forgedOwner.user._id, name: 'Forged owner fixture', slug: `mr-forged-owner-${suffix}`, country: 'UG', currency: 'UGX', status: 'verified' });
      const forged = await SellerVerification.create({ publicId: `svr_forged_owner_mr_${suffix}`, storeId: forgedStore._id, userId: customer.user._id, sellerType: 'individual', legalName: 'FORGED_LEGAL_NAME_PRIVATE', status: 'approved', reviewedAt: decisionAt,
        reviewedByUserId: original.user._id, reviewReason: verification.reviewReason, reviewHistory: [{ action: 'approve', actorUserId: original.user._id, reason: verification.reviewReason, at: decisionAt }] });
      const badReview = await ModerationQaReview.create({ publicId: `mqa_forged_owner_mr_${suffix}`, targetType: 'seller_verification', targetObjectId: forged._id, targetPublicId: forged.publicId,
        country: 'UG', decision: 'approved', decisionReason: verification.reviewReason, decisionVersionSnapshot: 0, decisionEventAt: decisionAt, originalReviewerUserId: original.user._id, sampledAt });
      await assert.rejects(act(owner, badReview, 'claim'), error => error.status === 404);
      await owner.client.get('/moderation/reports?report=qa&record=' + badReview.publicId).set('Accept', 'application/json').expect(404);
    });
    await t.test('a completed row without authoritative QA audit cannot inflate observed quality', async () => {
      await ModerationQaReview.updateOne({ _id: qa.KE[0]._id }, { $set: { status: 'completed', outcome: 'upheld', reviewedAt: now, qaReviewerUserId: owner.user._id } });
      const result = await loadModerationReportPage(scoped(owner, { country: 'KE' }), 'moderator-reports'); assert.equal(result.summary.completedQaCount, 0); assert.equal(result.summary.decisionQuality, null);
      await AuditLog.create({ requestId: `req_forged_outcome_mr_${suffix}`, action: 'moderation.qa_reviewed', targetType: 'moderation_qa', targetPublicId: qa.KE[0].publicId, country: 'KE', actorId: original.user._id, metadata: { outcome: 'upheld' }, result: 'success', createdAt: now });
      const forged = await loadModerationReportPage(scoped(owner, { country: 'KE' }), 'moderator-reports'); assert.equal(forged.summary.completedQaCount, 0); assert.equal(forged.summary.decisionQuality, null);
    });
    await t.test('audit failure rolls QA, escalation creation and authorization fences back together', async () => {
      const review = qa.UG[6]; await act(owner, review, 'claim');
      const before = await latest(review.publicId), beforeActor = await User.findById(owner.user._id), beforeGrant = await PlatformGrant.findById(owner.grant._id), beforeMarket = await CountrySetting.findOne({ code: 'UG' }), casesBefore = await TrustCase.countDocuments(), notificationsBefore = await Notification.countDocuments(), originalCreate = AuditLog.create;
      AuditLog.create = function (documents, ...args) { if ((Array.isArray(documents) ? documents : [documents]).some(row => row.action === 'moderation.qa_reviewed')) throw new Error('Injected authoritative QA audit failure'); return originalCreate.call(this, documents, ...args); };
      try { await assert.rejects(act(owner, review, 'complete', completion('escalated')), /Injected authoritative QA audit failure/); }
      finally { AuditLog.create = originalCreate; }
      assert.deepEqual((await latest(review.publicId)).toObject(), before.toObject()); assert.equal(await TrustCase.countDocuments(), casesBefore);
      assert.equal(await Notification.countDocuments(), notificationsBefore);
      assert.equal((await User.findById(owner.user._id)).__v, beforeActor.__v); assert.equal((await PlatformGrant.findById(owner.grant._id)).__v, beforeGrant.__v); assert.equal((await CountrySetting.findOne({ code: 'UG' })).__v, beforeMarket.__v);
      assert.equal(await AuditLog.countDocuments({ action: 'moderation.qa_reviewed', targetPublicId: review.publicId }), 0);
    });
    await t.test('streaming exports stop before another row after grants or calendar configuration change', async () => {
      for (const report of ['summary', 'qa']) {
        const output = new EventEmitter(), chunks = []; let ended = false;
        output.destroyed = false; output.set = () => output; output.end = () => { ended = true; };
        output.write = text => { chunks.push(text); if (chunks.length === 2) { const mutation = report === 'summary' ? PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { status: 'revoked' } }) : CountrySetting.updateOne({ code: 'UG' }, { $set: { timeZone: 'UTC' } }); Promise.resolve(mutation).then(() => output.emit('drain'), error => output.emit('error', error)); return false; } return true; };
        try { await assert.rejects(streamModerationReportCsv(scoped(owner, { report }), output, 'moderator-reports'), error => error.status === 403); assert.equal(chunks.length, 2); assert.equal(ended, false); }
        finally { await PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { status: 'active' } }); await CountrySetting.updateOne({ code: 'UG' }, { $set: { timeZone: 'Africa/Kampala' } }); }
      }
    });
    await t.test('current grant, account, authenticator and operational calendar govern direct and HTTP reports', async () => {
      await assert.rejects(loadModerationReportPage(scoped(customer), 'moderator-reports'), error => error.status === 403);
      await User.updateOne({ _id: owner.user._id }, { $set: { 'security.mfaEnabled': false } }); await assert.rejects(loadModerationReportPage(scoped(), 'moderator-reports'), error => error.code === 'MFA_ENROLLMENT_REQUIRED');
      await assert.rejects(act(owner, qa.UG[7], 'claim'), error => error.code === 'MFA_ENROLLMENT_REQUIRED');
      await User.updateOne({ _id: owner.user._id }, { $set: { 'security.mfaEnabled': true } });
      await PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { status: 'revoked' } }); await assert.rejects(loadModerationReportPage(scoped(), 'moderator-reports'), error => error.code === 'MODERATION_GRANT_UNAVAILABLE');
      await assert.rejects(act(owner, qa.UG[7], 'claim'), error => error.code === 'MODERATION_GRANT_UNAVAILABLE');
      await owner.client.get('/moderation/reports').set('Accept', 'application/json').expect(403); await PlatformGrant.updateOne({ _id: owner.grant._id }, { $set: { status: 'active' } });
      await User.updateOne({ _id: owner.user._id }, { $set: { status: 'suspended' } }); await assert.rejects(act(owner, qa.UG[7], 'claim'), error => error.code === 'ACCOUNT_UNAVAILABLE');
      await User.updateOne({ _id: owner.user._id }, { $set: { status: 'active' } });
      await User.updateOne({ _id: owner.user._id }, { $set: { 'preferences.moderationReportingPeriod': 'year', 'preferences.moderationDefaultCountry': 'UG', currency: 'TZS' } });
      const preferred = await loadModerationReportPage(scoped(), 'moderator-overview'); assert.equal(preferred.period, 'year'); assert.equal(preferred.country, 'UG'); assert.equal(preferred.timeZone, 'Africa/Kampala'); assert.equal(preferred.context.currency, 'UGX');
      assert.equal((await User.findById(owner.user._id)).role, 'customer'); assert.equal(await Store.countDocuments({ ownerUserId: owner.user._id }), 0);
      await User.updateOne({ _id: owner.user._id }, { $inc: { 'security.tokenVersion': 1 } }); await assert.rejects(act(owner, qa.UG[7], 'claim'), error => error.code === 'ACCOUNT_UNAVAILABLE');
    });
  } finally {
    for (const transport of transports) transport.destroy();
    try { await Promise.all(Object.values(mongoose.models).map(Model => Model.init())); await mongoose.connection.dropDatabase(); }
    finally { await mongoose.disconnect(); }
  }
});

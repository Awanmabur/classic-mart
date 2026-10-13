import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import request from 'supertest';
import sharp from 'sharp';

const suffix = crypto.randomBytes(8).toString('hex');
process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
process.env.UPLOAD_DIR = `/tmp/classicmart-moderation-catalogue-test-${suffix}`;
for (const name of ['SESSION_SECRET', 'TOKEN_PEPPER', 'SECURITY_INTEGRITY_KEY', 'DATA_ENCRYPTION_KEY']) process.env[name] = crypto.randomBytes(32).toString('hex');
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;
const routes = Object.freeze({
  'moderator-overview': '/moderation/overview', 'moderator-products': '/moderation/products',
  'moderator-reviews': '/moderation/reviews', 'moderator-sellers': '/moderation/verifications',
  'moderator-disputes': '/moderation/risk-cases', 'moderator-audit': '/moderation/audit',
  'moderator-reports': '/moderation/reports', 'moderator-settings': '/moderation/settings',
});
function csrf(html) {
  const match = html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/);
  assert.ok(match, 'An authenticated real page must provide CSRF.');
  return match[1];
}

test('Moderation catalogue uses real grants, evidence, independent review and seller publication with current source-country authorization', { skip: !uri, timeout: 360_000 }, async t => {
  const parsedUri = new URL(uri);
  assert.equal(parsedUri.hostname, '127.0.0.1');
  assert.equal(parsedUri.port, '27019', 'Only the dedicated loopback live-test replica set is authorized.');
  assert.match(parsedUri.pathname, /verification|test/i);
  const database = `classicmart_moderation_catalogue_test_${suffix}`, transports = [];
  await mongoose.connect(uri, { dbName: database });
  try {
    const { createApp } = await import('../src/app.js');
    const { User, PlatformGrant, CountrySetting, Store, StoreMember, SellerVerification, VerificationDocument,
      Category, Product, ProductVariant, ProductMedia, Warehouse, StockItem, AuditLog, Notification, OutboxEvent,
      ModerationQaReview, Device } = await import('../src/models/index.js');
    const { hashPassword, hashToken } = await import('../src/core/crypto.js');
    const { encryptSensitive } = await import('../src/core/sensitive.js');
    const { beginMfaEnrollment, confirmMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
    const { loadModerationCataloguePage, streamModerationCatalogueCsv } = await import('../src/services/moderation-catalogue-pages.js');
    const { reviewProduct, reviewerProductDetail } = await import('../src/services/product-moderation.js');
    const { reviewSellerVerification, reviewerVerificationRecord, readableVerificationDocument } = await import('../src/services/seller-verification.js');
    const { readVerificationDocumentBuffer } = await import('../src/services/verification-media.js');
    const { readMediaObjectBuffer } = await import('../src/services/object-storage.js');
    const { env } = await import('../src/config/env.js');
    assert.equal(env.mediaStorageDriver, 'filesystem');
    assert.equal(env.uploadDir, process.env.UPLOAD_DIR);
    await Promise.all(Object.values(mongoose.models).map(Model => Model.init()));
    await CountrySetting.create([
      { code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true },
      { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254', active: true },
      { code: 'TZ', name: 'Unassigned catalogue market', currency: 'TZS', locale: 'en-TZ', timeZone: 'Africa/Dar_es_Salaam', phonePrefix: '+255', active: true },
    ]);
    const app = createApp(null), password = `Moderation-Catalogue-${suffix}-A1!`, passwordHash = await hashPassword(password);
    const png = await sharp({ create: { width: 640, height: 640, channels: 3, background: '#e6aa70' } })
      .withMetadata({ exif: { IFD0: { Artist: 'CATALOGUE_PRIVATE_CAMERA_METADATA' } } }).png().toBuffer();
    let sequence = 0, requestSequence = 0;
    async function actor(role = 'customer', { managed = role === 'customer', countries = ['UG', 'KE'], country = 'UG', mfa = true } = {}) {
      const index = ++sequence, email = `moderation-catalogue-${suffix}-${index}@example.com`, phone = '+25670' + String(index).padStart(7, '0');
      let user = await User.create({ publicId: `usr_mcat_${suffix}_${index}`, name: `Catalogue Actor ${index}`, email, emailNormalized: email,
        phone, phoneNormalized: phone, passwordHash, role, country, shoppingCountry: 'TZ', currency: 'TZS', operationalCountries: ['TZ'],
        platformAccessManagedAt: managed ? new Date() : undefined, emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
        consents: { terms: true, privacy: true, recordedAt: new Date() } });
      if (!managed) await User.updateOne({ _id: user._id }, { $set: { operationalCountries: countries, shoppingCountry: country, currency: country === 'KE' ? 'KES' : 'UGX' } });
      const grant = managed ? await PlatformGrant.create({ publicId: `pgr_mcat_${suffix}_${index}`, userId: user._id, role: 'moderator',
        operationalCountries: countries, status: 'active', startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000),
        reason: 'Isolated genuine catalogue Moderation verification.', approvalPublicId: `apr_mcat_${suffix}_${index}`, approvedByUserId: new mongoose.Types.ObjectId() }) : null;
      let secret;
      if (mfa) {
        const enrollment = await beginMfaEnrollment(user._id, password); secret = enrollment.secret;
        await confirmMfaEnrollment(user._id, totpCode(secret, { time: Date.now() - 30_000 }));
        const enrolled = await User.findById(user._id).select('+security.mfaSecretEncrypted +security.mfaRecoveryCodeHashes');
        assert.equal(enrolled.security.mfaEnabled, true);
        assert.match(enrolled.security.mfaSecretEncrypted, /^v1:/);
        assert.equal(enrolled.security.mfaRecoveryCodeHashes.length, 10);
      }
      user = await User.findById(user._id);
      const transport = new http.Agent({ localAddress: `127.0.0.${index + 30}`, keepAlive: false }); transports.push(transport);
      const agent = request.agent(app).use(req => req.agent(transport)), form = await agent.get('/login').expect(200);
      const signedIn = await agent.post('/login').type('form').send({ email, password, _csrf: csrf(form.text) }).expect(302);
      let sessionResponse = signedIn;
      if (mfa) {
        assert.equal(signedIn.headers.location, '/mfa');
        const challenge = await agent.get('/mfa').expect(200);
        sessionResponse = await agent.post('/mfa').type('form').send({ code: totpCode(secret), _csrf: csrf(challenge.text) }).expect(302);
      }
      assert.equal(await Device.countDocuments({ userId: user._id, revokedAt: null }), 1);
      const cookie = (sessionResponse.headers['set-cookie'] || []).find(value => value.startsWith('cm.sid='));
      assert.ok(cookie, 'The actual authenticated session must issue a signed session cookie.');
      const signedCookie = decodeURIComponent(cookie.split(';')[0].slice('cm.sid='.length));
      assert.ok(signedCookie.startsWith('s:'));
      const sessionID = signedCookie.slice(2, signedCookie.lastIndexOf('.'));
      const device = await Device.findOne({ userId: user._id, revokedAt: null }).select('+sessionHash');
      assert.equal(hashToken(sessionID), device.sessionHash, 'The captured session identity must be the real persisted Device.');
      return { user: await User.findById(user._id), grant, secret, agent, signedIn, sessionID, device };
    }
    const moderator = await actor(), contender = await actor(), foreign = await actor('customer', { countries: ['KE'] });
    const owner = await actor('seller', { managed: false, countries: ['UG'] });
    async function core(entry, { query = {}, publicId, body = {} } = {}) {
      const user = await User.findById(entry.user._id);
      return { id: `req_mcat_${suffix}_${++requestSequence}`, user, session: { tokenVersion: user.security.tokenVersion }, query,
        params: publicId ? { publicId } : {}, body, ip: '127.0.0.40', get: () => 'CatalogueLiveVerification/1.0' };
    }
    async function webCore(entry, options) {
      const req = await core(entry, options);
      req.sessionID = entry.sessionID; req.device = entry.device; req.session.userId = String(entry.user._id);
      return req;
    }
    async function post(entry, base, action, Model, fields = {}) {
      const page = await entry.agent.get(base).expect(200), record = await Model.findOne({ publicId: base.split('/').at(-1) });
      return entry.agent.post(base + '/' + action).type('form').send({ version: record.__v, _csrf: csrf(page.text), ...fields });
    }
    const ownerPage = await owner.agent.get('/seller/verification').expect(200), ownerStore = await Store.findOne({ ownerUserId: owner.user._id });
    let verification = await SellerVerification.findOne({ storeId: ownerStore._id });
    assert.equal(ownerStore.country, 'UG'); assert.equal(ownerStore.status, 'pending_verification');
    const registration = 'CATALOGUE_PRIVATE_REGISTRATION_' + suffix, taxNumber = 'CATALOGUE_PRIVATE_TAX_' + suffix;
    async function uploadDocument(entry, type, bytes = png, contentType = 'image/png') {
      const page = await entry.agent.get('/seller/verification').expect(200), store = await Store.findOne({ ownerUserId: entry.user._id });
      const record = await SellerVerification.findOne({ storeId: store._id });
      return entry.agent.post('/seller/verification/documents').field('_csrf', csrf(page.text)).field('version', String(record.__v))
        .field('documentType', type).attach('document', bytes, { filename: 'evidence.png', contentType });
    }
    async function submitVerification() {
      const page = await owner.agent.get('/seller/verification').expect(200), record = await SellerVerification.findById(verification._id);
      return owner.agent.post('/seller/verification/submit').type('form').send({ _csrf: csrf(page.text), version: record.__v,
        sellerType: 'business', legalName: 'Catalogue Verified Business', registrationNumber: registration, taxNumber, declaration: 'yes' });
    }
    let identity;
    await t.test('seller evidence is a real encrypted sanitized upload; current required documents gate submission', async () => {
      assert.match(ownerPage.text, /Seller Verification/);
      assert.equal((await submitVerification()).status, 422);
      const count = await VerificationDocument.countDocuments();
      await owner.agent.post('/seller/verification/documents').field('documentType', 'identity').field('version', String(verification.__v))
        .attach('document', png, { filename: 'missing-csrf.png', contentType: 'image/png' }).expect(403);
      assert.equal(await VerificationDocument.countDocuments(), count);
      assert.equal((await uploadDocument(owner, 'identity', Buffer.from('invalid image'))).status, 422);
      assert.equal((await uploadDocument(owner, 'identity')).status, 302);
      assert.equal((await submitVerification()).status, 422, 'A business cannot submit with only identity evidence.');
      assert.equal((await uploadDocument(owner, 'registration')).status, 302);
      identity = await VerificationDocument.findOne({ verificationId: verification._id, documentType: 'identity', status: 'ready' }).select('+storageKey');
      const encrypted = await readMediaObjectBuffer(identity.storageKey);
      assert.equal(identity.encrypted, true); assert.equal(encrypted.subarray(0, 4).toString(), 'CMV1');
      const sanitized = await readVerificationDocumentBuffer(identity), metadata = await sharp(sanitized).metadata();
      assert.equal(metadata.format, 'webp'); assert.equal(metadata.exif, undefined);
      assert.equal(sanitized.includes(Buffer.from('CATALOGUE_PRIVATE_CAMERA_METADATA')), false);
      assert.equal((await submitVerification()).status, 302);
      verification = await SellerVerification.findById(verification._id).select('+registrationNumber +taxNumber');
      assert.equal(verification.status, 'submitted'); assert.match(verification.registrationNumber, /^v1:/);
      assert.ok(await Notification.exists({ userId: moderator.user._id, country: 'UG', type: 'moderation_work', title: 'High risk work awaiting review', href: '/moderation/verifications?record=' + verification.publicId + '&country=UG' }), 'The genuine business submission drives the saved priority alert workflow.');
      assert.doesNotMatch(verification.registrationNumber, /CATALOGUE_PRIVATE/);
    });

    const category = await Category.create({ publicId: `cat_mcat_${suffix}`, name: 'Catalogue everyday goods', slug: `mcat-${suffix}`,
      countries: ['UG', 'KE', 'TZ'], active: true });
    const restrictedCategory = await Category.create({ publicId: `cat_mcat_restricted_${suffix}`, name: 'Catalogue restricted goods', slug: `mcat-restricted-${suffix}`,
      countries: ['UG', 'KE', 'TZ'], active: true, restricted: true });
    const stores = {}, products = {}, verifications = {}, now = new Date();
    let fixtureSequence = 0;
    async function fixtureSeller(country, currency) {
      const index = ++fixtureSequence, email = `catalogue-fixture-${suffix}-${index}@example.com`;
      const phone = ({ UG: '+25678', KE: '+25471', TZ: '+25571' })[country] + String(index).padStart(7, '0');
      return User.create({ publicId: `usr_mcat_fixture_${suffix}_${index}`, name: `Catalogue ${country} seller ${index}`,
        email, emailNormalized: email, phone, phoneNormalized: phone, passwordHash, role: 'seller', country, currency,
        shoppingCountry: country, emailVerifiedAt: now, onboardingCompletedAt: now,
        consents: { terms: true, privacy: true, recordedAt: now } });
    }
    for (const [country, currency, amount] of [['UG', 'UGX', 31], ['KE', 'KES', 3], ['TZ', 'TZS', 2]]) {
      const sourceOwner = await fixtureSeller(country, currency);
      stores[country] = await Store.create({ publicId: `str_mcat_${country}_${suffix}`, ownerUserId: sourceOwner._id, name: `Catalogue source store ${country}`,
        slug: `mcat-source-${country.toLowerCase()}-${suffix}`, country, currency, status: 'verified', verifiedAt: now });
      products[country] = await Product.create(Array.from({ length: amount }, (_, index) => ({ publicId: `prd_mcat_${country}_${suffix}_${index}`,
        ownerUserId: sourceOwner._id, storeId: stores[country]._id, categoryId: category._id, title: country === 'UG' && index === 0 ? '=HYPERLINK("https://example.invalid","unsafe formula")' : `Catalogue ${country} listing ${index}`,
        slug: `mcat-${country.toLowerCase()}-${suffix}-${index}`, description: 'An actual persisted submitted catalogue listing for bounded source-country queue verification.',
        countries: country === 'UG' ? ['TZ'] : ['UG'], status: 'submitted', moderation: { submittedAt: now, riskLevel: index % 3 === 0 ? 'high' : 'standard',
          assignedUserId: country === 'UG' && index === 1 ? moderator.user._id : country === 'UG' && index === 2 ? contender.user._id : null } })));
      const applicantOwners = await Promise.all(Array.from({ length: amount }, () => fixtureSeller(country, currency)));
      const queueStores = await Store.create(Array.from({ length: amount }, (_, index) => ({ publicId: `str_mcat_ver_${country}_${suffix}_${index}`,
        ownerUserId: applicantOwners[index]._id, name: `Catalogue applicant ${country} ${index}`, slug: `mcat-applicant-${country.toLowerCase()}-${suffix}-${index}`,
        country, currency, status: 'pending_verification' })));
      verifications[country] = await SellerVerification.create(queueStores.map((store, index) => ({ publicId: `kyc_mcat_${country}_${suffix}_${index}`,
        storeId: store._id, userId: applicantOwners[index]._id, sellerType: index % 2 === 0 ? 'business' : 'individual', legalName: `Catalogue legal applicant ${country} ${index}`,
        registrationNumber: encryptSensitive('CATALOGUE_PRIVATE_QUEUE_REGISTRATION_' + index), status: index === 1 ? 'appealed' : 'submitted', submittedAt: now,
        assignedUserId: country === 'UG' && index === 1 ? moderator.user._id : country === 'UG' && index === 2 ? contender.user._id : null })));
    }
    const archivedOwner = await fixtureSeller('UG', 'UGX');
    const archivedStore = await Store.create({ publicId: `str_mcat_archived_${suffix}`, ownerUserId: archivedOwner._id, name: 'Archived source store must be absent',
      slug: `mcat-archived-${suffix}`, country: 'UG', currency: 'UGX', status: 'closed' });
    const archivedProduct = await Product.create({ publicId: `prd_mcat_archived_${suffix}`, ownerUserId: archivedOwner._id, storeId: archivedStore._id,
      categoryId: category._id, title: 'Archived source product must be absent', slug: `mcat-archived-product-${suffix}`, description: 'A submitted record under an archived source store.',
      countries: ['UG'], status: 'submitted', moderation: { submittedAt: now } });
    const archivedVerification = await SellerVerification.create({ publicId: `kyc_mcat_archived_${suffix}`, storeId: archivedStore._id, userId: archivedOwner._id,
      sellerType: 'individual', legalName: 'Archived source verification must be absent', status: 'submitted', submittedAt: now });
    await t.test('all eight real pages retain the approved Moderator shell and default Overview with stored customer identity', async () => {
      assert.equal(moderator.signedIn.headers.location, '/mfa');
      assert.equal((await moderator.agent.get('/dashboard').expect(302)).headers.location, '/moderation/overview');
      for (const [id, href] of Object.entries(routes)) {
        const page = await moderator.agent.get(href).expect(200);
        assert.match(page.text, /data-dashboard-workspace="moderator"/);
        assert.ok(page.text.includes(`data-dashboard-page="${id}"`));
        for (const destination of Object.values(routes)) assert.ok(page.text.includes(`href="${destination}"`), href + ':' + destination);
        assert.doesNotMatch(page.text, /Development preview|id="roleSwitcher"|data-dashboard-workspace="seller"|CATALOGUE_PRIVATE_/);
        assert.match(page.headers['cache-control'], /no-store/); assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
      }
      assert.equal((await User.findById(moderator.user._id)).role, 'customer');
      assert.equal(await Store.countDocuments({ ownerUserId: moderator.user._id }), 0);
      await moderator.agent.get('/dashboard/moderator-products?country=UG&search=retained%20query').expect(308).expect('location', '/moderation/products?country=UG&search=retained%20query');
      await moderator.agent.get('/dashboard/moderator-sellers?country=UG').expect(308).expect('location', '/moderation/verifications?country=UG');
      const unenrolled = await actor('customer', { mfa: false });
      await unenrolled.agent.get('/moderation/products').expect(302).expect('location', '/account/security?next=%2Fmoderation%2Fproducts');
      await unenrolled.agent.get('/moderation/products').set('Accept', 'application/json').expect(403);
      await assert.rejects(loadModerationCataloguePage(await core(unenrolled), 'moderator-products'), error => error.code === 'MFA_ENROLLMENT_REQUIRED');
      assert.equal(await Store.countDocuments({ ownerUserId: unenrolled.user._id }), 0);
    });

    await t.test('product and verification lists/counts/cursors scope the source Store.country across more than 25 tied-date rows', async () => {
      for (const [pageId, expected, ugTotal, high] of [
        ['moderator-products', [...products.UG, ...products.KE], 31, 11],
        ['moderator-sellers', [verification, ...verifications.UG, ...verifications.KE], 32, 17],
      ]) {
        let after = '', seen = [], batches = 0;
        do {
          const flow = await loadModerationCataloguePage(await core(moderator, { query: { country: '', after } }), pageId);
          assert.equal(flow.page.total, expected.length); assert.ok(flow.page.count <= 25);
          assert.ok(flow.items.every(row => ['UG', 'KE'].includes(row.store.country)));
          assert.equal(flow.items.some(row => row.publicId === archivedProduct.publicId || row.publicId === archivedVerification.publicId), false);
          assert.ok(flow.items.every(row => row.registrationNumber === undefined && row.taxNumber === undefined && row.documents === undefined && row.ownerUserId === undefined));
          seen.push(...flow.items.map(row => row.publicId)); batches++;
          if (!flow.page.hasMore) break;
          assert.ok(flow.page.next); assert.notEqual(flow.page.next, after); after = flow.page.next;
        } while (batches < 5);
        assert.equal(batches, 2); assert.equal(new Set(seen).size, seen.length);
        assert.deepEqual([...seen].sort(), expected.map(row => row.publicId).sort());
        const ug = await loadModerationCataloguePage(await core(moderator, { query: { country: 'UG' } }), pageId);
        assert.equal(ug.page.total, ugTotal); assert.equal(ug.metrics[0].value, ugTotal); assert.equal(ug.metrics[1].value, high);
        assert.equal(ug.metrics[2].value, 1); assert.equal(ug.metrics[3].value, ugTotal - 2);
        const mine = await loadModerationCataloguePage(await core(moderator, { query: { country: 'UG', assignment: 'mine' } }), pageId);
        assert.equal(mine.page.total, 1); assert.equal(mine.items[0].assignment, 'Assigned to you');
        assert.equal((await loadModerationCataloguePage(await core(moderator, { query: { country: 'UG', risk: 'high' } }), pageId)).page.total, high);
        const scopedForeign = await loadModerationCataloguePage(await core(foreign), pageId);
        assert.equal(scopedForeign.page.total, 3); assert.ok(scopedForeign.items.every(row => row.country === 'KE'));
      }
      const bySource = await loadModerationCataloguePage(await core(moderator, { query: { country: 'UG', search: products.UG[0].publicId } }), 'moderator-products');
      assert.equal(bySource.items[0].publicId, products.UG[0].publicId, 'Product selling countries never override the source Store.country.');
      assert.equal((await loadModerationCataloguePage(await core(moderator, { query: { country: 'UG', search: products.KE[0].publicId } }), 'moderator-products')).page.total, 0);
      for (const path of ['/moderation/products', '/moderation/verifications']) {
        for (const query of ['country=TZ', 'country=ug', 'country=UG&country=KE', 'assignment=unknown', 'after=invalid-cursor']) {
          await moderator.agent.get(path + '?' + query).set('Accept', 'application/json').expect(query === 'country=TZ' ? 403 : 422);
        }
      }
    });

    await t.test('private verification detail masks identifiers and document reads authorize the current matching case and grant', async () => {
      const base = '/moderation/verifications/' + verification.publicId, selected = (await moderator.agent.get(base).set('Accept', 'application/json').expect(200)).body.selected.reviewFlow;
      assert.equal(selected.record.registrationNumber, '•••• ' + registration.slice(-3));
      assert.equal(selected.record.taxNumber, '•••• ' + taxNumber.slice(-3));
      assert.equal(selected.record.userId, undefined); assert.equal(selected.record.storeId, undefined);
      assert.equal(JSON.stringify(selected).includes(registration), false);
      assert.ok(selected.documents.every(row => row.storageKey === undefined && row.checksumSha256 === undefined));
      const privateImage = await moderator.agent.get(base + '/documents/' + identity.publicId).expect(200);
      assert.equal(privateImage.headers['content-type'], 'image/webp'); assert.match(privateImage.headers['cache-control'], /no-store/);
      assert.equal(await AuditLog.countDocuments({ action: 'seller.verification_document_viewed', targetPublicId: identity.publicId, country: 'UG' }), 1);
      await foreign.agent.get(base + '/documents/' + identity.publicId).set('Accept', 'application/json').expect(404);
      await foreign.agent.get('/media/verification/' + identity.publicId).set('Accept', 'application/json').expect(403);
      await request(app).get('/media/verification/' + identity.publicId).set('Accept', 'application/json').expect(401);
      await moderator.agent.get('/moderation/verifications/' + verifications.UG[0].publicId + '/documents/' + identity.publicId).set('Accept', 'application/json').expect(404);
      await moderator.agent.get(base + '?country=KE').set('Accept', 'application/json').expect(404);
      await moderator.agent.get('/moderation/products/' + products.UG[0].publicId + '?country=KE').set('Accept', 'application/json').expect(404);
      await owner.agent.get('/media/verification/' + identity.publicId).expect(200);
      await assert.rejects(reviewerProductDetail(await core(foreign), products.UG[0].publicId), error => error.code === 'MODERATION_COUNTRY_FORBIDDEN');
      await assert.rejects(reviewerVerificationRecord(await core(foreign), verification.publicId), error => error.code === 'MODERATION_COUNTRY_FORBIDDEN');
      await foreign.agent.get('/moderation/products/' + products.UG[0].publicId).set('Accept', 'application/json').expect(404);
      await foreign.agent.get(base).set('Accept', 'application/json').expect(404);
    });

    function writable(onWrite) {
      const output = new EventEmitter(); output.destroyed = false; output.chunks = []; output.ended = false;
      output.type = () => output; output.set = () => output; output.end = () => { output.ended = true; };
      output.write = value => { output.chunks.push(String(value)); return onWrite ? onWrite(output, output.chunks.length) : true; };
      return output;
    }
    await t.test('complete CSV exports traverse every page, protect formulas and omit private evidence', async () => {
      for (const [path, expected] of [['/moderation/products', [...products.UG, ...products.KE]], ['/moderation/verifications', [verification, ...verifications.UG, ...verifications.KE]]]) {
        const result = await moderator.agent.get(path + '/export.csv?country=').expect(200);
        assert.match(result.headers['content-type'], /text\/csv/); assert.match(result.headers['cache-control'], /no-store/);
        assert.equal(result.text.trim().split('\r\n').length, expected.length + 1);
        for (const row of expected) assert.equal(result.text.split('"' + row.publicId + '"').length - 1, 1, 'Every persisted record exports once.');
        assert.doesNotMatch(result.text, /CATALOGUE_PRIVATE_|storageKey|registrationNumber|taxNumber/);
        for (const forbidden of [...products.TZ, ...verifications.TZ, archivedProduct, archivedVerification]) assert.equal(result.text.includes(forbidden.publicId), false);
        if (path.endsWith('products')) assert.ok(result.text.includes('"\'=HYPERLINK(""https://example.invalid""'), 'A stored formula-like product title is exported as literal text.');
      }
    });
    await t.test('CSV header backpressure rechecks narrowed grants before data; write errors and disconnects clean listeners', async () => {
      const entry = await actor(), req = await core(entry, { query: { country: '' } });
      const output = writable((response, count) => {
        if (count !== 1) return true;
        queueMicrotask(() => { void PlatformGrant.updateOne({ _id: entry.grant._id }, { $set: { operationalCountries: ['UG'] } })
          .then(() => response.emit('drain'), error => response.emit('error', error)); });
        return false;
      });
      await assert.rejects(streamModerationCatalogueCsv(req, output, 'moderator-products'), error => error.code === 'MODERATION_SCOPE_CHANGED');
      assert.equal(output.chunks.length, 1); assert.equal(output.ended, false);
      for (const event of ['drain', 'close', 'error']) assert.equal(output.listenerCount(event), 0);
      const failure = new Error('Writable catalogue export failed');
      const broken = writable((response, count) => { if (count === 1) { queueMicrotask(() => response.emit('error', failure)); return false; } return true; });
      await assert.rejects(streamModerationCatalogueCsv(await core(moderator), broken, 'moderator-sellers'), error => error === failure);
      assert.equal(broken.chunks.length, 1); assert.equal(broken.ended, false);
      for (const event of ['drain', 'close', 'error']) assert.equal(broken.listenerCount(event), 0);
      const closed = writable((response, count) => { if (count === 1) { queueMicrotask(() => { response.destroyed = true; response.emit('close'); }); return false; } return true; });
      await streamModerationCatalogueCsv(await core(moderator), closed, 'moderator-products');
      assert.equal(closed.chunks.length, 1); assert.equal(closed.ended, false);
      for (const event of ['drain', 'close', 'error']) assert.equal(closed.listenerCount(event), 0);
    });
    await t.test('a real authenticated Device revoked during export backpressure stops before any catalogue data', async () => {
      const entry = await actor(), req = await webCore(entry, { query: { country: '' } });
      const output = writable((response, count) => {
        if (count !== 1) return true;
        queueMicrotask(() => { void Device.updateOne({ _id: entry.device._id }, { $set: { revokedAt: new Date(), revokedReason: 'In-flight catalogue export revocation' } })
          .then(() => response.emit('drain'), error => response.emit('error', error)); });
        return false;
      });
      await assert.rejects(streamModerationCatalogueCsv(req, output, 'moderator-products'), error => error.code === 'ACCOUNT_UNAVAILABLE');
      assert.equal(output.chunks.length, 1); assert.equal(output.ended, false);
      for (const event of ['drain', 'close', 'error']) assert.equal(output.listenerCount(event), 0);
      await entry.agent.get('/moderation/products').set('Accept', 'application/json').expect(401);
    });
    await t.test('private document routes recheck real grants and Devices after reading genuine stored evidence bytes', async () => {
      const readFile = fs.readFile.bind(fs), storagePath = process.env.UPLOAD_DIR + '/' + identity.storageKey;
      for (const href of ['/media/verification/' + identity.publicId, '/moderation/verifications/' + verification.publicId + '/documents/' + identity.publicId]) {
        for (const change of ['grant', 'device']) {
          const entry = await actor('customer', { countries: ['UG'] }); let read = false;
          t.mock.method(fs, 'readFile', async (...args) => {
            const bytes = await readFile(...args);
            if (!read && String(args[0]) === storagePath) {
              read = true;
              if (change === 'grant') await PlatformGrant.updateOne({ _id: entry.grant._id }, { $set: { status: 'revoked', revokedAt: new Date() } });
              else await Device.updateOne({ _id: entry.device._id }, { $set: { revokedAt: new Date(), revokedReason: 'In-flight verification evidence revocation' } });
            }
            return bytes;
          });
          try {
            const response = await entry.agent.get(href).set('Accept', 'application/json').expect(403);
            assert.equal(read, true, 'Revocation must occur after the real private object was read.');
            assert.match(response.headers['content-type'], /application\/json/);
            assert.equal(response.headers['content-type'].includes('image/webp'), false);
          } finally { t.mock.restoreAll(); }
        }
      }
    });

    async function effects(entry, target, type) {
      const Model = type === 'product' ? Product : SellerVerification, record = await Model.findById(target._id).lean(), store = await Store.findById(record.storeId).lean();
      return { actorVersion: (await User.findById(entry.user._id)).__v, grantVersion: entry.grant ? (await PlatformGrant.findById(entry.grant._id)).__v : null,
        countries: (await CountrySetting.find().sort({ code: 1 }).lean()).map(row => [row.code, row.__v]),
        categoryVersions: (await Category.find().sort({ _id: 1 }).lean()).map(row => [row.publicId, row.__v]), record, store,
        documents: type === 'product' ? await ProductMedia.find({ productId: target._id }).sort({ _id: 1 }).lean() : await VerificationDocument.find({ verificationId: target._id }).sort({ _id: 1 }).lean(),
        audits: await AuditLog.countDocuments({ targetPublicId: target.publicId }), qa: await ModerationQaReview.countDocuments({ targetPublicId: target.publicId }),
        notices: await Notification.countDocuments({ userId: owner.user._id }), outbox: await OutboxEvent.countDocuments() };
    }
    await t.test('a concurrent real Device revocation at the transaction fence aborts every decision write', async () => {
      const entry = await actor('customer', { countries: ['UG'] }), target = products.UG[4], before = await effects(entry, target, 'product');
      const updateDevice = Device.updateOne.bind(Device); let revoked = false;
      t.mock.method(Device, 'updateOne', async (filter, update, options) => {
        if (!revoked && String(filter._id) === String(entry.device._id) && options?.session?.inTransaction()) {
          revoked = true;
          await Device.collection.updateOne({ _id: entry.device._id }, { $set: { revokedAt: new Date(), revokedReason: 'Concurrent catalogue decision revocation' } });
        }
        return updateDevice(filter, update, options);
      });
      try {
        await assert.rejects(reviewProduct(await webCore(entry, { publicId: target.publicId, body: { version: target.__v } }), 'claim'),
          error => ['ACCOUNT_UNAVAILABLE', 'MODERATION_ACCESS_CHANGED'].includes(error.code));
      } finally { t.mock.restoreAll(); }
      assert.equal(revoked, true, 'An actual independent Device write must race the transactional authorization fence.');
      assert.ok((await Device.findById(entry.device._id)).revokedAt);
      assert.deepEqual(await effects(entry, target, 'product'), before, 'Actor/grant/market/store/target/audit writes must roll back.');
    });
    await t.test('current store ownership, submitting identity and active or invited staff prevent self-review without side effects', async () => {
      const product = products.UG[3], record = verifications.UG[3], store = await Store.findById(record.storeId);
      for (const [Model, target, patch, undo, code] of [
        [Product, product, { ownerUserId: moderator.user._id }, { ownerUserId: product.ownerUserId }, 'REVIEW_CONFLICT_OF_INTEREST'],
        [Store, stores.UG, { ownerUserId: moderator.user._id }, { ownerUserId: stores.UG.ownerUserId }, 'REVIEW_CONFLICT_OF_INTEREST'],
        [SellerVerification, record, { userId: moderator.user._id }, { userId: record.userId }, 'REVIEW_CONFLICT_OF_INTEREST'],
        [Store, store, { ownerUserId: moderator.user._id }, { ownerUserId: store.ownerUserId }, 'REVIEW_CONFLICT_OF_INTEREST'],
      ]) {
        await Model.updateOne({ _id: target._id }, { $set: patch });
        try {
          const isProduct = Model === Product || target._id.equals(stores.UG._id), caseRecord = isProduct ? product : record;
          const before = await effects(moderator, caseRecord, isProduct ? 'product' : 'verification');
          await assert.rejects((isProduct ? reviewProduct : reviewSellerVerification)(await core(moderator, { publicId: caseRecord.publicId, body: { version: caseRecord.__v } }), 'claim'), error => error.code === code);
          assert.deepEqual(await effects(moderator, caseRecord, isProduct ? 'product' : 'verification'), before);
        } finally { await Model.updateOne({ _id: target._id }, { $set: undo }); }
      }
      for (const status of ['active', 'invited']) for (const [target, caseStore, type, review] of [[product, stores.UG, 'product', reviewProduct], [record, store, 'verification', reviewSellerVerification]]) {
        const member = await StoreMember.create({ publicId: `stm_mcat_${suffix}_${++requestSequence}`, storeId: caseStore._id, userId: moderator.user._id,
          invitedByUserId: owner.user._id, role: 'catalogue', status });
        try {
          const before = await effects(moderator, target, type);
          await assert.rejects(review(await core(moderator, { publicId: target.publicId, body: { version: target.__v } }), 'claim'), error => error.code === 'REVIEW_CONFLICT_OF_INTEREST');
          assert.deepEqual(await effects(moderator, target, type), before);
        } finally { await StoreMember.deleteOne({ _id: member._id }); }
      }
    });

    await t.test('verification claims have one winner, stale versions fail, required evidence and audit gate approval, then real approval persists QA and notices', async () => {
      const base = '/moderation/verifications/' + verification.publicId, unclaimed = await SellerVerification.findById(verification._id);
      assert.equal((await post(moderator, base, 'decision', SellerVerification, { decision: 'approve', reason: 'Current evidence confirmed.' })).status, 409);
      const requests = await Promise.all(Array.from({ length: 8 }, (_, index) => core(index % 2 ? moderator : contender, { publicId: verification.publicId, body: { version: unclaimed.__v } })));
      const claims = await Promise.allSettled(requests.map(req => reviewSellerVerification(req, 'claim')));
      assert.equal(claims.filter(row => row.status === 'fulfilled').length, 1);
      const claimed = await SellerVerification.findById(verification._id), winner = String(claimed.assignedUserId) === String(moderator.user._id) ? moderator : contender;
      assert.equal(claimed.reviewHistory.filter(row => row.action === 'claim').length, 1);
      assert.equal((await post(winner, base, 'release', SellerVerification)).status, 302);
      assert.equal((await post(moderator, base, 'claim', SellerVerification)).status, 302);
      const fresh = await SellerVerification.findById(verification._id);
      await assert.rejects(reviewSellerVerification(await core(moderator, { publicId: verification.publicId, body: { version: fresh.__v - 1, decision: 'approve' } }), 'decision'), error => error.code === 'VERIFICATION_VERSION_CONFLICT');
      const references = fresh.documents.toObject();
      await SellerVerification.updateOne({ _id: fresh._id }, { $set: { documents: references.filter(row => row.type !== 'registration') } });
      try { assert.equal((await post(moderator, base, 'decision', SellerVerification, { decision: 'approve' })).status, 409, 'An unreferenced ready registration document is insufficient.'); }
      finally { await SellerVerification.updateOne({ _id: fresh._id }, { $set: { documents: references } }); }
      const before = await effects(moderator, verification, 'verification');
      t.mock.method(AuditLog, 'create', async () => { throw new Error('Catalogue verification audit unavailable'); });
      try { await assert.rejects(reviewSellerVerification(await core(moderator, { publicId: verification.publicId, body: { version: fresh.__v, decision: 'approve', reason: 'Current required evidence verified.' } }), 'decision'), /Catalogue verification audit unavailable/); }
      finally { t.mock.restoreAll(); }
      assert.deepEqual(await effects(moderator, verification, 'verification'), before, 'Actor/grant/market/store/target/document/QA/notice writes all roll back together.');
      assert.equal((await post(moderator, base, 'decision', SellerVerification, { decision: 'approve', reason: 'Identity and current business registration confirmed.' })).status, 302);
      const approved = await SellerVerification.findById(verification._id);
      assert.equal(approved.status, 'approved'); assert.equal((await Store.findById(ownerStore._id)).status, 'verified');
      assert.equal(await VerificationDocument.countDocuments({ verificationId: approved._id, status: 'approved' }), 2);
      const qa = await ModerationQaReview.findOne({ targetPublicId: approved.publicId });
      assert.equal(qa.decision, 'approved'); assert.equal(qa.decisionVersionSnapshot, approved.__v); assert.equal(qa.country, 'UG');
      assert.equal(String(qa.originalReviewerUserId), String(moderator.user._id)); assert.ok(qa.decisionEventAt);
      const notice = await Notification.findOne({ userId: owner.user._id, type: 'seller.verification', title: 'Seller verification approved' });
      assert.equal(notice.country, 'UG'); assert.equal(notice.href, '/seller/verification');
      const outbox = await OutboxEvent.findOne({ type: 'seller.verification_notification', aggregatePublicId: approved.publicId }).sort({ createdAt: -1 }).lean();
      assert.ok(outbox); assert.doesNotMatch(JSON.stringify(outbox.payload), /CATALOGUE_PRIVATE_/);
    });

    let actualProduct, actualVariant, actualMedia;
    await t.test('a verified seller actually creates, sanitizes, stocks and submits the restricted listing', async () => {
      const fields = { title: `Catalogue Four Eyes Bag ${suffix}`, description: 'A durable cotton travel bag with a reinforced strap and zipped interior pocket. Suitable for everyday shopping and weekend travel. Hand wash in cool water and dry in the shade.',
        categoryPublicId: restrictedCategory.publicId, sku: `MCAT-${suffix}`, variantTitle: 'Natural cotton', price: '45000', compareAt: '50000', weightGrams: '650' };
      const form = await owner.agent.get('/seller/products/new').expect(200);
      await owner.agent.post('/seller/products').type('form').send({ ...fields, _csrf: csrf(form.text), status: 'published', countries: ['KE'] }).expect(302);
      actualProduct = await Product.findOne({ storeId: ownerStore._id }); actualVariant = await ProductVariant.findOne({ productId: actualProduct._id });
      assert.equal(actualProduct.status, 'draft'); assert.deepEqual(actualProduct.countries.toObject(), ['UG']);
      const warehouse = await Warehouse.create({ publicId: `wh_mcat_${suffix}`, storeId: ownerStore._id, ownerUserId: owner.user._id,
        name: 'Catalogue Kampala warehouse', country: 'UG', city: 'Kampala', address: 'Isolated catalogue inventory address', active: true });
      const base = '/seller/products/' + actualProduct.publicId;
      for (let position = 0; position < 3; position++) {
        const page = await owner.agent.get(base).expect(200), current = await Product.findById(actualProduct._id);
        await owner.agent.post(base + '/images').field('_csrf', csrf(page.text)).field('version', String(current.__v))
          .field('position', String(position)).field('altText', `Bag detail ${position}`).attach('image', png, { filename: 'bag.png', contentType: 'image/png' }).expect(302);
      }
      actualMedia = await ProductMedia.findOne({ productId: actualProduct._id }).select('+storageKey +thumbnailStorageKey');
      const bytes = await readMediaObjectBuffer(actualMedia.storageKey), metadata = await sharp(bytes).metadata();
      assert.equal(metadata.format, 'webp'); assert.equal(metadata.exif, undefined); assert.equal(bytes.includes(Buffer.from('CATALOGUE_PRIVATE_CAMERA_METADATA')), false);
      assert.equal((await post(owner, base, 'stock', Product, { variantPublicId: actualVariant.publicId, warehousePublicId: warehouse.publicId,
        quantity: 12, reason: 'Received twelve sellable bags', reorderPoint: 3 })).status, 302);
      assert.equal((await StockItem.findOne({ variantId: actualVariant._id })).onHand, 12);
      assert.equal((await post(owner, base, 'submit', Product)).status, 302);
      assert.equal((await Product.findById(actualProduct._id)).status, 'submitted');
      assert.ok(await Notification.exists({ userId: moderator.user._id, country: 'UG', type: 'moderation_work', title: 'High risk work awaiting review', href: '/moderation/products?record=' + actualProduct.publicId + '&country=UG' }), 'An actual restricted submission queues a scoped priority work alert.');
      await request(app).get('/products/' + actualProduct.publicId).expect(404);
      await request(app).get('/media/catalogue/' + actualMedia.publicId).expect(404);
    });
    await t.test('private product originals and thumbnails close grant and Device authorization after genuine storage reads', async () => {
      const readFile = fs.readFile.bind(fs);
      for (const size of ['original', 'thumb']) for (const change of ['grant', 'device']) {
        const entry = await actor('customer', { countries: ['UG'] });
        const href = '/media/catalogue/' + actualMedia.publicId + (size === 'thumb' ? '?size=thumb' : '');
        const allowed = await entry.agent.get(href).expect(200);
        assert.equal(allowed.headers['content-type'], 'image/webp'); assert.match(allowed.headers['cache-control'], /private.*no-store/);
        const key = size === 'thumb' ? actualMedia.thumbnailStorageKey : actualMedia.storageKey;
        assert.ok(key); const storagePath = process.env.UPLOAD_DIR + '/' + key; let read = false;
        t.mock.method(fs, 'readFile', async (...args) => {
          const bytes = await readFile(...args);
          if (!read && String(args[0]) === storagePath) {
            read = true;
            if (change === 'grant') await PlatformGrant.updateOne({ _id: entry.grant._id }, { $set: { status: 'revoked', revokedAt: new Date() } });
            else await Device.updateOne({ _id: entry.device._id }, { $set: { revokedAt: new Date(), revokedReason: 'In-flight private product image revocation' } });
          }
          return bytes;
        });
        try {
          const denied = await entry.agent.get(href).set('Accept', 'application/json').expect(403);
          assert.equal(read, true, 'Revocation must occur after reading the real stored image or thumbnail.');
          assert.match(denied.headers['content-type'], /application\/json/);
          assert.equal(denied.headers['x-classic-mart-media-fallback'], undefined, 'Authorization failure must not deliver media or a missing-object placeholder.');
        } finally { t.mock.restoreAll(); }
      }
    });
    await t.test('restricted products require two independent approvals, one decision wins, and only an actual seller publication becomes public', async () => {
      const base = '/moderation/products/' + actualProduct.publicId;
      const page = await moderator.agent.get(base).expect(200);
      assert.match(page.text, /Variants and pricing|Stock and fulfilment/); assert.match(page.text, /12/);
      assert.equal((await post(moderator, base, 'decision', Product, { decision: 'approve' })).status, 409);
      const claimVersion = (await Product.findById(actualProduct._id)).__v;
      const requests = await Promise.all(Array.from({ length: 8 }, (_, index) => core(index % 2 ? moderator : contender, { publicId: actualProduct.publicId, body: { version: claimVersion } })));
      const claims = await Promise.allSettled(requests.map(req => reviewProduct(req, 'claim')));
      assert.equal(claims.filter(row => row.status === 'fulfilled').length, 1);
      let fresh = await Product.findById(actualProduct._id), winner = String(fresh.moderation.assignedUserId) === String(moderator.user._id) ? moderator : contender;
      assert.equal(fresh.moderation.reviewHistory.filter(row => row.action === 'claim').length, 1);
      assert.equal((await post(winner, base, 'release', Product)).status, 302);
      assert.equal((await post(moderator, base, 'claim', Product)).status, 302);
      assert.equal((await post(moderator, base, 'decision', Product, { decision: 'reject', reason: 'Short' })).status, 422);
      fresh = await Product.findById(actualProduct._id);
      const decisions = await Promise.allSettled((await Promise.all(Array.from({ length: 6 }, () => core(moderator, { publicId: actualProduct.publicId,
        body: { version: fresh.__v, decision: 'approve', reason: 'Restricted category and current listing evidence confirmed.' } })))).map(req => reviewProduct(req, 'decision')));
      assert.equal(decisions.filter(row => row.status === 'fulfilled').length, 1);
      fresh = await Product.findById(actualProduct._id);
      assert.equal(fresh.status, 'submitted'); assert.equal(fresh.moderation.secondReviewRequired, true);
      assert.equal(String(fresh.moderation.firstApprovalByUserId), String(moderator.user._id));
      assert.equal(fresh.moderation.reviewHistory.filter(row => row.action === 'first_approval').length, 1);
      assert.equal(await ModerationQaReview.countDocuments({ targetPublicId: actualProduct.publicId }), 0);
      assert.equal(await ProductMedia.countDocuments({ productId: actualProduct._id, status: 'approved' }), 0);
      assert.equal((await post(moderator, base, 'claim', Product)).status, 409, 'The first approver cannot claim the second review.');
      assert.equal((await post(contender, base, 'claim', Product)).status, 302);
      const before = await effects(contender, actualProduct, 'product');
      t.mock.method(AuditLog, 'create', async () => { throw new Error('Catalogue product audit unavailable'); });
      try { await assert.rejects(reviewProduct(await core(contender, { publicId: actualProduct.publicId,
        body: { version: before.record.__v, decision: 'approve', reason: 'Independent second review confirms current evidence.' } }), 'decision'), /Catalogue product audit unavailable/); }
      finally { t.mock.restoreAll(); }
      assert.deepEqual(await effects(contender, actualProduct, 'product'), before);
      assert.equal((await post(contender, base, 'decision', Product, { decision: 'approve', reason: 'Independent second review confirms current evidence.' })).status, 302);
      fresh = await Product.findById(actualProduct._id);
      assert.equal(fresh.status, 'approved'); assert.equal(fresh.publishedAt, undefined);
      assert.equal(fresh.moderation.secondReviewRequired, false); assert.equal(String(fresh.moderation.reviewedByUserId), String(contender.user._id));
      assert.equal(await ProductMedia.countDocuments({ productId: actualProduct._id, status: 'approved' }), 3);
      const qa = await ModerationQaReview.findOne({ targetPublicId: actualProduct.publicId });
      assert.equal(qa.decision, 'approved'); assert.equal(qa.decisionVersionSnapshot, fresh.__v); assert.equal(qa.riskLevel, 'high');
      assert.equal(String(qa.originalReviewerUserId), String(contender.user._id)); assert.equal(qa.country, 'UG');
      assert.ok(await Notification.exists({ userId: owner.user._id, country: 'UG', type: 'catalogue.product', href: '/seller/products/' + actualProduct.publicId }));
      assert.ok(await OutboxEvent.exists({ type: 'catalogue.product_notification', aggregatePublicId: actualProduct.publicId }));
      await request(app).get('/products/' + actualProduct.publicId).expect(404);
      await request(app).get('/media/catalogue/' + actualMedia.publicId).expect(404);
      assert.equal((await post(owner, '/seller/products/' + actualProduct.publicId, 'publish', Product)).status, 302);
      assert.equal((await Product.findById(actualProduct._id)).status, 'published');
      assert.match((await request(app).get('/products/' + actualProduct.publicId).expect(200)).text, /Catalogue Four Eyes Bag/);
      const image = await request(app).get('/media/catalogue/' + actualMedia.publicId).expect(200); assert.match(image.headers['cache-control'], /public/);
    });

    await t.test('current grants, roles, MFA, account/session state and active market settings fail closed for reads and decisions', async () => {
      const target = products.UG[4];
      for (const [description, patch] of [
        ['revoked grant', entry => PlatformGrant.updateOne({ _id: entry.grant._id }, { $set: { status: 'revoked', revokedAt: new Date() } })],
        ['expired grant', entry => PlatformGrant.updateOne({ _id: entry.grant._id }, { $set: { expiresAt: new Date(Date.now() - 1) } })],
        ['future grant', entry => PlatformGrant.updateOne({ _id: entry.grant._id }, { $set: { startsAt: new Date(Date.now() + 60_000) } })],
        ['different current grant role', entry => PlatformGrant.updateOne({ _id: entry.grant._id }, { $set: { role: 'finance' } })],
        ['different current source-country grant', entry => PlatformGrant.updateOne({ _id: entry.grant._id }, { $set: { operationalCountries: ['KE'] } })],
        ['suspended account', entry => User.updateOne({ _id: entry.user._id }, { $set: { status: 'suspended' } })],
        ['unverified identity', entry => User.updateOne({ _id: entry.user._id }, { $set: { emailVerifiedAt: null } })],
        ['incomplete onboarding', entry => User.updateOne({ _id: entry.user._id }, { $set: { onboardingCompletedAt: null } })],
        ['disabled MFA', entry => User.updateOne({ _id: entry.user._id }, { $set: { 'security.mfaEnabled': false } })],
        ['changed session token', entry => User.updateOne({ _id: entry.user._id }, { $inc: { 'security.tokenVersion': 1 } })],
      ]) {
        const entry = await actor('customer', { countries: ['UG'] }), old = await core(entry, { query: { country: 'UG' }, publicId: target.publicId, body: { version: target.__v } });
        const before = await Product.findById(target._id).lean(); await patch(entry);
        await assert.rejects(loadModerationCataloguePage(old, 'moderator-products'), error => [403, 409].includes(error.status), description);
        await assert.rejects(reviewerProductDetail(old, target.publicId), error => [403, 409].includes(error.status), description);
        await assert.rejects(reviewProduct(old, 'claim'), error => [403, 409].includes(error.status), description);
        await assert.rejects(readableVerificationDocument(old, identity.publicId), error => [403, 409].includes(error.status), description);
        assert.deepEqual(await Product.findById(target._id).lean(), before, description);
        const response = await entry.agent.get('/moderation/products?country=UG').set('Accept', 'application/json');
        assert.ok([401, 403].includes(response.status), description + ': ' + response.status);
      }
      const legacy = await actor('moderator', { managed: false, countries: ['UG'] }), old = await core(legacy, { query: { country: 'UG' }, publicId: target.publicId, body: { version: target.__v } });
      await User.updateOne({ _id: legacy.user._id }, { $set: { role: 'customer' } });
      await assert.rejects(reviewProduct(old, 'claim'), error => error.code === 'MODERATION_FORBIDDEN');
      const sessionMismatch = await core(moderator); sessionMismatch.session.tokenVersion++;
      await assert.rejects(loadModerationCataloguePage(sessionMismatch, 'moderator-products'), error => error.code === 'ACCOUNT_UNAVAILABLE');
      await CountrySetting.updateOne({ code: 'UG' }, { $set: { active: false } });
      try {
        await moderator.agent.get('/moderation/products?country=UG').set('Accept', 'application/json').expect(403);
        await assert.rejects(reviewProduct(await core(moderator, { publicId: target.publicId, body: { version: target.__v } }), 'claim'), error => [403, 409].includes(error.status));
      } finally { await CountrySetting.updateOne({ code: 'UG' }, { $set: { active: true } }); }
      const deviceEntry = await actor(); await Device.updateMany({ userId: deviceEntry.user._id, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: 'Catalogue session test' } });
      await deviceEntry.agent.get('/moderation/products').set('Accept', 'application/json').expect(401);
      await deviceEntry.agent.get('/moderation/verifications').set('Accept', 'application/json').expect(401);
    });
    await t.test('changed target versions and archived source stores cannot be claimed or decided', async () => {
      for (const [target, Model, review, locked] of [[products.UG[5], Product, reviewProduct, 'PRODUCT_LOCKED'], [verifications.UG[5], SellerVerification, reviewSellerVerification, 'VERIFICATION_LOCKED']]) {
        const store = await Store.findById(target.storeId), changed = await Model.findById(target._id), oldVersion = changed.__v;
        if (Model === Product) changed.title += ' updated';
        else changed.legalName += ' updated';
        changed.increment(); await changed.save();
        const version = changed.__v; assert.equal(version, oldVersion + 1);
        const old = await core(moderator, { publicId: target.publicId, body: { version: oldVersion } });
        await assert.rejects(review(old, 'claim'), error => error.code === (Model === Product ? 'PRODUCT_VERSION_CONFLICT' : 'VERIFICATION_VERSION_CONFLICT'));
        await Store.updateOne({ _id: store._id }, { $set: { status: 'closed' } });
        try {
          const before = await effects(moderator, target, Model === Product ? 'product' : 'verification');
          await assert.rejects(review(await core(moderator, { publicId: target.publicId, body: { version } }), 'claim'), error => error.code === locked);
          assert.deepEqual(await effects(moderator, target, Model === Product ? 'product' : 'verification'), before);
        } finally { await Store.updateOne({ _id: store._id }, { $set: { status: store.status } }); }
      }
    });
    await t.test('direct authorized Core Admin review remains compatible while every Moderator UI requires the Moderator workspace', async () => {
      const admin = await actor('country_admin', { managed: false, countries: ['UG'] }), target = products.UG[6];
      for (const href of Object.values(routes)) await admin.agent.get(href).set('Accept', 'application/json').expect(403);
      await admin.agent.get('/moderation/products/' + target.publicId).set('Accept', 'application/json').expect(403);
      await admin.agent.get('/moderation/verifications/' + verifications.UG[6].publicId).set('Accept', 'application/json').expect(403);
      const claim = await reviewProduct(await core(admin, { publicId: target.publicId, body: { version: target.__v } }), 'claim');
      const result = await reviewProduct(await core(admin, { publicId: target.publicId,
        body: { version: claim.__v, decision: 'reject', reason: 'Current category evidence requires a corrected seller submission.' } }), 'decision');
      assert.equal(result.status, 'rejected'); assert.ok(await ModerationQaReview.exists({ targetPublicId: target.publicId, originalReviewerUserId: admin.user._id }));
      const applicant = verifications.UG[6], verificationClaim = await reviewSellerVerification(await core(admin, { publicId: applicant.publicId, body: { version: applicant.__v } }), 'claim');
      const released = await reviewSellerVerification(await core(admin, { publicId: applicant.publicId, body: { version: verificationClaim.__v } }), 'release');
      assert.equal(released.assignedUserId, null); assert.equal(await Store.countDocuments({ ownerUserId: admin.user._id }), 0);
    });
  } finally {
    t.mock.restoreAll(); for (const transport of transports) transport.destroy();
    try {
      assert.equal(mongoose.connection.name, database);
      if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    } finally { await mongoose.disconnect(); await fs.rm(process.env.UPLOAD_DIR, { recursive: true, force: true }); }
  }
});

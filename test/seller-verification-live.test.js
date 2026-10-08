import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import mongoose from 'mongoose';
import request from 'supertest';
import sharp from 'sharp';
import { chromium } from '@playwright/test';

const suffix = crypto.randomBytes(8).toString('hex');
process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.UPLOAD_DIR = `/tmp/classicmart-verification-images-${suffix}`;
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const token = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('seller evidence, independent country-scoped review, rejection, appeal and approval persist through real authenticated routes', { skip: !uri }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const database = `classicmart_verification_flow_test_${suffix}`;
  await mongoose.connect(uri, { dbName: database });
  const { createApp } = await import('../src/app.js');
  const { User, Store, StoreMember, SellerVerification, VerificationDocument, AuditLog, Notification, OutboxEvent, ModerationQaReview } = await import('../src/models/index.js');
  const { hashPassword } = await import('../src/core/crypto.js');
  const { pendingMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
  const { readVerificationDocumentBuffer } = await import('../src/services/verification-media.js');
  const { readMediaObjectBuffer } = await import('../src/services/object-storage.js');
  const { reviewSellerVerification, submitSellerVerification, sellerVerificationQueue } = await import('../src/services/seller-verification.js');
  const { processNotificationOutbox } = await import('../src/services/outbox.js');
  const { env } = await import('../src/config/env.js');
  assert.equal(env.mediaStorageDriver, 'filesystem');
  assert.equal(env.uploadDir, process.env.UPLOAD_DIR);
  const app = createApp(null);
  const password = `Verification-${suffix}A1!`;
  let sequence = 0, server, browser;
  const png = await sharp({ create: { width: 640, height: 640, channels: 3, background: '#ffd6a0' } }).withMetadata({ exif: { IFD0: { Artist: 'PRIVATE_CAMERA_METADATA' } } }).png().toBuffer();
  async function actor(role, country = 'UG', mfa = true) {
    const id = sequence++;
    const email = `verification-${suffix}-${id}@example.com`, phone = '+2567' + crypto.randomInt(10000000, 99999999);
    const user = await User.create({ publicId: `usr_ver_${suffix}_${id}`, name: `Verification User ${id}`, email, emailNormalized: email, phone, phoneNormalized: phone,
      passwordHash: await hashPassword(password), role, country, currency: 'UGX', emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
      consents: { terms: true, privacy: true, recordedAt: new Date() } });
    const agent = request.agent(app);
    const login = await agent.get('/login').expect(200);
    await agent.post('/login').type('form').send({ email, password, _csrf: token(login.text) }).expect(302);
    if (mfa) {
      const security = await agent.get('/account/security').expect(200);
      await agent.post('/account/mfa/begin').type('form').send({ currentPassword: password, _csrf: token(security.text) }).expect(302);
      const pending = await pendingMfaEnrollment(user._id);
      await agent.post('/account/mfa/confirm').type('form').send({ code: totpCode(pending.secret), _csrf: token((await agent.get('/account/security')).text) }).expect(302);
      assert.equal((await User.findById(user._id)).security.mfaEnabled, true);
    }
    return { user, agent };
  }
  async function version() { return (await SellerVerification.findOne({ storeId: store._id })).__v; }
  let store;
  try {
    await Promise.all([Store.init(), StoreMember.init(), SellerVerification.init(), VerificationDocument.init()]);
    const owner = await actor('seller');
    let page = await owner.agent.get('/seller/verification').expect(200);
    store = await Store.findOne({ ownerUserId: owner.user._id });
    let verification = await SellerVerification.findOne({ storeId: store._id });
    await owner.agent.get('/seller/onboarding').expect(308).expect('location', '/seller/verification');
    assert.match(page.text, /Seller Verification/);
    assert.doesNotMatch(page.text, /Development preview|role-workspaces\.js|roleSwitcher/);
    const submit = async fields => owner.agent.post('/seller/verification/submit').type('form').send({ sellerType: 'business', legalName: 'Verified Business Ltd', registrationNumber: 'REG-SENSITIVE-123', taxNumber: 'TAX-SENSITIVE-789', declaration: 'yes', version: await version(), _csrf: token((await owner.agent.get('/seller/verification')).text), ...fields });
    assert.equal((await submit({})).status, 422);
    const initialCount = await VerificationDocument.countDocuments();
    await owner.agent.post('/seller/verification/documents').field('documentType', 'identity').field('version', String(await version())).attach('document', png, { filename: 'id.png', contentType: 'image/png' }).expect(403);
    assert.equal(await VerificationDocument.countDocuments(), initialCount);
    async function upload(type, bytes = png, contentType = 'image/png') {
      const form = await owner.agent.get('/seller/verification').expect(200);
      return owner.agent.post('/seller/verification/documents').field('_csrf', token(form.text)).field('version', String(await version())).field('documentType', type).attach('document', bytes, { filename: 'proof.png', contentType });
    }
    assert.equal((await upload('identity', Buffer.from('invalid image'))).status, 422);
    assert.equal((await upload('identity', Buffer.from('<svg/>'), 'image/svg+xml')).status, 422);
    assert.equal((await upload('identity')).status, 302);
    assert.equal((await upload('identity')).status, 302);
    const first = await VerificationDocument.findOne({ verificationId: verification._id, status: 'superseded' }).select('+storageKey');
    const current = await VerificationDocument.findOne({ verificationId: verification._id, status: 'ready' }).select('+storageKey');
    assert.ok(first); assert.ok(current);
    const stored = await readMediaObjectBuffer(current.storageKey);
    assert.equal(stored.subarray(0, 4).toString(), 'CMV1');
    assert.equal(current.encrypted, true);
    const sanitized = await readVerificationDocumentBuffer(current);
    const metadata = await sharp(sanitized).metadata();
    assert.equal(metadata.format, 'webp'); assert.equal(metadata.exif, undefined);
    assert.equal(sanitized.includes(Buffer.from('PRIVATE_CAMERA_METADATA')), false);
    const ownMedia = await owner.agent.get('/media/verification/' + current.publicId).expect(200);
    assert.equal(ownMedia.headers['content-type'], 'image/webp');
    assert.match(ownMedia.headers['cache-control'], /private.*no-store/);
    const objectDirectory = `${process.env.UPLOAD_DIR}/verification-${verification.publicId}`;
    const beforeObjects = await fs.readdir(objectDirectory);
    t.mock.method(AuditLog, 'create', async () => { throw new Error('Document audit failure'); });
    assert.equal((await upload('identity')).status, 500);
    t.mock.restoreAll();
    assert.deepEqual(await fs.readdir(objectDirectory), beforeObjects);
    assert.equal(await VerificationDocument.countDocuments({ verificationId: verification._id, status: 'ready' }), 1);
    const other = await actor('seller');
    await other.agent.get('/seller/store').expect(200);
    await other.agent.get('/media/verification/' + current.publicId).expect(404);
    const delegated = await StoreMember.create({ publicId: `stm_evidence_${suffix}`, storeId: store._id, userId: other.user._id, role: 'admin', status: 'active', invitedByUserId: owner.user._id, acceptedAt: new Date() });
    await other.agent.get('/media/verification/' + current.publicId).expect(200);
    await StoreMember.updateOne({ _id: delegated._id }, { $set: { status: 'revoked', revokedAt: new Date() } });
    await VerificationDocument.updateOne({ _id: current._id }, { $set: { userId: other.user._id } });
    await other.agent.get('/media/verification/' + current.publicId).expect(404);
    await VerificationDocument.updateOne({ _id: current._id }, { $set: { userId: owner.user._id } });

    assert.equal((await submit({})).status, 422, 'business registration proof must be current');
    assert.equal((await upload('registration')).status, 302);
    const references = (await SellerVerification.findById(verification._id)).documents.toObject();
    await SellerVerification.updateOne({ _id: verification._id }, { $set: { documents: [] } });
    assert.equal((await submit({})).status, 422, 'unreferenced ready documents must not count as current evidence');
    await SellerVerification.updateOne({ _id: verification._id }, { $set: { documents: references } });
    const draftVersion = await version();
    const stale = await owner.agent.post('/seller/verification/submit').type('form').send({ sellerType: 'individual', legalName: 'Owner', declaration: 'yes', version: draftVersion - 1, _csrf: token((await owner.agent.get('/seller/verification')).text) }).expect(409);
    assert.match(stale.text, /Verification changed/);
    assert.equal((await submit({ declaration: 'no' })).status, 422);
    const freshOwner = await User.findById(owner.user._id);
    t.mock.method(AuditLog, 'create', async () => { throw new Error('Audit write failure'); });
    await assert.rejects(submitSellerVerification({ user: freshOwner, store, body: { sellerType: 'business', legalName: 'Verified Business Ltd', registrationNumber: 'REG-SENSITIVE-123', declaration: 'yes', version: await version() }, get: () => '' }), /Audit write failure/);
    t.mock.restoreAll();
    assert.equal((await SellerVerification.findById(verification._id)).status, 'draft');
    assert.equal(await Notification.countDocuments({ type: 'seller.verification' }), 0);
    assert.equal((await submit({})).status, 302);
    verification = await SellerVerification.findById(verification._id).select('+registrationNumber +taxNumber');
    assert.equal(verification.status, 'submitted');
    assert.match(verification.registrationNumber, /^v1:/); assert.doesNotMatch(verification.registrationNumber, /REG-SENSITIVE/);
    assert.match(verification.taxNumber, /^v1:/); assert.equal((await Store.findById(store._id)).status, 'pending_verification');
    assert.equal((await upload('identity')).status, 409);

    const reviewer = await actor('moderator');
    const foreignReviewer = await actor('moderator', 'KE');
    const queue = await reviewer.agent.get('/moderation/verifications').expect(200);
    assert.match(queue.text, /Verified Business Ltd/);
    assert.doesNotMatch((await foreignReviewer.agent.get('/moderation/verifications')).text, /Verified Business Ltd/);
    await foreignReviewer.agent.get('/media/verification/' + current.publicId).expect(403);
    await foreignReviewer.agent.get('/moderation/verifications/' + verification.publicId).expect(403);
    const base = '/moderation/verifications/' + verification.publicId;
    const reviewerPost = async (action, fields = {}) => {
      const view = await reviewer.agent.get(base).expect(200);
      return reviewer.agent.post(base + '/' + action).type('form').send({ version: await version(), _csrf: token(view.text), ...fields });
    };
    assert.equal((await reviewerPost('decision', { decision: 'approve' })).status, 409, 'assignment is mandatory');
    const independentStore = await Store.create({ publicId: `str_self_${suffix}`, ownerUserId: reviewer.user._id, name: 'Independent review conflict', slug: `self-${suffix}`, country: 'UG', currency: 'UGX' });
    const ownCase = await SellerVerification.create({ publicId: `kyc_self_${suffix}`, storeId: independentStore._id, userId: reviewer.user._id, sellerType: 'individual', legalName: 'Self review', status: 'submitted', submittedAt: new Date() });
    await assert.rejects(reviewSellerVerification({ user: await User.findById(reviewer.user._id), params: { publicId: ownCase.publicId }, body: { version: ownCase.__v }, get: () => '' }, 'claim'), { code: 'REVIEW_CONFLICT_OF_INTEREST' });
    const contender = await actor('moderator');
    const claimVersion = await version();
    const claims = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => reviewSellerVerification({ id: `verification-claim-${suffix}-${index}`, user: index % 2 ? reviewer.user : contender.user, params: { publicId: verification.publicId }, body: { version: claimVersion }, get: () => '' }, 'claim')));
    assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1, claims.filter(result => result.status === 'rejected').map(result => result.reason.code || result.reason.message).join(', '));
    const claimed = await SellerVerification.findById(verification._id);
    assert.equal(claimed.reviewHistory.filter(entry => entry.action === 'claim').length, 1);
    if (String(claimed.assignedUserId) !== String(reviewer.user._id)) {
      const casePage = await contender.agent.get(base).expect(200);
      await contender.agent.post(base + '/release').type('form').send({ version: claimed.__v, _csrf: token(casePage.text) }).expect(302);
      assert.equal((await reviewerPost('claim')).status, 302);
    }
    assert.equal((await reviewerPost('decision', { decision: 'reject', reason: 'No' })).status, 422);
    assert.equal((await reviewerPost('decision', { decision: 'reject', reason: 'Registration document needs clarification.' })).status, 302);
    assert.equal((await SellerVerification.findById(verification._id)).status, 'rejected');
    assert.equal((await Store.findById(store._id)).status, 'pending_verification');
    page = await owner.agent.get('/seller/verification').expect(200);
    assert.match(page.text, /Registration document needs clarification/);
    await owner.agent.post('/seller/verification/appeal').type('form').send({ version: await version(), message: 'The registration document is valid; please reconsider its details.', _csrf: token(page.text) }).expect(302);
    assert.equal((await SellerVerification.findById(verification._id)).status, 'appealed');
    assert.equal((await reviewerPost('claim')).status, 302);
    t.mock.method(AuditLog, 'create', async () => { throw new Error('Decision audit failure'); });
    await assert.rejects(reviewSellerVerification({ id: `decision-audit-${suffix}`, user: reviewer.user, params: { publicId: verification.publicId }, body: { version: await version(), decision: 'approve' }, get: () => '' }, 'decision'), /Decision audit failure/);
    t.mock.restoreAll();
    assert.equal((await Store.findById(store._id)).status, 'pending_verification');
    assert.equal((await SellerVerification.findById(verification._id)).status, 'appealed');
    assert.equal(await Notification.countDocuments({ userId: owner.user._id, type: 'seller.verification' }), 3);
    assert.equal(await ModerationQaReview.countDocuments({ targetPublicId: verification.publicId }), 1);
    assert.equal((await reviewerPost('decision', { decision: 'approve', reason: 'Evidence confirmed after appeal.' })).status, 302);
    assert.equal((await Store.findById(store._id)).status, 'verified');
    assert.equal((await SellerVerification.findById(verification._id)).status, 'approved');
    assert.equal(await VerificationDocument.countDocuments({ verificationId: verification._id, status: 'approved' }), 2);
    assert.equal(await VerificationDocument.countDocuments({ verificationId: verification._id, status: 'superseded' }), 1);
    assert.equal(await ModerationQaReview.countDocuments({ targetPublicId: verification.publicId }), 2);
    const notifications = await Notification.find({ userId: owner.user._id, type: 'seller.verification' });
    assert.equal(notifications.length, 4);
    const deliveries = await processNotificationOutbox({ limit: 20 });
    assert.equal(deliveries.processed, 4); assert.equal(deliveries.failed, 0);
    assert.equal(await OutboxEvent.countDocuments({ type: 'seller.verification_notification', status: 'processed', lastError: /no external email was sent/ }), 4);
    assert.equal((await upload('identity')).status, 409);
    const unenrolled = await actor('moderator', 'UG', false);
    await unenrolled.agent.get('/media/verification/' + current.publicId).expect(403);

    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
      server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
      const errors = [];
      async function browserSession(actorSession, path) {
        const context = await browser.newContext();
        const cookie = (await actorSession.agent.get(path)).headers['set-cookie'].find(value => value.startsWith('cm.sid=')).split(';')[0];
        const split = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: origin }]);
        const browserPage = await context.newPage(); browserPage.on('pageerror', error => errors.push(error.message));
        return { context, browserPage };
      }
      const applicant = await browserSession(other, '/seller/verification');
      await applicant.browserPage.goto(origin + '/seller/verification');
      await applicant.browserPage.locator('[name="document"]').setInputFiles({ name: 'identity.png', mimeType: 'image/png', buffer: png });
      await applicant.browserPage.locator('button[type="submit"]').filter({ hasText: 'Upload Document' }).click();
      await applicant.browserPage.getByText('Verification document uploaded.', { exact: true }).waitFor();
      await applicant.browserPage.locator('[name="legalName"]').fill('Browser Verified Seller');
      await applicant.browserPage.locator('[name="declaration"]').check();
      await applicant.browserPage.getByRole('button', { name: 'Submit for Review', exact: true }).click();
      await applicant.browserPage.getByText('Verification submitted for independent review.', { exact: true }).waitFor();
      const browserStore = await Store.findOne({ ownerUserId: other.user._id });
      const browserCase = await SellerVerification.findOne({ storeId: browserStore._id });
      assert.equal(browserCase.status, 'submitted');
      const browserReview = await browserSession(reviewer, '/moderation/verifications');
      await browserReview.browserPage.goto(origin + '/moderation/verifications/' + browserCase.publicId);
      await browserReview.browserPage.getByRole('button', { name: 'Claim Case', exact: true }).click();
      await browserReview.browserPage.getByRole('button', { name: 'Approve Verification', exact: true }).waitFor();
      await browserReview.browserPage.locator('[name="reason"]').fill('Identity evidence confirmed through review.');
      await browserReview.browserPage.getByRole('button', { name: 'Approve Verification', exact: true }).click();
      await browserReview.browserPage.getByText('Verification review updated.', { exact: true }).waitFor();
      assert.equal((await Store.findById(browserStore._id)).status, 'verified');
      await applicant.context.close(); await browserReview.context.close();
      for (const [actorSession, path, name] of [[owner, '/seller/verification', 'seller'], [reviewer, base, 'reviewer']]) {
        const { context, browserPage } = await browserSession(actorSession, path);
        for (const width of [1366, 390]) {
          await browserPage.setViewportSize({ width, height: 950 });
          const response = await browserPage.goto(origin + path);
          assert.equal(response.status(), 200); assert.equal(new URL(browserPage.url()).hash, '');
          assert.ok(await browserPage.locator('h1').isVisible());
          assert.equal(await browserPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await browserPage.screenshot({ path: `/tmp/classicmart-${name}-verification-${width}.png`, fullPage: true });
        }
        await context.close();
      }
      assert.deepEqual(errors, []);
    }
    const paginationStores = await Store.insertMany(Array.from({ length: 51 }, (_, index) => ({ publicId: `str_page_${suffix}_${index}`, ownerUserId: new mongoose.Types.ObjectId(), name: `Queue Store ${index}`, slug: `queue-${suffix}-${index}`, country: 'UG', currency: 'UGX' })));
    await SellerVerification.insertMany(paginationStores.map((row, index) => ({ publicId: `kyc_page_${suffix}_${index}`, storeId: row._id, userId: row.ownerUserId, sellerType: 'individual', legalName: `Queue Seller ${index}`, status: 'submitted', submittedAt: new Date('2026-01-01T00:00:00Z') })));
    const firstPage = await sellerVerificationQueue(reviewer.user);
    assert.equal(firstPage.items.length, 50); assert.equal(firstPage.page.hasMore, true);
    const nextPage = await sellerVerificationQueue(reviewer.user, firstPage.page.next);
    assert.equal(nextPage.page.hasMore, false);
    assert.equal(new Set([...firstPage.items, ...nextPage.items].map(row => row.publicId)).size, firstPage.items.length + nextPage.items.length);
    assert.equal([...firstPage.items, ...nextPage.items].filter(row => row.publicId.startsWith(`kyc_page_${suffix}_`)).length, 51);
    assert.ok(firstPage.items.every(row => row.registrationNumber === undefined && row.documents === undefined && row.store.country === 'UG'));
  } finally {
    t.mock.restoreAll(); await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    assert.equal(mongoose.connection.name, database); await mongoose.connection.dropDatabase(); await mongoose.disconnect();
    await fs.rm(process.env.UPLOAD_DIR, { recursive: true, force: true });
  }
});

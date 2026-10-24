import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
// A restricted push must be cancelled before reaching even this closed local port.
process.env.PUSH_GATEWAY_URL = 'http://127.0.0.1:1';
process.env.PUSH_GATEWAY_SECRET = 'privacy-test-local-no-provider-delivery';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('verified privacy requests enforce real restrictions, obligation checks and durable recovery', { skip: !uri, timeout: 180_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /test|verification/i);
  const suffix = crypto.randomBytes(7).toString('hex');
  let exportDirectory = '';
  let httpServer;
  try {
  await mongoose.connect(uri, { dbName: `classicmart_privacy_test_${suffix}` });
  const { env } = await import('../src/config/env.js');
  exportDirectory = env.privacyExportDir;
  const models = await import('../src/models/index.js');
  const { CustomerAvatar } = await import('../src/models/CustomerAvatar.js');
  const privacy = await import('../src/services/privacy.js');
  const { optionalProcessingUser } = await import('../src/services/optional-processing.js');
  const { queuePushNotification, registerPushDevice, processPushOutbox } = await import('../src/services/stage11.js');
  const { processNotificationOutbox } = await import('../src/services/outbox.js');
  const { queueAiJob } = await import('../src/services/ai.js');
  const { encryptSensitive } = await import('../src/core/sensitive.js');
  const { hashPassword, hashToken, hashValue, normalizeEmail } = await import('../src/core/crypto.js');
  const { ensureLedgerAccount, postLedgerTransaction } = await import('../src/services/money.js');
  const { createApp } = await import('../src/app.js');
  const { currentCustomerAccess } = await import('../src/services/customer-access.js');
  const { User, CountrySetting, Device, PlatformGrant, PlatformStaffInvitation, PrivacyRequest, CustomerAddress, CustomerCatalogueState, AiJob, NewsletterSubscription, OutboxEvent, PushDevice, Order, Store, StoreMember, StoreTeamInvitation, BusinessMember, AuditLog, WalletTopUp, LedgerTransaction, LoyaltyAccount, LoyaltyEntry, CustomerReward, SupportTicket } = models;
  const app = createApp(null), password = `Privacy-${suffix}-A1!`, passwordHash = await hashPassword(password);
  // Every client uses this one owned server. Supertest must not create an
  // untracked listener when a fixture or assertion fails between requests.
  httpServer = createServer(app);
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  let sequence = 0;
  const id = prefix => `${prefix}_privacy_${suffix}_${++sequence}`;
    for (const Model of Object.values(mongoose.models)) await Model.init();
    await CountrySetting.create([{ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256' }, { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254' }]);
    async function identity(role = 'customer', country = 'UG') {
      const email = `${id('email')}@example.com`, phone = '+25670' + String(++sequence).padStart(7, '0');
      const user = await User.create({ publicId: id('usr'), name: 'Privacy fixture', email, emailNormalized: email, phone, phoneNormalized: phone, passwordHash, role, status: 'active', country, shoppingCountry: country, currency: country === 'UG' ? 'UGX' : 'KES', operationalCountries: [country], platformAccessManagedAt: role === 'country_admin' ? new Date() : undefined, emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), onboardingCompletedAt: new Date(), security: { mfaEnabled: role === 'country_admin', tokenVersion: 0 }, consents: { terms: true, privacy: true, marketing: true, recordedAt: new Date() } });
      if (role === 'country_admin') await PlatformGrant.create({ publicId: id('pgr'), userId: user._id, role, operationalCountries: [country], status: 'active', startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000), reason: 'Privacy review fixture', approvalPublicId: id('apr'), approvedByUserId: new mongoose.Types.ObjectId() });
      const sessionID = crypto.randomUUID(), device = await Device.create({ publicId: id('dev'), userId: user._id, sessionHash: hashToken(sessionID), label: 'Privacy fixture', userAgent: 'Privacy/1', ipHash: 'fixture', lastSeenAt: new Date() });
      const scoped = () => ({ id: id('req'), user, device, sessionID, session: { userId: String(user._id), tokenVersion: user.security.tokenVersion }, country: { code: country }, query: {}, ip: '127.0.0.1', get: () => 'Privacy/1' });
      return { user, scoped };
    }
    const buyer = await identity(), other = await identity(), reviewer = await identity('country_admin'), foreign = await identity('country_admin', 'KE');
    const client = request.agent(base), otherClient = request.agent(base);
    for (const [agent, entry] of [[client, buyer], [otherClient, other]]) {
      const form = await agent.get('/login').expect(200);
      await agent.post('/login').type('form').send({ email: entry.user.email, password, _csrf: csrf(form.text) }).expect(302);
    }
    async function submit(type, agent = client) {
      const shown = await agent.get('/account/privacy').expect(200);
      await agent.post('/account/privacy/request').type('form').send({ type, password, _csrf: csrf(shown.text) }).expect(302);
      return PrivacyRequest.findOne({ userId: buyer.user._id, type }).sort({ createdAt: -1 });
    }
    const options = () => ({ request: reviewer.scoped() });

    await t.test('exports are privately encrypted, owned and reclaim interrupted and failed jobs', async () => {
      let doc = await submit('export');
      await client.post('/account/privacy/request').type('form').send({ type: 'deletion', password }).expect(403);
      const otherPage = await otherClient.get('/account/privacy').expect(200);
      await otherClient.get(`/account/privacy/${doc.publicId}/download`).expect(404);
      await PrivacyRequest.updateOne({ _id: doc._id }, { $set: { status: 'processing', lockedBy: 'crashed', leaseToken: 'old-claim', lockedUntil: new Date(Date.now() - 1), attempts: 1 } });
      assert.equal(await privacy.processPrivacyRequests({ workerId: 'privacy-recovery-test' }), 1);
      doc = await PrivacyRequest.findById(doc._id).select('+storageKey');
      assert.equal(doc.status, 'ready'); assert.equal(doc.attempts, 2);
      const bytes = await fs.readFile(path.join(env.privacyExportDir, doc.storageKey), 'utf8');
      assert.ok(!bytes.includes(buyer.user.email));
      const download = await client.get(`/account/privacy/${doc.publicId}/download`).expect(200);
      assert.match(download.headers['cache-control'], /private.*no-store/);
      assert.equal(JSON.parse(download.text).account.email, buyer.user.email);
      assert.doesNotMatch(download.text, /passwordHash|tokenHash|mfaSecretEncrypted|sessionHash/);
      await assert.rejects(privacy.privacyExportPayload({ ...doc.toObject(), userId: other.user._id }), error => error.code === 'PRIVACY_EXPORT_NOT_READY');
      // The stale reader cannot bypass an applied hold.
      await privacy.setPrivacyLegalHold(doc, reviewer.user, { active: true, reason: 'Verified legal review hold.', request: reviewer.scoped() });
      await assert.rejects(privacy.privacyExportPayload(doc), error => error.code === 'PRIVACY_EXPORT_NOT_READY');
      await assert.rejects(privacy.approvePrivacyRequest(doc, reviewer.user, 'A stale reviewer must not overwrite the hold.', options()), error => error.code === 'PRIVACY_REQUEST_CHANGED');
      const held = await PrivacyRequest.findById(doc._id);
      await assert.rejects(privacy.retryPrivacyRequest(held, reviewer.user, 'Try to bypass an active hold.', options()), error => error.code === 'PRIVACY_RECOVERY_UNAVAILABLE');
      // A separately created automatic export fails transiently then retries.
      const failed = await PrivacyRequest.create({ publicId: id('prv'), userId: other.user._id, userPublicId: other.user.publicId, country: 'UG', type: 'export', status: 'failed', attempts: 1, identityVerifiedAt: new Date(), nextAttemptAt: new Date(Date.now() - 1) });
      assert.equal(await privacy.processPrivacyRequests({ workerId: 'privacy-failed-test' }), 1);
      assert.equal((await PrivacyRequest.findById(failed._id)).status, 'ready');
      assert.ok(otherPage.text.includes('Privacy'));
    });

    await t.test('exports drain every owned financial record across batches and markets without counterparty or internal data', async () => {
      const owner = await identity(), outsider = await identity();
      const wallet = await ensureLedgerAccount({ code: 'customer_wallet', type: 'liability', ownerType: 'customer', ownerId: owner.user._id, ownerPublicId: owner.user.publicId, country: 'UG', currency: 'UGX' });
      const secondMarket = await ensureLedgerAccount({ code: 'customer_wallet', type: 'liability', ownerType: 'customer', ownerId: owner.user._id, ownerPublicId: owner.user.publicId, country: 'KE', currency: 'KES' });
      const clearing = await ensureLedgerAccount({ code: 'private_export_clearing', type: 'asset', ownerType: 'platform', ownerPublicId: 'PRIVATE_COUNTERPARTY_ACCOUNT', country: 'UG', currency: 'UGX' });
      const secondClearing = await ensureLedgerAccount({ code: 'private_export_clearing', type: 'asset', ownerType: 'platform', ownerPublicId: 'PRIVATE_COUNTERPARTY_ACCOUNT', country: 'KE', currency: 'KES' });
      const foreignWallet = await ensureLedgerAccount({ code: 'customer_wallet', type: 'liability', ownerType: 'customer', ownerId: outsider.user._id, ownerPublicId: outsider.user.publicId, country: 'UG', currency: 'UGX' });
      const transactions = Array.from({ length: 205 }, (_, index) => ({
        publicId: id('ltx'), idempotencyKey: id('export_posting'), referenceType: 'privacy_fixture', referencePublicId: `owned_posting_${index}`,
        country: index === 204 ? 'KE' : 'UG', currency: index === 204 ? 'KES' : 'UGX', description: 'INTERNAL_LEDGER_DESCRIPTION', entries: [
          { accountId: index === 204 ? secondMarket._id : wallet._id, accountPublicId: index === 204 ? secondMarket.publicId : wallet.publicId, debitMinor: 0, creditMinor: 10, memo: 'INTERNAL_LEDGER_MEMO' },
          { accountId: index === 204 ? secondClearing._id : clearing._id, accountPublicId: index === 204 ? secondClearing.publicId : clearing.publicId, debitMinor: 10, creditMinor: 0, memo: 'PRIVATE_COUNTERPARTY_MEMO' },
        ],
      }));
      const foreignPosting = { ...transactions[0], publicId: id('ltx'), idempotencyKey: id('export_posting'), referencePublicId: 'FOREIGN_LEDGER_SECRET', entries: [{ accountId: foreignWallet._id, accountPublicId: foreignWallet.publicId, debitMinor: 0, creditMinor: 10 }, transactions[0].entries[1]] };
      await LedgerTransaction.insertMany([...transactions, foreignPosting]);
      const topUps = Array.from({ length: 17 }, (_, index) => ({ publicId: id('wtu'), userId: owner.user._id, userPublicId: owner.user.publicId, country: index === 16 ? 'KE' : 'UG', currency: index === 16 ? 'KES' : 'UGX', amountMinor: 10, idempotencyKey: id('topup'), providerReference: id('provider'), status: 'succeeded', providerTrackingId: 'PRIVATE_PROVIDER_TRACKING', checkoutUrl: 'https://example.invalid/?token=PRIVATE_PAYMENT_SECRET' }));
      await WalletTopUp.insertMany([...topUps, { ...topUps[0], publicId: id('wtu'), userId: outsider.user._id, userPublicId: outsider.user.publicId, idempotencyKey: id('topup'), providerReference: 'FOREIGN_TOPUP_SECRET' }]);
      await LoyaltyAccount.create([{ publicId: id('loy'), userId: owner.user._id, country: 'UG', points: 205, lifetimeEarned: 205 }, { publicId: id('loy'), userId: owner.user._id, country: 'KE', points: 0 }, { publicId: id('loy'), userId: outsider.user._id, country: 'UG', points: 1 }]);
      const loyalty = Array.from({ length: 205 }, (_, index) => ({ publicId: id('lye'), idempotencyKey: id('loyalty'), userId: owner.user._id, country: 'UG', type: 'manual_adjustment', pointsDelta: 1, balanceAfter: index + 1, referenceType: 'privacy_fixture', referencePublicId: `owned_points_${index}`, reason: 'INTERNAL_LOYALTY_NOTE', actorUserId: reviewer.user._id }));
      await LoyaltyEntry.insertMany([...loyalty, { ...loyalty[0], publicId: id('lye'), idempotencyKey: id('loyalty'), userId: outsider.user._id, referencePublicId: 'FOREIGN_LOYALTY_SECRET' }]);
      const rewards = Array.from({ length: 15 }, () => ({ publicId: id('rwd'), idempotencyKey: id('reward'), userId: owner.user._id, country: 'UG', currency: 'UGX', rewardKey: 'fixture-voucher', label: 'Owned export voucher', kind: 'voucher', pointsCost: 1, valueMinor: 10, expiresAt: new Date(Date.now() + 86_400_000) }));
      await CustomerReward.insertMany([...rewards, { ...rewards[0], publicId: id('rwd'), idempotencyKey: id('reward'), userId: outsider.user._id, label: 'FOREIGN_REWARD_SECRET' }]);
      const orderId = new mongoose.Types.ObjectId(), orderPublicId = id('ord');
      await Order.collection.insertOne({ _id: orderId, publicId: orderPublicId, sessionKey: id('session'), idempotencyKey: id('order'), userId: owner.user._id, country: 'UG', status: 'paid', paymentState: 'paid', fulfillmentState: 'delivered', contact: { fullName: 'Export fixture', email: owner.user.email }, totals: { totalMinor: 10, currency: 'UGX' }, items: [{ linePublicId: id('line'), title: 'Owned purchase', unitPriceMinor: 10, unitCostMinor: 987654321, costSnapshotStatus: 'captured' }], policySnapshot: { internalNote: 'INTERNAL_MERCHANT_NOTE' } });
      await SupportTicket.collection.insertOne({ publicId: id('tkt'), userId: owner.user._id, country: 'UG', subject: 'Owned support request', notes: [{ internal: false, message: 'Customer-visible reply', actorUserId: owner.user._id }, { internal: true, message: 'INTERNAL_SUPPORT_NOTE', actorUserId: reviewer.user._id }] });
      const requested = await privacy.createPrivacyRequest(owner.scoped(), { type: 'export', password });
      assert.equal(await privacy.processPrivacyRequests({ workerId: 'privacy-complete-export' }), 1);
      const ready = await PrivacyRequest.findById(requested._id).select('+storageKey');
      assert.equal(ready.status, 'ready');
      const text = await privacy.privacyExportPayload(ready, { request: owner.scoped() }), data = JSON.parse(text);
      assert.equal(data.walletTopUps.length, 17);
      assert.deepEqual(new Set(data.walletTopUps.map(row => row.country)), new Set(['UG', 'KE']));
      assert.deepEqual(new Set(data.ledgerAccounts.map(row => row.publicId)), new Set([wallet.publicId, secondMarket.publicId]));
      assert.equal(data.ledgerTransactions.length, 205);
      assert.deepEqual(new Set(data.ledgerTransactions.map(row => row.referencePublicId)), new Set(transactions.map(row => row.referencePublicId)));
      assert.ok(data.ledgerTransactions.every(row => row.entries.length === 1 && row.entries[0].accountPublicId === (row.country === 'KE' ? secondMarket.publicId : wallet.publicId)));
      assert.deepEqual(new Set(data.ledgerTransactions.map(row => row.country)), new Set(['UG', 'KE']));
      assert.equal(data.ledgerTransactions.reduce((total, row) => total + row.entries[0].creditMinor, 0), 2050);
      assert.deepEqual(new Set(data.loyaltyAccounts.map(row => row.country)), new Set(['UG', 'KE']));
      assert.equal(data.loyaltyEntries.length, 205); assert.equal(data.rewards.length, 15);
      assert.equal(data.orders[0].publicId, orderPublicId); assert.equal(data.supportTickets[0].notes[0].message, 'Customer-visible reply');
      assert.doesNotMatch(text, /FOREIGN_|PRIVATE_COUNTERPARTY|INTERNAL_|987654321|unitCostMinor|costSnapshotStatus|PRIVATE_PAYMENT_SECRET|PRIVATE_PROVIDER_TRACKING|idempotencyKey|passwordHash|sessionHash|actorUserId/);
      assert.ok(!text.includes(clearing.publicId)); assert.ok(!text.includes(secondClearing.publicId)); assert.ok(!text.includes(foreignWallet.publicId));
    });

    await t.test('current access rejects invalid caller, session and authoritative identity token versions', async () => {
      const owner = await identity();
      for (const value of [undefined, null, -1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1]) {
        const scoped = owner.scoped(); scoped.user = { _id: owner.user._id, security: { tokenVersion: value } };
        await assert.rejects(currentCustomerAccess(scoped), error => error.code === 'ACCOUNT_UNAVAILABLE');
      }
      for (const value of [null, -1, 0.5, '0']) {
        const scoped = owner.scoped(); scoped.session.tokenVersion = value;
        await assert.rejects(currentCustomerAccess(scoped), error => error.code === 'ACCOUNT_UNAVAILABLE');
      }
      try {
        await User.collection.updateOne({ _id: owner.user._id }, { $set: { security: null } });
        await assert.rejects(currentCustomerAccess(owner.scoped()), error => error.code === 'ACCOUNT_UNAVAILABLE');
        await assert.rejects(privacy.createPrivacyRequest(owner.scoped(), { type: 'export', password }), error => error.code === 'ACCOUNT_UNAVAILABLE');
        await User.collection.updateOne({ _id: owner.user._id }, { $unset: { security: '' } });
        await assert.rejects(currentCustomerAccess(owner.scoped()), error => error.code === 'ACCOUNT_UNAVAILABLE');
        await assert.rejects(privacy.createPrivacyRequest(owner.scoped(), { type: 'export', password }), error => error.code === 'ACCOUNT_UNAVAILABLE');
        await User.collection.updateOne({ _id: owner.user._id }, { $set: { security: { tokenVersion: '0' } } });
        await assert.rejects(currentCustomerAccess(owner.scoped()), error => error.code === 'ACCOUNT_UNAVAILABLE');
        await assert.rejects(privacy.createPrivacyRequest(owner.scoped(), { type: 'export', password }), error => error.code === 'ACCOUNT_UNAVAILABLE');
        for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
          await User.collection.updateOne({ _id: owner.user._id }, { $set: { security: { tokenVersion: value } } });
          const scoped = owner.scoped(); scoped.user = { _id: owner.user._id, security: { tokenVersion: value } }; scoped.session.tokenVersion = value;
          await assert.rejects(currentCustomerAccess(scoped), error => error.code === 'ACCOUNT_UNAVAILABLE');
          await assert.rejects(privacy.createPrivacyRequest(scoped, { type: 'export', password }), error => error.code === 'ACCOUNT_UNAVAILABLE');
        }
      } finally { await User.collection.updateOne({ _id: owner.user._id }, { $set: { security: { tokenVersion: 0 } } }); }
      assert.equal(String((await currentCustomerAccess(owner.scoped()))._id), String(owner.user._id));
    });

    await t.test('private reads recheck revocation after storage and cleanup cannot clear a newer export', async () => {
      const owner = await identity();
      let doc = await privacy.createPrivacyRequest(owner.scoped(), { type: 'export', password });
      await privacy.processPrivacyRequests();
      doc = await PrivacyRequest.findById(doc._id).select('+storageKey +exportArtifacts');
      const file = path.join(env.privacyExportDir, doc.storageKey), originalRead = fs.readFile;
      const ownerRequest = owner.scoped();
      try {
        fs.readFile = async (target, ...args) => {
          const result = await originalRead(target, ...args);
          if (target === file) await Device.updateOne({ _id: ownerRequest.device._id }, { $set: { revokedAt: new Date() } });
          return result;
        };
        await assert.rejects(privacy.privacyExportPayload(doc, { request: ownerRequest }), error => error.code === 'ACCOUNT_UNAVAILABLE');
      } finally { fs.readFile = originalRead; }
      await Device.updateOne({ _id: ownerRequest.device._id }, { $set: { revokedAt: null } });
      await PrivacyRequest.updateOne({ _id: doc._id }, { $set: { expiresAt: new Date(0), 'exportArtifacts.$[].expiresAt': new Date(0) } });
      const originalRemove = fs.rm, replacement = `${doc.publicId}-replacement.enc`;
      await fs.writeFile(path.join(env.privacyExportDir, replacement), encryptSensitive('{"replacement":true}'), { flag: 'wx', mode: 0o600 });
      try {
        fs.rm = async (target, ...args) => {
          await originalRemove(target, ...args);
          if (target === file) await PrivacyRequest.updateOne({ _id: doc._id }, {
            $set: { storageKey: replacement, status: 'ready', expiresAt: new Date(Date.now() + 86_400_000) },
            $push: { exportArtifacts: { key: replacement, expiresAt: new Date(Date.now() + 86_400_000) } },
          });
        };
        assert.equal(await privacy.expirePrivacyExports(), 1);
      } finally { fs.rm = originalRemove; }
      doc = await PrivacyRequest.findById(doc._id).select('+storageKey +exportArtifacts');
      assert.equal(doc.status, 'ready'); assert.equal(doc.storageKey, replacement);
      assert.ok(doc.exportArtifacts.find(row => row.key === path.basename(file))?.cleanupAfter, 'cleaned claims keep durable cleanup tombstones');
      // Simulate an interrupted writer resuming after its first physical delete.
      await fs.writeFile(file, 'late interrupted writer', { flag: 'wx', mode: 0o600 });
      await PrivacyRequest.updateOne({ _id: doc._id, 'exportArtifacts.key': path.basename(file) }, { $set: { 'exportArtifacts.$.cleanupAfter': new Date(0) } });
      assert.equal(await privacy.expirePrivacyExports(), 1);
      await assert.rejects(fs.readFile(file), { code: 'ENOENT' });
      assert.equal(JSON.parse(await privacy.privacyExportPayload(doc, { request: owner.scoped() })).replacement, true);
    });

    await t.test('corrections change verified fields and reviews require current independent authority', async () => {
      let doc = await submit('correction');
      await assert.rejects(privacy.approvePrivacyRequest(doc, reviewer.user, 'Do not falsely complete an unapplied correction.', options()), error => error.code === 'PRIVACY_CORRECTION_REQUIRED');
      const reviewRequest = reviewer.scoped();
      await Device.updateOne({ _id: reviewRequest.device._id }, { $set: { revokedAt: new Date() } });
      await assert.rejects(privacy.approvePrivacyRequest(doc, reviewer.user, 'Revoked review session is unavailable.', { request: reviewRequest, corrections: { name: 'Corrected name' } }), error => error.code === 'ACCOUNT_UNAVAILABLE');
      await Device.updateOne({ _id: reviewRequest.device._id }, { $set: { revokedAt: null } });
      doc = await privacy.approvePrivacyRequest(doc, reviewer.user, 'Verified correction agreed with account holder.', { ...options(), corrections: { name: 'Verified corrected name', bio: 'Verified customer biography.' } });
      assert.equal(doc.status, 'completed');
      assert.equal((await User.findById(buyer.user._id)).name, 'Verified corrected name');
      const ownRequest = await privacy.createPrivacyRequest(reviewer.scoped(), { type: 'deletion', password });
      await assert.rejects(privacy.approvePrivacyRequest(ownRequest, reviewer.user, 'A staff member cannot approve their own deletion.', options()), error => error.code === 'PRIVACY_INDEPENDENT_REVIEW_REQUIRED');
      await PrivacyRequest.updateOne({ _id: ownRequest._id }, { $set: { status: 'cancelled' } });
    });

    await t.test('approved restrictions stop newsletter, stored profiling, queued outreach, AI and push', async () => {
      await CustomerCatalogueState.create({ userId: buyer.user._id, recentProducts: [{ productId: new mongoose.Types.ObjectId(), viewedAt: new Date() }] });
      await AiJob.create({ publicId: id('aij'), actorUserId: buyer.user._id, type: 'product_draft', country: 'UG', input: { notes: 'Private fixture notes' } });
      await registerPushDevice(buyer.user, { platform: 'web', token: 'privacy-push-token-fixture-123', label: 'Fixture' });
      const push = await queuePushNotification({ userId: buyer.user._id, userPublicId: buyer.user.publicId, title: 'Private push fixture', body: 'Do not dispatch after restriction.' });
      let doc = await submit('restriction');
      await assert.rejects(privacy.approvePrivacyRequest(doc, foreign.user, 'Foreign country review denied.', { request: foreign.scoped() }), error => error.code === 'COUNTRY_ADMIN_COUNTRY_FORBIDDEN');
      doc = await privacy.approvePrivacyRequest(doc, reviewer.user, 'Verified optional processing restriction.', options());
      assert.equal(await optionalProcessingUser(buyer.user._id), null);
      assert.equal((await CustomerCatalogueState.findOne({ userId: buyer.user._id })).recentProducts.length, 0);
      assert.equal((await AiJob.findOne({ actorUserId: buyer.user._id })).status, 'cancelled');
      assert.equal(await PushDevice.countDocuments({ userId: buyer.user._id, status: 'active' }), 0);
      assert.equal(await privacy.processPrivacyRequests(), 1);
      doc = await PrivacyRequest.findById(doc._id); assert.equal(doc.status, 'completed'); assert.equal(doc.restrictionActive, true);
      const page = await client.get('/account/privacy').expect(200);
      await client.post('/notifications/preferences').type('form').send({ orders: 'on', wishlist: 'on', offers: 'on', club: 'on', _csrf: csrf(page.text) }).expect(403);
      const beforeProfile = await User.findById(buyer.user._id);
      await client.post('/account/profile').type('form').send({ name: 'Restriction must reject this profile change', phone: buyer.user.phone, country: 'UG', currency: 'UGX', locale: 'en-UG', marketing: 'on', _csrf: csrf(page.text) }).expect(302);
      assert.equal((await User.findById(buyer.user._id)).name, beforeProfile.name);
      assert.equal((await User.findById(buyer.user._id)).consents.marketing, false);
      await PrivacyRequest.updateOne({ _id: doc._id }, { $set: { status: 'blocked' }, $inc: { __v: 1 } });
      await client.post(`/account/privacy/${doc.publicId}/cancel`).type('form').send({ _csrf: csrf(page.text) }).expect(409);
      doc = await PrivacyRequest.findById(doc._id);
      await client.post('/api/v1/newsletter/subscribe').set('accept', 'application/json').send({ email: buyer.user.email, _csrf: csrf(page.text) }).expect(403);
      const anonymous = request.agent(base), publicCart = await anonymous.get('/api/v1/cart').expect(200);
      assert.ok(publicCart.body.csrfToken);
      await anonymous.post('/api/v1/newsletter/subscribe').send({ email: buyer.user.email, _csrf: publicCart.body.csrfToken }).expect(201);
      // The authenticated attempt above cannot silently reactivate a subscription.
      assert.equal(await NewsletterSubscription.countDocuments({ userId: buyer.user._id, status: 'active' }), 0);
      const search = await client.get('/api/v1/storefront/search?q=private-fixture').expect(200);
      assert.equal(search.body.searchId, null);
      await client.post('/ask-classic').set('accept', 'application/json').type('form').send({ question: 'Private fixture question', _csrf: csrf(page.text) }).expect(403);
      await assert.rejects(queueAiJob({ type: 'product_draft', actorUserId: buyer.user._id, country: 'UG', input: { notes: 'Must not queue' } }), error => error.code === 'PRIVACY_PROCESSING_RESTRICTED');
      await assert.rejects(registerPushDevice(buyer.user, { platform: 'web', token: 'new-private-push-fixture-456' }), error => error.code === 'PRIVACY_PROCESSING_RESTRICTED');
      assert.equal((await processPushOutbox()).processed, 1);
      assert.equal((await OutboxEvent.findById(push._id)).lastError.startsWith('Push cancelled:'), true);
      const storeOwner = await identity('seller'), store = await Store.create({ publicId: id('str'), ownerUserId: storeOwner.user._id, name: 'Privacy store', slug: id('store'), country: 'UG', currency: 'UGX', status: 'verified' });
      const event = await OutboxEvent.create({ eventId: id('evt'), type: 'store.broadcast', aggregateType: 'store_broadcast', aggregatePublicId: id('brd'), payload: { userPublicId: buyer.user.publicId, email: buyer.user.email, body: 'Stale private payload', subject: 'Forbidden stale outreach', storePublicId: store.publicId, country: 'UG' } });
      let deliveries = 0; await processNotificationOutbox({ sendEmail: async () => { deliveries++; return { delivered: true }; } });
      assert.equal(deliveries, 0); assert.equal((await OutboxEvent.findById(event._id)).payload.deliveryStatus, 'cancelled');
      doc = await privacy.releasePrivacyRestriction(doc, reviewer.user, 'Account holder independently requested restored optional processing.', options());
      assert.equal(doc.restrictionActive, false); assert.ok(await optionalProcessingUser(buyer.user._id));
      assert.equal((await User.findById(buyer.user._id)).consents.marketing, false, 'release must not invent marketing consent');
    });

    await t.test('deletion blocks real obligations then revokes current access and queues durable media cleanup', async () => {
      const oldStore = await Store.create({ publicId: id('str'), ownerUserId: other.user._id, name: 'Other owner store', slug: id('store'), country: 'UG', currency: 'UGX', status: 'closed' });
      await StoreMember.create({ publicId: id('stm'), storeId: oldStore._id, userId: buyer.user._id, role: 'support', status: 'active', invitedByUserId: other.user._id });
      await BusinessMember.create({ publicId: id('bmem'), organizationId: new mongoose.Types.ObjectId(), userId: buyer.user._id, role: 'buyer', status: 'active', invitedByUserId: other.user._id });
      const invitationEmailHash = hashValue(normalizeEmail(buyer.user.email)), expiresAt = new Date(Date.now() + 86_400_000);
      const staffInvitation = await PlatformStaffInvitation.create({ publicId: id('sinv'), emailHash: invitationEmailHash, emailEncrypted: encryptSensitive(buyer.user.email), emailMasked: buyer.user.email, role: 'support', operationalCountries: ['UG'], reason: 'Pending deleted identity invitation fixture.', tokenHash: hashToken(id('token')), expiresAt, invitedByUserId: other.user._id });
      const storeInvitation = await StoreTeamInvitation.create({ publicId: id('sti'), storeId: oldStore._id, storePublicId: oldStore.publicId, country: 'UG', currency: 'UGX', emailHash: invitationEmailHash, emailEncrypted: encryptSensitive(buyer.user.email), emailMasked: buyer.user.email, role: 'support', invitedByUserId: other.user._id, invitedByTokenVersion: 0, invitedByMembershipId: new mongoose.Types.ObjectId(), invitedByRole: 'owner', invitedByPermissionVersion: 0, expiresAt });
      await CustomerAddress.create({ publicId: id('adr'), userId: buyer.user._id, fullName: buyer.user.name, phone: buyer.user.phone, address: 'Private address fixture', city: 'Kampala', country: 'UG' });
      const avatar = await CustomerAvatar.create({ publicId: id('avt'), userId: buyer.user._id, storageKey: `privacy-fixture-${suffix}.cmv`, mimeType: 'image/webp', sizeBytes: 100, width: 320, height: 320, checksumSha256: 'a'.repeat(64), current: true, status: 'active' });
      const order = await Order.create({ publicId: id('ord'), userId: buyer.user._id, country: 'UG', idempotencyKey: id('idem'), checkoutId: id('chk'), cartPublicId: id('cart'), sessionKey: id('session'), deliveryMethod: 'standard', paymentMethod: 'cod', contact: { fullName: buyer.user.name, email: buyer.user.email, phone: buyer.user.phone, address: 'Private address fixture', city: 'Kampala', country: 'UG' }, totals: { subtotalMinor: 100, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 100, currency: 'UGX' }, reservationExpiresAt: new Date(Date.now() + 3600_000), items: [{ linePublicId: id('line'), productId: new mongoose.Types.ObjectId(), variantId: new mongoose.Types.ObjectId(), storeId: oldStore._id, reservationPublicId: id('res'), productPublicId: id('prd'), variantPublicId: id('var'), storePublicId: oldStore.publicId, title: 'Retained order fixture', variantTitle: 'Standard', sku: id('sku'), quantity: 1, unitPriceMinor: 100, lineTotalMinor: 100, currency: 'UGX' }] });
      let doc = await submit('deletion'); doc = await privacy.approvePrivacyRequest(doc, reviewer.user, 'Deletion independently verified.', options());
      await privacy.processPrivacyRequests(); doc = await PrivacyRequest.findById(doc._id);
      assert.equal(doc.status, 'blocked'); assert.match(doc.decision, /active order/);
      assert.equal((await User.findById(buyer.user._id)).status, 'active');
      await Order.updateOne({ _id: order._id }, { $set: { status: 'paid', paymentState: 'paid', fulfillmentState: 'delivered' } });
      const wallet = await ensureLedgerAccount({ code: 'customer_wallet', type: 'liability', ownerType: 'customer', ownerId: buyer.user._id, ownerPublicId: buyer.user.publicId, country: 'UG', currency: 'UGX' });
      const clearing = await ensureLedgerAccount({ code: 'privacy_fixture_clearing', type: 'asset', ownerType: 'platform', ownerPublicId: 'platform', country: 'UG', currency: 'UGX' });
      await postLedgerTransaction({ idempotencyKey: id('ltx'), referenceType: 'privacy_test', referencePublicId: order.publicId, currency: 'UGX', country: 'UG', description: 'Fixture settled wallet credit', entries: [{ account: clearing, debitMinor: 100, creditMinor: 0 }, { account: wallet, debitMinor: 0, creditMinor: 100 }] });
      await privacy.retryPrivacyRequest(doc, reviewer.user, 'Recheck after completed order; retain unsettled balances.', options());
      await privacy.processPrivacyRequests(); doc = await PrivacyRequest.findById(doc._id); assert.equal(doc.status, 'blocked'); assert.match(doc.decision, /unsettled ledger balance/);
      await postLedgerTransaction({ idempotencyKey: id('ltx'), referenceType: 'privacy_test', referencePublicId: order.publicId, currency: 'UGX', country: 'UG', description: 'Fixture authorized wallet clearance', entries: [{ account: wallet, debitMinor: 100, creditMinor: 0 }, { account: clearing, debitMinor: 0, creditMinor: 100 }] });
      await privacy.retryPrivacyRequest(doc, reviewer.user, 'All obligations independently resolved; retry deletion.', options());
      await privacy.processPrivacyRequests(); doc = await PrivacyRequest.findById(doc._id);
      assert.equal(doc.status, 'completed');
      const removed = await User.findById(buyer.user._id); assert.equal(removed.status, 'deleted'); assert.equal(removed.security.tokenVersion, 1); assert.notEqual(removed.email, buyer.user.email);
      assert.equal(await CustomerAddress.countDocuments({ userId: buyer.user._id }), 0);
      assert.equal(await Device.countDocuments({ userId: buyer.user._id }), 0);
      assert.equal(await StoreMember.countDocuments({ userId: buyer.user._id, status: 'active' }), 0);
      assert.equal(await BusinessMember.countDocuments({ userId: buyer.user._id, status: 'active' }), 0);
      assert.equal((await PlatformStaffInvitation.findById(staffInvitation._id)).status, 'revoked');
      assert.equal((await StoreTeamInvitation.findById(storeInvitation._id)).status, 'revoked');
      assert.equal((await CustomerAvatar.findById(avatar._id)).status, 'pending_delete');
      assert.ok(await Order.exists({ _id: order._id }), 'legally retained transaction remains');
      assert.ok(await AuditLog.exists({ action: 'privacy.identity_deleted', targetPublicId: doc.publicId }));
      await client.get('/account/privacy').expect(302).expect('location', '/login?next=%2Faccount%2Fprivacy');
    });
  } finally {
    try {
      if (httpServer?.listening) {
        await new Promise((resolve, reject) => {
          httpServer.close(error => error ? reject(error) : resolve());
          httpServer.closeAllConnections();
        });
      }
    } finally {
    try {
      if (mongoose.connection.readyState === 1) {
        if (exportDirectory) {
          const docs = await mongoose.connection.db.collection('privacyrequests').find({}).project({ storageKey: 1, exportArtifacts: 1 }).toArray();
          for (const doc of docs) {
            const keys = new Set([doc.storageKey, ...(doc.exportArtifacts || []).map(row => row.key)].filter(key => /^[A-Za-z0-9_-]+\.enc$/.test(key || '')));
            for (const key of keys) await fs.rm(path.join(exportDirectory, key), { force: true }).catch(() => {});
          }
        }
        await mongoose.connection.dropDatabase();
      }
    } finally { await mongoose.disconnect(); }
    }
  }
});

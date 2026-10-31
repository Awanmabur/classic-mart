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
for (const name of ['SESSION_SECRET', 'TOKEN_PEPPER', 'SECURITY_INTEGRITY_KEY', 'DATA_ENCRYPTION_KEY']) process.env[name] ||= crypto.randomBytes(32).toString('hex');
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('Promoter relationships save real referrals, brand follows and two-way authorized messages', { skip: !uri, timeout: 180_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: `classicmart_promoter_relationship_test_${suffix}` });
  const { User, Store, StoreMember, CountrySetting, PromoterVerification, Campaign, CampaignApplication,
    PromoterContactRequest, MarketplaceConversation, Referral, ReferralInvite, PromoterBrandFollow,
    LoyaltyAccount, LoyaltyEntry, Order, Notification, AuditLog } = await import('../src/models/index.js');
  const { createApp } = await import('../src/app.js');
  const { hashPassword } = await import('../src/core/crypto.js');
  const { pendingMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
  const { getOrCreateStore } = await import('../src/services/store.js');
  const { acceptReferralCode, ensureReferralCode, applyGrowthForPaidOrder } = await import('../src/services/stage9.js');
  const { promoterRelationshipPage, generatePromoterReferral, followPromoterBrand, updatePromoterConversation,
    createPromoterCampaignConversation, sellerPromoterConversationsPage, updateSellerPromoterConversation } = await import('../src/services/promoter-relationship-pages.js');
  const app = createApp(null), password = `Relationship-${suffix}-Aa1!`, passwordHash = await hashPassword(password), transports = [];
  let actorSequence = 0, campaignSequence = 0, orderSequence = 0;
  const service = (entry, publicId = '', body = {}, query = {}) => ({ id: `rel-${suffix}-${crypto.randomBytes(6).toString('hex')}`,
    user: entry.user, store: entry.store, session: { tokenVersion: entry.user.security.tokenVersion }, params: { publicId }, body, query,
    country: { code: 'UG' }, get: () => '', ip: '127.0.0.1' });
  function client(index) {
    const transport = new http.Agent({ localAddress: `127.0.0.${index + 10}`, keepAlive: false }); transports.push(transport);
    return request.agent(app).use(req => req.agent(transport));
  }
  async function actor(role = 'promoter', country = 'UG', mfa = role === 'seller') {
    const index = ++actorSequence, email = `promoter-relationship-${suffix}-${index}@example.com`, phone = '+25677' + String(index).padStart(7, '0');
    let user = await User.create({ publicId: `usr_pr_${suffix}_${index}`, name: `Relationship ${index}`, email, emailNormalized: email,
      phone, phoneNormalized: phone, passwordHash, role, country, currency: country === 'KE' ? 'KES' : 'UGX',
      emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), consents: { terms: true, privacy: true, recordedAt: new Date() } });
    const agent = client(index), login = await agent.get('/login').expect(200);
    await agent.post('/login').type('form').send({ email, password, _csrf: csrf(login.text) }).expect(302);
    if (mfa) {
      const security = await agent.get('/account/security').expect(200);
      await agent.post('/account/mfa/begin').type('form').send({ currentPassword: password, _csrf: csrf(security.text) }).expect(302);
      const pending = await pendingMfaEnrollment(user._id);
      await agent.post('/account/mfa/confirm').type('form').send({ code: totpCode(pending.secret), _csrf: csrf((await agent.get('/account/security')).text) }).expect(302);
      user = await User.findById(user._id);
    }
    const result = { user, agent };
    if (role === 'promoter') result.verification = await PromoterVerification.create({ publicId: `prv_pr_${suffix}_${index}`, userId: user._id, country, status: 'verified' });
    if (role === 'seller') {
      const access = await getOrCreateStore(user);
      result.store = await Store.findOneAndUpdate({ _id: access.store._id }, { $set: { status: 'verified', verifiedAt: new Date() } }, { returnDocument: 'after' });
    }
    return result;
  }
  async function campaign(seller, promoter, overrides = {}) {
    const index = ++campaignSequence;
    const row = await Campaign.create({ publicId: `cmp_pr_${suffix}_${index}`, scope: 'seller', ownerUserId: seller.user._id, storeId: seller.store._id,
      country: seller.store.country, name: `Partnership ${index}`, status: 'active', visibility: 'public', commissionBps: 500,
      facts: ['PRIVATE_CAMPAIGN_FACT'], ...overrides });
    let application;
    if (promoter) application = await CampaignApplication.create({ publicId: `cap_pr_${suffix}_${index}`, campaignId: row._id, campaignPublicId: row.publicId,
      promoterUserId: promoter.user._id, country: row.country, status: 'approved', note: 'PRIVATE_APPLICATION_NOTE' });
    return { row, application };
  }
  async function post(entry, endpoint, body, expected = 200, page = '/promoter/messages') {
    const token = csrf((await entry.agent.get(page).expect(200)).text);
    return entry.agent.post(endpoint).set('accept', 'application/json').type('form').send({ ...body, _csrf: token }).expect(expected);
  }
  async function paidOrder(entry, { country = 'UG', paid = true } = {}) {
    const index = ++orderSequence, currency = country === 'KE' ? 'KES' : 'UGX';
    return Order.create({ publicId: `ord_pr_${suffix}_${index}`, idempotencyKey: `pr-${suffix}-${index}`, checkoutId: `chk_pr_${suffix}_${index}`,
      cartPublicId: `cart_pr_${suffix}_${index}`, sessionKey: `session-pr-${suffix}-${index}`, userId: entry.user._id, country,
      status: paid ? 'paid' : 'pending_payment', paymentMethod: 'wallet', paymentState: paid ? 'paid' : 'unpaid', deliveryMethod: 'standard',
      contact: { fullName: entry.user.name, email: entry.user.email, phone: entry.user.phone, address: '12 Test Road', city: 'Kampala', country },
      totals: { subtotalMinor: 10000, shippingMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 10000, currency },
      items: [{ linePublicId: `oline_pr_${suffix}_${index}`, productId: new mongoose.Types.ObjectId(), variantId: new mongoose.Types.ObjectId(),
        storeId: new mongoose.Types.ObjectId(), reservationPublicId: `res_pr_${suffix}_${index}`, productPublicId: 'prd_relationship_fixture',
        variantPublicId: 'var_relationship_fixture', storePublicId: 'sto_relationship_fixture', title: 'Referral purchase', variantTitle: 'Default',
        sku: `PR-${suffix}-${index}`, quantity: 1, unitPriceMinor: 10000, lineTotalMinor: 10000, currency }], reservationExpiresAt: new Date(Date.now() + 3600000) });
  }
  async function qualify(order) {
    const session = await mongoose.startSession();
    try { await session.withTransaction(() => applyGrowthForPaidOrder(order, session)); } finally { await session.endSession(); }
  }
  try {
    await Promise.all(Object.values(mongoose.models).map(model => model.init()));
    await CountrySetting.create([{ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256',
      growth: { loyaltyEnabled: false, referralEnabled: true, referralRewardPoints: 125 } },
    { code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254',
      growth: { loyaltyEnabled: false, referralEnabled: true, referralRewardPoints: 125 } }]);
    const promoter = await actor(), otherPromoter = await actor(), seller = await actor('seller'), otherSeller = await actor('seller'),
      customer = await actor('customer'), foreignPromoter = await actor('promoter', 'KE'), foreignSeller = await actor('seller', 'KE'),
      unverifiedSeller = await actor('seller'), staff = await actor('customer', 'UG', true);
    await Store.updateOne({ _id: unverifiedSeller.store._id }, { $set: { status: 'pending_verification' } });
    await StoreMember.create({ publicId: `stm_pr_staff_${suffix}`, storeId: seller.store._id, userId: staff.user._id, role: 'support', status: 'active', invitedByUserId: seller.user._id });
    const partnership = await campaign(seller, promoter), otherPartnership = await campaign(otherSeller, promoter),
      hidden = await campaign(otherSeller, null, { visibility: 'invite_only', name: 'HIDDEN_BRAND_CAMPAIGN' }),
      foreign = await campaign(foreignSeller, foreignPromoter, { name: 'FOREIGN_BRAND_PRIVATE' });
    await campaign(unverifiedSeller, promoter, { name: 'UNVERIFIED_BRAND_PRIVATE' });
    await campaign(seller, promoter, { status: 'paused', name: 'PAUSED_CAMPAIGN_PRIVATE' });
    await campaign(seller, promoter, { endsAt: new Date(Date.now() - 86400000), name: 'EXPIRED_CAMPAIGN_PRIVATE' });
    for (let index = 0; index < 54; index++) await campaign(seller, null);

    await t.test('private pages require a Promoter identity and do not mutate invitations on read', async () => {
      for (const page of ['referrals', 'brands', 'messages']) {
        await request(app).get('/promoter/' + page).expect(302).expect('location', '/login?next=' + encodeURIComponent('/promoter/' + page));
        const response = await promoter.agent.get('/promoter/' + page).expect(200);
        assert.match(response.headers['cache-control'], /no-store/); assert.match(response.headers['x-robots-tag'], /noindex/);
        assert.doesNotMatch(response.text, /data-role-switcher|Customer dashboard|Classic Club/);
        await customer.agent.get('/promoter/' + page).set('accept', 'application/json').expect(403);
      }
      assert.equal(await ReferralInvite.countDocuments(), 0);
      await promoter.agent.post('/promoter/referrals/generate').set('accept', 'application/json').send({}).expect(403);
    });

    await t.test('brand discovery counts the complete eligible dataset without private campaign or identity fields', async () => {
      const flow = (await promoter.agent.get('/promoter/brands').set('accept', 'application/json').expect(200)).body;
      assert.equal(flow.page.total, 2); assert.equal(flow.metrics[2].value, 56); assert.equal(flow.metrics[3].value, 2);
      const own = flow.records.find(row => row.publicId === seller.store.publicId); assert.equal(own.campaignCount, 55);
      const detail = (await promoter.agent.get('/promoter/brands?brand=' + seller.store.publicId).set('accept', 'application/json').expect(200)).body;
      assert.equal(detail.selected.campaigns.length, 50);
      assert.doesNotMatch(JSON.stringify(flow), /PRIVATE_CAMPAIGN_FACT|PRIVATE_APPLICATION_NOTE|FOREIGN_BRAND_PRIVATE|HIDDEN_BRAND_CAMPAIGN|emailNormalized|passwordHash|ownerUserId/);
      await promoter.agent.get('/promoter/brands?brand=' + foreignSeller.store.publicId).set('accept', 'application/json').expect(404);
      await promoter.agent.get('/promoter/brands?brand=' + unverifiedSeller.store.publicId).set('accept', 'application/json').expect(404);
    });

    await t.test('brand follows persist per Promoter and reject stale or unauthorized updates', async () => {
      await post(promoter, '/promoter/brands/' + seller.store.publicId + '/follow', { version: 0 }, 200, '/promoter/brands');
      let flow = await promoterRelationshipPage(service(promoter, '', {}, { brand: seller.store.publicId }), 'promoter-brands');
      assert.equal(flow.selected.status, 'followed'); assert.equal(await PromoterBrandFollow.countDocuments({ promoterUserId: promoter.user._id }), 1);
      const otherFlow = await promoterRelationshipPage(service(otherPromoter, '', {}, { brand: seller.store.publicId }), 'promoter-brands');
      assert.equal(otherFlow.selected.status, 'available');
      const version = flow.selected.version;
      await followPromoterBrand(service(promoter, seller.store.publicId, { version }), false);
      await assert.rejects(followPromoterBrand(service(promoter, seller.store.publicId, { version }), true), error => error.status === 409);
      flow = await promoterRelationshipPage(service(promoter, '', {}, { brand: seller.store.publicId }), 'promoter-brands');
      assert.equal(flow.selected.status, 'available');
      await assert.rejects(followPromoterBrand(service(promoter, foreignSeller.store.publicId, { version: 0 })), error => error.status === 404);
      assert.equal(await AuditLog.countDocuments({ action: { $in: ['promoter.brand_followed', 'promoter.brand_unfollowed'] } }), 2);
    });

    let invite, signupA, signupB;
    await t.test('a reusable invitation records two independent real signups, email verification and onboarding', async () => {
      const generated = await post(promoter, '/promoter/referrals/generate', {}, 200, '/promoter/referrals'); invite = generated.body.record;
      assert.match(invite.code, /^CM[A-F0-9]{12}$/);
      assert.equal((await generatePromoterReferral(service(promoter))).code, invite.code);
      assert.equal(await ReferralInvite.countDocuments({ referrerUserId: promoter.user._id }), 1);
      async function signup() {
        const index = ++actorSequence, agent = client(index), email = `signup-referral-${suffix}-${index}@example.com`;
        const page = await agent.get('/signup?ref=' + invite.code).expect(200);
        await agent.post('/signup').type('form').send({ name: `Referral Signup ${index}`, email, phoneCountry: 'UG', phone: '077' + String(index).padStart(7, '0'),
          password, confirmPassword: password, accountType: 'customer', acceptTerms: 'on', referralCode: invite.code, _csrf: csrf(page.text) }).expect(302).expect('location', '/verify-email');
        const verification = await agent.get('/verify-email').expect(200), code = verification.text.match(/Development verification code:\s*(\d{6})/)?.[1];
        assert.ok(code, 'test email sink exposes a six digit development code');
        await agent.post('/verify-email').type('form').send({ code, _csrf: csrf(verification.text) }).expect(302).expect('location', '/onboarding');
        const setup = await agent.get('/onboarding').expect(200);
        await agent.post('/onboarding').type('form').send({ role: 'customer', publicName: `Referral Signup ${index}`, location: 'Kampala', _csrf: csrf(setup.text) }).expect(302).expect('location', '/dashboard');
        const user = await User.findOne({ emailNormalized: email }); assert.ok(user.emailVerifiedAt); assert.ok(user.onboardingCompletedAt); assert.equal(user.phoneVerifiedAt, undefined);
        return { user, agent, initialLoyaltyPoints: Number((await LoyaltyAccount.findOne({ userId: user._id }))?.points || 0) };
      }
      signupA = await signup(); signupB = await signup();
      const histories = await Referral.find({ referralInviteId: (await ReferralInvite.findOne({ code: invite.code }))._id }).lean();
      assert.equal(histories.length, 2); assert.equal(new Set(histories.map(row => row.code)).size, 2);
      assert.ok(histories.every(row => row.invitationCode === invite.code && row.status === 'pending'));
      assert.equal(await LoyaltyEntry.countDocuments({ type: 'referral_earn' }), 0);
      assert.equal(await acceptReferralCode(invite.code, signupA.user), null);
    });

    await t.test('each signup earns its first paid purchase reward once, with no reward for unpaid or foreign orders', async () => {
      const unpaid = await paidOrder(signupA, { paid: false }); await qualify(unpaid);
      assert.equal((await Referral.findOne({ referredUserId: signupA.user._id })).status, 'pending');
      const foreignOrder = await paidOrder(signupA, { country: 'KE' }); await qualify(foreignOrder);
      assert.equal((await Referral.findOne({ referredUserId: signupA.user._id })).status, 'pending');
      // Remove the foreign fixture before testing the first-ever paid purchase policy.
      await Order.deleteOne({ _id: foreignOrder._id });
      const paidA = await paidOrder(signupA), paidB = await paidOrder(signupB);
      await qualify(paidA); await qualify(paidB); await qualify(paidA); await qualify(paidB);
      assert.equal(await Referral.countDocuments({ referrerUserId: promoter.user._id, status: 'rewarded' }), 2);
      assert.equal(await LoyaltyEntry.countDocuments({ userId: promoter.user._id, type: 'referral_earn' }), 2);
      assert.equal((await LoyaltyAccount.findOne({ userId: promoter.user._id })).points, 250);
      assert.equal((await LoyaltyAccount.findOne({ userId: signupA.user._id })).points, signupA.initialLoyaltyPoints + 125);
      const referralReward = await LoyaltyEntry.findOne({ userId: signupA.user._id, type: 'referral_earn', referenceType: 'referral' });
      assert.equal(referralReward.pointsDelta, 125);
      const flow = await promoterRelationshipPage(service(promoter), 'promoter-referrals');
      assert.equal(flow.metrics[0].value, 2); assert.equal(flow.metrics[2].value, 2); assert.equal(flow.metrics[3].value, 250);
      assert.doesNotMatch(JSON.stringify(flow), /signup-referral-|emailNormalized|passwordHash|referredUserId/);
    });

    await t.test('existing shared referral codes remain reusable without changing legacy receipt indexes', async () => {
      const legacyCode = 'LEGACY' + suffix.toUpperCase();
      const legacy = await Referral.create({ publicId: `ref_legacy_pr_${suffix}`, code: legacyCode, referrerUserId: otherPromoter.user._id,
        referredUserId: customer.user._id, country: 'UG', status: 'rewarded', referrerRewardPoints: 50, acceptedAt: new Date() });
      const adopted = await ensureReferralCode(otherPromoter.user); assert.equal(adopted.code, legacyCode);
      const fresh = await actor('customer'), second = await actor('customer');
      assert.ok(await acceptReferralCode(legacyCode, fresh.user)); assert.ok(await acceptReferralCode(legacyCode, second.user));
      assert.equal((await Referral.findById(legacy._id)).status, 'rewarded');
      assert.equal(await Referral.countDocuments({ invitationCode: legacyCode }), 2);
      await assert.rejects(acceptReferralCode(invite.code, promoter.user), error => error.code === 'REFERRAL_SELF');
      await assert.rejects(acceptReferralCode(invite.code, foreignPromoter.user), error => error.code === 'REFERRAL_COUNTRY');
      const index = (await Referral.collection.indexes()).find(row => row.key.referredUserId === 1); assert.equal(index.unique, true); assert.equal(index.sparse, true);
    });

    let thread;
    await t.test('approved campaign conversations persist seller and promoter replies, read receipts and audit notifications', async () => {
      const created = await post(promoter, '/promoter/messages/campaigns/create', { campaignId: partnership.row.publicId, subject: 'Campaign materials', message: 'Please confirm these campaign materials.' }, 201);
      thread = await MarketplaceConversation.findOne({ publicId: created.body.record.publicId });
      assert.equal(thread.messages.length, 1); assert.equal(thread.participantUserIds.length, 2);
      const sellerPage = await seller.agent.get('/seller/promoter-messages/' + thread.publicId).expect(200);
      assert.match(sellerPage.text, /Please confirm these campaign materials/);
      await seller.agent.post('/seller/promoter-messages/' + thread.publicId + '/reply').set('accept', 'application/json').type('form')
        .send({ version: thread.__v, message: 'Confirmed. Please use the approved brief.', _csrf: csrf(sellerPage.text) }).expect(200);
      thread = await MarketplaceConversation.findById(thread._id);
      const read = await post(promoter, '/promoter/messages/campaigns/' + thread.publicId + '/read', { version: thread.__v });
      assert.ok(read.body.record.version > thread.__v);
      thread = await MarketplaceConversation.findById(thread._id);
      assert.ok(thread.messages.every(message => message.readByUserIds.some(id => String(id) === String(promoter.user._id))));
      await post(promoter, '/promoter/messages/campaigns/' + thread.publicId + '/reply', { version: thread.__v, message: 'Thank you. I will use that brief.' });
      const current = await MarketplaceConversation.findById(thread._id);
      await assert.rejects(updatePromoterConversation(service(promoter, thread.publicId, { version: thread.__v, message: 'Stale reply must not save.' }), 'reply', true), error => error.status === 409);
      const page = await sellerPromoterConversationsPage(service(seller, current.publicId)); assert.equal(page.selected.messages.length, 3);
      const flow = await promoterRelationshipPage(service(promoter, '', {}, { tab: 'campaigns', thread: current.publicId }), 'promoter-messages');
      assert.equal(flow.selected.messages.length, 3);
      assert.doesNotMatch(JSON.stringify(flow), /PRIVATE_CAMPAIGN_FACT|PRIVATE_APPLICATION_NOTE|senderUserId|participantUserIds|emailNormalized/);
      await updateSellerPromoterConversation(service(seller, current.publicId, { version: current.__v }), 'resolve');
      assert.equal((await MarketplaceConversation.findById(thread._id)).status, 'closed');
      assert.ok(await Notification.exists({ userId: seller.user._id, href: '/seller/promoter-messages/' + thread.publicId }));
      assert.ok(await Notification.exists({ userId: promoter.user._id, href: '/promoter/messages?tab=campaigns&thread=' + thread.publicId }));
      assert.equal(await AuditLog.countDocuments({ targetPublicId: thread.publicId, action: { $in: ['promoter.campaign_conversation_created', 'seller.promoter_conversation_reply', 'promoter.conversation_read', 'promoter.conversation_reply', 'seller.promoter_conversation_resolve'] } }), 5);
    });

    await t.test('campaign messaging rejects other actors, store staff, private contexts and revoked permissions', async () => {
      const current = await MarketplaceConversation.findById(thread._id);
      await otherSeller.agent.get('/seller/promoter-messages/' + current.publicId).set('accept', 'application/json').expect(404);
      await staff.agent.get('/seller/promoter-messages/' + current.publicId).set('accept', 'application/json').expect(403);
      await otherPromoter.agent.get('/promoter/messages?tab=campaigns&thread=' + current.publicId).set('accept', 'application/json').expect(404);
      await assert.rejects(createPromoterCampaignConversation(service(promoter, '', { campaignId: hidden.row.publicId, subject: 'Private campaign', message: 'An unapproved request.' })), error => error.status === 404);
      await assert.rejects(createPromoterCampaignConversation(service(promoter, '', { campaignId: foreign.row.publicId, subject: 'Foreign campaign', message: 'A foreign request.' })), error => error.status === 404);
      const privateThread = await MarketplaceConversation.create({ publicId: `conv_private_pr_${suffix}`, country: 'UG', contextType: 'support',
        contextPublicId: partnership.row.publicId, participantUserIds: [promoter.user._id, seller.user._id], subject: 'PRIVATE_SUPPORT_CONTEXT',
        messages: [{ publicId: `msg_private_pr_${suffix}`, senderUserId: seller.user._id, body: 'PRIVATE_SUPPORT_BODY' }] });
      await promoter.agent.get('/promoter/messages?tab=campaigns&thread=' + privateThread.publicId).set('accept', 'application/json').expect(404);
      await seller.agent.get('/seller/promoter-messages/' + privateThread.publicId).set('accept', 'application/json').expect(404);
      await CampaignApplication.updateOne({ _id: partnership.application._id }, { $set: { status: 'revoked' } });
      await promoter.agent.get('/promoter/messages?tab=campaigns&thread=' + current.publicId).set('accept', 'application/json').expect(404);
      await seller.agent.get('/seller/promoter-messages/' + current.publicId).set('accept', 'application/json').expect(404);
      await CampaignApplication.updateOne({ _id: partnership.application._id }, { $set: { status: 'approved' } });
      await PromoterVerification.updateOne({ _id: promoter.verification._id }, { $set: { status: 'rejected' } });
      const revoked = await promoterRelationshipPage(service(promoter, '', {}, { tab: 'campaigns' }), 'promoter-messages');
      assert.equal(revoked.records.length, 0); assert.equal(revoked.campaignChoices.length, 0);
      await assert.rejects(generatePromoterReferral(service(promoter)), error => error.code === 'PROMOTER_VERIFICATION_REQUIRED');
      await PromoterVerification.updateOne({ _id: promoter.verification._id }, { $set: { status: 'verified' } });
      assert.equal((await MarketplaceConversation.findById(privateThread._id)).messages.length, 1);
    });

    await t.test('concurrent campaign creation has one winner and audit failure rolls every reply write back', async () => {
      const fresh = await campaign(seller, promoter);
      const attempts = await Promise.allSettled([1, 2].map(index => createPromoterCampaignConversation(service(promoter, '', {
        campaignId: fresh.row.publicId, subject: 'Concurrent partnership', message: `First message ${index}` }))));
      assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'CONTACT_EXISTS');
      const current = await MarketplaceConversation.findOne({ contextType: 'campaign', contextPublicId: fresh.row.publicId });
      assert.equal(await MarketplaceConversation.countDocuments({ contextType: 'campaign', contextPublicId: fresh.row.publicId }), 1);
      const notificationsBefore = await Notification.countDocuments(), auditCreate = AuditLog.create;
      AuditLog.create = async () => { throw new Error('Deliberate transactional audit failure'); };
      try {
        await assert.rejects(updatePromoterConversation(service(promoter, current.publicId, { version: current.__v, message: 'This reply must roll back.' }), 'reply', true), /transactional audit failure/);
      } finally { AuditLog.create = auditCreate; }
      const persisted = await MarketplaceConversation.findById(current._id);
      assert.equal(persisted.messages.length, 1); assert.equal(persisted.__v, current.__v);
      assert.equal(await Notification.countDocuments(), notificationsBefore);
      const promoterNotifications = await Notification.countDocuments({ userId: promoter.user._id });
      await User.updateOne({ _id: promoter.user._id }, { $set: { 'preferences.promoterMessages': false } });
      try {
        await updateSellerPromoterConversation(service(seller, persisted.publicId, { version: persisted.__v, message: 'Saved reply without an optional message alert.' }), 'reply');
        assert.equal(await Notification.countDocuments({ userId: promoter.user._id }), promoterNotifications);
        assert.equal((await MarketplaceConversation.findById(persisted._id)).messages.length, 2);
      } finally { await User.updateOne({ _id: promoter.user._id }, { $set: { 'preferences.promoterMessages': true } }); }
      const latest = await MarketplaceConversation.findById(persisted._id);
      await updateSellerPromoterConversation(service(seller, latest.publicId, { version: latest.__v }), 'resolve');
    });

    await t.test('customer contact requests and replies complete both ends without exposing another customer', async () => {
      const token = csrf((await customer.agent.get('/account/messages').expect(200)).text);
      const created = await customer.agent.post('/api/v1/storefront/promoters/' + promoter.verification.publicId + '/contact')
        .set('accept', 'application/json').type('form').send({ subject: 'Product recommendation', message: 'Can you recommend an approved product?', _csrf: token }).expect(201);
      const contactId = created.body.request.id;
      let contact = await PromoterContactRequest.findOne({ publicId: contactId });
      await post(promoter, '/promoter/messages/customers/' + contactId + '/reply', { version: contact.__v, message: 'Please review the listed campaign products.' });
      const page = await customer.agent.get('/account/messages').expect(200); assert.match(page.text, /Please review the listed campaign products/);
      await customer.agent.post('/account/promoter-messages/' + contactId + '/reply').type('form')
        .send({ message: 'Thank you for the recommendation.', _csrf: csrf(page.text) }).expect(302);
      const flow = await promoterRelationshipPage(service(promoter, '', {}, { thread: contactId }), 'promoter-messages');
      assert.equal(flow.selected.replies.length, 2); assert.equal(flow.selected.status, 'new');
      await otherPromoter.agent.get('/promoter/messages?thread=' + contactId).set('accept', 'application/json').expect(404);
      contact = await PromoterContactRequest.findOne({ publicId: contactId });
      await post(promoter, '/promoter/messages/customers/' + contactId + '/resolve', { version: contact.__v });
      assert.equal((await PromoterContactRequest.findOne({ publicId: contactId })).status, 'resolved');
      assert.ok(await Notification.exists({ userId: customer.user._id, href: '/account/messages', type: 'promoter_relationship' }));
    });

    await t.test('message pagination and filters count all authorized rows and keep campaign tabs', async () => {
      for (let index = 0; index < 31; index++) await MarketplaceConversation.create({ publicId: `conv_page_pr_${suffix}_${index}`, country: 'UG',
        contextType: 'campaign', contextPublicId: otherPartnership.row.publicId, participantUserIds: [promoter.user._id, otherSeller.user._id],
        subject: `Pageable partnership ${index}`, status: 'open', lastMessageAt: new Date(Date.now() + index * 1000), messages: [] });
      const first = (await promoter.agent.get('/promoter/messages?tab=campaigns&status=open').set('accept', 'application/json').expect(200)).body;
      assert.equal(first.page.total, 31); assert.equal(first.records.length, 25); assert.equal(first.filters.params.tab, 'campaigns');
      const second = (await promoter.agent.get('/promoter/messages?tab=campaigns&status=open&after=' + encodeURIComponent(first.page.next)).set('accept', 'application/json').expect(200)).body;
      assert.equal(second.records.length, 6); assert.ok(second.records.every(row => !first.records.some(previous => previous.publicId === row.publicId)));
      const empty = (await promoter.agent.get('/promoter/messages?tab=campaigns&search=missing-partnership').set('accept', 'application/json').expect(200)).body;
      assert.equal(empty.records.length, 0); assert.equal(empty.page.total, 0);
      await promoter.agent.get('/promoter/messages?tab=campaigns&after=invalid-cursor').set('accept', 'application/json').expect(422);
    });
  } finally {
    for (const transport of transports) transport.destroy();
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
  }
});

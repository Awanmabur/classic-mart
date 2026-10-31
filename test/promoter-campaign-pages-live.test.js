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
for (const name of ['SESSION_SECRET', 'TOKEN_PEPPER', 'SECURITY_INTEGRITY_KEY', 'DATA_ENCRYPTION_KEY']) process.env[name] = crypto.randomBytes(32).toString('hex');
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if (uri) process.env.MONGO_URI = uri;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('Promoter destinations and campaign assets stay on approved local paths', async () => {
  const { validatePromoterDestination, safeCampaignAssetUrl } = await import('../src/services/promoter-campaign-pages.js');
  for (const path of ['/', '/products', '/products/prd_approved']) assert.equal(validatePromoterDestination(path), path);
  for (const path of ['//evil.example/path', '/\\evil.example', 'https://evil.example', '/%2fevil.example', '/products/prd_good?next=evil', '/account/security', '/products/../../login', '/products/prd_good#fragment', '/products/prd_good\n/login']) assert.throws(() => validatePromoterDestination(path), path);
  assert.equal(safeCampaignAssetUrl('/assets/campaigns/approved.png'), '/assets/campaigns/approved.png');
  assert.equal(safeCampaignAssetUrl('/media/catalogue/med_approved'), '/media/catalogue/med_approved');
  for (const path of ['javascript:alert(1)', '//evil.example/a.png', 'https://private.example/token', '/assets/../private.png', '/account/security']) assert.equal(safeCampaignAssetUrl(path), '');
});

test('Promoter campaign and profile pages complete real scoped signup, promotion and settings flows', { skip: !uri, timeout: 150000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: `classicmart_promoter_campaign_test_${suffix}` });
  const models = await import('../src/models/index.js');
  const { Device, PlatformGrant, SubscriptionPlan, SubscriptionEnrollment, SubscriptionCharge, User, Store, StoreMember, LedgerAccount, CountrySetting, Category, Product, ProductVariant, PromoterVerification, Campaign, CampaignApplication, PromoterLink, AiJob, AuditLog } = models;
  const { createApp } = await import('../src/app.js');
  const { hashPassword, hashToken } = await import('../src/core/crypto.js');
  const services = await import('../src/services/promoter-campaign-pages.js');
  const promoterOperations = await import('../src/services/promoters.js');
  const affiliate = await import('../src/services/seller-affiliate-pages.js');
  const { pendingMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
  const app = createApp(null), password = `Promoter-${suffix}-A1!`, passwordHash = await hashPassword(password), transports = [];
  let sequence = 0;
  function client() {
    const transport = new http.Agent({ localAddress: `127.0.0.${transports.length + 30}`, keepAlive: false });
    transports.push(transport); return request.agent(app).use(req => req.agent(transport));
  }
  async function actor(role = 'promoter') {
    const number = ++sequence, email = `promoter-campaign-${suffix}-${number}@example.com`, phone = '+25670' + String(number).padStart(7, '0');
    const user = await User.create({ publicId: `usr_pc_${suffix}_${number}`, name: `Account ${number}`, email, emailNormalized: email, phone, phoneNormalized: phone,
      passwordHash, role: role === 'country_admin' ? 'customer' : role, country: 'UG', currency: 'UGX', emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
      ...(role === 'country_admin' ? { platformAccessManagedAt: new Date(), operationalCountries: ['UG'] } : {}), consents: { terms: true, privacy: true, recordedAt: new Date() } });
    if (role === 'country_admin') await PlatformGrant.create({ publicId: `pgr_pc_${suffix}_${number}`, userId: user._id, role, operationalCountries: ['UG'],
      status: 'active', startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000),
      approvalPublicId: `apr_pc_${suffix}_${number}`, approvedByUserId: new mongoose.Types.ObjectId(), reason: 'Independent campaign publication reviewer.' });
    const agent = client(), login = await agent.get('/login').expect(200);
    await agent.post('/login').type('form').send({ email, password, _csrf: csrf(login.text) }).expect(302);
    if (['seller', 'country_admin'].includes(role)) {
      const security = await agent.get('/account/security').expect(200);
      await agent.post('/account/mfa/begin').type('form').send({ currentPassword: password, _csrf: csrf(security.text) }).expect(302);
      const pending = await pendingMfaEnrollment(user._id), enrollment = await agent.get('/account/security').expect(200);
      await agent.post('/account/mfa/confirm').type('form').send({ code: totpCode(pending.secret), _csrf: csrf(enrollment.text) }).expect(302);
    }
    const current = await User.findById(user._id), sessionID = crypto.randomUUID();
    const device = await Device.create({ publicId: `dev_pc_${suffix}_${number}`, userId: current._id, sessionHash: hashToken(sessionID),
      label: 'Current programme fixture session', userAgent: 'Promoter campaign fixture', ipHash: hashToken('127.0.0.1'), lastSeenAt: new Date() });
    return { user: current, agent, sessionID, device };

  }
  function scoped(entry, body = {}, params = {}) {
    return { user: entry.user, sessionID: entry.sessionID, device: entry.device, store: entry.store,
      session: { userId: String(entry.user._id), tokenVersion: entry.user.security.tokenVersion, activeStorePublicId: entry.store?.publicId, mfaVerifiedAt: Date.now() }, query: {}, body, params,
      id: `test_pc_${suffix}_${crypto.randomBytes(4).toString('hex')}`, ip: '127.0.0.1', get: () => 'Promoter campaign verification', country: { code: 'UG', currency: 'UGX' } };
  }
  async function freshCampaign(row) { return Campaign.findById(row._id); }
  try {
    await Promise.all(Object.values(models).filter(model => typeof model?.init === 'function').map(model => model.init()));
    const setting = await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true, growth: { promoterCommissionBps: 300 } });
    await CountrySetting.create({ code: 'KE', name: 'Kenya', currency: 'KES', locale: 'en-KE', timeZone: 'Africa/Nairobi', phonePrefix: '+254', active: true });

    await t.test('public Promoter signup retains its account intent through email verification and onboarding', async () => {
      const agent = client(), signup = await agent.get('/signup?role=promoter').expect(200), email = `new-promoter-${suffix}@example.com`;
      assert.match(signup.text, /name="accountType" type="hidden" value="promoter"/);
      assert.doesNotMatch(signup.text, /id="roleSwitcher"|<select[^>]*name="accountType"/);
      await agent.post('/signup').type('form').send({ name: 'Real New Promoter', email, phoneCountry: 'UG', phone: '0758123456', password, confirmPassword: password,
        accountType: 'promoter', acceptTerms: 'on', _csrf: csrf(signup.text) }).expect(302).expect('location', '/verify-email');
      let registered = await User.findOne({ emailNormalized: email }).select('+passwordHash');
      assert.equal(registered.role, 'promoter'); assert.match(registered.passwordHash, /^\$argon2id\$/);
      const verification = await agent.get('/verify-email').expect(200), code = verification.text.match(/Development verification code:\s*(\d{6})/)?.[1];
      assert.ok(code, 'the real signup challenge is displayed by the test-only delivery sink');
      await agent.get('/promoter/marketplace').expect(302).expect('location', '/verify-email');
      await agent.post('/verify-email').type('form').send({ code, _csrf: csrf(verification.text) }).expect(302).expect('location', '/onboarding');
      const onboarding = await agent.get('/onboarding').expect(200);
      await agent.post('/onboarding').type('form').send({ role: 'promoter', publicName: 'Real Promoter', location: 'Kampala', _csrf: csrf(onboarding.text) }).expect(302).expect('location', '/promoter/overview');
      await agent.get('/promoter/profile').expect(200);
      registered = await User.findById(registered._id);
      assert.equal(registered.role, 'promoter'); assert.ok(registered.emailVerifiedAt); assert.ok(registered.onboardingCompletedAt);
      assert.equal(registered.phoneVerifiedAt, undefined); assert.equal(await Store.exists({ ownerUserId: registered._id }), null);
      assert.equal(await LedgerAccount.exists({ code: 'customer_wallet', ownerPublicId: registered.publicId }), null, 'Promoter workspace reads do not create a Customer wallet');
      const returning = client(), login = await returning.get('/login').expect(200);
      await returning.post('/login').type('form').send({ email, password, _csrf: csrf(login.text) }).expect(302).expect('location', '/promoter/overview');
      await returning.get('/promoter/links').expect(200);
    });

    const owner = await actor(), other = await actor(), customer = await actor('customer'), administrator = await actor('super_admin'), merchant = await actor('seller'), unverified = await actor(), reviewer = await actor('country_admin');
    const verification = await PromoterVerification.create({ publicId: `prv_pc_${suffix}`, userId: owner.user._id, country: 'UG', status: 'verified', channels: ['Instagram'], niches: ['Technology'], audienceSize: 1200, disclosureAcceptedAt: new Date() });
    await PromoterVerification.create({ publicId: `prv_other_pc_${suffix}`, userId: other.user._id, country: 'UG', status: 'verified' });
    const store = await Store.create({ publicId: `sto_pc_${suffix}`, ownerUserId: merchant.user._id, name: 'Approved Merchant', slug: `approved-merchant-${suffix}`, country: 'UG', currency: 'UGX', status: 'verified' });
    merchant.store = store;
    const membership = await StoreMember.create({ publicId: `stm_pc_owner_${suffix}`, storeId: store._id, userId: merchant.user._id,
      role: 'owner', status: 'active', acceptedAt: new Date(), invitedByUserId: merchant.user._id });
    // This read/pagination fixture starts with an already-paid, immutable period;
    // provider verification and activation are exercised by seller-recovery-live.
    const entitlements = { productLimit: 50, seatLimit: 1, campaignLimit: 100, analyticsDays: 30, analyticsExport: false };
    const plan = await SubscriptionPlan.create({ publicId: `spl_pc_${suffix}`, key: `pc-${suffix}`, name: 'Historical campaign capacity', audience: 'seller',
      country: 'UG', currency: 'UGX', priceMinor: 2500, cadence: 'monthly', status: 'active', entitlements,
      createdByUserId: reviewer.user._id, updatedByUserId: reviewer.user._id });
    const terms = { planPublicId: plan.publicId, planVersion: plan.__v, name: plan.name, priceMinor: plan.priceMinor, country: 'UG', currency: 'UGX', cadence: 'monthly', entitlements };
    const enrollmentId = new mongoose.Types.ObjectId(), chargeId = new mongoose.Types.ObjectId(), enrollmentPublicId = `sen_pc_${suffix}`, chargePublicId = `sch_pc_${suffix}`;
    await SubscriptionEnrollment.create({ _id: enrollmentId, publicId: enrollmentPublicId, planId: plan._id, planPublicId: plan.publicId, audience: 'seller', userId: merchant.user._id,
      storeId: store._id, storePublicId: store.publicId, country: 'UG', currency: 'UGX', priceMinor: plan.priceMinor, status: 'active',
      startsAt: new Date(Date.now() - 60_000), currentPeriodEndsAt: new Date(Date.now() + 86_400_000), terms, subscriptionChargeId: chargeId, subscriptionChargePublicId: chargePublicId });
    await SubscriptionCharge.create({ _id: chargeId, publicId: chargePublicId, requestId: new mongoose.Types.ObjectId(), requestPublicId: `scr_pc_${suffix}`,
      userId: merchant.user._id, payerTokenVersion: merchant.user.security.tokenVersion, payerMembershipId: membership._id, storeId: store._id, storePublicId: store.publicId,
      country: 'UG', currency: 'UGX', amountMinor: plan.priceMinor, terms, idempotencyKey: `historical-pc-${suffix}`, providerReference: `historical-pc-${suffix}`,
      status: 'succeeded', paidAt: new Date(Date.now() - 60_000), enrollmentId, enrollmentPublicId });
    async function independentlyApproveCampaign(row) {
      const savedAssets = row.assets.map(value => value.toObject());
      // The legacy invalid assets below intentionally exercise defensive output
      // filtering. They are never submitted as acceptable review evidence.
      row.assets = savedAssets.filter(asset => services.safeCampaignAssetUrl(asset.url));
      row.status = 'draft'; row.scope = 'seller'; row.systemManaged = false;
      row.createdByUserId = merchant.user._id; row.disclosureText ||= 'Sponsored Seller affiliate campaign';
      if (!row.facts.length) row.facts = ['Current approved product facts'];
      await row.save();
      await promoterOperations.submitCampaign(scoped(merchant), row.publicId, { version: row.__v });
      const submitted = await Campaign.findById(row._id);
      assert.equal(submitted.status, 'submitted'); assert.equal(String(submitted.submittedByUserId), String(merchant.user._id));
      await promoterOperations.reviewCampaign(scoped(reviewer), row.publicId, { version: submitted.__v, decision: 'approve', reason: 'Independent review of this exact Seller campaign source.' });
      const current = await Campaign.findById(row._id);
      assert.equal(current.status, 'active'); assert.equal(String(current.reviewedByUserId), String(reviewer.user._id));
      await Campaign.updateOne({ _id: row._id }, { $set: { assets: savedAssets } });
      return Campaign.findById(row._id);
    }
    async function decideApplication(row, decision = 'approve') {
      const current = await CampaignApplication.findById(row._id);
      await affiliate.decideSellerAffiliateApplication(scoped(merchant), current.publicId, { version: current.__v, decision, reason: 'Seller reviewed the independent verified applicant.' });
      return CampaignApplication.findById(row._id);
    }
    const category = await Category.create({ publicId: `cat_pc_${suffix}`, name: 'Technology', slug: `technology-${suffix}`, active: true, countries: ['UG'] });
    const product = await Product.create({ publicId: `prd_pc_${suffix}`, storeId: store._id, ownerUserId: merchant.user._id, categoryId: category._id, title: 'Approved Product', slug: `approved-product-${suffix}`,
      description: 'Real approved product facts.', countries: ['UG'], status: 'published', publishedAt: new Date() });
    const variant = await ProductVariant.create({ publicId: `var_pc_${suffix}`, productId: product._id, storeId: store._id, sku: `APPROVED-${suffix}`, title: 'Standard', priceMinor: 35000, currency: 'UGX', active: true });
    const campaign = await Campaign.create({ publicId: `cmp_public_pc_${suffix}`, ownerUserId: merchant.user._id, storeId: store._id, country: 'UG', name: 'Public Approved Campaign', status: 'active', commissionBps: 500,
      productPublicIds: [product.publicId], allowedChannels: ['Instagram'], facts: ['Approved product fact'], assets: [{ type: 'image', url: '/assets/campaigns/approved.png', label: 'Approved asset', approved: true }, { type: 'copy', url: 'https://private.example/token', label: 'PRIVATE_ASSET', approved: true }, { type: 'image', url: '/assets/campaigns/private.png', label: 'UNAPPROVED_ASSET', approved: false }] });
    const invitation = await Campaign.create({ publicId: `cmp_invite_pc_${suffix}`, ownerUserId: merchant.user._id, storeId: store._id, country: 'UG', name: 'Invitation Campaign', visibility: 'invite_only', status: 'active',
      productPublicIds: [product.publicId], facts: ['INVITE_PRIVATE_FACT'], assets: [{ type: 'image', url: '/assets/campaigns/invite.png', label: 'INVITE_PRIVATE_ASSET', approved: true }] });
    await independentlyApproveCampaign(campaign); await independentlyApproveCampaign(invitation);
    const foreign = await Campaign.create({ publicId: `cmp_foreign_pc_${suffix}`, ownerUserId: merchant.user._id, storeId: store._id, country: 'KE', name: 'FOREIGN_COUNTRY_CAMPAIGN', status: 'active', productPublicIds: [product.publicId] });

    await t.test('five canonical pages render live Promoter forms and safe marketplace briefs', async () => {
      for (const slug of ['marketplace', 'campaigns', 'links', 'content', 'profile']) {
        const page = await owner.agent.get('/promoter/' + slug).expect(200);
        assert.match(page.headers['cache-control'], /no-store/); assert.match(page.headers['x-robots-tag'], /noindex/);
        assert.match(page.text, new RegExp('data-dashboard-page="promoter-' + slug + '"'));
        assert.doesNotMatch(page.text, /id="roleSwitcher"|Classic Club|demo-live/);
        await owner.agent.get('/dashboard/promoter-' + slug + '?search=retained').expect(308).expect('location', '/promoter/' + slug + '?search=retained');
      }
      const page = (await owner.agent.get('/promoter/marketplace').set('accept', 'application/json').expect(200)).body;
      assert.ok(page.marketplaceCampaigns.some(row => row.publicId === campaign.publicId));
      assert.ok(page.marketplaceCampaigns.some(row => row.publicId === invitation.publicId));
      assert.ok(!JSON.stringify(page).includes('INVITE_PRIVATE_FACT')); assert.ok(!JSON.stringify(page).includes('INVITE_PRIVATE_ASSET'));
      assert.ok(!JSON.stringify(page).includes('PRIVATE_ASSET')); assert.ok(!JSON.stringify(page).includes(foreign.publicId));
      const detail = (await owner.agent.get('/promoter/marketplace?campaign=' + campaign.publicId).set('accept', 'application/json').expect(200)).body.detail;
      assert.deepEqual(detail.facts, ['Approved product fact']); assert.equal(detail.assets.length, 1); assert.equal(detail.products[0].href, '/products/' + product.publicId);
      const profile = (await owner.agent.get('/promoter/profile').set('accept', 'application/json').expect(200)).body;
      for (const hidden of ['passwordHash', 'tokenVersion', 'mfaSecret', 'reviewedByUserId', 'emailNormalized']) assert.ok(!JSON.stringify(profile).includes(hidden));
      const html = await owner.agent.get('/promoter/profile?section=notifications').expect(200);
      assert.equal((html.text.match(/class="switch"/g) || []).length, 3); assert.match(html.text, /Conversation alerts/); assert.doesNotMatch(html.text, /Wishlist alerts|Membership and club updates/);
    });

    await t.test('guest campaign metadata excludes private briefs and invalid catalogue eligibility', async () => {
      const guest = await request(app).get('/api/v1/campaigns?limit=1').expect(200);
      assert.equal(guest.body.campaigns.length, 1);
      assert.equal(guest.body.page.hasMore, true);
      const next = await request(app).get('/api/v1/campaigns?limit=1&after=' + guest.body.page.next).expect(200);
      assert.equal(next.body.campaigns.length, 1); assert.notEqual(next.body.campaigns[0].publicId, guest.body.campaigns[0].publicId);
      for (const hidden of ['INVITE_PRIVATE', 'ownerUserId', 'storeId', 'facts', 'assets', 'reviewedByUserId']) assert.ok(!JSON.stringify(guest.body).includes(hidden));
      const all = await request(app).get('/api/v1/campaigns?limit=100').expect(200);
      assert.ok(all.body.campaigns.some(row => row.publicId === campaign.publicId)); assert.ok(!all.body.campaigns.some(row => row.publicId === invitation.publicId));
      await User.updateOne({ _id: merchant.user._id }, { $set: { status: 'suspended' } });
      const unavailable = await request(app).get('/api/v1/campaigns?limit=100').expect(200);
      assert.ok(!unavailable.body.campaigns.some(row => row.publicId === campaign.publicId));
      await User.updateOne({ _id: merchant.user._id }, { $set: { status: 'active' } });
      await request(app).get('/api/v1/campaigns?after=invalid').expect(422);
      await request(app).get('/api/v1/campaigns?limit=101').expect(422);
    });

    await t.test('applications, tracking links and content kits persist real approved campaign facts', async () => {
      const html = await owner.agent.get('/promoter/marketplace?campaign=' + campaign.publicId).expect(200), token = csrf(html.text);
      await owner.agent.post('/promoter/campaigns/' + campaign.publicId + '/apply').type('form').send({ note: 'My audience follows technology products.' }).expect(403);
      await owner.agent.post('/promoter/campaigns/' + campaign.publicId + '/apply').type('form').send({ note: 'My audience follows technology products.', _csrf: token }).expect(302);
      let application = await CampaignApplication.findOne({ campaignId: campaign._id, promoterUserId: owner.user._id });
      assert.equal(application.status, 'pending'); application = await decideApplication(application); assert.equal(application.status, 'approved');
      assert.equal(String(application.reviewedByUserId), String(merchant.user._id));
      const base = { campaignId: campaign.publicId, destination: '/products/' + product.publicId, channel: 'Instagram', couponCode: `PC_${suffix.toUpperCase()}`, subId: 'weekend-story' };
      await owner.agent.post('/promoter/links').type('form').send({ ...base, _csrf: token }).expect(302).expect('location', '/promoter/links');
      const link = await PromoterLink.findOne({ campaignId: campaign._id, promoterUserId: owner.user._id });
      assert.equal(link.destination, base.destination); assert.equal(link.channel, 'Instagram'); assert.ok(link.token.length >= 24);
      for (const destination of ['//evil.example', '/products/' + product.publicId + '?next=//evil.example', '/account/security']) await owner.agent.post('/promoter/links').set('accept', 'application/json').type('form').send({ ...base, couponCode: '', destination, _csrf: token }).expect(422);
      await owner.agent.post('/promoter/links').set('accept', 'application/json').type('form').send({ ...base, couponCode: '', channel: 'Forbidden Channel', _csrf: token }).expect(422);
      const result = await owner.agent.post('/promoter/content').type('form').send({ campaignId: campaign.publicId, channel: 'Instagram', _csrf: token }).expect(302);
      const kit = await AiJob.findOne({ actorUserId: owner.user._id, type: 'promoter_content' }); assert.equal(kit.status, 'completed'); assert.equal(kit.provider, 'deterministic');
      assert.equal(kit.result.generator, 'approved-campaign-facts'); assert.deepEqual(kit.result.approvedFacts, campaign.facts); assert.match(kit.result.caption, /Approved product fact/); assert.match(kit.result.caption, /Sponsored\/affiliate/);
      assert.equal(kit.result.assets.length, 1); assert.ok(await PromoterLink.exists({ publicId: kit.result.linkPublicId, promoterUserId: owner.user._id }));
      const saved = await owner.agent.get(result.headers.location).expect(200); assert.match(saved.text, /Approved product fact/); assert.doesNotMatch(saved.text, /PRIVATE_ASSET|UNAPPROVED_ASSET/);
      const hidden = (await other.agent.get('/promoter/links').set('accept', 'application/json').expect(200)).body; assert.ok(!JSON.stringify(hidden).includes(link.publicId));
      await other.agent.post('/promoter/links/' + link.publicId + '/deactivate').type('form').send({ version: link.__v, _csrf: csrf((await other.agent.get('/promoter/links')).text) }).expect(404);
      await owner.agent.post('/promoter/links/' + link.publicId + '/deactivate').field('version', String(link.__v)).expect(403);
      assert.equal((await PromoterLink.findById(link._id)).active, true, 'multipart cannot bypass deferred CSRF');
    });

    await t.test('invitation review gates private content; rejected programmes and self promotion cannot earn', async () => {
      const pending = await services.secureApplyToCampaign(scoped(owner), invitation.publicId, 'Invitation request'); assert.equal(pending.status, 'pending');
      await assert.rejects(services.secureCreatePromoterLink(scoped(owner), { campaignId: invitation.publicId, destination: '/products/' + product.publicId }), error => error.code === 'CAMPAIGN_APPROVAL_REQUIRED');
      assert.ok(!JSON.stringify((await owner.agent.get('/promoter/campaigns?campaign=' + invitation.publicId).set('accept', 'application/json')).body).includes('INVITE_PRIVATE_FACT'));
      await decideApplication(pending);
      assert.ok(JSON.stringify((await owner.agent.get('/promoter/campaigns?campaign=' + invitation.publicId).set('accept', 'application/json')).body).includes('INVITE_PRIVATE_FACT'));
      await decideApplication(pending, 'revoke');
      assert.ok(!JSON.stringify((await owner.agent.get('/promoter/campaigns?campaign=' + invitation.publicId).set('accept', 'application/json')).body).includes('INVITE_PRIVATE_FACT'));
      await PromoterVerification.updateOne({ _id: verification._id }, { $set: { status: 'rejected' }, $inc: { __v: 1 } });
      await assert.rejects(services.secureCreatePromoterLink(scoped(owner), { campaignId: campaign.publicId, destination: '/products/' + product.publicId }), error => error.code === 'PROMOTER_VERIFICATION_REQUIRED');
      await PromoterVerification.updateOne({ _id: verification._id }, { $set: { status: 'verified' }, $inc: { __v: 1 } });
      const member = await StoreMember.create({ publicId: `stm_pc_${suffix}`, storeId: store._id, userId: owner.user._id, role: 'catalogue', status: 'active', invitedByUserId: merchant.user._id });
      await assert.rejects(services.secureCreatePromoterLink(scoped(owner), { campaignId: campaign.publicId, destination: '/products/' + product.publicId }), error => error.code === 'SELF_REFERRAL');
      await StoreMember.deleteOne({ _id: member._id });
      await assert.rejects(services.secureApplyToCampaign(scoped(owner), foreign.publicId), error => error.code === 'CAMPAIGN_NOT_FOUND');
    });

    await t.test('stale writes, concurrent applications and failed transactional audits preserve records', async () => {
      const current = await freshCampaign(campaign);
      await Campaign.updateOne({ _id: campaign._id }, { $inc: { __v: 1 } });
      await assert.rejects(services.secureCreatePromoterLink(scoped(owner), { campaignId: campaign.publicId, campaignVersion: current.__v, destination: '/products/' + product.publicId }), error => error.code === 'PROMOTER_VERSION_CONFLICT');
      const before = await PromoterLink.countDocuments({ promoterUserId: owner.user._id });
      const badAudit = scoped(owner); delete badAudit.id;
      await assert.rejects(services.secureCreatePromoterLink(badAudit, { campaignId: campaign.publicId, destination: '/products/' + product.publicId }));
      assert.equal(await PromoterLink.countDocuments({ promoterUserId: owner.user._id }), before);
      const results = await Promise.all([services.secureApplyToCampaign(scoped(other), campaign.publicId, 'First application'), services.secureApplyToCampaign(scoped(other), campaign.publicId, 'Second application')]);
      assert.equal(results[0].publicId, results[1].publicId); assert.equal(await CampaignApplication.countDocuments({ campaignId: campaign._id, promoterUserId: other.user._id }), 1);
      assert.equal(await AuditLog.countDocuments({ action: 'promoter.campaign_applied', actorId: other.user._id, targetPublicId: results[0].publicId }), 1);
      const link = await PromoterLink.findOne({ campaignId: campaign._id, promoterUserId: owner.user._id });
      await services.updatePromoterLink(scoped(owner, { version: link.__v, destination: link.destination, channel: 'Instagram', subId: 'Updated actual reference' }, { id: link.publicId }));
      await assert.rejects(services.updatePromoterLink(scoped(owner, { version: link.__v }, { id: link.publicId }), { deactivate: true }), error => error.code === 'PROMOTER_VERSION_CONFLICT');
      await Campaign.updateOne({ _id: campaign._id }, { $set: { status: 'ended' } });
      const updated = await PromoterLink.findById(link._id);
      await services.updatePromoterLink(scoped(owner, { version: updated.__v }, { id: link.publicId }), { deactivate: true });
      assert.equal((await PromoterLink.findById(link._id)).active, false, 'owners can deactivate historical links');
      await Campaign.updateOne({ _id: campaign._id }, { $set: { status: 'active' } });
    });

    await t.test('profile saves persist real preferences and verification disclosure without rewriting verified contact details', async () => {
      let page = await owner.agent.get('/promoter/profile').set('accept', 'application/json').expect(200), token = csrf((await owner.agent.get('/promoter/profile')).text);
      const original = await User.findById(owner.user._id);
      const identity = { name: 'Updated Promoter Name', publicName: 'Approved Public Name', bio: 'A saved audience biography', version: page.body.version, _csrf: token, email: 'attacker@example.com', phone: '+256701234567' };
      await owner.agent.post('/promoter/profile/identity').type('form').send(identity).expect(302);
      await owner.agent.post('/promoter/profile/identity').set('accept', 'application/json').type('form').send({ ...identity, name: 'Stale overwritten name' }).expect(409);
      let saved = await User.findById(owner.user._id); assert.equal(saved.name, identity.name); assert.equal(saved.email, original.email); assert.equal(saved.phone, original.phone);
      assert.deepEqual(saved.preferences.notifications.toObject(), original.preferences.notifications.toObject());
      page = await owner.agent.get('/promoter/profile?section=notifications').set('accept', 'application/json');
      await owner.agent.post('/promoter/profile/preferences').type('form').send({ version: page.body.version, lowData: 'on', marketing: 'on', _csrf: token }).expect(302);
      saved = await User.findById(owner.user._id); assert.equal(saved.preferences.promoterMessages, false); assert.equal(saved.preferences.lowData, true); assert.equal(saved.consents.marketing, true);
      assert.deepEqual(saved.preferences.notifications.toObject(), original.preferences.notifications.toObject());
      const freshProfile = (await unverified.agent.get('/promoter/profile').set('accept', 'application/json')).body, unverifiedToken = csrf((await unverified.agent.get('/promoter/profile?section=business')).text);
      const details = { channels: 'Instagram, WhatsApp', niches: 'Technology', audienceSize: '500', audienceLocation: 'Kampala', version: freshProfile.version, _csrf: unverifiedToken };
      await unverified.agent.post('/promoter/profile/channels').type('form').send(details).expect(302);
      let row = await PromoterVerification.findOne({ userId: unverified.user._id }); assert.equal(row.status, 'draft'); assert.deepEqual(row.channels, ['Instagram', 'WhatsApp']);
      await unverified.agent.post('/promoter/profile/verification').set('accept', 'application/json').type('form').send({ ...details, verificationVersion: row.__v }).expect(422);
      await unverified.agent.post('/api/v1/promoters/verification').set('x-csrf-token', unverifiedToken).send({ channels: ['Instagram'], niches: ['Technology'] }).expect(422);
      await unverified.agent.post('/promoter/profile/verification').type('form').send({ ...details, verificationVersion: row.__v, disclosureAccepted: 'on' }).expect(302);
      row = await PromoterVerification.findOne({ userId: unverified.user._id }); assert.equal(row.status, 'submitted'); assert.ok(row.disclosureAcceptedAt); assert.equal(row.audienceSize, 500);
      await assert.rejects(services.secureApplyToCampaign(scoped(unverified), campaign.publicId), error => error.code === 'PROMOTER_VERIFICATION_REQUIRED');
      await unverified.agent.post('/promoter/profile/verification').set('accept', 'application/json').type('form').send({ ...details, verificationVersion: row.__v - 1, disclosureAccepted: 'on' }).expect(409);
    });

    await t.test('operating country, filters, catalogue revocation and current identity fail closed', async () => {
      await User.updateOne({ _id: owner.user._id }, { $set: { shoppingCountry: 'KE', currency: 'KES' } });
      const page = (await owner.agent.get('/promoter/marketplace?brand=' + store.publicId).set('accept', 'application/json').expect(200)).body;
      assert.equal(page.market.country, 'UG'); assert.equal(page.market.currency, 'UGX'); assert.equal(page.filters.params.brand, store.publicId);
      for (const query of ['status=unknown', 'status=approved&status=pending', 'search[bad]=x', 'after=invalid', 'brand[]=bad']) await owner.agent.get('/promoter/marketplace?' + query).set('accept', 'application/json').expect(422);
      await owner.agent.get('/promoter/profile?section=unknown').set('accept', 'application/json').expect(422);
      await owner.agent.get('/promoter/links?link=plk_unknown').set('accept', 'application/json').expect(404);
      for (const entry of [customer, administrator, merchant]) await entry.agent.get('/promoter/marketplace').set('accept', 'application/json').expect(403);
      await ProductVariant.updateOne({ _id: variant._id }, { $set: { active: false } });
      assert.ok(!(await services.eligiblePromoterCampaigns(setting.toObject())).some(row => row.publicId === campaign.publicId));
      await assert.rejects(services.secureCreatePromoterLink(scoped(owner), { campaignId: campaign.publicId, destination: '/products/' + product.publicId }), error => error.code === 'CAMPAIGN_PRODUCT_SCOPE');
      await ProductVariant.updateOne({ _id: variant._id }, { $set: { active: true } });
      const fresh = await actor();
      for (const patch of [{ role: 'customer' }, { status: 'suspended' }, { emailVerifiedAt: null }, { onboardingCompletedAt: null }, { 'security.tokenVersion': 1 }]) {
        await User.updateOne({ _id: fresh.user._id }, { $set: patch });
        await assert.rejects(services.promoterCampaignPage(scoped(fresh), 'marketplace'), error => error.status === 403);
        await User.updateOne({ _id: fresh.user._id }, { $set: { role: 'promoter', status: 'active', emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(), 'security.tokenVersion': 0 } });
      }
    });

    await t.test('campaign and link pagination keeps exact filtered totals and safe complete exports', async () => {
      const paginationSources = await Campaign.insertMany(Array.from({ length: 23 }, (_, index) => ({ publicId: `cmp_page_pc_${suffix}_${index}`, ownerUserId: merchant.user._id, storeId: store._id,
        country: 'UG', name: `${index === 0 ? '=' : ''}Pagination approved ${index}`, status: 'submitted', productPublicIds: [product.publicId] })));
      for (const source of paginationSources) await independentlyApproveCampaign(source);
      const first = (await owner.agent.get('/promoter/marketplace?search=Pagination&status=available').set('accept', 'application/json').expect(200)).body;
      assert.equal(first.page.total, 23); assert.equal(first.rows.length, 20); assert.equal(first.page.hasMore, true);
      const second = (await owner.agent.get('/promoter/marketplace?search=Pagination&status=available&after=' + first.page.next).set('accept', 'application/json').expect(200)).body;
      assert.equal(second.rows.length, 3); assert.equal(second.page.hasMore, false);
      assert.ok(second.rows.every(row => !first.rows.some(previous => previous.id === row.id)));
      const csv = await owner.agent.get('/promoter/marketplace/export.csv?search=Pagination&status=available').expect(200);
      assert.equal(csv.text.trim().split('\r\n').length, 24); assert.match(csv.text, /"'=Pagination approved 0"/);
      await PromoterLink.insertMany(Array.from({ length: 23 }, (_, index) => ({ publicId: `plk_page_pc_${suffix}_${index}`, campaignId: campaign._id, promoterUserId: owner.user._id,
        token: `page_${suffix}_${index}`, destination: '/products/' + product.publicId, channel: 'Pagination channel', active: index % 2 === 0 })));
      const links = (await owner.agent.get('/promoter/links?search=Pagination&status=active').set('accept', 'application/json').expect(200)).body;
      assert.equal(links.page.total, 12); assert.equal(links.rows.length, 12); assert.ok(links.rows.every(row => row.cells.at(-1) === 'Active'));
      const brand = (await owner.agent.get('/promoter/marketplace?brand=' + store.publicId + '&search=Pagination').set('accept', 'application/json').expect(200)).body;
      assert.equal(brand.page.total, 23); assert.equal(brand.filters.params.brand, store.publicId);
    });
  } finally {
    for (const transport of transports) transport.destroy();
    await Promise.all(Object.values(models).filter(model => typeof model?.init === 'function').map(model => model.init()));
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
  }
});

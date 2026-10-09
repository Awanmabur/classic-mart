import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'false';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const csrf = html => html.match(/name="_csrf"[^>]*value="([^"]+)"/)[1];

test('seller registration survives verification, onboarding and later login without granting staff privilege', { skip: !uri }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  await mongoose.connect(uri, { dbName: `classicmart_seller_signup_test_${suffix}` });
  const { createApp } = await import('../src/app.js');
  const models = await import('../src/models/index.js');
  const { User, Store, StoreMember, CountrySetting, PlatformGrant, Order, CustomerAddress, AuditLog, Category, Product } = models;
  const app = createApp(null);
  const password = `Seller-${suffix}-A1!`;
  let sequence = 0, server, browser;
  const transports = [];
  const input = () => ({ name: 'New Seller', email: `seller-signup-${suffix}-${sequence++}@example.com`,
    phoneCountry: 'UG', phone: '07' + crypto.randomInt(10000000, 99999999), password, confirmPassword: password, acceptTerms: 'on' });
  async function verify(agent, verificationPage) {
    const page = verificationPage || await agent.get('/verify-email').expect(200);
    const code = page.text.match(/Development verification code: (\d{6})/)[1];
    await agent.post('/verify-email').type('form').send({ code, _csrf: csrf(page.text) }).expect(302).expect('location', '/onboarding');
  }
  async function completedCustomer() {
    const { hashPassword } = await import('../src/core/crypto.js');
    const values = input(), user = await User.create({ publicId: `usr_customer_${suffix}_${sequence++}`, name: 'Existing Customer', email: values.email,
      emailNormalized: values.email, phone: '+256' + values.phone.slice(1), phoneNormalized: '+256' + values.phone.slice(1),
      passwordHash: await hashPassword(password), role: 'customer', country: 'UG', emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
      roleProfile: { publicName: 'Existing Customer Profile', location: 'Kampala', bio: 'Original profile biography' },
      preferences: { lowData: true }, consents: { terms: true, privacy: true, marketing: true, recordedAt: new Date() } });
    const transport = new http.Agent({ localAddress: `127.0.0.${transports.length + 2}`, keepAlive: false });
    transports.push(transport);
    const agent = request.agent(app).use(req => req.agent(transport));
    const login = await agent.get('/login').expect(200);
    await agent.post('/login').type('form').send({ email: values.email, password, _csrf: csrf(login.text) }).expect(302).expect('location', '/dashboard');
    const page = await agent.get('/onboarding/seller').expect(200);
    const body = { role: 'seller', confirmSeller: 'on', publicName: 'Existing Customer Profile', businessName: 'Deliberate Seller Store',
      location: 'Kampala', bio: 'Original profile biography', version: page.text.match(/name="version" type="hidden" value="(\d+)"/)[1], _csrf: csrf(page.text) };
    return { user: await User.findById(user._id).select('+passwordHash +emailNormalized +phoneNormalized'), values, agent, body };
  }
  try {
    await Promise.all(Object.values(models).filter(model => typeof model?.init === 'function').map(model => model.init()));
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true });

    await t.test('seller entrypoint renders an explicit account intent and keeps it after validation errors', async () => {
      const agent = request.agent(app), page = await agent.get('/signup?role=seller').expect(200), values = input();
      assert.match(page.text, /name="accountType" type="hidden" value="seller"/);
      assert.match(page.text, /Free seller account/);
      assert.doesNotMatch(page.text, /name="accountType"[^>]*<(?:select|option)|roleSwitcher/);
      const invalid = await agent.post('/signup').type('form').send({ ...values, accountType: 'seller', confirmPassword: 'Wrong-confirmation-A1!', _csrf: csrf(page.text) }).expect(422);
      assert.match(invalid.text, /name="accountType" type="hidden" value="seller"/);
      assert.match(invalid.text, /Free seller account/);
      assert.equal(await User.exists({ emailNormalized: values.email }), null);
      const privileged = await request(app).get('/signup?role=super_admin').expect(200);
      assert.match(privileged.text, /name="accountType" type="hidden" value="customer"/);
    });

    await t.test('a new seller reaches its approved store dashboard after email and profile completion, then on later login', async () => {
      const agent = request.agent(app), form = await agent.get('/signup?role=seller').expect(200), values = input();
      await agent.post('/signup').type('form').send({ ...values, accountType: 'seller', _csrf: csrf(form.text) }).expect(302).expect('location', '/verify-email');
      let seller = await User.findOne({ emailNormalized: values.email }).select('+passwordHash');
      assert.equal(seller.role, 'seller');
      assert.match(seller.passwordHash, /^\$argon2id\$/);
      assert.equal(seller.onboardingCompletedAt, undefined);
      const verificationPage = await agent.get('/verify-email').expect(200);
      await agent.get('/seller/store').expect(302).expect('location', '/verify-email');
      await verify(agent, verificationPage);
      await agent.get('/seller/store').expect(302).expect('location', '/onboarding');
      const onboarding = await agent.get('/onboarding').expect(200);
      assert.match(onboarding.text, /<input checked name="role" required type="radio" value="seller"/);
      await agent.post('/onboarding').type('form').send({ role: 'seller', publicName: 'New Seller', businessName: 'Registration Store', location: 'Kampala', _csrf: csrf(onboarding.text) }).expect(302).expect('location', '/seller/store');
      const dashboard = await agent.get('/seller/store').expect(200);
      assert.match(dashboard.text, /data-dashboard-page="seller-store"/);
      assert.match(dashboard.text, /Registration Store/);
      assert.equal(dashboard.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
      await agent.get('/dashboard').expect(302).expect('location', '/seller/store');
      seller = await User.findById(seller._id);
      assert.ok(seller.emailVerifiedAt);
      assert.ok(seller.onboardingCompletedAt);
      assert.equal(seller.phoneVerifiedAt, undefined, 'phone verification stays optional at signup');
      assert.equal(seller.platformAccessManagedAt, undefined);
      const store = await Store.findOne({ ownerUserId: seller._id });
      assert.equal(store.status, 'pending_verification', 'public signup never approves a seller store');
      assert.ok(await StoreMember.exists({ storeId: store._id, userId: seller._id, role: 'owner', status: 'active' }));
      await agent.get('/warehouse').set('accept', 'application/json').expect(403);
      await agent.get('/dashboard/super-overview').set('accept', 'application/json').expect(403);
      // Retrying an old onboarding form must not reset a completed seller to customer.
      await agent.post('/onboarding').type('form').send({ role: 'customer', publicName: 'Tampered Retry', location: 'Kampala', _csrf: csrf(onboarding.text) }).expect(302).expect('location', '/seller/store');
      assert.equal((await User.findById(seller._id)).role, 'seller');
      const loginAgent = request.agent(app), login = await loginAgent.get('/login').expect(200);
      await loginAgent.post('/login').type('form').send({ email: values.email, password, _csrf: csrf(login.text) }).expect(302).expect('location', '/seller/store');
      await loginAgent.get('/seller/store').expect(200);
    });

    await t.test('ordinary signup stays customer and explicit operational account types are rejected', async () => {
      const customer = request.agent(app), form = await customer.get('/signup').expect(200), values = input();
      await customer.post('/signup').type('form').send({ ...values, role: 'super_admin', operationalCountries: ['*'], _csrf: csrf(form.text) }).expect(302).expect('location', '/verify-email');
      assert.equal((await User.findOne({ emailNormalized: values.email })).role, 'customer');
      await verify(customer);
      const onboarding = await customer.get('/onboarding').expect(200);
      assert.match(onboarding.text, /<input checked name="role" required type="radio" value="customer"/);
      await customer.post('/onboarding').type('form').send({ role: 'customer', publicName: 'New Customer', location: 'Kampala', _csrf: csrf(onboarding.text) }).expect(302).expect('location', '/dashboard');
      await customer.get('/dashboard').expect(200);
      await customer.post('/onboarding').type('form').send({ role: 'seller', publicName: 'Tampered Customer Retry', location: 'Kampala', _csrf: csrf(onboarding.text) }).expect(302).expect('location', '/dashboard');
      assert.equal((await User.findOne({ emailNormalized: values.email })).role, 'customer');
      await customer.get('/seller/store').set('accept', 'application/json').expect(403);
      const attacker = request.agent(app), badForm = await attacker.get('/signup').expect(200), badInput = input();
      await attacker.post('/signup').type('form').send({ ...badInput, accountType: 'warehouse', _csrf: csrf(badForm.text) }).expect(422);
      assert.equal(await User.exists({ emailNormalized: badInput.email }), null);
    });

    await t.test('profile completion and repeated submissions preserve active administrator-managed staff grants', async () => {
      const { hashPassword } = await import('../src/core/crypto.js');
      const values = input(), staff = await User.create({ publicId: `usr_staff_${suffix}`, name: 'Managed Staff', email: values.email,
        emailNormalized: values.email, phone: '+256' + values.phone.slice(1), phoneNormalized: '+256' + values.phone.slice(1),
        passwordHash: await hashPassword(password), role: 'warehouse', country: 'UG', emailVerifiedAt: new Date(),
        platformAccessManagedAt: new Date(), consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const grant = await PlatformGrant.create({ publicId: `pgr_signup_${suffix}`, userId: staff._id, role: 'warehouse', operationalCountries: ['UG'],
        startsAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 3_600_000), status: 'active', reason: 'Isolated signup access integrity fixture',
        approvalPublicId: `approval_signup_${suffix}`, approvedByUserId: staff._id });
      const agent = request.agent(app), login = await agent.get('/login').expect(200);
      await agent.post('/login').type('form').send({ email: values.email, password, _csrf: csrf(login.text) }).expect(302).expect('location', '/onboarding');
      const onboarding = await agent.get('/onboarding').expect(200);
      await agent.post('/onboarding').type('form').send({ role: 'seller', publicName: 'Managed Staff Profile', location: 'Kampala', _csrf: csrf(onboarding.text) }).expect(302).expect('location', '/warehouse');
      assert.equal((await User.findById(staff._id)).role, 'warehouse');
      await agent.post('/onboarding').type('form').send({ role: 'customer', publicName: 'Tampered Staff Retry', location: 'Kampala', _csrf: csrf(onboarding.text) }).expect(302).expect('location', '/warehouse');
      assert.equal((await User.findById(staff._id)).role, 'warehouse');
      assert.equal((await PlatformGrant.findById(grant._id)).status, 'active');
      assert.equal((await PlatformGrant.findById(grant._id)).__v, grant.__v);
      await agent.get('/onboarding/seller').set('accept', 'application/json').expect(403);
      await agent.post('/onboarding/seller').set('accept', 'application/json').type('form').send({ role: 'seller', confirmSeller: 'on', publicName: 'Attempted Staff Seller',
        location: 'Kampala', version: String((await User.findById(staff._id)).__v), _csrf: csrf(onboarding.text) }).expect(403);
      assert.equal((await User.findById(staff._id)).role, 'warehouse');
    });

    await t.test('an existing customer deliberately starts selling while retaining its identity, buyer order and address', async () => {
      const { user, values, agent, body } = await completedCustomer();
      const order = await Order.create({ publicId: `ord_buyer_${suffix}`, userId: user._id, idempotencyKey: `order-key-${suffix}`, checkoutId: `checkout-${suffix}`,
        cartPublicId: `crt_original_${suffix}`, sessionKey: `shopping-${suffix}`, country: 'UG', status: 'paid', paymentState: 'paid', fulfillmentState: 'delivered',
        deliveryMethod: 'standard', paymentMethod: 'cod', contact: { fullName: user.name, email: user.email, phone: user.phone, address: 'Original Delivery Address', city: 'Kampala', country: 'Uganda' },
        totals: { subtotalMinor: 45000, shippingMinor: 5000, discountMinor: 0, taxMinor: 0, totalMinor: 50000, currency: 'UGX' },
        items: [{ linePublicId: `line_original_${suffix}`, productId: new mongoose.Types.ObjectId(), variantId: new mongoose.Types.ObjectId(), storeId: new mongoose.Types.ObjectId(),
          reservationPublicId: `reservation-original-${suffix}`, productPublicId: 'prd_original', variantPublicId: 'var_original', storePublicId: 'str_original', title: 'Original Buyer Purchase',
          variantTitle: 'Standard', sku: 'ORIGINAL-SKU', quantity: 1, deliveredQuantity: 1, unitPriceMinor: 45000, lineTotalMinor: 45000, currency: 'UGX' }], reservationExpiresAt: new Date() });
      const address = await CustomerAddress.create({ publicId: `adr_original_${suffix}`, userId: user._id, fullName: user.name, phone: user.phone,
        address: 'Original Delivery Address', city: 'Kampala', country: 'UG', isDefault: true });
      const originalOrder = (await Order.findById(order._id)).toObject(), originalAddress = (await CustomerAddress.findById(address._id)).toObject();
      await agent.get('/signup?role=seller').expect(302).expect('location', '/onboarding/seller');
      const preview = await agent.get('/onboarding/seller').expect(200);
      assert.match(preview.text, /Start My Seller Account/);
      assert.match(preview.text, /name="role" type="hidden" value="seller"/);
      assert.doesNotMatch(preview.text, /name="role"[^>]*type="radio"/);
      assert.equal((await User.findById(user._id)).role, 'customer', 'viewing the seller offer never mutates the account');
      await agent.post('/onboarding/seller').type('form').send({ ...body, _csrf: undefined }).expect(403);
      await agent.post('/onboarding/seller').type('form').send({ ...body, role: 'warehouse' }).expect(422);
      await agent.post('/onboarding/seller').type('form').send(body).expect(302).expect('location', '/seller/store');
      await agent.get('/seller/store').expect(200);
      await agent.post('/onboarding/seller').type('form').send({ ...body, businessName: 'Replayed Unwanted Store Rename' }).expect(302).expect('location', '/seller/store');
      const seller = await User.findById(user._id).select('+passwordHash +emailNormalized +phoneNormalized');
      for (const field of ['name', 'email', 'emailNormalized', 'phone', 'phoneNormalized', 'passwordHash', 'country', 'currency']) assert.equal(seller[field], user[field], field);
      assert.equal(seller.security.tokenVersion, user.security.tokenVersion);
      assert.deepEqual(seller.preferences.toObject(), user.preferences.toObject());
      assert.deepEqual(seller.consents.toObject(), user.consents.toObject());
      assert.equal(seller.onboardingCompletedAt.getTime(), user.onboardingCompletedAt.getTime());
      assert.equal(seller.roleProfile.businessName, 'Deliberate Seller Store');
      assert.deepEqual((await Order.findById(order._id)).toObject(), originalOrder);
      assert.deepEqual((await CustomerAddress.findById(address._id)).toObject(), originalAddress);
      assert.equal(await AuditLog.countDocuments({ action: 'identity.seller_enrolled', actorId: user._id }), 1);
      const orders = await agent.get('/orders').expect(200);
      assert.match(orders.text, /Original Buyer Purchase/);
      const addresses = await agent.get('/addresses').expect(200);
      assert.match(addresses.text, /Original Delivery Address/);
      const store = await Store.findOne({ ownerUserId: user._id });
      assert.equal(store.status, 'pending_verification');
      const category = await Category.create({ publicId: `cat_enrol_${suffix}`, name: 'Enrolment Goods', slug: `enrol-${suffix}`, countries: ['UG'], active: true });
      const product = await Product.create({ publicId: `prd_enrol_${suffix}`, storeId: store._id, ownerUserId: user._id, categoryId: category._id, title: 'Unverified Seller Draft',
        slug: `unverified-${suffix}`, description: 'A real draft fixture verifies the enrolment never approves publishing.', countries: ['UG'], status: 'draft' });
      const denied = await agent.post(`/seller/products/${product.publicId}/submit`).set('accept', 'application/json').type('form').send({ version: product.__v, _csrf: body._csrf }).expect(409);
      assert.equal(denied.body.error.code, 'STORE_NOT_VERIFIED');
      assert.equal((await Product.findById(product._id)).status, 'draft');
      const returning = request.agent(app), login = await returning.get('/login').expect(200);
      await returning.post('/login').type('form').send({ email: values.email, password, _csrf: csrf(login.text) }).expect(302).expect('location', '/seller/store');
    });

    await t.test('concurrent confirmations produce one audited enrolment; changed profiles and failed audits preserve the customer', async () => {
      const concurrent = await completedCustomer();
      const results = await Promise.all([concurrent.agent.post('/onboarding/seller').type('form').send(concurrent.body), concurrent.agent.post('/onboarding/seller').type('form').send(concurrent.body)]);
      assert.deepEqual(results.map(result => result.status), [302, 302]);
      assert.ok(results.every(result => result.headers.location === '/seller/store'));
      assert.equal(await AuditLog.countDocuments({ action: 'identity.seller_enrolled', actorId: concurrent.user._id }), 1);
      const stale = await completedCustomer(), changed = await User.findById(stale.user._id);
      changed.name = 'A More Recent Customer Profile';
      await changed.save();
      const conflict = await stale.agent.post('/onboarding/seller').set('accept', 'application/json').type('form').send(stale.body).expect(409);
      assert.equal(conflict.body.error.code, 'SELLER_ENROLLMENT_CONFLICT');
      assert.equal((await User.findById(stale.user._id)).role, 'customer');
      assert.equal((await User.findById(stale.user._id)).name, changed.name);
      const rollback = await completedCustomer(), create = AuditLog.create;
      const auditFailure = t.mock.method(AuditLog, 'create', async function (...args) {
        if (Array.isArray(args[0]) && args[0][0]?.action === 'identity.seller_enrolled') throw new Error('Forced isolated enrolment audit failure');
        return create.apply(this, args);
      });
      try {
        await rollback.agent.post('/onboarding/seller').set('accept', 'application/json').type('form').send(rollback.body).expect(500);
        assert.equal((await User.findById(rollback.user._id)).role, 'customer');
        assert.equal((await User.findById(rollback.user._id)).__v, rollback.user.__v);
        assert.equal(await AuditLog.countDocuments({ action: 'identity.seller_enrolled', actorId: rollback.user._id }), 0);
      } finally { auditFailure.mock.restore(); }
    });

    await t.test('a grant provisioned during seller confirmation wins the race and stale or revoked sessions cannot enrol', async () => {
      const { activatePlatformGrant } = await import('../src/services/platform-grants.js');
      const { enrollCustomerAsSeller } = await import('../src/services/seller-enrollment.js');
      const racing = await completedCustomer(), save = User.prototype.save;
      let provisioned = false;
      const grantRace = t.mock.method(User.prototype, 'save', async function (...args) {
        if (!provisioned && args[0]?.session && this.role === 'seller' && this._id.equals(racing.user._id)) {
          provisioned = true;
          await activatePlatformGrant({ user: await User.findById(racing.user._id), role: 'warehouse', operationalCountries: ['UG'], approvedByUserId: racing.user._id,
            approvalPublicId: `approval_race_${suffix}`, reason: 'Isolated concurrent administrator provisioning fixture' });
        }
        return save.apply(this, args);
      });
      try {
        const denied = await racing.agent.post('/onboarding/seller').set('accept', 'application/json').type('form').send(racing.body).expect(403);
        assert.equal(denied.body.error.code, 'ACCOUNT_UNAVAILABLE');
      } finally { grantRace.mock.restore(); }
      const current = await User.findById(racing.user._id);
      assert.equal(current.role, 'warehouse');
      assert.ok(current.platformAccessManagedAt);
      assert.equal(await PlatformGrant.countDocuments({ userId: current._id, role: 'warehouse', status: 'active' }), 1);
      assert.equal(await AuditLog.countDocuments({ action: 'identity.seller_enrolled', actorId: current._id }), 0);
      const revoked = await completedCustomer();
      const serviceRequest = { id: `seller-revoked-${suffix}`, user: revoked.user, session: { userId: String(revoked.user._id), tokenVersion: revoked.user.security.tokenVersion },
        country: { code: 'UG' }, ip: '127.0.0.1', get: () => '' };
      await User.updateOne({ _id: revoked.user._id }, { $inc: { 'security.tokenVersion': 1 } });
      await assert.rejects(enrollCustomerAsSeller(serviceRequest, { ...revoked.body, version: Number(revoked.body.version) }), { code: 'ACCOUNT_UNAVAILABLE' });
      assert.equal((await User.findById(revoked.user._id)).role, 'customer');
    });

    await t.test('the browser submits the seller intent and lands in the approved seller UI at mobile and desktop sizes', async () => {
      // Distinct browser contexts represent distinct users behind a trusted
      // local test proxy, so one scenario cannot exhaust another user's quota.
      app.set('trust proxy', 1);
      server = http.createServer(app);
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
      for (const width of [390, 1366]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': width === 390 ? '192.0.2.90' : '192.0.2.91' } });
        const page = await context.newPage(), values = input();
        await page.goto(base + '/signup?role=seller');
        await page.screenshot({ path: `/tmp/classicmart-seller-signup-${width}.png`, fullPage: true, animations: 'disabled' });
        assert.equal(await page.locator('input[name="accountType"]').inputValue(), 'seller');
        await page.locator('#signUpName').fill(values.name);
        await page.locator('#signUpEmail').fill(values.email);
        await page.locator('select[name="phoneCountry"]').selectOption('UG');
        await page.locator('#signUpPhone').fill(values.phone);
        await page.locator('#signUpPassword').fill(password);
        await page.locator('#signUpConfirmPassword').fill(password);
        await page.locator('#acceptTerms').check();
        await Promise.all([page.waitForURL(base + '/verify-email'), page.locator('.auth-submit').click()]);
        const code = (await page.locator('body').innerText()).match(/Development verification code: (\d{6})/)[1];
        await page.locator('input[name="code"]').fill(code);
        await Promise.all([page.waitForURL(base + '/onboarding'), page.locator('form[action="/verify-email"] button[type="submit"]').click()]);
        assert.equal(await page.locator('input[name="role"][value="seller"]').isChecked(), true);
        assert.ok(await page.locator('.server-onboarding-form').evaluate(form => parseFloat(getComputedStyle(form).paddingLeft) >= 16));
        assert.ok((await page.getByRole('button', { name: 'Complete Secure Setup' }).boundingBox()).height >= 48);
        await page.locator('input[name="businessName"]').fill(`Browser Seller ${width}`);
        await Promise.all([page.waitForURL(base + '/seller/store'), page.locator('form[action="/onboarding"] button[type="submit"]').click()]);
        assert.equal(await page.locator('body').getAttribute('data-dashboard-page'), 'seller-store');
        assert.match(await page.locator('body').innerText(), new RegExp(`Browser Seller ${width}`));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
        await context.close();

        const existing = await completedCustomer(), enrollmentContext = await browser.newContext({ viewport: { width, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': width === 390 ? '192.0.2.92' : '192.0.2.93' } });
        const enrollment = await enrollmentContext.newPage();
        await enrollment.goto(base + '/login');
        await enrollment.locator('input[name="email"]').fill(existing.values.email);
        await enrollment.locator('input[name="password"]').fill(password);
        await Promise.all([enrollment.waitForURL(base + '/dashboard'), enrollment.locator('form[action="/login"] button[type="submit"]').click()]);
        await enrollment.goto(base + '/signup?role=seller');
        assert.equal(new URL(enrollment.url()).pathname, '/onboarding/seller');
        assert.equal(await enrollment.locator('input[name="role"]').inputValue(), 'seller');
        assert.equal(await enrollment.locator('input[name="role"][type="radio"]').count(), 0);
        assert.ok(await enrollment.locator('.server-onboarding-form').evaluate(form => parseFloat(getComputedStyle(form).paddingLeft) >= 16));
        assert.ok((await enrollment.getByRole('button', { name: 'Start My Seller Account' }).boundingBox()).height >= 48);
        await enrollment.screenshot({ path: `/tmp/classicmart-seller-enrollment-${width}.png`, fullPage: true, animations: 'disabled' });
        const accessibility = await new AxeBuilder({ page: enrollment }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        assert.deepEqual(accessibility.violations.map(row => ({ id: row.id, targets: row.nodes.map(node => node.target) })), [], 'the seller enrolment form meets the checked accessibility rules');
        await Promise.all([enrollment.waitForURL(base + '/seller/store'), enrollment.getByRole('button', { name: 'Start My Seller Account' }).click()]);
        assert.equal(await enrollment.locator('body').getAttribute('data-dashboard-page'), 'seller-store');
        assert.equal(await enrollment.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
        await enrollmentContext.close();
      }
    });
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    for (const transport of transports) transport.destroy();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

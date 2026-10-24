import test, { before, after } from 'node:test';
import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'true';
process.env.REDIS_URL = '';
const { createApp } = await import('../src/app.js');
const models = await import('../src/models/index.js');
const { User, Device, PlatformGrant, CountrySetting } = models;
const { hashPassword, verifyPassword } = await import('../src/core/crypto.js');
const { beginMfaEnrollment, confirmMfaEnrollment, totpCode } = await import('../src/services/mfa.js');
const { loginDestination } = await import('../src/dashboard/landing.js');
const { DASHBOARD_PAGES, routeForPage } = await import('../src/dashboard/registry.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cases = {
  customer: 'dashboard', seller: 'seller-overview', promoter: 'promoter-overview',
  country_admin: 'admin-overview', super_admin: 'super-overview', finance: 'finance-overview',
  support: 'support-overview', warehouse: 'warehouse-overview', moderator: 'moderator-overview',
  business: 'business-overview', delivery: 'delivery-overview',
};

test('approved stylesheet, scripts, and images match the supplied preview exactly', () => {
  for (const name of ['styles.css', 'design-system.css', 'role-workspaces.css', 'script.js', 'enhancements.js', ...fs.readdirSync(path.join(root, 'dashboard-preview/final19/assets')).map(name => 'assets/' + name)]) {
    assert.deepEqual(fs.readFileSync(path.join(root, 'public/approved-dashboard', name)), fs.readFileSync(path.join(root, 'dashboard-preview/final19', name)), name);
  }
});

test('landing respects assigned roles and rejects unsafe redirect destinations', () => {
  const user = { role: 'seller', status: 'active' };
  for (const next of [undefined, '/', '//evil.example', '/\\evil.example', '/\nevil']) {
    assert.equal(loginDestination(user, next), '/seller/overview');
  }
  assert.equal(loginDestination(user, '/cart'), '/cart');
  assert.equal(loginDestination({ ...user, preferences: { dashboard: { landingPage: 'dashboard' } } }, '/'), '/seller/overview');
});

const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const suffix = crypto.randomBytes(8).toString('hex');
const password = 'Dashboard-test-password-2026!';
const transports = [];
let app, passwordHash, sequence = 0, connected = false;
const csrf = html => html.match(/name="_csrf"[^>]*value="([^"]+)"/)[1];
const workspaceForRole = role => ({ country_admin: 'admin', super_admin: 'superadmin', moderator: 'moderator' }[role] || role);

before(async () => {
  if (!uri) return;
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  await mongoose.connect(uri, { dbName: `classicmart_approved_dashboard_test_${suffix}` });
  connected = true;
  await Promise.all(Object.values(mongoose.models).map(Model => Model.init()));
  await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG',
    timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true });
  passwordHash = await hashPassword(password);
  app = createApp(null);
});

after(async () => {
  for (const transport of transports) transport.destroy();
  if (!connected) return;
  try { await mongoose.connection.dropDatabase(); }
  finally { await mongoose.disconnect(); }
});

function client() {
  const transport = new http.Agent({ localAddress: `127.0.0.${++sequence + 20}`, keepAlive: false });
  transports.push(transport);
  return request.agent(app).use(req => req.agent(transport));
}

async function actorForRole(role, { managed = true } = {}) {
  const number = ++sequence, email = `approved-${suffix}-${number}@example.com`, phone = `+25671${String(number).padStart(7, '0')}`;
  const platform = managed && ['warehouse', 'support', 'moderator', 'finance', 'country_admin', 'super_admin'].includes(role);
  let user = await User.create({ publicId: `usr_approved_${suffix}_${number}`, name: `Approved Actor ${number}`,
    role, status: 'active', email, emailNormalized: email, phone, phoneNormalized: phone, passwordHash,
    country: 'UG', currency: 'UGX', locale: 'en-UG', emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(),
    onboardingCompletedAt: new Date(), consents: { terms: true, privacy: true, recordedAt: new Date() },
    ...(platform ? { platformAccessManagedAt: new Date(), operationalCountries: role === 'super_admin' ? ['*'] : ['UG'] } : {}) });
  if (platform) await PlatformGrant.create({ publicId: `pgr_approved_${suffix}_${number}`, userId: user._id, role,
    operationalCountries: role === 'super_admin' ? ['*'] : ['UG'], status: 'active',
    startsAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000),
    approvedByUserId: new mongoose.Types.ObjectId(), approvalPublicId: `apr_approved_${suffix}_${number}`,
    reason: 'Independent reviewed dashboard routing fixture.' });
  if (role === 'super_admin' && platform) {
    const enrollment = await beginMfaEnrollment(user._id, password);
    user = (await confirmMfaEnrollment(user._id, totpCode(enrollment.secret))).user;
  }
  return user;
}

test('real login/session routes land each authorized role in its approved workspace and deny foreign roles', { skip: !uri, timeout: 180_000 }, async () => {
  // The database, current Device, accepted grants, password hashing, session
  // regeneration, CSRF, role authorization, routing and EJS rendering are real.
  await request(app).get('/dashboard/seller-overview').expect(302).expect('location', '/login?next=%2Fdashboard%2Fseller-overview');
  for (const [role, page] of Object.entries(cases)) {
    const actor = await actorForRole(role), agent = client(), login = await agent.get('/login').expect(200);
    await agent.post('/login').type('form').send({ email: actor.email, password }).expect(403);
    await agent.post('/login').type('form').send({ email: actor.email, password, _csrf: csrf(login.text) })
      .expect(302).expect('location', routeForPage(page));
    assert.ok(await Device.exists({ userId: actor._id, revokedAt: null }), 'Login must establish an actual current Device.');
    const personal = await agent.get('/account/security').expect(200);
    assert.match(personal.text, new RegExp(`data-dashboard-workspace="${workspaceForRole(role)}"`));
    assert.match(personal.text, /\/approved-dashboard\/styles.css/);
    const cacheDirectives = new Set(String(personal.headers['cache-control']).split(',').map(value => value.trim()));
    assert.ok(cacheDirectives.has('private')); assert.ok(cacheDirectives.has('no-store'));
    assert.equal(personal.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
    assert.doesNotMatch(personal.text, /roleSwitcher|\/dashboard\/runtime.js|platform-bridge.js|dashboard\.css/);
    await agent.get('/signup').expect(302).expect('location', routeForPage(page));
    if (role === 'customer') {
      const dashboard = await agent.get('/dashboard').expect(200);
      assert.match(dashboard.text, /data-dashboard-workspace="customer"/);
      await agent.get('/dashboard/unknown').expect(404);
    } else {
      await agent.get('/dashboard').expect(302).expect('location', routeForPage(page));
      await agent.get('/dashboard/' + page).expect(308).expect('location', routeForPage(page));
      const dashboard = await agent.get(routeForPage(page)).expect(200);
      assert.match(dashboard.text, new RegExp(`data-dashboard-workspace="${workspaceForRole(role)}"`));
      assert.match(dashboard.text, new RegExp(`data-dashboard-page="${page}"`));
      assert.equal(dashboard.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
    }
    if (['customer', 'delivery'].includes(role)) {
      for (const path of ['/dashboard/seller-overview', '/dashboard/super-overview', '/dashboard/warehouse-overview']) await agent.get(path).expect(403);
    }
    if (role === 'moderator') for (const [id] of DASHBOARD_PAGES.moderator) {
      await agent.get('/dashboard/' + id).expect(308).expect('location', routeForPage(id));
    }
    if (role === 'super_admin') {
      await agent.get('/seller/overview').expect(403);
      assert.equal((await User.findById(actor._id)).role, 'super_admin', 'Navigation must not rewrite the staff identity.');
    }
  }
  const rawSuper = await actorForRole('super_admin', { managed: false }), agent = client();
  const login = await agent.get('/login').expect(200);
  await agent.post('/login').type('form').send({ email: rawSuper.email, password, _csrf: csrf(login.text) }).expect(302).expect('location', '/dashboard');
  await agent.get('/dashboard/super-overview').expect(403);
  assert.equal(await PlatformGrant.countDocuments({ userId: rawSuper._id }), 0, 'A saved role label cannot invent a global staff grant.');
});

test('signup assigns customer on the server, establishes its Device and rejects role smuggling, duplicates and weak passwords', { skip: !uri, timeout: 60_000 }, async () => {
  const agent = client(), signup = await agent.get('/signup').expect(200);
  const values = { name: 'New Customer', email: `new-${suffix}@example.com`, phone: '+256700123456', password,
    confirmPassword: password, acceptTerms: 'on', role: 'super_admin', _csrf: csrf(signup.text) };
  await agent.post('/signup').type('form').send(values).expect(302).expect('location', '/dashboard');
  const actor = await User.findOne({ emailNormalized: values.email }).select('+passwordHash');
  assert.equal(actor.role, 'customer');
  assert.notEqual(actor.passwordHash, password);
  assert.equal(await verifyPassword(actor.passwordHash, password), true);
  assert.equal(await PlatformGrant.countDocuments({ userId: actor._id }), 0);
  assert.ok(await Device.exists({ userId: actor._id, revokedAt: null }));
  await agent.get('/signup').expect(302).expect('location', '/dashboard');
  await agent.get('/dashboard/super-overview').expect(403);
  const guest = client(), form = await guest.get('/signup').expect(200), token = csrf(form.text);
  await guest.post('/signup').type('form').send({ ...values, _csrf: token }).expect(409);
  await guest.post('/signup').type('form').send({ ...values, email: `weak-${suffix}@example.com`, phone: '+256700123457', password: 'weak', confirmPassword: 'weak', _csrf: token }).expect(422);
  assert.equal(await User.countDocuments({ emailNormalized: `weak-${suffix}@example.com` }), 0);
});

test('application runtime has no role-selection control or handler', () => {
  const source = fs.readFileSync(path.join(root, 'public/approved-dashboard/role-workspaces.js'), 'utf8');
  const controls = fs.readFileSync(path.join(root, 'public/approved-dashboard/session-controls.js'), 'utf8');
  assert.doesNotMatch(source + controls, /roleSwitcher|buildRoleSwitcher/);
  assert.match(source, /workspaceName\.textContent/);
});

test('seller registration retains its account intent when local simple login skips onboarding', { skip: !uri, timeout: 60_000 }, async () => {
  const agent = client(), signup = await agent.get('/signup?role=seller').expect(200);
  assert.match(signup.text, /name="accountType" type="hidden" value="seller"/);
  const values = { name: 'Local Seller', email: `local-seller-${suffix}@example.com`, phone: '+256700123458',
    accountType: 'seller', role: 'super_admin', password, confirmPassword: password,
    acceptTerms: 'on', _csrf: csrf(signup.text) };
  await agent.post('/signup').type('form').send(values).expect(302).expect('location', '/seller/overview');
  const actor = await User.findOne({ emailNormalized: values.email }).select('+passwordHash');
  assert.equal(actor.role, 'seller');
  assert.equal(await verifyPassword(actor.passwordHash, password), true);
  assert.equal(await PlatformGrant.countDocuments({ userId: actor._id }), 0);
  assert.ok(await Device.exists({ userId: actor._id, revokedAt: null }));
  await agent.get('/dashboard').expect(302).expect('location', '/seller/overview');
  const seller = await agent.get('/seller/overview').expect(200);
  assert.match(seller.text, /data-dashboard-workspace="seller"/);
  assert.doesNotMatch(seller.text, /data-dashboard-workspace="customer"/);
  await agent.get('/dashboard/super-overview').expect(403);
});

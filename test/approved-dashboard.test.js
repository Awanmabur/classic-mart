import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'true';
process.env.REDIS_URL = '';
const { createApp } = await import('../src/app.js');
const { User, Device, AuditLog } = await import('../src/models/index.js');
const { hashPassword } = await import('../src/core/crypto.js');
const { loginDestination } = await import('../src/dashboard/landing.js');
const { DASHBOARD_PAGES, routeForPage } = await import('../src/dashboard/registry.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cases = {
  customer: 'dashboard', seller: 'seller-store', promoter: 'promoter-overview',
  country_admin: 'admin-overview', super_admin: 'super-overview', finance: 'finance-overview',
  support: 'support-overview', warehouse: 'warehouse-overview', moderator: 'moderator-sellers',
  business: 'business-overview', delivery: 'dashboard',
};

test('approved stylesheet, scripts, and images match the supplied preview exactly', () => {
  for (const name of ['styles.css', 'design-system.css', 'role-workspaces.css', 'script.js', 'enhancements.js', ...fs.readdirSync(path.join(root, 'dashboard-preview/final19/assets')).map(name => 'assets/' + name)]) {
    assert.deepEqual(fs.readFileSync(path.join(root, 'public/approved-dashboard', name)), fs.readFileSync(path.join(root, 'dashboard-preview/final19', name)), name);
  }
});

test('landing respects assigned roles and rejects unsafe redirect destinations', () => {
  const user = { role: 'seller', status: 'active' };
  for (const next of [undefined, '/', '//evil.example', '/\\evil.example', '/\nevil']) {
    assert.equal(loginDestination(user, next), '/seller/store');
  }
  assert.equal(loginDestination(user, '/cart'), '/cart');
  assert.equal(loginDestination({ ...user, preferences: { dashboard: { landingPage: 'dashboard' } } }, '/'), '/seller/store');
});

test('real login/session routes land every role in the approved UI; unauthorized roles are denied', async t => {
  // Database adapters are fixtures; password hashing, session regeneration, CSRF,
  // authentication, role authorization, routing, and EJS rendering are real.
  const password = 'Dashboard-test-password-2026!';
  const passwordHash = await hashPassword(password);
  let actor;
  t.mock.method(User, 'findOne', () => ({ select: async () => actor }));
  t.mock.method(User, 'findById', () => ({ select: async () => actor }));
  t.mock.method(User, 'updateOne', async () => ({}));
  t.mock.method(Device, 'create', async () => ({}));
  t.mock.method(Device, 'updateOne', async () => ({}));
  t.mock.method(Device, 'findOne', async () => ({ save: async () => {} }));
  t.mock.method(AuditLog, 'create', async () => ({}));
  const app = createApp(null);
  await request(app).get('/dashboard/seller-overview').expect(302).expect('location', '/login?next=%2Fdashboard%2Fseller-overview');
  for (const [role, page] of Object.entries(cases)) {
    actor = {
      _id: '507f1f77bcf86cd799439011', publicId: 'usr_test', name: 'Test User',
      role, status: 'active', email: 'dashboard@example.com', country: 'UG', currency: 'UGX',
      locale: 'en-UG', passwordHash, preferences: {}, security: { tokenVersion: 1, failedLoginCount: 0 },
      save: async () => {},
    };
    const agent = request.agent(app);
    const login = await agent.get('/login').expect(200);
    const csrf = login.text.match(/name="_csrf"[^>]*value="([^"]+)"/)[1];
    await agent.post('/login').type('form').send({ email: actor.email, password, _csrf: csrf }).expect(302).expect('location', routeForPage(page));
    if (role === 'customer' || role === 'delivery') {
      await agent.get('/signup').expect(302).expect('location', '/dashboard');
      await agent.get('/dashboard/seller-overview').expect(403);
      await agent.get('/dashboard/super-overview').expect(403);
      await agent.get('/dashboard/warehouse-overview').expect(403);
      await agent.get('/dashboard/unknown').expect(404);
    } else if (role === 'seller' || role === 'moderator') {
      const landing = role === 'seller' ? '/seller/store' : '/moderation/verifications';
      await agent.get('/dashboard').expect(302).expect('location', landing);
      await agent.get('/dashboard/' + page).expect(308).expect('location', landing);
      await agent.get('/dashboard/' + role + '-overview').expect(503);
    } else {
      const dashboard = await agent.get('/dashboard/' + page).expect(200);
      assert.match(dashboard.text, /\/approved-dashboard\/styles.css/);
      assert.match(dashboard.text, new RegExp('data-dashboard-page="' + page + '"'));
      assert.equal(dashboard.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
      assert.doesNotMatch(dashboard.text, /\/dashboard\/runtime.js|platform-bridge.js|dashboard\.css/);
    }
    if (role === 'super_admin') {
      for (const [workspace, rows] of Object.entries(DASHBOARD_PAGES)) {
        if (workspace === 'customer') continue;
        for (const [id] of rows) await agent.get('/dashboard/' + id).expect(['seller-store','seller-products','seller-add-product','seller-orders','seller-shipping','moderator-sellers','moderator-products'].includes(id) ? 308 : ['seller','moderator'].includes(workspace) ? 503 : 200);
      }
    }
  }
});

test('signup assigns customer on the server, starts a session and opens its dashboard', async t => {
  let actor;
  let duplicate = false;
  t.mock.method(User, 'exists', async () => duplicate);
  t.mock.method(User, 'create', async data => {
    assert.equal(data.role, 'customer');
    assert.notEqual(data.passwordHash, 'Dashboard-test-password-2026!');
    actor = new User(data);
    actor.save = async () => actor;
    return actor;
  });
  t.mock.method(User, 'findById', () => ({ select: async () => actor }));
  t.mock.method(Device, 'create', async () => ({}));
  t.mock.method(Device, 'findOne', async () => ({ save: async () => {} }));
  t.mock.method(AuditLog, 'create', async () => ({}));
  const signupApp = createApp(null);
  signupApp.set('trust proxy', 1);
  const agent = request.agent(signupApp);
  const signup = await agent.get('/signup').expect(200);
  const csrf = signup.text.match(/name="_csrf"[^>]*value="([^"]+)"/)[1];
  const values = { name: 'New Customer', email: 'new@example.com', phone: '+256700123456', password: 'Dashboard-test-password-2026!', confirmPassword: 'Dashboard-test-password-2026!', acceptTerms: 'on', role: 'super_admin', _csrf: csrf };
  await agent.post('/signup').set('X-Forwarded-For', '192.0.2.50').type('form').send(values).expect(302).expect('location', '/dashboard');
  await agent.get('/signup').expect(302).expect('location', '/dashboard');
  await agent.get('/dashboard/super-overview').expect(403);
  const guest = request.agent(signupApp);
  const form = await guest.get('/signup').expect(200);
  const token = form.text.match(/name="_csrf"[^>]*value="([^"]+)"/)[1];
  duplicate = true;
  await guest.post('/signup').set('X-Forwarded-For', '192.0.2.51').type('form').send({ ...values, _csrf: token }).expect(409);
  await guest.post('/signup').set('X-Forwarded-For', '192.0.2.51').type('form').send({ ...values, password: 'weak', _csrf: token }).expect(422);
});

test('application runtime has no role-selection control or handler', () => {
  const source = fs.readFileSync(path.join(root, 'public/approved-dashboard/role-workspaces.js'), 'utf8');
  const controls = fs.readFileSync(path.join(root, 'public/approved-dashboard/session-controls.js'), 'utf8');
  assert.doesNotMatch(source + controls, /roleSwitcher|buildRoleSwitcher/);
  assert.match(source, /workspaceName\.textContent/);
});

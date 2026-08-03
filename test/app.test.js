import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';
process.env.TOKEN_PEPPER = 'test-token-pepper-with-at-least-32-characters';
process.env.REDIS_URL = '';

const { createApp } = await import('../src/app.js');
const app = createApp(null);

test('serves liveness with defensive headers', async () => {
  const response = await request(app).get('/health/live').expect(200);
  assert.equal(response.body.status, 'ok');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-powered-by'], undefined);
  assert.ok(response.headers['content-security-policy']);
});

test('renders the preserved sign-in UI with a CSRF token', async () => {
  const response = await request(app).get('/login').expect(200);
  assert.match(response.text, /Sign In to Classic Mart/);
  assert.match(response.text, /name="_csrf"/);
  assert.ok(response.headers['set-cookie']);
});

test('does not create anonymous sessions for read-only storefront browsing', async () => {
  const response = await request(app)
    .get('/')
    .set('cookie', 'broken=%E0%A4%A')
    .expect(200);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.match(response.text, /Classic Mart/);
});

test('rejects state changes without a CSRF token', async () => {
  const response = await request(app)
    .post('/login')
    .type('form')
    .send({ identity: 'test@example.com', password: 'SecureClassic9!' })
    .expect(403);
  assert.match(response.text, /form expired/i);
});

test('accepts a valid CSRF token and rejects unavailable countries', async () => {
  const agent = request.agent(app);
  const login = await agent.get('/login').expect(200);
  const token = login.text.match(/name="_csrf"[^>]*value="([^"]+)"/)?.[1];
  assert.ok(token);
  const accepted = await agent
    .post('/country')
    .type('form')
    .set('referer', '/')
    .send({ _csrf: token, country: 'UG' })
    .expect(302);
  assert.equal(accepted.headers.location, '/');
  assert.match(accepted.headers['set-cookie'].join(';'), /cm_country=UG/);
  await agent
    .post('/country')
    .type('form')
    .send({ _csrf: token, country: 'ZZ' })
    .expect(422);
});

test('protects account routes on the server', async () => {
  await request(app)
    .get('/dashboard')
    .expect(302)
    .expect('location', '/login?next=%2Fdashboard');
});

test('returns only an empty non-sensitive catalogue summary to guests', async () => {
  const response = await request(app)
    .get('/api/v1/storefront/state')
    .set('accept', 'application/json')
    .expect(200);
  assert.equal(response.body.authenticated, false);
  assert.deepEqual(response.body.state.wishlist, []);
  assert.deepEqual(response.body.state.comparison, []);
  assert.deepEqual(response.body.state.recommendations, []);
  assert.equal(response.body.csrfToken, null);
  assert.equal(response.headers['set-cookie'], undefined);
});

test('rejects MongoDB selector syntax at the HTTP query boundary', async () => {
  const response = await request(app)
    .get('/api/v1/storefront/search?$where=1')
    .set('accept', 'application/json')
    .expect(400);
  assert.equal(response.body.error.code, 'UNSAFE_INPUT_KEY');
});

test('redirects legacy page URLs to clean routes', async () => {
  await request(app).get('/login.html').expect(301).expect('location', '/login');
  await request(app).get('/index.html').expect(301).expect('location', '/');
});

test('renders every preserved public page and restored profile asset', async () => {
  const routes = [
    '/',
    '/about',
    '/careers',
    '/cart',
    '/categories',
    '/contact',
    '/cookies',
    '/help',
    '/payments',
    '/press',
    '/privacy',
    '/products',
    '/promoters',
    '/returns',
    '/search',
    '/sellers',
    '/shipping',
    '/terms',
    '/track-order',
  ];
  for (const route of routes) {
    await request(app).get(route).expect(200);
  }
  await request(app).get('/profile-page.js').expect(200);
  await request(app).get('/profile-pages.css').expect(200);
  await request(app).get('/sellers/profile').expect(301).expect('location', '/sellers');
  await request(app).get('/sellers/profile?slug=verified-store').expect(301).expect('location', '/sellers/verified-store');
  await request(app).get('/sellers/verified-store').expect(200);
  await request(app).get('/promoters/profile').expect(301).expect('location', '/promoters');
  await request(app).get('/promoters/profile?id=verified-promoter').expect(301).expect('location', '/promoters/verified-promoter');
  await request(app).get('/promoters/verified-promoter').expect(200);
  await request(app).get('/seller-profile.html?slug=verified-store').expect(301).expect('location', '/sellers/verified-store');
  await request(app).get('/promoter-profile.html?id=verified-promoter').expect(301).expect('location', '/promoters/verified-promoter');
  await request(app)
    .get('/wishlist')
    .expect(302)
    .expect('location', '/login?next=%2Fwishlist');
  await request(app)
    .get('/compare')
    .expect(302)
    .expect('location', '/login?next=%2Fcompare');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import session from 'express-session';

process.env.NODE_ENV = 'test';
const { default: rateLimit, accountRateLimitKey, deviceRateLimitKey } = await import('../src/middleware/rate-limit.js');
let scope = 0;
function application(options = {}, { user, device, proxy = 'loopback' } = {}) {
  const app = express();
  app.set('trust proxy', proxy);
  app.use((req, _res, next) => {
    req.user = user || (req.get('x-test-actor') ? { _id: req.get('x-test-actor') } : null);
    req.device = device;
    next();
  });
  app.use(rateLimit({ scope: 'test:layered:' + ++scope, windowMs: 60_000, limit: 2,
    standardHeaders: 'draft-8', legacyHeaders: false, ...options }));
  app.get('/', (_req, res) => res.send('ok'));
  return app;
}

test('IP cap survives user-agent rotation and invented device headers', async () => {
  const app = application();
  for (let i = 0; i < 2; i++) await request(app).get('/').set('User-Agent', 'rotating-' + i).set('x-device-id', 'new-' + i).expect(200);
  const blocked = await request(app).get('/').set('User-Agent', 'another').set('x-device-id', 'another').expect(429);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
});

test('one authenticated account cannot reset its quota by changing IP or session', async () => {
  const app = application();
  for (let i = 1; i <= 2; i++) await request(app).get('/').set('X-Forwarded-For', '198.51.100.' + i).set('x-test-actor', 'account-a').expect(200);
  await request(app).get('/').set('X-Forwarded-For', '198.51.100.3').set('x-test-actor', 'account-a').expect(429);
  await request(app).get('/').set('X-Forwarded-For', '198.51.100.4').set('x-test-actor', 'account-b').expect(200);
});

test('existing custom account keys retain a separate IP cap across different accounts', async () => {
  const app = application({ keyGenerator: req => req.user._id });
  for (const id of ['a', 'b']) await request(app).get('/').set('x-test-actor', id).expect(200);
  await request(app).get('/').set('x-test-actor', 'c').expect(429);
});

test('verified device quota survives network changes and keys never contain raw identifiers', async () => {
  const user = { _id: 'private-account-id' }, device = { _id: 'private-device-id', userId: user._id };
  const app = application({ limit: 10, accountLimit: 10, deviceLimit: 2 }, { user, device });
  for (let i = 1; i <= 2; i++) await request(app).get('/').set('X-Forwarded-For', '198.51.100.' + i).expect(200);
  await request(app).get('/').set('X-Forwarded-For', '198.51.100.3').set('x-device-id', 'forged').expect(429);
  const accountKey = accountRateLimitKey({ user });
  const deviceKey = deviceRateLimitKey({ user, device });
  assert.match(accountKey, /^[a-f0-9]{64}$/);
  assert.match(deviceKey, /^[a-f0-9]{64}$/);
  assert.notEqual(accountKey, deviceKey);
  assert.equal(deviceRateLimitKey({ user, device: { ...device, userId: 'another' } }), '');
  assert.equal(deviceRateLimitKey({ user, device: { ...device, revokedAt: new Date() } }), '');
  assert.equal(accountRateLimitKey({ user: { _id: 'x'.repeat(161) } }), '');
});

test('anonymous form session has its own bucket while clearing cookies cannot defeat the IP cap', async () => {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(session({ secret: 'a-long-private-test-session-secret', resave: false, saveUninitialized: false }));
  app.get('/form', (req, res) => { req.session.csrfToken = 'a-real-server-side-csrf-token'; res.send('ready'); });
  app.get('/', rateLimit({ scope: 'test:session:' + ++scope, windowMs: 60_000, limit: 10, deviceLimit: 2 }), (_req, res) => res.send('ok'));
  const agent = request.agent(app);
  await agent.get('/form').expect(200);
  for (let i = 1; i <= 2; i++) await agent.get('/').set('X-Forwarded-For', '198.51.100.' + i).expect(200);
  await agent.get('/').set('X-Forwarded-For', '198.51.100.3').expect(429);
});

test('IPv6 rotation within one /56 shares the same IP quota', async () => {
  const app = application();
  await request(app).get('/').set('X-Forwarded-For', '2001:db8:abcd:1200::1').expect(200);
  await request(app).get('/').set('X-Forwarded-For', '2001:db8:abcd:12ff::2').expect(200);
  await request(app).get('/').set('X-Forwarded-For', '2001:db8:abcd:12aa::3').expect(429);
  await request(app).get('/').set('X-Forwarded-For', '2001:db8:abcd:1300::1').expect(200);
});

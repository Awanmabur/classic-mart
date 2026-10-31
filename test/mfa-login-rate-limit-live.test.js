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
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;

test('MFA verification has one account budget across actual TCP peers, proof methods and new password challenges', {
  skip: !uri, timeout: 120_000,
}, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex');
  const peers = new Set(), transports = [];
  let server;
  t.after(async () => {
    for (const transport of transports) transport.destroy();
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    try { if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase(); }
    finally { await mongoose.disconnect(); }
  });
  await mongoose.connect(uri, { dbName: `classicmart_mfa_login_rate_test_${suffix}` });
  const { User, CountrySetting } = await import('../src/models/index.js');
  const { settleModelInitialization } = await import('../scripts/live-test-model-lifecycle.js');
  await settleModelInitialization(mongoose.connection);
  const { hashPassword } = await import('../src/core/crypto.js');
  const { totpCode } = await import('../src/services/mfa.js');
  const { enrollFixtureTotp } = await import('./helpers/mfa-fixtures.js');
  const { createApp } = await import('../src/app.js');
  await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG',
    timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true });
  const password = `MfaRate-${suffix}-A1!`, passwordHash = await hashPassword(password);
  async function actor(number) {
    const email = `mfa-rate-${suffix}-${number}@example.test`, phone = `+25670${String(number).padStart(7, '0')}`;
    const user = await User.create({ publicId: `usr_mfa_rate_${suffix}_${number}`, name: `MFA Rate Actor ${number}`,
      email, emailNormalized: email, phone, phoneNormalized: phone, passwordHash, role: 'seller',
      country: 'UG', currency: 'UGX', emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
      consents: { terms: true, privacy: true, recordedAt: new Date() } });
    return { ...await enrollFixtureTotp(user, password), email };
  }
  const limited = await actor(1), independent = await actor(2);
  const app = createApp(null);
  server = http.createServer((incoming, outgoing) => {
    if (incoming.url.startsWith('/mfa') && incoming.method === 'POST') peers.add(incoming.socket.remoteAddress);
    app(incoming, outgoing);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let peerSequence = 0;
  function transport() {
    const agent = new http.Agent({ localAddress: `127.0.3.${++peerSequence}`, keepAlive: false });
    transports.push(agent);
    return agent;
  }
  function cookies(state, response) {
    for (const entry of response.headers['set-cookie'] || []) {
      const pair = entry.split(';')[0], index = pair.indexOf('=');
      state.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    state.cookie = [...state.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  function token(html) {
    const value = html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)?.[1];
    assert.ok(value, 'The real form must supply its CSRF token.');
    return value;
  }
  async function passwordChallenge(entry) {
    const state = { cookies: new Map(), cookie: '' }, agent = transport();
    const login = await request(base).get('/login').agent(agent);
    assert.equal(login.status, 200);
    cookies(state, login);
    const submitted = await request(base).post('/login').agent(agent).set('Cookie', state.cookie)
      .type('form').send({ email: entry.email, password, _csrf: token(login.text) });
    assert.equal(submitted.status, 302);
    assert.equal(submitted.headers.location, '/mfa');
    cookies(state, submitted);
    const form = await request(base).get('/mfa').agent(agent).set('Cookie', state.cookie);
    assert.equal(form.status, 200);
    cookies(state, form);
    state.csrf = token(form.text);
    return state;
  }
  async function proof(state, path, body, json = true) {
    let call = request(base).post(path).agent(transport()).set('Cookie', state.cookie);
    call = json ? call.set('Accept', 'application/json').set('x-csrf-token', state.csrf).send(body)
      : call.set('Accept', 'text/html').type('form').send({ _csrf: state.csrf, ...body });
    const response = await call;
    cookies(state, response);
    return response;
  }
  const pending = await passwordChallenge(limited);
  const baseline = await User.findById(limited.user._id).select('+security.mfaLastCounter +security.mfaRecoveryCodeHashes');
  const validCounters = new Set(Array.from({ length: 23 }, (_, index) =>
    totpCode(limited.secret, { time: Date.now() + (index - 1) * 30_000 })));
  let incorrect = '000000';
  while (validCounters.has(incorrect)) incorrect = String(Number(incorrect) + 1).padStart(6, '0');

  await t.test('twelve failed HTML and JSON proofs from twelve real peers share the same allowance', async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await proof(pending, '/mfa', { code: incorrect }, attempt % 2 === 0);
      assert.equal(response.status, 422, `Proof ${attempt + 1} must reach the real verifier before exhaustion.`);
    }
    assert.equal(peers.size, 12, 'Requests must use distinct TCP sources, without trusting forwarded-IP headers.');
    assert.equal((await User.findById(limited.user._id).select('+security.mfaLastCounter')).security.mfaLastCounter,
      baseline.security.mfaLastCounter);
  });
  await t.test('a new peer and alternate proof endpoint cannot spend a valid authenticator or recovery code', async () => {
    for (const path of ['/mfa', '/mfa/sms/verify', '/mfa/passkey/verify']) {
      const response = await proof(pending, path, { code: totpCode(limited.secret), credential: null });
      assert.equal(response.status, 429, path);
      assert.match(response.text, /Too many security verification attempts/);
    }
    const actor = await User.findById(limited.user._id).select('+security.mfaLastCounter +security.mfaRecoveryCodeHashes');
    assert.equal(actor.security.mfaLastCounter, baseline.security.mfaLastCounter);
    assert.deepEqual(actor.security.mfaRecoveryCodeHashes, baseline.security.mfaRecoveryCodeHashes);
    const privatePage = await request(base).get('/account/security').agent(transport()).set('Cookie', pending.cookie).set('Accept', 'application/json');
    assert.equal(privatePage.status, 401);
  });
  await t.test('another password challenge retains the exhausted account budget and leaves backup codes unused', async () => {
    const restarted = await passwordChallenge(limited);
    assert.notEqual(restarted.cookie, pending.cookie, 'The new password challenge must really regenerate its session.');
    const response = await proof(restarted, '/mfa', { code: limited.codes[0] });
    assert.equal(response.status, 429);
    assert.deepEqual((await User.findById(limited.user._id).select('+security.mfaRecoveryCodeHashes')).security.mfaRecoveryCodeHashes,
      baseline.security.mfaRecoveryCodeHashes);
  });
  await t.test('another account keeps its own budget and completes real authenticator sign-in', async () => {
    const other = await passwordChallenge(independent);
    const response = await proof(other, '/mfa', { code: totpCode(independent.secret) });
    assert.equal(response.status, 200);
    assert.ok(response.body.redirect.startsWith('/seller/'));
    const security = await request(base).get('/account/security').agent(transport()).set('Cookie', other.cookie).set('Accept', 'text/html');
    assert.equal(security.status, 200);
    assert.match(security.text, /data-dashboard-workspace="seller"/);
  });
});

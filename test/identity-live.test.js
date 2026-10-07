import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { spawnSync } from 'node:child_process';

const base = process.env.CLASSIC_MART_LIVE_BASE_URL;
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;

test('production rejects the development verification/MFA bypass', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config/env.js')"], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production', SIMPLE_LOGIN: 'true' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SIMPLE_LOGIN cannot bypass verification or MFA in production/);
});

test('signup, persistent account login, authorization and logout with real MongoDB', { skip: !base || !uri }, async () => {
  const target = new URL(uri);
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname), 'Use an isolated local test database.');
  assert.match(target.pathname, /verification|test/i);
  assert.equal(new URL(base).hostname, '127.0.0.1');
  await mongoose.connect(uri);
  try {
    const db = mongoose.connection.db;
    const suffix = crypto.randomBytes(6).toString('hex');
    const email = `identity-${suffix}@example.com`;
    const password = `Live-${crypto.randomBytes(16).toString('hex')}A1!`;
    const phone = '+2567' + String(crypto.randomInt(10000000, 99999999));
    const agent = request.agent(base);
    const signup = await agent.get('/signup').expect(200);
    const token = signup.text.match(/name="_csrf"[^>]*value="([^"]+)"/)[1];
    const body = { name: 'Live Test Customer', email, phone, password, confirmPassword: password, acceptTerms: 'on', role: 'super_admin', _csrf: token };
    const created = await agent.post('/signup').type('form').send(body).expect(302).expect('location', '/dashboard');
    assert.notEqual(created.headers['set-cookie'][0], signup.headers['set-cookie'][0]);
    const user = await db.collection('users').findOne({ emailNormalized: email });
    assert.equal(user.role, 'customer');
    assert.match(user.passwordHash, /^\$argon2id\$/);
    assert.notEqual(user.passwordHash, password);
    const dashboard = await agent.get('/dashboard').expect(200);
    assert.equal(dashboard.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
    await agent.get('/dashboard/super-overview').expect(403);
    await agent.post('/logout').type('form').send({}).expect(403);
    const csrf = dashboard.text.match(/name="csrf-token" content="([^"]+)"/)[1];
    await agent.post('/logout').type('form').send({ _csrf: csrf }).expect(302).expect('location', '/login');
    await agent.get('/dashboard').expect(302);
    assert.ok(await db.collection('devices').findOne({ userId: user._id, revokedReason: 'logout' }));
    const returning = request.agent(base);
    const login = await returning.get('/login').expect(200);
    const loginToken = login.text.match(/name="_csrf"[^>]*value="([^"]+)"/)[1];
    await returning.post('/login').type('form').send({ email, password: 'Wrong-password-A1!', _csrf: loginToken }).expect(401);
    await returning.post('/login').type('form').send({ email, password, _csrf: loginToken }).expect(302).expect('location', '/dashboard');
    await returning.get('/dashboard').expect(200);
  } finally {
    await mongoose.disconnect();
  }
});

const verifiedBase = process.env.CLASSIC_MART_VERIFIED_BASE_URL;
test('signup needs email and onboarding; phone verification remains optional', { skip: !verifiedBase || !uri }, async () => {
  assert.equal(new URL(verifiedBase).hostname, '127.0.0.1');
  const agent = request.agent(verifiedBase);
  const suffix = crypto.randomBytes(6).toString('hex');
  const password = `Verified-${suffix}A1!`;
  const signup = await agent.get('/signup').expect(200);
  const csrf = html => html.match(/name="_csrf"[^>]*value="([^"]+)"/)[1];
  await agent.post('/signup').type('form').send({ name: 'Verified Customer', email: `verified-${suffix}@example.com`, phoneCountry: 'UG', phone: '07' + crypto.randomInt(10000000, 99999999), password, confirmPassword: password, acceptTerms: 'on', _csrf: csrf(signup.text) }).expect(302).expect('location', '/verify-email');
  const emailPage = await agent.get('/verify-email').expect(200);
  await agent.get('/dashboard').expect(302).expect('location', '/verify-email');
  const emailCode = emailPage.text.match(/Development verification code: (\d{6})/)[1];
  await agent.post('/verify-email').type('form').send({ code: emailCode, _csrf: csrf(emailPage.text) }).expect(302).expect('location', '/onboarding');
  await agent.get('/dashboard').expect(302).expect('location', '/onboarding');
  const onboarding = await agent.get('/onboarding').expect(200);
  await agent.post('/onboarding').type('form').send({ role: 'customer', publicName: 'Verified Customer', location: 'Kampala', _csrf: csrf(onboarding.text) }).expect(302).expect('location', '/dashboard');
  await agent.get('/dashboard').expect(200);
  const phonePage = await agent.get('/verify-phone').expect(200);
  await agent.post('/verify-phone/send').type('form').send({ _csrf: csrf(phonePage.text) }).expect(302);
  const sent = await agent.get('/verify-phone').expect(200);
  const phoneCode = sent.text.match(/Development phone verification code: (\d{6})/)[1];
  await agent.post('/verify-phone').type('form').send({ code: phoneCode, _csrf: csrf(sent.text) }).expect(302).expect('location', '/dashboard');
  await agent.get('/dashboard').expect(200);
});

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import { chromium } from '@playwright/test';
import { canonicalPhone } from '../../src/core/phone.js';

/** Real app, database and browser; only the billed Yoola HTTP boundary is fake. */
export async function createMfaBrowserFixture(uri, scope) {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  assert.match(scope, /^[a-z_]+$/);
  const suffix = crypto.randomBytes(8).toString('hex');
  const password = `Methods-${suffix}-A1!`;
  const messages = [];
  const provider = { calls: 0, rejectNext: false };
  const originalFetch = globalThis.fetch;
  const changed = new Map();
  const configure = (name, value) => {
    if (!changed.has(name)) changed.set(name, process.env[name]);
    process.env[name] = value;
  };
  let application, browser, models, closed = false;
  const otherOriginServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html lang="en"><title>Owned alternate origin</title><body><button type="button">Verify test credential</button></body></html>');
  });
  const server = http.createServer((request, response) => {
    if (!application) { response.writeHead(503); response.end(); return; }
    application(request, response);
  });
  async function close() {
    if (closed) return;
    closed = true;
    try { if (browser) await browser.close(); }
    finally {
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      otherOriginServer.closeAllConnections();
      if (otherOriginServer.listening) await new Promise(resolve => otherOriginServer.close(resolve));
      try {
        if (mongoose.connection.readyState === 1) {
          const { settleModelInitialization } = await import('../../scripts/live-test-model-lifecycle.js');
          await settleModelInitialization(mongoose.connection);
          await mongoose.connection.dropDatabase();
        }
      } finally {
        await mongoose.disconnect();
        globalThis.fetch = originalFetch;
        for (const [name, value] of changed) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    }
  }
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    // localhost is a standard secure-context development RP domain. Bind only
    // loopback; do not weaken browser origin checks with insecure-origin flags.
    const base = `http://localhost:${server.address().port}`;
    await new Promise((resolve, reject) => {
      otherOriginServer.once('error', reject);
      otherOriginServer.listen(0, '127.0.0.1', resolve);
    });
    const otherOrigin = `http://localhost:${otherOriginServer.address().port}`;
    const fakeKey = crypto.randomBytes(24).toString('base64url');
    for (const [name, value] of Object.entries({
      NODE_ENV: 'test', BASE_URL: base, SIMPLE_LOGIN: 'false', PRIVILEGED_MFA_REQUIRED: 'true',
      MAIL_MODE: 'log', SMS_MODE: 'yoola', YOOLA_API_KEY: fakeKey, YOOLA_SENDER_ID: '',
      REDIS_URL: '', MONGO_URI: '', AI_ENABLED: 'false', AI_PROVIDER: 'disabled',
    })) configure(name, value);
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.hostname !== 'yoolasms.com') return originalFetch(input, options);
      assert.equal(url.origin, 'https://yoolasms.com');
      assert.equal(url.pathname, '/api/v1/send', 'this fixture never contacts a real SMS provider');
      assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body);
      assert.equal(body.api_key, fakeKey);
      assert.match(body.phone, /^0\d{9}$/, 'Ugandan Yoola requests use national format, not the stored calling code.');
      const code = String(body.message).match(/\b(\d{6})\b/)?.[1];
      assert.ok(code, 'the real MFA sender supplies a verification code');
      messages.push({ phone: canonicalPhone(body.phone, 'UG').slice(1), code });
      provider.calls++;
      const reject = provider.rejectNext;
      provider.rejectNext = false;
      const messageIdMode = provider.nextMessageIdMode;
      delete provider.nextMessageIdMode;
      const acknowledgement = { status: 'success' };
      if (messageIdMode !== 'missing') acknowledgement.message_id = messageIdMode === 'numeric'
        ? provider.calls : `fixture-message-${provider.calls}`;
      return Response.json(reject
        ? { status: 'error', message: 'Insufficient SMS balance.' }
        : acknowledgement);
    };
    await mongoose.connect(uri, { dbName: `classicmart_${scope}_test_${suffix}` });
    models = await import('../../src/models/index.js');
    const { settleModelInitialization } = await import('../../scripts/live-test-model-lifecycle.js');
    await settleModelInitialization(mongoose.connection);
    await models.CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG',
      timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true });
    const { hashPassword } = await import('../../src/core/crypto.js');
    const passwordHash = await hashPassword(password);
    const { createApp } = await import('../../src/app.js');
    application = createApp(null);
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium',
      args: ['--no-sandbox'] });
    let sequence = 0;
    async function actor(role = 'seller', { phoneVerified = true } = {}) {
      const number = ++sequence;
      const email = `mfa-browser-${scope}-${suffix}-${number}@example.test`;
      const phone = `+25670${String(number).padStart(7, '0')}`;
      const user = await models.User.create({ publicId: `usr_${scope}_${suffix}_${number}`,
        name: `MFA Browser Actor ${number}`, email, emailNormalized: email, phone, phoneNormalized: phone,
        passwordHash, role, country: 'UG', currency: 'UGX', locale: 'en-UG',
        emailVerifiedAt: new Date(), ...(phoneVerified ? { phoneVerifiedAt: new Date() } : {}), onboardingCompletedAt: new Date(),
        roleProfile: { businessName: `MFA Browser Store ${number}` },
        consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
      const page = await context.newPage();
      return { user, context, page };
    }
    async function signIn(entry, next = '/seller/store') {
      await entry.page.goto(base + '/login?next=' + encodeURIComponent(next));
      await entry.page.getByLabel('Email address', { exact: true }).fill(entry.user.email);
      await entry.page.getByLabel('Password', { exact: true }).fill(password);
      await Promise.all([
        entry.page.waitForURL(url => url.pathname !== '/login'),
        entry.page.getByRole('button', { name: 'Sign In to Classic Mart', exact: true }).click(),
      ]);
    }
    async function postJson(entry, path, body = {}) {
      return entry.page.evaluate(async ({ path, body }) => {
        const token = document.querySelector('input[name="_csrf"]')?.value
          || document.querySelector('meta[name="csrf-token"]')?.content;
        const response = await fetch(path, { method: 'POST', headers: {
          'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': token,
        }, body: JSON.stringify(body) });
        const text = await response.text();
        let value;
        try { value = JSON.parse(text); } catch { value = { text }; }
        return { status: response.status, body: value };
      }, { path, body });
    }
    async function logout(entry) {
      const token = await entry.page.locator('input[name="_csrf"]').first().inputValue();
      const response = await entry.context.request.post(base + '/logout', { form: { _csrf: token }, maxRedirects: 0 });
      assert.equal(response.status(), 302);
    }
    return { base, otherOrigin, password, models, browser, actor, signIn, postJson, logout, messages, provider, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** The browser signs with an actual owned test private key; no verifier is mocked. */
export async function addVirtualPasskeyAuthenticator(page, credentials = []) {
  const connection = await page.context().newCDPSession(page);
  await connection.send('WebAuthn.enable');
  const { authenticatorId } = await connection.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
  for (const credential of credentials) {
    await connection.send('WebAuthn.addCredential', { authenticatorId, credential });
  }
  return {
    connection, authenticatorId,
    credentials: async () => (await connection.send('WebAuthn.getCredentials', { authenticatorId })).credentials,
  };
}

export function browserPasskeyAssertion(page, options) {
  return page.evaluate(async options => {
    const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=')), character => character.charCodeAt(0));
    const encode = value => btoa(String.fromCharCode(...new Uint8Array(value)))
      .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    const publicKey = typeof PublicKeyCredential.parseRequestOptionsFromJSON === 'function'
      ? PublicKeyCredential.parseRequestOptionsFromJSON(options)
      : { ...options, challenge: decode(options.challenge),
        allowCredentials: options.allowCredentials?.map(item => ({ ...item, id: decode(item.id) })) };
    const credential = await navigator.credentials.get({ publicKey });
    if (typeof credential.toJSON === 'function') return credential.toJSON();
    return { id: credential.id, rawId: encode(credential.rawId), type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment,
      clientExtensionResults: credential.getClientExtensionResults(), response: {
        clientDataJSON: encode(credential.response.clientDataJSON),
        authenticatorData: encode(credential.response.authenticatorData), signature: encode(credential.response.signature),
        userHandle: credential.response.userHandle ? encode(credential.response.userHandle) : undefined,
      } };
  }, options);
}

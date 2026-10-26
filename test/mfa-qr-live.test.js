import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';
import sharp from 'sharp';
import QRCode from 'qrcode';
import { chromium } from '@playwright/test';

process.env.NODE_ENV = 'test';
process.env.SIMPLE_LOGIN = 'false';
process.env.PRIVILEGED_MFA_REQUIRED = 'true';
process.env.MAIL_MODE = 'log';
process.env.SMS_MODE = 'log';
process.env.REDIS_URL = '';
const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const csrf = html => html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('authenticator QR is real private setup material belonging to a current authenticated enrollment', { skip: !uri, timeout: 180_000 }, async t => {
  assert.equal(new URL(uri).hostname, '127.0.0.1');
  assert.match(new URL(uri).pathname, /verification|test/i);
  const suffix = crypto.randomBytes(8).toString('hex'), transports = [];
  await mongoose.connect(uri, { dbName: `classicmart_mfa_qr_test_${suffix}` });
  try {
    const models = await import('../src/models/index.js');
    const { User, Device, CountrySetting } = models;
    const { createApp } = await import('../src/app.js');
    const { hashPassword } = await import('../src/core/crypto.js');
    const { beginMfaEnrollment, confirmMfaEnrollment, pendingMfaEnrollment, totpCode, verifyMfa } = await import('../src/services/mfa.js');
    const { settleModelInitialization } = await import('../scripts/live-test-model-lifecycle.js');
    await settleModelInitialization(mongoose.connection);
    await CountrySetting.create({ code: 'UG', name: 'Uganda', currency: 'UGX', locale: 'en-UG', timeZone: 'Africa/Kampala', phonePrefix: '+256', active: true });
    const password = `Scan-${suffix}-A1!`, passwordHash = await hashPassword(password), app = createApp(null);
    let sequence = 0;
    async function actor(role = 'customer') {
      const number = ++sequence, email = `mfa-qr-${suffix}-${number}@example.test`;
      const user = await User.create({ publicId: `usr_mfa_qr_${suffix}_${number}`, name: 'Authenticator QR Fixture', role,
        email, emailNormalized: email, phone: `+2567${String(number).padStart(8, '0')}`, phoneNormalized: `+2567${String(number).padStart(8, '0')}`,
        passwordHash, country: 'UG', currency: 'UGX', emailVerifiedAt: new Date(), onboardingCompletedAt: new Date(),
        consents: { terms: true, privacy: true, recordedAt: new Date() } });
      const transport = new http.Agent({ localAddress: `127.0.0.${120 + number}`, keepAlive: false });
      transports.push(transport);
      const client = request.agent(app).use(req => req.agent(transport)), form = await client.get('/login').expect(200);
      await client.post('/login').type('form').send({ email, password, _csrf: csrf(form.text) }).expect(302);
      return { user, client };
    }

    await t.test('setup UI serves a same-origin PNG for the genuine pending URI without placing the URI in page text or the image URL', async () => {
      const entry = await actor(), security = await entry.client.get('/account/security').expect(200);
      await entry.client.post('/account/mfa/begin').type('form').send({ currentPassword: password, _csrf: csrf(security.text) }).expect(302);
      const enrollment = await pendingMfaEnrollment(entry.user._id), page = await entry.client.get('/account/security').expect(200);
      assert.match(page.headers['cache-control'], /private/);
      assert.match(page.headers['cache-control'], /no-store/);
      assert.match(page.text, /class="mfa-qr-image" src="\/account\/mfa\/qr-code\.png"/);
      assert.match(page.text, /Scan the QR code below/);
      assert.match(page.text, /Can’t scan the QR code/);
      assert.ok(page.text.includes(enrollment.secret), 'the owner retains a manual setup fallback');
      assert.ok(!page.text.includes(enrollment.uri) && !page.text.includes('otpauth:'), 'the full secret-bearing URI is not displayed');
      let renderedUri;
      const original = QRCode.toBuffer;
      QRCode.toBuffer = async function (value, options) { renderedUri = value; return original.call(this, value, options); };
      let response;
      try { response = await entry.client.get('/account/mfa/qr-code.png').expect(200); }
      finally { QRCode.toBuffer = original; }
      assert.equal(renderedUri, enrollment.uri, 'the image encodes this exact current owner enrollment');
      assert.equal(response.headers['content-type'], 'image/png');
      assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
      assert.match(response.headers['cache-control'], /private/);
      assert.match(response.headers['cache-control'], /no-store/);
      assert.equal(response.headers.etag, undefined);
      assert.equal(response.headers['last-modified'], undefined);
      assert.ok(Buffer.isBuffer(response.body));
      assert.deepEqual(response.body.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const metadata = await sharp(response.body).metadata();
      assert.equal(metadata.width, 256);
      assert.equal(metadata.height, 256);
      const pixels = await sharp(response.body).removeAlpha().raw().toBuffer();
      assert.deepEqual([...pixels.subarray(0, 3)], [255, 255, 255], 'a clean white quiet zone surrounds the QR');
      assert.ok(pixels.some(value => value === 17), 'the QR contains its dark modules');
    });

    await t.test('guests and another user without their own pending setup cannot request another account QR', async () => {
      await request(app).get('/account/mfa/qr-code.png').set('Accept', 'application/json').expect(401);
      const owner = await actor(), other = await actor();
      await beginMfaEnrollment(owner.user._id, password);
      const denied = await other.client.get('/account/mfa/qr-code.png').query({ userId: owner.user.publicId }).set('Accept', 'application/json').expect(404);
      assert.equal(denied.body.error.code, 'MFA_SETUP_NOT_PENDING');
      assert.notEqual(denied.headers['content-type'], 'image/png');
    });

    await t.test('a QR cannot be read once the pending factor is confirmed', async () => {
      const entry = await actor(), enrollment = await beginMfaEnrollment(entry.user._id, password);
      await confirmMfaEnrollment(entry.user._id, totpCode(enrollment.secret), (await Device.findOne({ userId: entry.user._id })).publicId);
      const denied = await entry.client.get('/account/mfa/qr-code.png').set('Accept', 'application/json');
      assert.notEqual(denied.status, 200);
      assert.notEqual(denied.headers['content-type'], 'image/png');
      assert.equal(await pendingMfaEnrollment(entry.user._id), null);
    });

    for (const [label, expectedStatus, mutate] of [
      ['revoked current Device', 403, async entry => Device.updateMany({ userId: entry.user._id }, { $set: { revokedAt: new Date() } })],
      ['changed account token version', 403, async entry => User.updateOne({ _id: entry.user._id }, { $inc: { 'security.tokenVersion': 1 } })],
      ['replacement enrollment', 409, async entry => beginMfaEnrollment(entry.user._id, password)],
    ]) {
      await t.test(`the final image delivery rejects ${label} committed during actual encoding`, async () => {
        const entry = await actor();
        await beginMfaEnrollment(entry.user._id, password);
        const original = QRCode.toBuffer;
        let encoded = false;
        QRCode.toBuffer = async function (...args) {
          const image = await original.apply(this, args);
          await mutate(entry);
          encoded = true;
          return image;
        };
        try {
          const denied = await entry.client.get('/account/mfa/qr-code.png').set('Accept', 'application/json').expect(expectedStatus);
          assert.notEqual(denied.headers['content-type'], 'image/png');
          assert.ok(encoded, 'authority changes after an actual QR is encoded');
        } finally { QRCode.toBuffer = original; }
      });
    }

    await t.test('login challenges share the styled auth shell and expose no enrollment key or QR', async () => {
      const entry = await actor(), enrollment = await beginMfaEnrollment(entry.user._id, password);
      const result = await confirmMfaEnrollment(entry.user._id, totpCode(enrollment.secret));
      const client = request.agent(app), login = await client.get('/login').expect(200);
      await client.post('/login').type('form').send({ email: entry.user.email, password, _csrf: csrf(login.text) }).expect(302).expect('location', '/mfa');
      const challenge = await client.get('/mfa').expect(200);
      assert.match(challenge.text, /href="\/storefront-pages\.css\?v=[a-f0-9]{16}"/);
      assert.match(challenge.text, /href="\/mfa\.css\?v=[a-f0-9]{16}"/);
      assert.match(challenge.text, /class="auth-submit">Continue securely/);
      assert.match(challenge.text, /data-mfa-recovery-toggle/);
      assert.ok(!challenge.text.includes(enrollment.secret));
      assert.doesNotMatch(challenge.text, /otpauth:|mfa-qr-image/);
      await client.post('/mfa').type('form').send({ code: result.codes[0], _csrf: csrf(challenge.text) }).expect(302);
      await client.get('/account/mfa/qr-code.png').set('Accept', 'application/json').expect(404);
    });

    await t.test('desktop and phone browsers complete QR enrollment, manual fallback and styled recovery-code sign-in',
      { skip: !process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, timeout: 100_000 }, async () => {
        const server = http.createServer(app);
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        const base = `http://127.0.0.1:${server.address().port}`;
        let browser;
        try {
          browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
          for (const width of [1366, 390]) {
            const entry = await actor(), context = await browser.newContext({ viewport: { width, height: 900 } });
            try {
              const page = await context.newPage(), browserErrors = [];
              page.on('pageerror', error => browserErrors.push(error.message));
              async function signIn() {
                await page.goto(base + '/login');
                await page.getByLabel('Email address', { exact: true }).fill(entry.user.email);
                await page.getByLabel('Password', { exact: true }).fill(password);
                await Promise.all([page.waitForURL(url => url.pathname !== '/login'), page.getByRole('button', { name: 'Sign In to Classic Mart', exact: true }).click()]);
              }
              await signIn();
              await page.goto(base + '/account/security');
              const start = page.locator('form[action="/account/mfa/begin"]');
              await start.getByLabel('Current password', { exact: true }).fill(password);
              await Promise.all([page.waitForNavigation(), start.getByRole('button', { name: 'Start MFA setup', exact: true }).click()]);
              const enrollment = await pendingMfaEnrollment(entry.user._id);
              assert.ok(enrollment);
              await page.waitForFunction(() => document.querySelector('.mfa-qr-image')?.naturalWidth === 256);
              const geometry = await page.locator('.mfa-qr-image').evaluate(image => ({
                width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height,
                radius: getComputedStyle(image).borderTopLeftRadius,
                overflow: document.documentElement.scrollWidth - window.innerWidth,
              }));
              assert.ok(geometry.width >= 180 && geometry.width <= 256);
              assert.ok(Math.abs(geometry.width - geometry.height) < 1);
              assert.equal(geometry.radius, '0px', 'the QR quiet zone is not clipped like a photograph');
              assert.ok(geometry.overflow <= 2);
              await page.screenshot({ path: `/tmp/classicmart-polish-mfa-setup-${width}.png`, fullPage: true });
              await page.locator('.mfa-manual-setup summary').click();
              const manualKey = page.getByLabel('Authenticator setup key', { exact: true });
              assert.equal(await manualKey.inputValue(), enrollment.secret);
              assert.equal(await manualKey.getAttribute('readonly'), '');
              const confirm = page.locator('form[action="/account/mfa/confirm"]');
              await confirm.getByLabel('Authenticator code', { exact: true }).fill(totpCode(enrollment.secret));
              await Promise.all([page.waitForNavigation(), confirm.getByRole('button', { name: 'Enable MFA', exact: true }).click()]);
              await page.waitForSelector('.mfa-recovery-codes code');
              const codes = (await page.locator('.mfa-recovery-codes code').allTextContents()).map(value => value.trim());
              assert.equal(codes.length, 10);
              assert.equal((await User.findById(entry.user._id)).security.mfaEnabled, true);
              await page.request.post(base + '/logout', { form: { _csrf: csrf(await page.content()) } });
              await signIn();
              assert.equal(new URL(page.url()).pathname, '/mfa');
              const card = await page.locator('.mfa-auth-card').evaluate(node => ({
                radius: parseFloat(getComputedStyle(node).borderTopLeftRadius), width: node.getBoundingClientRect().width,
                overflow: document.documentElement.scrollWidth - window.innerWidth,
              }));
              assert.ok(card.radius >= 20 && card.width >= 250 && card.overflow <= 2, 'the challenge retains its styled, fitting auth card');
              await page.screenshot({ path: `/tmp/classicmart-polish-mfa-challenge-${width}.png`, fullPage: true });
              await page.getByRole('button', { name: 'Use a recovery code instead', exact: true }).click();
              assert.equal(await page.locator('#mfaCode').getAttribute('inputmode'), 'text');
              await page.getByLabel('Authenticator or recovery code', { exact: true }).fill(codes[0]);
              await Promise.all([page.waitForURL(url => url.pathname !== '/mfa'), page.getByRole('button', { name: 'Continue securely', exact: true }).click()]);
              assert.equal(new URL(page.url()).pathname, '/dashboard');
              await assert.rejects(verifyMfa(entry.user._id, codes[0]), { code: 'MFA_CODE_INVALID' });
              assert.deepEqual(browserErrors, []);
            } finally { await context.close(); }
          }
        } finally {
          if (browser) await browser.close();
          server.closeAllConnections();
          await new Promise(resolve => server.close(resolve));
        }
      });
  } finally {
    for (const transport of transports) transport.destroy();
    const { settleModelInitialization } = await import('../scripts/live-test-model-lifecycle.js');
    await settleModelInitialization(mongoose.connection);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

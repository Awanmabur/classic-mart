import test from 'node:test';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { addVirtualPasskeyAuthenticator, browserPasskeyAssertion, createMfaBrowserFixture } from './helpers/mfa-browser-fixture.js';

const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;

test('a real browser enrolls and signs in with a verified passkey; invalid origins, signatures, replay and revocation cannot authenticate', {
  skip: !uri, timeout: 240_000,
}, async t => {
  const fixture = await createMfaBrowserFixture(uri, 'passkey_browser');
  t.after(() => fixture.close());
  const entry = await fixture.actor();
  const pageErrors = [];
  entry.page.on('pageerror', error => pageErrors.push(error.message));
  const authenticator = await addVirtualPasskeyAuthenticator(entry.page);
  let credential, ready = false;

  await t.test('real seller enrollment stores a public credential, displays recovery codes and requires CSRF', async () => {
    await fixture.signIn(entry);
    assert.equal(new URL(entry.page.url()).pathname, '/account/security');
    const noCsrf = await entry.context.request.post(fixture.base + '/account/mfa/passkeys/options', {
      data: { currentPassword: fixture.password }, headers: { accept: 'application/json' },
    });
    assert.equal(noCsrf.status(), 403);
    assert.equal(await fixture.models.PasskeyCredential.countDocuments({ userId: entry.user._id }), 0);
    const form = entry.page.locator('form[data-passkey-enrollment]');
    await form.locator('input[name="currentPassword"]').fill(fixture.password);
    await form.locator('input[name="name"]').fill('My laptop passkey');
    await Promise.all([
      entry.page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      form.locator('[data-passkey-enroll]').click(),
    ]);
    assert.equal(await entry.page.locator('body').getAttribute('data-dashboard-workspace'), 'seller');
    assert.equal(await entry.page.locator('.choice-grid code').count(), 10, 'the first real factor supplies recovery codes');
    const current = await fixture.models.User.findById(entry.user._id);
    assert.equal(current.security.mfaEnabled, true);
    assert.ok(current.security.mfaMethods.includes('passkey'));
    assert.equal(current.security.mfaPasskeyCount, 1);
    credential = await fixture.models.PasskeyCredential.findOne({ userId: entry.user._id, revokedAt: null })
      .select('+credentialId +publicKey +counter');
    assert.ok(credential);
    assert.equal(credential.name, 'My laptop passkey');
    assert.ok(credential.publicKey.length > 0);
    const devices = await authenticator.credentials();
    assert.equal(devices.length, 1, 'Chrome really created a credential');
    const registration = await fixture.models.MfaChallenge.findOne({ userId: entry.user._id, purpose: 'passkey_enroll' });
    assert.ok(registration.consumedAt);
    assert.equal(fixture.provider.calls, 0, 'passkey enrollment does not send an SMS');
    ready = true;
  });
  if (!ready) return;

  await t.test('cancelling the browser prompt keeps the challenge page usable; the next real signature opens the Seller workspace', async t => {
    await fixture.logout(entry);
    await fixture.signIn(entry);
    assert.equal(new URL(entry.page.url()).pathname, '/mfa');
    const before = await fixture.models.Device.countDocuments({ userId: entry.user._id, revokedAt: null });
    const optionsUrl = fixture.base + '/mfa/passkey/options';
    const delayOptions = async route => {
      // The initial waiting status is visible before options return. Retain a
      // real server response delay so this assertion cannot pass by fast timing.
      await new Promise(resolve => setTimeout(resolve, 250));
      await route.continue();
    };
    await entry.page.route(optionsUrl, delayOptions, { times: 1 });
    t.after(() => entry.page.unroute(optionsUrl, delayOptions));
    await entry.page.evaluate(() => {
      const actual = navigator.credentials.get.bind(navigator.credentials);
      Object.defineProperty(navigator.credentials, 'get', { configurable: true, value: () => {
        Object.defineProperty(navigator.credentials, 'get', { configurable: true, value: actual });
        return Promise.reject(new DOMException('The user cancelled the owned test prompt.', 'NotAllowedError'));
      } });
    });
    await entry.page.locator('[data-passkey-login]').click();
    await expect(entry.page.locator('[data-passkey-status]')).toHaveText(/cancel|not completed|try again/i);
    assert.match(await entry.page.locator('[data-passkey-status]').textContent(), /cancel|not completed|try again/i);
    assert.equal(new URL(entry.page.url()).pathname, '/mfa');
    assert.equal(await fixture.models.Device.countDocuments({ userId: entry.user._id, revokedAt: null }), before);
    await Promise.all([
      entry.page.waitForURL(url => url.pathname === '/seller/store'),
      entry.page.locator('[data-passkey-login]').click(),
    ]);
    assert.equal(await entry.page.locator('body').getAttribute('data-dashboard-workspace'), 'seller');
    assert.equal(await entry.page.getByRole('heading', { name: 'Store Settings', exact: true }).count(), 1);
    assert.equal(await entry.page.locator('#sidebar').getByText('My Orders', { exact: true }).count(), 0);
    credential = await fixture.models.PasskeyCredential.findById(credential._id).select('+counter +credentialId +publicKey');
    assert.ok(credential.counter > 0);
    assert.ok(credential.lastUsedAt);
    await entry.page.goto(fixture.base + '/account/security');
  });

  async function options() {
    const result = await fixture.postJson(entry, '/account/mfa/passkeys/authentication/options', {
      currentPassword: fixture.password, action: 'step-up',
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.options.rpId, new URL(fixture.base).hostname);
    assert.equal(result.body.options.userVerification, 'required');
    return result.body;
  }
  const verify = (challengeId, response) => fixture.postJson(entry, '/account/mfa/step-up', {
    currentPassword: fixture.password, mfaMethod: 'passkey', challengeId, credential: response,
  });

  await t.test('a genuine signature from another origin on the same RP host is rejected', async () => {
    const request = await options();
    const alternate = await entry.context.newPage();
    try {
      await alternate.goto(fixture.otherOrigin);
      // Import only this owned fixture's key into a second real virtual device.
      // This creates a valid signature and UV flag for the wrong port/origin;
      // changing clientDataJSON after signing would not prove origin checking.
      await addVirtualPasskeyAuthenticator(alternate, await authenticator.credentials());
      const response = await browserPasskeyAssertion(alternate, request.options);
      const client = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString());
      assert.equal(client.origin, fixture.otherOrigin);
      assert.notEqual(client.origin, fixture.base);
      const before = await fixture.models.PasskeyCredential.findById(credential._id).select('+counter');
      const rejected = await verify(request.challengeId, response);
      assert.equal(rejected.status, 422);
      assert.equal((await fixture.models.PasskeyCredential.findById(credential._id).select('+counter')).counter, before.counter);
      assert.equal((await fixture.models.MfaChallenge.findOne({ publicId: request.challengeId })).consumedAt, undefined);
    } finally { await alternate.close(); }
  });

  await t.test('a tampered signature fails and does not consume the proof', async () => {
    const request = await options();
    const response = await browserPasskeyAssertion(entry.page, request.options);
    const bytes = Buffer.from(response.response.signature, 'base64url');
    bytes[bytes.length - 1] ^= 1;
    response.response.signature = bytes.toString('base64url');
    const rejected = await verify(request.challengeId, response);
    assert.equal(rejected.status, 422);
    assert.equal((await fixture.models.MfaChallenge.findOne({ publicId: request.challengeId })).consumedAt, undefined);
  });

  await t.test('a real step-up proof succeeds once and replay cannot advance the credential counter again', async () => {
    const request = await options();
    const response = await browserPasskeyAssertion(entry.page, request.options);
    const accepted = await verify(request.challengeId, response);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.ok((await fixture.models.MfaChallenge.findOne({ publicId: request.challengeId })).consumedAt);
    const after = await fixture.models.PasskeyCredential.findById(credential._id).select('+counter');
    const replay = await verify(request.challengeId, response);
    assert.equal(replay.status, 422);
    assert.equal((await fixture.models.PasskeyCredential.findById(credential._id).select('+counter')).counter, after.counter);
  });

  await t.test('another account cannot use this real credential even with its own valid password and challenge', async () => {
    const other = await fixture.actor();
    try {
      await addVirtualPasskeyAuthenticator(other.page);
      await fixture.signIn(other);
      const form = other.page.locator('form[data-passkey-enrollment]');
      await form.locator('input[name="currentPassword"]').fill(fixture.password);
      await form.locator('input[name="name"]').fill('Other account passkey');
      await Promise.all([other.page.waitForNavigation(), form.locator('[data-passkey-enroll]').click()]);
      assert.equal(await fixture.models.PasskeyCredential.countDocuments({ userId: other.user._id, revokedAt: null }), 1);
      const request = await fixture.postJson(other, '/account/mfa/passkeys/authentication/options', {
        currentPassword: fixture.password, action: 'step-up',
      });
      assert.equal(request.status, 200, JSON.stringify(request.body));
      // Client-controlled allowCredentials is not an ownership boundary. Sign
      // B's real server nonce with A's actual key, on the correct website, then
      // submit through B's real session. Signature and challenge are genuine;
      // only the server's user/credential ownership check can safely reject it.
      const response = await browserPasskeyAssertion(entry.page, {
        ...request.body.options,
        allowCredentials: [{ id: credential.credentialId, type: 'public-key', transports: ['internal'] }],
      });
      assert.equal(response.id, credential.credentialId);
      const before = await fixture.models.PasskeyCredential.findById(credential._id).select('+counter');
      const rejected = await fixture.postJson(other, '/account/mfa/step-up', {
        currentPassword: fixture.password, mfaMethod: 'passkey', challengeId: request.body.challengeId, credential: response,
      });
      assert.equal(rejected.status, 422);
      assert.equal((await fixture.models.PasskeyCredential.findById(credential._id).select('+counter')).counter, before.counter);
      assert.equal((await fixture.models.MfaChallenge.findOne({ publicId: request.body.challengeId })).consumedAt, undefined);
    } finally { await other.context.close(); }
  });

  await t.test('revoking the credential after signing but before verification denies the in-flight proof', async () => {
    const request = await options();
    const response = await browserPasskeyAssertion(entry.page, request.options);
    await fixture.models.PasskeyCredential.updateOne({ _id: credential._id }, { $set: { revokedAt: new Date() } });
    const before = await fixture.models.PasskeyCredential.findById(credential._id).select('+counter');
    const rejected = await verify(request.challengeId, response);
    assert.equal(rejected.status, 422);
    assert.equal((await fixture.models.PasskeyCredential.findById(credential._id).select('+counter')).counter, before.counter);
  });
  assert.deepEqual(pageErrors, []);
});

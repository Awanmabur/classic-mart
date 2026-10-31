import test from 'node:test';
import assert from 'node:assert/strict';
import { createMfaBrowserFixture } from './helpers/mfa-browser-fixture.js';

const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;

test('SMS MFA completes seller enrollment and login with one-time phone-bound codes, without granting staff assurance', {
  skip: !uri, timeout: 240_000,
}, async t => {
  const fixture = await createMfaBrowserFixture(uri, 'sms_browser');
  let mockedDate = false;
  t.after(async () => { if (mockedDate) t.mock.timers.reset(); await fixture.close(); });
  const advance = milliseconds => {
    if (!mockedDate) {
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      mockedDate = true;
    }
    t.mock.timers.tick(milliseconds);
  };
  const entry = await fixture.actor('seller', { phoneVerified: false });
  let recoveryCodes = [], ready = false;
  const lastMessage = actor => fixture.messages.filter(message => message.phone === actor.user.phone.slice(1)).at(-1);
  async function requiredForm(actor, action, response) {
    const form = actor.page.locator(`form[action="${action}"]`);
    const evidence = { path: new URL(actor.page.url()).pathname, status: response?.status(),
      headings: (await actor.page.locator('h1').allTextContents()).map(value => value.trim().slice(0, 120)),
      formCount: await form.count() };
    // Keep failures useful without printing the page, password, challenge code,
    // cookies or provider payload when a redirect rendered an error document.
    assert.equal(evidence.formCount, 1, 'The next real MFA form must render: ' + JSON.stringify(evidence));
    return form;
  }

  await t.test('the user explicitly chooses SMS; one enrollment code verifies the saved phone and the factor', async () => {
    await fixture.signIn(entry);
    assert.equal(new URL(entry.page.url()).pathname, '/account/security');
    assert.equal(fixture.provider.calls, 0, 'password login and security rendering must not silently send SMS');
    let begin = await requiredForm(entry, '/account/mfa/sms/begin');
    await begin.locator('input[name="currentPassword"]').fill('wrong-password');
    const [badPasswordResponse] = await Promise.all([entry.page.waitForNavigation(), begin.locator('button[type="submit"]').click()]);
    assert.equal(fixture.provider.calls, 0, 'a bad password must fail before the billed provider boundary');
    begin = await requiredForm(entry, '/account/mfa/sms/begin', badPasswordResponse);
    await begin.locator('input[name="currentPassword"]').fill(fixture.password);
    const [sentResponse] = await Promise.all([entry.page.waitForNavigation(), begin.locator('button[type="submit"]').click()]);
    assert.equal(fixture.provider.calls, 1);
    const confirmation = await requiredForm(entry, '/account/mfa/sms/confirm', sentResponse);
    const id = await confirmation.locator('input[name="challengeId"]').inputValue();
    const code = lastMessage(entry).code;
    const pending = await fixture.models.MfaChallenge.findOne({ publicId: id }).select('+tokenHash');
    assert.equal(pending.purpose, 'sms_enroll');
    assert.notEqual(pending.tokenHash, code, 'the database must not contain the plaintext code');
    assert.ok(pending.deliveredAt);
    let actor = await fixture.models.User.findById(entry.user._id);
    assert.equal(actor.security.mfaEnabled, false, 'provider acceptance does not enable the factor');
    assert.equal(actor.phoneVerifiedAt, undefined, 'provider acceptance alone does not verify ownership');
    await confirmation.locator('input[name="code"]').fill(code);
    await Promise.all([entry.page.waitForNavigation(), confirmation.locator('button[type="submit"]').click()]);
    recoveryCodes = await entry.page.locator('.choice-grid code').allTextContents();
    assert.equal(recoveryCodes.length, 10);
    actor = await fixture.models.User.findById(entry.user._id).select('+security.mfaSecretEncrypted');
    assert.equal(actor.security.mfaEnabled, true);
    assert.deepEqual([...actor.security.mfaMethods], ['sms']);
    assert.ok(actor.phoneVerifiedAt);
    assert.equal(actor.security.mfaSecretEncrypted, undefined, 'SMS enrollment must not secretly require an authenticator');
    assert.equal(actor.security.mfaRecoveryStrong, false);
    assert.ok((await fixture.models.MfaChallenge.findOne({ publicId: id })).consumedAt);
    await entry.page.goto(fixture.base + '/seller/store');
    assert.equal(await entry.page.locator('body').getAttribute('data-dashboard-workspace'), 'seller');
    assert.equal(await entry.page.getByRole('heading', { name: 'Store Settings', exact: true }).count(), 1);
    ready = true;
  });
  if (!ready) return;

  await t.test('real sign-in enforces the resend cooldown then accepts the current SMS code once', async () => {
    await fixture.logout(entry);
    await fixture.signIn(entry);
    assert.equal(new URL(entry.page.url()).pathname, '/mfa');
    const cooldown = await fixture.postJson(entry, '/mfa/sms/send');
    assert.equal(cooldown.status, 429);
    assert.equal(cooldown.body.error.code, 'MFA_SMS_COOLDOWN');
    assert.equal(fixture.provider.calls, 1);
    // Advance only the real cooldown boundary. No challenge, rate-limit counter,
    // attempt count or database timestamp is reset; the 15-minute auth window
    // remains active. Browser/WebAuthn clocks are not replaced by this test.
    advance(61_000);
    const send = entry.page.locator('form[action="/mfa/sms/send"]');
    await Promise.all([entry.page.waitForNavigation(), send.locator('button[type="submit"]').click()]);
    assert.equal(fixture.provider.calls, 2);
    const confirmation = entry.page.locator('form[action="/mfa/sms/verify"]');
    const id = await confirmation.locator('input[name="challengeId"]').inputValue();
    const code = lastMessage(entry).code;
    const wrong = await fixture.postJson(entry, '/mfa/sms/verify', { challengeId: id, code: code === '000000' ? '111111' : '000000' });
    assert.equal(wrong.status, 422);
    assert.equal((await fixture.models.MfaChallenge.findOne({ publicId: id })).attempts, 1);
    await confirmation.locator('input[name="code"]').fill(code);
    await Promise.all([
      entry.page.waitForURL(url => url.pathname === '/seller/store'),
      confirmation.locator('button[type="submit"]').click(),
    ]);
    assert.equal(await entry.page.locator('body').getAttribute('data-dashboard-workspace'), 'seller');
    assert.equal(await entry.page.locator('#sidebar').getByText('My Orders', { exact: true }).count(), 0);
    assert.ok((await fixture.models.MfaChallenge.findOne({ publicId: id })).consumedAt);
    const replay = await fixture.postJson(entry, '/mfa/sms/verify', { challengeId: id, code });
    assert.ok([401, 403, 422].includes(replay.status), 'a completed login challenge cannot be reused');
  });

  await t.test('SMS-only credentials and their recovery codes cannot acquire staff assurance after a role change', async () => {
    await fixture.models.User.updateOne({ _id: entry.user._id }, { $set: { role: 'support', operationalCountries: ['UG'] } });
    const denied = await entry.context.request.get(fixture.base + '/support/overview', {
      headers: { accept: 'application/json' }, maxRedirects: 0,
    });
    assert.equal(denied.status(), 403);
    const denial = await denied.json();
    assert.ok(['MFA_ENROLLMENT_REQUIRED', 'MFA_STRONG_REQUIRED', 'MFA_VERIFICATION_REQUIRED'].includes(denial.error.code));
    await entry.page.goto(fixture.base + '/account/security');
    const proof = await fixture.postJson(entry, '/account/mfa/step-up', {
      currentPassword: fixture.password, mfaMethod: 'recovery', code: recoveryCodes[0],
    });
    // A low-assurance code may confirm the owner's personal account identity,
    // but must never authorize the staff workspace. Either an explicit strong-
    // factor refusal or a successful non-strong proof must leave that gate shut.
    assert.ok([200, 403].includes(proof.status));
    if (proof.status === 403) assert.equal(proof.body.error.code, 'MFA_STRONG_REQUIRED');
    const stillDenied = await entry.context.request.get(fixture.base + '/support/overview', {
      headers: { accept: 'application/json' }, maxRedirects: 0,
    });
    assert.equal(stillDenied.status(), 403);
    assert.ok(['MFA_ENROLLMENT_REQUIRED', 'MFA_STRONG_REQUIRED', 'MFA_VERIFICATION_REQUIRED'].includes((await stillDenied.json()).error.code));
  });

  await t.test('a provider rejection invalidates the issued code and never marks ownership or MFA successful', async () => {
    const rejected = await fixture.actor('seller', { phoneVerified: false });
    await fixture.signIn(rejected);
    fixture.provider.rejectNext = true;
    const result = await fixture.postJson(rejected, '/account/mfa/sms/begin', { currentPassword: fixture.password });
    assert.equal(result.status, 502);
    assert.equal(result.body.error.code, 'SMS_CREDIT_REQUIRED');
    const challenge = await fixture.models.MfaChallenge.findOne({ userId: rejected.user._id, purpose: 'sms_enroll' });
    assert.ok(challenge.consumedAt);
    assert.equal(challenge.deliveredAt, undefined);
    const cannotConfirm = await fixture.postJson(rejected, '/account/mfa/sms/confirm', {
      challengeId: challenge.publicId, code: lastMessage(rejected).code,
    });
    assert.equal(cannotConfirm.status, 422);
    const actor = await fixture.models.User.findById(rejected.user._id);
    assert.equal(actor.security.mfaEnabled, false);
    assert.equal(actor.phoneVerifiedAt, undefined);
    await rejected.context.close();
  });

  await t.test('changing the saved phone while its enrollment code is in flight invalidates that proof', async () => {
    const changed = await fixture.actor('seller', { phoneVerified: false });
    await fixture.signIn(changed);
    const sent = await fixture.postJson(changed, '/account/mfa/sms/begin', { currentPassword: fixture.password });
    assert.equal(sent.status, 200);
    const code = lastMessage(changed).code;
    await fixture.models.User.updateOne({ _id: changed.user._id }, {
      $set: { phone: '+256789000123', phoneNormalized: '+256789000123' },
    });
    const result = await fixture.postJson(changed, '/account/mfa/sms/confirm', { challengeId: sent.body.challengeId, code });
    assert.equal(result.status, 422);
    assert.equal((await fixture.models.User.findById(changed.user._id)).security.mfaEnabled, false);
    await changed.context.close();
  });

  await t.test('five incorrect guesses exhaust a code even when the next supplied code is correct', async () => {
    const capped = await fixture.actor('seller', { phoneVerified: false });
    await fixture.signIn(capped);
    const sent = await fixture.postJson(capped, '/account/mfa/sms/begin', { currentPassword: fixture.password });
    assert.equal(sent.status, 200);
    const code = lastMessage(capped).code;
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await fixture.postJson(capped, '/account/mfa/sms/confirm', {
        challengeId: sent.body.challengeId, code: code === '000000' ? '111111' : '000000',
      });
      assert.equal(result.status, 422);
    }
    const validAfterCap = await fixture.postJson(capped, '/account/mfa/sms/confirm', { challengeId: sent.body.challengeId, code });
    assert.equal(validAfterCap.status, 422);
    assert.equal((await fixture.models.MfaChallenge.findOne({ publicId: sent.body.challengeId })).attempts, 5);
    assert.equal((await fixture.models.User.findById(capped.user._id)).security.mfaEnabled, false);
    await capped.context.close();
  });

  await t.test('an expired enrollment code fails without relying on MongoDB TTL deletion timing', async () => {
    const expired = await fixture.actor('seller', { phoneVerified: false });
    await fixture.signIn(expired);
    const sent = await fixture.postJson(expired, '/account/mfa/sms/begin', { currentPassword: fixture.password });
    assert.equal(sent.status, 200);
    const code = lastMessage(expired).code;
    advance(5 * 60_000 + 1);
    const result = await fixture.postJson(expired, '/account/mfa/sms/confirm', { challengeId: sent.body.challengeId, code });
    assert.equal(result.status, 422);
    assert.equal((await fixture.models.User.findById(expired.user._id)).security.mfaEnabled, false);
    await expired.context.close();
  });
  // These independent accounts share the fixture's loopback IP. Move past the
  // real authentication window before their additional logins; do not clear
  // rate-limit counters or weaken the application's limits for this regression.
  advance(15 * 60_000 + 1);
  for (const messageIdMode of ['missing', 'numeric']) {
    await t.test(`positive SMS acknowledgement with ${messageIdMode} tracking ID preserves enrollment until the real OTP is checked`, async () => {
      const accepted = await fixture.actor('seller', { phoneVerified: false });
      try {
        await fixture.signIn(accepted);
        fixture.provider.nextMessageIdMode = messageIdMode;
        const sent = await fixture.postJson(accepted, '/account/mfa/sms/begin', { currentPassword: fixture.password });
        assert.equal(sent.status, 200, 'An explicit positive provider acknowledgement must not be rejected solely for its tracking metadata.');
        const challenge = await fixture.models.MfaChallenge.findOne({ publicId: sent.body.challengeId });
        assert.ok(challenge.deliveredAt);
        assert.equal(challenge.consumedAt, undefined);
        let actor = await fixture.models.User.findById(accepted.user._id);
        assert.equal(actor.security.mfaEnabled, false);
        assert.equal(actor.phoneVerifiedAt, undefined);
        const code = lastMessage(accepted).code;
        const confirmed = await fixture.postJson(accepted, '/account/mfa/sms/confirm', { challengeId: sent.body.challengeId, code });
        assert.equal(confirmed.status, 200);
        actor = await fixture.models.User.findById(accepted.user._id);
        assert.ok(actor.phoneVerifiedAt);
        assert.equal(actor.security.mfaEnabled, true);
        assert.ok((await fixture.models.MfaChallenge.findById(challenge._id)).consumedAt);
        const replay = await fixture.postJson(accepted, '/account/mfa/sms/confirm', { challengeId: sent.body.challengeId, code });
        assert.equal(replay.status, 422, 'An accepted provider acknowledgement cannot allow a second use of the proof.');
      } finally { await accepted.context.close(); }
    });
  }

  await t.test('ordinary phone verification accepts positive sending without a tracking ID and still requires a single-use OTP', async () => {
    const customer = await fixture.actor('customer', { phoneVerified: false });
    try {
      await fixture.signIn(customer, '/verify-phone');
      await customer.page.goto(fixture.base + '/verify-phone');
      fixture.provider.nextMessageIdMode = 'missing';
      const [sent] = await Promise.all([
        customer.page.waitForNavigation(),
        customer.page.locator('form[action="/verify-phone/send"] button[type="submit"]').click(),
      ]);
      assert.equal(sent.status(), 200);
      assert.equal(new URL(customer.page.url()).pathname, '/verify-phone');
      assert.match(await customer.page.locator('[role="status"]').innerText(), /accepted for sending/);
      const token = await fixture.models.VerificationToken.findOne({ userId: customer.user._id, purpose: 'verify_phone' }).select('+tokenHash');
      assert.equal(token.consumedAt, undefined);
      const code = lastMessage(customer).code;
      assert.notEqual(token.tokenHash, code);
      assert.equal((await fixture.models.User.findById(customer.user._id)).phoneVerifiedAt, undefined);
      await customer.page.locator('input[name="code"]').fill(code);
      await Promise.all([
        customer.page.waitForURL(url => url.pathname === '/dashboard'),
        customer.page.locator('form[action="/verify-phone"] button[type="submit"]').click(),
      ]);
      assert.ok((await fixture.models.User.findById(customer.user._id)).phoneVerifiedAt);
      assert.ok((await fixture.models.VerificationToken.findById(token._id)).consumedAt);
      const replay = await fixture.postJson(customer, '/verify-phone', { code });
      assert.equal(replay.status, 422);
    } finally { await customer.context.close(); }
  });

});

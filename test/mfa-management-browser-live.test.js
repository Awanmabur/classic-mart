import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { addVirtualPasskeyAuthenticator, createMfaBrowserFixture } from './helpers/mfa-browser-fixture.js';

const uri = process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;

test('real security management confirms changes, preserves required factors and completes recovery and removal flows', {
  skip: !uri, timeout: 300_000,
}, async t => {
  const fixture = await createMfaBrowserFixture(uri, 'mfa_management_browser');
  t.after(() => fixture.close());
  const errors = [];
  const entry = await fixture.actor();
  entry.page.on('pageerror', error => errors.push(error.message));
  let authenticator, firstCredential, secondCredential, ready = false;
  const csrfRequests = [];
  entry.page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/account/mfa/')) {
      csrfRequests.push(new URL(request.url()).pathname);
    }
  });

  async function securityNavigation(actor, button) {
    const alert = actor.page.locator('[data-passkey-status][role="alert"]:visible').first();
    try {
      const outcome = await Promise.race([
        actor.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 }).then(() => 'navigation'),
        button.click({ timeout: 20_000 }).then(() => alert.waitFor({ state: 'visible', timeout: 20_000 })).then(() => 'rejected'),
      ]);
      if (outcome !== 'navigation') throw new Error('The security action displayed an error instead of navigating.');
    } catch (error) {
      const evidence = { path: new URL(actor.page.url()).pathname,
        alerts: (await actor.page.locator('[data-passkey-status][role="alert"]').allTextContents()).map(text => text.trim().slice(0, 240)),
        confirmationOpen: await actor.page.locator('dialog.record-confirm-modal[open]').count() };
      // Only fixed UI status text and the route are diagnostics. Never include
      // HTML, form values, cookies, QR data or captured verification messages.
      throw new Error('Security action failed: ' + JSON.stringify(evidence), { cause: error });
    }
  }
  async function enrollPasskey(actor, name) {
    const form = actor.page.locator('form[data-passkey-enrollment]');
    await form.locator('input[name="name"]').fill(name);
    await form.locator('input[name="currentPassword"]').fill(fixture.password);
    await securityNavigation(actor, form.locator('[data-passkey-enroll]'));
    assert.equal(new URL(actor.page.url()).pathname, '/account/security');
    return fixture.models.PasskeyCredential.findOne({ userId: actor.user._id, name, revokedAt: null });
  }
  async function prepareProof(form, method = 'passkey', code = '') {
    await form.locator('input[name="currentPassword"]').fill(fixture.password);
    await form.locator('select[name="mfaMethod"]').selectOption(method);
    if (method !== 'passkey') await form.locator('input[name="code"]').fill(code);
  }
  async function openConfirmation(actor, button) {
    await button.click();
    const dialog = actor.page.locator('dialog.record-confirm-modal');
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await dialog.getByRole('button', { name: 'Cancel', exact: true }).evaluate(button => button === document.activeElement), true);
    return dialog;
  }
  async function confirmAndNavigate(actor, dialog) {
    await securityNavigation(actor, dialog.getByRole('button', { name: 'Continue', exact: true }));
    assert.equal(new URL(actor.page.url()).pathname, '/account/security');
  }
  async function enrollSms(actor) {
    const begin = actor.page.locator('form[action="/account/mfa/sms/begin"]');
    await begin.locator('input[name="currentPassword"]').fill(fixture.password);
    await Promise.all([actor.page.waitForNavigation(), begin.getByRole('button', { name: 'Send setup SMS', exact: true }).click()]);
    const form = actor.page.locator('form[action="/account/mfa/sms/confirm"]');
    const message = fixture.messages.filter(message => message.phone === actor.user.phone.slice(1)).at(-1);
    assert.ok(message);
    await form.locator('input[name="code"]').fill(message.code);
    await Promise.all([actor.page.waitForNavigation(), form.getByRole('button', { name: 'Enable SMS security', exact: true }).click()]);
    const codes = await actor.page.locator('.choice-grid code').allTextContents();
    assert.equal(codes.length, 10);
    return codes;
  }

  await t.test('a seller enrolls two separate real device credentials without replacing the first', async () => {
    await fixture.signIn(entry);
    authenticator = await addVirtualPasskeyAuthenticator(entry.page);
    firstCredential = await enrollPasskey(entry, 'First device');
    assert.ok(firstCredential);
    assert.equal(await entry.page.locator('.choice-grid code').count(), 10);
    // A separate device must create the second key: excludeCredentials rightly
    // prevents silently registering the same authenticator twice.
    await authenticator.connection.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: authenticator.authenticatorId });
    authenticator = await addVirtualPasskeyAuthenticator(entry.page);
    secondCredential = await enrollPasskey(entry, 'Second device');
    assert.ok(secondCredential);
    assert.equal(await fixture.models.PasskeyCredential.countDocuments({ userId: entry.user._id, revokedAt: null }), 2);
    assert.equal((await fixture.models.User.findById(entry.user._id)).security.mfaPasskeyCount, 2);
    assert.equal(await entry.page.locator('.choice-grid code').count(), 0, 'adding an already-strong method must not unexpectedly replace saved recovery codes');
    assert.equal(fixture.provider.calls, 0);
    ready = true;
  });
  if (!ready) return;

  await t.test('recovery regeneration waits for confirmation, then uses a real passkey proof and rotates every old code', async () => {
    const before = await fixture.models.User.findById(entry.user._id).select('+security.mfaRecoveryCodeHashes');
    const previousHashes = [...before.security.mfaRecoveryCodeHashes];
    const form = entry.page.locator('form[action="/account/mfa/recovery-codes"]');
    await entry.page.locator('details.mfa-method-section > summary').click();
    await prepareProof(form);
    const button = form.getByRole('button', { name: 'Generate new recovery codes', exact: true });
    const beforeRequests = csrfRequests.length;
    let dialog = await openConfirmation(entry, button);
    assert.equal(csrfRequests.length, beforeRequests, 'no password, passkey prompt or mutation is submitted before confirmation');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.deepEqual((await fixture.models.User.findById(entry.user._id).select('+security.mfaRecoveryCodeHashes')).security.mfaRecoveryCodeHashes, previousHashes);
    dialog = await openConfirmation(entry, button);
    await confirmAndNavigate(entry, dialog);
    const codes = await entry.page.locator('.choice-grid code').allTextContents();
    assert.equal(codes.length, 10);
    const after = await fixture.models.User.findById(entry.user._id).select('+security.mfaRecoveryCodeHashes');
    assert.equal(after.security.mfaRecoveryStrong, true);
    assert.equal(after.security.mfaRecoveryCodeHashes.length, 10);
    assert.equal(after.security.mfaRecoveryCodeHashes.some(hash => previousHashes.includes(hash)), false);
    assert.equal(csrfRequests.slice(beforeRequests).filter(path => path === '/account/mfa/recovery-codes').length, 1);
    const consumed = await fixture.models.MfaChallenge.findOne({ userId: entry.user._id, purpose: 'passkey_manage', action: 'recovery-codes' });
    assert.ok(consumed.consumedAt);
  });

  await t.test('the real removal UI cancels safely, then revokes only the selected credential using the other device', async () => {
    const section = entry.page.locator('details.mfa-credential').filter({ has: entry.page.locator('summary', { hasText: 'First device' }) });
    await section.locator('summary').click();
    const form = section.locator('form');
    await prepareProof(form);
    const button = form.getByRole('button', { name: 'Remove passkey', exact: true });
    const beforeVersion = (await fixture.models.User.findById(entry.user._id)).security.tokenVersion;
    const beforeRequests = csrfRequests.length;
    let dialog = await openConfirmation(entry, button);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal((await fixture.models.PasskeyCredential.findById(firstCredential._id)).revokedAt, undefined);
    assert.equal(csrfRequests.length, beforeRequests);
    dialog = await openConfirmation(entry, button);
    await confirmAndNavigate(entry, dialog);
    assert.ok((await fixture.models.PasskeyCredential.findById(firstCredential._id)).revokedAt);
    assert.equal((await fixture.models.PasskeyCredential.findById(secondCredential._id)).revokedAt, undefined);
    const actor = await fixture.models.User.findById(entry.user._id);
    assert.equal(actor.security.mfaPasskeyCount, 1);
    assert.equal(actor.security.tokenVersion, beforeVersion + 1);
    assert.equal(csrfRequests.slice(beforeRequests).filter(path => path.endsWith('/revoke')).length, 1);
    assert.equal(await fixture.models.AuditLog.countDocuments({ actorId: entry.user._id, action: 'account.passkey_removed', targetPublicId: firstCredential.publicId }), 1);
  });

  await t.test('the last required seller factor stays enabled after a genuine removal proof', async () => {
    const section = entry.page.locator('details.mfa-credential').filter({ has: entry.page.locator('summary', { hasText: 'Second device' }) });
    await section.locator('summary').click();
    const form = section.locator('form');
    await prepareProof(form);
    const dialog = await openConfirmation(entry, form.getByRole('button', { name: 'Remove passkey', exact: true }));
    const responsePromise = entry.page.waitForResponse(response => new URL(response.url()).pathname === `/account/mfa/passkeys/${secondCredential.publicId}/revoke`);
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    const response = await responsePromise;
    assert.equal(response.status(), 409);
    const error = await response.json();
    assert.equal(error.error.code, 'MFA_REQUIRED');
    await form.locator('[data-passkey-status][role="alert"]').waitFor({ state: 'visible' });
    assert.ok((await form.locator('[data-passkey-status]').textContent()).includes('Add another required security method'));
    const actor = await fixture.models.User.findById(entry.user._id);
    assert.equal(actor.security.mfaEnabled, true);
    assert.equal(actor.security.mfaPasskeyCount, 1);
    assert.equal((await fixture.models.PasskeyCredential.findById(secondCredential._id)).revokedAt, undefined);
  });

  await t.test('a missing required sign-in audit returns 500 without authenticating or creating a device', async () => {
    await fixture.logout(entry);
    await fixture.signIn(entry);
    assert.equal(new URL(entry.page.url()).pathname, '/mfa');
    const devicesBefore = await fixture.models.Device.countDocuments({ userId: entry.user._id });
    const auditsBefore = await fixture.models.AuditLog.countDocuments({ actorId: entry.user._id, action: 'identity.login' });
    const originalInsert = fixture.models.AuditLog.collection.insertOne;
    fixture.models.AuditLog.collection.insertOne = async function (document, ...args) {
      if (document.action === 'identity.login' && String(document.actorId) === String(entry.user._id)) throw new Error('Owned fixture sign-in audit failure');
      return originalInsert.call(this, document, ...args);
    };
    let failed;
    try {
      const responsePromise = entry.page.waitForResponse(response => new URL(response.url()).pathname === '/mfa/passkey/verify');
      await entry.page.locator('[data-passkey-login]').click();
      failed = await responsePromise;
    } finally { fixture.models.AuditLog.collection.insertOne = originalInsert; }
    assert.equal(failed.status(), 500);
    assert.equal((await failed.json()).error.code, 'INTERNAL_ERROR');
    await entry.page.locator('[data-passkey-status][role="alert"]').waitFor({ state: 'visible' });
    const protectedPage = await entry.context.request.get(fixture.base + '/account/security', { headers: { accept: 'application/json' }, maxRedirects: 0 });
    assert.equal(protectedPage.status(), 401, 'an error response must not leave an authenticated session for Express to autosave');
    assert.equal(await fixture.models.Device.countDocuments({ userId: entry.user._id }), devicesBefore);
    assert.equal(await fixture.models.AuditLog.countDocuments({ actorId: entry.user._id, action: 'identity.login' }), auditsBefore);
    await Promise.all([entry.page.waitForURL(url => url.pathname === '/seller/store'), entry.page.locator('[data-passkey-login]').click()]);
    assert.equal(await entry.page.locator('body').getAttribute('data-dashboard-workspace'), 'seller');
    await entry.page.goto(fixture.base + '/account/security');
  });

  await t.test('additional authenticator enrollment rolls back activation and device revocation if required audit fails', async () => {
    const { hashToken } = await import('../src/core/crypto.js');
    const { totpCode } = await import('../src/services/mfa.js');
    const unrelated = await fixture.models.Device.create({ publicId: `dev_${crypto.randomUUID().replaceAll('-', '')}`, userId: entry.user._id,
      sessionHash: hashToken(crypto.randomUUID()), label: 'Another owned device', userAgent: 'MfaManagement/1.0', ipHash: hashToken('127.0.0.1'), lastSeenAt: new Date() });
    const begin = entry.page.locator('form[action="/account/mfa/begin"]');
    await begin.locator('input[name="currentPassword"]').fill(fixture.password);
    await Promise.all([entry.page.waitForNavigation(), begin.getByRole('button', { name: 'Start MFA setup', exact: true }).click()]);
    const secret = await entry.page.locator('.mfa-manual-key').inputValue();
    const before = await fixture.models.User.findById(entry.user._id).select('+security.mfaPendingSecretEncrypted');
    assert.deepEqual([...before.security.mfaMethods], ['passkey']);
    const originalInsert = fixture.models.AuditLog.collection.insertOne;
    fixture.models.AuditLog.collection.insertOne = async function (document, ...args) {
      if (document.action === 'account.mfa_enabled' && String(document.actorId) === String(entry.user._id)) throw new Error('Owned fixture authenticator audit failure');
      return originalInsert.call(this, document, ...args);
    };
    let failed;
    try {
      const confirmation = entry.page.locator('form[action="/account/mfa/confirm"]');
      await confirmation.locator('input[name="code"]').fill(totpCode(secret));
      [failed] = await Promise.all([entry.page.waitForNavigation(), confirmation.getByRole('button', { name: 'Enable MFA', exact: true }).click()]);
    } finally { fixture.models.AuditLog.collection.insertOne = originalInsert; }
    assert.equal(failed.status(), 500);
    const after = await fixture.models.User.findById(entry.user._id).select('+security.mfaPendingSecretEncrypted +security.mfaSecretEncrypted');
    assert.deepEqual([...after.security.mfaMethods], ['passkey']);
    assert.equal(after.security.mfaSecretEncrypted, undefined);
    assert.equal(after.security.mfaPendingSecretEncrypted, before.security.mfaPendingSecretEncrypted);
    assert.equal(after.security.tokenVersion, before.security.tokenVersion);
    assert.equal(after.__v, before.__v, 'current-identity write fencing must also roll back');
    assert.equal((await fixture.models.Device.findById(unrelated._id)).revokedAt, undefined);
    assert.equal(await fixture.models.AuditLog.countDocuments({ actorId: entry.user._id, action: 'account.mfa_enabled' }), 0);
    await entry.page.goto(fixture.base + '/account/security');
    assert.equal(await entry.page.locator('body').getAttribute('data-dashboard-workspace'), 'seller');
    const retry = entry.page.locator('form[action="/account/mfa/confirm"]');
    await retry.locator('input[name="code"]').fill(totpCode(secret));
    await Promise.all([entry.page.waitForNavigation(), retry.getByRole('button', { name: 'Enable MFA', exact: true }).click()]);
    const committed = await fixture.models.User.findById(entry.user._id);
    assert.deepEqual([...committed.security.mfaMethods].sort(), ['passkey', 'totp']);
    assert.equal(committed.security.tokenVersion, before.security.tokenVersion + 1);
    assert.equal(await entry.page.locator('.choice-grid code').count(), 10);
    assert.ok((await fixture.models.Device.findById(unrelated._id)).revokedAt);
    assert.equal(await fixture.models.AuditLog.countDocuments({ actorId: entry.user._id, action: 'account.mfa_enabled' }), 1);
  });

  await t.test('a failed required step-up audit returns 500, rolls back its identity write and permits a fresh proof retry', async () => {
    const before = await fixture.models.User.findById(entry.user._id);
    const form = entry.page.locator('form[action="/account/mfa/step-up"]');
    await prepareProof(form);
    const auditsBefore = await fixture.models.AuditLog.countDocuments({ actorId: entry.user._id, action: 'account.mfa_step_up' });
    const originalInsert = fixture.models.AuditLog.collection.insertOne;
    fixture.models.AuditLog.collection.insertOne = async function (document, ...args) {
      if (document.action === 'account.mfa_step_up' && String(document.actorId) === String(entry.user._id)) throw new Error('Owned fixture step-up audit failure');
      return originalInsert.call(this, document, ...args);
    };
    let failed;
    try {
      const responsePromise = entry.page.waitForResponse(response => new URL(response.url()).pathname === '/account/mfa/step-up');
      await form.getByRole('button', { name: 'Confirm identity', exact: true }).click();
      failed = await responsePromise;
    } finally { fixture.models.AuditLog.collection.insertOne = originalInsert; }
    assert.equal(failed.status(), 500);
    assert.equal((await failed.json()).error.code, 'INTERNAL_ERROR');
    await form.locator('[data-passkey-status][role="alert"]').waitFor({ state: 'visible' });
    assert.equal((await fixture.models.User.findById(entry.user._id)).__v, before.__v);
    assert.equal(await fixture.models.AuditLog.countDocuments({ actorId: entry.user._id, action: 'account.mfa_step_up' }), auditsBefore);
    await Promise.all([entry.page.waitForNavigation(), form.getByRole('button', { name: 'Confirm identity', exact: true }).click()]);
    assert.equal(await fixture.models.AuditLog.countDocuments({ actorId: entry.user._id, action: 'account.mfa_step_up' }), auditsBefore + 1);
    await entry.page.goto(fixture.base + '/account/security');
  });

  await t.test('an SMS seller can really sign in with a saved recovery code, add a passkey and remove SMS', async () => {
    const sms = await fixture.actor('seller', { phoneVerified: false });
    sms.page.on('pageerror', error => errors.push(error.message));
    try {
      await fixture.signIn(sms);
      const codes = await enrollSms(sms);
      await fixture.logout(sms);
      await fixture.signIn(sms);
      assert.equal(new URL(sms.page.url()).pathname, '/mfa');
      const recovery = sms.page.locator('form[action="/mfa"]');
      await recovery.locator('input[name="code"]').fill(codes[0]);
      await Promise.all([sms.page.waitForURL(url => url.pathname === '/seller/store'), recovery.getByRole('button', { name: 'Continue securely', exact: true }).click()]);
      assert.equal(await sms.page.locator('body').getAttribute('data-dashboard-workspace'), 'seller');
      assert.equal((await fixture.models.User.findById(sms.user._id).select('+security.mfaRecoveryCodeHashes')).security.mfaRecoveryCodeHashes.length, 9);
      await sms.page.goto(fixture.base + '/account/security');
      const changed = await fixture.postJson(sms, '/account/profile', { name: sms.user.name, phone: '+256789000321', country: 'UG', currency: 'UGX', locale: 'en-UG' });
      assert.ok(changed.body.text?.includes('Remove SMS security'), 'changing a bound SMS phone must display actionable security guidance');
      assert.equal((await fixture.models.User.findById(sms.user._id)).phone, sms.user.phone);
      await sms.page.goto(fixture.base + '/account/security');
      await addVirtualPasskeyAuthenticator(sms.page);
      const added = await enrollPasskey(sms, 'Phone passkey');
      assert.ok(added);
      assert.equal(await sms.page.locator('.choice-grid code').count(), 10, 'the first strong factor replaces low-assurance recovery codes');
      const actor = await fixture.models.User.findById(sms.user._id);
      assert.equal(actor.security.mfaRecoveryStrong, true);
      assert.deepEqual([...actor.security.mfaMethods].sort(), ['passkey', 'sms']);
      const section = sms.page.locator('details').filter({ has: sms.page.locator('summary', { hasText: 'Remove SMS security' }) });
      await section.locator('summary').click();
      const form = section.locator('form[action="/account/mfa/sms/remove"]');
      await prepareProof(form);
      const dialog = await openConfirmation(sms, form.getByRole('button', { name: 'Remove SMS security', exact: true }));
      await confirmAndNavigate(sms, dialog);
      const updated = await fixture.models.User.findById(sms.user._id).select('+security.mfaSmsPhoneHash');
      assert.deepEqual([...updated.security.mfaMethods], ['passkey']);
      assert.equal(updated.security.mfaEnabled, true);
      assert.equal(updated.security.mfaSmsPhoneHash, undefined);
      assert.ok(updated.phoneVerifiedAt, 'removing the SMS factor does not falsify the previously verified phone');
      assert.equal(await fixture.models.AuditLog.countDocuments({ actorId: sms.user._id, action: 'account.sms_mfa_removed' }), 1);
    } finally { await sms.context.close(); }
  });

  await t.test('a customer can disable optional SMS MFA only after confirmation and a one-time recovery proof', async () => {
    const customer = await fixture.actor('customer', { phoneVerified: false });
    customer.page.on('pageerror', error => errors.push(error.message));
    try {
      await fixture.signIn(customer, '/account/security');
      const codes = await enrollSms(customer);
      await customer.page.locator('details.mfa-method-section > summary').click();
      const form = customer.page.locator('form[action="/account/mfa/disable"]');
      await prepareProof(form, 'recovery', codes[0]);
      const button = form.getByRole('button', { name: 'Disable MFA', exact: true });
      let dialog = await openConfirmation(customer, button);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal((await fixture.models.User.findById(customer.user._id)).security.mfaEnabled, true);
      dialog = await openConfirmation(customer, button);
      await confirmAndNavigate(customer, dialog);
      const actor = await fixture.models.User.findById(customer.user._id).select('+security.mfaSmsPhoneHash +security.mfaRecoveryCodeHashes');
      assert.equal(actor.security.mfaEnabled, false);
      assert.equal(actor.security.mfaSmsPhoneHash, undefined);
      assert.equal(actor.security.mfaRecoveryCodeHashes, undefined);
      assert.equal(await fixture.models.AuditLog.countDocuments({ actorId: customer.user._id, action: 'account.mfa_disabled' }), 1);
    } finally { await customer.context.close(); }
  });

  await t.test('unexpected transactional audit failure returns a real 500 and rolls back enrollment for a later retry', async () => {
    const failed = await fixture.actor('seller', { phoneVerified: false });
    try {
      await fixture.signIn(failed);
      const prepared = await fixture.postJson(failed, '/account/mfa/sms/begin', { currentPassword: fixture.password });
      assert.equal(prepared.status, 200);
      const code = fixture.messages.filter(message => message.phone === failed.user.phone.slice(1)).at(-1).code;
      const originalInsert = fixture.models.AuditLog.collection.insertOne;
      fixture.models.AuditLog.collection.insertOne = async function (document, ...args) {
        if (document.action === 'account.mfa_method_added' && String(document.actorId) === String(failed.user._id)) throw new Error('Owned fixture transactional audit failure');
        return originalInsert.call(this, document, ...args);
      };
      let failure;
      try { failure = await fixture.postJson(failed, '/account/mfa/sms/confirm', { challengeId: prepared.body.challengeId, code }); }
      finally { fixture.models.AuditLog.collection.insertOne = originalInsert; }
      assert.equal(failure.status, 500);
      assert.equal(failure.body.error.code, 'INTERNAL_ERROR');
      assert.ok(failure.body.error.requestId);
      assert.equal((await fixture.models.User.findById(failed.user._id)).security.mfaEnabled, false);
      assert.equal((await fixture.models.MfaChallenge.findOne({ publicId: prepared.body.challengeId })).consumedAt, undefined);
      assert.equal(await fixture.models.AuditLog.countDocuments({ actorId: failed.user._id, action: 'account.mfa_method_added' }), 0);
      const retry = await fixture.postJson(failed, '/account/mfa/sms/confirm', { challengeId: prepared.body.challengeId, code });
      assert.equal(retry.status, 200);
      assert.equal((await fixture.models.User.findById(failed.user._id)).security.mfaEnabled, true);
    } finally { await failed.context.close(); }
  });
  assert.deepEqual(errors, []);
});

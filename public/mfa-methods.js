(() => {
  'use strict';
  if (window.ClassicMartMfaMethods) return;
  const supported = Boolean(window.isSecureContext && window.PublicKeyCredential && navigator.credentials);
  const pending = new WeakSet();

  function decode(value) {
    const binary = atob(String(value).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  }
  function encode(value) {
    const bytes = new Uint8Array(value);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function optionsFromJson(options, registration) {
    const parser = registration ? PublicKeyCredential.parseCreationOptionsFromJSON : PublicKeyCredential.parseRequestOptionsFromJSON;
    if (typeof parser === 'function') return parser.call(PublicKeyCredential, options);
    const result = JSON.parse(JSON.stringify(options));
    result.challenge = decode(result.challenge);
    if (registration) result.user.id = decode(result.user.id);
    for (const entry of result.allowCredentials || result.excludeCredentials || []) entry.id = decode(entry.id);
    return result;
  }
  function serialize(credential) {
    if (!credential) throw new Error('No passkey confirmation was returned.');
    if (typeof credential.toJSON === 'function') return credential.toJSON();
    const response = { clientDataJSON: encode(credential.response.clientDataJSON) };
    for (const key of ['attestationObject', 'authenticatorData', 'signature', 'userHandle']) {
      if (credential.response[key]) response[key] = encode(credential.response[key]);
    }
    if (credential.response.getTransports) response.transports = credential.response.getTransports();
    return { id: credential.id, rawId: encode(credential.rawId), type: credential.type, response,
      clientExtensionResults: credential.getClientExtensionResults(), authenticatorAttachment: credential.authenticatorAttachment || undefined };
  }
  function fields(form) {
    return Object.fromEntries([...new FormData(form)].filter(([, value]) => typeof value === 'string'));
  }
  function status(form, message, error = false) {
    const element = form.querySelector('[data-passkey-status]');
    if (!element) return;
    element.hidden = !message;
    element.setAttribute('role', error ? 'alert' : 'status');
    element.textContent = message;
  }
  function friendly(error) {
    if (['NotAllowedError', 'AbortError'].includes(error.name)) return 'Passkey verification was cancelled or timed out. Try again or use another security method.';
    if (error.name === 'InvalidStateError') return 'This passkey is already registered. Use it to sign in or choose another passkey.';
    if (error.name === 'SecurityError') return 'Open the configured secure Classic Mart website address to use a passkey.';
    if (error.name === 'NotSupportedError') return 'This device or browser cannot use this passkey. Choose another security method.';
    return error.message || 'Security verification failed. Please try again.';
  }
  async function post(url, body) {
    const target = new URL(url, location.href);
    if (target.origin !== location.origin) throw new Error('This security request must stay on Classic Mart.');
    const response = await fetch(target, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(30_000), headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': body._csrf || '' }, body: JSON.stringify(body) });
    let result;
    try { result = await response.json(); } catch { throw new Error('Security verification could not be confirmed. Refresh the page and try again.'); }
    if (!response.ok || result.error) throw new Error(result.error?.message || 'Security verification failed. Please try again.');
    return result;
  }
  function redirect(result) {
    const destination = new URL(result.redirect || '/account/security', location.origin);
    if (destination.origin !== location.origin) throw new Error('The security destination is invalid.');
    location.assign(destination.href);
  }
  async function run(form, work) {
    if (pending.has(form)) return;
    pending.add(form);
    const buttons = [...form.querySelectorAll('button')].map(button => [button, button.disabled]);
    for (const [button] of buttons) button.disabled = true;
    form.setAttribute('aria-busy', 'true');
    status(form, 'Waiting for security verification…');
    try { await work(); }
    catch (error) { status(form, friendly(error), true); }
    finally {
      pending.delete(form); form.removeAttribute('aria-busy');
      for (const [button, disabled] of buttons) if (button.isConnected) button.disabled = disabled;
    }
  }
  function updateProof(form) {
    const method = form.querySelector('[data-mfa-method]')?.value;
    const input = form.querySelector('input[name="code"]');
    if (input) { input.required = method !== 'passkey'; input.disabled = method === 'passkey'; input.inputMode = method === 'recovery' ? 'text' : 'numeric'; }
    const field = form.querySelector('[data-mfa-code-field]');
    if (field) field.hidden = method === 'passkey';
    const send = form.querySelector('[data-mfa-sms-send]');
    if (send) send.hidden = method !== 'sms';
  }
  function initialize(root = document) {
    for (const button of root.querySelectorAll('[data-passkey-enroll], [data-passkey-login]')) {
      button.disabled = !supported;
      if (!supported) status(button.closest('form'), 'Passkeys need a supported browser on HTTPS or localhost. You can use another security method.');
    }
    for (const form of root.querySelectorAll('[data-mfa-proof-form]')) updateProof(form);
  }
  document.addEventListener('change', event => { if (event.target.matches('[data-mfa-method]')) updateProof(event.target.closest('form')); });
  document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || event.defaultPrevented) return;
    if (form.matches('[data-passkey-enrollment]')) {
      event.preventDefault();
      if (!supported) return status(form, 'This browser cannot use passkeys. Choose another security method.', true);
      void run(form, async () => {
        const body = fields(form);
        const prepared = await post('/account/mfa/passkeys/options', body);
        const credential = await navigator.credentials.create({ publicKey: optionsFromJson(prepared.options, true), signal: AbortSignal.timeout(65_000) });
        redirect(await post('/account/mfa/passkeys/confirm', { ...body, challengeId: prepared.challengeId, credential: serialize(credential) }));
      });
    } else if (form.matches('[data-passkey-login-form]')) {
      event.preventDefault();
      if (!supported) return status(form, 'This browser cannot use passkeys. Choose another security method.', true);
      void run(form, async () => {
        const body = fields(form), prepared = await post('/mfa/passkey/options', body);
        const credential = await navigator.credentials.get({ publicKey: optionsFromJson(prepared.options, false), signal: AbortSignal.timeout(65_000) });
        redirect(await post('/mfa/passkey/verify', { ...body, challengeId: prepared.challengeId, credential: serialize(credential) }));
      });
    } else if (form.matches('[data-mfa-proof-form]')) {
      const sender = event.submitter?.matches('[data-mfa-sms-send]');
      const method = form.querySelector('[data-mfa-method]')?.value;
      if (!sender && method !== 'passkey') return;
      event.preventDefault();
      void run(form, async () => {
        const body = fields(form);
        if (sender) {
          const result = await post('/account/mfa/sms/send', body);
          form.querySelector('input[name="challengeId"]').value = result.challengeId;
          status(form, result.developmentCode ? `Development code: ${result.developmentCode}. No SMS was sent.` : 'Your SMS was accepted for sending. Enter its security code below.');
          return;
        }
        if (!supported) throw new Error('This browser cannot use passkeys. Choose another security method.');
        const prepared = await post('/account/mfa/passkeys/authentication/options', body);
        const credential = await navigator.credentials.get({ publicKey: optionsFromJson(prepared.options, false), signal: AbortSignal.timeout(65_000) });
        redirect(await post(form.getAttribute('action') || location.href, { ...body, challengeId: prepared.challengeId, credential: serialize(credential) }));
      });
    }
  });
  window.ClassicMartMfaMethods = Object.freeze({ initialize });
  document.addEventListener('classicmart:content-ready', event => initialize(event.detail?.root || event.target));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => initialize(), { once: true });
  else initialize();
})();

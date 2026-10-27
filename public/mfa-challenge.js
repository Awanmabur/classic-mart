(() => {
  const field = document.querySelector('#mfaCode');
  const help = document.querySelector('#mfaCodeHelp');
  const toggle = document.querySelector('[data-mfa-recovery-toggle]');
  if (!field || !help || !toggle || field.hasAttribute('data-mfa-recovery-only')) return;

  toggle.hidden = false;
  toggle.addEventListener('click', () => {
    const recovery = toggle.getAttribute('aria-pressed') !== 'true';
    toggle.setAttribute('aria-pressed', String(recovery));
    toggle.textContent = recovery ? 'Use an authenticator code instead' : 'Use a recovery code instead';
    field.inputMode = recovery ? 'text' : 'numeric';
    help.textContent = recovery
      ? 'Enter one unused recovery code you saved when setting up your authenticator. Each recovery code works only once.'
      : 'Codes usually refresh every 30 seconds. If a code has just expired, wait for the next one.';
    field.focus();
  });
})();

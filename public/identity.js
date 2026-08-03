(() => {
  'use strict';

  document.querySelectorAll('[data-password-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = document.getElementById(button.dataset.passwordToggle);
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  });

  const confirmPairs = [
    ['signUpPassword', 'signUpConfirmPassword'],
    ['resetNewPassword', 'resetConfirmPassword'],
    ['newPassword', 'confirmNewPassword'],
  ];
  confirmPairs.forEach(([passwordId, confirmationId]) => {
    const password = document.getElementById(passwordId);
    const confirmation = document.getElementById(confirmationId);
    if (!password || !confirmation) return;
    const validate = () =>
      confirmation.setCustomValidity(
        confirmation.value && password.value !== confirmation.value
          ? 'Passwords do not match.'
          : '',
      );
    password.addEventListener('input', validate);
    confirmation.addEventListener('input', validate);
  });
})();

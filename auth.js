(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);

  const signupRole = new URLSearchParams(window.location.search).get('role');
  if (signupRole === 'seller') {
    document.body.classList.add('seller-signup-mode');
    const title = document.querySelector('.auth-form-card h1');
    const intro = document.querySelector('.auth-form-card > p');
    const submit = document.querySelector('#signUpForm .auth-submit');
    if (title) title.textContent = 'Create your seller account';
    if (intro) intro.textContent = 'Join Classic Mart, prepare your storefront and start listing products after account setup.';
    if (submit) submit.textContent = 'Create Seller Account';
  }


  function read(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function normalizePhone(value = '') {
    return String(value).replace(/[^\d+]/g, '').replace(/^00/, '+');
  }

  function showMessage(message, isError = false) {
    const target = $('#authMessage');
    if (!target) return;
    target.textContent = message;
    target.classList.add('show');
    target.classList.toggle('error', isError);
  }

  function showToast(message) {
    const toast = $('#pageToast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2400);
  }

  document.querySelectorAll('[data-password-toggle]').forEach(button => {
    button.addEventListener('click', () => {
      const input = document.getElementById(button.dataset.passwordToggle);
      if (!input) return;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      button.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    });
  });

  $('[data-demo-account]')?.addEventListener('click', () => {
    const identity = $('#signInIdentity');
    if (identity) identity.value = 'demo@classicmart.test';
    $('#signInPassword').value = 'demo123';
    showMessage('Demo account filled. Select Sign In to continue. You can also use +256700000000.');
  });

  document.querySelectorAll('[data-social-login]').forEach(button => {
    button.addEventListener('click', () => showToast(`${button.dataset.socialLogin} sign-in needs a connected authentication backend.`));
  });

  $('#signInForm')?.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;

    const identity = $('#signInIdentity').value.trim();
    const identityEmail = identity.toLowerCase();
    const identityPhone = normalizePhone(identity);
    const password = $('#signInPassword').value;
    const storedUser = read('classic-mart-user', null);
    const isDemoIdentity = identityEmail === 'demo@classicmart.test' || identityPhone === '+256700000000' || identityPhone === '256700000000';
    const isDemo = isDemoIdentity && password === 'demo123';
    const isStoredUser = storedUser && (
      storedUser.email?.toLowerCase() === identityEmail ||
      normalizePhone(storedUser.phone) === identityPhone
    ) && storedUser.password === password;

    if (!isDemo && !isStoredUser) {
      showMessage('The email, phone number or password is incorrect. Use the demo account or create a new account.', true);
      return;
    }

    const session = isDemo
      ? { name: 'Demo Shopper', email: 'demo@classicmart.test', phone: '+256700000000', signedInAt: new Date().toISOString() }
      : { name: storedUser.name, email: storedUser.email, phone: storedUser.phone, signedInAt: new Date().toISOString() };
    if (storedUser?.role) { session.role = storedUser.role; session.roleLabel = storedUser.roleLabel; }
    write('classic-mart-session', session);
    const destination = storedUser?.role === 'seller' ? 'seller-profile.html?owner=1' : storedUser?.role === 'promoter' ? 'promoter-profile.html?owner=1' : storedUser?.role ? 'profile.html' : 'onboarding.html';
    showMessage(`Welcome back, ${session.name}. Opening your account…`);
    setTimeout(() => { window.location.href = destination; }, 850);
  });

  $('#signUpForm')?.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;

    const password = $('#signUpPassword').value;
    const confirmPassword = $('#signUpConfirmPassword')?.value || password;
    if (password !== confirmPassword) {
      showMessage('The two passwords do not match.', true);
      $('#signUpConfirmPassword')?.focus();
      return;
    }

    const user = {
      name: $('#signUpName').value.trim(),
      email: $('#signUpEmail').value.trim().toLowerCase(),
      phone: normalizePhone($('#signUpPhone').value.trim()),
      password,
      createdAt: new Date().toISOString()
    };

    const saved = write('classic-mart-user', user);
    write('classic-mart-session', { name: user.name, email: user.email, phone: user.phone, signedInAt: new Date().toISOString() });
    if (!saved) {
      showMessage('Your browser blocked local storage. The form is valid, but the demo account could not be saved.', true);
      return;
    }

    showMessage(`Your account is ready, ${user.name}. Redirecting to Classic Mart…`);
    const nextRole = signupRole && ['seller','promoter','customer','business','delivery'].includes(signupRole) ? `?role=${encodeURIComponent(signupRole)}` : '';
    setTimeout(() => { window.location.href = `onboarding.html${nextRole}`; }, 900);
  });

  $('#forgotPasswordForm')?.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const identity = $('#recoveryIdentity').value.trim();
    const storedUser = read('classic-mart-user', null);
    const matchesStored = storedUser && (
      storedUser.email?.toLowerCase() === identity.toLowerCase() ||
      normalizePhone(storedUser.phone) === normalizePhone(identity)
    );
    const isDemo = identity.toLowerCase() === 'demo@classicmart.test' || ['+256700000000', '256700000000'].includes(normalizePhone(identity));

    write('classic-mart-reset-request', {
      identity,
      matched: Boolean(matchesStored || isDemo),
      requestedAt: new Date().toISOString(),
      demoCode: '123456'
    });
    showMessage('Reset request prepared. Use demo verification code 123456 on the next screen.');
    setTimeout(() => { window.location.href = 'reset-password.html'; }, 850);
  });

  const resetRequest = read('classic-mart-reset-request', null);
  if ($('#resetIdentityText') && resetRequest?.identity) {
    $('#resetIdentityText').textContent = `Enter the verification code sent to ${resetRequest.identity}, then choose a new password.`;
  }

  $('#resetPasswordForm')?.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;

    const code = $('#resetCode').value.trim();
    const password = $('#resetNewPassword').value;
    const confirm = $('#resetConfirmPassword').value;
    if (code !== '123456') {
      showMessage('The verification code is incorrect. Use 123456 for this front-end demo.', true);
      return;
    }
    if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}/.test(password)) {
      showMessage('Use at least 8 characters with uppercase, lowercase and a number.', true);
      return;
    }
    if (password !== confirm) {
      showMessage('The two passwords do not match.', true);
      return;
    }

    const storedUser = read('classic-mart-user', null);
    if (storedUser) {
      storedUser.password = password;
      storedUser.passwordUpdatedAt = new Date().toISOString();
      write('classic-mart-user', storedUser);
    }
    localStorage.removeItem('classic-mart-reset-request');
    showMessage('Your password has been updated. Redirecting to sign in…');
    setTimeout(() => { window.location.href = 'login.html'; }, 900);
  });
})();

(() => {
  'use strict';

  let csrfToken = '';
  async function token() {
    if (csrfToken) return csrfToken;
    const response = await fetch('/api/v1/storefront/action-token', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.csrfToken) throw new Error(payload.error?.message || 'Subscription could not be started.');
    csrfToken = payload.csrfToken;
    return csrfToken;
  }

  document.querySelectorAll('#newsletterForm, [data-newsletter-form]').forEach((form) => {
    const status = form.querySelector('[data-newsletter-status]');
    const button = form.querySelector('button[type="submit"]');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const email = String(new FormData(form).get('email') || '').trim();
      status?.classList.remove('is-error');
      if (!/^\S+@\S+\.\S+$/.test(email)) {
        if (status) { status.textContent = 'Enter a valid email address.'; status.classList.add('is-error'); }
        form.querySelector('input[type="email"]')?.focus();
        return;
      }
      const original = button?.textContent || 'Subscribe';
      if (button) { button.disabled = true; button.textContent = 'Subscribing…'; }
      try {
        const response = await fetch('/api/v1/newsletter/subscribe', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            'content-type': 'application/json',
            'x-csrf-token': await token(),
          },
          body: JSON.stringify({ email }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error?.message || 'Subscription failed.');
        if (status) status.textContent = payload.message || 'You are subscribed.';
        form.reset();
      } catch (error) {
        if (status) { status.textContent = error.message || 'Subscription failed.'; status.classList.add('is-error'); }
      } finally {
        if (button) { button.disabled = false; button.textContent = original; }
      }
    });
  });
})();

(() => {
  'use strict';
  if (window.ClassicMartSharing) return;

  let pending = false;
  let operation = 0;
  const query = selector => document.querySelector(selector);
  const notify = message => window.ClassicMartFlash?.show(message);

  function productUrl(id) {
    const identifier = String(id || '');
    if (!/^[A-Za-z0-9_-]{1,180}$/.test(identifier)) return '';
    const url = new URL(`/products/${encodeURIComponent(identifier)}`, window.location.origin);
    const country = query('#productModal')?.dataset.shareCountry;
    if (/^[A-Z]{2}$/.test(country || '')) url.searchParams.set('country', country);
    return url.href;
  }

  function closeFallback({ returnFocus = false, preserveRequest = false } = {}) {
    if (!preserveRequest) operation += 1;
    const panel = query('#productShareFallback');
    if (panel) panel.hidden = true;
    const button = query('#productModalShare');
    button?.setAttribute('aria-expanded', 'false');
    if (returnFocus && button && !button.closest('[hidden], [inert]')) button.focus();
  }

  function showFallback(url) {
    const panel = query('#productShareFallback'), input = query('#productShareLink');
    if (!panel || !input) return false;
    input.value = url;
    panel.hidden = false;
    query('#productModalShare')?.setAttribute('aria-expanded', 'true');
    input.focus();
    input.select();
    return true;
  }

  async function copyLink(url, isCurrent = () => true) {
    try {
      if (window.isSecureContext && typeof navigator.clipboard?.writeText === 'function') {
        await navigator.clipboard.writeText(url);
        return true;
      }
    } catch { /* Permission denial falls back to a selectable local link. */ }

    // A permission prompt can outlive its preview. Do not select or copy an old
    // product into a newly opened dialog after that asynchronous prompt ends.
    if (!isCurrent()) return false;
    const input = document.createElement('textarea');
    input.value = url;
    input.setAttribute('readonly', '');
    input.setAttribute('aria-label', 'Product link');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    const owner = query('#productModal:not([hidden])') || document.body;
    owner.append(input);
    input.select();
    input.setSelectionRange(0, input.value.length);
    let copied = false;
    try { copied = document.execCommand('copy') === true; } catch { /* Manual copy remains available. */ }
    input.remove();
    return copied;
  }

  async function shareProduct(button) {
    if (!button || button.disabled || pending) return 'unavailable';
    const url = productUrl(button.dataset.shareProduct);
    if (!url) return 'unavailable';
    const title = String(button.dataset.shareTitle || 'Classic Mart product');
    const data = { title, text: `Take a look at ${title} on Classic Mart.`, url };
    const hadFocus = document.activeElement === button;
    pending = true;
    button.disabled = true;
    closeFallback({ preserveRequest: true });
    const request = ++operation;
    try {
      // Invoke the platform share sheet directly during the user's click. No
      // API fetch or artificial menu consumes the browser's user activation.
      if (window.isSecureContext && typeof navigator.share === 'function') {
        try {
          await navigator.share(data);
          return 'shared';
        } catch (error) {
          if (error?.name === 'AbortError') return 'cancelled';
        }
      }
      if (request !== operation) return 'cancelled';
      const copied = await copyLink(url, () => request === operation);
      if (request !== operation) return 'cancelled';
      if (copied) {
        notify('Product link copied. Paste it into the app you want to share with.');
        return 'copied';
      }
      if (showFallback(url)) return 'manual';
      notify(`Copy this product link: ${url}`);
      return 'manual';
    } finally {
      pending = false;
      if (request === operation) {
        button.disabled = false;
        if (hadFocus && document.activeElement === document.body && !button.closest('[hidden], [inert]')) button.focus();
      }
    }
  }

  document.addEventListener('click', async event => {
    if (query('#productShareFallback')?.hidden === false && !event.target.closest('#productShareFallback, #productModalShare')) closeFallback();
    if (event.target.closest('[data-close-product-share]')) {
      closeFallback({ returnFocus: true });
      return;
    }
    if (!event.target.closest('[data-copy-share-link]')) return;
    const input = query('#productShareLink');
    const panel = query('#productShareFallback');
    if (!input?.value || !panel || panel.hidden) return;
    const request = operation;
    const url = input.value;
    const isCurrent = () => request === operation && !panel.hidden && input.value === url;
    const copied = await copyLink(url, isCurrent);
    if (!isCurrent()) return;
    if (copied) {
      closeFallback({ returnFocus: true });
      notify('Product link copied. Paste it into the app you want to share with.');
    } else {
      input.focus(); input.select();
      notify('Select the product link and copy it with your browser or keyboard.');
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || query('#productShareFallback')?.hidden !== false) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeFallback({ returnFocus: true });
  });

  window.ClassicMartSharing = Object.freeze({ productUrl, shareProduct, closeFallback });
})();

(() => {
  'use strict';
  if (window.ClassicMartFlash) return;

  let container;
  let content;
  let timer;
  let dialogHost = null;
  const toastSelector = '#toast, #catalogToast, #pageToast, .page-toast, [data-platform-flash-toast]';

  function dismiss() {
    clearTimeout(timer);
    if (!container) return;
    container.classList.remove('show');
    container.hidden = true;
  }

  function ensureContainer() {
    const parent = dialogHost?.isConnected && dialogHost.open ? dialogHost : document.body;
    if (container?.isConnected) {
      document.querySelectorAll(toastSelector).forEach(item => {
        if (item !== container) item.remove();
      });
      // Native modal dialogs make body siblings inert in the browser's top
      // layer. Their untransformed host keeps this same viewport-fixed surface
      // visible and operable; ordinary cards still cannot capture or clip it.
      if (container.parentElement !== parent) parent.append(container);
      return container;
    }
    container = document.querySelector(toastSelector) || document.createElement('div');
    document.querySelectorAll(toastSelector).forEach(item => {
      if (item !== container) item.remove();
    });
    container.className = 'platform-flash platform-flash-toast';
    container.dataset.platformFlashToast = '';
    container.hidden = true;
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-atomic', 'true');
    content = document.createElement('span');
    content.className = 'platform-flash-content';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'platform-flash-close';
    close.setAttribute('aria-label', 'Dismiss message');
    close.textContent = '×';
    close.addEventListener('click', dismiss);
    container.replaceChildren(content, close);
    container.addEventListener('pointerenter', () => clearTimeout(timer));
    container.addEventListener('focusin', () => clearTimeout(timer));
    // A message stays available while it is being read or its close button is
    // focused. It never steals keyboard focus from the action that triggered it.
    if (container.parentElement !== parent) parent.append(container);
    return container;
  }

  function show(message, { type = 'success', duration = 6000 } = {}) {
    const text = String(message ?? '').trim();
    if (!text) return;
    const target = ensureContainer();
    clearTimeout(timer);
    target.dataset.flashType = type === 'error' ? 'error' : 'success';
    target.setAttribute('role', type === 'error' ? 'alert' : 'status');
    target.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    // Provider/API messages are text, never HTML.
    target.hidden = false;
    content.textContent = text;
    target.classList.add('show');
    const lifetime = Number(duration);
    if (Number.isFinite(lifetime) && lifetime > 0) timer = setTimeout(dismiss, Math.max(1000, lifetime));
    return target;
  }

  function setDialogHost(dialog) {
    dialogHost = typeof HTMLDialogElement !== 'undefined' && dialog instanceof HTMLDialogElement && dialog.open ? dialog : null;
    ensureContainer();
  }

  window.ClassicMartFlash = Object.freeze({ show, dismiss, setDialogHost });
  window.addEventListener('pagehide', dismiss);
  const initialize = () => {
    if (document.querySelector(toastSelector)) ensureContainer();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();

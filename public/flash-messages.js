(() => {
  'use strict';
  if (window.ClassicMartFlash) return;

  const lifetime = 5000;
  const notices = new WeakMap();
  const active = new Set();
  const toastSelector = '#toast, #catalogToast, #pageToast, .page-toast, [data-platform-flash-toast]';
  const persistentSelector = '[data-flash-persistent], [role="note"], [data-seller-verification-notice]';
  let container;
  let content;
  let dialogHost = null;

  function stop(state) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }

  function dismissNotice(element) {
    const state = notices.get(element);
    const restoreFocus = element.contains(document.activeElement) ? state?.restoreFocus : null;
    if (state) {
      stop(state);
      state.dismissed = true;
    }
    active.delete(element);
    element.classList.remove('show');
    if (!element.hidden) element.hidden = true;
    if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
  }

  function resume(state) {
    if (state.element.hidden || !state.element.isConnected || state.hovered || state.focused || state.timer !== undefined) return;
    state.deadline = performance.now() + state.remaining;
    state.timer = setTimeout(() => dismissNotice(state.element), state.remaining);
  }

  function pause(state) {
    if (state.timer === undefined) return;
    state.remaining = Math.max(0, state.deadline - performance.now());
    stop(state);
  }

  function noticeState(element) {
    let state = notices.get(element);
    if (state) return state;
    state = { element, remaining: lifetime, hovered: false, focused: false, dismissed: false, lastMessage: '' };
    notices.set(element, state);
    element.addEventListener('pointerenter', () => { state.hovered = true; pause(state); });
    element.addEventListener('pointerleave', () => { state.hovered = false; resume(state); });
    element.addEventListener('focusin', event => {
      if (event.relatedTarget instanceof HTMLElement && !element.contains(event.relatedTarget)) state.restoreFocus = event.relatedTarget;
      state.focused = true;
      pause(state);
    });
    element.addEventListener('focusout', event => {
      if (event.relatedTarget && element.contains(event.relatedTarget)) return;
      state.focused = false;
      resume(state);
    });
    return state;
  }

  function present(state) {
    stop(state);
    state.remaining = lifetime;
    state.dismissed = false;
    state.focused = state.element.contains(document.activeElement);
    if (!state.focused && document.activeElement instanceof HTMLElement) state.restoreFocus = document.activeElement;
    state.element.hidden = false;
    active.add(state.element);
    resume(state);
  }

  function closeButton(element) {
    const close = document.createElement('button');
    close.type = 'button';
    // round-small also excludes this icon control from the dashboard's pill
    // button rules. Its geometry is owned by the shared flash stylesheet.
    close.className = 'platform-flash-close round-small';
    close.setAttribute('aria-label', 'Dismiss message');
    close.textContent = '×';
    close.addEventListener('click', () => dismissNotice(element));
    return close;
  }

  function dismiss() {
    if (container) dismissNotice(container);
  }

  function ensureContainer() {
    const parent = dialogHost?.isConnected && dialogHost.open ? dialogHost : document.body;
    if (container?.isConnected) {
      document.querySelectorAll(toastSelector).forEach(item => { if (item !== container) item.remove(); });
      // Native modal dialogs make body siblings inert in the browser's top
      // layer. Keep this same viewport-fixed surface in their active host.
      if (container.parentElement !== parent) parent.append(container);
      return container;
    }
    container = document.querySelector(toastSelector) || document.createElement('div');
    document.querySelectorAll(toastSelector).forEach(item => { if (item !== container) item.remove(); });
    container.className = 'platform-flash platform-flash-toast';
    container.dataset.platformFlashToast = '';
    container.hidden = true;
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-atomic', 'true');
    content = document.createElement('span');
    content.className = 'platform-flash-content';
    container.replaceChildren(content, closeButton(container));
    noticeState(container);
    if (container.parentElement !== parent) parent.append(container);
    return container;
  }

  function show(message, { type = 'success' } = {}) {
    const text = String(message ?? '').trim();
    if (!text) return;
    const target = ensureContainer();
    target.dataset.flashType = type === 'error' ? 'error' : 'success';
    target.setAttribute('role', type === 'error' ? 'alert' : 'status');
    target.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    // Provider/API messages are text, never HTML. All transient flashes share
    // five seconds of reading time; a caller cannot leave one up indefinitely.
    content.textContent = text;
    target.classList.add('show');
    present(noticeState(target));
    return target;
  }

  function manageInline(element) {
    if (!element.isConnected || element.matches(toastSelector) || element.matches(persistentSelector)) return;
    const first = !notices.has(element);
    const state = noticeState(element);
    const originallyHidden = element.hidden;
    const rebuilt = state.content?.parentElement !== element || state.close?.parentElement !== element;
    if (rebuilt) {
      const children = Array.from(element.childNodes).filter(child => !child.classList?.contains('platform-flash-close'));
      state.content = document.createElement('span');
      state.content.className = 'platform-flash-content';
      state.content.append(...children);
      state.close = closeButton(element);
      element.replaceChildren(state.content, state.close);
      element.dataset.platformFlashInline = '';
      element.setAttribute('aria-atomic', 'true');
    }
    const text = state.content.textContent.trim();
    const changed = rebuilt || state.lastMessage !== text;
    state.lastMessage = text;
    if (!text) { dismissNotice(element); return; }
    // Preserve deliberately hidden initial content. Later text changes can
    // reveal an empty/expired status region used by an existing page script.
    if (first && originallyHidden) { state.dismissed = true; return; }
    if (changed || !element.hidden && state.dismissed) present(state);
    else if (element.hidden) { stop(state); active.delete(element); }
  }

  function setDialogHost(dialog) {
    dialogHost = typeof HTMLDialogElement !== 'undefined' && dialog instanceof HTMLDialogElement && dialog.open ? dialog : null;
    ensureContainer();
  }

  window.ClassicMartFlash = Object.freeze({ show, dismiss, setDialogHost });
  window.addEventListener('pagehide', () => { for (const element of active) dismissNotice(element); });
  const initialize = () => {
    if (document.querySelector(toastSelector)) ensureContainer();
    document.querySelectorAll('.platform-flash').forEach(manageInline);
    // Hydrate server fragments and existing status regions without polling or
    // rescanning the entire page for unrelated DOM updates.
    new MutationObserver(records => {
      const changed = new Set();
      for (const record of records) {
        const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        const enclosing = target?.closest('.platform-flash');
        if (enclosing) changed.add(enclosing);
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.matches('.platform-flash')) changed.add(node);
          node.querySelectorAll('.platform-flash').forEach(element => changed.add(element));
        }
      }
      changed.forEach(manageInline);
      for (const element of active) {
        if (!element.isConnected) { stop(notices.get(element)); active.delete(element); }
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();

(() => {
  'use strict';
  if (window.ClassicMartDialogIsolation) return;

  const flashSelector = '[data-platform-flash-toast], #toast, #catalogToast, #pageToast, .page-toast';
  const focusableSelector = 'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  let active = null;
  let suspended = null;

  function setInert(element, value) {
    if (element.hasAttribute('inert') === value) return;
    if (!active.original.has(element)) active.original.set(element, element.getAttribute('inert'));
    if (value) element.setAttribute('inert', '');
    else element.removeAttribute('inert');
  }

  function refresh() {
    if (!active) return;
    const allowed = new Set([active.dialog, ...active.backdrops,
      ...document.querySelectorAll(flashSelector)].filter(element => element?.isConnected));
    const ancestors = new Set();
    for (const element of allowed) {
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) ancestors.add(parent);
    }
    active.allowed = allowed;
    active.ancestors = ancestors;
    const visit = element => {
      if (allowed.has(element)) { setInert(element, false); return; }
      if (ancestors.has(element)) {
        setInert(element, false);
        for (const child of element.children) visit(child);
      } else setInert(element, true);
    };
    for (const element of document.body.children) visit(element);
  }

  function ensureDialogFocus() {
    if (!active || active.dialog.hidden || active.dialog.inert) return;
    const focused = document.activeElement;
    if ([...active.allowed].some(element => element.contains(focused))) return;
    const first = [...active.dialog.querySelectorAll(focusableSelector)]
      .find(element => !element.closest('[hidden], [inert]') && element.getClientRects().length);
    first?.focus({ preventScroll: true });
  }

  function release(dialog) {
    if (!active || (dialog && active.dialog !== dialog)) return;
    active.observer.disconnect();
    const original = active.original;
    active = null;
    // Restore exact author states before callers return focus to an opener.
    for (const [element, value] of original) {
      if (value === null) element.removeAttribute('inert');
      else element.setAttribute('inert', value);
    }
  }

  function activate(dialog, backdrops = []) {
    if (!dialog?.isConnected) return;
    if (active?.dialog === dialog) {
      active.backdrops = backdrops;
      refresh();
      ensureDialogFocus();
      return;
    }
    release();
    const observer = new MutationObserver(records => {
      if (!active) return;
      // Text changes and ordinary rendering inside already inert branches need
      // no work. Observe new sibling branches or newly created shared flashes.
      const relevant = records.some(record => record.target === document.body || active.ancestors.has(record.target)
        || [...record.addedNodes].some(node => node.nodeType === 1
          && (node.matches(flashSelector) || node.querySelector(flashSelector))));
      if (relevant) refresh();
      // Replacing preview content can remove its focused control. Browsers
      // silently move focus to body in that case, without a focusin event.
      if (records.some(record => active.dialog.contains(record.target))) ensureDialogFocus();
    });
    active = { dialog, backdrops, original: new Map(), allowed: new Set(), ancestors: new Set(), observer };
    refresh();
    // Focus must enter the dialog immediately; animation timers leave a gap
    // when related-product rendering replaces the previously focused card.
    ensureDialogFocus();
    observer.observe(document.body, { childList: true, subtree: true });
  }

  document.addEventListener('focusin', event => {
    if (!active || active.dialog.contains(event.target) || event.target.closest?.(flashSelector)
      || active.backdrops.some(element => element?.contains(event.target))) return;
    ensureDialogFocus();
  }, true);

  window.addEventListener('pagehide', () => {
    suspended = active && { dialog: active.dialog, backdrops: active.backdrops };
    release();
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted && suspended?.dialog.isConnected && !suspended.dialog.hidden) activate(suspended.dialog, suspended.backdrops);
    suspended = null;
  });

  window.ClassicMartDialogIsolation = Object.freeze({ activate, release });
})();

(() => {
  if (window.ClassicMartLoading) return;

  const active = new Set();
  const submitting = new Map();
  const dialogOrder = [];
  let indicator, label, revealTimer, navigationTask, dialogHost;

  function nativeModal(element) {
    if (typeof HTMLDialogElement === 'undefined' || !(element instanceof HTMLDialogElement) || !element.isConnected || !element.open) return false;
    try { return element.matches(':modal'); } catch { return true; }
  }

  function feedbackHost() {
    for (let index = dialogOrder.length - 1; index >= 0; index--) {
      if (!dialogOrder[index].isConnected || !dialogOrder[index].open) dialogOrder.splice(index, 1);
    }
    if (dialogHost && (!dialogHost.isConnected || !dialogHost.open)) dialogHost = undefined;
    const focused = document.activeElement?.closest('dialog[open]');
    if (nativeModal(focused)) return focused;
    const known = dialogOrder.findLast(nativeModal);
    if (known) return known;
    if (nativeModal(dialogHost)) return dialogHost;
    return [...document.querySelectorAll('dialog[open]')].findLast(nativeModal) || document.body;
  }

  function mount() {
    if (!document.body) return null;
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.className = 'platform-loading';
      indicator.dataset.platformLoading = '';
      indicator.hidden = true;
      indicator.setAttribute('role', 'status');
      indicator.setAttribute('aria-live', 'polite');
      indicator.setAttribute('aria-atomic', 'true');
      const brand = document.createElement('img');
      brand.className = 'platform-loading-brand';
      brand.src = '/approved-dashboard/assets/classic-mart-icon.png';
      brand.alt = '';
      brand.width = 32;
      brand.height = 32;
      brand.decoding = 'async';
      brand.setAttribute('aria-hidden', 'true');
      const spinner = document.createElement('span');
      spinner.className = 'platform-loading-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      label = document.createElement('span');
      indicator.append(brand, spinner, label);
    }
    const parent = feedbackHost();
    if (indicator.parentElement !== parent) parent.append(indicator);
    // A previously isolated body sibling may have been marked inert before a
    // modal opened. Only restore this owned, non-interactive status surface.
    indicator.removeAttribute('inert');
    return indicator;
  }

  function render() {
    if (!active.size) {
      clearTimeout(revealTimer); revealTimer = undefined;
      if (indicator) {
        indicator.hidden = true;
        if (document.body && indicator.parentElement !== document.body) document.body.append(indicator);
        indicator.removeAttribute('inert');
      }
      return;
    }
    if (indicator) mount();
    const message = navigationTask ? 'Loading page…' : 'Working…';
    if (label) label.textContent = message;
    if (indicator && !indicator.hidden || revealTimer !== undefined) return;
    // Fast work finishes without a distracting flash or a forced minimum wait.
    revealTimer = setTimeout(() => {
      revealTimer = undefined;
      if (!active.size || !mount()) return;
      label.textContent = navigationTask ? 'Loading page…' : 'Working…';
      indicator.hidden = false;
    }, 300);
  }

  function begin() {
    const task = {};
    active.add(task); render();
    return () => { active.delete(task); render(); };
  }

  function restoreForms() {
    for (const [form, state] of submitting) {
      if (state.busy === null) form.removeAttribute('aria-busy');
      else form.setAttribute('aria-busy', state.busy);
      if (state.submitter) {
        if (state.disabled === null) state.submitter.removeAttribute('aria-disabled');
        else state.submitter.setAttribute('aria-disabled', state.disabled);
      }
    }
    submitting.clear();
  }

  function finishNavigation(task = navigationTask) {
    if (!task || task !== navigationTask) return;
    navigationTask = undefined; task(); restoreForms(); render();
  }

  function beginNavigation() {
    if (!navigationTask) { navigationTask = begin(); render(); }
    return navigationTask;
  }

  function destination(value) {
    try {
      const url = new URL(value, location.href);
      return ['http:', 'https:'].includes(url.protocol) && url.origin === location.origin && !url.username && !url.password ? url : null;
    } catch { return null; }
  }

  function changesDocument(url) {
    return url && (url.pathname !== location.pathname || url.search !== location.search);
  }

  function attachmentDestination(url) {
    // Native downloads do not expose a reliable completion/cancellation event
    // to page JavaScript. These existing export routes keep browser download UI
    // and never acquire a page-navigation lock. Other custom exports can opt out
    // with data-loading-skip without changing their authorization or response.
    return url && (/\.(?:csv|pdf)$/i.test(url.pathname) || /\/(?:download|pdf)\/?$/i.test(url.pathname));
  }

  function selfTarget(value) {
    const target = value || document.querySelector('base[target]')?.getAttribute('target');
    return !target || target.toLowerCase() === '_self';
  }

  // Run after every submit handler. AJAX handlers and confirmation dialogs keep
  // their existing cancellation, validation, FormData and requestSubmit behavior.
  window.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || event.defaultPrevented) return;
    if (submitting.has(form)) { event.preventDefault(); return; }
    queueMicrotask(() => {
      if (event.defaultPrevented || !form.isConnected || form.hasAttribute('data-loading-skip')) return;
      const submitter = event.submitter;
      const target = submitter?.getAttribute('formtarget') ?? form.getAttribute('target');
      const method = (submitter?.getAttribute('formmethod') || form.getAttribute('method') || 'get').toLowerCase();
      const url = destination(submitter?.getAttribute('formaction') || form.getAttribute('action') || location.href);
      if (!selfTarget(target) || method === 'dialog' || !url || attachmentDestination(url) || submitter?.hasAttribute('data-loading-skip')) return;
      submitting.set(form, { busy: form.getAttribute('aria-busy'), submitter,
        disabled: submitter?.getAttribute('aria-disabled') ?? null });
      // Do not disable the submitter: the browser must still submit its name/value.
      form.setAttribute('aria-busy', 'true');
      submitter?.setAttribute('aria-disabled', 'true');
      beginNavigation();
    });
  });

  window.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor || anchor.hasAttribute('download') || anchor.hasAttribute('data-loading-skip') || !selfTarget(anchor.getAttribute('target'))) return;
    const url = destination(anchor.href);
    if (!changesDocument(url) || attachmentDestination(url)) return;
    queueMicrotask(() => { if (!event.defaultPrevented) beginNavigation(); });
  });

  // Supported browsers also cover location.assign/href and native cancellation.
  // Never intercept navigation or alter the destination, history or request.
  if (window.navigation?.addEventListener) {
    window.navigation.addEventListener('navigate', event => {
      const url = destination(event.destination?.url);
      if (event.destination?.sameDocument || event.downloadRequest != null || !url || attachmentDestination(url)
        || event.sourceElement?.closest('[data-loading-skip]')) return;
      queueMicrotask(() => {
        if (event.defaultPrevented || event.signal?.aborted) return;
        const task = beginNavigation();
        event.signal?.addEventListener('abort', () => finishNavigation(task), { once: true });
      });
    });
    window.navigation.addEventListener('navigateerror', () => finishNavigation());
    window.navigation.addEventListener('navigatesuccess', () => finishNavigation());
  }

  function track(promise) {
    const finish = begin();
    return Promise.resolve(promise).then(value => { finish(); return value; }, error => { finish(); throw error; });
  }

  function trackBodyReaders(response) {
    if (!(response instanceof Response) || !Object.isExtensible(response)) return response;
    for (const name of ['json', 'text', 'arrayBuffer', 'blob', 'formData', 'bytes']) {
      const read = response[name];
      if (typeof read !== 'function') continue;
      try {
        Object.defineProperty(response, name, { configurable: true, writable: true,
          value: function () { return track(Reflect.apply(read, this, arguments)); } });
      } catch {
        // A non-extensible/custom response remains usable without enhancement.
      }
    }
    return response;
  }

  if (typeof window.fetch === 'function') {
    const originalFetch = window.fetch;
    window.fetch = function fetch(input, options) {
      // Inspect only the URL of native supported input types; never serialize
      // a request body, touch credentials, add headers, or coerce custom inputs.
      const value = typeof input === 'string' || input instanceof URL ? input
        : input instanceof Request ? input.url : null;
      if (!value || !destination(value)) return Reflect.apply(originalFetch, this, arguments);
      const promise = Reflect.apply(originalFetch, this, arguments);
      const finish = begin();
      return Promise.resolve(promise).then(response => {
        const result = trackBodyReaders(response);
        // Transfer feedback to an immediately awaited body reader without a
        // flicker. An intentionally unread/streamed response releases next task;
        // callers can use track() for their own manually streamed operation.
        setTimeout(finish, 0);
        return result;
      }, error => { finish(); throw error; });
    };
  }

  function reset() {
    finishNavigation(); active.clear(); restoreForms(); render();
  }
  window.addEventListener('pagehide', reset);
  window.addEventListener('pageshow', event => { if (event.persisted) reset(); });
  window.addEventListener('keydown', event => { if (event.key === 'Escape') finishNavigation(); });
  document.addEventListener('beforetoggle', event => {
    if (typeof HTMLDialogElement === 'undefined' || !(event.target instanceof HTMLDialogElement)) return;
    const old = dialogOrder.indexOf(event.target);
    if (old !== -1) dialogOrder.splice(old, 1);
    if (event.newState === 'open') dialogOrder.push(event.target);
    queueMicrotask(render);
  }, true);
  document.addEventListener('close', event => {
    if (typeof HTMLDialogElement === 'undefined' || !(event.target instanceof HTMLDialogElement)) return;
    const old = dialogOrder.indexOf(event.target);
    if (old !== -1) dialogOrder.splice(old, 1);
    if (dialogHost === event.target) dialogHost = undefined;
    render();
  }, true);
  window.ClassicMartLoading = Object.freeze({
    track,
    setDialogHost(dialog) { dialogHost = nativeModal(dialog) ? dialog : undefined; render(); },
    navigate(value) {
      const url = destination(value);
      if (!url) throw new TypeError('The loading navigation must stay on Classic Mart.');
      const task = changesDocument(url) && !attachmentDestination(url) ? beginNavigation() : null;
      try { location.assign(url.href); }
      catch (error) { if (task) finishNavigation(task); throw error; }
    },
  });
})();

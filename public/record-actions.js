(() => {
  'use strict';
  if (window.ClassicMartRecordActions) return;

  const svgNamespace = 'http://www.w3.org/2000/svg';
  const iconPaths = {
    view: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z'],
    edit: ['m4 16-.7 4.7L8 20l11-11-4-4L4 16Z', 'm13.5 6.5 4 4'],
    delete: ['M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5'],
    close: ['m6 6 12 12M18 6 6 18'],
  };
  const clickDeletes = '[data-remove-item], [data-remove-wishlist], [data-wishlist-remove], [data-remove-comparison], [data-cart-remove], [data-cart-clear], #clearWishlist';
  const allowedClicks = new WeakSet();
  const pendingClicks = new WeakSet();
  const allowedSubmissions = new WeakMap();
  const pendingForms = new WeakSet();
  const submittingForms = new WeakSet();
  const pendingMutations = new WeakSet();
  let preview, confirmation, confirmationResult, opener, controller, sequence = 0, historyEntry = false, restoreUrl = '';
  let controlStates = [], editableForms = [], dirty = false;

  // Named fields such as action or method shadow properties on HTML forms.
  // Read the platform accessors so those fields remain ordinary POST data.
  const formGetters = Object.fromEntries(['action', 'method', 'enctype'].map(name =>
    [name, Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, name).get]));
  const formValue = (form, name) => formGetters[name].call(form);

  function icon(name) {
    const svg = document.createElementNS(svgNamespace, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const value of iconPaths[name] || iconPaths.view) {
      const path = document.createElementNS(svgNamespace, 'path'); path.setAttribute('d', value); svg.append(path);
    }
    return svg;
  }

  function safeUrl(value, base = location.href) {
    try {
      const url = new URL(value, base);
      return url.origin === location.origin && !url.username && !url.password && !/[\\\u0000-\u001f\u007f]/.test(value) ? url : null;
    } catch { return null; }
  }

  function recordUrl(value) {
    const url = safeUrl(value);
    if (!url || !/^\/(?:seller|promoter|finance|support|moderation|admin|super|warehouse|business|delivery|orders)(?:\/|$)|^\/addresses$/.test(url.pathname)) return null;
    if (/\/(?:export|download|evidence|documents?)(?:\/|$)|\.(?:csv|pdf|zip|png|jpe?g|webp|avif)$/i.test(url.pathname)) return null;
    return url;
  }

  function control(label, className, iconName) {
    const button = document.createElement('button'); button.type = 'button'; button.className = className;
    if (iconName) button.append(icon(iconName));
    if (label) { const text = document.createElement('span'); text.textContent = label; button.append(text); }
    return button;
  }

  function focusOpener(element) {
    if (element?.isConnected && !element.closest('[hidden], [inert]')) element.focus({ preventScroll: true });
  }

  function buildPreview() {
    if (preview) return preview;
    const dialog = document.createElement('dialog'); dialog.className = 'record-modal'; dialog.hidden = true;
    dialog.setAttribute('aria-labelledby', 'classicMartRecordTitle');
    const header = document.createElement('header'); header.className = 'record-modal-header';
    const heading = document.createElement('h2'); heading.id = 'classicMartRecordTitle';
    const tools = document.createElement('div'); tools.className = 'record-modal-tools';
    const edit = control('Edit', 'soft-button record-modal-edit', 'edit'); edit.hidden = true;
    edit.addEventListener('click', () => setMode('edit'));
    const full = document.createElement('a'); full.className = 'plain-link record-modal-full-page'; full.textContent = 'Open full page';
    const close = control('', 'record-modal-close', 'close'); close.setAttribute('aria-label', 'Close record');
    close.addEventListener('click', () => closePreview());
    tools.append(edit, full, close); header.append(heading, tools);
    const content = document.createElement('div'); content.className = 'record-modal-content';
    dialog.append(header, content);
    (document.querySelector('#pageHost') || document.body).append(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); closePreview(); });
    dialog.addEventListener('click', event => { if (event.target === dialog) closePreview(); });
    preview = { dialog, heading, content, edit, full };
    return preview;
  }

  function closePreview({ fromHistory = false, restoreFocus = true, refresh = true } = {}) {
    if (!preview?.dialog.open) return;
    if (confirmation?.dialog.open && preview.dialog.contains(confirmation.source)) finishConfirmation(false);
    controller?.abort(); controller = null; sequence++;
    window.ClassicMartDialogIsolation?.release(preview.dialog);
    preview.dialog.close(); preview.dialog.hidden = true; preview.content.replaceChildren(); controlStates = []; editableForms = [];
    window.ClassicMartFlash?.setDialogHost?.(null);
    const wasHistoryEntry = historyEntry; historyEntry = false;
    if (dirty && refresh && restoreUrl) {
      if (fromHistory) location.reload();
      else location.replace(restoreUrl);
      return;
    }
    if (wasHistoryEntry && !fromHistory) history.back();
    else if (!fromHistory && restoreUrl && location.href !== restoreUrl) history.replaceState(history.state, '', restoreUrl);
    if (restoreFocus) focusOpener(opener);
  }

  function setMode(mode) {
    const editing = mode === 'edit';
    preview.dialog.dataset.recordMode = editing ? 'edit' : 'view';
    for (const { element, disabled, readOnly } of controlStates) {
      element.disabled = disabled || !editing && /^(SELECT|BUTTON)$/.test(element.tagName)
        || !editing && /^(checkbox|radio|file|submit)$/.test(element.type);
      if ('readOnly' in element) element.readOnly = readOnly || !editing;
    }
    preview.edit.hidden = editing || !editableForms.length;
    if (editing) {
      const field = editableForms.flatMap(form => [...form.elements]).find(element =>
        element.matches('input:not([type="hidden"]), select, textarea') && !element.disabled && !element.readOnly);
      field?.focus({ preventScroll: true });
      field?.scrollIntoView({ block: 'nearest' });
    }
  }

  function prepareForms(root) {
    controlStates = []; editableForms = [];
    for (const form of root.querySelectorAll('form')) {
      if (formValue(form, 'method').toLowerCase() !== 'post') continue;
      const fields = [...form.elements].filter(element => element.matches('input:not([type="hidden"]), select, textarea')
        && !element.matches(':disabled') && !element.readOnly);
      if (!fields.length) continue;
      editableForms.push(form); form.dataset.recordEditForm = '';
      for (const element of form.elements) {
        if (element.matches('input[type="hidden"]')) continue;
        controlStates.push({ element, disabled: element.disabled, readOnly: Boolean(element.readOnly) });
      }
    }
  }

  async function htmlBody(response, signal) {
    const reader = response.body?.getReader();
    if (!reader) return response.text();
    const parts = []; let length = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > 2_000_000) throw new Error('This record is too large for a preview. Open the full page.');
        parts.push(value);
      }
      const bytes = new Uint8Array(length); let position = 0;
      for (const part of parts) { bytes.set(part, position); position += part.byteLength; }
      return new TextDecoder().decode(bytes);
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  function safeContent(documentSource, url, prefix) {
    const page = documentSource.querySelector('#pageHost');
    if (!page) throw new Error('This page cannot be previewed. Open the full page.');
    let target = null;
    if (url.hash) {
      try { target = documentSource.getElementById(decodeURIComponent(url.hash.slice(1))); } catch {}
      if (target && !page.contains(target)) target = null;
    }
    const source = target || page.querySelector('[data-record-detail]') || page;
    if (source.matches('script, style, iframe, object, embed, base, meta, link, template, svg, math')) throw new Error('Open the full page to view this content.');
    const fragment = source.cloneNode(true);
    fragment.querySelectorAll('script, style, iframe, object, embed, base, meta, link, template, foreignObject, animate, animateMotion, animateTransform, set, math, audio, video, source, track').forEach(element => element.remove());
    if (source === page) {
      fragment.querySelectorAll('.role-metric-grid, .role-chart-panel, .role-activity-panel, .role-progress-card, .role-insights, .role-tip-card').forEach(element => element.remove());
      fragment.querySelectorAll('.role-table-panel').forEach(panel => { if (panel.querySelector('a.role-row-menu')) panel.remove(); });
      fragment.classList.remove('dashboard', 'page-host');
    }
    const elements = [fragment, ...fragment.querySelectorAll('*')];
    const ids = new Map(elements.filter(element => element.id).map(element => [element.id, prefix + element.id]));
    for (const element of elements) {
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase(), value = attribute.value;
        if (name.startsWith('on') || ['srcdoc', 'nonce', 'autofocus'].includes(name)) { element.removeAttribute(attribute.name); continue; }
        if (name === 'style' && /url\s*\(|expression\s*\(|@import/i.test(value)) { element.removeAttribute('style'); continue; }
        if (['action', 'formaction', 'src', 'poster'].includes(name)) {
          const resolved = safeUrl(value, url.href);
          if (!resolved) { if (name === 'action') element.remove(); else element.removeAttribute(attribute.name); }
          else element.setAttribute(attribute.name, resolved.href);
        }
        if (name === 'srcset') element.removeAttribute(attribute.name);
        if (name === 'href' || name === 'xlink:href') {
          if (value.startsWith('#')) element.setAttribute(attribute.name, ids.has(value.slice(1)) ? '#' + ids.get(value.slice(1)) : value);
          else {
            const resolved = safeUrl(value, url.href);
            if (!resolved) element.removeAttribute(attribute.name);
            else element.setAttribute(attribute.name, resolved.href);
          }
        }
        if (['for', 'list', 'form', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns'].includes(name)) {
          element.setAttribute(attribute.name, value.split(/\s+/).map(id => ids.get(id) || id).join(' '));
        }
      }
      if (element.id) element.id = ids.get(element.id);
      if (element.tagName === 'FORM') {
        const action = safeUrl(element.getAttribute('action') || url.href, url.href);
        if (!action || !['get', 'post'].includes((element.getAttribute('method') || 'get').toLowerCase())) element.remove();
        else { element.action = action.href; element.removeAttribute('target'); }
      }
      if (element.tagName === 'A' && element.target === '_blank') element.rel = 'noopener noreferrer';
    }
    return fragment;
  }

  function mount(parsed, url, mode, title, current) {
    const fragment = safeContent(parsed, url, `record-${current}-`);
    preview.heading.textContent = title || parsed.querySelector('#pageHost h1')?.textContent?.trim() || 'Record details';
    preview.content.replaceChildren(document.importNode(fragment, true));
    const flash = parsed.querySelector('.platform-flash[role="alert"], .platform-flash[role="status"]');
    if (flash && !fragment.querySelector('.platform-flash')) {
      const message = document.createElement('p'); message.className = 'platform-flash'; message.role = 'status'; message.textContent = flash.textContent.trim();
      preview.content.prepend(message);
    }
    prepareForms(preview.content); setMode(mode); enhance(preview.content);
    preview.full.href = url.href;
    document.dispatchEvent(new CustomEvent('classicmart:content-ready', { detail: { root: preview.content } }));
    if (!historyEntry) { history.pushState({ ...history.state, classicMartRecordDialog: true }, '', url.pathname + url.search + url.hash); historyEntry = true; }
    else history.replaceState({ ...history.state, classicMartRecordDialog: true }, '', url.pathname + url.search + url.hash);
    window.ClassicMartDialogIsolation?.activate(preview.dialog);
  }

  async function open(value, { trigger, mode = 'view', title = '' } = {}) {
    const url = recordUrl(value);
    if (!url || typeof HTMLDialogElement === 'undefined') return false;
    const ui = buildPreview();
    controller?.abort(); controller = new AbortController();
    const current = ++sequence, requestController = controller;
    if (!ui.dialog.open) { opener = trigger || document.activeElement; restoreUrl = location.href; dirty = false; }
    ui.heading.textContent = title || 'Record details'; ui.full.href = url.href; ui.edit.hidden = true;
    const status = document.createElement('p'); status.className = 'record-modal-status'; status.role = 'status'; status.textContent = 'Loading current record…';
    ui.content.replaceChildren(status);
    if (!ui.dialog.open) { ui.dialog.hidden = false; ui.dialog.showModal(); }
    window.ClassicMartFlash?.setDialogHost?.(ui.dialog);
    window.ClassicMartDialogIsolation?.activate(ui.dialog);
    const timer = setTimeout(() => requestController.abort(), 15_000);
    try {
      const response = await fetch(url.href.split('#')[0], { method: 'GET', mode: 'same-origin', credentials: 'same-origin', redirect: 'error',
        cache: 'no-store', headers: { Accept: 'text/html', 'X-Requested-With': 'ClassicMartRecordPreview' }, signal: requestController.signal });
      if (!response.ok) throw new Error(response.status === 403 ? 'You no longer have access to this record.' : 'This record is unavailable. Open the full page to continue.');
      if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('Use the full page to open this record.');
      const html = await htmlBody(response, requestController.signal);
      if (current !== sequence || !ui.dialog.open) return true;
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      mount(parsed, url, mode, title, current);
    } catch (error) {
      if (current !== sequence || !ui.dialog.open) return true;
      status.role = 'alert'; status.textContent = requestController.signal.aborted ? 'The preview timed out. Open the full page to try again.' : error.message;
      ui.content.replaceChildren(status);
    } finally { clearTimeout(timer); }
    return true;
  }

  function confirm({ title = 'Confirm deletion', message = 'Continue with this change?', confirmLabel = 'Continue', opener: source } = {}) {
    if (confirmationResult) return Promise.resolve(false);
    if (typeof HTMLDialogElement === 'undefined') return Promise.resolve(false);
    if (!confirmation) {
      const dialog = document.createElement('dialog'); dialog.className = 'record-confirm-modal'; dialog.hidden = true;
      dialog.setAttribute('aria-labelledby', 'classicMartConfirmTitle'); dialog.setAttribute('aria-describedby', 'classicMartConfirmMessage');
      const symbol = document.createElement('span'); symbol.className = 'record-confirm-symbol'; symbol.append(icon('delete'));
      const heading = document.createElement('h2'); heading.id = 'classicMartConfirmTitle';
      const text = document.createElement('p'); text.id = 'classicMartConfirmMessage';
      const actions = document.createElement('div'); actions.className = 'record-confirm-actions';
      const cancel = control('Cancel', 'record-confirm-cancel');
      const proceed = control('Continue', 'record-confirm-continue');
      actions.append(cancel, proceed); dialog.append(symbol, heading, text, actions); document.body.append(dialog);
      confirmation = { dialog, heading, text, cancel, proceed, source: null };
      cancel.addEventListener('click', () => finishConfirmation(false));
      proceed.addEventListener('click', () => finishConfirmation(true));
      dialog.addEventListener('cancel', event => { event.preventDefault(); finishConfirmation(false); });
      dialog.addEventListener('click', event => { if (event.target === dialog) finishConfirmation(false); });
    }
    confirmation.source = source || document.activeElement;
    confirmation.heading.textContent = String(title); confirmation.text.textContent = String(message);
    confirmation.proceed.querySelector('span').textContent = String(confirmLabel);
    confirmation.dialog.hidden = false; confirmation.dialog.showModal(); window.ClassicMartDialogIsolation?.activate(confirmation.dialog);
    window.ClassicMartFlash?.setDialogHost?.(confirmation.dialog);
    confirmation.cancel.focus();
    return new Promise(resolve => { confirmationResult = resolve; });
  }

  function finishConfirmation(accepted) {
    if (!confirmationResult) return;
    const resolve = confirmationResult; confirmationResult = null;
    window.ClassicMartDialogIsolation?.release(confirmation.dialog); confirmation.dialog.close(); confirmation.dialog.hidden = true;
    window.ClassicMartFlash?.setDialogHost?.(preview?.dialog.open ? preview.dialog : null);
    if (preview?.dialog.open) window.ClassicMartDialogIsolation?.activate(preview.dialog);
    focusOpener(confirmation.source); resolve(accepted);
  }

  function deletion(form, submitter) {
    if (!form || formValue(form, 'method').toLowerCase() !== 'post' || form.dataset.recordConfirm === 'off') return false;
    const url = safeUrl(submitter?.getAttribute('formaction') || form.getAttribute('action') || location.href);
    if (!url) return false;
    return Boolean(form.hasAttribute('data-confirm-message') || submitter?.hasAttribute('data-confirm-message')
      || /\/(?:delete|remove|archive|revoke|clear)(?:\/|$)/i.test(url.pathname)
      || /^(?:delete|remove|archive)$/.test(submitter?.name === 'action' ? submitter.value : '')
      || form.querySelector('input[name="_method"][value="DELETE"], input[name="_method"][value="delete"]'));
  }

  function actionLabel(element, fallback = 'Delete item') {
    return element?.getAttribute('aria-label') || element?.textContent?.trim().replace(/\s+/g, ' ') || fallback;
  }

  function enhance(root = document) {
    for (const link of root.querySelectorAll('a.role-row-menu')) {
      link.dataset.recordAction ||= 'view';
      if (link.dataset.recordIcon !== 'view') {
        link.replaceChildren(icon('view')); link.dataset.recordIcon = 'view';
      }
      link.classList.add('record-action-icon');
    }
  }

  function formSignature(form, submitter) {
    const action = safeUrl(submitter?.getAttribute('formaction') || formValue(form, 'action'));
    let data;
    try { data = new FormData(form, submitter); }
    catch { data = new FormData(form); if (submitter?.name) data.append(submitter.name, submitter.value); }
    return JSON.stringify([action?.href, submitter?.getAttribute('formmethod') || formValue(form, 'method'),
      [...data].map(([name, value]) => [name, typeof value === 'string' ? value
        : [value.name, value.size, value.lastModified, value.type]])]);
  }

  function clickSignature(element) {
    const identity = node => [actionLabel(node, ''), ...[...node.attributes]
      .filter(attribute => /^(?:id|name|value|data-(?:remove-|wishlist-remove|cart-remove|cart-clear))/.test(attribute.name))
      .map(attribute => [attribute.name, attribute.value])];
    const collection = element.matches('#clearWishlist, [data-cart-clear]')
      ? [...document.querySelectorAll(clickDeletes)].map(identity) : null;
    return JSON.stringify([identity(element), collection]);
  }

  document.addEventListener('click', async event => {
    if (!(event.target instanceof Element) || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const destructive = event.target.closest(clickDeletes);
    if (destructive && !destructive.disabled) {
      if (allowedClicks.has(destructive)) { allowedClicks.delete(destructive); return; }
      event.preventDefault(); event.stopImmediatePropagation();
      if (pendingClicks.has(destructive)) return;
      pendingClicks.add(destructive);
      try {
        const signature = clickSignature(destructive);
        if (await confirm({ title: 'Confirm deletion', message: `Continue with “${actionLabel(destructive, 'Remove this item')}”?`, opener: destructive })
          && destructive.isConnected && !destructive.disabled) {
          if (signature !== clickSignature(destructive)) {
            window.ClassicMartFlash?.show('The item changed. Review it before confirming again.', { type: 'error' });
            return;
          }
          allowedClicks.add(destructive); destructive.click();
        }
      } finally { pendingClicks.delete(destructive); }
      return;
    }
    const link = event.target.closest('a[data-record-action], a.role-row-menu, a[data-address-edit]');
    if (!link || link.target || link.hasAttribute('download') || !recordUrl(link.getAttribute('href'))) return;
    event.preventDefault(); event.stopImmediatePropagation();
    await open(link.href, { trigger: link, mode: link.dataset.recordAction === 'edit' || link.hasAttribute('data-address-edit') ? 'edit' : 'view', title: link.dataset.recordTitle || '' });
  }, true);

  document.addEventListener('submit', async event => {
    const form = event.target, submitter = event.submitter;
    if (!(form instanceof HTMLFormElement)) return;
    if (submittingForms.has(form) || pendingMutations.has(form)) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (allowedSubmissions.get(form) === submitter && allowedSubmissions.has(form)) {
      allowedSubmissions.delete(form); submittingForms.add(form); form.setAttribute('aria-busy', 'true');
      const clear = () => { submittingForms.delete(form); form.removeAttribute('aria-busy'); };
      queueMicrotask(() => { if (event.defaultPrevented) clear(); });
      setTimeout(clear, 15_000); return;
    }
    if (!deletion(form, submitter)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (pendingForms.has(form)) return;
    pendingForms.add(form);
    try {
      const signature = formSignature(form, submitter);
      const label = actionLabel(submitter, 'Remove this record');
      const accepted = await confirm({ title: submitter?.dataset.confirmTitle || form.dataset.confirmTitle || (/^(?:delete|remove|clear)/i.test(label) ? 'Confirm deletion' : 'Confirm action'),
        message: submitter?.dataset.confirmMessage || form.dataset.confirmMessage || `Continue with “${label}”? This changes the saved record.`, opener: submitter });
      if (accepted && form.isConnected && (!submitter || !submitter.disabled && submitter.form === form)) {
        if (signature !== formSignature(form, submitter)) {
          window.ClassicMartFlash?.show('The record changed. Review it before confirming again.', { type: 'error' });
          return;
        }
        allowedSubmissions.set(form, submitter);
        try { HTMLFormElement.prototype.requestSubmit.call(form, submitter || undefined); }
        finally {
          // A failed native validity check emits no submit event. It must not
          // leave a permission token for a later, unconfirmed deletion.
          allowedSubmissions.delete(form);
        }
      }
    } finally { pendingForms.delete(form); }
  }, true);

  document.addEventListener('submit', async event => {
    const form = event.target, submitter = event.submitter;
    if (event.defaultPrevented || !(form instanceof HTMLFormElement) || !preview?.dialog.open || !preview.content.contains(form)
      || (submitter?.getAttribute('formmethod') || formValue(form, 'method')).toLowerCase() !== 'post') return;
    const action = safeUrl(submitter?.getAttribute('formaction') || formValue(form, 'action'));
    if (!action) return;
    event.preventDefault();
    if (pendingMutations.has(form)) return;
    pendingMutations.add(form); dirty = true;
    let data;
    try { data = new FormData(form, submitter); }
    catch { data = new FormData(form); if (submitter?.name) data.append(submitter.name, submitter.value); }
    const multipart = (submitter?.getAttribute('formenctype') || formValue(form, 'enctype')) === 'multipart/form-data';
    const body = multipart ? data : new URLSearchParams([...data].filter(([, value]) => typeof value === 'string'));
    const wasDisabled = submitter?.disabled;
    if (submitter) submitter.disabled = true;
    form.setAttribute('aria-busy', 'true');
    const status = document.createElement('p'); status.className = 'record-modal-status'; status.role = 'status'; status.textContent = 'Saving…'; form.append(status);
    controller?.abort(); controller = new AbortController();
    const requestController = controller, current = ++sequence;
    const timer = setTimeout(() => requestController.abort(), 20_000);
    try {
      const response = await fetch(action.href, { method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store',
        headers: { Accept: 'text/html', 'X-Requested-With': 'ClassicMartRecordPreview' }, body, signal: requestController.signal });
      if (current !== sequence || !preview.dialog.open) return;
      const destination = recordUrl(response.url);
      if (!destination) { const local = safeUrl(response.url); if (local) location.assign(local.href); return; }
      if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('Review the full page to confirm the saved result.');
      const html = await htmlBody(response, requestController.signal);
      if (current !== sequence || !preview.dialog.open) return;
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      if (!parsed.querySelector('#pageHost')) throw new Error('Open the full page to review this response before trying again.');
      mount(parsed, destination, 'edit', '', current);
      if (!response.ok && !preview.content.querySelector('[role="alert"], .dashboard-message-error, .server-flash.error')) {
        const message = document.createElement('p'); message.role = 'alert'; message.className = 'record-modal-status';
        message.textContent = 'The change was not accepted. Review the record and try again.'; preview.content.prepend(message);
      }
    } catch (error) {
      if (current !== sequence || !preview.dialog.open) return;
      status.role = 'alert'; status.textContent = requestController.signal.aborted
        ? 'The request was interrupted. Open the full page to check its result before trying again.' : error.message;
    } finally {
      clearTimeout(timer); pendingMutations.delete(form); form.removeAttribute('aria-busy');
      if (submitter?.isConnected) submitter.disabled = wasDisabled;
    }
  });

  window.addEventListener('popstate', () => { if (preview?.dialog.open) closePreview({ fromHistory: true }); });
  window.addEventListener('pagehide', () => { finishConfirmation(false); closePreview({ fromHistory: true, restoreFocus: false, refresh: false }); });
  document.addEventListener('classicmart:content-ready', event => enhance(event.detail?.root || document));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => enhance(), { once: true });
  else enhance();
  window.ClassicMartRecordActions = Object.freeze({ open, confirm, enhance });
})();

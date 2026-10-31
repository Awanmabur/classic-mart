(() => {
  'use strict';
  if (window.ClassicMartImageUploads) return;

  const states = new WeakMap();
  const controls = new Set();
  const selector = 'input[type="file"]';
  const excluded = '[data-image-search-input], [data-native-file-control], [hidden], .sr-only';
  const rasterTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
  const maxPreviewBytes = 8 * 1024 * 1024;
  let sequence = 0;
  let observer;

  function icon(image) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) {
      svg.setAttribute(name, value);
    }
    const paths = image
      ? ['M14 3H6a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3v-8',
        'm3 16 5-5 5 5 3-3 5 5', 'M16.5 4h5m-2.5-2.5v5', 'M8 7.5h.01']
      : ['M14 3H6a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3V10Z',
        'M14 3v7h7', 'M8 15h8', 'M8 18h5'];
    for (const data of paths) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', data);
      svg.append(path);
    }
    return svg;
  }

  function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
  }

  function clearPreview(state) {
    state.previewVersion++;
    state.preview.hidden = true;
    state.preview.removeAttribute('src');
    state.symbol.hidden = false;
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = '';
    state.file = null;
  }

  function refresh(state) {
    const { input, shell, name } = state;
    if (!input.isConnected || states.get(input) !== state) return;
    const files = [...(input.files || [])];
    const image = /(?:^|,)\s*(?:image\/|\.(?:jpe?g|png|webp|avif)\b)/i.test(input.accept);
    const kind = image ? 'image' : 'file';
    const plural = input.multiple ? `${kind}s` : kind;
    if (state.image !== image) {
      state.image = image;
      state.symbol.replaceChildren(icon(image));
    }
    setText(state.label, `Choose ${plural}`);
    setText(name, files.length > 1 ? `${files.length} files selected · ${files[0].name}` : files[0]?.name || `No ${kind} selected`);
    shell.dataset.uploadKind = kind;
    shell.setAttribute('aria-disabled', String(input.matches(':disabled')));
    if (state.form !== input.form) {
      state.form?.removeEventListener('reset', state.onReset);
      state.form = input.form;
      state.form?.addEventListener('reset', state.onReset);
    }

    const file = files[0];
    if (!image || !file || file.size > maxPreviewBytes || !rasterTypes.has(file.type)) { clearPreview(state); return; }
    if (file === state.file && state.objectUrl) return;
    clearPreview(state);
    // Display only local raster selections. A filename or MIME hint never
    // establishes server-side validity, and an SVG is not loaded as a preview.
    state.file = file;
    const version = state.previewVersion;
    const objectUrl = URL.createObjectURL(file);
    state.objectUrl = objectUrl;
    state.preview.onload = () => {
      if (state.previewVersion !== version) return;
      // Existing avatar validation may clear this native field asynchronously.
      if (input.files?.[0] !== file || !input.isConnected) { clearPreview(state); refresh(state); return; }
      state.preview.hidden = false;
      state.symbol.hidden = true;
    };
    state.preview.onerror = () => {
      if (state.previewVersion !== version) return;
      clearPreview(state);
    };
    state.preview.src = objectUrl;
  }

  function destroy(state) {
    clearTimeout(state.resetTimer);
    clearPreview(state);
    state.input.removeEventListener('change', state.onChange);
    state.input.removeEventListener('input', state.onChange);
    state.input.removeEventListener('cancel', state.onChange);
    state.form?.removeEventListener('reset', state.onReset);
    if (state.originalAriaLabel === null) state.input.removeAttribute('aria-label');
    else state.input.setAttribute('aria-label', state.originalAriaLabel);
    if (state.originalDescription === null) state.input.removeAttribute('aria-describedby');
    else state.input.setAttribute('aria-describedby', state.originalDescription);
    state.input.classList.remove('platform-upload-input');
    if (state.shell.contains(state.input)) state.shell.replaceWith(state.input);
    else state.shell.remove();
    if (state.decoration && !state.decoration.parentElement?.querySelector('.platform-upload')) {
      delete state.decoration.dataset.enhancedUploadDecoration;
    }
    controls.delete(state);
    states.delete(state.input);
  }

  function enhance(input) {
    if (states.has(input)) { refresh(states.get(input)); return; }
    if (input.matches(excluded) || input.style.display === 'none') return;
    const shell = document.createElement('span');
    shell.className = 'platform-upload';
    shell.dataset.imageUploadControl = '';
    const symbol = document.createElement('span');
    symbol.className = 'platform-upload-symbol';
    symbol.setAttribute('aria-hidden', 'true');
    const preview = document.createElement('img');
    preview.className = 'platform-upload-preview';
    preview.alt = '';
    preview.hidden = true;
    const label = document.createElement('span');
    label.className = 'platform-upload-label';
    label.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'platform-upload-name';
    name.id = `classicmart-upload-selection-${++sequence}`;
    name.setAttribute('role', 'status');
    name.setAttribute('aria-live', 'polite');
    name.setAttribute('aria-atomic', 'true');

    const originalAriaLabel = input.getAttribute('aria-label');
    const originalDescription = input.getAttribute('aria-describedby');
    if (!originalAriaLabel && !input.hasAttribute('aria-labelledby')) {
      // Preserve the pre-enhancement label, rather than adding the visual
      // filename and instructions to the field's accessible name.
      const existingLabel = [...(input.labels || [])].map(item => item.textContent).join(' ').replace(/\s+/g, ' ').trim();
      input.setAttribute('aria-label', existingLabel || (/image\//i.test(input.accept) ? 'Choose image' : 'Choose file'));
    }
    input.setAttribute('aria-describedby', [originalDescription, name.id].filter(Boolean).join(' '));
    input.before(shell);
    shell.append(symbol, preview, label, name, input);
    input.classList.add('platform-upload-input');
    const state = { input, shell, symbol, preview, label, name, originalAriaLabel, originalDescription,
      image: null, file: null, objectUrl: '', previewVersion: 0, form: null, resetTimer: null };
    state.onChange = () => queueMicrotask(() => refresh(state));
    state.onReset = () => {
      // The reset event precedes the browser's native reset algorithm. A
      // microtask can still see the previous FileList; use the next task so a
      // completed or cancelled native reset remains the source of truth.
      clearTimeout(state.resetTimer);
      state.resetTimer = setTimeout(() => { state.resetTimer = null; refresh(state); }, 0);
    };
    input.addEventListener('change', state.onChange);
    input.addEventListener('input', state.onChange);
    input.addEventListener('cancel', state.onChange);
    states.set(input, state);
    controls.add(state);
    const uploadBox = input.closest('.role-upload-box');
    const oldDecoration = uploadBox?.querySelector(':scope > span:not(.platform-upload):has(> svg)');
    if (oldDecoration && !oldDecoration.textContent.trim()) {
      oldDecoration.dataset.enhancedUploadDecoration = '';
      state.decoration = oldDecoration;
    }
    refresh(state);
  }

  function initialize(root = document) {
    if (root?.matches?.(selector)) enhance(root);
    root?.querySelectorAll?.(selector).forEach(enhance);
  }

  function observe() {
    observer ||= new MutationObserver(records => {
      const forms = new Set();
      for (const record of records) {
        if (record.type === 'attributes') {
          if (record.target.matches(selector)) {
            const state = states.get(record.target);
            if (state && record.target.matches(excluded)) destroy(state);
            else if (state) refresh(state);
            else enhance(record.target);
          } else if (record.attributeName === 'disabled' && record.target.matches('fieldset')) {
            const form = record.target.closest('form');
            if (form) forms.add(form);
          }
          continue;
        }
        for (const node of record.addedNodes) if (node.nodeType === 1) initialize(node);
        const form = record.target.closest?.('form');
        if (form) forms.add(form);
      }
      for (const state of [...controls]) {
        if (!state.input.isConnected || !state.shell.isConnected || !state.shell.contains(state.input)) {
          const input = state.input;
          destroy(state);
          if (input.isConnected) enhance(input);
        }
        else if (forms.has(state.input.form)) refresh(state);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['disabled', 'accept', 'multiple', 'form', 'hidden', 'data-native-file-control'] });
  }

  function start() { initialize(); observe(); }
  window.ClassicMartImageUploads = Object.freeze({ initialize });
  document.addEventListener('classicmart:content-ready', event => initialize(event.detail?.root || event.detail?.container || event.target));
  window.addEventListener('pagehide', () => {
    observer?.disconnect();
    for (const state of controls) { clearTimeout(state.resetTimer); state.resetTimer = null; clearPreview(state); }
  });
  window.addEventListener('pageshow', event => { if (event.persisted) { initialize(); observe(); } });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();

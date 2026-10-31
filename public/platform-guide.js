(() => {
  'use strict';
  if (window.ClassicMartGuide || !window.HTMLDialogElement || !document.body || !document.querySelector('main')) return;
  const microphone = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>';
  const trigger = document.createElement('button');
  trigger.type = 'button'; trigger.className = 'classic-guide-trigger';
  trigger.setAttribute('aria-label', 'Open Classic AI voice and shopping guide');
  trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-controls', 'classicGuideDialog');
  trigger.innerHTML = `${microphone}<span>Ask Classic</span>`;
  const dialog = document.createElement('dialog');
  dialog.id = 'classicGuideDialog'; dialog.className = 'classic-guide-dialog'; dialog.setAttribute('aria-labelledby', 'classicGuideTitle');
  // This markup is static. Questions, answers, prices and links are rendered with
  // DOM text nodes below, without interpreting model or catalogue text as HTML.
  dialog.innerHTML = `<header class="classic-guide-head"><div><h2 id="classicGuideTitle">Ask Classic</h2><p>Find products. Find your way.</p></div><button class="classic-guide-close" type="button" aria-label="Close Classic guide"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 5 19 19M19 5 5 19"/></svg></button></header>
    <div class="classic-guide-log" role="log" aria-label="Your guide conversation" aria-live="polite" aria-relevant="additions"></div>
    <form class="classic-guide-form"><label for="classicGuideQuestion">How can I help?</label><div class="classic-guide-compose"><button class="classic-guide-mic" type="button" aria-label="Speak your question" aria-pressed="false">${microphone}</button><input id="classicGuideQuestion" name="message" type="text" minlength="2" maxlength="2000" required autocomplete="off" placeholder="Find a speaker under UGX 200,000"><button class="classic-guide-send" type="button">Send</button></div><div class="classic-guide-options"><label><input type="checkbox" name="speak">Read replies aloud</label><label hidden data-guide-detailed><input type="checkbox" name="detailed">Detailed AI answer</label></div><p class="classic-guide-status" aria-live="polite" aria-atomic="true"></p><p class="classic-guide-disclosure">Microphone starts only when you tap it. Your browser may use its speech service. Review the text before sending. Detailed AI sends your question and public catalogue facts to our AI provider.</p></form>`;
  document.body.append(trigger, dialog);
  const form = dialog.querySelector('form'), input = form.elements.message;
  const log = dialog.querySelector('[role="log"]'), status = dialog.querySelector('.classic-guide-status');
  const mic = dialog.querySelector('.classic-guide-mic'), send = dialog.querySelector('.classic-guide-send');

  // No third-party drag library or network calls. Persist only a normalized
  // launcher position, not the conversation or shopper's location.
  const positionKey = 'classic-mart:guide-launcher:v1';
  const edgeGap = 8;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const bounds = () => ({
    x: Math.max(edgeGap, document.documentElement.clientWidth - trigger.offsetWidth - edgeGap),
    y: Math.max(edgeGap, window.innerHeight - trigger.offsetHeight - edgeGap),
  });
  let dragging = null, ignoreClick = false, resizeFrame = 0;
  trigger.title = 'Drag to move. Alt + arrow keys to reposition. Alt + Home to reset.';
  trigger.setAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown Alt+Home');

  function placeLauncher(x, y, persist = false) {
    const limit = bounds();
    const left = Math.round(clamp(x, edgeGap, limit.x));
    const top = Math.round(clamp(y, edgeGap, limit.y));
    trigger.dataset.positioned = 'true';
    trigger.style.left = left + 'px';
    trigger.style.top = top + 'px';
    trigger.style.right = 'auto';
    trigger.style.bottom = 'auto';
    if (persist) {
      const width = Math.max(1, limit.x - edgeGap), height = Math.max(1, limit.y - edgeGap);
      try { localStorage.setItem(positionKey, JSON.stringify({
        x: (left - edgeGap) / width, y: (top - edgeGap) / height,
      })); } catch { /* private storage is optional */ }
    }
  }
  function restoreLauncher() {
    try {
      const value = JSON.parse(localStorage.getItem(positionKey) || 'null');
      if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)
          || value.x < 0 || value.x > 1 || value.y < 0 || value.y > 1) return;
      const limit = bounds();
      placeLauncher(edgeGap + value.x * Math.max(1, limit.x - edgeGap),
        edgeGap + value.y * Math.max(1, limit.y - edgeGap));
    } catch { /* retain the safe default above Back to top */ }
  }
  function resetLauncher() {
    try { localStorage.removeItem(positionKey); } catch {}
    trigger.removeAttribute('data-positioned');
    for (const value of ['left', 'top', 'right', 'bottom', 'transform']) trigger.style.removeProperty(value);
  }
  trigger.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || dialog.open) return;
    const rect = trigger.getBoundingClientRect();
    dragging = { id: event.pointerId, x: event.clientX, y: event.clientY,
      left: rect.left, top: rect.top, dx: 0, dy: 0, moved: false, frame: 0 };
    try { trigger.setPointerCapture(event.pointerId); } catch {}
  });
  trigger.addEventListener('pointermove', event => {
    if (!dragging || dragging.id !== event.pointerId) return;
    const dx = event.clientX - dragging.x, dy = event.clientY - dragging.y;
    if (!dragging.moved && Math.hypot(dx, dy) < 6) return;
    dragging.moved = true;
    dragging.dx = dx; dragging.dy = dy;
    trigger.dataset.dragging = 'true';
    event.preventDefault();
    if (!dragging.frame) {
      const state = dragging;
      state.frame = requestAnimationFrame(() => {
        state.frame = 0;
        if (dragging !== state) return;
        const limit = bounds();
        const x = clamp(state.left + state.dx, edgeGap, limit.x);
        const y = clamp(state.top + state.dy, edgeGap, limit.y);
        trigger.style.transform = 'translate3d(' + (x - state.left) + 'px, ' + (y - state.top) + 'px, 0)';
      });
    }
  });
  function endDrag(event, cancelled = false) {
    if (!dragging || event.pointerId !== dragging.id) return;
    const state = dragging; dragging = null;
    if (state.frame) cancelAnimationFrame(state.frame);
    trigger.style.removeProperty('transform');
    delete trigger.dataset.dragging;
    if (trigger.hasPointerCapture?.(state.id)) trigger.releasePointerCapture(state.id);
    if (!cancelled && state.moved) {
      placeLauncher(state.left + event.clientX - state.x, state.top + event.clientY - state.y, true);
      ignoreClick = true;
      setTimeout(() => { ignoreClick = false; }, 0);
    }
  }
  trigger.addEventListener('pointerup', event => endDrag(event));
  trigger.addEventListener('pointercancel', event => endDrag(event, true));
  trigger.addEventListener('click', event => {
    if (!ignoreClick) return;
    event.preventDefault(); event.stopImmediatePropagation();
    ignoreClick = false;
  }, true);
  trigger.addEventListener('keydown', event => {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Home') { event.preventDefault(); resetLauncher(); return; }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = arrows[event.key];
    if (!direction) return;
    event.preventDefault();
    const rect = trigger.getBoundingClientRect();
    const step = event.shiftKey ? 42 : 18;
    placeLauncher(rect.left + direction[0] * step, rect.top + direction[1] * step, true);
  });
  window.addEventListener('resize', () => {
    if (dragging || resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      if (trigger.hasAttribute('data-positioned')) restoreLauncher();
    });
  }, { passive: true });
  restoreLauncher();

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let session = null, bootstrap = null, bootstrapController = null, request = null, recognition = null, generation = 0;
  const sayStatus = text => { status.textContent = text; };
  function safeLink(href) {
    try { const url = new URL(href, location.origin); return url.origin === location.origin && !url.username && !url.password ? `${url.pathname}${url.search}${url.hash}` : null; } catch { return null; }
  }
  function message(text, question = false) {
    const node = document.createElement('article'); node.className = `classic-guide-message${question ? ' classic-guide-message--question' : ''}`;
    const p = document.createElement('p'); p.textContent = text; node.append(p); log.append(node);
    // Keep DOM and spoken-history memory bounded during long shopping sessions.
    while (log.children.length > 24) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
    return node;
  }
  function renderReply(payload) {
    const node = message(String(payload.answer || 'Open the Help centre for more guidance.'));
    const label = document.createElement('small'); label.textContent = payload.aiGenerated ? 'AI-generated · check current listing details' : 'Live catalogue and platform guide'; node.prepend(label);
    const products = document.createElement('div'); products.className = 'classic-guide-products';
    for (const product of (payload.products || []).slice(0, 5)) {
      const href = safeLink(product.href); if (!href) continue;
      const link = document.createElement('a'); link.href = href;
      const name = document.createElement('strong'); name.textContent = String(product.name || 'View product');
      const detail = document.createElement('span');
      try { detail.textContent = new Intl.NumberFormat(session?.locale || 'en', { style: 'currency', currency: product.currency }).format(product.price); } catch { detail.textContent = `${product.currency || ''} ${Number(product.price) || 0}`; }
      if (product.seller) detail.textContent += ` · ${String(product.seller)}`;
      link.append(name, detail); products.append(link);
    }
    if (products.children.length) node.append(products);
    const links = document.createElement('div'); links.className = 'classic-guide-links';
    for (const item of (payload.links || []).slice(0, 5)) {
      const href = safeLink(item.href); if (!href) continue;
      const link = document.createElement('a'); link.href = href; link.textContent = String(item.label || 'Open page'); links.append(link);
    }
    node.append(links); log.scrollTop = log.scrollHeight;
    if (form.elements.speak.checked && window.speechSynthesis && window.SpeechSynthesisUtterance) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(String(payload.answer || '').slice(0, 1500));
      utterance.lang = session?.locale || document.documentElement.lang || 'en'; window.speechSynthesis.speak(utterance);
    }
  }
  async function initialize() {
    if (session) return session;
    if (bootstrap) return bootstrap;
    const active = (async () => {
      const controller = new AbortController(); bootstrapController = controller;
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch('/api/v1/ai/guide/session', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.csrfToken) throw new Error(payload.error?.message || 'The guide is temporarily unavailable. Use the Help centre or try again.');
        session = payload; dialog.querySelector('[data-guide-detailed]').hidden = !payload.aiConfigured; return session;
      } finally { clearTimeout(timer); if (bootstrapController === controller) bootstrapController = null; }
    })();
    bootstrap = active;
    try { return await active; } finally { if (bootstrap === active) bootstrap = null; }
  }
  async function open() {
    if (dialog.open) { input.focus(); return; }
    const opening = ++generation;
    dialog.showModal();
    trigger.setAttribute('aria-expanded', 'true'); input.focus();
    if (!log.children.length) message('Hello! Ask about a product and budget, or tell me which part of Classic Mart you need help finding.');
    sayStatus('Connecting to your selected market…');
    try { const ready = await initialize(); if (dialog.open && opening === generation) sayStatus(`Shopping in ${ready.country}. Type a question or use the microphone.`); }
    catch (error) { if (dialog.open && opening === generation) sayStatus(error.name === 'AbortError' ? 'Connection took too long. Please try sending your question again.' : error.message); }
  }
  function stopAudio() {
    recognition?.abort(); recognition = null; mic.setAttribute('aria-pressed', 'false'); window.speechSynthesis?.cancel();
  }
  function close() { if (dialog.open) dialog.close(); }
  trigger.addEventListener('click', open);
  dialog.querySelector('.classic-guide-close').addEventListener('click', close);
  dialog.addEventListener('close', () => { generation++; request?.abort(); bootstrapController?.abort(); request = null; stopAudio(); send.disabled = false; trigger.setAttribute('aria-expanded', 'false'); trigger.focus({ preventScroll: true }); });
  if (!Recognition) { mic.hidden = true; input.placeholder = 'Type a product or platform question'; }
  mic.addEventListener('click', () => {
    if (recognition) { stopAudio(); sayStatus('Listening stopped.'); return; }
    window.speechSynthesis?.cancel();
    const current = new Recognition(); recognition = current;
    current.lang = session?.locale || document.documentElement.lang || 'en'; current.interimResults = false; current.continuous = false; current.maxAlternatives = 1;
    current.onstart = () => { if (recognition !== current) return; mic.setAttribute('aria-pressed', 'true'); sayStatus('Listening… tap the microphone to stop.'); };
    current.onresult = event => { if (recognition !== current || !dialog.open) return; input.value = String(event.results[0]?.[0]?.transcript || '').slice(0, 2000); sayStatus('Review your question, then send.'); input.focus(); };
    current.onerror = event => { if (recognition !== current) return; sayStatus(event.error === 'not-allowed' ? 'Microphone permission was denied. You can type your question.' : 'Speech recognition is unavailable. Please type your question.'); };
    current.onend = () => { if (recognition === current) { recognition = null; mic.setAttribute('aria-pressed', 'false'); } };
    try { current.start(); } catch { recognition = null; sayStatus('Microphone could not start. Please type your question.'); }
  });
  form.elements.speak.addEventListener('change', () => { if (!form.elements.speak.checked) window.speechSynthesis?.cancel(); });
  // Keep this widget isolated from unrelated page form submit selectors.
  send.addEventListener('click', () => form.requestSubmit());
  form.addEventListener('submit', async event => {
    event.preventDefault(); const text = input.value.trim(); if (text.length < 2 || send.disabled) return;
    stopAudio(); const version = ++generation; send.disabled = true; message(text, true); input.value = ''; sayStatus('Finding current information…');
    try {
      const ready = await initialize(); if (version !== generation || !dialog.open) return;
      const controller = new AbortController(); request = controller;
      const timer = setTimeout(() => controller.abort(), 30_000);
      let response, payload;
      try { response = await fetch('/api/v1/ai/guide', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': ready.csrfToken }, body: JSON.stringify({ message: text, detailed: form.elements.detailed.checked }), signal: controller.signal }); payload = await response.json().catch(() => ({})); }
      finally { clearTimeout(timer); }
      if (version !== generation || !dialog.open) return;
      if (!response.ok) { if (response.status === 403) session = null; throw new Error(payload.error?.message || (response.status === 429 ? 'Please wait a moment before asking again.' : 'The guide could not complete that request. Please try again.')); }
      if (typeof payload.answer !== 'string') throw new Error('The guide returned an incomplete reply. Please try again.');
      renderReply(payload); sayStatus('Reply ready. Prices and availability can change.');
    } catch (error) {
      if (version === generation && dialog.open) { if (!input.value) input.value = text; message(error.name === 'AbortError' ? 'That request took too long. Please try again.' : error.message); sayStatus('You can try again or open the Help centre.'); }
    } finally { if (version === generation) { request = null; send.disabled = false; input.focus(); } }
  });
  window.addEventListener('pagehide', () => { generation++; request?.abort(); bootstrapController?.abort(); stopAudio(); });
  window.addEventListener('pageshow', event => { if (event.persisted) { send.disabled = false; request = null; if (dialog.open) sayStatus('Ready for your next question.'); } });
  window.ClassicMartGuide = Object.freeze({ open, close });
})();

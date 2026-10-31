(() => {
  'use strict';
  if (window.ClassicMartGuide || !document.body || !document.querySelector('main')) return;

  // Voice-first assistant: no text input or chat modal. Only a user gesture
  // starts microphone capture. Answers come from the existing read-only guide API.
  const microphone = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>';
  const stopIcon = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'classic-guide-trigger';
  trigger.setAttribute('aria-label', 'Ask Classic - start voice assistant');
  trigger.setAttribute('aria-pressed', 'false');
  trigger.innerHTML = microphone + '<span>Ask Classic</span>';

  const hud = document.createElement('section');
  hud.className = 'classic-voice-hud';
  hud.id = 'classicVoiceHud';
  hud.hidden = true;
  hud.setAttribute('role', 'region');
  hud.setAttribute('aria-label', 'Classic Mart voice assistant status');
  hud.innerHTML = '<div class="classic-voice-hud-head"><span class="classic-voice-indicator" aria-hidden="true"></span><strong>Classic AI Voice</strong><button class="classic-voice-stop" type="button" aria-label="Stop Classic AI voice assistant">' + stopIcon + '</button></div><div class="classic-voice-waves" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><p class="classic-voice-status" role="status" aria-live="polite" aria-atomic="true">Tap to speak</p><p class="classic-voice-notice">Microphone starts on tap. Recognized words are sent to Classic Mart for an answer. Your browser may use a speech service.</p><a class="classic-voice-fallback" href="/ask-classic" hidden>Open Classic AI without voice</a>';
  document.body.append(trigger, hud);
  const status = hud.querySelector('.classic-voice-status');
  const fallback = hud.querySelector('.classic-voice-fallback');
  const stop = hud.querySelector('.classic-voice-stop');

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const SynthUtterance = window.SpeechSynthesisUtterance;
  const synth = window.speechSynthesis;
  const storageKey = 'classic-mart:guide-launcher:v1';
  const edge = 8;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const limits = () => ({
    x: Math.max(edge, document.documentElement.clientWidth - trigger.offsetWidth - edge),
    y: Math.max(edge, window.innerHeight - trigger.offsetHeight - edge)
  });
  let dragging = null, ignoreClick = false, resizeFrame = 0;
  let recognition = null, session = null, sessionTask = null, sessionController = null, request = null;
  let speech = null, lastAnswer = '', version = 0;
  let state = 'idle';
  trigger.title = 'Tap to speak, tap again to stop. Drag to move; Alt + arrows reposition, Alt + Home resets.';
  trigger.setAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown Alt+Home');

  function placeHud() {
    if (hud.hidden) return;
    const r = trigger.getBoundingClientRect();
    const w = hud.offsetWidth, h = hud.offsetHeight;
    const maxX = Math.max(edge, document.documentElement.clientWidth - w - edge);
    const maxY = Math.max(edge, window.innerHeight - h - edge);
    // Put the compact audio display above the button, or below if dragged near the top.
    const top = r.top - h - 10 >= edge ? r.top - h - 10 : r.bottom + 10;
    hud.style.left = Math.round(clamp(r.left + r.width / 2 - w / 2, edge, maxX)) + 'px';
    hud.style.top = Math.round(clamp(top, edge, maxY)) + 'px';
  }
  function placeLauncher(x, y, persist = false) {
    const limit = limits();
    const left = Math.round(clamp(x, edge, limit.x));
    const top = Math.round(clamp(y, edge, limit.y));
    trigger.dataset.positioned = 'true';
    Object.assign(trigger.style, { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' });
    if (persist) {
      try {
        localStorage.setItem(storageKey, JSON.stringify({
          x: (left - edge) / Math.max(1, limit.x - edge),
          y: (top - edge) / Math.max(1, limit.y - edge)
        }));
      } catch { /* Storage is optional. */ }
    }
    placeHud();
  }
  function restoreLauncher() {
    try {
      const p = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return;
      const limit = limits();
      placeLauncher(edge + p.x * Math.max(1, limit.x - edge), edge + p.y * Math.max(1, limit.y - edge));
    } catch { /* Keep default above the Back to top control. */ }
  }
  function resetLauncher() {
    try { localStorage.removeItem(storageKey); } catch {}
    delete trigger.dataset.positioned;
    for (const name of ['left', 'top', 'right', 'bottom', 'transform']) trigger.style.removeProperty(name);
    placeHud();
  }
  trigger.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    const r = trigger.getBoundingClientRect();
    dragging = { id: event.pointerId, x: event.clientX, y: event.clientY,
      left: r.left, top: r.top, dx: 0, dy: 0, moved: false, frame: 0 };
    try { trigger.setPointerCapture(event.pointerId); } catch {}
  });
  trigger.addEventListener('pointermove', event => {
    const d = dragging;
    if (!d || event.pointerId !== d.id) return;
    const dx = event.clientX - d.x, dy = event.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 6) return;
    d.moved = true; d.dx = dx; d.dy = dy;
    trigger.dataset.dragging = 'true';
    event.preventDefault();
    if (!d.frame) d.frame = requestAnimationFrame(() => {
      d.frame = 0;
      if (dragging !== d) return;
      const limit = limits();
      const x = clamp(d.left + d.dx, edge, limit.x);
      const y = clamp(d.top + d.dy, edge, limit.y);
      trigger.style.transform = 'translate3d(' + (x - d.left) + 'px,' + (y - d.top) + 'px,0)';
    });
  });
  function endDrag(event, cancelled = false) {
    if (!dragging || event.pointerId !== dragging.id) return;
    const d = dragging; dragging = null;
    if (d.frame) cancelAnimationFrame(d.frame);
    trigger.style.removeProperty('transform');
    delete trigger.dataset.dragging;
    if (trigger.hasPointerCapture?.(d.id)) trigger.releasePointerCapture(d.id);
    if (!cancelled && d.moved) {
      placeLauncher(d.left + event.clientX - d.x, d.top + event.clientY - d.y, true);
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
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const dir = directions[event.key];
    if (!dir) return;
    event.preventDefault();
    const r = trigger.getBoundingClientRect();
    const amount = event.shiftKey ? 42 : 18;
    placeLauncher(r.left + dir[0] * amount, r.top + dir[1] * amount, true);
  });
  window.addEventListener('resize', () => {
    if (dragging || resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      if (trigger.hasAttribute('data-positioned')) restoreLauncher();
      placeHud();
    });
  }, { passive: true });
  restoreLauncher();

  function setState(next, message) {
    state = next;
    trigger.dataset.voiceState = next;
    trigger.setAttribute('aria-pressed', String(next === 'listening'));
    hud.dataset.voiceState = next;
    hud.hidden = next === 'idle';
    status.textContent = message;
    stop.hidden = next === 'unsupported' || next === 'idle';
    fallback.hidden = next !== 'unsupported' && next !== 'error';
    if (!hud.hidden) requestAnimationFrame(placeHud);
  }
  function stopAudio() {
    const active = recognition; recognition = null;
    if (active) {
      active.onresult = null; active.onerror = null; active.onend = null;
      try { active.abort(); } catch {}
    }
    if (synth) { try { synth.cancel(); } catch {} }
    speech = null;
  }
  function close() {
    version++;
    request?.abort(); request = null;
    sessionController?.abort(); sessionController = null;
    sessionTask = null;
    stopAudio();
    setState('idle', '');
  }
  stop.addEventListener('click', close);

  async function initialize() {
    if (session) return session;
    if (sessionTask) return sessionTask;
    const controller = new AbortController();
    sessionController = controller;
    const timer = setTimeout(() => controller.abort(), 10000);
    const task = (async () => {
      try {
        const response = await fetch('/api/v1/ai/guide/session', {
          credentials: 'same-origin', cache: 'no-store',
          headers: { Accept: 'application/json' }, signal: controller.signal
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.csrfToken) throw new Error(payload.error?.message || 'Voice guide unavailable.');
        session = payload; return session;
      } finally {
        clearTimeout(timer);
        if (sessionController === controller) sessionController = null;
      }
    })();
    sessionTask = task;
    try { return await task; } finally { if (sessionTask === task) sessionTask = null; }
  }

  function speakAnswer(answer, generation) {
    if (!synth || !SynthUtterance) {
      if (generation === version) setState('error', 'Audio playback is unavailable. Open Classic AI for the full answer.');
      return;
    }
    try {
      synth.cancel();
      const utterance = new SynthUtterance(answer.slice(0, 1600));
      utterance.lang = session?.locale || document.documentElement.lang || 'en';
      speech = utterance;
      utterance.onstart = () => {
        if (generation === version) setState('speaking', 'Speaking your answer. Tap Stop to end.');
      };
      utterance.onend = () => {
        if (generation === version) setState('ready', 'Answer complete. Tap the microphone to ask again.');
        if (speech === utterance) speech = null;
      };
      utterance.onerror = () => {
        if (generation === version) setState('error', 'Could not play the answer. Open Classic AI to read it.');
        if (speech === utterance) speech = null;
      };
      synth.speak(utterance);
      if (generation === version) setState('speaking', 'Speaking your answer. Tap Stop to end.');
    } catch {
      if (generation === version) setState('error', 'Speech playback failed. Open Classic AI for a text answer.');
    }
  }

  async function ask(transcript, generation) {
    if (generation !== version) return;
    const question = String(transcript || '').trim().slice(0, 2000);
    if (question.length < 2) { setState('ready', 'I did not catch that. Tap the microphone to try again.'); return; }
    setState('thinking', 'Finding the latest product and platform information…');
    try {
      const ready = await initialize();
      if (generation !== version) return;
      const controller = new AbortController(); request = controller;
      const timer = setTimeout(() => controller.abort(), 30000);
      let response, data;
      try {
        response = await fetch('/api/v1/ai/guide', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': ready.csrfToken },
          body: JSON.stringify({ message: question, detailed: false }), signal: controller.signal
        });
        data = await response.json().catch(() => ({}));
      } finally {
        clearTimeout(timer);
        if (request === controller) request = null;
      }
      if (generation !== version) return;
      if (!response.ok || typeof data.answer !== 'string' || !data.answer.trim()) {
        if (response.status === 403) session = null;
        throw new Error(data.error?.message || 'I could not retrieve an answer. Try again.');
      }
      lastAnswer = data.answer;
      speakAnswer(lastAnswer, generation);
    } catch (error) {
      if (generation !== version) return;
      const msg = error.name === 'AbortError' ? 'That request took too long.' : 'I could not answer that request.';
      setState('error', msg + ' Tap the microphone to retry.');
    }
  }

  function start() {
    // Starting recognition in this direct click handler preserves user gesture
    // and does not request permission in background or during page load.
    if (!Recognition) {
      setState('unsupported', 'Voice recognition is not supported in this browser.');
      return;
    }
    close();
    const generation = version;
    setState('connecting', 'Requesting microphone access…');
    try {
      const current = new Recognition();
      recognition = current;
      current.lang = session?.locale || document.documentElement.lang || 'en';
      current.continuous = false;
      current.interimResults = false;
      current.maxAlternatives = 1;
      current.onstart = () => {
        if (recognition === current && version === generation) setState('listening', 'Listening… speak your question.');
      };
      current.onresult = event => {
        if (recognition !== current || version !== generation) return;
        const transcript = String(event.results?.[0]?.[0]?.transcript || '');
        recognition = null;
        try { current.stop?.(); } catch {}
        void ask(transcript, generation);
      };
      current.onerror = event => {
        if (version !== generation) return;
        recognition = null;
        setState('error', event.error === 'not-allowed' || event.error === 'service-not-allowed'
          ? 'Microphone access denied. Check browser permission.'
          : 'Voice recognition failed. Tap to try again.');
      };
      current.onend = () => {
        if (recognition !== current || version !== generation) return;
        recognition = null;
        if (state === 'listening' || state === 'connecting') setState('ready', 'No speech detected. Tap the microphone to retry.');
      };
      current.start();
    } catch {
      recognition = null;
      setState('error', 'Could not start microphone. Check microphone access and retry.');
    }
  }

  function open() {
    if (state === 'listening' || state === 'connecting' || state === 'thinking' || state === 'speaking') { close(); return; }
    start();
  }
  trigger.addEventListener('click', open);
  window.addEventListener('pagehide', close);
  document.addEventListener('visibilitychange', () => { if (document.hidden && state !== 'idle') close(); });
  window.ClassicMartGuide = Object.freeze({ open, close });
})();
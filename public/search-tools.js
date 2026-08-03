(() => {
  'use strict';

  const tokenCache = { value: '' };

  function toast(message) {
    const target = document.querySelector('#toast, #catalogToast, .page-toast');
    if (target) {
      target.textContent = message;
      target.classList.add('show');
      clearTimeout(toast.timer);
      toast.timer = setTimeout(() => target.classList.remove('show'), 2600);
      return;
    }
    window.alert(message);
  }

  async function actionToken() {
    if (tokenCache.value) return tokenCache.value;
    const response = await fetch('/api/v1/storefront/action-token', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.csrfToken) throw new Error(payload.error?.message || 'Search could not be started.');
    tokenCache.value = payload.csrfToken;
    return tokenCache.value;
  }

  function submitSearch(form) {
    const input = form.querySelector('#searchInput, input[type="search"]');
    input?.dispatchEvent(new Event('input', { bubbles: true }));
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }

  function startVoiceSearch(form, button) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      toast('Voice search is not supported by this browser.');
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = document.documentElement.lang || navigator.language || 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    button.classList.add('is-listening');
    button.setAttribute('aria-pressed', 'true');
    toast('Listening…');
    recognition.addEventListener('result', (event) => {
      const transcript = String(event.results?.[0]?.[0]?.transcript || '').trim();
      const input = form.querySelector('#searchInput, input[type="search"]');
      if (!transcript || !input) return;
      input.value = transcript;
      submitSearch(form);
    });
    recognition.addEventListener('error', (event) => {
      const message = event.error === 'not-allowed'
        ? 'Microphone permission was not granted.'
        : 'Voice search could not understand that. Please try again.';
      toast(message);
    });
    recognition.addEventListener('end', () => {
      button.classList.remove('is-listening');
      button.setAttribute('aria-pressed', 'false');
    });
    recognition.start();
  }

  async function runImageSearch(form, button, file) {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(file.type)) {
      toast('Choose a JPEG, PNG, WebP or AVIF image.');
      return;
    }
    if (file.size > 6 * 1024 * 1024) {
      toast('Choose an image smaller than 6 MB.');
      return;
    }
    button.classList.add('is-loading');
    button.disabled = true;
    toast('Finding visually similar products…');
    try {
      const csrfToken = await actionToken();
      const hasResultSurface = Boolean(document.querySelector('#catalogProductGrid, #trending'));
      const body = new FormData();
      body.append('image', file, file.name || 'visual-search-image');
      body.append('transfer', hasResultSurface ? '0' : '1');
      const response = await fetch('/api/v1/storefront/search-by-image', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'x-csrf-token': csrfToken },
        body,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || 'Image search failed.');
      const products = Array.isArray(payload.products) ? payload.products : [];
      if (!hasResultSurface) {
        if (!payload.visualSearchReady) throw new Error('Image search results could not be transferred.');
        window.location.assign('/search?visual=1');
        return;
      }
      document.dispatchEvent(new CustomEvent('classicmart:visual-search-results', {
        detail: { products, count: products.length, sourceForm: form },
      }));
      toast(products.length ? `${products.length} visual match${products.length === 1 ? '' : 'es'} found.` : 'No visual matches were found.');
    } catch (error) {
      toast(error.message || 'Image search failed.');
    } finally {
      button.classList.remove('is-loading');
      button.disabled = false;
      const input = form.querySelector('[data-image-search-input]');
      if (input) input.value = '';
    }
  }

  document.querySelectorAll('#searchForm').forEach((form) => {
    const voiceButton = form.querySelector('[data-voice-search]');
    const imageButton = form.querySelector('[data-image-search]');
    const imageInput = form.querySelector('[data-image-search-input]');
    voiceButton?.addEventListener('click', () => startVoiceSearch(form, voiceButton));
    imageButton?.addEventListener('click', () => imageInput?.click());
    imageInput?.addEventListener('change', () => runImageSearch(form, imageButton, imageInput.files?.[0]));
  });
})();

(() => {
  'use strict';
  let installPrompt = null;
  function updateInstallButtons() {
    document.querySelectorAll('[data-pwa-install]').forEach(button => {
      button.hidden = !installPrompt;
      button.disabled = !installPrompt;
    });
  }
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; updateInstallButtons(); });
  window.addEventListener('appinstalled', () => { installPrompt = null; updateInstallButtons(); });
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-pwa-install]'); if (!button || !installPrompt) return;
    installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; updateInstallButtons();
  });
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(error => console.warn('Classic Mart PWA registration failed:', error)));
  }
  updateInstallButtons();
})();

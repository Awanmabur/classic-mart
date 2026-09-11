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
    const localDevelopment = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
    window.addEventListener('load', async () => {
      if (localDevelopment) {
        try {
          const registrations = await navigator.serviceWorker.getRegistrations();
          await Promise.all(registrations.map((registration) => registration.unregister()));
          if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys.filter((key) => key.startsWith('classic-mart-public-')).map((key) => caches.delete(key)));
          }
        } catch (error) {
          console.warn('Classic Mart local PWA cache cleanup failed:', error);
        }
        return;
      }
      try {
        const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
        await registration.update();
      } catch (error) {
        console.warn('Classic Mart PWA registration failed:', error);
      }
    });
  }
  updateInstallButtons();
})();

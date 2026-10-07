(() => {
  'use strict';
  document.body.dataset.workspace = 'seller';
  if (location.pathname !== '/seller/store') {
    const section = document.querySelector('[data-seller-settings-panel].active')?.dataset.sellerSettingsPanel || 'identity';
    history.replaceState(null, '', '/seller/store?section=' + encodeURIComponent(section));
  }
  document.querySelectorAll('[data-seller-settings-tab]').forEach(button => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-seller-settings-tab]').forEach(tab => {
        const active = tab === button;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-pressed', String(active));
      });
      document.querySelectorAll('[data-seller-settings-panel]').forEach(panel => {
        panel.classList.toggle('active', panel.dataset.sellerSettingsPanel === button.dataset.sellerSettingsTab);
      });
      const url = new URL(location.href);
      url.searchParams.set('section', button.dataset.sellerSettingsTab);
      history.replaceState(null, '', url);
    });
  });
  document.querySelector('[data-seller-security]')?.addEventListener('click', () => location.assign('/account/security'));
})();

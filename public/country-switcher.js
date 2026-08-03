(() => {
  'use strict';
  const button = document.querySelector('#languageButton');
  if (!button || button.dataset.countryReady === 'true') return;
  button.dataset.countryReady = 'true';
  let panel;
  const close = () => { panel?.remove(); panel = null; button.setAttribute('aria-expanded','false'); };
  button.addEventListener('click', async (event) => {
    event.preventDefault(); event.stopPropagation();
    if (panel) return close();
    try {
      const response = await fetch('/api/v1/country-options', { credentials:'same-origin', headers:{ Accept:'application/json' } });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error?.message || 'Country options unavailable');
      panel = document.createElement('div'); panel.className = 'country-switch-popover'; panel.setAttribute('role','menu');
      const title = document.createElement('strong'); title.textContent = 'Country & currency'; panel.appendChild(title);
      payload.countries.forEach((country) => {
        const form = document.createElement('form'); form.method = 'post'; form.action = '/country'; form.className = 'country-switch-form';
        const csrf = document.createElement('input'); csrf.type='hidden'; csrf.name='_csrf'; csrf.value=payload.csrfToken;
        const code = document.createElement('input'); code.type='hidden'; code.name='country'; code.value=country.code;
        const choose = document.createElement('button'); choose.type='submit'; choose.className='country-switch-option';
        choose.textContent = `${country.name} · ${country.currency}`; if (country.code === payload.current) choose.setAttribute('aria-current','true');
        form.append(csrf, code, choose); panel.appendChild(form);
      });
      document.body.appendChild(panel);
      const rect = button.getBoundingClientRect(); panel.style.top = `${Math.min(window.innerHeight - panel.offsetHeight - 12, rect.bottom + 8)}px`; panel.style.left = `${Math.max(12, Math.min(window.innerWidth - panel.offsetWidth - 12, rect.right - panel.offsetWidth))}px`;
      button.setAttribute('aria-expanded','true');
    } catch { window.location.href = '/dashboard'; }
  });
  document.addEventListener('click', (event) => { if (panel && !panel.contains(event.target) && event.target !== button) close(); });
  window.addEventListener('resize', close, { passive:true });
})();

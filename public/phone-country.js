(() => {
  'use strict';
  const refreshers = [];
  document.querySelectorAll('.phone-country-control').forEach(control => {
    const select = control.querySelector('.phone-country-select');
    const display = control.querySelector('.phone-country-display');
    if (!select || !display) return;
    const refresh = () => {
      const prefix = select.selectedOptions[0]?.dataset.phonePrefix;
      if (!prefix) { control.classList.remove('phone-country-enhanced'); return; }
      display.textContent = prefix;
      control.classList.add('phone-country-enhanced');
    };
    select.addEventListener('change', refresh);
    select.addEventListener('input', refresh);
    select.form?.addEventListener('reset', () => requestAnimationFrame(refresh));
    refreshers.push(refresh);
    refresh();
  });
  window.addEventListener('pageshow', () => refreshers.forEach(refresh => refresh()));
})();

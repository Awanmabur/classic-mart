(() => {
  'use strict';
  const allowed = JSON.parse(document.body.dataset.dashboardAllowed);
  const initialPage = document.body.dataset.dashboardPage;
  const roleDashboard = window.ClassicRoleDashboard;
  // Navigate through authenticated server routes rather than a cross-role preview hash.
  document.addEventListener('click', event => {
    const logout = event.target.closest('[data-action="logout"]');
    if (logout) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const form = document.createElement('form');
      form.method = 'post'; form.action = '/logout';
      const token = document.createElement('input');
      token.type = 'hidden'; token.name = '_csrf';
      token.value = document.querySelector('meta[name="csrf-token"]').content;
      form.append(token); document.body.append(form); form.submit();
      return;
    }
    const target = event.target.closest('[data-page-target]');
    if (!target) return;
    const page = target.dataset.pageTarget;
    const role = roleDashboard.roleForPage(page) || 'customer';
    if (!allowed.includes(role)) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    event.preventDefault(); event.stopImmediatePropagation();
    location.assign('/dashboard/' + encodeURIComponent(page));
  }, true);
  window.addEventListener('hashchange', () => {
    const page = location.hash.slice(1);
    const role = roleDashboard.roleForPage(page) || 'customer';
    if (!allowed.includes(role)) {
      history.replaceState(null, '', '#' + initialPage);
      window.navigateTo?.(initialPage, { fromHash: true });
    }
  }, true);
})();

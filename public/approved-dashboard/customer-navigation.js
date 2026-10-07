(() => {
  'use strict';
  const page = document.body.dataset.dashboardPage;
  const routes = JSON.parse(document.body.dataset.customerRoutes || '{}');
  document.querySelectorAll('.side-link').forEach(link => link.classList.toggle('active', link.dataset.pageTarget === page));
  document.addEventListener('click', event => {
    const logout = event.target.closest('[data-action="logout"]');
    if (logout) {
      const form = document.createElement('form');
      form.method = 'post'; form.action = '/logout';
      const token = document.createElement('input');
      token.type = 'hidden'; token.name = '_csrf';
      token.value = document.querySelector('meta[name="csrf-token"]').content;
      form.append(token); document.body.append(form); form.submit();
      return;
    }
    const anchor = event.target.closest('a[href^="#"]');
    if (anchor && !anchor.dataset.pageTarget) {
      const destination = document.getElementById(anchor.getAttribute('href').slice(1));
      if (destination) { event.preventDefault(); destination.scrollIntoView({behavior:'smooth',block:'start'}); }
    }
    const target = event.target.closest('[data-page-target]');
    if (target) {
      event.preventDefault();
      const destination = target.dataset.profileTab === 'security' ? '/account/security' : routes[target.dataset.pageTarget];
      if (destination) location.assign(destination);
    }
    const filter = event.target.closest('[data-notification-filter]');
    if (filter) {
      const category = filter.dataset.notificationFilter;
      document.querySelectorAll('[data-notification-filter]').forEach(button => button.classList.toggle('active', button === filter));
      document.querySelectorAll('[data-notification-type]').forEach(row => { row.hidden = category !== 'all' && !row.dataset.notificationType.toLowerCase().includes(category); });
    }
    const tab = event.target.closest('[data-settings-tab]');
    if (tab) {
      document.querySelectorAll('[data-settings-tab]').forEach(button => button.classList.toggle('active', button === tab));
      document.querySelectorAll('[data-settings-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.settingsPanel === tab.dataset.settingsTab));
    }
  });
  document.getElementById('classicAiBtn')?.addEventListener('click', () => location.assign('/ask-classic'));
  document.querySelectorAll('[data-order-filter]').forEach(button => button.addEventListener('click', () => {
    const status = button.dataset.orderFilter;
    document.querySelectorAll('[data-order-filter]').forEach(tab => {
      const active = tab === button; tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', String(active));
    });
    const rows = [...document.querySelectorAll('[data-order-group]')];
    rows.forEach(row => { row.hidden = status !== 'all' && row.dataset.orderGroup !== status; });
    const empty = document.getElementById('orderFilterEmpty');
    if (empty) empty.hidden = status === 'all' || rows.some(row => !row.hidden);
    document.querySelector('.rich-order-list > .empty-state:not(#orderFilterEmpty)')?.toggleAttribute('hidden', status !== 'all');
  }));
  const search = document.getElementById('searchForm');
  search?.addEventListener('submit', event => {
    event.preventDefault();
    const value = document.getElementById('searchInput').value.trim();
    if (value) location.assign('/search?q=' + encodeURIComponent(value));
  });
})();

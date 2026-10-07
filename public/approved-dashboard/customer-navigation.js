(() => {
  'use strict';
  const page = document.body.dataset.dashboardPage;
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
    const target = event.target.closest('[data-page-target]');
    if (target) {
      event.preventDefault();
      location.assign(target.dataset.profileTab === 'security' ? '/account/security' : '/dashboard/' + encodeURIComponent(target.dataset.pageTarget));
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
  const search = document.getElementById('searchForm');
  search?.addEventListener('submit', event => {
    event.preventDefault();
    const value = document.getElementById('searchInput').value.trim();
    if (value) location.assign('/search?q=' + encodeURIComponent(value));
  });
})();

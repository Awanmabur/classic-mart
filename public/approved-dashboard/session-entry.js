(() => {
  'use strict';
  const { dashboardWorkspace: workspace, dashboardPage: page } = document.body.dataset;
  // The server-selected account workspace wins over another user's preview preferences.
  localStorage.setItem('classicMartWorkspace', workspace);
  history.replaceState(null, '', '#' + page);
})();

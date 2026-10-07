(() => {
  'use strict';
  const { dashboardWorkspace: workspace, dashboardPage: page } = document.body.dataset;
  // The server-selected account workspace wins over another user's preview preferences.
  localStorage.setItem('classicMartWorkspace', workspace);
  if (workspace === 'customer') {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  } else {
    history.replaceState(null, '', '#' + page);
  }
})();

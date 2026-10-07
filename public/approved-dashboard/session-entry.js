(() => {
  'use strict';
  const { dashboardWorkspace: workspace, dashboardPage: page } = document.body.dataset;
  if (workspace === 'customer' || document.body.dataset.dashboardLive === 'true') {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    return;
  }
  // Preview preferences never select a live account's workspace.
  try { localStorage.setItem('classicMartWorkspace', workspace); } catch {}
  history.replaceState(null, '', '#' + page);
})();

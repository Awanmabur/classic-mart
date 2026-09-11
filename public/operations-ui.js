(() => {
  'use strict';

  function enhanceTable(table) {
    if (!table || table.classList.contains('mobile-ops-table')) return;
    const headers = Array.from(table.querySelectorAll('thead th')).map((cell) => cell.textContent.trim());
    if (!headers.length) return;
    table.classList.add('ops-responsive-table');
    for (const row of table.querySelectorAll('tbody tr')) {
      Array.from(row.cells).forEach((cell, index) => {
        if (cell.hasAttribute('colspan')) {
          cell.dataset.label = '';
          return;
        }
        if (!cell.dataset.label) cell.dataset.label = headers[index] || '';
      });
    }
  }

  function boot() {
    if (document.body?.dataset.operationsUi !== 'true') return;
    document.querySelectorAll('.table-wrap table, .catalogue-table-wrap table, .role-table-wrap table').forEach(enhanceTable);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();

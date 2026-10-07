(() => {
  const menuButton = document.getElementById('mobileMenuBtn');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');

  if (!menuButton || !sidebar || !overlay) return;

  const setOpen = (open) => {
    sidebar.classList.toggle('open', open);
    overlay.classList.toggle('show', open);
    menuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.classList.toggle('sidebar-open', open);
  };

  menuButton.setAttribute('aria-controls', 'sidebar');
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.addEventListener('click', () => setOpen(!sidebar.classList.contains('open')));
  overlay.addEventListener('click', () => setOpen(false));

  sidebar.addEventListener('click', (event) => {
    if (event.target.closest('a, button[type="submit"]')) setOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && sidebar.classList.contains('open')) {
      setOpen(false);
      menuButton.focus();
    }
  });
})();

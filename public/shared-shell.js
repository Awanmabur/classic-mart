(() => {
  const form = document.querySelector('#searchForm');
  if (form) {
    form.addEventListener('submit', (event) => {
      // Catalogue pages process the exact homepage search form in catalog-page.js.
      if (document.body.classList.contains('catalog-body')) return;
      event.preventDefault();
      const query = document.querySelector('#searchInput')?.value.trim();
      const category = document.querySelector('#searchCategory')?.value;
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (category && category !== 'all') params.set('category', category);
      window.location.href = `/products${params.toString() ? `?${params}` : ''}`;
    });
  }

  function ensureMobileBottomNav() {
    if (document.querySelector('.mobile-bottom-nav')) return;
    const nav = document.createElement('nav');
    nav.className = 'mobile-bottom-nav';
    nav.setAttribute('aria-label', 'Mobile navigation');
    const current = window.location.pathname;
    const items = [
      ['/', 'house.svg', 'Home', ''],
      ['/categories', 'table-cells-large.svg', 'Categories', ''],
      ['/signup?role=seller', 'plus.svg', 'Sell', 'mobile-bottom-nav__sell'],
      ['/wishlist', 'heart-regular.svg', 'Wishlist', ''],
      ['/dashboard', 'user.svg', 'Profile', ''],
    ];
    nav.innerHTML = items.map(([href, icon, label, extraClass]) => {
      const active = !extraClass && (href === '/' ? current === '/' : current === href || current.startsWith(`${href}/`));
      const classes = [active ? 'active' : '', extraClass].filter(Boolean).join(' ');
      return `<a href="${href}" class="${classes}" ${active ? 'aria-current="page"' : ''}${extraClass ? ' aria-label="Sell on Classic Mart"' : ''}><img alt="" aria-hidden="true" src="/assets/icons/${icon}"><span>${label}</span></a>`;
    }).join('');
    document.body.appendChild(nav);

    let revealTimer = 0;
    const reveal = () => nav.classList.remove('is-scrolling');
    window.addEventListener('scroll', () => {
      if (window.innerWidth > 760) return;
      nav.classList.add('is-scrolling');
      window.clearTimeout(revealTimer);
      revealTimer = window.setTimeout(reveal, 420);
    }, { passive: true });
    window.addEventListener('resize', () => {
      if (window.innerWidth > 760) reveal();
    }, { passive: true });
  }
  ensureMobileBottomNav();

  // The homepage browse button opens its panel; internal pages open the full Categories page.
  document.querySelector('#menuToggle')?.addEventListener('click', () => {
    window.location.href = '/categories';
  });




  async function loadSharedCatalogue() {
    if (!window.ClassicMartSharedCataloguePromise) {
      window.ClassicMartSharedCataloguePromise = fetch('/api/v1/storefront/catalogue', {
        credentials: 'same-origin', headers: { Accept: 'application/json' },
      }).then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error?.message || 'Marketplace catalogue unavailable.');
        return payload;
      });
    }
    try {
      const catalogue = await window.ClassicMartSharedCataloguePromise;
      const categorySelect = document.querySelector('#searchCategory');
      if (categorySelect && Array.isArray(catalogue.categories)) {
        const selected = categorySelect.value || 'all';
        categorySelect.innerHTML = '<option value="all">All Categories</option>' + catalogue.categories.map((category) => `<option value="${String(category.id || category.slug || '').replace(/"/g, '&quot;')}">${String(category.name || '')}</option>`).join('');
        if ([...categorySelect.options].some((option) => option.value === selected)) categorySelect.value = selected;
      }
      document.querySelectorAll('a[href="/categories"] .tiny-badge').forEach((badge) => { badge.textContent = String(catalogue.categories?.length || 0); });
      return catalogue;
    } catch {
      return null;
    }
  }
  loadSharedCatalogue();

  async function updateWishlistBadges() {
    try {
      const response = await fetch('/api/v1/storefront/state', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return;
      const payload = await response.json();
      const count = payload.state?.wishlist?.length || 0;
      document.querySelectorAll('[data-wishlist-count]').forEach(badge => {
        badge.textContent = String(count);
      });
    } catch {
      // Navigation and all other storefront controls remain available offline.
    }
  }
  updateWishlistBadges();

  if (window.ClassicMartCart) {
    window.ClassicMartCart.decorateLinks();
  } else {
    const badge = document.querySelector('#cartCount');
    if (badge) badge.textContent = '0';
  }

  const pageRoutes = {
    sellerModal: '/signup?role=seller', trackModal: '/track-order', helpModal: '/help',
    aboutModal: '/about', blogModal: '/press', policyModal: '/privacy', locationModal: '/?location=1#top'
  };
  document.querySelectorAll('[data-open]').forEach(button => {
    button.addEventListener('click', () => { window.location.href = pageRoutes[button.dataset.open] || '/#top'; });
  });
})();

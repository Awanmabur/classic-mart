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
      window.location.href = `products.html${params.toString() ? `?${params}` : ''}`;
    });
  }

  const mobileSearchButton = document.querySelector('#mobileSearchButton');
  mobileSearchButton?.addEventListener('click', () => {
    const search = document.querySelector('#searchForm');
    if (!search) return;
    search.classList.toggle('mobile-open');
    if (search.classList.contains('mobile-open')) {
      document.querySelector('#searchInput')?.focus();
    }
  });

  document.addEventListener('click', (event) => {
    if (window.innerWidth > 760) return;
    const search = document.querySelector('#searchForm.mobile-open');
    if (!search) return;
    if (!search.contains(event.target) && !event.target.closest('#mobileSearchButton')) {
      search.classList.remove('mobile-open');
    }
  });

  // The homepage browse button opens its panel; internal pages open the full Categories page.
  document.querySelector('#menuToggle')?.addEventListener('click', () => {
    window.location.href = 'categories.html';
  });


  function updateWishlistBadges() {
    let count = 0;
    try { const value = JSON.parse(localStorage.getItem('shophub-wishlist') || '[]'); count = Array.isArray(value) ? value.length : 0; } catch {}
    document.querySelectorAll('[data-wishlist-count]').forEach(badge => { badge.textContent = String(count); });
  }
  updateWishlistBadges();
  window.addEventListener('storage', updateWishlistBadges);
  window.addEventListener('classic-mart-wishlist-change', updateWishlistBadges);

  if (window.ClassicMartCart) {
    window.ClassicMartCart.decorateLinks();
  } else {
    try {
      const raw = JSON.parse(localStorage.getItem('shophub-cart') || '{}');
      const count = Object.values(raw).reduce((sum, value) => sum + (Number(value?.quantity ?? value?.qty ?? value) || 0), 0);
      const badge = document.querySelector('#cartCount');
      if (badge) badge.textContent = String(count);
    } catch { /* cart-store.js handles normal operation */ }
  }

  document.querySelector('#subscribeForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    const original = button.textContent;
    button.textContent = 'Subscribed';
    event.currentTarget.reset();
    setTimeout(() => { button.textContent = original; }, 1800);
  });

  const pageRoutes = {
    sellerModal: 'signup.html?role=seller', trackModal: 'track-order.html', helpModal: 'help.html',
    aboutModal: 'about.html', blogModal: 'press.html', policyModal: 'privacy.html', locationModal: 'index.html#top'
  };
  document.querySelectorAll('[data-open]').forEach(button => {
    button.addEventListener('click', () => { window.location.href = pageRoutes[button.dataset.open] || 'index.html#top'; });
  });
})();

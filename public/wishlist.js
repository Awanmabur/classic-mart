(() => {
  'use strict';

  const qs = (selector) => document.querySelector(selector);
  let products = [];
  let recommendations = [];
  let csrfToken = '';
  let sort = 'recent';

  const escapeHtml = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#039;',
        })[character],
    );

  function money(value, currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
      }).format(value);
    } catch {
      return `${currency} ${Number(value || 0).toLocaleString()}`;
    }
  }

  function toast(message) {
    const element = qs('#pageToast');
    if (!element) return;
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => element.classList.remove('show'), 2_200);
  }

  function card(product, canRemove = true) {
    const saving = Math.max(0, product.oldPrice - product.price);
    return `<article class="wishlist-card">
      <a class="wishlist-card-image" href="/products/${encodeURIComponent(product.id)}"><img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='/assets/product-placeholder.svg'"></a>
      ${canRemove ? `<button class="wishlist-remove" data-remove-wishlist="${escapeHtml(product.id)}" aria-label="Remove ${escapeHtml(product.name)}"><img src="/assets/icons/xmark.svg" alt=""></button>` : ''}
      <div class="wishlist-card-body">
        <span class="wishlist-card-badge">${product.stock > 0 ? 'In stock' : 'Unavailable'}</span>
        <h3>${escapeHtml(product.name)}</h3>
        <p class="wishlist-card-subtitle">${escapeHtml(product.subtitle)} · ${escapeHtml(product.brand)}</p>
        <div class="wishlist-rating"><b>★</b><span>${product.reviews ? `${product.rating.toFixed(1)} (${product.reviews.toLocaleString()})` : 'No reviews yet'}</span></div>
        <div class="wishlist-pricing"><strong>${money(product.price, product.currency)}</strong></div>
        <div class="wishlist-card-actions">
          <button data-wishlist-cart="${escapeHtml(product.id)}" ${product.stock < 1 ? 'disabled' : ''}><img src="/assets/icons/cart-plus.svg" alt="">Add to cart</button>
          <a href="/products/${encodeURIComponent(product.id)}" aria-label="View ${escapeHtml(product.name)}"><img src="/assets/icons/chevron-right.svg" alt=""></a>
        </div>
      </div>
    </article>`;
  }

  function sorted(list) {
    return [...list].sort((a, b) => {
      if (sort === 'price-low') return a.price - b.price;
      if (sort === 'price-high') return b.price - a.price;
      if (sort === 'rating') return b.rating - a.rating;
      if (sort === 'saving') {
        return b.oldPrice - b.price - (a.oldPrice - a.price);
      }
      return 0;
    });
  }

  function render() {
    const list = sorted(products);
    qs('#wishlistGrid').innerHTML = list.map((product) => card(product)).join('');
    qs('#wishlistGrid').hidden = !list.length;
    qs('#wishlistEmpty').hidden = Boolean(list.length);
    qs('#wishlistTotal').textContent = String(list.length);
    const savingsByCurrency = new Map();
    for (const product of list) {
      savingsByCurrency.set(
        product.currency,
        (savingsByCurrency.get(product.currency) || 0) +
          Math.max(0, product.oldPrice - product.price),
      );
    }
    qs('#wishlistSavings').textContent =
      [...savingsByCurrency.entries()]
        .map(([currency, value]) => money(value, currency))
        .join(' + ') || money(0, 'UGX');
    qs('#wishlistAvailable').textContent = String(
      list.filter((product) => product.stock > 0).length,
    );
    qs('#wishlistRecommendations').innerHTML = recommendations
      .slice(0, 4)
      .map((product) => card(product, false))
      .join('');
    document.querySelectorAll('[data-wishlist-count]').forEach((badge) => {
      badge.textContent = String(list.length);
    });
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: {
        Accept: 'application/json',
        'x-csrf-token': csrfToken,
        ...(options.headers || {}),
      },
    });
    if (response.status === 401) {
      location.href = `/login?next=${encodeURIComponent('/wishlist')}`;
      throw new Error('Authentication required');
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error?.message || 'Request failed.');
    }
    return payload;
  }

  async function load() {
    try {
      const payload = await api('/api/v1/storefront/state');
      if (!payload.authenticated) { location.href = `/login?next=${encodeURIComponent('/wishlist')}`; throw new Error('Authentication required'); }
      products = payload.state.wishlistProducts || [];
      recommendations = payload.state.recommendations || [];
      csrfToken = payload.csrfToken || '';
      render();
    } catch (error) {
      if (error.message !== 'Authentication required') toast(error.message);
    }
  }

  async function addCart(product, button) {
    if (!product || !window.ClassicMartCart) return false;
    if (button?.disabled) return false;
    const previous = button?.innerHTML || '';
    if (button) { button.disabled = true; button.textContent = 'Adding…'; }
    try {
      await window.ClassicMartCart.add(product, 1);
      toast(`${product.name} added to cart`);
      if (button) button.textContent = 'Added ✓';
      return true;
    } catch (error) {
      toast(error.message || 'Product could not be added.');
      return false;
    } finally {
      if (button) setTimeout(() => {
        if (!document.body.contains(button)) return;
        button.disabled = Number(product.stock || 0) < 1;
        button.innerHTML = previous;
      }, 900);
    }
  }

  document.addEventListener('click', async (event) => {
    const remove = event.target.closest('[data-remove-wishlist]');
    if (remove) {
      try {
        await api(
          `/api/v1/storefront/wishlist/${encodeURIComponent(remove.dataset.removeWishlist)}`,
          { method: 'DELETE' },
        );
        products = products.filter(
          (product) => product.id !== remove.dataset.removeWishlist,
        );
        render();
        toast('Product removed from wishlist');
      } catch (error) {
        toast(error.message);
      }
      return;
    }
    const cart = event.target.closest('[data-wishlist-cart]');
    if (cart) {
      await addCart(products.find((product) => product.id === cart.dataset.wishlistCart), cart);
    }
  });

  qs('#wishlistSort')?.addEventListener('change', (event) => {
    sort = event.target.value;
    render();
  });
  qs('#clearWishlist')?.addEventListener('click', async () => {
    try {
      await api('/api/v1/storefront/wishlist', { method: 'DELETE' });
      products = [];
      render();
      toast('Wishlist cleared');
    } catch (error) {
      toast(error.message);
    }
  });
  qs('#addAllWishlist')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const available = products.filter((product) => product.stock > 0);
    if (!available.length) { toast('No wishlist products are currently available.'); return; }
    button.disabled = true;
    const previous = button.textContent;
    button.textContent = 'Adding…';
    let added = 0;
    for (const product of available) if (await addCart(product)) added += 1;
    button.disabled = false;
    button.textContent = previous;
    if (added) toast(`${added} wishlist product${added === 1 ? '' : 's'} added to cart`);
  });
  load();
})();

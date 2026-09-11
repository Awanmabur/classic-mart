(() => {
  'use strict';

  const qs = (selector) => document.querySelector(selector);
  let products = [];
  let csrfToken = '';

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

  function render() {
    qs('#compareTotal').textContent = String(products.length);
    qs('#compareAvailable').textContent = String(
      products.filter((product) => product.stock > 0).length,
    );
    qs('#compareGrid').hidden = products.length === 0;
    qs('#compareEmpty').hidden = products.length > 0;
    qs('#compareGrid').innerHTML = products
      .map(
        (product) => `
        <article class="wishlist-card">
          <a class="wishlist-card-image" href="/products/${encodeURIComponent(product.id)}"><img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='/assets/product-placeholder.svg'"></a>
          <button class="wishlist-remove" data-remove-comparison="${escapeHtml(product.id)}" aria-label="Remove ${escapeHtml(product.name)}"><img src="/assets/icons/xmark.svg" alt=""></button>
          <div class="wishlist-card-body">
            <span class="wishlist-card-badge">${product.stock > 0 ? `${product.stock} in stock` : 'Unavailable'}</span>
            <h3>${escapeHtml(product.name)}</h3>
            <p class="wishlist-card-subtitle">${escapeHtml(product.brand)} · ${escapeHtml(product.categoryName)}</p>
            <div class="wishlist-rating"><b>★</b><span>${product.reviews ? `${product.rating.toFixed(1)} (${product.reviews.toLocaleString()})` : 'No reviews yet'}</span></div>
            <div class="wishlist-pricing"><strong>${money(product.price, product.currency)}</strong></div>
            <p class="wishlist-card-subtitle">Seller: ${escapeHtml(product.seller.name)}</p>
            <div class="wishlist-card-actions"><a href="/products/${encodeURIComponent(product.id)}">View details</a></div>
          </div>
        </article>`,
      )
      .join('');
  }

  async function load() {
    const response = await fetch('/api/v1/storefront/state', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    const payload = await response.json();
    if (!response.ok) return;
    if (!payload.authenticated) { location.href = `/login?next=${encodeURIComponent('/compare')}`; return; }
    products = payload.state.comparisonProducts || [];
    csrfToken = payload.csrfToken || '';
    render();
  }

  document.addEventListener('click', async (event) => {
    const remove = event.target.closest('[data-remove-comparison]');
    if (!remove) return;
    const response = await fetch(
      `/api/v1/storefront/comparison/${encodeURIComponent(remove.dataset.removeComparison)}`,
      {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'x-csrf-token': csrfToken,
        },
      },
    );
    if (!response.ok) return;
    products = products.filter(
      (product) => product.id !== remove.dataset.removeComparison,
    );
    render();
  });

  load();
})();

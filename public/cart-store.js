(() => {
  'use strict';

  // The browser keeps only an in-memory projection for rendering. MongoDB is the
  // source of truth for cart contents; page reloads always rehydrate from /api/v1/cart.
  let items = [];
  let serverCart = null;
  let csrfToken = '';
  let initialized = false;
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });

  const asId = (value) => String(value?.id ?? value?.product?.variantId ?? value?.product?.id ?? value ?? '');

  function normalizeServerItems(cart) {
    return (cart?.items || []).map((item) => ({
      id: item.variantId,
      quantity: Number(item.quantity) || 0,
      product: {
        id: item.productId,
        cartLineId: item.variantId,
        variantId: item.variantId,
        currency: item.currency || cart?.totals?.currency || 'UGX',
        name: item.name,
        subtitle: item.variant,
        category: 'product',
        brand: item.brand || 'Classic Mart',
        image: item.image || '/assets/product-placeholder.svg',
        images: item.image ? [item.image] : [],
        price: Number(item.price) || 0,
        oldPrice: Number(item.price) || 0,
        rating: Number(item.rating) || 0,
        reviews: Number(item.reviews) || 0,
        stock: Number(item.available) || 0,
        shippingInformation: 'Delivery options are calculated by the server at checkout',
      },
    })).filter((item) => item.id && item.quantity > 0);
  }

  function emit() {
    try {
      window.dispatchEvent(new CustomEvent('classicmart:cartchange', { detail: { items: getItems() } }));
    } catch { /* older browsers can still render from direct calls */ }
    updateBadges();
  }

  function setProjection(cart, notify = true) {
    serverCart = cart || null;
    items = normalizeServerItems(cart);
    if (notify) emit();
    return getItems();
  }

  function getItems() {
    return items.map((item) => ({ ...item, product: { ...item.product } }));
  }


  function getServerTotals() { return serverCart?.totals ? { ...serverCart.totals } : null; }
  function getPromotions() { return Array.isArray(serverCart?.promotions) ? serverCart.promotions.map((row) => ({ ...row })) : []; }

  function count() {
    return items.reduce((total, item) => total + item.quantity, 0);
  }

  function asLegacyCart() {
    return items.reduce((result, item) => {
      result[asId(item)] = item.quantity;
      return result;
    }, {});
  }

  async function request(path, options = {}) {
    if (!initialized) await ready;
    const method = options.method || 'GET';
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken) headers['x-csrf-token'] = csrfToken;
    const response = await fetch(path, { credentials: 'same-origin', ...options, method, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || 'Cart request failed.');
    if (payload.csrfToken) csrfToken = payload.csrfToken;
    if (payload.cart) setProjection(payload.cart);
    return payload;
  }

  async function refresh() {
    const response = await fetch('/api/v1/cart', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || 'Cart could not be loaded.');
    csrfToken = payload.csrfToken || csrfToken;
    setProjection(payload.cart);
    return getItems();
  }

  async function initialize() {
    try {
      await refresh();
    } catch (error) {
      console.error('Classic Mart server cart could not be loaded.', error);
      items = [];
      emit();
    } finally {
      initialized = true;
      readyResolve();
    }
  }

  async function add(product, quantity = 1) {
    const productId = String(product?.id || '');
    const variantId = String(product?.variantId || product?.variants?.[0]?.id || '');
    if (!productId) throw new Error('Product is unavailable.');
    const payload = await request('/api/v1/cart/items', {
      method: 'POST',
      body: JSON.stringify({ productId, ...(variantId ? { variantId } : {}), quantity: Math.max(1, Number(quantity) || 1) }),
    });
    return setProjection(payload.cart);
  }

  async function setQuantity(idValue, quantity) {
    const id = String(idValue || '');
    const item = items.find((entry) => String(entry.id) === id || String(entry.product?.variantId) === id);
    if (!item) return getItems();
    const next = Math.max(0, Math.min(99, Number(quantity) || 0));
    const variantId = String(item.product?.variantId || '');
    if (!variantId) throw new Error('Cart item variant is unavailable.');
    const payload = next === 0
      ? await request(`/api/v1/cart/items/${encodeURIComponent(variantId)}`, { method: 'DELETE' })
      : await request(`/api/v1/cart/items/${encodeURIComponent(variantId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ quantity: next }),
        });
    return setProjection(payload.cart);
  }

  async function remove(idValue) {
    return setQuantity(idValue, 0);
  }

  async function clear() {
    const payload = await request('/api/v1/cart', { method: 'DELETE' });
    return setProjection(payload.cart);
  }

  function updateBadges() {
    const total = count();
    document.querySelectorAll('#cartCount, [data-cart-count]').forEach((element) => { element.textContent = total; });
  }

  function decorateLinks() {
    document.querySelectorAll('a[href="/cart"], a[href^="/cart?"], a[data-cart-link]').forEach((link) => {
      link.setAttribute('href', '/cart');
    });
    updateBadges();
  }

  function navigate() { window.location.assign('/cart'); }
  function cartUrl() { return '/cart'; }
  function getCsrfToken() { return csrfToken; }

  // replace() intentionally does not mutate server state. It remains only as a
  // compatibility rendering helper and is not exposed as an authority path.
  function replace(serverItems) {
    items = Array.isArray(serverItems) ? serverItems : [];
    emit();
    return getItems();
  }

  window.ClassicMartCart = {
    getItems, replace, add, setQuantity, remove, clear, count,
    asLegacyCart, cartUrl, getCsrfToken, navigate, decorateLinks, updateBadges,
    refresh, ready, getServerTotals, getPromotions,
  };

  initialize();
  document.addEventListener('DOMContentLoaded', decorateLinks);
  window.addEventListener('classicmart:cartchange', decorateLinks);
  window.addEventListener('pageshow', () => { refresh().catch(() => {}); decorateLinks(); });
})();

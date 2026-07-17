(() => {
  'use strict';

  const STORE_KEY = 'classic-mart-cart-v4';
  const LEGACY_CART_KEY = 'shophub-cart';
  const LEGACY_PRODUCT_KEY = 'classic-mart-cart-products';
  const BRIDGE_PREFIX = 'classic-mart-state:';
  let locationConsumed = false;


  function getStorage(name) {
    try { return window[name]; } catch { return null; }
  }

  const storageGet = (storage, key) => {
    try {
      const raw = storage?.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  };

  const storageSet = (storage, key, value) => {
    try { storage?.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  };

  function bridgeRead() {
    try {
      if (!window.name || !window.name.startsWith(BRIDGE_PREFIX)) return {};
      return JSON.parse(window.name.slice(BRIDGE_PREFIX.length)) || {};
    } catch { return {}; }
  }

  function bridgeWrite(key, value) {
    try {
      const state = bridgeRead();
      state[key] = value;
      window.name = BRIDGE_PREFIX + JSON.stringify(state);
      return true;
    } catch { return false; }
  }

  function asId(value) {
    const raw = value?.id ?? value?.product?.id ?? value;
    if (raw === null || raw === undefined || raw === '') return '';
    return String(raw);
  }

  function cleanProduct(product, fallbackId) {
    const source = product && typeof product === 'object' ? product : {};
    const idRaw = source.id ?? fallbackId;
    const numeric = Number(idRaw);
    const id = Number.isFinite(numeric) && String(idRaw).trim() !== '' ? numeric : String(idRaw || fallbackId || '');
    return {
      id,
      name: String(source.name || source.title || `Classic Mart product ${id}`),
      subtitle: String(source.subtitle || source.description || 'Marketplace item'),
      category: String(source.category || 'product'),
      brand: String(source.brand || 'Classic Mart'),
      image: String(source.image || source.thumbnail || source.images?.[0] || 'assets/product-placeholder.svg'),
      images: Array.isArray(source.images) ? source.images.slice(0, 6) : [],
      price: Number(source.price) || 0,
      oldPrice: Number(source.oldPrice) || Number(source.price) || 0,
      rating: Number(source.rating) || 4.5,
      reviews: Number(source.reviews) || 0,
      stock: Number(source.stock) || 1,
      shippingInformation: String(source.shippingInformation || 'Ready for marketplace delivery')
    };
  }

  function normalizeItems(raw) {
    const source = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];
    const map = new Map();
    source.forEach(entry => {
      const id = asId(entry);
      const quantity = Math.max(0, Math.min(99, Number(entry?.quantity ?? entry?.qty ?? 1) || 0));
      if (!id || quantity <= 0) return;
      const product = cleanProduct(entry?.product || entry, id);
      const previous = map.get(id);
      map.set(id, {
        id: product.id,
        quantity: Math.max(quantity, previous?.quantity || 0),
        product: previous?.product?.price ? previous.product : product
      });
    });
    return [...map.values()];
  }

  function encode(value) {
    try {
      const json = JSON.stringify(value);
      const bytes = new TextEncoder().encode(json);
      let binary = '';
      bytes.forEach(byte => { binary += String.fromCharCode(byte); });
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    } catch {
      try { return btoa(unescape(encodeURIComponent(JSON.stringify(value)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
      catch { return ''; }
    }
  }

  function decode(value) {
    if (!value) return null;
    try {
      const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      try { return JSON.parse(decodeURIComponent(escape(atob(value)))); }
      catch { return null; }
    }
  }

  function payloadFromLocation() {
    try {
      const query = new URLSearchParams(window.location.search || '');
      const encoded = query.get('cmcart');
      if (encoded) return normalizeItems(decode(encoded));

      const hash = String(window.location.hash || '').replace(/^#/, '');
      if (hash.startsWith('cmcart=')) return normalizeItems(decode(hash.slice(7)));

      const legacy = query.get('cartData') || query.get('cart') || query.get('items');
      if (legacy) {
        try { return normalizeItems(JSON.parse(legacy)); }
        catch {
          try { return normalizeItems(JSON.parse(decodeURIComponent(legacy))); }
          catch { return []; }
        }
      }
    } catch { /* storage sources remain available */ }
    return null;
  }

  function legacyItems() {
    const cart = storageGet(getStorage('localStorage'), LEGACY_CART_KEY)
      || storageGet(getStorage('sessionStorage'), LEGACY_CART_KEY)
      || bridgeRead()[LEGACY_CART_KEY]
      || {};
    const snapshots = storageGet(getStorage('localStorage'), LEGACY_PRODUCT_KEY)
      || storageGet(getStorage('sessionStorage'), LEGACY_PRODUCT_KEY)
      || bridgeRead()[LEGACY_PRODUCT_KEY]
      || {};

    if (Array.isArray(cart)) return normalizeItems(cart);
    if (!cart || typeof cart !== 'object') return [];
    return normalizeItems(Object.entries(cart).map(([id, value]) => ({
      id,
      quantity: Number(value?.quantity ?? value?.qty ?? value) || 0,
      product: snapshots[id] || snapshots[Number(id)] || value?.product || { id }
    })));
  }

  function persistedItems() {
    const candidates = [
      storageGet(getStorage('localStorage'), STORE_KEY),
      storageGet(getStorage('sessionStorage'), STORE_KEY),
      bridgeRead()[STORE_KEY],
      legacyItems()
    ];
    for (const candidate of candidates) {
      const items = normalizeItems(candidate);
      if (items.length) return items;
    }
    return [];
  }

  function save(items, notify = true) {
    const normalized = normalizeItems(items);
    storageSet(getStorage('localStorage'), STORE_KEY, normalized);
    storageSet(getStorage('sessionStorage'), STORE_KEY, normalized);
    bridgeWrite(STORE_KEY, normalized);

    const legacyCart = {};
    const snapshots = {};
    normalized.forEach(item => {
      const id = asId(item);
      legacyCart[id] = item.quantity;
      snapshots[id] = item.product;
    });
    storageSet(getStorage('localStorage'), LEGACY_CART_KEY, legacyCart);
    storageSet(getStorage('localStorage'), LEGACY_PRODUCT_KEY, snapshots);
    storageSet(getStorage('sessionStorage'), LEGACY_CART_KEY, legacyCart);
    storageSet(getStorage('sessionStorage'), LEGACY_PRODUCT_KEY, snapshots);
    bridgeWrite(LEGACY_CART_KEY, legacyCart);
    bridgeWrite(LEGACY_PRODUCT_KEY, snapshots);

    if (notify) {
      try { window.dispatchEvent(new CustomEvent('classicmart:cartchange', { detail: { items: normalized } })); } catch { /* optional */ }
    }
    return normalized;
  }

  function getItems() {
    if (!locationConsumed) {
      locationConsumed = true;
      const transferred = payloadFromLocation();
      if (transferred && transferred.length) return save(transferred, false);
    }
    return persistedItems();
  }

  function replace(items) { return save(items); }

  function add(product, quantity = 1) {
    const itemProduct = cleanProduct(product, product?.id);
    const id = asId(itemProduct);
    if (!id) return getItems();
    const items = getItems();
    const existing = items.find(item => asId(item) === id);
    if (existing) {
      existing.quantity = Math.min(99, existing.quantity + Math.max(1, Number(quantity) || 1));
      existing.product = itemProduct;
    } else {
      items.push({ id: itemProduct.id, quantity: Math.max(1, Number(quantity) || 1), product: itemProduct });
    }
    return save(items);
  }

  function setQuantity(idValue, quantity) {
    const id = asId(idValue);
    const items = getItems();
    const item = items.find(entry => asId(entry) === id);
    if (!item) return items;
    const next = Math.max(0, Math.min(99, Number(quantity) || 0));
    if (!next) return save(items.filter(entry => asId(entry) !== id));
    item.quantity = next;
    return save(items);
  }

  function remove(idValue) {
    const id = asId(idValue);
    return save(getItems().filter(item => asId(item) !== id));
  }

  function clear() { return save([]); }

  function count() { return getItems().reduce((total, item) => total + item.quantity, 0); }

  function asLegacyCart() {
    return getItems().reduce((result, item) => {
      result[asId(item)] = item.quantity;
      return result;
    }, {});
  }

  function cartUrl() {
    const items = getItems();
    if (!items.length) return 'cart.html';
    const payload = encode({ version: 4, items });
    return payload ? `cart.html?cmcart=${payload}` : 'cart.html';
  }

  function updateBadges() {
    const total = count();
    document.querySelectorAll('#cartCount, [data-cart-count]').forEach(element => { element.textContent = total; });
  }

  function decorateLinks() {
    const href = cartUrl();
    document.querySelectorAll('a[href^="cart.html"], a[data-cart-link]').forEach(link => { link.setAttribute('href', href); });
    updateBadges();
  }

  function navigate() { window.location.assign(cartUrl()); }

  window.ClassicMartCart = {
    getItems, replace, add, setQuantity, remove, clear, count,
    asLegacyCart, cartUrl, navigate, decorateLinks, updateBadges,
    encode, decode, normalizeItems
  };

  document.addEventListener('DOMContentLoaded', decorateLinks);
  window.addEventListener('classicmart:cartchange', decorateLinks);
  window.addEventListener('pageshow', decorateLinks);

  document.addEventListener('click', event => {
    const link = event.target.closest?.('a[href^="cart.html"], a[data-cart-link]');
    if (!link || event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const current = String(window.location.pathname || '').split('/').pop();
    if (current === 'cart.html') return;
    event.preventDefault();
    navigate();
  }, true);
})();

(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];

  const bridgePrefix = 'classic-mart-state:';

  function bridgeState() {
    try {
      if (!window.name || !window.name.startsWith(bridgePrefix)) return {};
      return JSON.parse(window.name.slice(bridgePrefix.length)) || {};
    } catch { return {}; }
  }

  function read(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      if (value) return JSON.parse(value);
    } catch { /* use same-tab bridge */ }
    const bridge = bridgeState();
    return Object.prototype.hasOwnProperty.call(bridge, key) ? bridge[key] : fallback;
  }

  function write(key, value) {
    let stored = false;
    try { localStorage.setItem(key, JSON.stringify(value)); stored = true; } catch { /* local-file storage can be isolated */ }
    try {
      const bridge = bridgeState();
      bridge[key] = value;
      window.name = bridgePrefix + JSON.stringify(bridge);
      stored = true;
    } catch { /* current in-memory cart still works */ }
    return stored;
  }

  function sessionRead(key, fallback = null) {
    try { return sessionStorage.getItem(key) ?? fallback; } catch { return fallback; }
  }
  function sessionWrite(key, value) {
    try { sessionStorage.setItem(key, value); } catch { /* optional enhancement */ }
  }
  function sessionRemove(key) {
    try { sessionStorage.removeItem(key); } catch { /* optional enhancement */ }
  }

  function money(value) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value) || 0);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' })[character]);
  }

  function normalizeCart(raw) {
    if (Array.isArray(raw)) {
      return raw.reduce((result, item) => {
        const id = Number(item?.id ?? item?.product?.id);
        const quantity = Number(item?.quantity ?? item?.qty ?? 1);
        if (id && quantity > 0) result[id] = quantity;
        return result;
      }, {});
    }
    if (!raw || typeof raw !== 'object') return {};
    return Object.entries(raw).reduce((result, [key, value]) => {
      const id = Number(value?.id ?? value?.product?.id ?? key);
      const quantity = Number(value?.quantity ?? value?.qty ?? value);
      if (id && quantity > 0) result[id] = quantity;
      return result;
    }, {});
  }

  function decodeBase64Payload(value) {
    if (!value) return null;
    try {
      if (window.ClassicMartCart?.decode) return window.ClassicMartCart.decode(value);
      const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch { return null; }
  }

  function transferPayload() {
    const params = new URLSearchParams(window.location.search);
    const compact = params.get('cmcart');
    if (compact) return decodeBase64Payload(compact);
    const raw = params.get('cartData') || params.get('cart') || params.get('items');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch {
      try { return JSON.parse(decodeURIComponent(raw)); } catch { return null; }
    }
  }

  const transferred = transferPayload();
  const transferredItems = Array.isArray(transferred?.items) ? transferred.items : [];
  const robustItems = window.ClassicMartCart?.getItems() || [];
  const sourceItems = transferredItems.length ? transferredItems : robustItems;
  let cart = sourceItems.length
    ? sourceItems.reduce((result, item) => {
        const id = String(item.id ?? item.product?.id ?? '');
        const quantity = Number(item.quantity ?? item.qty) || 0;
        if (id && quantity > 0) result[id] = quantity;
        return result;
      }, {})
    : normalizeCart(read('shophub-cart', {}));
  let snapshots = sourceItems.length
    ? sourceItems.reduce((result, item) => {
        const id = String(item.id ?? item.product?.id ?? '');
        if (id) result[id] = item.product || item;
        return result;
      }, {})
    : read('classic-mart-cart-products', {});

  function syncCartStore() {
    const items = Object.entries(cart).map(([id, quantity]) => ({
      id: snapshots[id]?.id ?? (/^\d+$/.test(id) ? Number(id) : id),
      quantity: Number(quantity) || 0,
      product: snapshots[id] || productById(id)
    })).filter(item => item.quantity > 0);
    if (window.ClassicMartCart) window.ClassicMartCart.replace(items);
    else {
      write('shophub-cart', cart);
      write('classic-mart-cart-products', snapshots);
    }
  }
  const fallbackCatalog = [
    { id: 13, name: 'Modern Table Lamp', subtitle: 'Warm Ambient Light', category: 'home', brand: 'Classic Living', image: 'assets/products/table-lamp.svg', price: 64.99, oldPrice: 89.99, rating: 4.7, reviews: 410, stock: 21, shippingInformation: 'Carefully packed for delivery' },
    { id: 14, name: 'Wireless Headphones', subtitle: 'Comfortable Everyday Audio', category: 'electronics', brand: 'Classic Audio', image: 'assets/products/wireless-headphones.svg', price: 39.99, oldPrice: 54.99, rating: 4.8, reviews: 1240, stock: 46, shippingInformation: 'Ships in 1–2 business days' },
    { id: 15, name: 'Fitness Smart Watch', subtitle: 'Activity and Notification Tracking', category: 'electronics', brand: 'Classic Active', image: 'assets/products/smart-watch.svg', price: 74.99, oldPrice: 99.99, rating: 4.8, reviews: 1310, stock: 29, shippingInformation: 'Tracked delivery available' },
    { id: 16, name: 'Classic Wrist Watch', subtitle: 'Stainless Steel Finish', category: 'fashion', brand: 'Classic Time', image: 'assets/products/smart-watch.svg', price: 59.99, oldPrice: 79.99, rating: 4.7, reviews: 920, stock: 31, shippingInformation: 'Ready for marketplace delivery' },
    { id: 17, name: 'Leather Journal', subtitle: 'Premium Notebook', category: 'books', brand: "Levi's", image: 'https://images.unsplash.com/photo-1517842645767-c639042777db?auto=format&fit=crop&w=1000&q=86', price: 14.99, oldPrice: 19.99, rating: 4.7, reviews: 630, stock: 74, shippingInformation: 'Ready to dispatch today' },
    { id: 18, name: 'Designer Sunglasses', subtitle: 'UV400 Protection', category: 'fashion', brand: 'Nike', image: 'https://images.unsplash.com/photo-1511499767150-a48a237f0083?auto=format&fit=crop&w=1000&q=86', price: 16.99, oldPrice: 29.99, rating: 4.5, reviews: 1100, stock: 55, shippingInformation: 'Ready for marketplace delivery' },
    { id: 19, name: 'City Backpack', subtitle: 'Laptop Compartment', category: 'fashion', brand: 'Adidas', image: 'assets/products/city-backpack.svg', price: 34.99, oldPrice: 46.99, rating: 4.6, reviews: 890, stock: 48, shippingInformation: 'Standard and express delivery' },
    { id: 20, name: 'Modern Floor Lamp', subtitle: 'Warm Ambient Light', category: 'home', brand: 'Philips', image: 'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=1000&q=86', price: 64.99, oldPrice: 89.99, rating: 4.6, reviews: 410, stock: 21, shippingInformation: 'Carefully packed for delivery' }
  ];
  let catalog = [...fallbackCatalog];
  syncCartStore();
  let discountRate = Number(sessionRead('classic-mart-discount-rate', '0')) || 0;
  let currentStep = 1;
  let highestStep = 1;
  let currentOrderNumber = '';

  function mapCategory(category = '') {
    if (['beauty', 'fragrances', 'skin-care'].includes(category)) return 'beauty';
    if (['smartphones', 'laptops', 'tablets', 'mobile-accessories'].includes(category)) return 'electronics';
    if (['mens-shirts', 'mens-shoes', 'mens-watches', 'womens-bags', 'womens-dresses', 'womens-jewellery', 'womens-shoes', 'womens-watches', 'tops', 'sunglasses'].includes(category)) return 'fashion';
    if (['furniture', 'home-decoration', 'kitchen-accessories'].includes(category)) return 'home';
    if (category === 'groceries') return 'grocery';
    if (category === 'sports-accessories') return 'sports';
    if (['vehicle', 'motorcycle'].includes(category)) return 'automotive';
    return 'home';
  }

  function normalize(item, index) {
    const price = Number(item.price) || 19.99;
    const discount = Math.min(70, Math.max(5, Number(item.discountPercentage) || 12));
    return {
      id: index + 1,
      name: item.title || `Classic Mart Product ${index + 1}`,
      subtitle: String(item.category || '').replaceAll('-', ' ').replace(/\b\w/g, value => value.toUpperCase()),
      category: mapCategory(item.category),
      brand: item.brand || 'Classic Mart Select',
      image: item.thumbnail || item.images?.[0] || 'assets/product-placeholder.svg',
      images: item.images || [item.thumbnail],
      price,
      oldPrice: Number((price / (1 - discount / 100)).toFixed(2)),
      rating: Number(item.rating) || 4.5,
      reviews: Math.max(86, (item.reviews?.length || 2) * 417 + (item.id || index) * 9),
      stock: Number(item.stock) || 24,
      shippingInformation: item.shippingInformation || 'Ships in 2–3 business days'
    };
  }

  function productById(id) {
    const numeric = Number(id);
    return snapshots[numeric] || snapshots[String(numeric)] || catalog.find(product => product.id === numeric) || {
      id: numeric,
      name: `Classic Mart product ${numeric}`,
      subtitle: 'Marketplace item',
      category: 'product',
      brand: 'Classic Mart',
      image: 'assets/product-placeholder.svg',
      price: 0,
      rating: 4.5,
      stock: 1,
      shippingInformation: 'Ready for marketplace delivery'
    };
  }

  function entries() {
    return Object.entries(cart)
      .map(([id, quantity]) => ({ product: productById(id), quantity: Number(quantity) }))
      .filter(entry => entry.quantity > 0);
  }

  function persistProduct(product) {
    snapshots[product.id] = product;
    write('classic-mart-cart-products', snapshots);
  }

  function showToast(message) {
    const toast = $('#pageToast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2300);
  }

  function imageMarkup(product) {
    return `<img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='assets/product-placeholder.svg'">`;
  }

  function selectedDelivery() {
    return document.querySelector('input[name="delivery"]:checked')?.value || 'standard';
  }

  function selectedPayment() {
    return document.querySelector('input[name="payment"]:checked')?.value || 'card';
  }

  function calculateTotals() {
    const list = entries();
    const subtotal = list.reduce((sum, item) => sum + (Number(item.product.price) || 0) * item.quantity, 0);
    const delivery = selectedDelivery();
    const standardShipping = subtotal > 0 && subtotal < 59 ? 5.99 : 0;
    const shipping = delivery === 'express' ? 9.99 : delivery === 'pickup' ? 0 : standardShipping;
    const discount = subtotal * discountRate;
    const total = Math.max(0, subtotal + shipping - discount);
    return { subtotal, shipping, discount, total };
  }

  function updateTotalElements() {
    const totals = calculateTotals();
    $$('[data-total-subtotal]').forEach(element => { element.textContent = money(totals.subtotal); });
    $$('[data-total-shipping]').forEach(element => { element.textContent = totals.shipping ? money(totals.shipping) : 'Free'; });
    $$('[data-total-discount]').forEach(element => { element.textContent = `−${money(totals.discount)}`; });
    $$('[data-total-final]').forEach(element => { element.textContent = money(totals.total); });
    $$('.discount-summary-row').forEach(row => { row.hidden = !totals.discount; });
  }

  function renderCartItems() {
    const list = entries();
    const totalItems = list.reduce((sum, item) => sum + item.quantity, 0);
    const countText = `${totalItems} item${totalItems === 1 ? '' : 's'} in your cart`;
    if ($('#cartPageCount')) $('#cartPageCount').textContent = countText;
    if ($('#checkoutItemCount')) $('#checkoutItemCount').textContent = `${totalItems} item${totalItems === 1 ? '' : 's'}`;
    if ($('#clearCartButton')) $('#clearCartButton').hidden = !list.length;
    if ($('#cartEmptyPage')) $('#cartEmptyPage').hidden = Boolean(list.length);

    const itemsContainer = $('#cartPageItems');
    if (!itemsContainer) return;
    itemsContainer.innerHTML = list.map(({ product, quantity }) => `
      <article class="cart-page-item" data-cart-id="${product.id}">
        <button class="cart-delete-button" data-remove-item="${product.id}" type="button" aria-label="Remove ${escapeHtml(product.name)} from cart"><img src="assets/icons/trash-can.svg" alt=""></button>
        <a class="cart-page-image" href="index.html?product=${product.id}#trending">${imageMarkup(product)}</a>
        <div class="cart-item-copy">
          <div class="cart-item-meta"><span>${escapeHtml(product.category || 'product')}</span><b>${escapeHtml(product.brand || 'Classic Mart')}</b></div>
          <a href="index.html?product=${product.id}#trending"><h3>${escapeHtml(product.name)}</h3></a>
          <p>${escapeHtml(product.shippingInformation || 'Ready for marketplace delivery')}</p>
          <div class="cart-item-bottom">
            <div class="cart-quantity" aria-label="Quantity for ${escapeHtml(product.name)}"><button data-cart-minus="${product.id}" type="button" aria-label="Decrease quantity">−</button><strong>${quantity}</strong><button data-cart-plus="${product.id}" type="button" aria-label="Increase quantity">+</button></div>
            <button class="cart-item-action" data-save-later="${product.id}" type="button">Save for later</button>
          </div>
        </div>
        <div class="cart-item-price"><strong>${money(product.price * quantity)}</strong><small>${money(product.price)} each</small></div>
      </article>`).join('');

    const disabled = !list.length;
    $('#goToCheckout').disabled = disabled;
    $('#goToCheckout').classList.toggle('disabled', disabled);
    updateTotalElements();
    renderCheckoutMiniItems();
  }

  function renderCheckoutMiniItems() {
    const list = entries();
    $('#checkoutMiniItems').innerHTML = list.map(({ product, quantity }) => `
      <article class="checkout-mini-item">
        <span>${imageMarkup(product)}<b>${quantity}</b></span>
        <div><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.brand || 'Classic Mart')}</small></div>
        <em>${money(product.price * quantity)}</em>
      </article>`).join('');
  }

  function renderConfirmItems() {
    const list = entries();
    $('#confirmItems').innerHTML = list.map(({ product, quantity }) => `
      <article class="confirm-item">
        <span>${imageMarkup(product)}<b>${quantity}</b></span>
        <div><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.brand)} · ${money(product.price)} each</small></div>
        <em>${money(product.price * quantity)}</em>
      </article>`).join('');
  }

  function updateQuantity(id, difference) {
    const next = (Number(cart[id]) || 0) + difference;
    if (next <= 0) delete cart[id];
    else cart[id] = Math.min(99, next);
    syncCartStore();
    renderCartItems();
  }

  function removeItem(id, announce = true) {
    const product = productById(id);
    delete cart[id];
    syncCartStore();
    renderCartItems();
    if (announce) showToast(`${product.name} removed from your cart`);
  }

  function addItem(id) {
    const product = productById(id);
    cart[id] = Math.min(99, (Number(cart[id]) || 0) + 1);
    persistProduct(product);
    syncCartStore();
    renderCartItems();
    renderRecommendations();
    showToast(`${product.name} added to your cart`);
  }

  function renderRecommendations() {
    const section = $('#cartRecommendations');
    const grid = $('#cartRecommendedGrid');
    if (!section || !grid) return;

    const existingIds = new Set(Object.keys(cart).map(Number));
    const mergedCatalog = [...catalog, ...fallbackCatalog].filter((product, index, items) =>
      product && product.id && items.findIndex(item => Number(item.id) === Number(product.id)) === index
    );
    let list = mergedCatalog
      .filter(product => !existingIds.has(Number(product.id)))
      .sort((a, b) => Number(b.rating || 0) - Number(a.rating || 0))
      .slice(0, 4);

    if (!list.length) list = fallbackCatalog.slice(0, 4);
    section.hidden = false;
    grid.innerHTML = list.map(product => `
      <article class="cart-recommend-card">
        <a class="cart-recommend-image" href="index.html?product=${product.id}#trending">${imageMarkup(product)}</a>
        <div class="cart-recommend-copy">
          <span class="cart-recommend-category">${escapeHtml(product.category || 'Marketplace pick')}</span>
          <a href="index.html?product=${product.id}#trending"><h3>${escapeHtml(product.name)}</h3></a>
          <p>${escapeHtml(product.subtitle || product.brand || 'Recommended for your order')}</p>
          <div class="cart-recommend-rating"><span aria-hidden="true">★</span><strong>${Number(product.rating || 4.5).toFixed(1)}</strong><small>Trusted pick</small></div>
          <div class="cart-recommend-price"><strong>${money(product.price)}</strong><button data-recommend-add="${product.id}" type="button" aria-label="Add ${escapeHtml(product.name)} to cart"><img src="assets/icons/cart-plus.svg" alt=""><span>Add</span></button></div>
        </div>
      </article>`).join('');
  }

  function checkoutData() {
    const form = $('#checkoutDetailsForm');
    const data = new FormData(form);
    return {
      name: String(data.get('name') || '').trim(),
      email: String(data.get('email') || '').trim(),
      phone: String(data.get('phone') || '').trim(),
      address: String(data.get('address') || '').trim(),
      city: String(data.get('city') || '').trim(),
      country: String(data.get('country') || '').trim(),
      note: String(data.get('note') || '').trim(),
      delivery: selectedDelivery(),
      payment: selectedPayment(),
      cardName: $('#cardName')?.value.trim() || '',
      cardNumber: $('#cardNumber')?.value.replace(/\s/g, '') || '',
      cardExpiry: $('#cardExpiry')?.value.trim() || '',
      mobileNetwork: $('#mobileNetwork')?.value || '',
      mobileMoneyPhone: $('#mobileMoneyPhone')?.value.trim() || ''
    };
  }

  function validateCheckout() {
    const form = $('#checkoutDetailsForm');
    const requiredBase = ['#checkoutName', '#checkoutEmail', '#checkoutPhone', '#checkoutAddress', '#checkoutCity', '#checkoutCountry'];
    const firstInvalid = requiredBase.map(selector => $(selector)).find(input => input && !input.checkValidity());
    if (firstInvalid) {
      firstInvalid.reportValidity();
      firstInvalid.focus();
      return false;
    }

    const payment = selectedPayment();
    if (payment === 'card') {
      const cardFields = [$('#cardName'), $('#cardNumber'), $('#cardExpiry'), $('#cardCvv')];
      const invalid = cardFields.find(input => !input.value.trim());
      if (invalid) {
        invalid.setCustomValidity('Complete the card details to continue.');
        invalid.reportValidity();
        invalid.setCustomValidity('');
        invalid.focus();
        return false;
      }
      if ($('#cardNumber').value.replace(/\s/g, '').length < 12) {
        $('#cardNumber').setCustomValidity('Enter a valid card number.');
        $('#cardNumber').reportValidity();
        $('#cardNumber').setCustomValidity('');
        return false;
      }
    }

    if (payment === 'mobile') {
      if (!$('#mobileNetwork').value || !$('#mobileMoneyPhone').value.trim()) {
        const target = !$('#mobileNetwork').value ? $('#mobileNetwork') : $('#mobileMoneyPhone');
        target.setCustomValidity('Complete the mobile money details to continue.');
        target.reportValidity();
        target.setCustomValidity('');
        target.focus();
        return false;
      }
    }

    write('classic-mart-checkout-draft', checkoutData());
    return form.checkValidity();
  }

  function paymentSummary(data) {
    if (data.payment === 'card') {
      const lastFour = data.cardNumber.slice(-4) || '0000';
      return `<span class="confirm-detail-icon"><img src="assets/icons/credit-card.svg" alt=""></span><div><strong>Card ending in ${escapeHtml(lastFour)}</strong><p>${escapeHtml(data.cardName || 'Cardholder')} · Protected payment</p></div>`;
    }
    if (data.payment === 'mobile') {
      return `<span class="confirm-detail-icon"><img src="assets/icons/mobile-screen-button.svg" alt=""></span><div><strong>${escapeHtml(data.mobileNetwork || 'Mobile money')}</strong><p>${escapeHtml(data.mobileMoneyPhone)} · Approval required</p></div>`;
    }
    return `<span class="confirm-detail-icon"><img src="assets/icons/basket-shopping.svg" alt=""></span><div><strong>Cash on delivery</strong><p>Pay when the order arrives at your delivery address.</p></div>`;
  }

  function buildConfirmation() {
    const data = checkoutData();
    const deliveryLabels = {
      standard: 'Standard delivery · 3–5 business days',
      express: 'Express delivery · 1–2 business days',
      pickup: 'Store pickup · Collection notice will be sent'
    };
    renderConfirmItems();
    $('#confirmDelivery').innerHTML = `
      <span class="confirm-detail-icon"><img src="assets/icons/location-dot.svg" alt=""></span>
      <div><strong>${escapeHtml(data.name)}</strong><p>${escapeHtml(data.address)}, ${escapeHtml(data.city)}, ${escapeHtml(data.country)}</p><small>${escapeHtml(data.phone)} · ${escapeHtml(data.email)}</small><b>${escapeHtml(deliveryLabels[data.delivery])}</b>${data.note ? `<em>Note: ${escapeHtml(data.note)}</em>` : ''}</div>`;
    $('#confirmPayment').innerHTML = paymentSummary(data);
    updateTotalElements();
  }

  function setStep(step) {
    const nextStep = Math.max(1, Math.min(3, Number(step)));
    if (nextStep > highestStep) highestStep = nextStep;
    currentStep = nextStep;

    $$('[data-checkout-screen]').forEach(screen => {
      const active = Number(screen.dataset.checkoutScreen) === nextStep;
      screen.hidden = !active;
      screen.classList.toggle('active', active);
    });

    $$('.checkout-step').forEach((button, index) => {
      const stepNumber = index + 1;
      button.classList.toggle('active', stepNumber === nextStep);
      button.classList.toggle('complete', stepNumber < nextStep);
      button.disabled = stepNumber > highestStep;
      if (stepNumber === nextStep) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });

    $$('.checkout-step-line').forEach((line, index) => line.classList.toggle('complete', index + 1 < nextStep));
    $('#cartRecommendations').hidden = nextStep !== 1 || !catalog.length;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function refreshCartFromStore() {
    const latest = window.ClassicMartCart?.getItems?.() || [];
    if (!latest.length && Object.keys(cart).length) return;
    cart = latest.reduce((result, item) => {
      const id = String(item.id ?? item.product?.id ?? '');
      const quantity = Number(item.quantity) || 0;
      if (id && quantity > 0) result[id] = quantity;
      return result;
    }, {});
    latest.forEach(item => {
      const id = String(item.id ?? item.product?.id ?? '');
      if (id) snapshots[id] = item.product || item;
    });
    renderCartItems();
  }

  window.addEventListener('pageshow', refreshCartFromStore);
  window.addEventListener('classicmart:cartchange', event => {
    if (!event.detail?.items) return;
    refreshCartFromStore();
  });

  function prefillCheckout() {
    const saved = read('classic-mart-checkout-draft', null);
    const user = read('classic-mart-user', null);
    const session = read('classic-mart-session', null);
    const source = saved || user || session || {};
    if (source.name) $('#checkoutName').value = source.name;
    if (source.email) $('#checkoutEmail').value = source.email;
    if (source.phone) $('#checkoutPhone').value = source.phone;
    if (saved?.address) $('#checkoutAddress').value = saved.address;
    if (saved?.city) $('#checkoutCity').value = saved.city;
    if (saved?.country) $('#checkoutCountry').value = saved.country;
    if (saved?.note) $('#checkoutNote').value = saved.note;
  }

  function updateChoiceStyles() {
    $$('.checkout-choice').forEach(choice => choice.classList.toggle('active', choice.querySelector('input')?.checked));
    $$('.payment-tab').forEach(tab => tab.classList.toggle('active', tab.querySelector('input')?.checked));
    const payment = selectedPayment();
    $$('[data-payment-panel]').forEach(panel => { panel.hidden = panel.dataset.paymentPanel !== payment; });
    updateTotalElements();
  }

  async function loadCatalog() {
    try {
      const response = await fetch('https://dummyjson.com/products?limit=100', { cache: 'force-cache' });
      if (!response.ok) throw new Error('Could not load catalog');
      const data = await response.json();
      catalog = (data.products || []).slice(0, 30).map(normalize);
      catalog.forEach(product => {
        if (cart[product.id] && !snapshots[product.id] && !snapshots[String(product.id)]) persistProduct(product);
      });
    } catch (error) {
      console.warn('Checkout is using its built-in recommendation catalog.', error);
      const savedProducts = Object.values(snapshots).filter(Boolean);
      catalog = [...savedProducts, ...fallbackCatalog.filter(product => !savedProducts.some(saved => Number(saved.id) === product.id))];
    }
    renderCartItems();
    renderRecommendations();
  }

  document.addEventListener('click', event => {
    const minus = event.target.closest('[data-cart-minus]');
    if (minus) return updateQuantity(minus.dataset.cartMinus, -1);
    const plus = event.target.closest('[data-cart-plus]');
    if (plus) return updateQuantity(plus.dataset.cartPlus, 1);
    const remove = event.target.closest('[data-remove-item]');
    if (remove) return removeItem(remove.dataset.removeItem);
    const save = event.target.closest('[data-save-later]');
    if (save) {
      const id = Number(save.dataset.saveLater);
      const wishlist = read('shophub-wishlist', []);
      if (!wishlist.includes(id)) wishlist.push(id);
      write('shophub-wishlist', wishlist);
      removeItem(id, false);
      showToast('Item saved to your wishlist');
      return;
    }
    const add = event.target.closest('[data-recommend-add]');
    if (add) return addItem(add.dataset.recommendAdd);

    const previous = event.target.closest('[data-checkout-prev]');
    if (previous) return setStep(previous.dataset.checkoutPrev);

    const jump = event.target.closest('[data-step-jump]');
    if (jump && !jump.disabled) return setStep(jump.dataset.stepJump);
  });

  $('#clearCartButton')?.addEventListener('click', () => {
    if (!Object.keys(cart).length) return;
    cart = {};
    syncCartStore();
    renderCartItems();
    showToast('Your cart has been cleared');
  });

  $('#couponForm')?.addEventListener('submit', event => {
    event.preventDefault();
    const code = $('#couponInput').value.trim().toUpperCase();
    if (code === 'CLASSIC10') {
      discountRate = .10;
      sessionWrite('classic-mart-discount-rate', String(discountRate));
      $('#couponStatus').textContent = 'CLASSIC10 applied — you saved 10%.';
      updateTotalElements();
      return;
    }
    discountRate = 0;
    sessionRemove('classic-mart-discount-rate');
    $('#couponStatus').textContent = code ? 'That promo code is not available.' : 'Enter a promo code first.';
    updateTotalElements();
  });

  $('#goToCheckout')?.addEventListener('click', () => {
    if (!entries().length) {
      showToast('Add at least one item before checkout');
      return;
    }
    setStep(2);
  });

  $('#checkoutDetailsForm')?.addEventListener('submit', event => {
    event.preventDefault();
    if (!entries().length) return setStep(1);
    if (!validateCheckout()) return;
    buildConfirmation();
    setStep(3);
  });

  document.addEventListener('change', event => {
    if (event.target.matches('input[name="delivery"], input[name="payment"]')) updateChoiceStyles();
  });

  $('#cardNumber')?.addEventListener('input', event => {
    const digits = event.target.value.replace(/\D/g, '').slice(0, 16);
    event.target.value = digits.replace(/(.{4})/g, '$1 ').trim();
  });

  $('#cardExpiry')?.addEventListener('input', event => {
    const digits = event.target.value.replace(/\D/g, '').slice(0, 4);
    event.target.value = digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
  });

  $('#placeOrderButton')?.addEventListener('click', () => {
    const error = $('#confirmError');
    error.textContent = '';
    if (!$('#confirmTerms').checked) {
      error.textContent = 'Confirm the order details and marketplace terms before placing the order.';
      $('#confirmTerms').focus();
      return;
    }
    if (!entries().length) {
      error.textContent = 'Your cart is empty. Return to the marketplace and add an item.';
      return;
    }

    const data = checkoutData();
    const totals = calculateTotals();
    currentOrderNumber = `CM-${Math.floor(100000 + Math.random() * 899999)}`;
    const order = {
      orderNumber: currentOrderNumber,
      customer: data,
      items: entries(),
      totals,
      createdAt: new Date().toISOString(),
      status: 'Order confirmed'
    };
    const orders = read('classic-mart-orders', []);
    orders.unshift(order);
    write('classic-mart-orders', orders.slice(0, 20));

    cart = {};
    syncCartStore();
    sessionRemove('classic-mart-discount-rate');
    discountRate = 0;
    $$('.checkout-screen, .checkout-steps, .checkout-heading').forEach(element => { element.hidden = true; });
    const complete = $('#orderComplete');
    complete.hidden = false;
    $('#orderCompleteMessage').innerHTML = `Order <strong>${escapeHtml(currentOrderNumber)}</strong> has been created for ${escapeHtml(data.name)}. A confirmation would be sent to ${escapeHtml(data.email)} and ${escapeHtml(data.phone)}. No real payment was processed.`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  $('#copyOrderNumber')?.addEventListener('click', async () => {
    if (!currentOrderNumber) return;
    try {
      await navigator.clipboard.writeText(currentOrderNumber);
      showToast('Order number copied');
    } catch {
      showToast(`Order number: ${currentOrderNumber}`);
    }
  });

  const session = read('classic-mart-session', null);
  if (session?.name) {
    $('#accountPageText').textContent = `Hi, ${session.name.split(' ')[0]}`;
    $('#accountPageLink').href = 'login.html';
  }

  try {
    prefillCheckout();
    updateChoiceStyles();
    renderCartItems();
    renderRecommendations();
  } catch (error) {
    console.error('Classic Mart cart render recovery:', error);
    const count = $('#cartPageCount');
    if (count) count.textContent = '0 items in your cart';
    const empty = $('#cartEmptyPage');
    if (empty) empty.hidden = false;
  }
  loadCatalog().catch(error => console.warn('Cart catalogue recovery:', error));
})();

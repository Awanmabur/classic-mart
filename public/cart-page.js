(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];

  let displayLocale = 'en-UG';

  function money(value) {
    return new Intl.NumberFormat(displayLocale, { style: 'currency', currency: displayCurrency, maximumFractionDigits: displayCurrency === 'UGX' ? 0 : 2 }).format(Number(value) || 0);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' })[character]);
  }


  const robustItems = window.ClassicMartCart?.getItems() || [];
  let cart = robustItems.reduce((result, item) => {
    const id = String(item.id ?? item.product?.id ?? '');
    const quantity = Number(item.quantity ?? item.qty) || 0;
    if (id && quantity > 0) result[id] = quantity;
    return result;
  }, {});
  let snapshots = robustItems.reduce((result, item) => {
    const id = String(item.id ?? item.product?.id ?? '');
    if (id) result[id] = item.product || item;
    return result;
  }, {});

  function syncCartStore() {
    // Rendering projection only. Mutations always go through ClassicMartCart's API calls.
    cart = window.ClassicMartCart?.asLegacyCart() || {};
  }

  let currentStep = 1;
  let highestStep = 1;
  let checkoutReview = null;
  let orderIdempotencyKey = '';
  let displayCurrency = 'UGX';
  let catalog = [];
  let csrfToken = '';

  function productById(id) {
    const productId = String(id);
    return snapshots[productId] || catalog.find(product => String(product.id) === productId) || {
      id: productId,
      name: 'Unavailable product',
      subtitle: 'Marketplace item',
      category: 'product',
      brand: 'Classic Mart',
      image: 'assets/product-placeholder.svg',
      price: 0,
      rating: 0,
      stock: 0,
      shippingInformation: 'Delivery information unavailable'
    };
  }

  function entries() {
    return Object.entries(cart)
      .map(([lineId, quantity]) => ({ lineId, product: productById(lineId), quantity: Number(quantity) }))
      .filter(entry => entry.quantity > 0);
  }

  function persistProduct(product) { snapshots[product.id] = product; }

  function showToast(message) {
    const toast = $('#pageToast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2300);
  }

  function imageMarkup(product) {
    return `<img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='/assets/product-placeholder.svg'">`;
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
    if (checkoutReview?.totals) {
      const factor = ['UGX', 'RWF'].includes(checkoutReview.totals.currency || displayCurrency) ? 1 : 100;
      return { subtotal: checkoutReview.totals.subtotalMinor / factor, shipping: checkoutReview.totals.shippingMinor / factor, discount: (checkoutReview.totals.discountMinor || 0) / factor, tax: (checkoutReview.totals.taxMinor || 0) / factor, total: checkoutReview.totals.totalMinor / factor };
    }
    const serverTotals = window.ClassicMartCart?.getServerTotals?.();
    if (serverTotals) {
      const factor = ['UGX', 'RWF'].includes(serverTotals.currency || displayCurrency) ? 1 : 100;
      return { subtotal: serverTotals.subtotalMinor / factor, shipping: 0, discount: (serverTotals.discountMinor || 0) / factor, tax: 0, total: serverTotals.totalMinor / factor };
    }
    return { subtotal, shipping: 0, discount: 0, tax: 0, total: subtotal };
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
    itemsContainer.innerHTML = list.map(({ lineId, product, quantity }) => `
      <article class="cart-page-item" data-cart-id="${escapeHtml(lineId)}">
        <button class="cart-delete-button" data-remove-item="${escapeHtml(lineId)}" type="button" aria-label="Remove ${escapeHtml(product.name)} from cart"><img src="/assets/icons/trash-can.svg" alt=""></button>
        <a class="cart-page-image" href="/products/${encodeURIComponent(product.id)}">${imageMarkup(product)}</a>
        <div class="cart-item-copy">
          <div class="cart-item-meta"><span>${escapeHtml(product.category || 'product')}</span><b>${escapeHtml(product.brand || 'Classic Mart')}</b></div>
          <a href="/products/${encodeURIComponent(product.id)}"><h3>${escapeHtml(product.name)}</h3></a>
          <p>${escapeHtml(product.shippingInformation || 'Ready for marketplace delivery')}</p>
          <div class="cart-item-bottom">
            <div class="cart-quantity" aria-label="Quantity for ${escapeHtml(product.name)}"><button data-cart-minus="${escapeHtml(lineId)}" type="button" aria-label="Decrease quantity">−</button><strong>${quantity}</strong><button data-cart-plus="${escapeHtml(lineId)}" type="button" aria-label="Increase quantity">+</button></div>
            <button class="cart-item-action" data-save-later="${escapeHtml(lineId)}" data-product-id="${escapeHtml(product.id)}" type="button">Save for later</button>
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

  function requireCartService(method) {
    const service = window.ClassicMartCart;
    if (!service || typeof service[method] !== 'function') throw new Error('The secure cart service is unavailable. Refresh the page and try again.');
    return service;
  }

  async function updateQuantity(id, difference) {
    try {
      const next = Math.max(0, Math.min(99, (Number(cart[id]) || 0) + difference));
      await requireCartService('setQuantity').setQuantity(id, next);
      refreshCartFromStore();
    } catch (error) { showToast(error.message); }
  }

  async function removeItem(id, announce = true) {
    const product = productById(id);
    try {
      await requireCartService('remove').remove(id);
      refreshCartFromStore();
      if (announce) showToast(`${product.name} removed from your cart`);
    } catch (error) { showToast(error.message); }
  }

  async function addItem(id) {
    const product = productById(id);
    persistProduct(product);
    try {
      await requireCartService('add').add(product, 1);
      refreshCartFromStore();
      renderRecommendations();
      showToast(`${product.name} added to your cart`);
    } catch (error) { showToast(error.message); }
  }

  function renderRecommendations() {
    const section = $('#cartRecommendations');
    const grid = $('#cartRecommendedGrid');
    if (!section || !grid) return;

    const existingIds = new Set(entries().map(({ product }) => String(product.id)));
    const mergedCatalog = catalog.filter((product, index, items) =>
      product && product.id && items.findIndex(item => String(item.id) === String(product.id)) === index
    );
    const list = mergedCatalog
      .filter(product => !existingIds.has(String(product.id)) && Number(product.stock || 0) > 0)
      .sort((a, b) => Number(b.rating || 0) - Number(a.rating || 0))
      .slice(0, 4);

    section.hidden = !list.length;
    grid.innerHTML = list.map(product => `
      <article class="cart-recommend-card">
        <a class="cart-recommend-image" href="/products/${encodeURIComponent(product.id)}">${imageMarkup(product)}</a>
        <div class="cart-recommend-copy">
          <span class="cart-recommend-category">${escapeHtml(product.category || 'Marketplace pick')}</span>
          <a href="/products/${encodeURIComponent(product.id)}"><h3>${escapeHtml(product.name)}</h3></a>
          <p>${escapeHtml(product.subtitle || product.brand || 'Recommended for your order')}</p>
          <div class="cart-recommend-rating"><span aria-hidden="true">★</span><strong>${Number(product.rating || 0) > 0 ? Number(product.rating).toFixed(1) : 'New'}</strong><small>${Number(product.reviews || 0) ? `${Number(product.reviews)} reviews` : 'No reviews yet'}</small></div>
          <div class="cart-recommend-price"><strong>${money(product.price)}</strong><button data-recommend-add="${product.id}" type="button" aria-label="Add ${escapeHtml(product.name)} to cart"><img src="/assets/icons/cart-plus.svg" alt=""><span>Add</span></button></div>
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
      pickupPointId: $('#checkoutPickupPoint')?.value || '',
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
    return form.checkValidity();
  }

  function paymentSummary(data) {
    if (data.payment === 'card') return `<span class="confirm-detail-icon"><img src="/assets/icons/credit-card.svg" alt=""></span><div><strong>Card</strong><p>Payment pending · hosted payment follows order creation</p></div>`;
    if (data.payment === 'mobile') return `<span class="confirm-detail-icon"><img src="/assets/icons/mobile-screen-button.svg" alt=""></span><div><strong>Mobile money</strong><p>Payment pending · provider approval is required</p></div>`;
    return `<span class="confirm-detail-icon"><img src="/assets/icons/basket-shopping.svg" alt=""></span><div><strong>Cash on delivery</strong><p>Payment remains pending until delivery reconciliation.</p></div>`;
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
      <span class="confirm-detail-icon"><img src="/assets/icons/location-dot.svg" alt=""></span>
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
    // Checkout personal data is collected only by the server-authoritative checkout flow, never browser storage.
  }

  async function loadCheckoutOptions() {
    const city = $('#checkoutCity')?.value?.trim() || '';
    try {
      const response = await fetch(`/api/v1/checkout/options?city=${encodeURIComponent(city)}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Checkout options unavailable.');
      const select = $('#checkoutPickupPoint');
      if (select) {
        const current = select.value;
        select.innerHTML = '<option value="">Choose a pickup point</option>' + (data.pickupPoints || []).map(point => `<option value="${escapeHtml(point.id)}">${escapeHtml(point.name)} — ${escapeHtml(point.city)}</option>`).join('');
        if ([...select.options].some(option => option.value === current)) select.value = current;
      }
      $$('input[name="payment"]').forEach(input => { input.disabled = data.payments?.[input.value] === false; });
    } catch (error) { showToast(error.message || 'Checkout options could not be loaded.'); }
  }

  function updateChoiceStyles() {
    $$('.checkout-choice').forEach(choice => choice.classList.toggle('active', choice.querySelector('input')?.checked));
    $$('.payment-tab').forEach(tab => tab.classList.toggle('active', tab.querySelector('input')?.checked));
    const pickupFields = $('#pickupPointFields');
    if (pickupFields) pickupFields.hidden = selectedDelivery() !== 'pickup';
    const payment = selectedPayment();
    $$('[data-payment-panel]').forEach(panel => { panel.hidden = panel.dataset.paymentPanel !== payment; });
    updateTotalElements();
  }

  async function loadCatalog() {
    try {
      const response = await fetch('/api/v1/storefront/catalogue', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error('Could not load catalog');
      const data = await response.json();
      catalog = data.products || [];
      csrfToken = data.csrfToken || window.ClassicMartCart?.getCsrfToken?.() || csrfToken;
      if (data.country?.currency) displayCurrency = data.country.currency;
      else if (catalog[0]?.currency) displayCurrency = catalog[0].currency;
      if (data.country?.locale) displayLocale = data.country.locale;
      catalog.forEach(product => {
        if (cart[product.id] && !snapshots[product.id] && !snapshots[String(product.id)]) persistProduct(product);
      });
    } catch (error) {
      console.error('Cart catalogue could not be loaded.', error);
      catalog = Object.values(snapshots).filter(Boolean);
    }
    renderCartItems();
    renderRecommendations();
  }

  document.addEventListener('click', async event => {
    const minus = event.target.closest('[data-cart-minus]');
    if (minus) return updateQuantity(minus.dataset.cartMinus, -1);
    const plus = event.target.closest('[data-cart-plus]');
    if (plus) return updateQuantity(plus.dataset.cartPlus, 1);
    const remove = event.target.closest('[data-remove-item]');
    if (remove) return removeItem(remove.dataset.removeItem);
    const save = event.target.closest('[data-save-later]');
    if (save) {
      const id = save.dataset.saveLater;
      const productId = save.dataset.productId || productById(id).id;
      const response = await fetch(
        `/api/v1/storefront/wishlist/${encodeURIComponent(productId)}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            'x-csrf-token': csrfToken,
          },
        },
      );
      if (response.status === 401) {
        location.href = `/login?next=${encodeURIComponent('/cart')}`;
        return;
      }
      if (response.ok) {
        await removeItem(id, false);
        showToast('Item saved to your wishlist');
      } else {
        const payload = await response.json().catch(() => ({}));
        showToast(payload.error?.message || 'Item could not be saved.');
      }
      return;
    }
    const add = event.target.closest('[data-recommend-add]');
    if (add) return addItem(add.dataset.recommendAdd);

    const previous = event.target.closest('[data-checkout-prev]');
    if (previous) return setStep(previous.dataset.checkoutPrev);

    const jump = event.target.closest('[data-step-jump]');
    if (jump && !jump.disabled) return setStep(jump.dataset.stepJump);
  });

  $('#clearCartButton')?.addEventListener('click', async () => {
    if (!Object.keys(cart).length) return;
    try {
      await requireCartService('clear').clear();
      refreshCartFromStore();
      showToast('Your cart has been cleared');
    } catch (error) { showToast(error.message); }
  });

  $('#couponForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    if (window.ClassicMartCart?.ready) await window.ClassicMartCart.ready;
    csrfToken = window.ClassicMartCart?.getCsrfToken?.() || csrfToken;
    const code = $('#couponInput').value.trim();
    const status = $('#couponStatus');
    if (!code) { status.textContent = 'Enter a promoter or campaign code first.'; return; }
    try {
      let response = await fetch('/api/v1/cart/promotions', {
        method: 'POST', credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ code })
      });
      let payload = await response.json().catch(() => ({}));
      if (response.ok) {
        await window.ClassicMartCart?.refresh?.();
        refreshCartFromStore();
        const promos = window.ClassicMartCart?.getPromotions?.() || [];
        status.textContent = promos.length ? `Seller promotion applied: ${promos.map(row => row.name).join(', ')}.` : 'Seller promotion applied.';
        return;
      }
      if (response.status !== 404) throw new Error(payload.error?.message || 'Code could not be applied.');
      response = await fetch('/api/v1/promoters/coupons/redeem', {
        method: 'POST', credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ code })
      });
      payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || 'Code could not be applied.');
      status.textContent = 'Promoter attribution applied. The server will show any separately eligible seller discount.';
    } catch (error) { status.textContent = error.message; }
  });

  $('#goToCheckout')?.addEventListener('click', async () => {
    if (!entries().length) {
      showToast('Add at least one item before checkout');
      return;
    }
    try {
      const cartResponse = await fetch('/api/v1/cart', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const cartData = await cartResponse.json();
      csrfToken = cartData.csrfToken || csrfToken;
      if (!cartResponse.ok || !cartData.cart?.items?.length) throw new Error('Your server cart is empty. Refresh and add the item again.');
      await loadCheckoutOptions();
      setStep(2);
    } catch (error) { showToast(error.message || 'Checkout could not start.'); }
  });

  $('#checkoutDetailsForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    if (!entries().length) return setStep(1);
    if (!validateCheckout()) return;
    const data = checkoutData();
    try {
      const response = await fetch('/api/v1/checkout/review', {
        method: 'POST', credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ deliveryMethod: data.delivery, paymentMethod: data.payment, city: data.city, pickupPointId: data.pickupPointId })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || 'Checkout review failed.');
      checkoutReview = payload;
      displayCurrency = payload.totals?.currency || displayCurrency;
      orderIdempotencyKey = (crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^a-zA-Z0-9-]/g, '');
      buildConfirmation();
      const factor = ['UGX', 'RWF'].includes(displayCurrency) ? 1 : 100;
      if (payload.totals) {
        $$('[data-total-subtotal]').forEach(element => { element.textContent = money(payload.totals.subtotalMinor / factor); });
        $$('[data-total-shipping]').forEach(element => { element.textContent = payload.totals.shippingMinor ? money(payload.totals.shippingMinor / factor) : 'Free'; });
        $$('[data-total-discount]').forEach(element => { element.textContent = `−${money((payload.totals.discountMinor || 0) / factor)}`; });
        $$('[data-total-final]').forEach(element => { element.textContent = money(payload.totals.totalMinor / factor); });
        $$('.discount-summary-row').forEach(row => { row.hidden = !(payload.totals.discountMinor || 0); });
      }
      setStep(3);
    } catch (error) { showToast(error.message || 'Checkout review failed.'); }
  });

  document.addEventListener('change', event => {
    if (event.target.matches('input[name="delivery"], input[name="payment"]')) { checkoutReview = null; updateChoiceStyles(); }
    if (event.target.matches('#checkoutCity')) loadCheckoutOptions();
  });


  $('#placeOrderButton')?.addEventListener('click', async () => {
    const error = $('#confirmError');
    error.textContent = '';
    if (!$('#confirmTerms')?.checked) { error.textContent = 'Confirm the order details and marketplace terms first.'; return; }
    if (!checkoutReview?.checkoutId) { error.textContent = 'Checkout review expired. Return to Checkout and review again.'; return; }
    const data = checkoutData();
    const button = $('#placeOrderButton');
    button.disabled = true;
    try {
      const response = await fetch('/api/v1/orders', {
        method: 'POST', credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({
          checkoutId: checkoutReview.checkoutId,
          idempotencyKey: orderIdempotencyKey,
          deliveryMethod: data.delivery,
          paymentMethod: data.payment,
          city: data.city,
          pickupPointId: data.pickupPointId,
          contact: { fullName: data.name, email: data.email, phone: data.phone, address: data.address, city: data.city, country: data.country, note: data.note }
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || 'Order could not be created.');
      await window.ClassicMartCart?.clear?.();
      const paymentKey = (crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^a-zA-Z0-9-]/g, '');
      const paymentResponse = await fetch(`/api/v1/orders/${encodeURIComponent(payload.order.id)}/payment-intents`, {
        method: 'POST', credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ idempotencyKey: paymentKey })
      });
      const paymentPayload = await paymentResponse.json().catch(() => ({}));
      if (!paymentResponse.ok) {
        location.href = `/track-order?order=${encodeURIComponent(payload.order.id)}&payment=retry`;
        return;
      }
      if (paymentPayload.payment?.checkoutUrl) {
        location.href = paymentPayload.payment.checkoutUrl;
        return;
      }
      location.href = `/track-order?order=${encodeURIComponent(payload.order.id)}`;
    } catch (orderError) {
      error.textContent = orderError.message || 'Order could not be created.';
      button.disabled = false;
    }
  });

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

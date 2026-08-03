(() => {
  'use strict';

  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const modal = qs('#productModal');
  const backdrop = qs('#modalBackdrop');
  const content = qs('#productModalContent');
  if (!modal || !backdrop || !content) return;

  const state = {
    products: [],
    categories: [],
    wishlist: [],
    csrfToken: '',
    locale: 'en-UG',
    currency: 'UGX',
    productId: '',
    variantId: '',
    quantity: 1,
    loaded: false,
    loading: null,
    lastFocused: null,
  };

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  })[character]);

  function normalizeProduct(product = {}) {
    const price = Number(product.price) || 0;
    const oldPrice = Number(product.oldPrice ?? price) || price;
    const stock = Math.max(0, Number(product.stock) || 0);
    const seller = product.seller || {};
    const images = (Array.isArray(product.images) && product.images.length ? product.images : [product.image])
      .filter(Boolean);
    return {
      ...product,
      id: String(product.id || ''),
      name: String(product.name || 'Product'),
      subtitle: String(product.subtitle || ''),
      description: String(product.description || 'Product information is provided by the verified seller.'),
      category: String(product.category || ''),
      brand: String(product.brand || 'Classic Mart'),
      sku: String(product.sku || 'Not provided'),
      badge: String(product.badge || (oldPrice > price ? 'Deal' : 'Featured')),
      badgeTone: product.badgeTone || (product.badge === 'Deal' ? 'red' : product.badge === 'New Arrival' ? 'teal' : 'orange'),
      price,
      oldPrice,
      currency: product.currency || state.currency,
      stock,
      rating: Math.max(0, Math.min(5, Number(product.rating) || 0)),
      reviews: Math.max(0, Number(product.reviews) || 0),
      sold: Math.max(0, Number(product.sold) || 0),
      image: images[0] || '/assets/product-placeholder.svg',
      images: images.length ? images : ['/assets/product-placeholder.svg'],
      variants: Array.isArray(product.variants) ? product.variants : [],
      reviewItems: Array.isArray(product.reviewItems) ? product.reviewItems : [],
      questions: Array.isArray(product.questions) ? product.questions : [],
      tags: Array.isArray(product.tags) && product.tags.length
        ? product.tags
        : [product.categoryName, product.category, product.brand].filter(Boolean),
      availabilityStatus: stock > 0 ? 'In stock' : 'Out of stock',
      warrantyInformation: product.warrantyInformation || product.attributes?.warranty || 'Seller warranty terms were not provided',
      shippingInformation: product.shippingInformation || 'Delivery options are shown at checkout',
      returnPolicy: product.returnPolicy || 'Return eligibility is shown before purchase',
      weight: product.weight || (product.variants?.[0]?.weightGrams ? `${(Number(product.variants[0].weightGrams) / 1000).toFixed(2)} kg` : 'Not provided'),
      minimumOrderQuantity: Math.max(1, Number(product.minimumOrderQuantity) || 1),
      seller: {
        name: String(seller.name || 'Classic Mart Seller'),
        slug: String(seller.slug || ''),
        country: String(seller.country || 'Verified marketplace seller'),
        description: String(seller.description || 'Verified Classic Mart marketplace seller.'),
      },
    };
  }

  function money(value, currency = state.currency) {
    try {
      return new Intl.NumberFormat(state.locale, { style: 'currency', currency }).format(Number(value) || 0);
    } catch {
      return `${currency} ${Number(value || 0).toLocaleString()}`;
    }
  }

  function reviewCount(value) {
    const number = Number(value) || 0;
    if (number >= 1000) return `${(number / 1000).toFixed(number >= 10000 ? 0 : 1)}K`;
    return String(number);
  }

  function starMarkup(value) {
    const rating = Math.max(0, Math.min(5, Math.round(Number(value) || 0)));
    return `${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}`;
  }

  function imageWithFallback(image, alt, className = '') {
    return `<img class="${escapeHtml(className)}" src="${escapeHtml(image || '/assets/product-placeholder.svg')}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='/assets/product-placeholder.svg';">`;
  }

  function badgeClass(product) {
    return `badge-${product.badgeTone || 'orange'}`;
  }

  function wishlistIcon(wished) {
    return wished ? '/assets/icons/heart.svg' : '/assets/icons/heart-regular.svg';
  }

  function categoryLabel(category = '') {
    return state.categories.find((item) => item.id === category)?.name ||
      String(category || 'Products').replaceAll('-', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
  }

  function productById(id) {
    return state.products.find((product) => String(product.id) === String(id));
  }

  function variantById(product, variantId) {
    const variants = Array.isArray(product?.variants) ? product.variants : [];
    return variants.find((variant) => String(variant.id) === String(variantId)) ||
      variants.find((variant) => String(variant.id) === String(product?.variantId)) ||
      variants[0] || null;
  }

  function selectedProduct() {
    const product = productById(state.productId);
    if (!product) return null;
    const variant = variantById(product, state.variantId);
    if (!variant) return { ...product };
    return {
      ...product,
      variantId: variant.id,
      subtitle: variant.title || product.subtitle,
      price: Number(variant.price ?? product.price) || 0,
      oldPrice: Number(variant.oldPrice ?? variant.price ?? product.oldPrice ?? product.price) || 0,
      currency: variant.currency || product.currency,
      stock: Math.max(0, Number(variant.stock ?? product.stock) || 0),
      sku: variant.sku || product.sku,
      selectedVariant: variant,
    };
  }

  function showToast(message) {
    const toast = qs('#catalogToast') || qs('#pageToast') || qs('[role="status"].page-toast');
    if (!toast) return;
    toast.textContent = String(message || '');
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2400);
  }

  async function ensureCatalogue() {
    if (state.loaded) return;
    if (state.loading) return state.loading;
    state.loading = (async () => {
      const response = await fetch('/api/v1/storefront/catalogue', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || 'Products could not be loaded.');
      state.products = (payload.products || []).map(normalizeProduct);
      state.categories = payload.categories || [];
      state.wishlist = payload.state?.wishlist || [];
      state.csrfToken = payload.csrfToken || '';
      state.locale = payload.country?.locale || state.locale;
      state.currency = payload.country?.currency || state.currency;
      state.loaded = true;
    })().finally(() => { state.loading = null; });
    return state.loading;
  }

  function openModal() {
    state.lastFocused = document.activeElement;
    modal.hidden = false;
    backdrop.hidden = false;
    document.body.classList.add('no-scroll');
    requestAnimationFrame(() => {
      backdrop.classList.add('show');
      modal.classList.add('open');
    });
    setTimeout(() => modal.querySelector('button, a, input, select, textarea')?.focus(), 80);
  }

  function closeModal() {
    modal.classList.remove('open');
    backdrop.classList.remove('show');
    qs('#productShareMenu')?.setAttribute('hidden', '');
    document.body.classList.remove('no-scroll');
    setTimeout(() => {
      modal.hidden = true;
      backdrop.hidden = true;
      content.innerHTML = '';
    }, 220);
    state.lastFocused?.focus?.();
  }

  function updatePurchaseSummary() {
    const product = selectedProduct();
    if (!product) return;
    const maxQuantity = Math.max(1, Math.min(20, Number(product.stock) || 1));
    state.quantity = Math.max(1, Math.min(maxQuantity, Number(state.quantity) || 1));
    const quantity = state.quantity;
    const discount = product.oldPrice > product.price
      ? Math.max(0, Math.round((1 - product.price / product.oldPrice) * 100))
      : 0;
    const setText = (selector, value) => { const element = qs(selector, modal); if (element) element.textContent = value; };
    setText('#modalQuantity', String(quantity));
    // The original price is the only live total. No duplicate quantity-price block is rendered.
    setText('#previewUnitPrice', money(product.price * quantity, product.currency));
    setText('#previewOldPrice', product.oldPrice > product.price ? money(product.oldPrice * quantity, product.currency) : '');
    setText('#previewDiscount', discount ? `Save ${discount}%` : '');
    setText('#previewAvailability', Number(product.stock) > 0 ? 'In stock' : 'Out of stock');
    setText('#previewVariantTitle', product.subtitle || product.selectedVariant?.title || 'Default option');
    setText('#previewStockCount', `${product.stock} unit${Number(product.stock) === 1 ? '' : 's'} ready to order`);
    setText('#previewSku', `SKU: ${product.sku || 'Not provided'}`);

    const oldPrice = qs('#previewOldPrice', modal);
    if (oldPrice) oldPrice.hidden = !(product.oldPrice > product.price);
    const discountElement = qs('#previewDiscount', modal);
    if (discountElement) discountElement.hidden = !discount;
    const minus = qs('[data-modal-qty-minus]', modal);
    const plus = qs('[data-modal-qty-plus]', modal);
    if (minus) minus.disabled = quantity <= 1;
    if (plus) plus.disabled = product.stock <= quantity || quantity >= 20;
    const unavailable = Number(product.stock) <= 0;
    const addButton = qs('[data-modal-add-cart]', modal);
    const buyButton = qs('[data-buy-now]', modal);
    for (const button of [addButton, buyButton]) {
      if (!button) continue;
      button.disabled = unavailable;
      button.setAttribute('aria-disabled', String(unavailable));
    }
    const addLabel = addButton?.querySelector('[data-preview-add-label]');
    if (addLabel) addLabel.textContent = unavailable ? 'Out of stock' : `Add ${quantity} to Cart`;
    if (buyButton) buyButton.textContent = unavailable ? 'Out of stock' : `Buy ${quantity} Now`;
    const shareUrl = new URL(`/products/${encodeURIComponent(product.id)}`, window.location.origin).toString();
    const whatsapp = qs('.preview-whatsapp-button', modal);
    if (whatsapp) {
      whatsapp.href = `https://wa.me/?text=${encodeURIComponent(`Hello Classic Mart, I am interested in ${quantity} × ${product.name} (${product.subtitle || 'Default'}) for ${money(product.price * quantity, product.currency)}. ${shareUrl}`)}`;
    }
  }

  function configureToolbar(product) {
    const wished = state.wishlist.includes(product.id);
    const shareUrl = new URL(`/products/${encodeURIComponent(product.id)}`, window.location.origin).toString();
    const shareButton = qs('#productModalShare');
    const wishlistButton = qs('#productModalWishlist');
    const shareMenu = qs('#productShareMenu');
    const copyButton = qs('#productShareCopy');
    const whatsapp = qs('#productShareWhatsApp');
    if (shareButton) {
      shareButton.dataset.shareProduct = product.id;
      shareButton.dataset.shareUrl = shareUrl;
      shareButton.setAttribute('aria-expanded', 'false');
    }
    if (shareMenu) shareMenu.hidden = true;
    if (copyButton) copyButton.dataset.shareUrl = shareUrl;
    if (whatsapp) whatsapp.href = `https://wa.me/?text=${encodeURIComponent(`Take a look at ${product.name} on Classic Mart. ${shareUrl}`)}`;
    if (wishlistButton) {
      wishlistButton.dataset.wishlist = product.id;
      wishlistButton.classList.toggle('active', wished);
      wishlistButton.setAttribute('aria-pressed', String(wished));
      const icon = wishlistButton.querySelector('img');
      if (icon) icon.src = wishlistIcon(wished);
    }
  }

  function renderProduct(product) {
    const initialVariant = variantById(product, product.variantId);
    state.productId = product.id;
    state.variantId = initialVariant?.id || '';
    state.quantity = 1;
    const lowData = document.documentElement.dataset.lowData === 'true' || navigator.connection?.saveData === true;
    const images = (product.images || [product.image]).slice(0, lowData ? 1 : 5);
    const discount = product.oldPrice > product.price
      ? Math.max(0, Math.round((1 - product.price / product.oldPrice) * 100))
      : 0;
    const dimensions = product.dimensions
      ? `${product.dimensions.width || '—'} × ${product.dimensions.height || '—'} × ${product.dimensions.depth || '—'} cm`
      : 'See packaging details';
    const shareUrl = new URL(`/products/${encodeURIComponent(product.id)}`, window.location.origin).toString();
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(`Hello Classic Mart, I am interested in ${product.name} (${money(product.price, product.currency)}). ${shareUrl}`)}`;

    const reviewItems = product.reviewItems.slice(0, 4);
    const reviewMarkup = reviewItems.length ? reviewItems.map((review) => `
      <article class="preview-review">
        <div class="review-avatar">V</div>
        <div class="review-content">
          <div class="review-head"><div><strong>Verified buyer</strong><small>Verified purchase</small></div><span aria-label="${Number(review.rating) || 5} out of 5 stars">${starMarkup(Number(review.rating) || 5)}</span></div>
          <p>${escapeHtml(review.body || review.title || 'Verified purchase review.')}</p>
          <div class="review-meta"><span>${review.publishedAt ? new Date(review.publishedAt).toLocaleDateString() : 'Verified review'}</span></div>
        </div>
      </article>`).join('') : '<p class="empty-preview-copy">Customer feedback will appear here after verified purchases.</p>';

    const ratingRows = [5, 4, 3, 2, 1].map((stars) => {
      const value = stars === 5 && product.reviews ? Math.min(92, Math.max(0, Math.round(product.rating * 16))) : 0;
      return `<div class="rating-breakdown-row"><span>${stars} ★</span><i><b style="width:${value}%"></b></i><small>${value}%</small></div>`;
    }).join('');

    const tagMarkup = (product.tags || [product.category, 'quality checked', 'buyer protected']).slice(0, 4)
      .map((tag) => `<span>${escapeHtml(String(tag).replaceAll('-', ' '))}</span>`).join('');

    const relatedProducts = state.products
      .filter((item) => item.id !== product.id)
      .sort((left, right) => {
        const categoryDifference = Number(right.category === product.category) - Number(left.category === product.category);
        if (categoryDifference) return categoryDifference;
        const brandDifference = Number(right.brand === product.brand) - Number(left.brand === product.brand);
        if (brandDifference) return brandDifference;
        return right.rating - left.rating || right.sold - left.sold;
      })
      .slice(0, 5);

    const relatedMarkup = relatedProducts.map((item) => `
      <article class="preview-related-card" data-product-preview="${escapeHtml(item.id)}" tabindex="0" role="button" aria-label="Open ${escapeHtml(item.name)} preview">
        <div class="preview-related-image">${imageWithFallback(item.image, item.name)}</div>
        <div class="preview-related-copy">
          <h4>${escapeHtml(item.name)}</h4>
          <div><strong>${money(item.price, item.currency)}</strong><span>${item.reviews ? `${item.rating.toFixed(1)} ★` : 'New'}</span></div>
          <button type="button" data-preview-related-add="${escapeHtml(item.id)}">Add to cart</button>
        </div>
      </article>`).join('');

    content.innerHTML = `
      <div class="product-preview">
        <nav class="preview-breadcrumb" aria-label="Breadcrumb"><a href="/">Home</a><b>›</b><a href="/products?category=${encodeURIComponent(product.category)}">${escapeHtml(categoryLabel(product.category))}</a><b>›</b><strong>${escapeHtml(product.name)}</strong></nav>

        <div class="product-preview-main">
          <div class="product-gallery">
            <div class="gallery-main"><img id="previewMainImage" src="${escapeHtml(images[0] || product.image)}" alt="${escapeHtml(product.name)}" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='/assets/product-placeholder.svg';"></div>
            <div class="gallery-thumbnails" aria-label="Product images">
              ${images.map((image, imageIndex) => `<button class="gallery-thumb ${imageIndex === 0 ? 'active' : ''}" data-gallery-thumb="${escapeHtml(image)}" type="button" aria-label="View image ${imageIndex + 1}"><img src="${escapeHtml(image)}" alt="${escapeHtml(product.name)} view ${imageIndex + 1}" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='/assets/product-placeholder.svg';"></button>`).join('')}
            </div>
          </div>

          <div class="product-modal-copy">
            <div class="preview-badges"><span class="product-badge ${badgeClass(product)}">${escapeHtml(product.badge)}</span><span class="verified-badge"><img src="/assets/icons/circle-check.svg" alt=""> Verified listing</span></div>
            <h2 id="productModalTitle">${escapeHtml(product.name)}</h2>
            <div class="preview-price-row" aria-live="polite"><strong id="previewUnitPrice">${money(product.price, product.currency)}</strong><del id="previewOldPrice" ${product.oldPrice > product.price ? '' : 'hidden'}>${product.oldPrice > product.price ? money(product.oldPrice, product.currency) : ''}</del><span id="previewDiscount" ${discount ? '' : 'hidden'}>${discount ? `Save ${discount}%` : ''}</span></div>
            <div class="preview-payment-note"><img src="/assets/icons/credit-card.svg" alt=""><span>Pay securely at checkout. Taxes and delivery are calculated before confirmation.</span></div>
            <p class="preview-description" id="productModalDescription">${escapeHtml(product.description)}</p>

            <div class="preview-stock-line"><span class="stock-dot"></span><strong id="previewAvailability">${escapeHtml(product.availabilityStatus)}</strong><span id="previewVariantTitle">${escapeHtml(initialVariant?.title || product.subtitle || 'Default option')}</span><span id="previewStockCount">${product.stock} unit${Number(product.stock) === 1 ? '' : 's'} ready to order</span><span class="preview-sku" id="previewSku">SKU: ${escapeHtml(product.sku)}</span></div>

            <div class="preview-choice-grid">
              <div class="preview-option-block">
                <div class="preview-option-heading"><span>Choose option</span></div>
                <div class="preview-option-row">
                  <div class="option-chips">${(product.variants || []).map((variant) => `<button class="${String(variant.id) === String(initialVariant?.id) ? 'active' : ''}" type="button" data-preview-option="${escapeHtml(variant.id)}" aria-pressed="${String(variant.id) === String(initialVariant?.id)}">${escapeHtml(variant.title)}${Number(variant.stock) > 0 ? '' : ' · Out of stock'}</button>`).join('')}</div>
                  <div class="modal-quantity" aria-label="Quantity"><button data-modal-qty-minus type="button" aria-label="Decrease quantity">−</button><strong id="modalQuantity">1</strong><button data-modal-qty-plus type="button" aria-label="Increase quantity">+</button></div>
                </div>
              </div>
            </div>

            <div class="preview-purchase-actions" aria-label="Purchase actions">
              <button class="button button-primary preview-cart-button" data-modal-add-cart="${escapeHtml(product.id)}" type="button"><img src="/assets/icons/cart-plus.svg" alt=""><span data-preview-add-label>Add 1 to Cart</span></button>
              <button class="buy-now-button" data-buy-now="${escapeHtml(product.id)}" type="button">Buy 1 Now</button>
              <a class="preview-whatsapp-button" href="${whatsappUrl}" target="_blank" rel="noopener noreferrer" aria-label="Chat about this product on WhatsApp"><img class="whatsapp-logo" src="/assets/icons/whatsapp.svg" alt=""><strong>WhatsApp</strong></a>
            </div>
          </div>
        </div>

        <section class="preview-information-grid" aria-label="Shopping information">
          <article><img src="/assets/icons/rotate-left.svg" alt=""><div><strong>Returns</strong><small>Eligibility follows the return policy confirmed with your order</small></div></article>
          <article><img src="/assets/icons/circle-check.svg" alt=""><div><strong>Warranty</strong><small>${escapeHtml(product.warrantyInformation)}</small></div></article>
          <article><img src="/assets/icons/headset.svg" alt=""><div><strong>Support</strong><small>Help before and after your purchase</small></div></article>
        </section>

        <div class="product-preview-extra">
          <section class="preview-panel preview-overview-panel">
            <div class="preview-panel-heading"><span>Overview</span><h3>Why shoppers choose it</h3></div>
            <ul>
              <li><img src="/assets/icons/check.svg" alt=""> Published after catalogue moderation</li>
              <li><img src="/assets/icons/check.svg" alt=""> Current stock is read from seller inventory</li>
              <li><img src="/assets/icons/check.svg" alt=""> Price and country availability come from the live listing</li>
              <li><img src="/assets/icons/check.svg" alt=""> Product images are approved and served by Classic Mart</li>
            </ul>
            <div class="preview-tag-list">${tagMarkup}</div>
          </section>
          <section class="preview-panel">
            <div class="preview-panel-heading"><span>Details</span><h3>Specifications</h3></div>
            <dl class="spec-list"><div><dt>Brand</dt><dd>${escapeHtml(product.brand)}</dd></div><div><dt>SKU</dt><dd>${escapeHtml(product.sku)}</dd></div><div><dt>Category</dt><dd>${escapeHtml(categoryLabel(product.category))}</dd></div><div><dt>Dimensions</dt><dd>${escapeHtml(dimensions)}</dd></div><div><dt>Weight</dt><dd>${escapeHtml(product.weight)}</dd></div><div><dt>Minimum order</dt><dd>${product.minimumOrderQuantity} unit</dd></div></dl>
          </section>
          <section class="preview-panel seller-panel">
            <div class="seller-logo">${escapeHtml(product.seller.name.charAt(0).toUpperCase())}</div><div><span>Sold by</span><h3>${escapeHtml(product.seller.name)}</h3><p>${escapeHtml(product.seller.description)}</p><div><b>${escapeHtml(product.seller.country)}</b><b>${product.stock} available</b><b>Verified seller</b></div><div class="seller-panel-links">${product.seller.slug ? `<a href="/sellers/${encodeURIComponent(product.seller.slug)}">Seller profile</a><a href="/products?seller=${encodeURIComponent(product.seller.slug)}">Seller products</a>` : ''}</div></div>
          </section>
        </div>

        <section class="preview-reviews" id="previewReviews">
          <div class="preview-section-title"><div><span>Ratings &amp; reviews</span><h3>Feedback from verified buyers</h3></div><button class="review-write-button" type="button" data-focus-review-form>Write a review</button></div>
          <div class="preview-ai-summary" id="previewAiSummary"><small>Classic AI review summary uses verified-purchase reviews only. Summary unavailable until enough review data and an approved AI provider are available.</small></div><div class="preview-ratings-layout">
            <aside class="rating-overview-card">
              <div class="rating-score"><strong>${product.rating.toFixed(1)}</strong><span>${starMarkup(product.rating)}</span><small>Based on ${reviewCount(product.reviews)} ratings</small></div>
              <div class="rating-breakdown">${ratingRows}</div>
              <div class="rating-highlights">${product.reviews ? `<span><b>${product.rating.toFixed(1)}</b> average</span><span><b>${reviewCount(product.reviews)}</b> reviews</span>` : '<span><b>New</b> No verified reviews yet</span>'}</div>
            </aside>
            <div class="preview-review-list">${reviewMarkup}</div>
          </div>

          <form class="preview-review-form" id="previewReviewForm" data-product-name="${escapeHtml(product.name)}">
            <div class="review-form-heading"><div><span>Share your experience</span><h3>Write a product review</h3></div><small>Only verified purchases are published publicly.</small></div>
            <div class="review-star-input" role="radiogroup" aria-label="Your rating">
              ${[1, 2, 3, 4, 5].map((star) => `<button type="button" data-review-star="${star}" aria-label="${star} star${star > 1 ? 's' : ''}">★</button>`).join('')}
              <input type="hidden" id="previewReviewRating" name="rating" value="0">
            </div>
            <div class="review-form-grid"><label>Review title<input name="title" type="text" required maxlength="160" placeholder="Summarise your experience"></label></div>
            <label>Your review<textarea name="review" rows="4" required placeholder="What did you like? How was the quality, value and delivery?"></textarea></label>
            <div class="review-form-actions"><button class="button button-primary" type="submit">Submit review</button></div>
          </form>
        </section>

        <section class="preview-panel preview-community-panel" aria-labelledby="previewQuestionsTitle">
          <div class="preview-panel-heading"><span>Questions &amp; alerts</span><h3 id="previewQuestionsTitle">Ask before you buy</h3></div>
          <div class="preview-question-list">${product.questions.length ? product.questions.map((item) => `<article><strong>${escapeHtml(item.question)}</strong><p>${escapeHtml(item.answer || '')}</p></article>`).join('') : '<p class="empty-preview-copy">No answered questions yet.</p>'}</div>
          <form id="previewQuestionForm" class="preview-review-form"><label>Your question<textarea name="question" rows="2" minlength="5" maxlength="500" required placeholder="Ask about size, compatibility, warranty or another product detail"></textarea></label><button class="button" type="submit">Submit question</button></form>
          <div class="review-form-actions"><button class="button" type="button" data-product-alert="restock">Notify me when restocked</button><button class="button" type="button" data-product-alert="price_drop">Watch price drops</button></div>
        </section>

        <section class="preview-related-products" aria-labelledby="previewRelatedTitle">
          <div class="preview-related-heading">
            <div><span>Recommended for you</span><h3 id="previewRelatedTitle">Other products you may like</h3></div>
            <a href="/products?category=${encodeURIComponent(product.category)}">View all</a>
          </div>
          <div class="preview-related-grid" id="previewRelatedGrid">${relatedMarkup}</div>
        </section>
      </div>`;

    configureToolbar(product);
    updatePurchaseSummary();
  }

  async function recordRecent(productId) {
    if (!state.csrfToken) return;
    fetch(`/api/v1/storefront/recent/${encodeURIComponent(productId)}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { Accept: 'application/json', 'x-csrf-token': state.csrfToken },
    }).catch(() => {});
  }

  async function loadAiEnhancements(product) {
    Promise.allSettled([
      fetch(`/api/v1/ai/products/${encodeURIComponent(product.id)}/similar`, { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then((response) => response.ok ? response.json() : null),
      fetch(`/api/v1/ai/products/${encodeURIComponent(product.id)}/review-summary`, { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then((response) => response.ok ? response.json() : null),
    ]).then(([similarResult, reviewResult]) => {
      if (state.productId !== product.id) return;
      const similar = similarResult.status === 'fulfilled' ? (similarResult.value?.products || []) : [];
      const grid = qs('#previewRelatedGrid', modal);
      if (grid && similar.length) {
        grid.innerHTML = similar.slice(0, 5).map((item) => `
          <article class="preview-related-card" data-product-preview="${escapeHtml(item.id)}" tabindex="0" role="button" aria-label="Open ${escapeHtml(item.name)} preview">
            <div class="preview-related-image">${imageWithFallback(item.image, item.name)}</div>
            <div class="preview-related-copy"><h4>${escapeHtml(item.name)}</h4><div><strong>${money(item.price, item.currency)}</strong><span>${escapeHtml(item.recommendationExplanation || 'Similar catalogue match')}</span></div><button type="button" data-preview-related-add="${escapeHtml(item.id)}">Add to cart</button></div>
          </article>`).join('');
      }
      const summary = reviewResult.status === 'fulfilled' ? reviewResult.value?.summary : null;
      const summaryBox = qs('#previewAiSummary', modal);
      if (summaryBox && summary?.reviewCount > 0) {
        summaryBox.innerHTML = `<strong>Classic AI review summary</strong><p>${escapeHtml(summary.summary || '')}</p><small>Based on ${Number(summary.reviewCount) || 0} verified-purchase reviews. AI-generated summary; check individual reviews for context.</small>`;
      }
    }).catch(() => {});
  }

  async function openProduct(productId) {
    const id = String(productId || '');
    if (!id) return;
    try {
      await ensureCatalogue();
      let product = productById(id);
      if (!product) throw new Error('This product is no longer available.');
      content.innerHTML = '<div class="product-preview-loading" role="status">Loading product preview…</div>';
      openModal();
      try {
        const response = await fetch(`/api/v1/storefront/products/${encodeURIComponent(id)}`, {
          credentials: 'same-origin', headers: { Accept: 'application/json' },
        });
        if (response.ok) {
          const payload = await response.json();
          product = normalizeProduct({ ...product, ...(payload.product || {}) });
          const index = state.products.findIndex((item) => item.id === product.id);
          if (index >= 0) state.products[index] = product;
        }
      } catch {
        // Keep the live catalogue card data if product detail enrichment is temporarily unavailable.
      }
      renderProduct(product);
      recordRecent(product.id);
      loadAiEnhancements(product);
    } catch (error) {
      closeModal();
      showToast(error.message || 'Product preview could not be opened.');
    }
  }

  async function addSelectedToCart({ buyNow = false } = {}) {
    const product = selectedProduct();
    if (!product || product.stock < 1) return;
    if (!window.ClassicMartCart) {
      showToast('Cart is still loading. Please try again.');
      return;
    }
    const button = buyNow ? qs('[data-buy-now]', modal) : qs('[data-modal-add-cart]', modal);
    const previous = button?.innerHTML || '';
    if (button) {
      button.disabled = true;
      button.textContent = buyNow ? 'Preparing checkout…' : 'Adding…';
    }
    try {
      await window.ClassicMartCart.add(product, state.quantity);
      if (buyNow) window.location.assign('/cart');
      else {
        showToast(`${state.quantity} × ${product.name} added to cart`);
        updatePurchaseSummary();
      }
    } catch (error) {
      showToast(error.message || 'Product could not be added.');
    } finally {
      if (button && document.body.contains(button)) button.innerHTML = previous;
      updatePurchaseSummary();
    }
  }

  async function addRelated(productId, button) {
    const product = productById(productId);
    if (!product || !window.ClassicMartCart) return;
    const previous = button.innerHTML;
    button.disabled = true;
    button.textContent = 'Adding…';
    try {
      await window.ClassicMartCart.add(product, 1);
      showToast(`${product.name} added to cart`);
      button.textContent = 'Added ✓';
    } catch (error) {
      showToast(error.message || 'Product could not be added.');
      button.innerHTML = previous;
    } finally {
      setTimeout(() => {
        if (!document.body.contains(button)) return;
        button.disabled = product.stock < 1;
        button.innerHTML = previous;
      }, 900);
    }
  }

  async function toggleWishlist(productId) {
    const id = String(productId || '');
    const included = state.wishlist.includes(id);
    if (!state.csrfToken) {
      window.location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
      return;
    }
    const response = await fetch(`/api/v1/storefront/wishlist/${encodeURIComponent(id)}`, {
      method: included ? 'DELETE' : 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'x-csrf-token': state.csrfToken },
    });
    if (response.status === 401) {
      window.location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
      return;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast(payload.error?.message || 'Wishlist could not be updated.');
      return;
    }
    state.wishlist = payload.wishlist || [];
    document.querySelectorAll('[data-wishlist-count]').forEach((badge) => { badge.textContent = String(state.wishlist.length); });
    configureToolbar(productById(id));
    showToast(included ? 'Product removed from wishlist' : 'Product saved to wishlist');
  }

  async function copyShareLink(url) {
    try {
      await navigator.clipboard.writeText(url);
      showToast('Product link copied.');
    } catch {
      const input = document.createElement('textarea');
      input.value = url;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.append(input);
      input.select();
      document.execCommand('copy');
      input.remove();
      showToast('Product link copied.');
    }
  }

  async function submitReview(form) {
    const product = selectedProduct();
    const rating = Number(qs('#previewReviewRating', form)?.value || 0);
    if (!rating) {
      showToast('Please choose a star rating');
      qs('[data-review-star]', form)?.focus();
      return;
    }
    if (!state.csrfToken) {
      window.location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
      return;
    }
    const formData = new FormData(form);
    const response = await fetch('/api/v1/reviews', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', Accept: 'application/json', 'x-csrf-token': state.csrfToken },
      body: JSON.stringify({ productId: product.id, rating, title: formData.get('title'), body: formData.get('review') }),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      window.location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
      return;
    }
    if (!response.ok) {
      showToast(payload.error?.message || 'Review could not be submitted.');
      return;
    }
    showToast('Review submitted for moderation.');
    await openProduct(product.id);
  }

  async function submitQuestion(form) {
    const product = selectedProduct();
    if (!state.csrfToken) {
      window.location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
      return;
    }
    const question = String(new FormData(form).get('question') || '').trim();
    const response = await fetch(`/api/v1/storefront/products/${encodeURIComponent(product.id)}/questions`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', Accept: 'application/json', 'x-csrf-token': state.csrfToken },
      body: JSON.stringify({ question }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast(payload.error?.message || 'Question could not be submitted.');
      return;
    }
    form.reset();
    showToast('Question submitted to the seller.');
  }

  async function saveAlert(type) {
    const product = selectedProduct();
    if (!state.csrfToken) {
      window.location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
      return;
    }
    const response = await fetch(`/api/v1/storefront/alerts/${encodeURIComponent(product.id)}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', Accept: 'application/json', 'x-csrf-token': state.csrfToken },
      body: JSON.stringify({ type }),
    });
    const payload = await response.json().catch(() => ({}));
    showToast(response.ok ? 'Product alert saved.' : (payload.error?.message || 'Alert could not be saved.'));
  }

  document.addEventListener('click', async (event) => {
    const close = event.target.closest('[data-close-product-preview]');
    if (close) {
      event.preventDefault();
      closeModal();
      return;
    }

    const relatedAdd = event.target.closest('[data-preview-related-add]');
    if (relatedAdd) {
      event.preventDefault();
      event.stopPropagation();
      await addRelated(relatedAdd.dataset.previewRelatedAdd, relatedAdd);
      return;
    }

    const addButton = event.target.closest('[data-modal-add-cart]');
    if (addButton) {
      event.preventDefault();
      await addSelectedToCart();
      return;
    }

    const buyButton = event.target.closest('[data-buy-now]');
    if (buyButton) {
      event.preventDefault();
      await addSelectedToCart({ buyNow: true });
      return;
    }

    const quantityMinus = event.target.closest('[data-modal-qty-minus]');
    if (quantityMinus) {
      state.quantity -= 1;
      updatePurchaseSummary();
      return;
    }
    const quantityPlus = event.target.closest('[data-modal-qty-plus]');
    if (quantityPlus) {
      state.quantity += 1;
      updatePurchaseSummary();
      return;
    }

    const option = event.target.closest('[data-preview-option]');
    if (option) {
      state.variantId = option.dataset.previewOption;
      state.quantity = 1;
      qsa('[data-preview-option]', modal).forEach((button) => {
        const active = button === option;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      updatePurchaseSummary();
      return;
    }

    const thumbnail = event.target.closest('[data-gallery-thumb]');
    if (thumbnail) {
      const main = qs('#previewMainImage', modal);
      if (main) main.src = thumbnail.dataset.galleryThumb;
      qsa('[data-gallery-thumb]', modal).forEach((button) => button.classList.toggle('active', button === thumbnail));
      return;
    }

    const shareButton = event.target.closest('#productModalShare');
    if (shareButton) {
      const menu = qs('#productShareMenu');
      if (!menu) return;
      menu.hidden = !menu.hidden;
      shareButton.setAttribute('aria-expanded', String(!menu.hidden));
      return;
    }

    const copyButton = event.target.closest('[data-copy-product]');
    if (copyButton) {
      await copyShareLink(copyButton.dataset.shareUrl || location.href);
      qs('#productShareMenu')?.setAttribute('hidden', '');
      return;
    }

    const wishlistButton = event.target.closest('#productModalWishlist');
    if (wishlistButton) {
      await toggleWishlist(wishlistButton.dataset.wishlist);
      return;
    }

    const reviewStar = event.target.closest('[data-review-star]');
    if (reviewStar) {
      const rating = Number(reviewStar.dataset.reviewStar);
      const input = qs('#previewReviewRating', modal);
      if (input) input.value = String(rating);
      qsa('[data-review-star]', modal).forEach((button) => button.classList.toggle('active', Number(button.dataset.reviewStar) <= rating));
      return;
    }

    if (event.target.closest('[data-focus-review-form]')) {
      qs('#previewReviewForm', modal)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      qs('#previewReviewForm input', modal)?.focus();
      return;
    }

    const alert = event.target.closest('[data-product-alert]');
    if (alert) {
      await saveAlert(alert.dataset.productAlert);
      return;
    }

    const related = event.target.closest('[data-product-preview]');
    if (related && modal.contains(related)) {
      event.preventDefault();
      await openProduct(related.dataset.productPreview);
      return;
    }

    const productLink = event.target.closest('a[href^="/products/"]');
    if (productLink && !productLink.hasAttribute('download') && productLink.target !== '_blank') {
      const pathname = new URL(productLink.href, location.origin).pathname;
      const match = pathname.match(/^\/products\/([^/]+)$/);
      if (match) {
        event.preventDefault();
        await openProduct(decodeURIComponent(match[1]));
      }
    }
  });

  document.addEventListener('submit', async (event) => {
    if (event.target.matches('#previewReviewForm')) {
      event.preventDefault();
      await submitReview(event.target);
    }
    if (event.target.matches('#previewQuestionForm')) {
      event.preventDefault();
      await submitQuestion(event.target);
    }
  });

  backdrop.addEventListener('click', closeModal);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden) closeModal();
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-product-preview]')) {
      event.preventDefault();
      openProduct(event.target.dataset.productPreview);
    }
  });

  document.addEventListener('classicmart:visual-search-results', (event) => {
    const products = (event.detail?.products || []).map(normalizeProduct);
    if (!products.length) return;
    const existing = new Map(state.products.map((product) => [product.id, product]));
    products.forEach((product) => existing.set(product.id, product));
    state.products = [...existing.values()];
  });

  window.ClassicMartProductPreview = { open: openProduct, close: closeModal };
})();

(() => {
  'use strict';

  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

  const PRIMARY_CATEGORY_IDS = [
    'electronics', 'fashion', 'home-living', 'beauty', 'sports-fitness',
    'automotive', 'books', 'groceries', 'baby', 'office',
  ];

  function orderedCategories() {
    const byId = new Map(categories.map((category) => [category.id, category]));
    const primary = PRIMARY_CATEGORY_IDS.map((id) => byId.get(id)).filter(Boolean);
    const extras = categories.filter((category) => !PRIMARY_CATEGORY_IDS.includes(category.id));
    return [...primary, ...extras];
  }

  function normalizeProduct(product) {
    return {
      ...product,
      images: product.images?.length ? product.images : [product.image],
      barcode: String(product.barcode || product.variants?.[0]?.barcode || ''),
      videoUrl: String(product.videoUrl || ''),
      attributes: product.attributes && typeof product.attributes === 'object' ? product.attributes : {},
      publishedAt: product.publishedAt || '',
      qualityScore: Math.max(0, Math.min(100, Number(product.qualityScore) || 0)),
      policyVersion: String(product.policyVersion || ''),
      deliveryOptions: product.deliveryOptions && typeof product.deliveryOptions === 'object' ? product.deliveryOptions : {},
      ratingDistribution: product.ratingDistribution && typeof product.ratingDistribution === 'object' ? product.ratingDistribution : { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      availabilityStatus: product.stock > 0 ? "In stock" : "Out of stock",
      warrantyInformation: product.attributes?.warranty || "Seller warranty terms were not provided",
      shippingInformation: Number(product.freeStandardShippingThreshold) > 0 ? `Free standard delivery on eligible orders from ${money(Number(product.freeStandardShippingThreshold), product.currency || displayCurrency)}; final delivery options are shown at checkout.` : "Delivery options and fees are shown at checkout",
      returnPolicy: Number(product.returnWindowDays) > 0 ? `${Number(product.returnWindowDays)}-day return window for eligible items; final eligibility is frozen with the order.` : "Return eligibility is shown before purchase",
      weight: product.variants?.[0]?.weightGrams
        ? `${(product.variants[0].weightGrams / 1000).toFixed(2)} kg`
        : "Not provided",
      minimumOrderQuantity: 1,
      paymentMethods: Array.isArray(product.paymentMethods) ? product.paymentMethods : [],
      reviewItems: Array.isArray(product.reviewItems) ? product.reviewItems : [],
      questions: Array.isArray(product.questions) ? product.questions : [],
      reviewPage: product.reviewPage || { count: 0, total: 0, hasMore: false, next: '' },
      questionPage: product.questionPage || { count: 0, total: 0, hasMore: false, next: '' },
      tags: [product.categoryName, product.brand].filter(Boolean),
      badgeTone: product.badge === "Deal" ? "red" : product.badge === "New Arrival" ? "teal" : "orange"
    };
  }

  function readInitialStorefront() {
    const node = document.getElementById('initialStorefrontData');
    if (!node?.textContent) return {};
    try { return JSON.parse(node.textContent); }
    catch (error) {
      console.error('Classic Mart initial storefront payload is invalid:', error);
      return {};
    }
  }

  const initialStorefront = readInitialStorefront();
  let categories = Array.isArray(initialStorefront.categories) ? initialStorefront.categories : [];
  let products = (Array.isArray(initialStorefront.products) ? initialStorefront.products : []).map(normalizeProduct);
  let brands = Array.isArray(initialStorefront.brands) ? initialStorefront.brands : [];
  let displayLocale = initialStorefront.country?.locale || "en-UG";
  let displayCurrency = initialStorefront.country?.currency || "UGX";
  const state = {
    cart: window.ClassicMartCart?.asLegacyCart?.() || {},
    wishlist: [],
    recent: [],
    filteredProducts: products.slice(0, 12),
    csrfToken: '',
    heroIndex: 0,
    heroTimer: null,
    lastFocused: null,
    deepLinkOpened: false,
    recentRecorded: new Set(),
    dealCountdownTimer: null,
  };
  const previewState = { productId: '', variantId: '', quantity: 1 };

  async function hydrateOnlineCatalog() {
    try {
      const response = await fetch("/api/v1/storefront/catalogue", { credentials: "same-origin", headers: { Accept: "application/json" } });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "Catalogue request failed");
      categories = Array.isArray(payload.categories) ? payload.categories : [];
      products = (Array.isArray(payload.products) ? payload.products : []).map(normalizeProduct);
      brands = Array.isArray(payload.brands) ? payload.brands : [];
      displayLocale = payload.country?.locale || displayLocale;
      displayCurrency = payload.country?.currency || displayCurrency;
      const priceRange = qs('#priceRange');
      if (priceRange) {
        const maxCataloguePrice = Math.max(1, ...products.map(product => Number(product.price) || 0));
        const roundedMax = Math.ceil(maxCataloguePrice);
        priceRange.min = '0'; priceRange.max = String(roundedMax); priceRange.value = String(roundedMax);
        if (qs('#priceOutput')) qs('#priceOutput').textContent = money(roundedMax);
      }
      state.wishlist = Array.isArray(payload.state?.wishlist) ? payload.state.wishlist : [];
      state.recent = Array.isArray(payload.state?.recent) ? payload.state.recent : [];
      state.csrfToken = payload.csrfToken || "";
      state.filteredProducts = products.slice(0, 12);
      renderCategories();
      renderBrands();
      renderHeaderCategories();
      renderTrending(state.filteredProducts);
      renderDeals();
      renderRecommended();
      renderBestSellers();
      renderBudgetPicks();
      renderFreshFinds();
      renderRecentlyViewed();
      updateCartUI();
      document.querySelectorAll("[data-wishlist-count]").forEach(badge => { badge.textContent = String(state.wishlist.length); });
    } catch (error) {
      console.error("Classic Mart catalogue could not be loaded:", error);
      showToast("Products could not be loaded. Refresh to try again.");
    }
  }

  function rememberCartProduct(_product) { /* Product snapshots come from the server catalogue. */ }


  function cartTransferUrl() { return '/cart'; }


  function money(value, currency = displayCurrency) {
    return new Intl.NumberFormat(displayLocale, { style: 'currency', currency }).format(value);
  }

  function deliveryTimeLabel(hours) {
    const value = Math.max(1, Number(hours) || 1);
    if (value < 24) return `${Math.ceil(value)} hour${Math.ceil(value) === 1 ? '' : 's'}`;
    const days = Math.ceil(value / 24);
    return `${days} day${days === 1 ? '' : 's'}`;
  }

  function reviewCount(value) {
    if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K`;
    return String(value);
  }

  function starMarkup(rating) {
    const rounded = Math.round(rating);
    return `${'★'.repeat(rounded)}${'☆'.repeat(5 - rounded)}`;
  }

  function feedbackReviewMarkup(review) {
    return `<article class="preview-review" data-review-id="${escapeHtml(review.publicId || '')}"><div class="review-avatar">V</div><div class="review-content"><div class="review-head"><div><strong>Verified buyer</strong><small>${review.verifiedPurchase ? 'Verified purchase' : 'Published review'}</small></div><span aria-label="${Number(review.rating) || 5} out of 5 stars">${starMarkup(Number(review.rating) || 5)}</span></div><p>${escapeHtml(review.body || review.title || 'Verified purchase review.')}</p><div class="review-meta"><span>${review.publishedAt ? new Date(review.publishedAt).toLocaleDateString() : 'Published review'}</span></div></div></article>`;
  }

  function feedbackQuestionMarkup(item) {
    return `<article data-question-id="${escapeHtml(item.publicId || '')}"><strong>${escapeHtml(item.question)}</strong><p>${escapeHtml(item.answer?.body || item.answer || '')}</p></article>`;
  }

  function compactRatingMarkup(product) {
    if (!product.reviews) return '<span class="rating-star" aria-hidden="true">★</span><strong>New</strong><span>(0)</span>';
    return `<span class="rating-star" aria-hidden="true">★</span><strong>${Number(product.rating).toFixed(1)}</strong><span>(${reviewCount(product.reviews)})</span>`;
  }

  function productById(id) {
    return products.find(product => String(product.id) === String(id));
  }

  function variantById(product, variantId) {
    const variants = Array.isArray(product?.variants) ? product.variants : [];
    return variants.find((variant) => String(variant.id) === String(variantId)) ||
      variants.find((variant) => String(variant.id) === String(product?.variantId)) ||
      variants[0] || null;
  }

  function selectedPreviewProduct() {
    const product = productById(previewState.productId);
    if (!product) return null;
    const variant = variantById(product, previewState.variantId);
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

  function updatePreviewPurchaseSummary() {
    const product = selectedPreviewProduct();
    if (!product) return;
    const maxQuantity = Math.max(1, Math.min(20, Number(product.stock) || 1));
    previewState.quantity = Math.max(1, Math.min(maxQuantity, Number(previewState.quantity) || 1));
    const quantity = previewState.quantity;
    const discount = product.oldPrice > product.price
      ? Math.max(0, Math.round((1 - product.price / product.oldPrice) * 100))
      : 0;
    const setText = (selector, value) => { const element = qs(selector); if (element) element.textContent = value; };
    setText('#modalQuantity', String(quantity));
    setText('#previewUnitPrice', money(product.price * quantity, product.currency));
    setText('#previewOldPrice', product.oldPrice > product.price ? money(product.oldPrice * quantity, product.currency) : '');
    setText('#previewDiscount', discount ? `Save ${discount}%` : '');
    setText('#previewAvailability', Number(product.stock) > 0 ? 'In stock' : 'Out of stock');
    setText('#previewVariantTitle', product.subtitle || product.selectedVariant?.title || 'Default option');
    setText('#previewStockCount', `${product.stock} unit${Number(product.stock) === 1 ? '' : 's'} ready to order`);
    setText('#previewSku', `SKU: ${product.sku || 'Not provided'}`);
    const oldPrice = qs('#previewOldPrice');
    if (oldPrice) oldPrice.hidden = !(product.oldPrice > product.price);
    const discountElement = qs('#previewDiscount');
    if (discountElement) discountElement.hidden = !discount;
    const quantityMinus = qs('[data-modal-qty-minus]');
    const quantityPlus = qs('[data-modal-qty-plus]');
    if (quantityMinus) quantityMinus.disabled = quantity <= 1;
    if (quantityPlus) quantityPlus.disabled = product.stock <= quantity || quantity >= 20;
    const unavailable = Number(product.stock) <= 0;
    const addButton = qs('[data-modal-add-cart]');
    const buyButton = qs('[data-buy-now]');
    for (const button of [addButton, buyButton]) {
      if (!button) continue;
      button.disabled = unavailable;
      button.setAttribute('aria-disabled', String(unavailable));
    }
    const addLabel = addButton?.querySelector('[data-preview-add-label]');
    if (addLabel) addLabel.textContent = unavailable ? 'Out of stock' : 'Add to Cart';
    if (buyButton) buyButton.textContent = unavailable ? 'Out of stock' : 'Buy Now';
    const shareUrl = new URL(`/products/${encodeURIComponent(product.id)}`, window.location.origin).toString();
    const whatsapp = qs('.preview-whatsapp-button');
    if (whatsapp) {
      whatsapp.href = `https://wa.me/?text=${encodeURIComponent(`Hello Classic Mart, I am interested in ${quantity} × ${product.name} (${product.subtitle || 'Default'}) for ${money(product.price * quantity, product.currency)}. ${shareUrl}`)}`;
    }
  }

  function setPreviewVariant(variantId) {
    const product = productById(previewState.productId);
    const variant = variantById(product, variantId);
    if (!product || !variant) return;
    previewState.variantId = variant.id;
    const maximum = Math.max(1, Math.min(20, Number(variant.stock) || 1));
    previewState.quantity = Math.min(previewState.quantity, maximum);
    updatePreviewPurchaseSummary();
  }

  function setPreviewQuantity(quantity) {
    previewState.quantity = Number(quantity) || 1;
    updatePreviewPurchaseSummary();
  }

  function imageWithFallback(image, alt, className = '') {
    return `<img class="${className}" src="${escapeHtml(image || '/assets/product-placeholder.svg')}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='/assets/product-placeholder.svg';">`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function badgeClass(product) {
    return `badge-${product.badgeTone || 'orange'}`;
  }

  function promoterAmount(product) {
    const bps = Math.max(0, Math.min(5000, Number(product?.promoterCommissionBps) || 0));
    const price = Math.max(0, Number(product?.price) || 0);
    if (!bps || !price) return '';
    return money(price * bps / 10000, product.currency || displayCurrency);
  }

  function sponsoredBadge(product) {
    const amount = promoterAmount(product);
    if (amount) {
      const disclosure = product.sponsoredDisclosure || 'Promoters may earn the displayed amount on qualifying Classic Mart purchases.';
      return `<span class="promoter-badge" title="${escapeHtml(`${disclosure} Estimated promoter earning: ${amount}.`)}">Prom ${escapeHtml(amount)}</span>`;
    }
    return product.sponsored ? `<span class="promoter-badge" title="${escapeHtml(product.sponsoredDisclosure || 'Sponsored placement')}">Sponsored</span>` : '';
  }

  document.querySelectorAll('[data-wishlist-count]').forEach(badge => { badge.textContent = String(state.wishlist.length); });

  function wishlistIcon(wished) {
    return wished
      ? '/assets/icons/heart.svg'
      : '/assets/icons/heart-regular.svg';
  }

  function categoryLabel(category = '') {
    return categories.find(item => item.id === category)?.name ||
      String(category).replaceAll('-', ' ').replace(/\b\w/g, character => character.toUpperCase());
  }

  function productCard(product) {
    const wished = state.wishlist.includes(product.id);
    return `
      <article class="product-card" data-product-preview="${product.id}" data-product-id="${product.id}" data-category="${product.category}" data-brand="${escapeHtml(product.brand)}" data-price="${product.price}" data-rating="${product.rating}" tabindex="0" role="button" aria-label="Open ${escapeHtml(product.name)} preview">
        <div class="product-image">
          <span class="product-badge ${badgeClass(product)}">${escapeHtml(product.badge)}</span>
          ${imageWithFallback(product.image, product.name)}
          <span class="category-badge">${escapeHtml(categoryLabel(product.category))}</span>
          ${sponsoredBadge(product)}
          <button class="wishlist-button ${wished ? 'active' : ''}" data-wishlist="${product.id}" type="button" aria-pressed="${wished}" aria-label="${wished ? 'Remove from' : 'Add to'} wishlist">
            <img src="${wishlistIcon(wished)}" alt="">
          </button>
        </div>
        <div class="product-info">
          <h3>${escapeHtml(product.name)}</h3>
          <div class="product-meta-row">
            <div class="price"><strong>${money(product.price, product.currency)}</strong></div>
            <div class="rating" aria-label="${product.reviews ? `${product.rating} out of 5 stars` : 'No reviews yet'}">${compactRatingMarkup(product)}</div>
          </div>
          <button class="add-cart" data-add-cart="${product.id}" type="button">Add to cart</button>
        </div>
      </article>`;
  }

  function compactProductCard(product) {
    const compareAt = Number(product.oldPrice || 0);
    const livePrice = Number(product.price || 0);
    const discount = compareAt > livePrice && compareAt > 0 ? Math.max(1, Math.round((1 - livePrice / compareAt) * 100)) : 0;
    return `
      <article class="compact-product" data-product-preview="${product.id}" data-product-id="${product.id}" tabindex="0" role="button" aria-label="Open ${escapeHtml(product.name)} preview">
        <div class="compact-image">
          <span class="deal-badge">${discount}% Off</span>
          ${imageWithFallback(product.image, product.name)}
          <span class="category-badge">${escapeHtml(categoryLabel(product.category))}</span>
          ${sponsoredBadge(product)}
        </div>
        <h3>${escapeHtml(product.name)}</h3>
        <div class="product-meta-row">
          <div class="price"><strong>${money(product.price, product.currency)}</strong></div>
          <div class="rating" aria-label="${product.reviews ? `${product.rating} out of 5 stars` : 'No reviews yet'}">${compactRatingMarkup(product)}</div>
        </div>
        <div class="sold">Sold: ${product.sold}</div>
        <button class="compact-add" data-add-cart="${product.id}" type="button">Add to cart</button>
      </article>`;
  }

  function recommendCard(product) {
    return `
      <article class="recommend-card" data-product-preview="${product.id}" tabindex="0" role="button" aria-label="Open ${escapeHtml(product.name)} preview">
        <div class="recommend-image">${imageWithFallback(product.image, product.name)}<span class="category-badge">${escapeHtml(categoryLabel(product.category))}</span>${sponsoredBadge(product)}</div>
        <div><h3>${escapeHtml(product.name)}</h3><div class="product-meta-row"><div class="price"><strong>${money(product.price, product.currency)}</strong></div><div class="rating" aria-label="${product.reviews ? `${product.rating} out of 5 stars` : 'No reviews yet'}">${compactRatingMarkup(product)}</div></div></div>
      </article>`;
  }

  function miniProductCard(product, index) {
    return `
      <article class="mini-product-card ${index >= 3 ? 'mobile-extra-card' : ''}" data-product-preview="${product.id}" tabindex="0" role="button" aria-label="Open ${escapeHtml(product.name)} preview">
        <div class="mini-product-image">
          ${imageWithFallback(product.image, product.name)}
          <span class="category-badge">${escapeHtml(categoryLabel(product.category))}</span>
          ${sponsoredBadge(product)}
        </div>
        <h3>${escapeHtml(product.name)}</h3>
        <div class="mini-card-footer"><strong>${money(product.price, product.currency)}</strong><span>${product.reviews ? `${product.rating.toFixed(1)} ★` : 'New'}</span></div>
      </article>`;
  }

  function renderCategories() {
    const target = qs('#categoryRow');
    if (!target) return;
    const ordered = orderedCategories();
    const visibleCategories = ordered;
    target.innerHTML = visibleCategories.map((category, index) => `
      <button class="category-card ${index >= PRIMARY_CATEGORY_IDS.length ? 'category-extra' : ''}" data-category-jump="${escapeHtml(category.id)}" type="button">
        <span class="category-image">${imageWithFallback(category.image, category.name)}</span>
        <span>${escapeHtml(category.name)}</span>
      </button>`).join('');
    const more = qs('[data-category-more]');
    if (more) {
      const hasExtraCategories = ordered.length > PRIMARY_CATEGORY_IDS.length;
      more.hidden = !hasExtraCategories;
      const label = more.querySelector('[data-category-more-label]');
      if (label) label.textContent = 'More';
    }
  }

  function approvedBrandMark(name) {
    const brand = String(name || '').trim();
    const key = brand.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const known = {
      samsung: ['brand-samsung', 'SAMSUNG'],
      sony: ['brand-sony', 'SONY'],
      nike: ['brand-nike', 'NIKE'],
      adidas: ['brand-adidas', 'adidas'],
      philips: ['brand-philips', 'PHILIPS'],
      levis: ['brand-levis', "LEVI'S"],
      canon: ['brand-canon', 'Canon'],
    };
    if (key === 'apple') return '<img alt="Apple" src="/assets/icons/apple.svg">';
    const mark = known[key];
    if (mark) return `<span class="${mark[0]}">${escapeHtml(mark[1])}</span>`;
    return `<span class="brand-wordmark">${escapeHtml(brand)}</span>`;
  }

  function renderBrands() {
    const target = qs('#brandRow');
    if (!target) return;
    const liveBrands = brands.length
      ? brands.map((brand) => typeof brand === 'string' ? brand : brand.name)
      : [...new Set(products.map((product) => product.brand).filter(Boolean))];
    target.innerHTML = liveBrands.filter(Boolean).map((brand) => `
      <button class="brand-card" data-brand="${escapeHtml(brand)}" type="button">
        ${approvedBrandMark(brand)}
      </button>`).join('');
  }

  function categoryIcon(categoryId) {
    const icons = {
      electronics: 'mobile-screen-button.svg',
      fashion: 'shirt.svg',
      'home-living': 'house.svg',
      beauty: 'wand-magic-sparkles.svg',
      'sports-fitness': 'football.svg',
      automotive: 'car.svg',
      books: 'book.svg',
      groceries: 'basket-shopping.svg',
      baby: 'gift.svg',
      office: 'box.svg',
      'phones-tablets': 'mobile-screen-button.svg',
      computers: 'mobile-screen-button.svg',
      'tv-audio': 'youtube.svg',
      gaming: 'puzzle-piece.svg',
      shoes: 'shirt.svg',
      'bags-accessories': 'gift.svg',
      'jewelry-watches': 'tags.svg',
      'personal-care': 'wand-magic-sparkles.svg',
      'health-wellness': 'circle-check.svg',
      'kitchen-appliances': 'house.svg',
      'furniture-decor': 'house.svg',
      toys: 'puzzle-piece.svg',
      'kids-fashion': 'shirt.svg',
      'school-supplies': 'book.svg',
      'tools-home-improvement': 'box.svg',
      'garden-outdoor': 'house.svg',
      pets: 'paw.svg',
      'travel-luggage': 'gift.svg',
      'gifts-crafts': 'gift.svg',
      'business-industrial': 'box.svg',
    };
    return icons[categoryId] || 'tags.svg';
  }

  function renderHeaderCategories() {
    const target = qs('#searchCategory');
    if (target) {
      const current = target.value;
      target.innerHTML = '<option value="all">All Categories</option>' +
        categories.map(category => `<option value="${escapeHtml(category.id)}">${escapeHtml(category.name)}</option>`).join('');
      target.value = categories.some(category => category.id === current) ? current : 'all';
    }

    const badge = qs('#categoryCountBadge');
    if (badge) badge.textContent = String(categories.length);

    const panel = qs('#categoryPanel[data-dynamic-categories]');
    if (panel && categories.length) {
      const viewAll = panel.querySelector('.view-all')?.outerHTML || '<a class="view-all" href="/categories"><img alt="" aria-hidden="true" src="/assets/icons/table-cells-large.svg"><span>View All Categories</span><img alt="" aria-hidden="true" src="/assets/icons/chevron-right.svg"></a>';
      const primaryCategories = orderedCategories().slice(0, PRIMARY_CATEGORY_IDS.length);
      panel.innerHTML = primaryCategories.map(category => `<button data-category="${escapeHtml(category.id)}" type="button"><img alt="" aria-hidden="true" src="/assets/icons/${categoryIcon(category.id)}"><span>${escapeHtml(category.name)}</span></button>`).join('') + viewAll;
    }

    const filterCategories = qs('#homepageFilterCategories');
    if (filterCategories && categories.length) {
      const selected = new FormData(qs('#filterForm')).get('filterCategory') || 'all';
      filterCategories.innerHTML = '<legend>Category</legend>' +
        [`<label><input name="filterCategory" type="radio" value="all" ${selected === 'all' ? 'checked' : ''}/> All categories</label>`,
          ...categories.map(category => `<label><input name="filterCategory" type="radio" value="${escapeHtml(category.id)}" ${selected === category.id ? 'checked' : ''}/> ${escapeHtml(category.name)}</label>`)]
          .join('');
    }
  }

  function renderTrending(list = products.slice(0, 12)) {
    const target = qs('#trendingGrid');
    if (!target) return;
    target.innerHTML = list.length
      ? list.map(productCard).join('')
      : '<div class="product-search-empty"><strong>No matching products</strong><span>Try another product name, brand, or category.</span></div>';
  }

  function updateDailyDealCountdown() {
    const hours = qs('#dealHours');
    const minutes = qs('#dealMinutes');
    const seconds = qs('#dealSeconds');
    if (!hours || !minutes || !seconds) return;
    const now = new Date();
    const end = new Date(now);
    end.setHours(24, 0, 0, 0);
    const remaining = Math.max(0, end.getTime() - now.getTime());
    const totalSeconds = Math.floor(remaining / 1000);
    hours.textContent = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    minutes.textContent = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    seconds.textContent = String(totalSeconds % 60).padStart(2, '0');
  }

  function startDailyDealCountdown() {
    updateDailyDealCountdown();
    if (state.dealCountdownTimer) clearInterval(state.dealCountdownTimer);
    state.dealCountdownTimer = setInterval(updateDailyDealCountdown, 1000);
  }

  function renderDeals() {
    const target = qs('#dealGrid');
    if (!target) return;
    const dealProducts = products
      .filter((product) => Number(product.oldPrice || 0) > Number(product.price || 0))
      .sort((a, b) => ((Number(b.oldPrice) - Number(b.price)) / Number(b.oldPrice)) - ((Number(a.oldPrice) - Number(a.price)) / Number(a.oldPrice)))
      .slice(0, 12);
    target.innerHTML = dealProducts.length
      ? dealProducts.map(compactProductCard).join('')
      : '<div class="product-search-empty"><strong>No live deals right now</strong><span>New discounted products will appear here automatically.</span></div>';
  }

  function renderRecommended() {
    const target = qs('#recommendGrid');
    if (!target) return;
    const recommended = products.slice().sort((a, b) => b.rating - a.rating || b.reviews - a.reviews).slice(0, 12);
    target.innerHTML = recommended.map(recommendCard).join('');
    qsa('.recommend-card', target).forEach(card => card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openProductModal(card.dataset.productPreview);
      }
    }));
  }


  function renderBestSellers() {
    const target = qs('#bestSellerGrid');
    if (!target) return;
    const bestSellers = products.slice().sort((a, b) => b.sold - a.sold || b.reviews - a.reviews).slice(0, 12);
    target.innerHTML = bestSellers.map(productCard).join('');
  }

  function renderBudgetPicks() {
    const target = qs('#budgetGrid');
    if (!target) return;
    const budgetProducts = products.filter(product => Number(product.stock || 0) > 0).slice().sort((a, b) => a.price - b.price || b.rating - a.rating);
    target.innerHTML = budgetProducts.slice(0, 12).map(productCard).join('');
  }

  function renderFreshFinds() {
    const target = qs('#freshFindsGrid');
    if (!target) return;
    const freshProducts = products.slice().sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)).slice(0, 6);
    target.innerHTML = freshProducts.map(miniProductCard).join('');
    qsa('.mini-product-card', target).forEach(card => card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openProductModal(card.dataset.productPreview);
      }
    }));
  }

  function renderRecentlyViewed() {
    const section = qs('#recentlyViewedSection');
    const target = qs('#recentGrid');
    if (!section || !target) return;
    const recentProducts = state.recent
      .map(id => productById(id))
      .filter(Boolean)
      .slice(0, 12);
    section.hidden = recentProducts.length === 0;
    target.innerHTML = recentProducts.map(productCard).join('');
  }

  function showToast(message) {
    const toast = qs('#toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  async function copyShareLink(value) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch { /* use the compatible fallback below */ }

    const helper = document.createElement('textarea');
    helper.value = value;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.left = '-9999px';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    helper.setSelectionRange(0, helper.value.length);
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    helper.remove();
    return copied;
  }

  async function addToCart(id, quantity = 1, variantId = '') {
    const baseProduct = productById(id);
    if (!baseProduct || !window.ClassicMartCart) return null;
    const selectedVariant = variantById(baseProduct, variantId);
    const product = selectedVariant ? {
      ...baseProduct,
      variantId: selectedVariant.id,
      subtitle: selectedVariant.title || baseProduct.subtitle,
      price: Number(selectedVariant.price ?? baseProduct.price) || 0,
      oldPrice: Number(selectedVariant.oldPrice ?? selectedVariant.price ?? baseProduct.oldPrice ?? baseProduct.price) || 0,
      currency: selectedVariant.currency || baseProduct.currency,
      stock: Math.max(0, Number(selectedVariant.stock ?? baseProduct.stock) || 0),
      sku: selectedVariant.sku || baseProduct.sku,
    } : baseProduct;
    const requestedQuantity = Math.max(1, Math.min(99, Number(quantity) || 1));
    if (Number(product.stock) <= 0) {
      showToast('This option is out of stock.');
      return null;
    }
    if (requestedQuantity > Number(product.stock)) {
      showToast(`Only ${product.stock} item(s) are available.`);
      return null;
    }
    try {
      const savedItems = await window.ClassicMartCart.add(product, requestedQuantity);
      state.cart = window.ClassicMartCart.asLegacyCart();
      updateCartUI();
      showToast(`${requestedQuantity} × ${product.name}${selectedVariant?.title && selectedVariant.title !== 'Default' ? ` (${selectedVariant.title})` : ''} added to your cart`);
      return savedItems;
    } catch (error) {
      showToast(error.message || 'Item could not be added to your cart.');
      return null;
    }
  }

  async function updateCartQuantity(id, nextQuantity) {
    if (!window.ClassicMartCart) return;
    try {
      await window.ClassicMartCart.setQuantity(id, nextQuantity);
      state.cart = window.ClassicMartCart.asLegacyCart();
      updateCartUI();
    } catch (error) { showToast(error.message || 'Cart could not be updated.'); }
  }

  async function removeFromCart(id) {
    const product = productById(id);
    if (!window.ClassicMartCart) return;
    try {
      await window.ClassicMartCart.remove(id);
      state.cart = window.ClassicMartCart.asLegacyCart();
      updateCartUI();
      showToast(product ? `${product.name} removed` : 'Item removed');
    } catch (error) { showToast(error.message || 'Item could not be removed.'); }
  }

  function cartEntries() {
    return Object.entries(state.cart)
      .map(([id, quantity]) => ({ product: productById(id), quantity: Number(quantity) }))
      .filter(entry => entry.product && entry.quantity > 0);
  }

  function updateCartUI() {
    const totalItems = window.ClassicMartCart
      ? window.ClassicMartCart.count()
      : cartEntries().reduce((sum, entry) => sum + entry.quantity, 0);
    const cartCount = qs('#cartCount');
    if (cartCount) cartCount.textContent = totalItems;
    window.ClassicMartCart?.decorateLinks();
  }

  window.addEventListener('classicmart:cartchange', () => {
    state.cart = window.ClassicMartCart?.asLegacyCart() || {};
    updateCartUI();
  });

  function openCart() {
    closeAllModals();
    if (window.ClassicMartCart) window.ClassicMartCart.navigate();
    else window.location.href = cartTransferUrl();
  }

  function closeCart() {
    const drawer = qs('#cartDrawer');
    const backdrop = qs('#drawerBackdrop');
    if (!drawer) return;
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    backdrop?.classList.remove('show');
    if (backdrop) setTimeout(() => { backdrop.hidden = true; }, 250);
    document.body.classList.remove('no-scroll');
  }

  async function toggleWishlist(id) {
    const productId = String(id);
    const product = productById(productId);
    const index = state.wishlist.indexOf(productId);
    const response = await fetch(`/api/v1/storefront/wishlist/${encodeURIComponent(productId)}`, {
      method: index >= 0 ? 'DELETE' : 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'x-csrf-token': state.csrfToken
      }
    });
    if (response.status === 401) {
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
      return;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast(payload.error?.message || 'Wishlist could not be updated.');
      return;
    }
    state.wishlist = payload.wishlist || [];
    showToast(index >= 0 ? `${product?.name || 'Product'} removed from wishlist` : `${product?.name || 'Product'} saved to wishlist`);
    document.querySelectorAll('[data-wishlist-count]').forEach(badge => { badge.textContent = String(state.wishlist.length); });
    renderTrending(state.filteredProducts);
    renderBestSellers();
    renderBudgetPicks();
  }

  async function openProductModal(id) {
    let product = productById(id);
    if (!product) return;
    try {
      const detailResponse = await fetch(`/api/v1/storefront/products/${encodeURIComponent(id)}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (detailResponse.ok) {
        const detailPayload = await detailResponse.json();
        product = normalizeProduct({ ...product, ...(detailPayload.product || {}) });
        const productIndex = products.findIndex((item) => String(item.id) === String(product.id));
        if (productIndex >= 0) products[productIndex] = product;
      }
    } catch {
      // Preserve the already-rendered catalogue card when the detail request is temporarily unavailable.
    }
    const wished = state.wishlist.includes(product.id);
    const initialVariant = variantById(product, product.variantId);
    previewState.productId = product.id;
    previewState.variantId = initialVariant?.id || '';
    previewState.quantity = 1;
    const lowData = document.documentElement.dataset.lowData === 'true' || navigator.connection?.saveData === true;
    const images = (product.images || [product.image]).slice(0, lowData ? 1 : 5);
    const discount = Math.max(0, Math.round((1 - product.price / product.oldPrice) * 100));
    const reviewItems = (product.reviewItems || []).slice(0, 4);
    if (state.csrfToken && !state.recentRecorded?.has(product.id)) {
      state.recentRecorded ||= new Set();
      state.recentRecorded.add(product.id);
      state.recent = [product.id, ...state.recent.filter(id => id !== product.id)].slice(0, 50);
      renderRecentlyViewed();
      fetch(`/api/v1/storefront/recent/${encodeURIComponent(product.id)}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'x-csrf-token': state.csrfToken }
      }).catch(() => {});
    }
    const dimensions = product.dimensions
      ? `${product.dimensions.width || '—'} × ${product.dimensions.height || '—'} × ${product.dimensions.depth || '—'} cm`
      : 'See packaging details';
    const shareUrl = new URL(`/products/${encodeURIComponent(product.id)}`, window.location.origin).toString();
    const whatsappText = `Hello Classic Mart, I am interested in ${product.name} (${money(product.price, product.currency)}). ${shareUrl}`;
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(whatsappText)}`;
    const topShare = qs('#productModalShare');
    const topWishlist = qs('#productModalWishlist');
    if (topShare) {
      topShare.dataset.shareProduct = product.id;
      topShare.dataset.shareUrl = shareUrl;
    }
    const shareMenu = qs('#productShareMenu');
    const shareCopy = qs('#productShareCopy');
    const shareWhatsApp = qs('#productShareWhatsApp');
    if (shareMenu) shareMenu.hidden = true;
    if (topShare) topShare.setAttribute('aria-expanded', 'false');
    if (shareCopy) shareCopy.dataset.shareUrl = shareUrl;
    if (shareWhatsApp) shareWhatsApp.href = `https://wa.me/?text=${encodeURIComponent(`Take a look at ${product.name} on Classic Mart. ${shareUrl}`)}`;
    if (topWishlist) {
      topWishlist.dataset.wishlist = product.id;
      topWishlist.classList.toggle('active', wished);
      topWishlist.setAttribute('aria-pressed', String(wished));
      const icon = topWishlist.querySelector('img');
      if (icon) icon.src = wishlistIcon(wished);
    }

    const reviewMarkup = reviewItems.length ? reviewItems.map(feedbackReviewMarkup).join('') : '<p class="empty-preview-copy">Customer feedback will appear here after verified purchases.</p>';

    const ratingTotal = Math.max(0, Number(product.reviews) || 0);
    const ratingRows = [5, 4, 3, 2, 1].map((stars) => {
      const count = Math.max(0, Number(product.ratingDistribution?.[stars] ?? product.ratingDistribution?.[String(stars)]) || 0);
      const value = ratingTotal ? Math.round((count / ratingTotal) * 100) : 0;
      return `<div class="rating-breakdown-row"><span>${stars} ★</span><i><b style="width:${value}%"></b></i><small>${count}</small></div>`;
    }).join('');

    const tagMarkup = (product.tags || [product.category, 'quality checked', 'buyer protected']).slice(0, 4)
      .map(tag => `<span>${escapeHtml(String(tag).replaceAll('-', ' '))}</span>`).join('');
    const attributeMarkup = Object.entries(product.attributes || {}).filter(([, value]) => String(value || '').trim()).slice(0, 20).map(([name, value]) => `<div><dt>${escapeHtml(String(name).replaceAll('_', ' '))}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
    const promoterEarning = Math.max(0, Number(product.promoterCommissionBps) || 0) > 0 ? product.price * Math.max(0, Number(product.promoterCommissionBps) || 0) / 10000 : 0;
    const publishedLabel = product.publishedAt ? new Date(product.publishedAt).toLocaleDateString() : 'Published listing';
    const videoMarkup = product.videoUrl ? `<a class="preview-video-link" href="${escapeHtml(product.videoUrl)}" target="_blank" rel="noopener noreferrer">Watch product video ↗</a>` : '';
    const variantDetailMarkup = (product.variants || []).map((variant) => {
      const options = Object.entries(variant.options || {}).map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(value)}`).join(' · ');
      return `<article class="preview-variant-detail"><div><strong>${escapeHtml(variant.title || 'Default')}</strong><small>${options || 'Standard option'}</small></div><div><span>${money(Number(variant.price || product.price), variant.currency || product.currency)}</span><small>${Math.max(0, Number(variant.stock) || 0)} in stock</small></div><dl><div><dt>SKU</dt><dd>${escapeHtml(variant.sku || 'Not provided')}</dd></div>${variant.barcode ? `<div><dt>Barcode</dt><dd>${escapeHtml(variant.barcode)}</dd></div>` : ''}${Number(variant.weightGrams) > 0 ? `<div><dt>Weight</dt><dd>${(Number(variant.weightGrams)/1000).toFixed(2)} kg</dd></div>` : ''}</dl></article>`;
    }).join('');
    const paymentMarkup = (product.paymentMethods || []).map((method) => ({card:'Card',mobile:'Mobile money',cod:'Cash on delivery'}[method] || method).replaceAll('_',' ')).join(' · ');
    const deliveryOptions = product.deliveryOptions || {};
    const standardDeliveryLabel = deliveryOptions.standardEnabled === false ? 'Not available' : `Usually within ${deliveryTimeLabel(deliveryOptions.standardSlaHours || 72)}`;
    const expressDeliveryLabel = deliveryOptions.expressEnabled ? `Usually within ${deliveryTimeLabel(deliveryOptions.expressSlaHours || 24)}` : 'Not available';
    const pickupLabel = deliveryOptions.pickupEnabled ? 'Available at eligible pickup points' : 'Not available';
    const sellerVerifiedLabel = product.seller?.verifiedAt ? new Date(product.seller.verifiedAt).toLocaleDateString() : (product.seller?.verified ? 'Verified seller' : 'Verification unavailable');
    const mediaSummary = `${images.length} image${images.length === 1 ? '' : 's'}${product.videoUrl ? ' · video available' : ''}`;


    const relatedProducts = products
      .filter(item => item.id !== product.id)
      .sort((a, b) => {
        const categoryDifference = Number(b.category === product.category) - Number(a.category === product.category);
        if (categoryDifference) return categoryDifference;
        const brandDifference = Number(b.brand === product.brand) - Number(a.brand === product.brand);
        if (brandDifference) return brandDifference;
        return b.rating - a.rating || b.sold - a.sold;
      })
      .slice(0, 5);

    const relatedMarkup = relatedProducts.map(item => `
      <article class="preview-related-card" data-product-preview="${item.id}" tabindex="0" role="button" aria-label="Open ${escapeHtml(item.name)} preview">
        <div class="preview-related-image">${imageWithFallback(item.image, item.name)}</div>
        <div class="preview-related-copy">
          <h4>${escapeHtml(item.name)}</h4>
          <div class="preview-related-commerce"><strong>${money(item.price, item.currency)}</strong><span>${item.reviews ? `${item.rating.toFixed(1)} ★ (${reviewCount(item.reviews)})` : 'New'}</span></div>
          <button type="button" data-add-cart="${item.id}">Add to cart</button>
        </div>
      </article>`).join('');

    qs('#productModalContent').innerHTML = `
      <div class="product-preview">
        <nav class="preview-breadcrumb" aria-label="Breadcrumb"><a href="/">Home</a><b>›</b><a href="/products?category=${encodeURIComponent(product.category)}">${escapeHtml(categoryLabel(product.category))}</a><b>›</b><strong>${escapeHtml(product.name)}</strong></nav>

        <div class="product-preview-main">
          <div class="product-gallery">
            <div class="gallery-main"><img id="previewMainImage" src="${images[0]}" alt="${escapeHtml(product.name)}" referrerpolicy="no-referrer"></div>
            <div class="gallery-thumbnails" aria-label="Product images">
              ${images.map((image, imageIndex) => `<button class="gallery-thumb ${imageIndex === 0 ? 'active' : ''}" data-gallery-thumb="${image}" type="button" aria-label="View image ${imageIndex + 1}"><img src="${image}" alt="${escapeHtml(product.name)} view ${imageIndex + 1}" loading="lazy" referrerpolicy="no-referrer"></button>`).join('')}
            </div>
          </div>

          <div class="product-modal-copy">
            <div class="preview-badges"><span class="product-badge ${badgeClass(product)}">${escapeHtml(product.badge)}</span><span class="verified-badge"><img src="/assets/icons/circle-check.svg" alt=""> Verified listing</span></div>
            <h2 id="productModalTitle">${escapeHtml(product.name)}</h2>
            <div class="preview-title-meta"><a href="/products?brand=${encodeURIComponent(product.brandSlug || product.brand)}">${escapeHtml(product.brand)}</a><span>${product.reviews ? `${Number(product.rating || 0).toFixed(1)} ★ · ${reviewCount(product.reviews)} reviews` : 'New · no verified reviews yet'}</span><span>${reviewCount(product.sold || 0)} sold</span></div>

            <div class="preview-price-row"><strong id="previewUnitPrice">${money(product.price, product.currency)}</strong><del id="previewOldPrice" ${product.oldPrice > product.price ? '' : 'hidden'}>${product.oldPrice > product.price ? money(product.oldPrice, product.currency) : ''}</del><span id="previewDiscount" ${discount ? '' : 'hidden'}>${discount ? `Save ${discount}%` : ''}</span></div>
            <div class="preview-value-row">${promoterEarning > 0 ? `<span>Promoter earns <strong>${money(promoterEarning, product.currency)}</strong></span>` : ''}<span>Listed ${escapeHtml(publishedLabel)}</span>${videoMarkup}</div>
            <div class="preview-payment-note"><img src="/assets/icons/credit-card.svg" alt=""><span>${paymentMarkup ? `Payment options: ${escapeHtml(paymentMarkup)}. ` : ''}Taxes and delivery are calculated before confirmation.</span></div>
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
              <button class="button button-primary preview-cart-button" data-modal-add-cart="${product.id}" type="button"><img src="/assets/icons/cart-plus.svg" alt=""><span data-preview-add-label>Add to Cart</span></button>
              <button class="buy-now-button" data-buy-now="${product.id}" type="button">Buy Now</button>
              <a class="preview-whatsapp-button" href="${whatsappUrl}" target="_blank" rel="noopener noreferrer" aria-label="Chat about this product on WhatsApp"><img class="whatsapp-logo" src="/assets/icons/whatsapp.svg" alt=""><strong>WhatsApp</strong></a>
            </div>
          </div>
        </div>

        <section class="preview-information-grid" aria-label="Shopping information">
          <article><img src="/assets/icons/rotate-left.svg" alt=""><div><strong>Returns</strong><small>${escapeHtml(product.returnPolicy)}</small></div></article>
          <article><img src="/assets/icons/circle-check.svg" alt=""><div><strong>Warranty</strong><small>${escapeHtml(product.warrantyInformation)}</small></div></article>
          <article><img src="/assets/icons/headset.svg" alt=""><div><strong>Delivery</strong><small>${escapeHtml(product.shippingInformation)}</small></div></article>
        </section>

        <section class="preview-panel preview-buying-details" aria-label="Buying details">
          <div class="preview-panel-heading"><span>Buying details</span><h3>Delivery, protection and listing facts</h3></div>
          <div class="preview-buying-cards">
            <article class="preview-buying-card">
              <div class="preview-buying-card-heading"><span>Delivery &amp; payment</span><strong>How you receive and pay</strong></div>
              <dl class="preview-buying-grid">
                <div><dt>Standard delivery</dt><dd>${escapeHtml(standardDeliveryLabel)}</dd></div>
                <div><dt>Express delivery</dt><dd>${escapeHtml(expressDeliveryLabel)}</dd></div>
                <div><dt>Pickup</dt><dd>${escapeHtml(pickupLabel)}</dd></div>
                <div><dt>Returns</dt><dd>${Math.max(0, Number(product.returnWindowDays) || 0) ? `${Math.max(0, Number(product.returnWindowDays) || 0)} days for eligible items` : 'Eligibility shown before purchase'}</dd></div>
                <div><dt>Payment</dt><dd>${escapeHtml(paymentMarkup || 'Shown at checkout')}</dd></div>
              </dl>
            </article>
            <article class="preview-buying-card">
              <div class="preview-buying-card-heading"><span>Listing &amp; seller</span><strong>Product and marketplace facts</strong></div>
              <dl class="preview-buying-grid">
                <div><dt>Product ID</dt><dd>${escapeHtml(product.id)}</dd></div>
                <div><dt>Product media</dt><dd>${escapeHtml(mediaSummary)}</dd></div>
                <div><dt>Seller verification</dt><dd>${escapeHtml(sellerVerifiedLabel)}</dd></div>
                ${Number(product.qualityScore) > 0 ? `<div><dt>Listing completeness</dt><dd>${Math.round(Number(product.qualityScore))}%</dd></div>` : ''}
                ${product.policyVersion ? `<div><dt>Marketplace policy</dt><dd>${escapeHtml(product.policyVersion)}</dd></div>` : ''}
              </dl>
            </article>
          </div>
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
            <dl class="spec-list"><div><dt>Brand</dt><dd>${escapeHtml(product.brand)}</dd></div><div><dt>SKU</dt><dd>${escapeHtml(product.sku)}</dd></div>${product.barcode ? `<div><dt>Barcode</dt><dd>${escapeHtml(product.barcode)}</dd></div>` : ''}<div><dt>Category</dt><dd>${escapeHtml(categoryLabel(product.category))}</dd></div><div><dt>Dimensions</dt><dd>${escapeHtml(dimensions)}</dd></div><div><dt>Weight</dt><dd>${escapeHtml(product.weight)}</dd></div><div><dt>Minimum order</dt><dd>${product.minimumOrderQuantity} unit</dd></div><div><dt>Published</dt><dd>${escapeHtml(publishedLabel)}</dd></div>${attributeMarkup}</dl>
          </section>
          <section class="preview-panel seller-panel">
            <div class="seller-logo">${escapeHtml(product.seller.name.charAt(0).toUpperCase())}</div><div><span>Sold by</span><h3>${escapeHtml(product.seller.name)}</h3><p>${escapeHtml(product.seller.description || 'Verified Classic Mart marketplace seller.')}</p><div><b>${escapeHtml(product.seller.country)}</b><b>${product.stock} available</b><b>Verified seller</b></div><div class="seller-panel-links"><a href="/sellers/${encodeURIComponent(product.seller.slug)}">Seller profile</a><a href="/products?seller=${encodeURIComponent(product.seller.slug)}">Seller products</a></div></div>
          </section>
        </div>

        <section class="preview-panel preview-variant-panel"><div class="preview-panel-heading"><span>Options</span><h3>Available variants</h3></div><div class="preview-variant-details">${variantDetailMarkup || '<p class="empty-preview-copy">One standard option is available.</p>'}</div></section>

        <section class="preview-reviews" id="previewReviews">
          <div class="preview-section-title"><div><span>Ratings &amp; reviews</span><h3>Feedback from verified buyers</h3></div><button class="review-write-button" type="button" data-focus-review-form>Write a review</button></div>
          <div class="preview-ai-summary" id="previewAiSummary"><small>Classic AI review summary uses verified-purchase reviews only. Summary unavailable until enough review data and an approved AI provider are available.</small></div><div class="preview-ratings-layout">
            <aside class="rating-overview-card">
              <div class="rating-score"><strong>${product.rating.toFixed(1)}</strong><span>${starMarkup(product.rating)}</span><small>Based on ${reviewCount(product.reviews)} ratings</small></div>
              <div class="rating-breakdown">${ratingRows}</div>
              <div class="rating-highlights">${product.reviews ? `<span><b>${product.rating.toFixed(1)}</b> average</span><span><b>${reviewCount(product.reviews)}</b> reviews</span>` : '<span><b>New</b> No verified reviews yet</span>'}</div>
            </aside>
            <div class="preview-review-list">${reviewMarkup}</div>${product.reviewPage?.hasMore ? `<button class="outline-button" type="button" data-load-more-reviews>Load more reviews</button>` : ``}
          </div>

          <form class="preview-review-form" id="previewReviewForm" data-product-name="${escapeHtml(product.name)}">
            <div class="review-form-heading"><div><span>Share your experience</span><h3>Write a product review</h3></div><small>Only verified purchases are published publicly.</small></div>
            <div class="review-star-input" role="radiogroup" aria-label="Your rating">
              ${[1,2,3,4,5].map(star => `<button type="button" data-review-star="${star}" aria-label="${star} star${star > 1 ? 's' : ''}">★</button>`).join('')}
              <input type="hidden" id="previewReviewRating" name="rating" value="0">
            </div>
            <div class="review-form-grid"><label>Review title<input name="title" type="text" required maxlength="160" placeholder="Summarise your experience"></label></div>
            <label>Your review<textarea name="review" rows="4" required placeholder="What did you like? How was the quality, value and delivery?"></textarea></label>
            <div class="review-form-actions"><button class="button button-primary" type="submit">Submit review</button></div>
          </form>
        </section>

        <section class="preview-panel preview-community-panel" aria-labelledby="previewQuestionsTitle">
          <div class="preview-panel-heading"><span>Questions &amp; alerts</span><h3 id="previewQuestionsTitle">Ask before you buy</h3></div>
          <div class="preview-question-list">${(product.questions || []).length ? product.questions.map(feedbackQuestionMarkup).join('') : '<p class="empty-preview-copy">No answered questions yet.</p>'}</div>${product.questionPage?.hasMore ? `<button class="outline-button" type="button" data-load-more-questions>Load more questions</button>` : ``}
          <form id="previewQuestionForm" class="preview-review-form"><label>Your question<textarea name="question" rows="2" minlength="5" maxlength="500" required placeholder="Ask about size, compatibility, warranty or another product detail"></textarea></label><button class="button" type="submit">Submit question</button></form>
          <div class="review-form-actions">${Number(product.stock||0)<=0?'<button class="button" type="button" data-product-alert="restock">Notify me when restocked</button>':''}<button class="button" type="button" data-product-alert="price_drop">Watch price drops</button></div>
        </section>

        <section class="preview-related-products" aria-labelledby="previewRelatedTitle">
          <div class="preview-related-heading">
            <div><span>Recommended for you</span><h3 id="previewRelatedTitle">Other products you may like</h3></div>
            <a href="/products?category=${encodeURIComponent(product.category)}">View all</a>
          </div>
          <div class="preview-related-grid" id="previewRelatedGrid">${relatedMarkup}</div>
        </section>
      </div>`;
    Promise.allSettled([
      fetch(`/api/v1/ai/products/${encodeURIComponent(product.id)}/similar`, { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(async response => response.ok ? response.json() : null),
      fetch(`/api/v1/ai/products/${encodeURIComponent(product.id)}/review-summary`, { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(async response => response.ok ? response.json() : null)
    ]).then(([similarResult, reviewResult]) => {
      const similar = similarResult.status === 'fulfilled' ? (similarResult.value?.products || []) : [];
      const grid = qs('#previewRelatedGrid');
      if (grid && similar.length) grid.innerHTML = similar.slice(0, 5).map(item => `
        <article class="preview-related-card" data-product-preview="${escapeHtml(item.id)}" tabindex="0" role="button" aria-label="Open ${escapeHtml(item.name)} preview">
          <div class="preview-related-image">${imageWithFallback(item.image, item.name)}</div>
          <div class="preview-related-copy"><h4>${escapeHtml(item.name)}</h4><div class="preview-related-commerce"><strong>${money(item.price, item.currency)}</strong><span>${Number(item.reviews || 0) ? `${Number(item.rating || 0).toFixed(1)} ★ (${reviewCount(item.reviews)})` : 'New'}</span></div><button type="button" data-add-cart="${escapeHtml(item.id)}">Add to cart</button></div>
        </article>`).join('');
      const summary = reviewResult.status === 'fulfilled' ? reviewResult.value?.summary : null;
      const summaryBox = qs('#previewAiSummary');
      if (summaryBox && summary?.reviewCount > 0) summaryBox.innerHTML = `<strong>Classic AI review summary</strong><p>${escapeHtml(summary.summary || '')}</p><small>Based on ${Number(summary.reviewCount) || 0} verified-purchase reviews. AI-generated summary; check individual reviews for context.</small>`;
    }).catch(() => {});

    qs('[data-load-more-reviews]')?.addEventListener('click', async event => {
      const button=event.currentTarget;if(!product.reviewPage?.hasMore||!product.reviewPage.next)return;button.disabled=true;
      try{const response=await fetch(`/api/v1/reviews/product/${encodeURIComponent(product.id)}?limit=20&after=${encodeURIComponent(product.reviewPage.next)}`,{credentials:'same-origin',headers:{Accept:'application/json'}});const payload=await response.json().catch(()=>({}));if(!response.ok)throw new Error(payload.error?.message||'Reviews could not be loaded.');const list=qs('.preview-review-list');const seen=new Set((product.reviewItems||[]).map(row=>String(row.publicId||'')));for(const row of payload.reviews||[]){if(!seen.has(String(row.publicId||''))){product.reviewItems.push(row);seen.add(String(row.publicId||''));if(list)list.insertAdjacentHTML('beforeend',feedbackReviewMarkup(row));}}product.reviewPage=payload.page||{hasMore:false,next:''};if(!product.reviewPage.hasMore)button.remove();else button.disabled=false;}catch(error){button.disabled=false;showToast(error.message||'Reviews could not be loaded.');}
    });
    qs('[data-load-more-questions]')?.addEventListener('click', async event => {
      const button=event.currentTarget;if(!product.questionPage?.hasMore||!product.questionPage.next)return;button.disabled=true;
      try{const response=await fetch(`/api/v1/storefront/products/${encodeURIComponent(product.id)}/questions?limit=20&after=${encodeURIComponent(product.questionPage.next)}`,{credentials:'same-origin',headers:{Accept:'application/json'}});const payload=await response.json().catch(()=>({}));if(!response.ok)throw new Error(payload.error?.message||'Questions could not be loaded.');const list=qs('.preview-question-list');const seen=new Set((product.questions||[]).map(row=>String(row.publicId||'')));for(const row of payload.questions||[]){if(!seen.has(String(row.publicId||''))){product.questions.push(row);seen.add(String(row.publicId||''));if(list)list.insertAdjacentHTML('beforeend',feedbackQuestionMarkup(row));}}product.questionPage=payload.page||{hasMore:false,next:''};if(!product.questionPage.hasMore)button.remove();else button.disabled=false;}catch(error){button.disabled=false;showToast(error.message||'Questions could not be loaded.');}
    });

    qs('#previewReviewForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      const rating = Number(qs('#previewReviewRating')?.value || 0);
      if (!rating) {
        showToast('Please choose a star rating');
        qs('[data-review-star]')?.focus();
        return;
      }
      if (!state.csrfToken) {
        location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
        return;
      }
      const form = new FormData(event.currentTarget);
      const response = await fetch('/api/v1/reviews', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', Accept: 'application/json', 'x-csrf-token': state.csrfToken },
        body: JSON.stringify({ productId: product.id, rating, title: form.get('title'), body: form.get('review') })
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401) { location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`; return; }
      if (!response.ok) { showToast(payload.error?.message || 'Review could not be submitted.'); return; }
      showToast('Review submitted for moderation.');
      await openProductModal(product.id);
    });
    qs('#previewQuestionForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      if (!state.csrfToken) { location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`; return; }
      const question = String(new FormData(event.currentTarget).get('question') || '').trim();
      const response = await fetch(`/api/v1/storefront/products/${encodeURIComponent(product.id)}/questions`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', Accept: 'application/json', 'x-csrf-token': state.csrfToken },
        body: JSON.stringify({ question })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) { showToast(payload.error?.message || 'Question could not be submitted.'); return; }
      event.currentTarget.reset();
      showToast('Question submitted to the seller.');
    });
    qsa('[data-product-alert]', qs('#productModalContent')).forEach(button => button.addEventListener('click', async () => {
      if (!state.csrfToken) { location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`; return; }
      const response = await fetch(`/api/v1/storefront/alerts/${encodeURIComponent(product.id)}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', Accept: 'application/json', 'x-csrf-token': state.csrfToken },
        body: JSON.stringify({ type: button.dataset.productAlert })
      });
      const payload = await response.json().catch(() => ({}));
      showToast(response.ok ? 'Product alert saved.' : (payload.error?.message || 'Alert could not be saved.'));
    }));
    updatePreviewPurchaseSummary();
    openModal('productModal');
  }

  function openModal(id) {
    closeCart();
    closeFilter();
    const modal = qs(`#${id}`);
    const backdrop = qs('#modalBackdrop');
    if (!modal || !backdrop) return;
    state.lastFocused = document.activeElement;
    qsa('.modal.open').forEach(item => {
      item.classList.remove('open');
      item.hidden = true;
    });
    modal.hidden = false;
    backdrop.hidden = false;
    document.body.classList.add('no-scroll');
    requestAnimationFrame(() => {
      backdrop.classList.add('show');
      modal.classList.add('open');
    });
    setTimeout(() => modal.querySelector('input, select, textarea, button')?.focus(), 100);
  }

  function closeAllModals() {
    const backdrop = qs('#modalBackdrop');
    const openModal = qs('.modal.open');
    if (!openModal) return;
    openModal.classList.remove('open');
    backdrop.classList.remove('show');
    setTimeout(() => {
      openModal.hidden = true;
      backdrop.hidden = true;
    }, 220);
    document.body.classList.remove('no-scroll');
    const shareMenu = qs('#productShareMenu');
    if (shareMenu) shareMenu.hidden = true;
    qs('#productModalShare')?.setAttribute('aria-expanded', 'false');
    state.lastFocused?.focus?.();
  }

  function openFilter() {
    closeCart();
    closeAllModals();
    const drawer = qs('#filterDrawer');
    const backdrop = qs('#drawerBackdrop');
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    backdrop.hidden = false;
    requestAnimationFrame(() => backdrop.classList.add('show'));
    document.body.classList.add('no-scroll');
  }

  function closeFilter() {
    const drawer = qs('#filterDrawer');
    if (!drawer?.classList.contains('open')) return;
    const backdrop = qs('#drawerBackdrop');
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    backdrop.classList.remove('show');
    setTimeout(() => { backdrop.hidden = true; }, 250);
    document.body.classList.remove('no-scroll');
  }

  function scrollToSelector(selector) {
    qs(selector)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function filterByCategory(category) {
    state.filteredProducts = category === 'all' ? products.slice() : products.filter(product => product.category === category);
    renderTrending(state.filteredProducts);
    scrollToSelector('#trending');
    const name = categories.find(item => item.id === category)?.name || 'All products';
    showToast(`${state.filteredProducts.length} ${name.toLowerCase()} item${state.filteredProducts.length === 1 ? '' : 's'}`);
    qs('#categoryPanel')?.classList.remove('open');
    qs('#menuToggle')?.setAttribute('aria-expanded', 'false');
  }

  function searchProducts(query, category = 'all') {
    const normalized = query.trim().toLowerCase();
    let result = products.filter(product => category === 'all' || product.category === category);
    if (normalized) {
      result = result.filter(product => [product.name, product.subtitle, product.category, product.brand, product.description].join(' ').toLowerCase().includes(normalized));
    }
    state.filteredProducts = result;
    renderTrending(result);
    scrollToSelector('#trending');
    showToast(result.length ? `${result.length} matching product${result.length === 1 ? '' : 's'} found` : 'No matching products found');
  }

  function matchingProducts(query, category = 'all') {
    const normalized = query.trim().toLowerCase();
    return products.filter(product => {
      const categoryMatches = category === 'all' || product.category === category;
      if (!categoryMatches) return false;
      if (!normalized) return true;
      const searchableText = [
        product.name,
        product.subtitle,
        product.category,
        categoryLabel(product.category),
        product.brand,
        product.description,
        ...(product.tags || [])
      ].join(' ').toLowerCase();
      return searchableText.includes(normalized);
    });
  }

  function applyLiveSearch() {
    const input = qs('#searchInput');
    const category = qs('#searchCategory')?.value || 'all';
    if (!input) return [];
    const value = input.value.trim();
    const matches = matchingProducts(value, category);
    const visibleProducts = value || category !== 'all' ? matches : products.slice(0, 12);
    state.filteredProducts = visibleProducts;
    renderTrending(visibleProducts);
    return matches;
  }

  function updateSearchSuggestions() {
    const input = qs('#searchInput');
    const panel = qs('#searchSuggestions');
    const category = qs('#searchCategory')?.value || 'all';
    if (!input || !panel) return;

    const value = input.value.trim();
    const matches = matchingProducts(value, category);
    const visibleProducts = value || category !== 'all' ? matches : products.slice(0, 12);
    state.filteredProducts = visibleProducts;
    renderTrending(visibleProducts);

    if (!value) {
      panel.classList.remove('show');
      panel.innerHTML = '';
      return;
    }

    const visibleMatches = matches.slice(0, 6);
    panel.innerHTML = `
      <div class="search-results-summary">
        <span><strong>${matches.length}</strong> result${matches.length === 1 ? '' : 's'} for “${escapeHtml(value)}”</span>
        <button data-search-all type="button">View filtered products</button>
      </div>
      ${visibleMatches.length ? visibleMatches.map(product => `
        <button class="search-result-option" data-suggestion="${product.id}" type="button" role="option">
          ${imageWithFallback(product.image, product.name)}
          <span><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.subtitle)} · ${escapeHtml(product.brand)}</small></span>
          <b>${money(product.price, product.currency)}</b>
        </button>`).join('') : '<div class="no-suggestions">No products match your search and selected category.</div>'}`;
    panel.classList.add('show');
  }

  function goToHero(index) {
    const slides = qsa('.hero-slide');
    if (!slides.length) return;
    state.heroIndex = (index + slides.length) % slides.length;
    qs('#heroTrack').style.transform = `translateX(-${state.heroIndex * 100}%)`;
    qsa('#heroDots button').forEach((button, buttonIndex) => button.classList.toggle('active', buttonIndex === state.heroIndex));
  }

  function startHero() {
    clearInterval(state.heroTimer);
    if (qsa('.hero-slide').length < 2) return;
    state.heroTimer = setInterval(() => goToHero(state.heroIndex + 1), 5600);
  }

  function openContent(title, html) {
    qs('#contentModalBody').innerHTML = `<h2 id="contentModalTitle">${escapeHtml(title)}</h2>${html}`;
    openModal('contentModal');
  }

  function installMobileSectionControls() {
    qsa('.mobile-more-wrap').forEach((wrapper) => wrapper.remove());
  }

  async function shareProductLink(button) {
    const product = productById(button?.dataset.shareProduct);
    const url = button?.dataset.shareUrl || window.location.href;
    const shareText = product
      ? `Take a look at ${product.name} on Classic Mart.`
      : 'Take a look at this product on Classic Mart.';
    const menu = qs('#productShareMenu');
    const copyButton = qs('#productShareCopy');
    const whatsappLink = qs('#productShareWhatsApp');

    if (copyButton) copyButton.dataset.shareUrl = url;
    if (whatsappLink) {
      whatsappLink.href = `https://wa.me/?text=${encodeURIComponent(`${shareText} ${url}`)}`;
    }

    // Some Android WebViews expose navigator.share but terminate it with
    // RESULT_CODE_KILLED_BAD_MESSAGE. The in-page menu is reliable in browsers,
    // installed PWAs and local-file previews, so it is now the primary flow.
    if (menu) {
      menu.hidden = !menu.hidden;
      button?.setAttribute('aria-expanded', String(!menu.hidden));
      if (!menu.hidden) setTimeout(() => whatsappLink?.focus(), 0);
      return true;
    }

    const copied = await copyShareLink(url);
    showToast(copied ? 'Product link copied — ready to share' : `Share this link: ${url}`);
    return copied;
  }

  async function handleDocumentClick(event) {
    const activeShareMenu = qs('#productShareMenu');
    if (activeShareMenu && !activeShareMenu.hidden && !event.target.closest('#productShareMenu, [data-share-product]')) {
      activeShareMenu.hidden = true;
      qs('#productModalShare')?.setAttribute('aria-expanded', 'false');
    }

    const cartLink = event.target.closest('a[href="/cart"], a[href^="/cart"]');
    if (cartLink) {
      event.preventDefault();
      window.location.href = cartTransferUrl();
      return;
    }

    const directoryPage = event.target.closest('[data-directory-page]');
    if (directoryPage) {
      window.location.href = directoryPage.dataset.directoryPage;
      return;
    }

    const promoter = event.target.closest('[data-promoter]');
    if (promoter) {
      window.location.href = `/promoters?q=${encodeURIComponent(promoter.dataset.promoter)}`;
      return;
    }

    const sectionNext = event.target.closest('[data-scroll-next]');
    if (sectionNext) {
      const target = qs(`#${sectionNext.dataset.scrollNext}`);
      if (!target) return;
      const firstItem = target.firstElementChild;
      const styles = getComputedStyle(target);
      const gap = parseFloat(styles.columnGap || styles.gap || 0) || 0;
      const step = firstItem ? firstItem.getBoundingClientRect().width + gap : Math.max(260, target.clientWidth * .8);
      const maxScroll = Math.max(0, target.scrollWidth - target.clientWidth);
      if (maxScroll > 4) {
        const nextLeft = target.scrollLeft + Math.max(step, target.clientWidth * .72);
        target.scrollTo({ left: nextLeft >= maxScroll - 4 ? 0 : nextLeft, behavior: 'smooth' });
      } else if (firstItem && target.children.length > 1) {
        target.appendChild(firstItem);
        target.animate([{ opacity: .76, transform: 'translateX(8px)' }, { opacity: 1, transform: 'translateX(0)' }], { duration: 220, easing: 'ease-out' });
      }
      return;
    }

    const galleryThumb = event.target.closest('[data-gallery-thumb]');
    if (galleryThumb) {
      const mainImage = qs('#previewMainImage');
      if (mainImage) mainImage.src = galleryThumb.dataset.galleryThumb;
      qsa('.gallery-thumb').forEach(button => button.classList.toggle('active', button === galleryThumb));
      return;
    }

    if (event.target.closest('[data-modal-qty-minus]')) {
      setPreviewQuantity(previewState.quantity - 1);
      return;
    }

    if (event.target.closest('[data-modal-qty-plus]')) {
      setPreviewQuantity(previewState.quantity + 1);
      return;
    }

    const previewReviewLink = event.target.closest('[data-scroll-preview-reviews]');
    if (previewReviewLink) {
      qs('#previewReviews')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    const previewOption = event.target.closest('[data-preview-option]');
    if (previewOption) {
      qsa('[data-preview-option]', previewOption.closest('.option-chips')).forEach(button => {
        const active = button === previewOption;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      setPreviewVariant(previewOption.dataset.previewOption);
      return;
    }

    const reviewStar = event.target.closest('[data-review-star]');
    if (reviewStar) {
      const value = Number(reviewStar.dataset.reviewStar);
      const input = qs('#previewReviewRating');
      if (input) input.value = String(value);
      qsa('[data-review-star]').forEach(button => {
        const selected = Number(button.dataset.reviewStar) <= value;
        button.classList.toggle('selected', selected);
        button.setAttribute('aria-checked', String(Number(button.dataset.reviewStar) === value));
      });
      return;
    }

    if (event.target.closest('[data-focus-review-form]')) {
      qs('#previewReviewForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => qs('#previewReviewForm input')?.focus(), 450);
      return;
    }

    const shareButton = event.target.closest('[data-share-product]');
    if (shareButton) {
      event.preventDefault();
      event.stopPropagation();
      await shareProductLink(shareButton);
      return;
    }

    const copyButton = event.target.closest('[data-copy-product]');
    if (copyButton) {
      event.preventDefault();
      const url = copyButton.dataset.shareUrl || window.location.href;
      const copied = await copyShareLink(url);
      const menu = qs('#productShareMenu');
      if (menu) menu.hidden = true;
      qs('#productModalShare')?.setAttribute('aria-expanded', 'false');
      showToast(copied ? 'Product link copied' : `Copy this link: ${url}`);
      return;
    }

    const buyNow = event.target.closest('[data-buy-now]');
    if (buyNow) {
      if (buyNow.disabled) return;
      buyNow.disabled = true;
      const previousLabel = buyNow.textContent;
      buyNow.textContent = 'Adding…';
      const added = await addToCart(buyNow.dataset.buyNow, previewState.quantity, previewState.variantId);
      if (added) {
        window.location.assign(cartTransferUrl());
        return;
      }
      buyNow.disabled = false;
      buyNow.textContent = previousLabel;
      updatePreviewPurchaseSummary();
      return;
    }

    const addButton = event.target.closest('[data-add-cart]');
    if (addButton) {
      if (addButton.disabled) return;
      addButton.disabled = true;
      const previousLabel = addButton.textContent;
      addButton.textContent = 'Adding…';
      const added = await addToCart(addButton.dataset.addCart);
      addButton.textContent = added ? 'Added ✓' : previousLabel;
      setTimeout(() => {
        if (!document.body.contains(addButton)) return;
        addButton.disabled = false;
        addButton.textContent = previousLabel;
      }, added ? 1000 : 0);
      return;
    }

    const modalAdd = event.target.closest('[data-modal-add-cart]');
    if (modalAdd) {
      if (modalAdd.disabled) return;
      modalAdd.disabled = true;
      const label = modalAdd.querySelector('[data-preview-add-label]');
      if (label) label.textContent = 'Adding…';
      const added = await addToCart(modalAdd.dataset.modalAddCart, previewState.quantity, previewState.variantId);
      modalAdd.disabled = false;
      if (added && label) {
        label.textContent = 'Added ✓';
        setTimeout(() => { if (document.body.contains(modalAdd)) updatePreviewPurchaseSummary(); }, 900);
      } else updatePreviewPurchaseSummary();
      return;
    }

    const wishlist = event.target.closest('[data-wishlist]');
    if (wishlist) {
      await toggleWishlist(wishlist.dataset.wishlist);
      if (qs('#productModal.open')) openProductModal(wishlist.dataset.wishlist);
      return;
    }

    const productPreview = event.target.closest('[data-product-preview]');
    if (productPreview) {
      openProductModal(productPreview.dataset.productPreview);
      return;
    }

    const quickView = event.target.closest('[data-quick-view]');
    if (quickView) {
      openProductModal(quickView.dataset.quickView);
      return;
    }

    const categoryMore = event.target.closest('[data-category-more]');
    if (categoryMore) {
      const target = qs('#categoryRow');
      if (target) {
        const firstExtra = target.children[PRIMARY_CATEGORY_IDS.length];
        const nextLeft = firstExtra ? Math.max(0, firstExtra.offsetLeft - target.offsetLeft) : target.scrollWidth;
        target.scrollTo({ left: nextLeft, behavior: 'smooth' });
      }
      return;
    }

    const heroViewAllCategories = event.target.closest('.hero-category-menu .view-all');
    if (heroViewAllCategories) {
      event.preventDefault();
      window.location.href = '/categories';
      return;
    }

    const categoryJump = event.target.closest('[data-category-jump]');
    if (categoryJump) {
      window.location.href = `/products?category=${encodeURIComponent(categoryJump.dataset.categoryJump)}`;
      return;
    }

    const categoryButton = event.target.closest('[data-category]');
    if (categoryButton) {
      window.location.href = `/products?category=${encodeURIComponent(categoryButton.dataset.category)}`;
      return;
    }

    const scrollButton = event.target.closest('[data-scroll]');
    if (scrollButton) {
      scrollToSelector(scrollButton.dataset.scroll);
      return;
    }

    const modalTrigger = event.target.closest('[data-open]');
    if (modalTrigger) {
      const target = modalTrigger.dataset.open;
      if (target === 'brandModal') {
        window.location.href = '/products?view=brands';
      } else if (target === 'aboutModal') {
        openContent('About Classic Mart', '<p>Classic Mart is a server-authoritative multi-vendor marketplace. Products, stock, carts, orders, payments and trust workflows are validated by the backend.</p><h3>Buyer-first experience</h3><p>The design focuses on clear product discovery, mobile responsiveness, accessibility and transparent buyer protection.</p>');
      } else if (target === 'policyModal') {
        openContent('Classic Mart Policies', '<h3>Privacy</h3><p>Trusted account, cart and order data is stored on the server. Browser storage is limited to non-sensitive presentation preferences.</p><h3>Payments</h3><p>Online payment details are entered on the hosted provider checkout and verified by the server before an order is marked paid.</p><h3>Returns</h3><p>Eligible purchases can use the Buyer Protection return, dispute and refund workflows.</p>');
      } else {
        openModal(target);
      }
      return;
    }

    const brand = event.target.closest('[data-brand]');
    if (brand) {
      window.location.href = `/products?brand=${encodeURIComponent(brand.dataset.brand)}`;
      return;
    }

    const viewProducts = event.target.closest('[data-view-products]');
    if (viewProducts) {
      const type = viewProducts.dataset.viewProducts || 'all';
      window.location.href = `/products?view=${encodeURIComponent(type)}`;
      return;
    }

    const freshFindsToggle = event.target.closest('[data-toggle-fresh-finds]');
    if (freshFindsToggle) {
      window.location.href = '/products?view=fresh';
      return;
    }

    if (event.target.closest('[data-show-all-categories]')) {
      window.location.href = '/categories';
      return;
    }

    if (event.target.closest('[data-search-all]')) {
      const query = qs('#searchInput')?.value.trim() || '';
      const category = qs('#searchCategory')?.value || 'all';
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (category !== 'all') params.set('category', category);
      window.location.href = `/search${params.toString() ? `?${params}` : ''}`;
      return;
    }

    const suggestion = event.target.closest('[data-suggestion]');
    if (suggestion) {
      qs('#searchSuggestions').classList.remove('show');
      openProductModal(suggestion.dataset.suggestion);
      return;
    }

    const minus = event.target.closest('[data-cart-minus]');
    if (minus) {
      const id = minus.dataset.cartMinus;
      updateCartQuantity(id, Number(state.cart[id]) - 1);
      return;
    }

    const plus = event.target.closest('[data-cart-plus]');
    if (plus) {
      const id = plus.dataset.cartPlus;
      updateCartQuantity(id, Number(state.cart[id]) + 1);
      return;
    }

    const remove = event.target.closest('[data-cart-remove]');
    if (remove) {
      removeFromCart(remove.dataset.cartRemove);
      return;
    }

    if (event.target.closest('[data-close-modal]')) closeAllModals();
  }

  function startPromoAnimations() {
    const cards = qsa('.promo-card');
    if (!cards.length || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const motions = ['slide-left', 'slide-right', 'slide-up', 'slide-down', 'zoom-in', 'zoom-out', 'fade'];
    const motionClasses = motions.map(motion => `promo-motion-${motion}`);

    cards.forEach((card, index) => {
      const run = () => {
        card.classList.remove(...motionClasses);
        void card.offsetWidth;
        const motion = motions[Math.floor(Math.random() * motions.length)];
        card.classList.add(`promo-motion-${motion}`);
        card.addEventListener('animationend', () => card.classList.remove(`promo-motion-${motion}`), { once: true });
        window.setTimeout(run, 3000 + Math.random() * 3200 + index * 320);
      };
      window.setTimeout(run, 1200 + index * 850 + Math.random() * 900);
    });
  }

  function ensureMobileBottomNav() {
    if (qs('.mobile-bottom-nav')) return;
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

  function bindEvents() {
    document.addEventListener('click', handleDocumentClick);

    qs('#menuToggle')?.addEventListener('click', event => {
      event.stopPropagation();
      const panel = qs('#categoryPanel');
      const open = panel.classList.toggle('open');
      event.currentTarget.setAttribute('aria-expanded', String(open));
    });

    document.addEventListener('click', event => {
      const panel = qs('#categoryPanel');
      const toggle = qs('#menuToggle');
      if (panel?.classList.contains('open') && !panel.contains(event.target) && !toggle.contains(event.target)) {
        panel.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
      if (!event.target.closest('.search-bar')) {
        qs('#searchSuggestions')?.classList.remove('show');
        qs('#searchInput')?.setAttribute('aria-expanded', 'false');
      }
    });

    const searchInput = qs('#searchInput');
    const searchPanel = qs('#searchSuggestions');

    const refreshSearch = () => {
      updateSearchSuggestions();
      searchInput?.setAttribute('aria-expanded', String(searchPanel?.classList.contains('show')));
    };

    searchInput?.setAttribute('aria-controls', 'searchSuggestions');
    searchInput?.setAttribute('aria-expanded', 'false');
    searchInput?.addEventListener('input', refreshSearch);
    searchInput?.addEventListener('search', refreshSearch);
    searchInput?.addEventListener('focus', () => {
      if (searchInput.value.trim()) refreshSearch();
    });
    searchInput?.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        searchPanel?.classList.remove('show');
        searchInput.setAttribute('aria-expanded', 'false');
      }
    });
    qs('#searchCategory')?.addEventListener('change', () => {
      applyLiveSearch();
      if (qs('#searchInput')?.value.trim()) updateSearchSuggestions();
    });
    qs('#searchForm')?.addEventListener('submit', event => {
      event.preventDefault();
      const query = qs('#searchInput')?.value.trim() || '';
      const category = qs('#searchCategory')?.value || 'all';
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (category !== 'all') params.set('category', category);
      window.location.href = `/search${params.toString() ? `?${params}` : ''}`;
    });

    qsa('.slider-arrow').forEach(button => {
      button.addEventListener('click', () => {
        const target = qs(`#${button.dataset.target}`);
        if (!target) return;
        target.scrollBy({ left: (button.classList.contains('next') ? 1 : -1) * Math.max(320, target.clientWidth * .75), behavior: 'smooth' });
      });
    });

    qs('#heroPrev')?.addEventListener('click', () => { goToHero(state.heroIndex - 1); startHero(); });
    qs('#heroNext')?.addEventListener('click', () => { goToHero(state.heroIndex + 1); startHero(); });
    qsa('#heroDots button').forEach(button => button.addEventListener('click', () => { goToHero(Number(button.dataset.slide)); startHero(); }));

    let touchStart = 0;
    qs('#heroSlider')?.addEventListener('touchstart', event => { touchStart = event.touches[0].clientX; }, { passive: true });
    qs('#heroSlider')?.addEventListener('touchend', event => {
      const delta = event.changedTouches[0].clientX - touchStart;
      if (Math.abs(delta) > 45) {
        goToHero(state.heroIndex + (delta < 0 ? 1 : -1));
        startHero();
      }
    }, { passive: true });

    qs('#drawerBackdrop')?.addEventListener('click', () => { closeCart(); closeFilter(); });

    qs('#filterButton')?.addEventListener('click', openFilter);
    qs('#closeFilter')?.addEventListener('click', closeFilter);
    qs('#priceRange')?.addEventListener('input', event => { qs('#priceOutput').textContent = money(Number(event.target.value)); });
    qs('#filterForm')?.addEventListener('submit', event => {
      event.preventDefault();
      const category = new FormData(event.currentTarget).get('filterCategory');
      const maxPrice = Number(qs('#priceRange').value);
      const sort = qs('#sortSelect').value;
      let list = products.filter(product => (category === 'all' || product.category === category) && product.price <= maxPrice);
      if (sort === 'price-asc') list.sort((a, b) => a.price - b.price);
      if (sort === 'price-desc') list.sort((a, b) => b.price - a.price);
      if (sort === 'rating') list.sort((a, b) => b.rating - a.rating);
      state.filteredProducts = list;
      renderTrending(list);
      closeFilter();
      showToast(`${list.length} products match your filters`);
    });
    qs('#resetFilters')?.addEventListener('click', () => {
      qs('#filterForm').reset();
      const range = qs('#priceRange');
      if (range) { range.value = range.max; qs('#priceOutput').textContent = money(Number(range.max)); }
      state.filteredProducts = products.slice();
      renderTrending(state.filteredProducts);
    });

    qs('#modalBackdrop')?.addEventListener('click', closeAllModals);

    qs('#locationForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      const city = qs('#locationInput')?.value.trim();
      const status = qs('#locationStatus');
      if (!city) return;
      try {
        if (status) status.textContent = 'Checking delivery coverage…';
        const tokenResponse = await fetch('/api/v1/delivery-location', { headers: { Accept: 'application/json' } });
        const tokenPayload = await tokenResponse.json();
        if (!tokenResponse.ok) throw new Error(tokenPayload.error?.message || tokenPayload.message || 'Could not start location update.');
        const response = await fetch('/api/v1/delivery-location', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': tokenPayload.csrfToken },
          body: JSON.stringify({ city }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error?.message || payload.message || 'Delivery location could not be saved.');
        const label = `${payload.city}, ${payload.country.name}`;
        qs('#deliveryLocation').textContent = label;
        if (status) status.textContent = `Saved: ${label}`;
        showToast(`Delivery location updated to ${label}`);
        setTimeout(closeAllModals, 450);
      } catch (error) {
        if (status) status.textContent = error.message;
        showToast(error.message);
      }
    });

    qs('#checkoutForm')?.addEventListener('submit', event => {
      event.preventDefault();
      location.href = '/cart';
    });


    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        closeAllModals();
        closeCart();
        closeFilter();
        qs('#categoryPanel')?.classList.remove('open');
        return;
      }

      if (event.key === 'Enter' || event.key === ' ') {
        const card = event.target.closest?.('[data-product-preview]');
        const isNestedControl = event.target.closest?.('button, a, input, select, textarea') && event.target !== card;
        if (card && !isNestedControl) {
          event.preventDefault();
          openProductModal(card.dataset.productPreview);
        }
      }
    });

    const backToTop = qs('#backToTop');
    window.addEventListener('scroll', () => backToTop.classList.toggle('show', window.scrollY > 650), { passive: true });
    backToTop?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

    qsa('a[href^="#"]').forEach(link => link.addEventListener('click', () => qs('#searchForm')?.classList.remove('mobile-open')));
  }

  document.addEventListener('classicmart:visual-search-results', (event) => {
    const matches = (Array.isArray(event.detail?.products) ? event.detail.products : []).map(normalizeProduct);
    state.filteredProducts = matches;
    renderTrending(matches);
    const heading = qs('#trending')?.closest('section')?.querySelector('.section-heading h2, h2');
    if (heading) heading.textContent = 'Visual search results';
    qs('#trending')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  function restorePreferences() { /* Trusted delivery details are collected and validated at checkout. */ }

  function observeSections() {
    if (!('IntersectionObserver' in window)) return;
    const navLinks = qsa('.primary-nav a[href^="#"]');
    const sections = navLinks.map(link => qs(link.getAttribute('href'))).filter(Boolean);
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      navLinks.forEach(link => link.classList.toggle('active', link.getAttribute('href') === `#${visible.target.id}`));
    }, { rootMargin: '-20% 0px -65% 0px', threshold: [0, .2, .6] });
    sections.forEach(section => observer.observe(section));
  }

  function openProductFromUrl() {
    if (state.deepLinkOpened) return;
    const queryId = new URLSearchParams(window.location.search).get('product');
    const pathMatch = window.location.pathname.match(/^\/products\/([^/]+)$/);
    const id = queryId || (pathMatch ? decodeURIComponent(pathMatch[1]) : '');
    if (!id || !productById(id)) return;
    state.deepLinkOpened = true;
    openProductModal(id);
  }

  function openRequestedContent() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('location') === '1') {
      openModal('locationModal');
      params.delete('location');
      const query = params.toString();
      history.replaceState({}, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash || ''}`);
    }
  }

  async function init() {
    renderCategories();
    renderHeaderCategories();
    renderTrending(products.slice(0, 12));
    renderDeals();
    startDailyDealCountdown();
    renderRecommended();
    renderBestSellers();
    renderBudgetPicks();
    renderFreshFinds();
    state.filteredProducts = products.slice(0, 12);
    updateCartUI();
    restorePreferences();
    installMobileSectionControls();
    ensureMobileBottomNav();
    bindEvents();
    observeSections();
    startHero();
    startPromoAnimations();
    await hydrateOnlineCatalog();
    openProductFromUrl();
    openRequestedContent();
  }

  init();
})();

/* Keep every section navigation arrow vertically aligned with the centre
   of the row it controls. This also corrects the shorter Top Brands row. */
(() => {
  const alignSectionArrows = () => {
    document.querySelectorAll('.section-next-button[data-scroll-next]').forEach((button) => {
      const targetId = button.getAttribute('data-scroll-next');
      const target = targetId ? document.getElementById(targetId) : null;
      const section = button.closest('.store-section, .daily-deals');
      if (!target || !section) return;

      const sectionRect = section.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const targetCenter = targetRect.top - sectionRect.top + (targetRect.height / 2);

      if (Number.isFinite(targetCenter) && targetCenter > 0) {
        button.style.setProperty('top', `${targetCenter}px`, 'important');
      }
    });
  };

  let resizeFrame = 0;
  const queueAlignment = () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(alignSectionArrows);
  };

  window.addEventListener('load', () => {
    queueAlignment();
    setTimeout(queueAlignment, 150);
    setTimeout(queueAlignment, 600);
  });
  window.addEventListener('resize', queueAlignment, { passive: true });

  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(queueAlignment);
    document.querySelectorAll('.horizontal-scroll, .mini-product-grid').forEach((row) => observer.observe(row));
  }

  if ('MutationObserver' in window) {
    const observer = new MutationObserver(queueAlignment);
    document.querySelectorAll('.horizontal-scroll, .mini-product-grid').forEach((row) => {
      observer.observe(row, { childList: true, subtree: false });
    });
  }

  queueAlignment();
})();

(() => {
  'use strict';

  const qs = (selector) => document.querySelector(selector);
  const qsa = (selector) => [...document.querySelectorAll(selector)];
  const state = {
    mode: document.body.dataset.pageMode || 'products',
    params: new URLSearchParams(location.search),
    products: [],
    filtered: [],
    categories: [],
    wishlist: new Set(),
    comparison: new Set(),
    csrfToken: '',
    locale: 'en-UG',
    currency: 'UGX',
    page: 1,
    pageSize: 12,
    viewMode: 'grid',
    searchId: '',
    autocompleteTimer: null,
  };

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

  function money(value, currency = state.currency) {
    try {
      return new Intl.NumberFormat(state.locale, {
        style: 'currency',
        currency,
      }).format(Number(value) || 0);
    } catch {
      return `${currency} ${Number(value || 0).toLocaleString()}`;
    }
  }

  function reviewCount(value) {
    return Number(value || 0).toLocaleString(state.locale);
  }

  function categoryLabel(id) {
    return (
      state.categories.find((item) => item.id === id)?.name ||
      id ||
      'All categories'
    );
  }

  function showToast(message) {
    const toast = qs('#catalogToast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2_200);
  }

  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (state.csrfToken && options.method && options.method !== 'GET') {
      headers['x-csrf-token'] = state.csrfToken;
    }
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers,
    });
    if (response.status === 401) {
      location.href = `/login?next=${encodeURIComponent(
        location.pathname + location.search,
      )}`;
      throw new Error('Authentication required');
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error?.message || 'Request failed.');
    }
    return payload;
  }

  async function addToCart(product, button) {
    if (!window.ClassicMartCart) {
      showToast('Cart will be available after this page reloads.');
      return false;
    }
    if (button?.disabled) return false;
    const previous = button?.innerHTML || '';
    if (button) { button.disabled = true; button.textContent = 'Adding…'; }
    try {
      await window.ClassicMartCart.add(product, 1);
      showToast(`${product.name} added to cart`);
      if (button) button.textContent = 'Added ✓';
      return true;
    } catch (error) {
      showToast(error.message || 'Product could not be added.');
      if (button) button.innerHTML = previous;
      return false;
    } finally {
      if (button) setTimeout(() => {
        if (!document.body.contains(button)) return;
        button.disabled = Number(product.stock || 0) < 1;
        button.innerHTML = previous;
      }, 900);
    }
  }

  function pageContext() {
    if (state.mode === 'categories') {
      return {
        eyebrow: 'Explore departments',
        title: 'All Categories',
        description:
          'Browse active marketplace departments and their published products.',
      };
    }
    if (state.mode === 'search') {
      return {
        eyebrow: 'Marketplace search',
        title: state.params.get('q')
          ? `Search results for “${state.params.get('q')}”`
          : 'Search Classic Mart',
        description:
          'Search published products, approved brands and verified sellers.',
      };
    }
    const views = {
      deals: ['Flash deals', 'Published products with current price reductions.'],
      new: ['New arrivals', 'Recently published marketplace products.'],
      brands: ['Top brands', 'Products from approved marketplace brands.'],
      fresh: ['Fresh finds', 'Newly published products from verified sellers.'],
      trending: ['Trending now', 'Available products across Classic Mart.'],
      budget: ['Budget picks', 'Sort and filter products by the price that suits you.'],
      'best-sellers': [
        'Best sellers',
        'Available products from verified sellers.',
      ],
    };
    const chosen = views[state.params.get('view')] || [
      'Browse products',
      'Compare published marketplace products with live pricing and availability.',
    ];
    return {
      eyebrow: state.params.get('view')
        ? 'Curated collection'
        : 'Classic Mart marketplace',
      title: chosen[0],
      description: chosen[1],
    };
  }

  function configurePage() {
    const context = pageContext();
    document.title = `${context.title} — Classic Mart`;
    qs('#catalogEyebrow').textContent = context.eyebrow;
    qs('#catalogTitle').textContent = context.title;
    qs('#catalogBreadcrumb').textContent = context.title;
    qs('#catalogDescription').textContent = context.description;
    qs('#categoryDirectory').hidden = state.mode !== 'categories';
    const initialQuery = state.params.get('q') || '';
    qs('#catalogQuery').value = initialQuery;
    qs('#searchInput').value = initialQuery;
    if (state.mode === 'search') {
      setTimeout(() => qs('#catalogQuery')?.focus(), 80);
    }
  }

  function populateHeaderCategories() {
    const select = qs('#searchCategory');
    const selected = state.params.get('category') || 'all';
    select.innerHTML = [
      '<option value="all">All Categories</option>',
      ...state.categories.map(
        (category) =>
          `<option value="${escapeHtml(category.id)}">${escapeHtml(
            category.name,
          )}</option>`,
      ),
    ].join('');
    select.value = state.categories.some((item) => item.id === selected)
      ? selected
      : 'all';
  }

  function renderCategoryDirectory() {
    qs('#categoryDirectoryGrid').innerHTML = state.categories
      .map(
        (category) => `
        <a class="category-directory-card" href="/products?category=${encodeURIComponent(category.id)}">
          <div class="category-directory-image"><img src="${escapeHtml(category.image)}" alt="${escapeHtml(category.name)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='/assets/product-placeholder.svg'"><span><img src="/assets/icons/tags.svg" alt=""></span></div>
          <div><h3>${escapeHtml(category.name)}</h3><p>${escapeHtml(category.note)}</p><b>${category.count} product${category.count === 1 ? '' : 's'} <img src="/assets/icons/chevron-right.svg" alt=""></b></div>
        </a>`,
      )
      .join('');
  }

  function renderFilterCategories() {
    const selected = state.params.get('category') || 'all';
    qs('#filterCategoryList').innerHTML = [
      { id: 'all', name: 'All categories', count: state.products.length },
      ...state.categories,
    ]
      .map(
        (category) => `
        <label><input type="radio" name="category" value="${escapeHtml(category.id)}" ${selected === category.id ? 'checked' : ''}><span>${escapeHtml(category.name)}</span><small>${category.id === 'all' ? state.products.length : category.count}</small></label>`,
      )
      .join('');
  }

  function getFilters() {
    return {
      query: qs('#catalogQuery')?.value.trim().toLowerCase() || '',
      category: qs('input[name="category"]:checked')?.value || 'all',
      min: Number(qs('#minPrice')?.value || 0),
      max: Number(qs('#maxPrice')?.value || Infinity),
      rating: Number(qs('input[name="rating"]:checked')?.value || 0),
      inStock: Boolean(qs('#inStockOnly')?.checked),
      discount: Boolean(qs('#discountOnly')?.checked),
      brand: state.params.get('brand') || '',
      seller: state.params.get('seller') || '',
      view: state.params.get('view') || '',
    };
  }

  function applyFilters(resetPage = true) {
    if (resetPage) state.page = 1;
    const filters = getFilters();
    let products = state.products.filter((product) => {
      const haystack = [
        product.name,
        product.subtitle,
        product.brand,
        product.categoryName,
        product.description,
        product.seller?.name,
      ]
        .join(' ')
        .toLowerCase();
      return (
        (!filters.query || haystack.includes(filters.query)) &&
        (filters.category === 'all' ||
          product.category === filters.category) &&
        (!filters.brand ||
          product.brand.toLowerCase() === filters.brand.toLowerCase()) &&
        (!filters.seller || product.seller?.slug === filters.seller) &&
        product.price >= filters.min &&
        product.price <= filters.max &&
        product.rating >= filters.rating &&
        (!filters.inStock || product.stock > 0) &&
        (!filters.discount || product.oldPrice > product.price)
      );
    });

    if (filters.view === 'deals') {
      products = products.filter((product) => product.oldPrice > product.price);
    }
    if (filters.view === 'new' || filters.view === 'fresh') {
      products.sort(
        (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt),
      );
    }
    if (filters.view === 'brands') {
      products.sort((a, b) => a.brand.localeCompare(b.brand));
    }
    const sort = qs('#catalogSort')?.value || 'featured';
    if (sort === 'rating') products.sort((a, b) => b.rating - a.rating);
    if (sort === 'popular') products.sort((a, b) => b.sold - a.sold);
    if (sort === 'price-low') products.sort((a, b) => a.price - b.price);
    if (sort === 'price-high') products.sort((a, b) => b.price - a.price);
    if (sort === 'discount') {
      products.sort(
        (a, b) =>
          (b.oldPrice - b.price) / Math.max(b.oldPrice, 1) -
          (a.oldPrice - a.price) / Math.max(a.oldPrice, 1),
      );
    }
    state.filtered = products;
    renderProducts();
    renderActiveFilters(filters);
  }

  function productCard(product) {
    const wished = state.wishlist.has(product.id);
    const compared = state.comparison.has(product.id);
    const discount =
      product.oldPrice > product.price
        ? Math.round((1 - product.price / product.oldPrice) * 100)
        : 0;
    return `<article class="catalog-product-card" data-product-id="${escapeHtml(product.id)}">
      <a class="catalog-product-image" href="/products/${encodeURIComponent(product.id)}" aria-label="View ${escapeHtml(product.name)} details"><img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.imageAlt || product.name)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='/assets/product-placeholder.svg'"><span>${escapeHtml(product.badge)}</span></a>
      <button class="catalog-wishlist ${wished ? 'active' : ''}" data-catalog-wishlist="${escapeHtml(product.id)}" type="button" aria-label="${wished ? 'Remove from' : 'Add to'} wishlist"><img src="/assets/icons/${wished ? 'heart.svg' : 'heart-regular.svg'}" alt=""></button>
      <div class="catalog-product-info"><div class="catalog-product-category">${escapeHtml(categoryLabel(product.category))}</div><a href="/products/${encodeURIComponent(product.id)}"><h3>${escapeHtml(product.name)}</h3></a><p>${escapeHtml(product.subtitle)} · ${escapeHtml(product.brand)}</p><div class="catalog-card-commerce"><div class="catalog-card-price"><strong>${money(product.price, product.currency)}</strong>${discount ? `<del>${money(product.oldPrice, product.currency)}</del><b>-${discount}%</b>` : ''}</div><div class="catalog-card-rating" aria-label="${product.reviews ? `Rated ${product.rating.toFixed(1)} from ${product.reviews} reviews` : 'No reviews yet'}"><span aria-hidden="true">★</span><strong>${product.reviews ? product.rating.toFixed(1) : 'New'}</strong>${product.reviews ? `<small>(${reviewCount(product.reviews)})</small>` : ''}</div></div><div class="catalog-card-meta"><span><img src="/assets/icons/truck-fast.svg" alt=""> Delivery at checkout</span><span>${product.stock > 0 ? `${product.stock} in stock` : 'Out of stock'}</span></div><div class="catalog-card-actions"><button data-catalog-add="${escapeHtml(product.id)}" type="button" ${product.stock < 1 ? 'disabled' : ''}><img src="/assets/icons/cart-plus.svg" alt=""> Add to cart</button><button class="${compared ? 'active' : ''}" data-catalog-compare="${escapeHtml(product.id)}" type="button">${compared ? 'Compared' : 'Compare'}</button></div></div>
    </article>`;
  }

  function renderProducts() {
    const totalPages = Math.max(
      1,
      Math.ceil(state.filtered.length / state.pageSize),
    );
    state.page = Math.min(state.page, totalPages);
    const start = (state.page - 1) * state.pageSize;
    const visible = state.filtered.slice(start, start + state.pageSize);
    const grid = qs('#catalogProductGrid');
    grid.classList.toggle('list-view', state.viewMode === 'list');
    grid.innerHTML = visible.map(productCard).join('');
    qs('#catalogResultCount').innerHTML =
      `<strong>${state.filtered.length}</strong> product${state.filtered.length === 1 ? '' : 's'} found`;
    qs('#catalogEmpty').hidden = state.filtered.length > 0;
    grid.hidden = state.filtered.length === 0;
    renderPagination(totalPages);
    qsa('[data-wishlist-count]').forEach((badge) => {
      badge.textContent = String(state.wishlist.size);
    });
  }

  function renderPagination(totalPages) {
    const nav = qs('#catalogPagination');
    if (totalPages <= 1) {
      nav.innerHTML = '';
      return;
    }
    const pages = [
      ...new Set(
        [1, state.page - 1, state.page, state.page + 1, totalPages].filter(
          (page) => page >= 1 && page <= totalPages,
        ),
      ),
    ];
    nav.innerHTML = `<button data-page="${Math.max(1, state.page - 1)}" ${state.page === 1 ? 'disabled' : ''}><img src="/assets/icons/chevron-left.svg" alt=""> Previous</button>${pages.map((page, index) => `${index && page - pages[index - 1] > 1 ? '<span>…</span>' : ''}<button class="${page === state.page ? 'active' : ''}" data-page="${page}">${page}</button>`).join('')}<button data-page="${Math.min(totalPages, state.page + 1)}" ${state.page === totalPages ? 'disabled' : ''}>Next <img src="/assets/icons/chevron-right.svg" alt=""></button>`;
  }

  function renderActiveFilters(filters) {
    const chips = [];
    if (filters.query) chips.push(`Search: ${filters.query}`);
    if (filters.category !== 'all') chips.push(categoryLabel(filters.category));
    if (filters.min > 0) chips.push(`From ${money(filters.min)}`);
    if (Number.isFinite(filters.max)) chips.push(`Up to ${money(filters.max)}`);
    if (filters.rating) chips.push(`${filters.rating}+ rating`);
    if (filters.inStock) chips.push('In stock');
    if (filters.discount) chips.push('Discounted');
    if (filters.brand) chips.push(filters.brand);
    if (filters.seller) chips.push(`Seller: ${filters.seller}`);
    qs('#activeFilterRow').innerHTML = chips.length
      ? `${chips.map((chip) => `<span>${escapeHtml(chip)}</span>`).join('')}<button id="clearActiveFilters" type="button">Clear filters</button>`
      : '';
  }

  function clearFilters() {
    qs('#catalogFilterForm').reset();
    qs('#catalogQuery').value = '';
    qs('input[name="category"][value="all"]').checked = true;
    for (const name of ['q', 'category', 'brand', 'seller']) {
      state.params.delete(name);
    }
    history.replaceState(
      {},
      '',
      `${location.pathname}${state.params.toString() ? `?${state.params}` : ''}`,
    );
    applyFilters();
  }

  function toggleFilters(open) {
    qs('#catalogFilterPanel').classList.toggle('open', open);
    const backdrop = qs('#catalogFilterBackdrop');
    backdrop.hidden = !open;
    backdrop.classList.toggle('show', open);
    document.body.classList.toggle('no-scroll', open);
  }

  async function toggleWishlist(productId) {
    const wished = state.wishlist.has(productId);
    const payload = await api(
      `/api/v1/storefront/wishlist/${encodeURIComponent(productId)}`,
      { method: wished ? 'DELETE' : 'POST' },
    );
    state.wishlist = new Set(payload.wishlist);
    renderProducts();
    showToast(wished ? 'Product removed from wishlist' : 'Product saved');
  }

  async function toggleComparison(productId) {
    const compared = state.comparison.has(productId);
    const payload = await api(
      `/api/v1/storefront/comparison/${encodeURIComponent(productId)}`,
      { method: compared ? 'DELETE' : 'POST' },
    );
    state.comparison = new Set(payload.comparison);
    renderProducts();
    showToast(
      compared ? 'Product removed from comparison' : 'Product added to comparison',
    );
  }

  function filterFromHeader(scroll = false) {
    const query = qs('#searchInput')?.value.trim() || '';
    const category = qs('#searchCategory')?.value || 'all';
    qs('#catalogQuery').value = query;
    const categoryRadio =
      qsa('input[name="category"]').find(
        (input) => input.value === category,
      ) || qs('input[name="category"][value="all"]');
    if (categoryRadio) categoryRadio.checked = true;
    if (query) state.params.set('q', query);
    else state.params.delete('q');
    if (category !== 'all') state.params.set('category', category);
    else state.params.delete('category');
    history.replaceState(
      {},
      '',
      `${location.pathname}${state.params.toString() ? `?${state.params}` : ''}`,
    );
    if (state.mode === 'search') {
      hydrateCatalog();
      return;
    }
    applyFilters();
    if (scroll) {
      qs('#catalogWorkspace').scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }
  }

  function bindEvents() {
    let timer;
    qs('#searchForm')?.addEventListener('submit', (event) => {
      event.preventDefault();
      filterFromHeader(true);
    });
    qs('#searchInput')?.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(filterFromHeader, 160);
    });
    qs('#searchCategory')?.addEventListener('change', () => filterFromHeader());
    qs('#catalogQuery')?.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (state.mode === 'search') {
          const query = qs('#catalogQuery').value.trim();
          qs('#searchInput').value = query;
          if (query) state.params.set('q', query);
          else state.params.delete('q');
          history.replaceState(
            {},
            '',
            `${location.pathname}${state.params.toString() ? `?${state.params}` : ''}`,
          );
          hydrateCatalog();
        } else {
          applyFilters();
        }
      }, state.mode === 'search' ? 320 : 160);
    });
    qs('#catalogFilterForm')?.addEventListener('change', (event) => {
      if (
        state.mode === 'search' &&
        event.target.matches('input[name="category"]')
      ) {
        if (event.target.value === 'all') state.params.delete('category');
        else state.params.set('category', event.target.value);
        history.replaceState(
          {},
          '',
          `${location.pathname}${state.params.toString() ? `?${state.params}` : ''}`,
        );
        hydrateCatalog();
        return;
      }
      applyFilters();
    });
    qs('#catalogFilterForm')?.addEventListener('submit', (event) => {
      event.preventDefault();
      applyFilters();
      toggleFilters(false);
    });
    qs('#catalogSort')?.addEventListener('change', () => applyFilters(false));
    qs('#clearCatalogFilters')?.addEventListener('click', clearFilters);
    qs('#emptyClearButton')?.addEventListener('click', clearFilters);
    qs('#openCatalogFilters')?.addEventListener('click', () =>
      toggleFilters(true),
    );
    qs('#closeCatalogFilters')?.addEventListener('click', () =>
      toggleFilters(false),
    );
    qs('#catalogFilterBackdrop')?.addEventListener('click', () =>
      toggleFilters(false),
    );
    document.addEventListener('click', async (event) => {
      const productLink = event.target.closest('a[href^="/products/"]');
      if (productLink && state.searchId) {
        const card = productLink.closest('[data-product-id]');
        if (card?.dataset.productId) {
          api(`/api/v1/storefront/search/${encodeURIComponent(state.searchId)}/click`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ productId: card.dataset.productId }),
          }).catch(() => {});
        }
      }
      const add = event.target.closest('[data-catalog-add]');
      if (add) {
        const product = state.products.find(
          (item) => item.id === add.dataset.catalogAdd,
        );
        if (product) await addToCart(product, add);
        return;
      }
      const wishlist = event.target.closest('[data-catalog-wishlist]');
      if (wishlist) {
        try {
          await toggleWishlist(wishlist.dataset.catalogWishlist);
        } catch (error) {
          if (error.message !== 'Authentication required') showToast(error.message);
        }
        return;
      }
      const comparison = event.target.closest('[data-catalog-compare]');
      if (comparison) {
        try {
          await toggleComparison(comparison.dataset.catalogCompare);
        } catch (error) {
          if (error.message !== 'Authentication required') showToast(error.message);
        }
        return;
      }
      const page = event.target.closest('[data-page]');
      if (page && !page.disabled) {
        state.page = Number(page.dataset.page);
        renderProducts();
        qs('#catalogWorkspace').scrollIntoView({ behavior: 'smooth' });
      }
      const view = event.target.closest('[data-view-mode]');
      if (view) {
        state.viewMode = view.dataset.viewMode;
        qsa('[data-view-mode]').forEach((button) =>
          button.classList.toggle('active', button === view),
        );
        renderProducts();
      }
      if (event.target.closest('#clearActiveFilters')) clearFilters();
    });
    document.addEventListener('classicmart:visual-search-results', (event) => {
      const matches = Array.isArray(event.detail?.products) ? event.detail.products : [];
      state.products = matches;
      state.filtered = matches.slice();
      state.page = 1;
      state.searchId = '';
      const title = qs('#catalogTitle');
      const description = qs('#catalogDescription');
      const breadcrumb = qs('#catalogBreadcrumb');
      if (title) title.textContent = 'Visual search results';
      if (breadcrumb) breadcrumb.textContent = 'Visual search results';
      if (description) description.textContent = 'Products matched to the image you selected.';
      renderFilterCategories();
      renderProducts();
      qs('#catalogWorkspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') toggleFilters(false);
    });
  }

  async function transferredVisualResults() {
    if (state.params.get('visual') !== '1') return null;
    const payload = await api('/api/v1/storefront/visual-search-results');
    return Array.isArray(payload.products) ? payload.products : [];
  }

  async function hydrateCatalog() {
    try {
      const searchParameters = new URLSearchParams();
      for (const name of ['q', 'category', 'brand', 'seller']) {
        const value = state.params.get(name);
        if (value) searchParameters.set(name, value);
      }
      const shouldSearch =
        state.mode === 'search' ||
        state.params.has('seller') ||
        state.params.has('brand');
      const endpoint = shouldSearch
        ? `/api/v1/storefront/search?${searchParameters}`
        : '/api/v1/storefront/catalogue';
      const visualProducts = await transferredVisualResults();
      const payload = await api(endpoint);
      state.products = visualProducts ?? payload.products ?? [];
      state.categories = payload.categories || [];
      state.wishlist = new Set(payload.state?.wishlist || []);
      state.comparison = new Set(payload.state?.comparison || []);
      state.csrfToken = payload.csrfToken || '';
      state.locale = payload.country?.locale || state.locale;
      state.currency = payload.country?.currency || state.currency;
      state.searchId = payload.searchId || '';
      populateHeaderCategories();
      renderCategoryDirectory();
      renderFilterCategories();
      applyFilters();
      if (visualProducts !== null) {
        const title = qs('#catalogTitle');
        const description = qs('#catalogDescription');
        const breadcrumb = qs('#catalogBreadcrumb');
        if (title) title.textContent = 'Visual search results';
        if (breadcrumb) breadcrumb.textContent = 'Visual search results';
        if (description) description.textContent = 'Products matched to the image you selected.';
      }
    } catch (error) {
      qs('#catalogResultCount').textContent =
        'Products could not be loaded. Refresh to try again.';
      showToast(error.message);
    }
  }

  configurePage();
  bindEvents();
  hydrateCatalog();
})();

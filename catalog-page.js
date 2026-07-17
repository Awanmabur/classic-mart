(() => {
  'use strict';

  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
  const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  const reviewCount = value => Number(value) >= 1000 ? `${(Number(value) / 1000).toFixed(Number(value) >= 10000 ? 0 : 1)}K` : String(value || 0);
  const stars = rating => `${'★'.repeat(Math.round(Number(rating) || 0))}${'☆'.repeat(5 - Math.round(Number(rating) || 0))}`;

  const categories = [
    { id: 'electronics', name: 'Electronics', icon: 'mobile-screen-button.svg', image: 'https://images.unsplash.com/photo-1498049794561-7780e7231661?auto=format&fit=crop&w=1000&q=84', note: 'Phones, audio, computers and smart devices' },
    { id: 'fashion', name: 'Fashion', icon: 'shirt.svg', image: 'https://images.unsplash.com/photo-1445205170230-053b83016050?auto=format&fit=crop&w=1000&q=84', note: 'Clothing, footwear, bags and accessories' },
    { id: 'home', name: 'Home & Kitchen', icon: 'house.svg', image: 'https://images.unsplash.com/photo-1556911220-bff31c812dba?auto=format&fit=crop&w=1000&q=84', note: 'Appliances, furniture and home essentials' },
    { id: 'beauty', name: 'Beauty & Health', icon: 'wand-magic-sparkles.svg', image: 'https://images.unsplash.com/photo-1596462502278-27bfdc403348?auto=format&fit=crop&w=1000&q=84', note: 'Skincare, fragrance and personal care' },
    { id: 'sports', name: 'Sports & Outdoors', icon: 'football.svg', image: 'https://images.unsplash.com/photo-1517836357463-d25dfeac3438?auto=format&fit=crop&w=1000&q=84', note: 'Fitness, outdoor and active lifestyle gear' },
    { id: 'toys', name: 'Toys & Games', icon: 'puzzle-piece.svg', image: 'https://images.unsplash.com/photo-1594787318286-3d835c1d207f?auto=format&fit=crop&w=1000&q=84', note: 'Creative play, games and family activities' },
    { id: 'automotive', name: 'Automotive', icon: 'car.svg', image: 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1000&q=84', note: 'Car care, tools and useful accessories' },
    { id: 'books', name: 'Books & Stationery', icon: 'book.svg', image: 'https://images.unsplash.com/photo-1495446815901-a7297e633e8d?auto=format&fit=crop&w=1000&q=84', note: 'Books, journals, school and office supplies' },
    { id: 'pets', name: 'Pet Supplies', icon: 'paw.svg', image: 'https://images.unsplash.com/photo-1552053831-71594a27632d?auto=format&fit=crop&w=1000&q=84', note: 'Food, care and accessories for pets' },
    { id: 'grocery', name: 'Groceries', icon: 'basket-shopping.svg', image: 'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=1000&q=84', note: 'Pantry staples and everyday food essentials' }
  ];

  const fallbackProducts = [
    ['Wireless Earbuds','Premium sound','electronics','Apple',29.99,64.99,4.8,4820,54,684,'Best Seller','https://images.unsplash.com/photo-1606220945770-b5b6c2c55bf1?auto=format&fit=crop&w=900&q=84'],
    ['Travel Backpack','Water resistant','fashion','Nike',39.99,49.99,4.7,2140,31,341,'20% Off','https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=900&q=84'],
    ['Smart Watch','Fitness tracker','electronics','Samsung',89.99,129.99,4.9,3410,67,497,'Top Rated','https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=900&q=84'],
    ['Portable Blender','USB rechargeable','home','Philips',25.49,29.99,4.5,1230,44,312,'15% Off','https://images.unsplash.com/photo-1570222094114-d054a817e56b?auto=format&fit=crop&w=900&q=84'],
    ["Men's Sneakers",'Comfort and style','fashion','Nike',49.99,79.99,4.8,2740,38,512,'Best Seller','https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=900&q=84'],
    ['Luxury Perfume','Long lasting','beauty','Levi\'s',36.99,64.99,4.6,2410,22,288,'New','https://images.unsplash.com/photo-1541643600914-78b084683601?auto=format&fit=crop&w=900&q=84'],
    ['Non-Stick Cookware','10-piece set','home','Philips',79.99,99.99,4.7,3720,18,193,'20% Off','https://images.unsplash.com/photo-1584990347449-a4ecad58a21d?auto=format&fit=crop&w=900&q=84'],
    ['Hydration Bottle','Temperature display','sports','Adidas',22.99,31.99,4.5,760,82,156,'Popular','https://images.unsplash.com/photo-1602143407151-7111542de6e8?auto=format&fit=crop&w=900&q=84'],
    ['Coffee Maker','Programmable brew','home','Philips',59.99,79.99,4.8,980,26,169,'25% Off','https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=900&q=84'],
    ['Noise Cancelling Headphones','Studio wireless','electronics','Sony',89.99,149.99,4.9,4130,43,312,'40% Off','https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=900&q=84'],
    ['Bluetooth Speaker','Portable bass','electronics','Sony',25.99,39.99,4.6,1720,71,205,'35% Off','https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?auto=format&fit=crop&w=900&q=84'],
    ['LED Desk Lamp','Touch control','home','Philips',19.99,24.99,4.5,540,61,168,'20% Off','https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=900&q=84'],
    ['Robot Vacuum Cleaner','Smart navigation','home','Samsung',139.99,199.99,4.8,960,14,256,'30% Off','https://images.unsplash.com/photo-1558317374-067fb5f30001?auto=format&fit=crop&w=900&q=84'],
    ['Smartphone 128GB','All-day battery','electronics','Apple',299.99,349.99,4.7,2440,35,418,'New Arrival','https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?auto=format&fit=crop&w=900&q=84'],
    ['Daily Skincare Cream','Hydrating formula','beauty','Nivea',18.99,24.99,4.6,840,89,233,'25% Off','https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=900&q=84'],
    ['Classic Wrist Watch','Stainless steel','fashion','Samsung',74.99,99.99,4.8,1310,29,287,'Best Seller','https://images.unsplash.com/photo-1524592094714-0f0654e20314?auto=format&fit=crop&w=900&q=84'],
    ['Leather Journal','Premium notebook','books','Classic Select',14.99,19.99,4.7,640,74,179,'Popular','https://images.unsplash.com/photo-1531346878377-a5be20888e57?auto=format&fit=crop&w=900&q=84'],
    ['Pet Comfort Bed','Soft washable cover','pets','Paw Home',34.99,46.99,4.8,770,32,144,'26% Off','https://images.unsplash.com/photo-1541599540903-216a46ca1dc0?auto=format&fit=crop&w=900&q=84'],
    ['Building Blocks Set','Creative learning','toys','Play Studio',27.99,39.99,4.7,1180,49,221,'30% Off','https://images.unsplash.com/photo-1594787318286-3d835c1d207f?auto=format&fit=crop&w=900&q=84'],
    ['Car Cleaning Kit','Complete interior care','automotive','Auto Pro',31.99,44.99,4.5,530,27,132,'29% Off','https://images.unsplash.com/photo-1607860108855-64acf2078ed9?auto=format&fit=crop&w=900&q=84'],
    ['Organic Pantry Box','Everyday essentials','grocery','Fresh Market',42.99,52.99,4.6,410,65,118,'19% Off','https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=900&q=84'],
    ['Yoga Mat Pro','Non-slip cushioning','sports','Adidas',28.99,38.99,4.8,920,51,190,'26% Off','https://images.unsplash.com/photo-1592432678016-e910b452f9a2?auto=format&fit=crop&w=900&q=84'],
    ['Makeup Brush Set','Soft precision brushes','beauty','Glow Studio',24.99,39.99,4.7,1360,57,246,'38% Off','https://images.unsplash.com/photo-1596462502278-27bfdc403348?auto=format&fit=crop&w=900&q=84'],
    ['Office Desk Chair','Ergonomic support','home','Classic Select',119.99,159.99,4.6,690,16,151,'25% Off','https://images.unsplash.com/photo-1580480055273-228ff5388ef8?auto=format&fit=crop&w=900&q=84']
  ].map((item, index) => ({
    id: index + 1, name: item[0], subtitle: item[1], category: item[2], brand: item[3], price: item[4], oldPrice: item[5], rating: item[6], reviews: item[7], stock: item[8], sold: item[9], badge: item[10], image: item[11], description: `${item[0]} selected for dependable quality, clear value and a buyer-friendly shopping experience.`
  }));

  const state = {
    products: fallbackProducts,
    filtered: [],
    page: 1,
    pageSize: 12,
    viewMode: 'grid',
    params: new URLSearchParams(location.search),
    mode: document.body.dataset.pageMode || 'products'
  };

  function categoryLabel(id) { return categories.find(item => item.id === id)?.name || id || 'All categories'; }
  function mapRemoteCategory(category = '') {
    if (['beauty', 'fragrances', 'skin-care'].includes(category)) return 'beauty';
    if (['smartphones', 'laptops', 'tablets', 'mobile-accessories'].includes(category)) return 'electronics';
    if (['mens-shirts','mens-shoes','mens-watches','womens-bags','womens-dresses','womens-jewellery','womens-shoes','womens-watches','tops','sunglasses'].includes(category)) return 'fashion';
    if (['furniture','home-decoration','kitchen-accessories'].includes(category)) return 'home';
    if (category === 'groceries') return 'grocery';
    if (category === 'sports-accessories') return 'sports';
    if (['vehicle','motorcycle'].includes(category)) return 'automotive';
    return 'home';
  }
  function normalizeRemote(item, index) {
    const price = Number(item.price) || 19.99;
    const discount = Math.max(5, Number(item.discountPercentage) || 12);
    return {
      id: index + 1,
      name: item.title || `Classic Mart Product ${index + 1}`,
      subtitle: String(item.category || '').replaceAll('-', ' ').replace(/\b\w/g, letter => letter.toUpperCase()),
      category: mapRemoteCategory(item.category),
      brand: item.brand || 'Classic Mart Select',
      image: item.thumbnail || item.images?.[0] || 'assets/product-placeholder.svg',
      price,
      oldPrice: Number((price / (1 - Math.min(70, discount) / 100)).toFixed(2)),
      rating: Math.min(5, Math.max(3.8, Number(item.rating) || 4.5)),
      reviews: Math.max(86, (item.reviews?.length || 2) * 417 + (item.id || index) * 9),
      stock: Number(item.stock) || 20,
      sold: Math.max(54, ((item.id || index) * 37) % 690),
      badge: discount >= 18 ? `${Math.round(discount)}% Off` : Number(item.rating) >= 4.7 ? 'Top Rated' : 'New Arrival',
      description: item.description || 'A carefully selected marketplace product with clear details and buyer protection.'
    };
  }

  const bridgePrefix = 'classic-mart-state:';
  function bridgeState() {
    try {
      if (!window.name || !window.name.startsWith(bridgePrefix)) return {};
      return JSON.parse(window.name.slice(bridgePrefix.length)) || {};
    } catch { return {}; }
  }
  function safeRead(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw);
    } catch { /* local-file storage can be blocked */ }
    const bridge = bridgeState();
    return Object.prototype.hasOwnProperty.call(bridge, key) ? bridge[key] : fallback;
  }
  function safeWrite(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* bridge below keeps same-tab navigation working */ }
    try {
      const bridge = bridgeState();
      bridge[key] = value;
      window.name = bridgePrefix + JSON.stringify(bridge);
    } catch { /* current page state still works */ }
  }
  function showToast(message) {
    const toast = qs('#catalogToast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2300);
  }
  function updateCartCount() {
    const count = window.ClassicMartCart
      ? window.ClassicMartCart.count()
      : Object.values(safeRead('shophub-cart', {})).reduce((sum, quantity) => sum + Number(quantity || 0), 0);
    if (qs('#cartCount')) qs('#cartCount').textContent = count;
    window.ClassicMartCart?.decorateLinks();
  }
  function addToCart(product) {
    if (window.ClassicMartCart) {
      window.ClassicMartCart.add(product, 1);
    } else {
      const cart = safeRead('shophub-cart', {});
      cart[product.id] = Number(cart[product.id] || 0) + 1;
      safeWrite('shophub-cart', cart);
      const saved = safeRead('classic-mart-cart-products', {});
      saved[product.id] = product;
      safeWrite('classic-mart-cart-products', saved);
    }
    updateCartCount();
    showToast(`${product.name} added to your cart`);
  }

  function pageContext() {
    const query = state.params.get('q') || '';
    const category = state.params.get('category') || 'all';
    const brand = state.params.get('brand') || '';
    const view = state.params.get('view') || '';
    if (state.mode === 'search') return { eyebrow: 'Product search', title: query ? `Results for “${query}”` : 'Search Classic Mart', description: query ? 'Use the filters to narrow these search results by department, price, rating and availability.' : 'Search products, brands and categories, then compare clear prices, ratings and buyer information.' };
    if (state.mode === 'categories') return { eyebrow: 'Marketplace departments', title: 'All categories', description: 'Explore every department and continue to complete product listings with useful filters and sorting.' };
    if (brand) return { eyebrow: 'Brand collection', title: `${brand} products`, description: `Browse available ${brand} products, compare prices and check verified buyer ratings.` };
    if (category !== 'all') return { eyebrow: 'Category collection', title: categoryLabel(category), description: `Browse products, popular picks and current offers in ${categoryLabel(category)}.` };
    const views = {
      deals: ['Flash deals', 'Limited-time discounts and strong-value marketplace offers.'],
      recommended: ['Recommended for you', 'Highly rated products selected from across the marketplace.'],
      'best-sellers': ['Best sellers', 'Products most frequently chosen by Classic Mart shoppers.'],
      budget: ['Popular picks under $50', 'Useful products at practical everyday prices.'],
      fresh: ['Fresh finds', 'New and noteworthy products from across the marketplace.'],
      new: ['New arrivals', 'Recently added products and fresh marketplace discoveries.'],
      brands: ['Top brands', 'Browse products from popular and trusted marketplace brands.'],
      trending: ['Trending now', 'Popular products shoppers are viewing, saving and buying right now.']
    };
    const chosen = views[view] || ['Browse all products', 'Compare products from every category with clear prices, ratings and buyer information.'];
    return { eyebrow: view ? 'Curated collection' : 'Classic Mart marketplace', title: chosen[0], description: chosen[1] };
  }

  function configurePage() {
    const context = pageContext();
    document.title = `${context.title} — Classic Mart`;
    qs('#catalogEyebrow').textContent = context.eyebrow;
    qs('#catalogTitle').textContent = context.title;
    qs('#catalogBreadcrumb').textContent = context.title;
    qs('#catalogDescription').textContent = context.description;
    if (state.mode === 'categories') qs('#categoryDirectory').hidden = false;
    const initialQuery = state.params.get('q') || '';
    qs('#catalogQuery').value = initialQuery;
    qs('#searchInput').value = initialQuery;
    const category = state.params.get('category') || 'all';
    qs('#searchCategory').value = category;
    if (state.mode === 'search') setTimeout(() => qs('#catalogQuery')?.focus(), 80);
  }

  function renderCategoryDirectory() {
    const grid = qs('#categoryDirectoryGrid');
    grid.innerHTML = categories.map(category => `
      <a class="category-directory-card" href="products.html?category=${category.id}">
        <div class="category-directory-image"><img src="${category.image}" alt="${escapeHtml(category.name)}" referrerpolicy="no-referrer"><span><img src="assets/icons/${category.icon}" alt=""></span></div>
        <div><h3>${escapeHtml(category.name)}</h3><p>${escapeHtml(category.note)}</p><b>Shop category <img src="assets/icons/chevron-right.svg" alt=""></b></div>
      </a>`).join('');
  }

  function renderFilterCategories() {
    const selected = state.params.get('category') || 'all';
    qs('#filterCategoryList').innerHTML = [{ id: 'all', name: 'All categories' }, ...categories].map(category => `
      <label><input type="radio" name="category" value="${category.id}" ${selected === category.id ? 'checked' : ''}><span>${escapeHtml(category.name)}</span><small>${category.id === 'all' ? state.products.length : state.products.filter(product => product.category === category.id).length}</small></label>`).join('');
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
      view: state.params.get('view') || ''
    };
  }

  function applyFilters(resetPage = true) {
    if (resetPage) state.page = 1;
    const filters = getFilters();
    let products = state.products.filter(product => {
      const haystack = [product.name, product.subtitle, product.brand, product.category, product.description].join(' ').toLowerCase();
      return (!filters.query || haystack.includes(filters.query)) &&
        (filters.category === 'all' || product.category === filters.category) &&
        (!filters.brand || product.brand.toLowerCase() === filters.brand.toLowerCase()) &&
        product.price >= filters.min && product.price <= filters.max &&
        product.rating >= filters.rating &&
        (!filters.inStock || product.stock > 0) &&
        (!filters.discount || product.oldPrice > product.price);
    });

    if (filters.view === 'deals') products = products.filter(product => product.oldPrice > product.price).sort((a,b) => ((b.oldPrice-b.price)/b.oldPrice) - ((a.oldPrice-a.price)/a.oldPrice));
    if (filters.view === 'recommended') products.sort((a,b) => b.rating - a.rating || b.reviews - a.reviews);
    if (filters.view === 'best-sellers') products.sort((a,b) => b.sold - a.sold || b.reviews - a.reviews);
    if (filters.view === 'budget') products = products.filter(product => product.price <= 50).sort((a,b) => b.rating - a.rating || a.price - b.price);
    if (filters.view === 'fresh' || filters.view === 'new') products.sort((a,b) => b.id - a.id);
    if (filters.view === 'brands') products.sort((a,b) => a.brand.localeCompare(b.brand) || b.rating - a.rating);
    if (filters.view === 'trending') products.sort((a,b) => b.sold - a.sold || b.rating - a.rating);

    const sort = qs('#catalogSort')?.value || 'featured';
    if (sort === 'rating') products.sort((a,b) => b.rating - a.rating || b.reviews - a.reviews);
    if (sort === 'popular') products.sort((a,b) => b.sold - a.sold);
    if (sort === 'price-low') products.sort((a,b) => a.price - b.price);
    if (sort === 'price-high') products.sort((a,b) => b.price - a.price);
    if (sort === 'discount') products.sort((a,b) => ((b.oldPrice-b.price)/b.oldPrice) - ((a.oldPrice-a.price)/a.oldPrice));

    state.filtered = products;
    renderProducts();
    renderActiveFilters(filters);
  }

  function productCard(product) {
    const wishlist = safeRead('shophub-wishlist', []);
    const wished = wishlist.includes(product.id);
    const discount = Math.max(0, Math.round((1 - product.price / product.oldPrice) * 100));
    return `<article class="catalog-product-card" data-product-id="${product.id}">
      <a class="catalog-product-image" href="index.html?product=${product.id}#trending" aria-label="View ${escapeHtml(product.name)} details"><img src="${product.image}" alt="${escapeHtml(product.name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='assets/product-placeholder.svg'"><span>${escapeHtml(product.badge)}</span></a>
      <button class="catalog-wishlist ${wished ? 'active' : ''}" data-catalog-wishlist="${product.id}" type="button" aria-label="${wished ? 'Remove from' : 'Add to'} wishlist"><img src="assets/icons/${wished ? 'heart.svg' : 'heart-regular.svg'}" alt=""></button>
      <div class="catalog-product-info"><div class="catalog-product-category">${escapeHtml(categoryLabel(product.category))}</div><a href="index.html?product=${product.id}#trending"><h3>${escapeHtml(product.name)}</h3></a><p>${escapeHtml(product.subtitle)} · ${escapeHtml(product.brand)}</p><div class="catalog-card-commerce"><div class="catalog-card-price"><strong>${money(product.price)}</strong><del>${money(product.oldPrice)}</del>${discount ? `<b>-${discount}%</b>` : ''}</div><div class="catalog-card-rating" aria-label="Rated ${product.rating.toFixed(1)} out of 5 from ${product.reviews} reviews"><span aria-hidden="true">★</span><strong>${product.rating.toFixed(1)}</strong><small>(${reviewCount(product.reviews)})</small></div></div><div class="catalog-card-meta"><span><img src="assets/icons/truck-fast.svg" alt=""> Tracked delivery</span><span>${product.stock > 0 ? `${product.stock} in stock` : 'Out of stock'}</span></div><div class="catalog-card-actions"><button data-catalog-add="${product.id}" type="button"><img src="assets/icons/cart-plus.svg" alt=""> Add to cart</button><a href="index.html?product=${product.id}#trending">View details</a></div></div>
    </article>`;
  }

  function renderProducts() {
    const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
    state.page = Math.min(state.page, totalPages);
    const start = (state.page - 1) * state.pageSize;
    const visible = state.filtered.slice(start, start + state.pageSize);
    const grid = qs('#catalogProductGrid');
    grid.classList.toggle('list-view', state.viewMode === 'list');
    grid.innerHTML = visible.map(productCard).join('');
    qs('#catalogResultCount').innerHTML = `<strong>${state.filtered.length}</strong> product${state.filtered.length === 1 ? '' : 's'} found`;
    qs('#catalogEmpty').hidden = state.filtered.length > 0;
    grid.hidden = state.filtered.length === 0;
    renderPagination(totalPages);
  }

  function renderPagination(totalPages) {
    const nav = qs('#catalogPagination');
    if (totalPages <= 1) { nav.innerHTML = ''; return; }
    const pages = [...new Set([1, state.page - 1, state.page, state.page + 1, totalPages].filter(page => page >= 1 && page <= totalPages))];
    nav.innerHTML = `<button data-page="${Math.max(1, state.page - 1)}" ${state.page === 1 ? 'disabled' : ''}><img src="assets/icons/chevron-left.svg" alt=""> Previous</button>${pages.map((page, index) => `${index && page - pages[index - 1] > 1 ? '<span>…</span>' : ''}<button class="${page === state.page ? 'active' : ''}" data-page="${page}">${page}</button>`).join('')}<button data-page="${Math.min(totalPages, state.page + 1)}" ${state.page === totalPages ? 'disabled' : ''}>Next <img src="assets/icons/chevron-right.svg" alt=""></button>`;
  }

  function renderActiveFilters(filters) {
    const chips = [];
    if (filters.query) chips.push(`Search: ${filters.query}`);
    if (filters.category !== 'all') chips.push(categoryLabel(filters.category));
    if (Number.isFinite(filters.min) && filters.min > 0) chips.push(`From ${money(filters.min)}`);
    if (Number.isFinite(filters.max)) chips.push(`Up to ${money(filters.max)}`);
    if (filters.rating) chips.push(`${filters.rating}+ rating`);
    if (filters.inStock) chips.push('In stock');
    if (filters.discount) chips.push('Discounted');
    if (filters.brand) chips.push(filters.brand);
    qs('#activeFilterRow').innerHTML = chips.length ? chips.map(chip => `<span>${escapeHtml(chip)}</span>`).join('') + '<button id="clearActiveFilters" type="button">Clear filters</button>' : '';
  }

  function clearFilters() {
    qs('#catalogFilterForm').reset();
    qs('#catalogQuery').value = '';
    qs('input[name="category"][value="all"]').checked = true;
    state.params.delete('q'); state.params.delete('category'); state.params.delete('brand');
    history.replaceState({}, '', `${location.pathname}${state.params.toString() ? `?${state.params}` : ''}`);
    applyFilters();
  }

  function openFilters() {
    qs('#catalogFilterPanel').classList.add('open');
    const backdrop = qs('#catalogFilterBackdrop');
    backdrop.hidden = false;
    requestAnimationFrame(() => backdrop.classList.add('show'));
    document.body.classList.add('no-scroll');
  }
  function closeFilters() {
    qs('#catalogFilterPanel').classList.remove('open');
    const backdrop = qs('#catalogFilterBackdrop');
    backdrop.classList.remove('show');
    setTimeout(() => { backdrop.hidden = true; }, 220);
    document.body.classList.remove('no-scroll');
  }

  let catalogSearchTimer;

  function selectCatalogCategory(category) {
    const requested = category || 'all';
    const radios = qsa('input[name="category"]');
    const match = radios.find(input => input.value === requested) || radios.find(input => input.value === 'all');
    if (match) match.checked = true;
  }

  function filterCatalogFromHeader({ scroll = false } = {}) {
    const query = qs('#searchInput')?.value.trim() || '';
    const category = qs('#searchCategory')?.value || 'all';
    if (qs('#catalogQuery')) qs('#catalogQuery').value = query;
    selectCatalogCategory(category);

    if (query) state.params.set('q', query); else state.params.delete('q');
    if (category !== 'all') state.params.set('category', category); else state.params.delete('category');
    history.replaceState({}, '', `${location.pathname}${state.params.toString() ? `?${state.params}` : ''}`);
    applyFilters();
    if (scroll) qs('#catalogWorkspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function scheduleCatalogFilter(callback) {
    clearTimeout(catalogSearchTimer);
    catalogSearchTimer = setTimeout(callback, 160);
  }

  function bindEvents() {
    qs('#searchForm')?.addEventListener('submit', event => {
      event.preventDefault();
      filterCatalogFromHeader({ scroll: true });
    });
    qs('#searchInput')?.addEventListener('input', () => scheduleCatalogFilter(() => filterCatalogFromHeader()));
    qs('#searchCategory')?.addEventListener('change', () => filterCatalogFromHeader());
    qs('#catalogQuery')?.addEventListener('input', () => scheduleCatalogFilter(() => applyFilters()));
    qs('#catalogFilterForm')?.addEventListener('change', event => {
      if (event.target.matches('input[name="category"], input[name="rating"], #inStockOnly, #discountOnly')) applyFilters();
    });
    qs('#catalogFilterForm')?.addEventListener('submit', event => { event.preventDefault(); applyFilters(); closeFilters(); });
    qs('#catalogSort')?.addEventListener('change', () => applyFilters(false));
    qs('#clearCatalogFilters')?.addEventListener('click', clearFilters);
    qs('#emptyClearButton')?.addEventListener('click', clearFilters);
    qs('#openCatalogFilters')?.addEventListener('click', openFilters);
    qs('#closeCatalogFilters')?.addEventListener('click', closeFilters);
    qs('#catalogFilterBackdrop')?.addEventListener('click', closeFilters);
    qs('#catalogMenuButton')?.addEventListener('click', event => {
      const nav = qs('#catalogNavLinks');
      const open = nav.classList.toggle('open');
      event.currentTarget.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', event => {
      const add = event.target.closest('[data-catalog-add]');
      if (add) {
        const product = state.products.find(item => item.id === Number(add.dataset.catalogAdd));
        if (product) { addToCart(product); add.innerHTML = '<img src="assets/icons/check.svg" alt=""> Added'; setTimeout(() => add.innerHTML = '<img src="assets/icons/cart-plus.svg" alt=""> Add to cart', 900); }
        return;
      }
      const wishlistButton = event.target.closest('[data-catalog-wishlist]');
      if (wishlistButton) {
        const id = Number(wishlistButton.dataset.catalogWishlist);
        const list = safeRead('shophub-wishlist', []);
        const index = list.indexOf(id);
        if (index >= 0) list.splice(index, 1); else list.push(id);
        safeWrite('shophub-wishlist', list);
        wishlistButton.classList.toggle('active', index < 0);
        wishlistButton.querySelector('img').src = `assets/icons/${index < 0 ? 'heart.svg' : 'heart-regular.svg'}`;
        showToast(index < 0 ? 'Product saved to wishlist' : 'Product removed from wishlist');
        return;
      }
      const pageButton = event.target.closest('[data-page]');
      if (pageButton && !pageButton.disabled) { state.page = Number(pageButton.dataset.page); renderProducts(); window.scrollTo({ top: qs('#catalogWorkspace').offsetTop - 100, behavior: 'smooth' }); return; }
      const viewButton = event.target.closest('[data-view-mode]');
      if (viewButton) { state.viewMode = viewButton.dataset.viewMode; qsa('[data-view-mode]').forEach(button => button.classList.toggle('active', button === viewButton)); renderProducts(); return; }
      if (event.target.closest('#clearActiveFilters')) clearFilters();
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closeFilters(); });
  }

  async function hydrateCatalog() {
    try {
      const response = await fetch('https://dummyjson.com/products?limit=100', { cache: 'force-cache' });
      if (!response.ok) throw new Error('Catalog request failed');
      const payload = await response.json();
      if (!Array.isArray(payload.products) || payload.products.length < 12) throw new Error('Incomplete catalog');
      state.products = payload.products.slice(0, 48).map(normalizeRemote);
    } catch (error) {
      console.warn('Using built-in Classic Mart catalog:', error);
    }
    renderFilterCategories();
    applyFilters();
  }

  function init() {
    configurePage();
    renderCategoryDirectory();
    renderFilterCategories();
    bindEvents();
    updateCartCount();
    applyFilters();
    hydrateCatalog();
  }

  init();
})();

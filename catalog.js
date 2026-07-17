(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const categories = [
    ['all', 'All products', 'https://images.unsplash.com/photo-1472851294608-062f824d29cc?auto=format&fit=crop&w=400&q=80'],
    ['electronics', 'Electronics', 'https://images.unsplash.com/photo-1498049794561-7780e7231661?auto=format&fit=crop&w=400&q=80'],
    ['fashion', 'Fashion', 'https://images.unsplash.com/photo-1445205170230-053b83016050?auto=format&fit=crop&w=400&q=80'],
    ['home', 'Home & Kitchen', 'https://images.unsplash.com/photo-1556911220-bff31c812dba?auto=format&fit=crop&w=400&q=80'],
    ['beauty', 'Beauty & Health', 'https://images.unsplash.com/photo-1596462502278-27bfdc403348?auto=format&fit=crop&w=400&q=80'],
    ['sports', 'Sports', 'https://images.unsplash.com/photo-1517836357463-d25dfeac3438?auto=format&fit=crop&w=400&q=80'],
    ['grocery', 'Groceries', 'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=400&q=80'],
    ['automotive', 'Automotive', 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=400&q=80']
  ];
  const fallback = [
    { title: 'Wireless Headphones', category: 'mobile-accessories', brand: 'Classic Audio', price: 49.99, discountPercentage: 22, rating: 4.8, stock: 34, thumbnail: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=900&q=86' },
    { title: 'Travel Backpack', category: 'mens-bags', brand: 'Classic Carry', price: 39.99, discountPercentage: 18, rating: 4.7, stock: 46, thumbnail: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=900&q=86' },
    { title: 'Smart Fitness Watch', category: 'mens-watches', brand: 'Classic Active', price: 89.99, discountPercentage: 28, rating: 4.9, stock: 22, thumbnail: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=900&q=86' },
    { title: 'Portable Blender', category: 'kitchen-accessories', brand: 'Classic Home', price: 25.49, discountPercentage: 15, rating: 4.5, stock: 51, thumbnail: 'https://images.unsplash.com/photo-1570222094114-d054a817e56b?auto=format&fit=crop&w=900&q=86' },
    { title: 'Everyday Sneakers', category: 'mens-shoes', brand: 'Classic Step', price: 49.99, discountPercentage: 24, rating: 4.8, stock: 31, thumbnail: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=900&q=86' },
    { title: 'Hydrating Skincare Set', category: 'skin-care', brand: 'Classic Glow', price: 32.99, discountPercentage: 20, rating: 4.6, stock: 63, thumbnail: 'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=900&q=86' }
  ];

  let allProducts = [];
  let visibleCount = 20;
  const state = { query: '', category: 'all', maxPrice: 2000, minRating: 0, dealsOnly: false, sort: 'featured', collection: 'all' };

  function read(key, fallback) { try { const value = localStorage.getItem(key); return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
  function write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
  function money(value) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value) || 0); }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;' })[ch]); }
  function mapCategory(category = '') {
    if (['beauty','fragrances','skin-care'].includes(category)) return 'beauty';
    if (['smartphones','laptops','tablets','mobile-accessories'].includes(category)) return 'electronics';
    if (['mens-shirts','mens-shoes','mens-watches','mens-bags','womens-bags','womens-dresses','womens-jewellery','womens-shoes','womens-watches','tops','sunglasses'].includes(category)) return 'fashion';
    if (['furniture','home-decoration','kitchen-accessories'].includes(category)) return 'home';
    if (category === 'groceries') return 'grocery';
    if (category === 'sports-accessories') return 'sports';
    if (['vehicle','motorcycle'].includes(category)) return 'automotive';
    return 'home';
  }
  function categoryName(id) { return categories.find(item => item[0] === id)?.[1] || 'All products'; }
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
      discount,
      rating: Math.min(5, Math.max(3.8, Number(item.rating) || 4.5)),
      reviews: Math.max(86, (item.reviews?.length || 2) * 417 + (item.id || index) * 9),
      stock: Number(item.stock) || 24,
      sold: Math.max(54, ((item.id || index) * 37) % 690),
      description: item.description || 'A carefully selected product with buyer-friendly information and support.'
    };
  }
  function showToast(message) { const toast = $('#catalogToast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200); }
  function updateCartCount() { const cart = read('shophub-cart', {}); $('#catalogCartCount').textContent = Object.values(cart).reduce((sum, value) => sum + Number(value || 0), 0); }
  function rememberProduct(product) { const saved = read('classic-mart-cart-products', {}); saved[product.id] = product; write('classic-mart-cart-products', saved); }
  function addToCart(product) { const cart = read('shophub-cart', {}); cart[product.id] = Math.min(99, Number(cart[product.id] || 0) + 1); write('shophub-cart', cart); rememberProduct(product); updateCartCount(); showToast(`${product.name} added to your cart`); }
  function toggleWishlist(product, button) { const list = read('shophub-wishlist', []); const index = list.indexOf(product.id); if (index >= 0) list.splice(index, 1); else list.push(product.id); write('shophub-wishlist', list); button.classList.toggle('active', index < 0); button.querySelector('img').src = index < 0 ? 'assets/icons/heart.svg' : 'assets/icons/heart-regular.svg'; showToast(index < 0 ? 'Saved to wishlist' : 'Removed from wishlist'); }

  function applyCollection(list) {
    if (state.collection === 'deals') return list.filter(product => product.discount >= 10).sort((a,b) => b.discount - a.discount);
    if (state.collection === 'recommended') return list.sort((a,b) => b.rating - a.rating || b.reviews - a.reviews);
    if (state.collection === 'best-sellers') return list.sort((a,b) => b.sold - a.sold);
    if (state.collection === 'budget') return list.filter(product => product.price <= 50).sort((a,b) => b.rating - a.rating);
    if (state.collection === 'fresh') return list.slice().reverse();
    if (state.collection === 'brands') return list.sort((a,b) => a.brand.localeCompare(b.brand));
    return list;
  }
  function filteredProducts() {
    let list = allProducts.filter(product => {
      const queryText = `${product.name} ${product.subtitle} ${product.brand} ${product.category} ${product.description}`.toLowerCase();
      return (!state.query || queryText.includes(state.query.toLowerCase())) &&
        (state.category === 'all' || product.category === state.category) &&
        product.price <= state.maxPrice &&
        product.rating >= state.minRating &&
        (!state.dealsOnly || product.discount > 0);
    });
    list = applyCollection(list);
    if (state.sort === 'rating') list.sort((a,b) => b.rating - a.rating || b.reviews - a.reviews);
    if (state.sort === 'price-asc') list.sort((a,b) => a.price - b.price);
    if (state.sort === 'price-desc') list.sort((a,b) => b.price - a.price);
    if (state.sort === 'discount') list.sort((a,b) => b.discount - a.discount);
    if (state.sort === 'featured' && state.collection === 'all') list.sort((a,b) => b.rating * b.sold - a.rating * a.sold);
    return list;
  }
  function card(product) {
    const wished = read('shophub-wishlist', []).includes(product.id);
    return `<article class="catalog-product-card" data-product-id="${product.id}" tabindex="0" role="button" aria-label="Open ${escapeHtml(product.name)} preview">
      <div class="catalog-product-image"><span class="catalog-product-badge">${Math.round(product.discount)}% Off</span><img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='assets/product-placeholder.svg'"><button class="catalog-wishlist ${wished ? 'active' : ''}" data-wishlist="${product.id}" type="button" aria-label="Save ${escapeHtml(product.name)}"><img src="assets/icons/${wished ? 'heart.svg' : 'heart-regular.svg'}" alt=""></button><div class="catalog-image-meta"><span>${escapeHtml(categoryName(product.category))}</span><span>Promo ${money(product.price * .03)}</span></div></div>
      <div class="catalog-product-info"><h3>${escapeHtml(product.name)}</h3><p>${escapeHtml(product.brand)} · ${escapeHtml(product.subtitle)}</p><div class="catalog-product-meta"><div class="catalog-product-price"><strong>${money(product.price)}</strong><del>${money(product.oldPrice)}</del></div><div class="catalog-product-rating"><b>★</b> ${product.rating.toFixed(1)} (${product.reviews > 999 ? `${(product.reviews/1000).toFixed(1)}K` : product.reviews})</div></div><div class="catalog-product-actions"><button class="catalog-add-cart" data-add-cart="${product.id}" type="button">Add to cart</button><a class="catalog-open-product" href="index.html?product=${product.id}#trending" aria-label="Open product preview"><img src="assets/icons/chevron-right.svg" alt=""></a></div></div>
    </article>`;
  }
  function renderCategories() {
    $('#catalogCategoryStrip').innerHTML = categories.map(item => `<button class="catalog-category-chip ${state.category === item[0] ? 'active' : ''}" data-category-chip="${item[0]}" type="button"><img src="${item[2]}" alt="" loading="lazy"><span><strong>${item[1]}</strong><small>${item[0] === 'all' ? 'Browse everything' : 'Explore category'}</small></span></button>`).join('');
  }
  function collectionLabel() {
    const labels = { deals: ['Deal collection','Best deals'], recommended: ['Selected for you','Recommended products'], 'best-sellers': ['Shopper favourites','Best sellers'], budget: ['Everyday value','Popular picks under $50'], fresh: ['Recently added','Fresh finds'], brands: ['Shop by maker','Top brands'] };
    return labels[state.collection] || ['Classic Mart catalogue','Explore the marketplace'];
  }
  function renderActiveFilters() {
    const chips = [];
    if (state.query) chips.push(`<button data-clear-filter="query">Search: ${escapeHtml(state.query)} ×</button>`);
    if (state.category !== 'all') chips.push(`<button data-clear-filter="category">${escapeHtml(categoryName(state.category))} ×</button>`);
    if (state.maxPrice < 2000) chips.push(`<button data-clear-filter="price">Up to ${money(state.maxPrice)} ×</button>`);
    if (state.minRating) chips.push(`<button data-clear-filter="rating">${state.minRating}+ stars ×</button>`);
    if (state.dealsOnly) chips.push(`<button data-clear-filter="deals">Deals only ×</button>`);
    $('#catalogActiveFilters').innerHTML = chips.join('');
  }
  function render() {
    const list = filteredProducts();
    const visible = list.slice(0, visibleCount);
    $('#catalogGrid').innerHTML = visible.length ? visible.map(card).join('') : '<div class="catalog-empty"><div><h3>No products matched your filters</h3><p>Try a different search, category, price or rating.</p></div></div>';
    $('#catalogResultCount').textContent = `${list.length} product${list.length === 1 ? '' : 's'} found${visible.length < list.length ? ` · showing ${visible.length}` : ''}`;
    const [eyebrow,title] = collectionLabel(); $('#catalogEyebrow').textContent = eyebrow; $('#catalogTitle').textContent = state.query ? `Results for “${state.query}”` : title;
    $('#catalogLoadMore').hidden = visible.length >= list.length;
    renderCategories(); renderActiveFilters();
  }
  function syncControls() {
    $('#catalogSearchInput').value = state.query; $('#catalogCategorySelect').value = state.category; $('#catalogSidebarCategory').value = state.category; $('#catalogPriceRange').value = state.maxPrice; $('#catalogPriceOutput').textContent = money(state.maxPrice); $('#catalogDealsOnly').checked = state.dealsOnly; $('#catalogSort').value = state.sort;
    const radio = document.querySelector(`input[name="catalogRating"][value="${state.minRating}"]`); if (radio) radio.checked = true;
  }
  function updateUrl() { const params = new URLSearchParams(); if (state.query) params.set('q', state.query); if (state.category !== 'all') params.set('category', state.category); if (state.collection !== 'all') params.set('collection', state.collection); history.replaceState(null, '', `${location.pathname}${params.toString() ? `?${params}` : ''}`); }
  function resetFilters() { Object.assign(state, { query:'', category:'all', maxPrice:2000, minRating:0, dealsOnly:false, sort:'featured', collection:'all' }); visibleCount=20; syncControls(); updateUrl(); render(); }

  async function loadProducts() {
    try { const response = await fetch('https://dummyjson.com/products?limit=100', { cache:'force-cache' }); if (!response.ok) throw new Error(); const data = await response.json(); allProducts = (data.products || []).slice(0,100).map(normalize); }
    catch { allProducts = fallback.map(normalize); }
    render();
  }
  function readUrl() { const params = new URLSearchParams(location.search); state.query = params.get('q') || ''; state.category = params.get('category') || 'all'; state.collection = params.get('collection') || 'all'; if (state.collection === 'budget') state.maxPrice = 50; syncControls(); }
  function bind() {
    $('#catalogSearchForm').addEventListener('submit', e => { e.preventDefault(); state.query = $('#catalogSearchInput').value.trim(); state.category = $('#catalogCategorySelect').value; visibleCount=20; $('#catalogSidebarCategory').value=state.category; updateUrl(); render(); });
    $('#catalogSearchInput').addEventListener('input', e => { state.query=e.target.value.trim(); visibleCount=20; render(); });
    $('#catalogCategorySelect').addEventListener('change', e => { state.category=e.target.value; $('#catalogSidebarCategory').value=state.category; visibleCount=20; updateUrl(); render(); });
    $('#catalogSidebarCategory').addEventListener('change', e => { state.category=e.target.value; $('#catalogCategorySelect').value=state.category; visibleCount=20; updateUrl(); render(); });
    $('#catalogPriceRange').addEventListener('input', e => { state.maxPrice=Number(e.target.value); $('#catalogPriceOutput').textContent=money(state.maxPrice); visibleCount=20; render(); });
    $$('input[name="catalogRating"]').forEach(input => input.addEventListener('change', e => { state.minRating=Number(e.target.value); visibleCount=20; render(); }));
    $('#catalogDealsOnly').addEventListener('change', e => { state.dealsOnly=e.target.checked; visibleCount=20; render(); });
    $('#catalogSort').addEventListener('change', e => { state.sort=e.target.value; render(); });
    $('#catalogResetFilters').addEventListener('click', resetFilters);
    $('#catalogLoadMore').addEventListener('click', () => { visibleCount += 20; render(); });
    $('#catalogMobileFilter').addEventListener('click', () => $('.catalog-filter-panel').classList.toggle('open'));
    document.addEventListener('click', e => {
      const chip=e.target.closest('[data-category-chip]'); if(chip){state.category=chip.dataset.categoryChip; $('#catalogCategorySelect').value=state.category; $('#catalogSidebarCategory').value=state.category; visibleCount=20; updateUrl(); render(); return;}
      const clear=e.target.closest('[data-clear-filter]'); if(clear){const key=clear.dataset.clearFilter; if(key==='query') state.query=''; if(key==='category') state.category='all'; if(key==='price') state.maxPrice=2000; if(key==='rating') state.minRating=0; if(key==='deals') state.dealsOnly=false; syncControls(); updateUrl(); render(); return;}
      const add=e.target.closest('[data-add-cart]'); if(add){e.preventDefault();e.stopPropagation();const p=allProducts.find(item=>item.id===Number(add.dataset.addCart));if(p)addToCart(p);return;}
      const wish=e.target.closest('[data-wishlist]'); if(wish){e.preventDefault();e.stopPropagation();const p=allProducts.find(item=>item.id===Number(wish.dataset.wishlist));if(p)toggleWishlist(p,wish);return;}
      const card=e.target.closest('.catalog-product-card'); if(card && !e.target.closest('a,button')) location.href=`index.html?product=${card.dataset.productId}#trending`;
      if(innerWidth<=920 && !e.target.closest('.catalog-filter-panel,#catalogMobileFilter')) $('.catalog-filter-panel').classList.remove('open');
    });
    document.addEventListener('keydown', e => { const card=e.target.closest?.('.catalog-product-card'); if(card && (e.key==='Enter'||e.key===' ')){e.preventDefault();location.href=`index.html?product=${card.dataset.productId}#trending`;}});
  }
  readUrl(); bind(); updateCartCount(); loadProducts();
})();

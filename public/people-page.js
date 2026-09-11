(() => {
  'use strict';

  const directoryType = document.body.dataset.directoryType === 'promoters' ? 'promoters' : 'sellers';
  const singular = directoryType === 'promoters' ? 'promoter' : 'seller';
  const grid = document.querySelector('#peopleGrid');
  const query = document.querySelector('#peopleQuery');
  const sort = document.querySelector('#peopleSort');
  const count = document.querySelector('#peopleCount');
  const empty = document.querySelector('#peopleEmpty');
  const heroCount = document.querySelector('#directoryStatCount');
  const heroPrimary = document.querySelector('#directoryStatPrimary');
  const heroSecondary = document.querySelector('#directoryStatSecondary');
  let people = [];
  let csrfToken = '';
  let nextCursor = '';
  let directoryTotal = 0;
  const loadMore = document.querySelector('#peopleLoadMore');

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]);

  function updateHero() {
    if (heroCount) heroCount.textContent = String(directoryTotal || people.length);
    if (directoryType === 'sellers') {
      const rated = people.filter((item) => Number(item.rating) > 0);
      const average = rated.length ? rated.reduce((sum, item) => sum + Number(item.rating), 0) / rated.length : 0;
      if (heroPrimary) heroPrimary.textContent = average ? average.toFixed(1) : 'New';
      if (heroSecondary) heroSecondary.textContent = String(people.reduce((sum, item) => sum + Number(item.productCount || 0), 0));
    } else {
      if (heroPrimary) heroPrimary.textContent = String(people.reduce((sum, item) => sum + Number(item.campaignCount || 0), 0));
      if (heroSecondary) heroSecondary.textContent = String(people.reduce((sum, item) => sum + Number(item.conversions || 0), 0));
    }
  }

  function promoterCard(person) {
    return `<article class="person-card"><div class="person-cover"></div><div class="person-content">
      <img class="person-avatar" src="${escapeHtml(person.image)}" alt="${escapeHtml(person.name)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='/assets/image-placeholder.svg'">
      <span class="person-verified"><img src="/assets/icons/circle-check.svg" alt="">Verified</span>
      <h2>${escapeHtml(person.name)}</h2><p class="person-role">${escapeHtml(person.country)} marketplace promoter</p>
      <p class="person-bio">${escapeHtml(person.description || 'Verified Classic Mart marketplace promoter.')}</p>
      <div class="person-metrics"><span><strong>${person.campaignCount || 0}</strong><small>Campaigns</small></span><span><strong>${person.clicks || 0}</strong><small>Clicks</small></span><span><strong>${person.conversions || 0}</strong><small>Conversions</small></span></div>
      <div class="person-tags">${[...(person.niches || []), ...(person.channels || [])].slice(0, 4).map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
      <div class="person-actions"><a href="/promoters/${encodeURIComponent(person.id)}">View profile</a><a class="person-products-link" href="/promoters/${encodeURIComponent(person.id)}#profileProducts">Campaign picks</a><button class="${person.followed ? 'active' : ''}" type="button" data-follow="${escapeHtml(person.id)}" aria-label="${person.followed ? 'Unfollow' : 'Follow'} ${escapeHtml(person.name)}"><img src="/assets/icons/${person.followed ? 'heart.svg' : 'heart-regular.svg'}" alt=""></button></div>
    </div></article>`;
  }

  function sellerCard(person) {
    return `<article class="person-card"><div class="person-cover"></div><div class="person-content">
      <img class="person-avatar" src="${escapeHtml(person.image)}" alt="${escapeHtml(person.name)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='/assets/product-placeholder.svg'">
      <span class="person-verified"><img src="/assets/icons/circle-check.svg" alt="">Verified</span>
      <h2>${escapeHtml(person.name)}</h2><p class="person-role">${escapeHtml(person.country)} marketplace seller</p>
      <p class="person-bio">${escapeHtml(person.description || 'Verified Classic Mart marketplace store.')}</p>
      <div class="person-metrics"><span><strong>${person.rating ? Number(person.rating).toFixed(1) : 'New'}</strong><small>Rating</small></span><span><strong>${person.productCount || 0}</strong><small>Products</small></span><span><strong>${person.categories?.length || 0}</strong><small>Categories</small></span></div>
      <div class="person-tags">${(person.categories || []).slice(0, 4).map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
      <div class="person-actions"><a href="/sellers/${encodeURIComponent(person.slug)}">View profile</a><a class="person-products-link" href="/products?seller=${encodeURIComponent(person.slug)}">Products</a><button class="${person.followed ? 'active' : ''}" type="button" data-follow="${escapeHtml(person.slug)}" aria-label="${person.followed ? 'Unfollow' : 'Follow'} ${escapeHtml(person.name)}"><img src="/assets/icons/${person.followed ? 'heart.svg' : 'heart-regular.svg'}" alt=""></button></div>
    </div></article>`;
  }

  function render() {
    const term = query?.value.trim().toLowerCase() || '';
    let items = people.filter((person) => [person.name, person.description, person.focus, person.country, ...(person.categories || []), ...(person.niches || []), ...(person.channels || [])].join(' ').toLowerCase().includes(term));
    if (sort?.value === 'rating') items.sort((a, b) => directoryType === 'sellers' ? Number(b.rating || 0) - Number(a.rating || 0) : Number(b.conversions || 0) - Number(a.conversions || 0));
    if (sort?.value === 'name') items.sort((a, b) => a.name.localeCompare(b.name));
    count.textContent = `${items.length} shown · ${directoryTotal || people.length} verified ${singular}${(directoryTotal || people.length) === 1 ? '' : 's'}`;
    empty.hidden = Boolean(items.length); grid.hidden = !items.length;
    grid.innerHTML = items.map((person) => directoryType === 'sellers' ? sellerCard(person) : promoterCard(person)).join('');
    updateHero();
  }

  async function toggleFollow(button) {
    const person = people.find((item) => (directoryType === 'sellers' ? item.slug : item.id) === button.dataset.follow);
    if (!person) return;
    const target = directoryType === 'sellers' ? `/api/v1/storefront/follow/${encodeURIComponent(person.slug)}` : `/api/v1/storefront/promoters/${encodeURIComponent(person.id)}/follow`;
    const response = await fetch(target, { method: person.followed ? 'DELETE' : 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'x-csrf-token': csrfToken } });
    if (response.status === 401) { location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`; return; }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) { const toast = document.querySelector('#catalogToast'); toast.textContent = payload.error?.message || `${singular} follow could not be updated.`; toast.classList.add('show'); return; }
    person.followed = payload.followed; render();
  }

  async function loadPeople(after = '') {
    try {
      if (loadMore) loadMore.disabled = true;
      const params = new URLSearchParams(); if (after) params.set('after', after);
      const response = await fetch(`/api/v1/storefront/${directoryType}${params.size ? `?${params}` : ''}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || `${directoryType} could not be loaded.`);
      const incoming = payload[directoryType] || [];
      if (!after) people = incoming; else { const key = item => directoryType === 'sellers' ? item.slug : item.id; const seen = new Set(people.map(key)); people.push(...incoming.filter(item => !seen.has(key(item)))); }
      csrfToken = payload.csrfToken || csrfToken; nextCursor = payload.page?.next || ''; directoryTotal = Number(payload.page?.total || people.length);
      if (loadMore) { loadMore.hidden = !payload.page?.hasMore; loadMore.disabled = false; }
      render();
    } catch (error) { count.textContent = error.message; if (!after) people = []; if (loadMore) loadMore.disabled = false; render(); }
  }

  const initialQuery = new URLSearchParams(location.search).get('q');
  if (query && initialQuery) query.value = initialQuery;
  document.querySelector('#peopleSearchForm')?.addEventListener('submit', (event) => { event.preventDefault(); render(); });
  query?.addEventListener('input', render); sort?.addEventListener('change', render);
  document.addEventListener('click', (event) => { const button = event.target.closest('[data-follow]'); if (button) toggleFollow(button); });
  loadMore?.addEventListener('click', () => { if (nextCursor) loadPeople(nextCursor); });
  loadPeople();
})();

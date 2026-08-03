(() => {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const sellerMatch = location.pathname.match(/^\/sellers\/([^/]+)$/);
  const promoterMatch = location.pathname.match(/^\/promoters\/([^/]+)$/);
  const profileType = promoterMatch ? 'promoter' : 'seller';
  const profileId = decodeURIComponent((promoterMatch || sellerMatch)?.[1] || new URLSearchParams(location.search).get(profileType === 'seller' ? 'slug' : 'id') || '');
  let profile;
  let csrfToken = '';

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]);
  function money(value, currency, locale = 'en-UG') { try { return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value); } catch { return `${currency} ${Number(value || 0).toLocaleString()}`; } }
  function showStatus(message) { const toast = byId('pageToast'); if (!toast) return; toast.textContent = message; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2200); }

  function renderProducts(products) {
    const container = byId('profileProducts');
    const rows = (products || []).slice(0, 9);
    if (!rows.length) { container.innerHTML = '<p>No currently available campaign products.</p>'; return; }
    container.innerHTML = rows.map((product) => `<article class="profile-product"><a href="/products/${encodeURIComponent(product.id)}"><img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='/assets/product-placeholder.svg'"></a><div><h3>${escapeHtml(product.name)}</h3><strong>${money(product.price, product.currency, profile.locale)}</strong></div></article>`).join('');
  }

  function renderSeller() {
    byId('profileRole').textContent = `Verified seller · ${profile.country}`;
    byId('profileAboutTitle').textContent = 'About this seller';
    byId('profileCollectionTitle').textContent = `Products from ${profile.name}`;
    byId('profileBio').textContent = profile.description || 'Verified Classic Mart marketplace store.';
    byId('profileAllProducts').href = `/products?seller=${encodeURIComponent(profile.slug)}`;
    byId('profileTags').innerHTML = ['<span>Verified business</span>', ...(profile.categories || []).slice(0, 3).map((item) => `<span>${escapeHtml(item)}</span>`)].join('');
    byId('profileMetrics').innerHTML = `<span><strong>${profile.rating ? Number(profile.rating).toFixed(1) : 'New'}</strong><small>Rating</small></span><span><strong>${profile.productCount || 0}</strong><small>Products</small></span><span><strong>${profile.categories?.length || 0}</strong><small>Categories</small></span>`;
    renderProducts(profile.products);
  }

  function renderPromoter() {
    byId('profileRole').textContent = `Verified promoter · ${profile.country}`;
    byId('profileAboutTitle').textContent = 'About this promoter';
    byId('profileCollectionTitle').textContent = `Campaign picks from ${profile.name}`;
    byId('profileBio').textContent = profile.description || 'Verified Classic Mart marketplace promoter.';
    byId('profileAllProducts').href = '/products';
    byId('profileAllProducts').textContent = 'Browse marketplace';
    byId('profileTags').innerHTML = ['<span>Verified promoter</span>', ...(profile.niches || []).slice(0, 3).map((item) => `<span>${escapeHtml(item)}</span>`), ...(profile.channels || []).slice(0, 2).map((item) => `<span>${escapeHtml(item)}</span>`)].join('');
    byId('profileMetrics').innerHTML = `<span><strong>${profile.campaignCount || 0}</strong><small>Campaigns</small></span><span><strong>${profile.clicks || 0}</strong><small>Tracked clicks</small></span><span><strong>${profile.conversions || 0}</strong><small>Conversions</small></span>`;
    renderProducts(profile.products);
  }

  function render() {
    document.title = `${profile.name} — Classic Mart`;
    const avatar = byId('profileAvatar'); avatar.src = profile.image || '/assets/image-placeholder.svg'; avatar.alt = profile.name; avatar.onerror = () => { avatar.onerror = null; avatar.src = '/assets/image-placeholder.svg'; };
    byId('profileName').textContent = profile.name; byId('profileShortName').textContent = profile.name;
    if (profileType === 'seller') renderSeller(); else renderPromoter();
    const follow = byId('followProfile'); follow.classList.toggle('active', profile.followed); follow.lastChild.textContent = profile.followed ? 'Following' : 'Follow'; follow.querySelector('img').src = `/assets/icons/${profile.followed ? 'heart.svg' : 'heart-regular.svg'}`;
  }

  function endpoint(suffix = '') {
    if (profileType === 'seller') return suffix === 'follow' ? `/api/v1/storefront/follow/${encodeURIComponent(profile.slug)}` : `/api/v1/storefront/sellers/${encodeURIComponent(profile.slug)}${suffix === 'contact' ? '/contact' : ''}`;
    return `/api/v1/storefront/promoters/${encodeURIComponent(profile.id)}${suffix === 'follow' ? '/follow' : suffix === 'contact' ? '/contact' : ''}`;
  }

  async function toggleFollow() {
    const response = await fetch(endpoint('follow'), { method: profile.followed ? 'DELETE' : 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'x-csrf-token': csrfToken } });
    if (response.status === 401) { location.href = `/login?next=${encodeURIComponent(location.pathname)}`; return; }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) { showStatus(payload.error?.message || 'Follow could not be updated.'); return; }
    profile.followed = payload.followed; render();
  }

  async function load() {
    if (!profileId) { location.replace(profileType === 'seller' ? '/sellers' : '/promoters'); return; }
    try {
      const response = await fetch(profileType === 'seller' ? `/api/v1/storefront/sellers/${encodeURIComponent(profileId)}` : `/api/v1/storefront/promoters/${encodeURIComponent(profileId)}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error?.message || `${profileType} not found.`);
      profile = payload[profileType]; csrfToken = payload.csrfToken || ''; render();
    } catch (error) { byId('profileName').textContent = `${profileType === 'seller' ? 'Seller' : 'Promoter'} unavailable`; byId('profileBio').textContent = error.message; }
  }

  byId('followProfile')?.addEventListener('click', () => { if (profile) toggleFollow(); });
  byId('shareProfile')?.addEventListener('click', async () => { try { await navigator.clipboard.writeText(location.href); showStatus('Profile link copied'); } catch { showStatus('Copy the address from your browser'); } });
  byId('profileContactForm')?.addEventListener('submit', async (event) => {
    event.preventDefault(); if (!profile) return;
    const subject = event.currentTarget.querySelector('[name="subject"]')?.value.trim() || `${profileType} enquiry`;
    const message = event.currentTarget.querySelector('[name="message"]')?.value.trim() || '';
    const response = await fetch(endpoint('contact'), { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ subject, message }) });
    if (response.status === 401) { location.href = `/login?next=${encodeURIComponent(location.pathname)}`; return; }
    const payload = await response.json().catch(() => ({})); byId('profileContactStatus').textContent = response.ok ? `Message sent. Reference: ${payload.request.id}` : payload.error?.message || 'Message could not be sent.'; if (response.ok) event.currentTarget.reset();
  });
  load();
})();

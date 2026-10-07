const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

const toast = $('#toast');
let toastTimer;
let rewardPoints = 320;
let walletBalance = 85000;
let cartCount = 3;
let wishlistCount = 5;
let editingAddressCard = null;

function showToast(message) {
  if (!message || !toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}

function formatMoney(value) {
  return `UGX ${Number(value).toLocaleString('en-UG')}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function updateCounters() {
  $$('.points-text').forEach((el) => { el.textContent = rewardPoints; });
  if ($('#pointsStat')) $('#pointsStat').textContent = rewardPoints;
  if ($('#sidePoints')) $('#sidePoints').textContent = rewardPoints;
  if ($('#walletBalance')) $('#walletBalance').textContent = formatMoney(walletBalance);
  if ($('#walletStat')) $('#walletStat').textContent = formatMoney(walletBalance);
  if ($('#sideWallet')) $('#sideWallet').textContent = formatMoney(walletBalance);
  if ($('#checkoutWallet')) $('#checkoutWallet').textContent = formatMoney(walletBalance);
  if ($('#cartBadge')) $('#cartBadge').textContent = cartCount;
  if ($('#wishlistBadge')) $('#wishlistBadge').textContent = wishlistCount;
  if ($('#wishlistCount')) $('#wishlistCount').textContent = wishlistCount;
  $$('.side-link[data-page-target="wishlist"] b').forEach((el) => { el.textContent = wishlistCount; });
  const titleCount = $('.title-count');
  if (titleCount) titleCount.textContent = cartCount;
}

const sidebar = $('#sidebar');
const sidebarOverlay = $('#sidebarOverlay');
const profileMenu = $('#profileMenu');

function openSidebar() {
  sidebar?.classList.add('open');
  sidebarOverlay?.classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeSidebar() {
  sidebar?.classList.remove('open');
  sidebarOverlay?.classList.remove('show');
  document.body.style.overflow = '';
}

function setSettingsTab(tabName) {
  const tab = tabName || 'personal';
  $$('.settings-nav button').forEach((button) => button.classList.toggle('active', button.dataset.settingsTab === tab));
  $$('.settings-content').forEach((panel) => panel.classList.toggle('active', panel.dataset.settingsPanel === tab));
}

function navigateTo(pageName, options = {}) {
  window.ClassicRoleDashboard?.ensureRoleForPage(pageName);
  const target = $(`.app-page[data-page="${pageName}"]`);
  if (!target) return;

  $$('.app-page').forEach((page) => page.classList.remove('active'));
  target.classList.add('active');
  $$('.side-link').forEach((link) => link.classList.toggle('active', link.dataset.pageTarget === pageName));

  const heading = target.querySelector('h1')?.textContent.trim() || 'Dashboard';
  document.title = `${heading} | Classic Mart`;
  if (location.hash !== `#${pageName}` && !options.fromHash) history.pushState({ page: pageName }, '', `#${pageName}`);

  if (pageName === 'profile' && options.profileTab) setSettingsTab(options.profileTab);
  closeSidebar();
  profileMenu?.classList.remove('show');
  window.scrollTo({ top: 0, behavior: options.instant ? 'auto' : 'smooth' });
}

function currentPageFromHash() {
  const value = location.hash.replace('#', '').trim();
  return $('.app-page[data-page="' + value + '"]') ? value : 'dashboard';
}


function addressTypeIcon(type) {
  return type === 'Office' ? 'i-bag' : type === 'Family' ? 'i-pin' : 'i-home';
}

function resetAddressFormMode() {
  editingAddressCard = null;
  const panel = $('#addressFormPanel');
  if (panel) $('h2', panel).textContent = 'Add Delivery Address';
  const submit = $('#addressForm button[type="submit"]');
  if (submit) submit.textContent = 'Save Address';
}

function populateAddressForm(card) {
  const form = $('#addressForm');
  if (!card || !form) return;
  editingAddressCard = card;
  const lines = ($('p', card)?.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const locality = lines[1] || '';
  const match = locality.match(/^([^,]+),\s*(.*?)(?:\s+(\d+))?$/);
  form.elements.fullName.value = $('h3', card)?.textContent?.trim() || '';
  form.elements.phone.value = card.querySelector(':scope > strong')?.textContent?.trim() || '';
  form.elements.street.value = lines[0] || '';
  form.elements.city.value = match?.[1]?.trim() || '';
  form.elements.region.value = match?.[2]?.trim() || '';
  form.elements.postal.value = match?.[3]?.trim() || '';
  form.elements.type.value = $('.address-type', card)?.textContent?.trim() || 'Home';
  form.elements.isDefault.checked = Boolean($('.default-badge', card));
  const panel = $('#addressFormPanel');
  if (panel) $('h2', panel).textContent = 'Edit Delivery Address';
  const submit = $('#addressForm button[type="submit"]');
  if (submit) submit.textContent = 'Update Address';
  panel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  form.elements.fullName.focus();
}

function addressCardMarkup(data) {
  const locality = `${escapeHtml(data.city)}, ${escapeHtml(data.region)}${data.postal ? ` ${escapeHtml(data.postal)}` : ''}`;
  return `<div class="address-top"><span class="address-type"><svg><use href="#${addressTypeIcon(data.type)}"></use></svg>${escapeHtml(data.type)}</span><button class="plain-link" data-action="make-default">Make Default</button></div><h3>${escapeHtml(data.fullName)}</h3><p>${escapeHtml(data.street)}<br>${locality}<br>Uganda</p><strong>${escapeHtml(data.phone)}</strong><div class="card-actions"><button class="soft-button" data-action="edit-address"><svg><use href="#i-edit"></use></svg>Edit</button><button class="outline-button" data-action="delete-address"><svg><use href="#i-trash"></use></svg>Delete</button></div>`;
}

document.addEventListener('click', (event) => {
  const control = event.target.closest('[data-page-target]');
  if (!control) return;
  event.preventDefault();
  navigateTo(control.dataset.pageTarget, { profileTab: control.dataset.profileTab });
});

window.addEventListener('popstate', () => navigateTo(currentPageFromHash(), { fromHash: true, instant: true }));

$('#mobileMenuBtn')?.addEventListener('click', openSidebar);
sidebarOverlay?.addEventListener('click', closeSidebar);
window.addEventListener('resize', () => { if (window.innerWidth > 840) closeSidebar(); });

$('#profileButton')?.addEventListener('click', (event) => {
  event.stopPropagation();
  profileMenu?.classList.toggle('show');
});
profileMenu?.addEventListener('click', (event) => event.stopPropagation());
document.addEventListener('click', () => profileMenu?.classList.remove('show'));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeSidebar();
    profileMenu?.classList.remove('show');
  }
});

$('#searchForm')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = $('#searchInput').value.trim();
  if (!query) {
    showToast('Enter a product, brand or order number to search');
    return;
  }
  if (window.ClassicRoleDashboard?.searchWorkspace(query)) return;
  const summary = $('#searchSummary');
  if (summary) summary.textContent = `Showing the closest matches for “${query}”.`;
  navigateTo('categories');
  showToast(`Search results for “${query}”`);
});

function redeemPoints(cost) {
  if (rewardPoints < cost) {
    showToast(`You need ${cost - rewardPoints} more points for this reward`);
    return;
  }
  rewardPoints -= cost;
  updateCounters();
  showToast(`${cost} points redeemed successfully`);
}

function addToCart(quantity = 1) {
  cartCount += quantity;
  updateCounters();
  showToast('Product added to your cart');
}

function toggleHeart(button) {
  const nowActive = button.classList.toggle('active');
  wishlistCount = Math.max(0, wishlistCount + (nowActive ? 1 : -1));
  updateCounters();
  showToast(nowActive ? 'Added to wishlist' : 'Removed from wishlist');
}

function recalculateCart() {
  const items = $$('.cart-item', $('#cartList'));
  let subtotal = 0;
  cartCount = 0;
  items.forEach((item) => {
    const qty = Number($('.quantity strong', item)?.textContent || 1);
    const price = Number(item.dataset.price || 0);
    subtotal += qty * price;
    cartCount += qty;
    const priceEl = $('.cart-price', item);
    if (priceEl) priceEl.textContent = formatMoney(qty * price);
  });
  const discount = Number($('#cartDiscount')?.dataset.value || 0);
  if ($('#cartSubtotal')) $('#cartSubtotal').textContent = formatMoney(subtotal);
  if ($('#cartTotal')) $('#cartTotal').textContent = formatMoney(Math.max(0, subtotal - discount));
  updateCounters();
}

function deleteAddress(card) {
  if (!card) return;
  if (card.classList.contains('selected')) {
    showToast('Choose another default address before deleting this one');
    return;
  }
  card.remove();
  showToast('Address deleted');
}

function makeAddressDefault(card) {
  if (!card) return;
  $$('.address-card').forEach((item) => {
    item.classList.remove('selected');
    const badge = $('.default-badge', item);
    badge?.remove();
    const existing = $('[data-action="make-default"]', item);
    if (!existing) {
      const button = document.createElement('button');
      button.className = 'plain-link';
      button.dataset.action = 'make-default';
      button.textContent = 'Make Default';
      $('.address-top', item)?.append(button);
    }
  });
  card.classList.add('selected');
  $('[data-action="make-default"]', card)?.remove();
  const badge = document.createElement('span');
  badge.className = 'default-badge';
  badge.textContent = 'Default';
  $('.address-top', card)?.append(badge);
  showToast('Default delivery address updated');
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('button, a');
  if (!target) return;

  if (target.matches('[data-redeem]')) redeemPoints(Number(target.dataset.redeem));
  if (target.matches('[data-action="toggle-heart"]')) toggleHeart(target);

  if (target.matches('[data-action="remove-wishlist"]')) {
    const card = target.closest('.product-card');
    card?.classList.add('removing');
    wishlistCount = Math.max(0, wishlistCount - 1);
    updateCounters();
    setTimeout(() => card?.remove(), 200);
    showToast('Removed from wishlist');
  }

  if (target.matches('[data-action="add-cart"], [data-action="buy-again"]')) addToCart();

  if (target.matches('[data-action="move-all-to-cart"]')) {
    const count = $$('#wishlistProducts .product-card').length;
    if (!count) return showToast('Your wishlist is empty');
    cartCount += count;
    wishlistCount = 0;
    $('#wishlistProducts').innerHTML = '';
    updateCounters();
    showToast(`${count} products moved to your cart`);
  }

  if (target.matches('[data-order-filter]')) {
    $$('#orderFilters button').forEach((button) => button.classList.remove('active'));
    target.classList.add('active');
    const status = target.dataset.orderFilter;
    $$('.rich-order').forEach((order) => { order.hidden = status !== 'all' && order.dataset.status !== status; });
  }

  if (target.matches('[data-qty]')) {
    const quantity = target.closest('.quantity');
    const number = $('strong', quantity);
    const current = Number(number.textContent);
    if (target.dataset.qty === 'minus' && current <= 1) return;
    number.textContent = target.dataset.qty === 'plus' ? current + 1 : current - 1;
    recalculateCart();
  }

  if (target.matches('[data-action="remove-cart"]')) {
    target.closest('.cart-item')?.remove();
    recalculateCart();
    showToast('Item removed from cart');
  }

  if (target.matches('[data-action="clear-cart"]')) {
    const cart = $('#cartList');
    if (cart) cart.innerHTML = '<div class="empty-state"><strong>Your cart is empty</strong><p>Browse categories to add products.</p></div>';
    recalculateCart();
    showToast('Cart cleared');
  }

  if (target.matches('[data-action="save-for-later"]')) {
    target.closest('.cart-item')?.remove();
    wishlistCount += 1;
    recalculateCart();
    showToast('Moved to wishlist');
  }

  if (target.matches('[data-action="apply-coupon"]')) {
    const code = $('#couponInput')?.value.trim().toUpperCase();
    if (code === 'CLASSIC10') {
      $('#cartDiscount').dataset.value = '50000';
      $('#cartDiscount').textContent = '−UGX 50,000';
      recalculateCart();
      showToast('CLASSIC10 applied — you saved UGX 50,000');
    } else {
      showToast('Try CLASSIC10 for a demo discount');
    }
  }

  if (target.matches('[data-amount]')) {
    $$('.amount-chips button').forEach((button) => button.classList.remove('active'));
    target.classList.add('active');
    $('#walletAmount').value = target.dataset.amount;
  }

  if (target.matches('[data-focus]')) {
    const input = document.getElementById(target.dataset.focus);
    input?.focus();
    input?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  if (target.matches('[data-action="edit-address"]')) { populateAddressForm(target.closest('.address-card')); return; }
  if (target.matches('[data-action="delete-address"]')) deleteAddress(target.closest('.address-card'));
  if (target.matches('[data-action="make-default"]')) makeAddressDefault(target.closest('.address-card'));

  if (target.matches('[data-settings-tab]')) setSettingsTab(target.dataset.settingsTab);

  if (target.matches('[data-support-category]')) {
    $('#supportCategory').value = target.dataset.supportCategory;
    $('#supportCategory').scrollIntoView({ behavior: 'smooth', block: 'center' });
    showToast(`${target.dataset.supportCategory} selected`);
  }

  if (target.matches('.faq-item')) {
    target.classList.toggle('open');
    target.nextElementSibling?.classList.toggle('open');
  }

  if (target.matches('[data-notification-filter]')) {
    $$('.notification-tabs button').forEach((button) => button.classList.remove('active'));
    target.classList.add('active');
    const filter = target.dataset.notificationFilter;
    $$('#notificationList article').forEach((item) => { item.hidden = filter !== 'all' && item.dataset.type !== filter; });
  }

  if (target.matches('[data-action="logout"]')) showToast('Demo account logged out successfully');

  if (target.matches('[data-action="add-card"], [data-action="edit-card"]')) {
    window.ClassicRoleDashboard?.openCreateForm?.('payment-method', target.matches('[data-action="edit-card"]') ? 'Edit payment method' : 'Add payment method');
    return;
  }
  if (target.matches('[data-action="start-return"], [data-action="return-item"]')) {
    window.ClassicRoleDashboard?.openCreateForm?.('returns', 'Start a return');
    return;
  }

  const genericMessages = {
    'download-orders': 'Order history downloaded', invoice: 'Invoice downloaded', track: 'Live tracking opened',
    'order-details': 'Order details opened', 'cancel-order': 'Cancellation request started',
    'edit-address': 'Address is ready to edit', 'reward-history': 'Points history opened',
    'wallet-statement': 'Wallet statement downloaded', 'wallet-help': 'Wallet help opened',
    'all-transactions': 'All transactions opened', 'add-card': 'Add payment method opened',
    'edit-card': 'Payment method editor opened', 'start-return': 'Select an eligible item below',
    'return-item': 'Return request started', 'reschedule-pickup': 'Pickup rescheduling opened',
    'all-tickets': 'All support tickets opened', 'preview-profile': 'Profile preview opened',
    'change-photo': 'Profile photo picker opened', sessions: 'Active sessions opened',
    'save-communication': 'Communication preferences saved', 'category-filter': 'Product filters opened',
    'view-more-products': 'More recommendations loaded', checkout: 'Secure checkout opened',
    'notification-menu': 'Notification options opened', 'save-notifications': 'Notification settings saved'
  };
  const action = target.dataset.action;
  if (genericMessages[action]) showToast(genericMessages[action]);
});

$('#walletForm')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const amount = Number($('#walletAmount').value);
  if (amount < 10000) return showToast('Minimum wallet top-up is UGX 10,000');
  walletBalance += amount;
  event.currentTarget.reset();
  $$('.amount-chips button').forEach((button) => button.classList.remove('active'));
  updateCounters();
  showToast(`${formatMoney(amount)} added to your wallet`);
});

$('#addressForm')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form).entries());
  data.isDefault = form.elements.isDefault.checked;
  const wasEditing = Boolean(editingAddressCard);
  let card = editingAddressCard;
  if (card) {
    card.innerHTML = addressCardMarkup(data);
  } else {
    card = document.createElement('article');
    card.className = 'address-card panel';
    card.innerHTML = addressCardMarkup(data);
    $('#addressList')?.prepend(card);
  }
  if (data.isDefault) makeAddressDefault(card);
  form.reset();
  resetAddressFormMode();
  showToast(wasEditing ? 'Delivery address updated' : 'New delivery address saved');
});

$('#showAddressForm')?.addEventListener('click', () => {
  $('#addressForm')?.reset();
  resetAddressFormMode();
  $('#addressFormPanel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('#addressForm input')?.focus();
});

$('#supportForm')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const subject = $('input[placeholder="Summarise the issue"]', event.currentTarget)?.value || 'New support request';
  const ticket = document.createElement('article');
  ticket.innerHTML = `<span class="ticket-icon"><svg><use href="#i-message"></use></svg></span><div><strong>${subject.replace(/[<>]/g, '')}</strong><small>New ticket · Just now</small></div><span class="status-pill shipped">Submitted</span>`;
  $('#ticketList')?.prepend(ticket);
  event.currentTarget.reset();
  showToast('Support ticket submitted successfully');
});

$$('.save-form').forEach((form) => form.addEventListener('submit', (event) => {
  event.preventDefault();
  showToast('Profile changes saved successfully');
}));

$('#markAllRead')?.addEventListener('click', () => {
  $$('#notificationList article').forEach((item) => item.classList.remove('unread'));
  if ($('#notificationBadge')) $('#notificationBadge').textContent = '0';
  showToast('All notifications marked as read');
});

// Mouse drag support for horizontal mobile content rows.
$$('.swipe-zone').forEach((container) => {
  let isDragging = false;
  let startX = 0;
  let startScrollLeft = 0;
  let moved = false;

  container.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'touch' || event.button !== 0) return;
    isDragging = true;
    moved = false;
    startX = event.clientX;
    startScrollLeft = container.scrollLeft;
    container.classList.add('is-dragging');
    container.setPointerCapture(event.pointerId);
  });

  container.addEventListener('pointermove', (event) => {
    if (!isDragging) return;
    const distance = event.clientX - startX;
    if (Math.abs(distance) > 4) moved = true;
    container.scrollLeft = startScrollLeft - distance;
  });

  const stopDragging = (event) => {
    if (!isDragging) return;
    isDragging = false;
    container.classList.remove('is-dragging');
    if (container.hasPointerCapture?.(event.pointerId)) container.releasePointerCapture(event.pointerId);
  };

  container.addEventListener('pointerup', stopDragging);
  container.addEventListener('pointercancel', stopDragging);
  container.addEventListener('click', (event) => {
    if (!moved) return;
    event.preventDefault();
    event.stopPropagation();
    moved = false;
  }, true);
});

window.ClassicRoleDashboard?.init();
updateCounters();
navigateTo(currentPageFromHash(), { fromHash: true, instant: true });
recalculateCart();

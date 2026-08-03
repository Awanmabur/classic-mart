(() => {
  'use strict';
  const form = document.querySelector('#trackPageForm');
  const input = document.querySelector('#trackPageInput');
  const result = document.querySelector('#trackingPageResult');
  const status = form?.querySelector('.form-status');
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
  let csrfToken = '';
  function money(minor, currency) {
    const zeroDecimal = ['UGX', 'RWF'].includes(currency);
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'UGX', maximumFractionDigits: zeroDecimal ? 0 : 2 }).format(zeroDecimal ? Number(minor || 0) : Number(minor || 0) / 100);
  }
  function paymentAction(order) {
    if (!['pending_payment', 'payment_failed'].includes(order.status)) return '';
    return `<button class="text-button tracking-pay-button" data-pay-order="${escapeHtml(order.id)}" type="button">${order.paymentMethod === 'cod' ? 'Confirm COD order' : 'Continue secure payment'}</button>`;
  }
  function cancellationAction(order) {
    if (!order.canMutate || !['pending_payment','payment_failed','confirmed','paid'].includes(order.status)) return '';
    const label = order.status === 'paid' ? 'Cancel & request refund' : 'Cancel order';
    return `<button class="text-button tracking-cancel-button" data-cancel-order="${escapeHtml(order.id)}" type="button">${label}</button>`;
  }
  async function load(orderId) {
    if (!orderId) return;
    if (status) status.textContent = 'Checking order…';
    try {
      const identity = document.querySelector('#trackIdentity')?.value?.trim() || '';
      const suffix = identity ? `?identity=${encodeURIComponent(identity)}` : '';
      const response = await fetch(`/api/v1/orders/${encodeURIComponent(orderId)}${suffix}`,  { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error?.message || 'Order could not be found.');
      csrfToken = payload.csrfToken || csrfToken; const order = payload.order;
      if (result) result.innerHTML = `<span class="tracking-icon"><img alt="" src="/assets/icons/box.svg"/></span><div><h2>${escapeHtml(order.id)}</h2><p><strong>${escapeHtml(String(order.status).replaceAll('_', ' '))}</strong> · ${escapeHtml(order.items.length)} item(s) · ${escapeHtml(money(order.totals.totalMinor, order.totals.currency))}</p>${paymentAction(order)}${cancellationAction(order)}<a class="text-button" href="/orders/${encodeURIComponent(order.id)}/receipt">View receipt</a>${order.isGuest ? `<a class="text-button" href="/signup?next=${encodeURIComponent(`/track-order?order=${order.id}`)}">Create account & keep this order</a>` : ''}${order.shipment ? `<p><strong>Delivery:</strong> ${escapeHtml(String(order.shipment.status).replaceAll('_',' '))}${order.shipment.deliveryCode ? ` · Delivery OTP: <b>${escapeHtml(order.shipment.deliveryCode)}</b>` : ''}</p>` : ''}<div class="tracking-timeline">${(order.timeline || []).map(event => `<p><b>${escapeHtml(event.message)}</b><small>${escapeHtml(new Date(event.at).toLocaleString())}</small></p>`).join('')}</div></div>`;
      if (status) status.textContent = 'Order found.';
    } catch (error) { if (status) status.textContent = error.message; if (result) result.innerHTML = `<span class="tracking-icon"><img alt="" src="/assets/icons/box.svg"/></span><div><h2>Order not available</h2><p>${escapeHtml(error.message)}</p></div>`; }
  }
  async function continuePayment(orderId, button) {
    button.disabled = true;
    try {
      const idempotencyKey = (crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^a-zA-Z0-9-]/g, '');
      const response = await fetch(`/api/v1/orders/${encodeURIComponent(orderId)}/payment-intents`, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ idempotencyKey }) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error?.message || 'Payment could not be started.');
      if (payload.payment?.checkoutUrl) { location.href = payload.payment.checkoutUrl; return; }
      await load(orderId);
    } catch (error) { if (status) status.textContent = error.message; button.disabled = false; }
  }

  async function cancelTrackedOrder(orderId, button) {
    if (!window.confirm('Cancel this order before carrier pickup? Paid online orders will request a provider refund.')) return;
    button.disabled = true;
    try {
      const response = await fetch(`/api/v1/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ reason: 'Customer cancelled from order tracking' }) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error?.message || 'Order could not be cancelled.');
      await load(orderId);
    } catch (error) { if (status) status.textContent = error.message; button.disabled = false; }
  }

  result?.addEventListener('click', event => { const pay = event.target.closest('[data-pay-order]'); if (pay) return continuePayment(pay.dataset.payOrder, pay); const cancel = event.target.closest('[data-cancel-order]'); if (cancel) return cancelTrackedOrder(cancel.dataset.cancelOrder, cancel); });
  form?.addEventListener('submit', event => { event.preventDefault(); load(input.value.trim()); });
  const initial = new URLSearchParams(location.search).get('order') || ''; if (initial) { input.value = initial; load(initial); }
})();

(() => {
  'use strict';
  const form = document.querySelector('#trackPageForm');
  const input = document.querySelector('#trackPageInput');
  const identityInput = document.querySelector('#trackIdentity');
  const result = document.querySelector('#trackingPageResult');
  const status = form?.querySelector('.form-status');
  const csrfInput = document.querySelector('#trackCsrf');
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
  let csrfToken = csrfInput?.value || '';
  let currentOrderId = '';

  function money(minor, currency) {
    const zeroDecimal = ['UGX', 'RWF'].includes(currency);
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'UGX', maximumFractionDigits: zeroDecimal ? 0 : 2 }).format(zeroDecimal ? Number(minor || 0) : Number(minor || 0) / 100);
  }
  function paymentAction(order) {
    if (!order.canMutate || !['pending_payment', 'payment_failed'].includes(order.status)) return '';
    return `<button class="text-button tracking-pay-button" data-pay-order="${escapeHtml(order.id)}" type="button">${order.paymentMethod === 'cod' ? 'Confirm COD order' : 'Continue secure payment'}</button>`;
  }
  function cancellationAction(order) {
    if (!order.canMutate || !['pending_payment','payment_failed','confirmed','paid'].includes(order.status)) return '';
    const label = order.status === 'paid' ? 'Cancel & request refund' : 'Cancel order';
    return `<button class="text-button tracking-cancel-button" data-cancel-order="${escapeHtml(order.id)}" type="button">${label}</button>`;
  }
  function stepUpAction(order) {
    if (order.canMutate) return '';
    return `<button class="text-button" data-step-up-order="${escapeHtml(order.id)}" type="button">Verify for payment, cancellation & delivery OTP</button>`;
  }
  function lifecycleSummary(order) {
    const parts = [
      `Payment: ${String(order.paymentState || 'unpaid').replaceAll('_', ' ')}`,
      `Fulfilment: ${String(order.fulfillmentState || 'unfulfilled').replaceAll('_', ' ')}`,
    ];
    if (order.returnState && order.returnState !== 'none') parts.push(`Return: ${String(order.returnState).replaceAll('_', ' ')}`);
    if (order.refundState && order.refundState !== 'none') parts.push(`Refund: ${String(order.refundState).replaceAll('_', ' ')}`);
    if (order.cancellationState && order.cancellationState !== 'none') parts.push(`Cancellation: ${String(order.cancellationState).replaceAll('_', ' ')}`);
    return parts.map(escapeHtml).join(' · ');
  }
  function itemProgress(order) {
    const rows = (order.items || []).map(item => {
      const delivered = Number(item.deliveredQuantity || 0);
      const returned = Number(item.returnedQuantity || 0);
      const refunded = Number(item.refundedQuantity || 0);
      return `<li><strong>${escapeHtml(item.title)}</strong>${item.variant ? ` · ${escapeHtml(item.variant)}` : ''}${item.sku ? ` · ${escapeHtml(item.sku)}` : ''}<br><small>ordered ${escapeHtml(item.quantity)} · delivered ${escapeHtml(delivered)} · returned ${escapeHtml(returned)} · refunded ${escapeHtml(refunded)}</small></li>`;
    }).join('');
    return rows ? `<div class="tracking-detail-block"><h3>Item progress</h3><ul>${rows}</ul></div>` : '';
  }
  function sellerShipmentProgress(order) {
    const rows = (order.sellerShipments || []).map(row => `<li><strong>${escapeHtml(row.storeId)}</strong> · ${escapeHtml(String(row.status).replaceAll('_', ' '))}<br><small>${escapeHtml(row.sellerOrderId)} · parcel ${escapeHtml(row.parcelId)} · ${escapeHtml(row.quantity)} item(s)</small></li>`).join('');
    return rows ? `<div class="tracking-detail-block"><h3>Seller shipments</h3><ul>${rows}</ul></div>` : '';
  }
  function financialDocuments(order) {
    const rows = (order.documents || []).map(doc => `<a class="text-button" href="${escapeHtml(doc.href)}">${escapeHtml(String(doc.type).replaceAll('_', ' '))} · ${escapeHtml(doc.number)}</a>`).join('');
    return rows ? `<div class="tracking-detail-block"><h3>Financial documents</h3>${rows}</div>` : `<a class="text-button" href="/orders/${encodeURIComponent(order.id)}/receipt">View receipt</a>`;
  }
  function verificationCard(orderId, purpose, destination = '') {
    const action = purpose === 'mutate' ? 'sensitive order actions' : 'tracking access';
    if (result) result.innerHTML = `<span class="tracking-icon"><img alt="" src="/assets/icons/box.svg"/></span><div><h2>Verify ${escapeHtml(orderId)}</h2><p>Enter the six-digit code sent to ${escapeHtml(destination || 'the order email address')} for ${escapeHtml(action)}.</p><form data-order-code-form><label>Verification code<input inputmode="numeric" autocomplete="one-time-code" maxlength="6" minlength="6" pattern="[0-9]{6}" data-order-code required></label><input type="hidden" data-order-purpose value="${escapeHtml(purpose)}"><button class="text-button" type="submit">Verify code</button></form></div>`;
  }
  async function requestChallenge(orderId, purpose = 'read') {
    const identity = identityInput?.value?.trim() || '';
    if (!identity) throw new Error('Enter the order email or phone first.');
    const response = await fetch(`/api/v1/orders/${encodeURIComponent(orderId)}/tracking-challenge`, {
      method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ identity, purpose }),
    });
    const payload = await response.json();
    csrfToken = payload.csrfToken || csrfToken;
    if (!response.ok) throw new Error(payload.error?.message || 'Verification code could not be sent.');
    verificationCard(orderId, purpose, payload.challenge?.destination || '');
    if (status) status.textContent = `Verification code sent to ${payload.challenge?.destination || 'the order email address'}.`;
  }
  async function verifyChallenge(orderId, code, purpose) {
    const response = await fetch(`/api/v1/orders/${encodeURIComponent(orderId)}/tracking-verify`, {
      method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ code, purpose }),
    });
    const payload = await response.json();
    csrfToken = payload.csrfToken || csrfToken;
    if (!response.ok) throw new Error(payload.error?.message || 'Verification failed.');
    await load(orderId, { requestChallengeOnUnauthorized: false });
  }
  async function load(orderId, { requestChallengeOnUnauthorized = true } = {}) {
    if (!orderId) return;
    currentOrderId = orderId;
    if (status) status.textContent = 'Checking order…';
    try {
      const response = await fetch(`/api/v1/orders/${encodeURIComponent(orderId)}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const payload = await response.json();
      csrfToken = payload.csrfToken || csrfToken;
      if (!response.ok) {
        if (response.status === 401 && payload.error?.code === 'ORDER_TRACKING_VERIFICATION_REQUIRED' && requestChallengeOnUnauthorized) {
          await requestChallenge(orderId, 'read');
          return;
        }
        throw new Error(payload.error?.message || 'Order could not be found.');
      }
      const order = payload.order;
      const stateLabel = order.displayStatus || String(order.status).replaceAll('_', ' ');
      if (result) result.innerHTML = `<span class="tracking-icon"><img alt="" src="/assets/icons/box.svg"/></span><div><h2>${escapeHtml(order.id)}</h2><p><strong>${escapeHtml(stateLabel)}</strong> · ${escapeHtml(order.items.length)} item(s) · ${escapeHtml(money(order.totals.totalMinor, order.totals.currency))}</p><p><small>${lifecycleSummary(order)}</small></p>${paymentAction(order)}${cancellationAction(order)}${stepUpAction(order)}${financialDocuments(order)}${order.isGuest ? `<a class="text-button" href="/signup?next=${encodeURIComponent(`/track-order?order=${order.id}`)}">Create account & keep this order</a>` : ''}${order.shipment ? `<p><strong>Root delivery:</strong> ${escapeHtml(String(order.shipment.status).replaceAll('_',' '))}${order.shipment.deliveryCode ? ` · Delivery OTP: <b>${escapeHtml(order.shipment.deliveryCode)}</b>` : ''}</p>` : ''}${sellerShipmentProgress(order)}${itemProgress(order)}<div class="tracking-timeline"><h3>Order timeline</h3>${(order.timeline || []).map(event => `<p><b>${escapeHtml(event.message)}</b><small>${escapeHtml(new Date(event.at).toLocaleString())}</small></p>`).join('')}</div></div>`;
      if (status) status.textContent = order.canMutate ? 'Order found. Sensitive actions are verified.' : 'Order found. Tracking access is read-only.';
    } catch (error) {
      if (status) status.textContent = error.message;
      if (result) result.innerHTML = `<span class="tracking-icon"><img alt="" src="/assets/icons/box.svg"/></span><div><h2>Order not available</h2><p>${escapeHtml(error.message)}</p></div>`;
    }
  }
  async function continuePayment(orderId, button) {
    button.disabled = true;
    try {
      const idempotencyKey = (crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^a-zA-Z0-9-]/g, '');
      const response = await fetch(`/api/v1/orders/${encodeURIComponent(orderId)}/payment-intents`, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ idempotencyKey }) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error?.message || 'Payment could not be started.');
      if (payload.payment?.checkoutUrl) { location.href = payload.payment.checkoutUrl; return; }
      await load(orderId, { requestChallengeOnUnauthorized: false });
    } catch (error) { if (status) status.textContent = error.message; button.disabled = false; }
  }
  async function cancelTrackedOrder(orderId, button) {
    if (!window.confirm('Cancel this order before carrier pickup? Paid online orders will request a provider refund.')) return;
    button.disabled = true;
    try {
      const response = await fetch(`/api/v1/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ reason: 'Customer cancelled from order tracking' }) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error?.message || 'Order could not be cancelled.');
      await load(orderId, { requestChallengeOnUnauthorized: false });
    } catch (error) { if (status) status.textContent = error.message; button.disabled = false; }
  }

  result?.addEventListener('click', async event => {
    const pay = event.target.closest('[data-pay-order]'); if (pay) return continuePayment(pay.dataset.payOrder, pay);
    const cancel = event.target.closest('[data-cancel-order]'); if (cancel) return cancelTrackedOrder(cancel.dataset.cancelOrder, cancel);
    const step = event.target.closest('[data-step-up-order]');
    if (step) { try { step.disabled = true; await requestChallenge(step.dataset.stepUpOrder, 'mutate'); } catch (error) { if (status) status.textContent = error.message; step.disabled = false; } }
  });
  result?.addEventListener('submit', async event => {
    const codeForm = event.target.closest('[data-order-code-form]'); if (!codeForm) return;
    event.preventDefault();
    const code = codeForm.querySelector('[data-order-code]')?.value?.trim() || '';
    const purpose = codeForm.querySelector('[data-order-purpose]')?.value || 'read';
    const button = codeForm.querySelector('button[type="submit"]'); if (button) button.disabled = true;
    try { await verifyChallenge(currentOrderId, code, purpose); }
    catch (error) { if (status) status.textContent = error.message; if (button) button.disabled = false; }
  });
  form?.addEventListener('submit', event => { event.preventDefault(); load(input.value.trim()); });
  const initial = new URLSearchParams(location.search).get('order') || ''; if (initial) { input.value = initial; load(initial); }
})();

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { AppError, asyncHandler } from '../core/errors.js';
import { noStore } from '../middleware/request.js';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { loadSellerStore, requireStoreCapability } from '../middleware/store.js';
import { setFlash } from '../middleware/view.js';
import { allowedWorkspacesFor } from '../dashboard/access.js';
import { env } from '../config/env.js';
import { liveAccountHeader } from '../dashboard/live-account-header.js';
import { sellerNavigation, SELLER_LIVE_ROUTES } from '../dashboard/seller-navigation.js';
import { sellerOrderList, sellerOrderDetail, transitionSellerOrder } from '../services/seller-orders.js';
import { writeAudit } from '../services/audit.js';

const router = Router();
const privatePage = (_request, response, next) => { response.set('X-Robots-Tag', 'noindex, nofollow, noarchive'); next(); };
const access = [noStore, privatePage, requireAuth, requireVerified, requireOnboarding];
const requireFulfilmentMfa = (request, response, next) => {
  // Store staff may retain a customer account role. The operational capability,
  // rather than that display role, defines this privileged boundary.
  if (env.auth.simpleLogin || !env.security.privilegedMfaRequired || request.user.security?.mfaEnabled) return next();
  if (request.accepts(['html', 'json']) === 'json') return next(new AppError('Multi-factor authentication enrollment is required for order operations.', 403, 'MFA_ENROLLMENT_REQUIRED'));
  return response.redirect('/account/security?next=' + encodeURIComponent(request.originalUrl));
};
const seller = [...access, loadSellerStore, requireStoreCapability('fulfilment'), requireFulfilmentMfa];
const mutationLimit = rateLimit({ windowMs: 15 * 60_000, limit: 80, standardHeaders: 'draft-8', legacyHeaders: false });
const exportLimit = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
const detailPath = id => '/seller/orders/' + encodeURIComponent(id);
const filtersFor = request => ({ status: String(request.query.status || '').slice(0, 30), search: String(request.query.search || '').slice(0, 100) });

async function orderPage(request, response, mode = 'detail', error = '') {
  const filters = filtersFor(request);
  const data = mode === 'detail' ? await sellerOrderDetail(request)
    : await sellerOrderList(request, { after: request.query.after, status: filters.status, q: filters.search, shipping: mode === 'shipping' });
  if (request.accepts(['html', 'json']) === 'json') return response.json(data);
  const header = await liveAccountHeader(request);
  return response.render('approved-dashboard', {
    ...header, workspace: 'seller', initialPage: mode === 'shipping' ? 'seller-shipping' : 'seller-orders',
    customerRoutes: { ...header.customerRoutes, ...SELLER_LIVE_ROUTES }, allowedWorkspaces: allowedWorkspacesFor(request.user),
    liveSeller: { profileRole: 'Seller', store: request.store.toObject(), navigation: sellerNavigation(request),
      orderFlow: { ...data, mode, filters: data.filters || filters, error } },
  });
}

router.get('/seller/orders', ...seller, asyncHandler((request, response) => orderPage(request, response, 'list')));
router.get('/seller/shipping', ...seller, asyncHandler((request, response) => orderPage(request, response, 'shipping')));
for (const [page, path] of [['seller-orders', '/seller/orders'], ['seller-shipping', '/seller/shipping']]) {
  router.get('/dashboard/' + page, ...access, (request, response) => response.redirect(308, path + new URL(request.originalUrl, 'http://localhost').search));
}

function csvCell(value) {
  let text = String(value ?? '');
  // Neutralize formulas even when spreadsheet applications strip leading whitespace.
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
router.get('/seller/orders/export.csv', ...seller, exportLimit, asyncHandler(async (request, response) => {
  const filters = filtersFor(request);
  const orders = [];
  let after = '';
  do {
    const data = await sellerOrderList(request, { after, status: filters.status, q: filters.search, shipping: request.query.shipping === '1', limit: 100 });
    orders.push(...data.orders);
    if (orders.length > 500 || (orders.length === 500 && data.page.hasMore)) throw new AppError('Exports support up to 500 orders. Narrow the search or status filter and try again.', 422, 'ORDER_EXPORT_LIMIT');
    after = data.page.hasMore ? data.page.next : '';
  } while (after);
  await writeAudit(request, 'seller.orders_exported', { targetType: 'store', targetPublicId: request.store.publicId,
    country: request.store.country, metadata: { rowCount: orders.length, status: filters.status } });
  const rows = [['Seller order', 'Marketplace order', 'Status', 'Payment state', 'Currency', 'Subtotal minor', 'Shipping minor', 'Tax minor', 'Discount minor', 'Total minor', 'Created at'],
    ...orders.map(order => [order.publicId, order.orderPublicId, order.statusLabel, order.paymentState, order.currency,
      order.totals.subtotalMinor, order.totals.shippingMinor, order.totals.taxMinor, order.totals.discountMinor, order.totals.totalMinor,
      new Date(order.createdAt).toISOString()])];
  response.set('Content-Disposition', 'attachment; filename="classic-mart-seller-orders.csv"');
  return response.type('text/csv; charset=utf-8').send(rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
}));
router.get('/seller/orders/:publicId', ...seller, asyncHandler((request, response) => orderPage(request, response)));
for (const action of ['processing', 'pick', 'pack', 'dispatch']) {
  router.post('/seller/orders/:publicId/' + action, ...seller, mutationLimit, asyncHandler(async (request, response) => {
    try {
      const order = await transitionSellerOrder(request, action);
      if (request.accepts(['html', 'json']) === 'json') return response.json({ order });
      setFlash(request, 'success', ({ processing: 'Order processing started.', pick: 'Items picked from their reserved warehouses.',
        pack: 'Parcel packed.', dispatch: 'Parcel ready for carrier pickup.' })[action]);
      return response.redirect(303, detailPath(request.params.publicId));
    } catch (error) {
      const status = error.name === 'ZodError' ? 422 : error.status;
      if (![409, 422].includes(status) || request.accepts(['html', 'json']) === 'json') throw error;
      response.status(status);
      return orderPage(request, response, 'detail', error.name === 'ZodError' ? error.issues[0].message : error.message);
    }
  }));
}
export default router;

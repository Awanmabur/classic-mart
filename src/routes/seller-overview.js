import { Router } from 'express';
import { AppError, asyncHandler } from '../core/errors.js';
import { noStore } from '../middleware/request.js';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { loadSellerStore, requireStoreCapability } from '../middleware/store.js';
import { canAccessWorkspace, allowedWorkspacesFor } from '../dashboard/access.js';
import { liveSellerAccountHeader as liveAccountHeader } from '../dashboard/live-account-header.js';
import { sellerNavigation, SELLER_LIVE_ROUTES } from '../dashboard/seller-navigation.js';
import { loadSellerOverview } from '../services/seller-overview.js';

const router = Router();
const access = [noStore, (_request, response, next) => { response.set('X-Robots-Tag', 'noindex, nofollow, noarchive'); next(); },
  requireAuth, requireVerified, requireOnboarding,
  (request, _response, next) => canAccessWorkspace(request.user, 'seller') ? next() : next(new AppError('Seller access is required.', 403, 'DASHBOARD_FORBIDDEN')),
  loadSellerStore, requireStoreCapability('staff')];

// Read the original URL so pollution protection cannot silently turn repeated
// or nested reporting parameters into a different, valid reporting period.
function reportingPeriod(request) {
  const query = new URL(request.originalUrl, 'http://localhost').searchParams;
  if (query.getAll('period').length > 1 || [...query.keys()].some(key => /^period(?:\[|\.)/u.test(key))) {
    throw new AppError('Select one supported reporting period.', 422, 'SELLER_PERIOD_INVALID');
  }
  return query.has('period') ? query.get('period') : undefined;
}

router.get('/seller/overview', ...access, asyncHandler(async (request, response) => {
  const json = request.accepts(['html', 'json']) === 'json';
  const [overviewFlow, header] = await Promise.all([
    loadSellerOverview(request, { period: reportingPeriod(request) }), json ? null : liveAccountHeader(request),
  ]);
  if (json) return response.json(overviewFlow);
  return response.render('approved-dashboard', { ...header, workspace: 'seller', initialPage: 'seller-overview',
    customerRoutes: { ...header.customerRoutes, ...SELLER_LIVE_ROUTES }, allowedWorkspaces: allowedWorkspacesFor(request.user),
    liveSeller: { profileRole: 'Seller', store: overviewFlow.store, navigation: sellerNavigation(request), overviewFlow } });
}));
for (const path of ['/seller', '/dashboard/seller-overview']) router.get(path, ...access.slice(0, 6), (request, response) =>
  response.redirect(308, '/seller/overview' + new URL(request.originalUrl, 'http://localhost').search));

const csvCell = value => {
  let text = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};
router.get('/seller/overview/summary.csv', ...access, asyncHandler(async (request, response) => {
  const data = await loadSellerOverview(request, { period: reportingPeriod(request), export: true });
  const rows = [['Store', 'Country', 'Currency', 'Time zone', 'Period start', 'Period end'],
    [data.store.name, data.store.country, data.store.currency, data.timeZone, data.range.start.toISOString(), data.range.end.toISOString()],
    ['Metric', 'Value'], ['Paid item sales minor', data.metrics.paidMinor], ['Completed item refunds minor', data.metrics.refundMinor],
    ['Net paid item sales minor', data.metrics.netSalesMinor], ['Orders created', data.metrics.orders],
    ['Published products', data.metrics.publishedProducts], ['Published reviews', data.metrics.reviews],
    ['Bucket', 'Paid item sales minor', 'Completed item refunds minor', 'Net paid item sales minor'],
    ...data.trend.map(bucket => [bucket.key, bucket.paidMinor, bucket.refundMinor, bucket.netMinor])];
  response.set('Content-Disposition', 'attachment; filename="classic-mart-store-summary.csv"');
  return response.type('text/csv; charset=utf-8').send(rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
}));
export default router;

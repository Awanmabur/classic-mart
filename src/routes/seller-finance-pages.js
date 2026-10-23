import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { AppError, asyncHandler } from '../core/errors.js';
import { sellerPageGates, renderSellerPage } from '../dashboard/seller-page-view.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { writeAudit } from '../services/audit.js';
import { streamSellerLedgerCsv } from '../services/seller-finance.js';
import { createSellerPayoutDestination, loadSellerAnalyticsPage, loadSellerFinancePage, requestSellerPayout, sellerFinanceAccess } from '../services/seller-finance-pages.js';

const router = Router();
const mutateLimiter = rateLimit({ scope: 'seller-finance-pages:1', windowMs: 15 * 60_000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false });
const periods = new Set(['7months', '30days', 'year']);
function reportingPeriod(request) {
  const query = new URL(request.originalUrl, 'http://localhost').searchParams;
  if (query.getAll('period').length > 1 || [...query.keys()].some(key => /^period(?:\[|\.)/u.test(key))) {
    throw new AppError('Select one supported reporting period.', 422, 'SELLER_PERIOD_INVALID');
  }
  const period = query.get('period') || '30days';
  if (!periods.has(period)) throw new AppError('Select one supported reporting period.', 422, 'SELLER_PERIOD_INVALID');
  return period;
}
function validateFinanceQuery(request) {
  const params = new URL(request.originalUrl, 'http://localhost').searchParams;
  for (const name of ['q', 'search', 'status', 'after']) {
    if (params.getAll(name).length > 1 || [...params.keys()].some(key => key.startsWith(name + '[') || key.startsWith(name + '.'))) {
      throw new AppError('Provide one value for each finance filter.', 422, 'SELLER_FINANCE_FILTER_INVALID');
    }
  }
}
for (const [pageId, path] of [['seller-earnings', '/seller/earnings'], ['seller-payouts', '/seller/payouts']]) {
  router.get(path, ...sellerPageGates('finance'), asyncHandler(async (request, response) => {
    validateFinanceQuery(request);
    return renderSellerPage(request, response, pageId, await loadSellerFinancePage(request, pageId));
  }));
  router.get('/dashboard/' + pageId, ...sellerPageGates('finance'), (request, response) => response.redirect(308, path + new URL(request.originalUrl, 'http://localhost').search));
}
router.post('/seller/payouts/accounts', ...sellerPageGates('finance'), mutateLimiter, asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request);
  const account = await createSellerPayoutDestination(request, request.body || {});
  await writeAudit(request, 'seller.payout_account_created', { targetType: 'payout_account', targetPublicId: account.publicId, country: request.store.country });
  if (request.accepts(['html', 'json']) === 'json') return response.status(201).json({ account });
  setFlash(request, 'success', 'Payout destination added and awaiting verification.');
  return response.redirect('/seller/payouts');
}));
router.post('/seller/payouts', ...sellerPageGates('finance'), mutateLimiter, asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request);
  const payout = await requestSellerPayout(request, request.body || {});
  await writeAudit(request, 'seller.payout_requested', { targetType: 'payout', targetPublicId: payout.publicId, country: request.store.country });
  if (request.accepts(['html', 'json']) === 'json') return response.status(201).json({ payout });
  setFlash(request, 'success', 'Payout request recorded. Follow its status while finance reviews and processes it.');
  return response.redirect('/seller/payouts');
}));
router.get('/seller/earnings/ledger.csv', ...sellerPageGates('finance'), asyncHandler(async (request, response) => {
  const { store } = await sellerFinanceAccess(request);
  await writeAudit(request, 'seller.ledger_exported', { targetType: 'store', targetPublicId: store.publicId, country: store.country });
  response.set('Content-Disposition', 'attachment; filename="classic-mart-seller-ledger.csv"');
  response.type('text/csv; charset=utf-8');
  await streamSellerLedgerCsv({ store, response });
  return response.end();
}));
const csvCell = value => {
  let text = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};
router.get('/seller/earnings/contribution.csv', ...sellerPageGates('finance'), asyncHandler(async (request, response) => {
  const page = await loadSellerFinancePage(request, 'seller-earnings');
  const report = page.finance.profitability;
  const rows = [['Store', 'Currency', 'Reported SKUs', 'Total SKUs', 'Limited report'],
    [page.store.name, page.currency, report.rows.length, report.totalSkuCount, report.limited ? 'yes' : 'no'],
    ['Methodology', report.methodology],
    ['SKU', 'Product', 'Units', 'Known cost units', 'Unknown cost units', 'Known cost minor', 'Known receivable minor', 'Known refund reversals minor', 'Known net contribution minor'],
    ...report.rows.map(row => [row.sku, row.title, row.units, row.knownCostUnits, row.unknownCostUnits, row.knownCostMinor,
      row.knownSellerReceivableMinor, row.knownRefundSellerMinor, row.netContributionMinor])];
  await writeAudit(request, 'seller.contribution_exported', { targetType: 'store', targetPublicId: page.store.publicId, country: page.store.country });
  response.set('Content-Disposition', 'attachment; filename="classic-mart-seller-contribution.csv"');
  return response.type('text/csv; charset=utf-8').send(rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
}));
router.get('/seller/analytics', ...sellerPageGates('analytics'), asyncHandler(async (request, response) =>
  renderSellerPage(request, response, 'seller-analytics', await loadSellerAnalyticsPage(request, { period: reportingPeriod(request) }))));
router.get('/dashboard/seller-analytics', ...sellerPageGates('analytics'), (request, response) => response.redirect(308, '/seller/analytics' + new URL(request.originalUrl, 'http://localhost').search));
router.get('/seller/analytics/summary.csv', ...sellerPageGates('analytics'), asyncHandler(async (request, response) => {
  const page = await loadSellerAnalyticsPage(request, { period: reportingPeriod(request), export: true });
  const rows = [['Store', 'Country', 'Currency', 'Time zone', 'Period start', 'Period end'],
    [page.store.name, page.store.country, page.currency, page.timeZone, page.range.start.toISOString(), page.range.end.toISOString()],
    ['Metric', 'Value'], ...Object.entries(page.analytics),
    ['Period', 'Paid item sales minor', 'Completed refunds minor', 'Net paid sales minor'],
    ...page.trend.map(row => [row.key, row.paidMinor, row.refundMinor, row.netMinor])];
  await writeAudit(request, 'seller.analytics_exported', { targetType: 'store', targetPublicId: page.store.publicId, country: page.store.country });
  response.set('Content-Disposition', 'attachment; filename="classic-mart-seller-analytics.csv"');
  return response.type('text/csv; charset=utf-8').send(rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
}));

export default router;

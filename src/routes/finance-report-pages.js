import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../core/errors.js';
import { financePageGates, renderFinancePage } from '../dashboard/finance-page-view.js';
import { loadFinanceReportPage, streamFinanceReportCsv } from '../services/finance-report-pages.js';

const router = Router();
const exportLimit = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
for (const slug of ['overview', 'reports', 'audit']) {
  const pageId = 'finance-' + slug, path = '/finance/' + slug;
  router.get(path, ...financePageGates(), asyncHandler(async (request, response) => renderFinancePage(request, response, pageId, await loadFinanceReportPage(request, pageId))));
  router.get(path + '/export.csv', ...financePageGates(), exportLimit, asyncHandler(async (request, response) => streamFinanceReportCsv(request, response, pageId)));
}
router.get('/finance/ledger.csv', ...financePageGates(), exportLimit, (request,response) => response.redirect(308, '/finance/reports/export.csv?' + new URLSearchParams({ country: request.financeContext.country, period: request.query.period || request.financeContext.actor.preferences.financeReportingPeriod || '30days', report: 'ledger' })));
export default router;

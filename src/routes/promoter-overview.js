import { Router } from 'express';
import { AppError, asyncHandler } from '../core/errors.js';
import { promoterPageGates, renderPromoterPage } from '../dashboard/promoter-page-view.js';
import { loadPromoterOverview } from '../services/promoter-overview.js';
import { writeAudit } from '../services/audit.js';

const router = Router();
const queryShape = request => {
  const query = new URL(request.originalUrl, 'http://localhost').searchParams;
  if (query.getAll('period').length > 1 || [...query.keys()].some(key => /^period(?:\[|\.)/.test(key))) throw new AppError('Select one supported reporting period.', 422, 'PROMOTER_PERIOD_INVALID');
};
router.get('/promoter/overview', ...promoterPageGates(), asyncHandler(async (request, response) => {
  queryShape(request); return renderPromoterPage(request, response, 'promoter-overview', await loadPromoterOverview(request));
}));
router.get('/promoter/overview/summary.csv', ...promoterPageGates(), asyncHandler(async (request, response) => {
  queryShape(request); const overview = await loadPromoterOverview(request);
  const cell = value => { let text = String(value ?? ''); if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text; return '"' + text.replaceAll('"', '""') + '"'; };
  const rows = [['Country', 'Currency', 'Time zone', 'Period'], [overview.market.country, overview.currency, overview.timeZone, overview.period],
    ['Metric', 'Value'], ...overview.metrics.map(metric => [metric.label, metric.value]), ['Recorded this month minor', overview.monthEarnedMinor],
    ['Period', 'Recorded visits', 'Net commission minor'], ...overview.analytics.trend.map(row => [row.key, row.visits, row.commissionMinor])];
  await writeAudit(request, 'promoter.overview_exported', { targetType: 'user', targetPublicId: request.user.publicId, country: overview.market.country });
  return response.type('text/csv').set('Content-Disposition', 'attachment; filename="classic-mart-promoter-overview.csv"').send(rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n');
}));
export default router;

import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { asyncHandler } from '../core/errors.js';
import { supportPageGates, renderSupportPage } from '../dashboard/support-page-view.js';
import { loadSupportReportPage, streamSupportReportCsv } from '../services/support-report-pages.js';

const router = Router();
const exportLimit = rateLimit({ scope: 'support-report-pages:1', windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
for (const slug of ['overview', 'reports']) {
  const pageId = 'support-' + slug, path = '/support/' + slug;
  router.get(path, ...supportPageGates(), asyncHandler(async (request, response) => renderSupportPage(request, response, pageId, await loadSupportReportPage(request, pageId))));
  router.get(path + '/export.csv', ...supportPageGates(), exportLimit, asyncHandler(async (request, response) => streamSupportReportCsv(request, response, pageId)));
}
export default router;

import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { asyncHandler } from '../core/errors.js';
import { countryAdminPageGates, renderCountryAdminPage } from '../dashboard/country-admin-page-view.js';
import { loadCountryAdminReportPage, streamCountryAdminReportCsv } from '../services/country-admin-report-pages.js';

const router = Router();
const exportLimit = rateLimit({ scope: 'country-admin-report-pages:1', windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
for (const slug of ['overview', 'reports']) {
  const path = '/admin/' + slug, pageId = 'admin-' + slug;
  router.get(path, ...countryAdminPageGates(), asyncHandler(async (request, response) => renderCountryAdminPage(request, response, pageId, await loadCountryAdminReportPage(request, pageId))));
  router.get(path + '/export.csv', ...countryAdminPageGates(), exportLimit, asyncHandler(async (request, response) => streamCountryAdminReportCsv(request, response, pageId)));
}
export default router;

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../core/errors.js';
import { moderationPageGates, renderModerationPage } from '../dashboard/moderation-page-view.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { actModerationQa, loadModerationReportPage, streamModerationReportCsv } from '../services/moderation-report-pages.js';

const router = Router();
const exportLimit = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
const actionLimit = rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
for (const slug of ['overview', 'audit', 'reports']) {
  const pageId = 'moderator-' + slug, path = '/moderation/' + slug;
  router.get(path, ...moderationPageGates(), asyncHandler(async (request, response) => renderModerationPage(request, response, pageId, await loadModerationReportPage(request, pageId))));
  router.get(path + '/export.csv', ...moderationPageGates(), exportLimit, asyncHandler(async (request, response) => streamModerationReportCsv(request, response, pageId)));
}

router.post('/moderation/reports/qa/:publicId/action', ...moderationPageGates(), actionLimit, asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request);
  try {
    const qa = await actModerationQa(request, request.params.publicId, request.body || {});
    if (request.accepts(['html', 'json']) === 'json') return response.json({ qa });
    setFlash(request, 'success', request.body?.action === 'complete' ? qa.outcome === 'escalated' ? 'Quality review completed and a trust investigation opened.' : 'Independent quality review recorded.' : 'Quality review assignment saved.');
    return response.redirect('/moderation/reports?' + new URLSearchParams({ report: 'qa', country: qa.country, record: qa.publicId }));
  } catch (error) {
    const status = error.name === 'ZodError' ? 422 : error.status;
    if (![409, 422].includes(status) || request.accepts(['html', 'json']) === 'json') throw error;
    const reportRequest = Object.create(request);
    Object.defineProperty(reportRequest, 'query', { value: { country: request.query.country, report: 'qa', record: request.params.publicId } });
    const flow = await loadModerationReportPage(reportRequest, 'moderator-reports');
    flow.error = error.name === 'ZodError' ? error.issues.map(issue => issue.message).join(' ') : error.message;
    flow.qaDraft = { note: typeof request.body?.note === 'string' ? request.body.note.slice(0, 1000) : '', outcome: ['upheld', 'coaching', 'escalated'].includes(request.body?.outcome) ? request.body.outcome : '' };
    response.status(status); return renderModerationPage(request, response, 'moderator-reports', flow);
  }
}));
export default router;

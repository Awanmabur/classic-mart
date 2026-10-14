import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { asyncHandler } from '../core/errors.js';
import { moderationPageGates, renderModerationPage } from '../dashboard/moderation-page-view.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { loadModerationSettingsPage, saveModerationSettings, saveModerationProfile, saveModerationCommunication } from '../services/moderation-settings-pages.js';
import { writeAudit } from '../services/audit.js';
import { moderationAccess, assertModerationReadAccess } from '../services/moderation-workspace-access.js';
const router = Router();
const limiter = rateLimit({ scope: 'moderation-settings-pages:1', windowMs: 15 * 60_000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false });
router.get('/moderation/settings', ...moderationPageGates(), asyncHandler(async (request, response) => renderModerationPage(request, response, 'moderator-settings', await loadModerationSettingsPage(request))));
router.get('/moderation/settings/export.csv', ...moderationPageGates(), limiter, asyncHandler(async (request, response) => {
  const original = await moderationAccess(request);
  const flow = await loadModerationSettingsPage(request);
  await assertModerationReadAccess(request, original);
  await writeAudit(request, 'moderation.settings_exported', { targetType: 'moderation_report', country: flow.country || flow.context.countries[0].code });
  await assertModerationReadAccess(request, original);
  const cell = value => { let text = String(value ?? ''); if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text; return '"' + text.replaceAll('"', '""') + '"'; };
  response.type('text/csv').set('Content-Disposition', 'attachment; filename="classic-mart-moderation-settings.csv"')
    .send([flow.columns, ...flow.rows.map(row => row.cells)].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n');
}));
router.post('/moderation/settings', ...moderationPageGates(), limiter, asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request);
  try {
    const preferences = await saveModerationSettings(request, request.body || {});
    if (request.accepts(['html', 'json']) === 'json') return response.json({ preferences });
    setFlash(request, 'success', 'Moderation workspace preferences saved.');
    return response.redirect('/moderation/settings?section=' + (request.body.section === 'payments' ? 'payments' : 'business'));
  } catch (error) {
    const status = error.name === 'ZodError' ? 422 : error.status;
    if (![409, 422].includes(status) || request.accepts(['html', 'json']) === 'json') throw error;
    const flow = await loadModerationSettingsPage(request); flow.section = request.body.section === 'payments' ? 'payments' : 'business';
    flow.error = error.name === 'ZodError' ? error.issues.map(issue => issue.message).join(' ') : error.message;
    flow.draft = { defaultCountry: String(request.body.defaultCountry || '').slice(0, 2), reportingPeriod: String(request.body.reportingPeriod || '').slice(0, 10) };
    response.status(status); return renderModerationPage(request, response, 'moderator-settings', flow);
  }
}));
for (const [action, operation, section] of [['profile', saveModerationProfile, 'profile'], ['communication', saveModerationCommunication, 'notifications']]) {
  router.post('/moderation/settings/' + action, ...moderationPageGates(), limiter, asyncHandler(async (request, response) => {
    verifyDeferredCsrf(request);
    try {
      const result = await operation(request, request.body || {});
      if (request.accepts(['html', 'json']) === 'json') return response.json(result);
      setFlash(request, 'success', section === 'profile' ? 'Moderation profile saved.' : 'Moderation communication preferences saved.');
      return response.redirect('/moderation/settings?section=' + section);
    } catch (error) {
      const status = error.name === 'ZodError' ? 422 : error.status;
      if (![409, 422].includes(status) || request.accepts(['html', 'json']) === 'json') throw error;
      const flow = await loadModerationSettingsPage(request); flow.section = section;
      flow.error = error.name === 'ZodError' ? error.issues.map(issue => issue.message).join(' ') : error.message;
      flow.draft = Object.fromEntries(Object.entries(request.body || {}).filter(([name, value]) => name !== '_csrf' && typeof value === 'string').map(([name, value]) => [name, value.slice(0, 1000)]));
      response.status(status); return renderModerationPage(request, response, 'moderator-settings', flow);
    }
  }));
}
export default router;

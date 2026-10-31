import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { asyncHandler } from '../core/errors.js';
import { supportPageGates, renderSupportPage } from '../dashboard/support-page-view.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { loadSupportSettingsPage, saveSupportSettings, saveSupportProfile, saveSupportCommunication } from '../services/support-settings-pages.js';
import { writeAudit } from '../services/audit.js';
import { supportAccess, assertSupportReadAccess } from '../services/support-workspace-access.js';
const router = Router();
const limiter = rateLimit({ scope: 'support-settings-pages:1', windowMs: 15 * 60_000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false });
router.get('/support/settings', ...supportPageGates(), asyncHandler(async (request, response) => renderSupportPage(request, response, 'support-settings', await loadSupportSettingsPage(request))));
router.get('/support/settings/export.csv', ...supportPageGates(), limiter, asyncHandler(async (request, response) => {
  const original = await supportAccess(request);
  const flow = await loadSupportSettingsPage(request);
  await assertSupportReadAccess(request, original);
  await writeAudit(request, 'support.settings_exported', { targetType: 'support_report', country: flow.country || flow.context.countries[0].code });
  const cell = value => { let text = String(value ?? ''); if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text; return '"' + text.replaceAll('"', '""') + '"'; };
  response.type('text/csv').set('Content-Disposition', 'attachment; filename="classic-mart-support-settings.csv"')
    .send([flow.columns, ...flow.rows.map(row => row.cells)].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n');
}));
router.post('/support/settings', ...supportPageGates(), limiter, asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request);
  try {
    const preferences = await saveSupportSettings(request, request.body || {});
    if (request.accepts(['html', 'json']) === 'json') return response.json({ preferences });
    setFlash(request, 'success', 'Support report preferences saved.');
    return response.redirect('/support/settings?section=' + (request.body.section === 'payments' ? 'payments' : 'business'));
  } catch (error) {
    const status = error.name === 'ZodError' ? 422 : error.status;
    if (![409, 422].includes(status) || request.accepts(['html', 'json']) === 'json') throw error;
    const flow = await loadSupportSettingsPage(request); flow.section = request.body.section === 'payments' ? 'payments' : 'business';
    flow.error = error.name === 'ZodError' ? error.issues.map(issue => issue.message).join(' ') : error.message;
    flow.draft = { defaultCountry: String(request.body.defaultCountry || '').slice(0, 2), reportingPeriod: String(request.body.reportingPeriod || '').slice(0, 10) };
    response.status(status); return renderSupportPage(request, response, 'support-settings', flow);
  }
}));
for (const [action, operation, section] of [['profile', saveSupportProfile, 'profile'], ['communication', saveSupportCommunication, 'notifications']]) {
  router.post('/support/settings/' + action, ...supportPageGates(), limiter, asyncHandler(async (request, response) => {
    verifyDeferredCsrf(request);
    try {
      const result = await operation(request, request.body || {});
      if (request.accepts(['html', 'json']) === 'json') return response.json(result);
      setFlash(request, 'success', section === 'profile' ? 'Support profile saved.' : 'Support communication preferences saved.');
      return response.redirect('/support/settings?section=' + section);
    } catch (error) {
      const status = error.name === 'ZodError' ? 422 : error.status;
      if (![409, 422].includes(status) || request.accepts(['html', 'json']) === 'json') throw error;
      const flow = await loadSupportSettingsPage(request); flow.section = section;
      flow.error = error.name === 'ZodError' ? error.issues.map(issue => issue.message).join(' ') : error.message;
      flow.draft = Object.fromEntries(Object.entries(request.body || {}).filter(([name, value]) => name !== '_csrf' && typeof value === 'string').map(([name, value]) => [name, value.slice(0, 1000)]));
      response.status(status); return renderSupportPage(request, response, 'support-settings', flow);
    }
  }));
}
export default router;

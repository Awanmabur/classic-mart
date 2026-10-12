import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../core/errors.js';
import { financePageGates, renderFinancePage } from '../dashboard/finance-page-view.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { loadFinanceSettingsPage, saveFinanceSettings, saveFinanceProfile, saveFinanceCommunication } from '../services/finance-settings-pages.js';
import { writeAudit } from '../services/audit.js';
import { financeAccess, assertFinanceExportAccess } from '../services/finance-workspace-access.js';
const router = Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false });
router.get('/finance/settings', ...financePageGates(), asyncHandler(async (request, response) => renderFinancePage(request, response, 'finance-settings', await loadFinanceSettingsPage(request))));
router.get('/finance/settings/export.csv', ...financePageGates(), limiter, asyncHandler(async (request, response) => {
  const original = await financeAccess(request);
  const flow = await loadFinanceSettingsPage(request);
  await assertFinanceExportAccess(request, original);
  await writeAudit(request, 'finance.settings_exported', { targetType: 'finance_report', country: flow.country || flow.context.countries[0].code });
  const cell = value => { let text = String(value ?? ''); if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text; return '"' + text.replaceAll('"', '""') + '"'; };
  response.type('text/csv').set('Content-Disposition', 'attachment; filename="classic-mart-finance-settings.csv"')
    .send([flow.columns, ...flow.rows.map(row => row.cells)].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n');
}));
router.post('/finance/settings', ...financePageGates(), limiter, asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request);
  try {
    const preferences = await saveFinanceSettings(request, request.body || {});
    if (request.accepts(['html', 'json']) === 'json') return response.json({ preferences });
    setFlash(request, 'success', 'Finance report preferences saved.');
    return response.redirect('/finance/settings?section=business');
  } catch (error) {
    const status = error.name === 'ZodError' ? 422 : error.status;
    if (![409, 422].includes(status) || request.accepts(['html', 'json']) === 'json') throw error;
    const flow = await loadFinanceSettingsPage(request); flow.section = 'business';
    flow.error = error.name === 'ZodError' ? error.issues.map(issue => issue.message).join(' ') : error.message;
    flow.draft = { defaultCountry: String(request.body.defaultCountry || '').slice(0, 2), reportingPeriod: String(request.body.reportingPeriod || '').slice(0, 10) };
    response.status(status); return renderFinancePage(request, response, 'finance-settings', flow);
  }
}));
for (const [action, operation, section] of [['profile', saveFinanceProfile, 'profile'], ['communication', saveFinanceCommunication, 'notifications']]) {
  router.post('/finance/settings/' + action, ...financePageGates(), limiter, asyncHandler(async (request, response) => {
    verifyDeferredCsrf(request);
    try {
      const result = await operation(request, request.body || {});
      if (request.accepts(['html', 'json']) === 'json') return response.json(result);
      setFlash(request, 'success', section === 'profile' ? 'Finance profile saved.' : 'Finance communication preferences saved.');
      return response.redirect('/finance/settings?section=' + section);
    } catch (error) {
      const status = error.name === 'ZodError' ? 422 : error.status;
      if (![409, 422].includes(status) || request.accepts(['html', 'json']) === 'json') throw error;
      const flow = await loadFinanceSettingsPage(request); flow.section = section;
      flow.error = error.name === 'ZodError' ? error.issues.map(issue => issue.message).join(' ') : error.message;
      flow.draft = Object.fromEntries(Object.entries(request.body || {}).filter(([name, value]) => name !== '_csrf' && typeof value === 'string').map(([name, value]) => [name, value.slice(0, 1000)]));
      response.status(status); return renderFinancePage(request, response, 'finance-settings', flow);
    }
  }));
}
export default router;

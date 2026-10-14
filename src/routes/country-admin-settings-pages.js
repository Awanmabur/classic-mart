import { Router } from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../core/errors.js';
import { countryAdminPageGates, renderCountryAdminPage } from '../dashboard/country-admin-page-view.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { loadCountryAdminSettingsPage, saveCountryAdminSettings, saveCountryAdminProfile, saveCountryAdminCommunication } from '../services/country-admin-settings-pages.js';
import { writeAudit } from '../services/audit.js';
import { countryAdminAccess, assertCountryAdminReadAccess, fenceCountryAdminAccess } from '../services/country-admin-workspace-access.js';
const router = Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false });
const currentScopeQuery = request => typeof request.query?.country === 'string' ? { country: request.query.country } : {};
router.get('/admin/settings', ...countryAdminPageGates(), asyncHandler(async (request, response) => renderCountryAdminPage(request, response, 'admin-settings', await loadCountryAdminSettingsPage(request))));
router.get('/admin/settings/export.csv', ...countryAdminPageGates(), limiter, asyncHandler(async (request, response) => {
  const original = await countryAdminAccess(request);
  const flow = await loadCountryAdminSettingsPage(request);
  await assertCountryAdminReadAccess(request, original);
  const session=await mongoose.startSession();
  try { await session.withTransaction(async()=>{const current=await countryAdminAccess(request,{session,country:original.country});await fenceCountryAdminAccess(current,session);await writeAudit(request, 'country_admin.settings_exported', { session,actor:current.actor,targetType: 'country_admin_export', country: flow.country || flow.context.countries[0].code,metadata:{pageId:'admin-settings'} });}); }finally{await session.endSession();}
  await assertCountryAdminReadAccess(request, original);
  const cell = value => { let text = String(value ?? ''); if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text; return '"' + text.replaceAll('"', '""') + '"'; };
  response.type('text/csv').set('Content-Disposition', 'attachment; filename="classic-mart-country-admin-settings.csv"')
    .send([flow.columns, ...flow.rows.map(row => row.cells)].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n');
}));
router.post('/admin/settings', ...countryAdminPageGates(), limiter, asyncHandler(async (request, response) => {
  verifyDeferredCsrf(request);
  try {
    const preferences = await saveCountryAdminSettings(request, request.body || {});
    if (request.accepts(['html', 'json']) === 'json') return response.json({ preferences });
    setFlash(request, 'success', 'Country Admin workspace preferences saved.');
    return response.redirect(303,'/admin/settings?' + new URLSearchParams({section:request.body.section === 'payments' ? 'payments' : 'business',...currentScopeQuery(request)}));
  } catch (error) {
    const status = error.name === 'ZodError' ? 422 : error.status;
    if (![409, 422].includes(status) || request.accepts(['html', 'json']) === 'json') throw error;
    const flow = await loadCountryAdminSettingsPage(request); flow.section = request.body.section === 'payments' ? 'payments' : 'business';
    flow.error = error.name === 'ZodError' ? error.issues.map(issue => issue.message).join(' ') : error.message;
    flow.draft = Object.fromEntries(['defaultCountry','reportingPeriod','landingPage','density','idleReminderMinutes'].filter(key=>typeof request.body[key] === 'string').map(key=>[key,request.body[key].slice(0,100)]));
    response.status(status); return renderCountryAdminPage(request, response, 'admin-settings', flow);
  }
}));
for (const [action, operation, section] of [['profile', saveCountryAdminProfile, 'profile'], ['communication', saveCountryAdminCommunication, 'notifications']]) {
  router.post('/admin/settings/' + action, ...countryAdminPageGates(), limiter, asyncHandler(async (request, response) => {
    verifyDeferredCsrf(request);
    try {
      const result = await operation(request, request.body || {});
      if (request.accepts(['html', 'json']) === 'json') return response.json(result);
      setFlash(request, 'success', section === 'profile' ? 'Country Admin profile saved.' : 'Country Admin communication preferences saved.');
      return response.redirect(303,'/admin/settings?' + new URLSearchParams({section,...currentScopeQuery(request)}));
    } catch (error) {
      const status = error.name === 'ZodError' ? 422 : error.status;
      if (![409, 422].includes(status) || request.accepts(['html', 'json']) === 'json') throw error;
      const flow = await loadCountryAdminSettingsPage(request); flow.section = section;
      flow.error = error.name === 'ZodError' ? error.issues.map(issue => issue.message).join(' ') : error.message;
      flow.draft = Object.fromEntries(Object.entries(request.body || {}).filter(([name, value]) => name !== '_csrf' && typeof value === 'string').map(([name, value]) => [name, value.slice(0, 1000)]));
      response.status(status); return renderCountryAdminPage(request, response, 'admin-settings', flow);
    }
  }));
}
export default router;

import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { asyncHandler } from '../core/errors.js';
import { countryAdminPageGates, renderCountryAdminPage } from '../dashboard/country-admin-page-view.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { loadCountryAdminSupportPage, countryAdminSupportAction, streamCountryAdminSupportCsv } from '../services/country-admin-support-pages.js';

const router = Router(), base = '/admin/support';
const writes = rateLimit({ scope: 'country-admin-support-pages:1', windowMs: 15 * 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
const exports = rateLimit({ scope: 'country-admin-support-pages:2', windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
async function page(request, response, error = '') {
  const flow = await loadCountryAdminSupportPage(request); flow.error = error;
  flow.draft = error ? Object.fromEntries(['message', 'recipient', 'priority', 'queue', 'status', 'internal'].filter(key => typeof request.body?.[key] === 'string')
    .map(key => [key, request.body[key].slice(0, key === 'message' ? 2000 : 100)])) : {};
  return renderCountryAdminPage(request, response, 'admin-support', flow);
}
router.get(base, ...countryAdminPageGates(), asyncHandler((req, res) => page(req, res)));
router.get(base + '/export.csv', ...countryAdminPageGates(), exports, asyncHandler(streamCountryAdminSupportCsv));
router.get(base + '/:publicId', ...countryAdminPageGates(), asyncHandler((req, res) => page(req, res)));
for (const action of ['action', 'claim', 'release', 'transfer', 'update', 'reply', 'status', 'resolve', 'reopen']) {
  router.post(base + '/:publicId/' + action, ...countryAdminPageGates(), writes, asyncHandler(async (req, res) => {
    verifyDeferredCsrf(req);
    try {
      const ticket = await countryAdminSupportAction(req, action === 'action' ? req.body?.action : action);
      if (req.accepts(['html', 'json']) === 'json') return res.json({ ticket });
      setFlash(req, 'success', 'The support conversation and its next step were saved.');
      return res.redirect(303, base + '/' + encodeURIComponent(ticket.publicId) + '?country=' + encodeURIComponent(ticket.country));
    } catch (error) {
      const status = error.name === 'ZodError' ? 422 : error.status;
      if (![409, 422].includes(status) || req.accepts(['html', 'json']) === 'json') throw error;
      res.status(status); return page(req, res, error.name === 'ZodError' ? error.issues.map(issue => issue.message).join(' ') : error.message);
    }
  }));
}
export default router;

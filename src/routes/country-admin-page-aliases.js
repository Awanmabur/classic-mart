import { Router } from 'express';
import { noStore } from '../middleware/request.js';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { countryAdminPageGates } from '../dashboard/country-admin-page-view.js';
import { dashboardLanding } from '../dashboard/landing.js';
import { COUNTRY_ADMIN_LIVE_ROUTES } from '../dashboard/country-admin-routes.js';
const router = Router();
for (const [id, href] of Object.entries(COUNTRY_ADMIN_LIVE_ROUTES)) router.get('/dashboard/' + id, noStore, requireAuth, requireVerified, requireOnboarding,
  (request, response) => response.redirect(308, href + new URL(request.originalUrl, 'http://localhost').search));
router.get('/admin', ...countryAdminPageGates(), (request, response) => response.redirect(dashboardLanding(request.countryAdminContext.actor)));
export default router;

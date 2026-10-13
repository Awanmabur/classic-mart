import { Router } from 'express';
import { noStore } from '../middleware/request.js';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { moderationPageGates } from '../dashboard/moderation-page-view.js';
import { dashboardLanding } from '../dashboard/landing.js';
import { MODERATION_LIVE_ROUTES } from '../dashboard/moderation-routes.js';
const router = Router();
for (const [id, href] of Object.entries(MODERATION_LIVE_ROUTES)) router.get('/dashboard/' + id, noStore, requireAuth, requireVerified, requireOnboarding,
  (request, response) => response.redirect(308, href + new URL(request.originalUrl, 'http://localhost').search));
router.get('/moderation', ...moderationPageGates(), (request, response) => response.redirect(dashboardLanding(request.moderationContext.actor)));
export default router;

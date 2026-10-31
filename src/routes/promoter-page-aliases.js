import { Router } from 'express';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { PROMOTER_LIVE_ROUTES } from '../dashboard/promoter-routes.js';
const router = Router();
for (const [id, path] of Object.entries(PROMOTER_LIVE_ROUTES)) router.get('/dashboard/' + id, noStore, requireAuth, requireVerified, requireOnboarding,
  (request, response) => response.redirect(308, path + new URL(request.originalUrl, 'http://localhost').search));
export default router;

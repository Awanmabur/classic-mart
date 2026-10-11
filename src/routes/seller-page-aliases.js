import { Router } from 'express';
import { noStore } from '../middleware/request.js';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { SELLER_LIVE_ROUTES } from '../dashboard/seller-routes.js';

const router = Router();
for (const [id, href] of Object.entries(SELLER_LIVE_ROUTES)) {
  router.get('/dashboard/' + id, noStore, requireAuth, requireVerified, requireOnboarding, (request, response) =>
    response.redirect(308, href + new URL(request.originalUrl, 'http://localhost').search));
}
export default router;

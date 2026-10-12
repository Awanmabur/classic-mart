import { Router } from 'express';
import { noStore } from '../middleware/request.js';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { financePageGates } from '../dashboard/finance-page-view.js';
import { FINANCE_LIVE_ROUTES } from '../dashboard/finance-routes.js';
const router = Router();
for (const [id, href] of Object.entries(FINANCE_LIVE_ROUTES)) router.get('/dashboard/' + id, noStore, requireAuth, requireVerified, requireOnboarding,
  (request, response) => response.redirect(308, href + new URL(request.originalUrl, 'http://localhost').search));
router.get('/finance', ...financePageGates(), (_request, response) => response.redirect(302, '/finance/overview'));
export default router;

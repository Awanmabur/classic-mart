import { Router } from 'express';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { allowedWorkspacesFor, workspaceForPage } from '../dashboard/access.js';
import { dashboardLanding } from '../dashboard/landing.js';
import { pageWorkspace, routeForPage, defaultPageFor } from '../dashboard/registry.js';
import { AppError, asyncHandler } from '../core/errors.js';
import { env } from '../config/env.js';
import { customerView } from '../dashboard/customer-view.js';

const router = Router();
const privateDashboard = (_request, response, next) => {
  response.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  next();
};
const gates = [noStore, privateDashboard, requireAuth, requireVerified, requireOnboarding];
router.get('/dashboard', ...gates, (request, response) => response.redirect(dashboardLanding(request.user)));
router.get('/dashboard/:page', ...gates, asyncHandler(async (request, response, next) => {
  const page = request.params.page;
  if (!pageWorkspace(page)) return next(new AppError('Dashboard page not found.', 404, 'DASHBOARD_PAGE_NOT_FOUND'));
  const workspace = workspaceForPage(request.user, page);
  if (!workspace) return next(new AppError('You do not have access to this dashboard.', 403, 'DASHBOARD_FORBIDDEN'));
  if (workspace !== 'customer' && env.isProduction) return next(new AppError('This dashboard is not connected to live operations yet.', 503, 'DASHBOARD_NOT_CONNECTED'));
  return response.render('approved-dashboard', {
    workspace, initialPage: page, allowedWorkspaces: allowedWorkspacesFor(request.user),
    ...(workspace === 'customer' ? await customerView(request, page) : {}),
  });
}));

const aliases = {
  '/seller': 'seller', '/promoter': 'promoter', '/admin': 'admin',
  '/super-admin': 'superadmin', '/finance': 'finance', '/operations/support': 'support',
  '/operations/logistics': 'warehouse', '/warehouse': 'warehouse',
  '/moderation': 'moderator', '/business': 'business', '/account': 'customer',
};
for (const [path, workspace] of Object.entries(aliases)) {
  router.get(path, ...gates, (request, response, next) => {
    const page = defaultPageFor(workspace);
    if (!workspaceForPage(request.user, page)) return next(new AppError('You do not have access to this dashboard.', 403, 'DASHBOARD_FORBIDDEN'));
    return response.redirect(routeForPage(page));
  });
}
export default router;

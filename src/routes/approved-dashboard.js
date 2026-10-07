import { Router } from 'express';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { allowedWorkspacesFor, workspaceForPage } from '../dashboard/access.js';
import { dashboardLanding } from '../dashboard/landing.js';
import { pageWorkspace, routeForPage, defaultPageFor } from '../dashboard/registry.js';
import { AppError, asyncHandler } from '../core/errors.js';
import { env } from '../config/env.js';
import { CUSTOMER_ROUTES, PUBLIC_CUSTOMER_PAGES } from '../dashboard/customer-routes.js';
import { customerView } from '../dashboard/customer-view.js';

const router = Router();
const privateDashboard = (_request, response, next) => {
  response.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  next();
};
const gates = [noStore, privateDashboard, requireAuth, requireVerified, requireOnboarding];
async function renderPage(request, response, page) {
  const workspace = workspaceForPage(request.user, page);
  if (!workspace) throw new AppError('You do not have access to this dashboard.', 403, 'DASHBOARD_FORBIDDEN');
  if (workspace !== 'customer' && (workspace === 'seller' || env.isProduction)) throw new AppError('This dashboard is not connected to live operations yet.', 503, 'DASHBOARD_NOT_CONNECTED');
  return response.render('approved-dashboard', {
    workspace, initialPage: page, allowedWorkspaces: allowedWorkspacesFor(request.user),
    ...(workspace === 'customer' ? await customerView(request, page) : {}),
  });
}
for (const [page, path] of Object.entries(CUSTOMER_ROUTES)) {
  router.get(path, (request, _response, next) => {
    // Existing guest catalogue, cart and return-policy routes remain public.
    if (!request.user && PUBLIC_CUSTOMER_PAGES.has(page)) return next('route');
    return next();
  }, ...gates, asyncHandler(async (request, response) => {
    if (page === 'dashboard') {
      const landing = dashboardLanding(request.user);
      if (landing !== path) return response.redirect(landing);
    }
    return renderPage(request, response, page);
  }));
}
router.get('/dashboard/:page', ...gates, asyncHandler(async (request, response, next) => {
  const page = request.params.page;
  if (!pageWorkspace(page)) return next(new AppError('Dashboard page not found.', 404, 'DASHBOARD_PAGE_NOT_FOUND'));
  if (CUSTOMER_ROUTES[page]) {
    const search = new URL(request.originalUrl, 'http://localhost').search;
    return response.redirect(308, CUSTOMER_ROUTES[page] + search);
  }
  return renderPage(request, response, page);
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

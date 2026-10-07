import { AppError } from '../core/errors.js';
import { DASHBOARD_PAGES, DASHBOARD_WORKSPACES, pageDefinition, routeForPage } from './registry.js';
import { customerView } from './customer-view.js';
import { workspaceForPage } from './access.js';
import { loadDashboardNavigationState, loadDashboardPageData } from './data.js';

function visibleDashboardPages(workspace, pages, dashboardData) {
  if (workspace !== 'seller') return pages;
  if (dashboardData?.access?.canAnalytics) return pages;
  return pages.filter((page) => page[0] !== 'seller-analytics');
}


export async function renderDashboardPage(request, response, pageId) {
  const workspace = workspaceForPage(request.user, pageId);
  if (!workspace) throw new AppError('You do not have access to this dashboard page.', 403, 'DASHBOARD_FORBIDDEN');
  const page = pageDefinition(workspace, pageId);
  if (!page) throw new AppError('Dashboard page not found.', 404, 'DASHBOARD_PAGE_NOT_FOUND');

  const [dashboardData, dashboardNav] = await Promise.all([
    loadDashboardPageData({ request, workspace, pageId }),
    loadDashboardNavigationState({ request, workspace }),
  ]);
  response.set('Cache-Control', 'private, no-store');
  return response.render('approved-dashboard', {
    workspace, initialPage: pageId, allowedWorkspaces: [workspace],
    ...(workspace === 'customer' ? await customerView(request, pageId) : {}),
    requestedWorkspace: workspace,
    requestedPage: pageId,
    dashboardPage: {
      id: page[0], label: page[1], icon: page[2], group: page[3], title: page[4], description: page[5], kind: page[6],
    },
    dashboardWorkspace: DASHBOARD_WORKSPACES[workspace],
    dashboardPages: visibleDashboardPages(workspace, DASHBOARD_PAGES[workspace] || [], dashboardData),
    dashboardData,
    dashboardNav,
    routeForPage,
  });
}

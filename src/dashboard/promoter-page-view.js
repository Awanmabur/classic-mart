import { AppError } from '../core/errors.js';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { promoterAccess } from '../services/promoter-workspace-access.js';
import { DASHBOARD_PAGES } from './registry.js';
import { PROMOTER_LIVE_ROUTES } from './promoter-routes.js';
import { liveSellerAccountHeader } from './live-account-header.js';
import { loadPromoterSidebar } from '../services/promoter-overview.js';

export function promoterNavigation() {
  return DASHBOARD_PAGES.promoter.map(([id, label, icon, group]) => ({ id, label, icon, group, href: PROMOTER_LIVE_ROUTES[id], ready: Boolean(PROMOTER_LIVE_ROUTES[id]) }));
}
const privatePage = (_request, response, next) => { response.set('X-Robots-Tag', 'noindex, nofollow, noarchive'); next(); };
const loadPromoter = async (request, _response, next) => {
  try { request.promoterContext = await promoterAccess(request); next(); } catch (error) { next(error); }
};
export function promoterPageGates() { return [noStore, privatePage, requireAuth, requireVerified, requireOnboarding, loadPromoter]; }

export async function renderPromoterPage(request, response, pageId, promoterFlow) {
  const page = DASHBOARD_PAGES.promoter.find(([id]) => id === pageId);
  if (!page) throw new AppError('Promoter page not found.', 404, 'PROMOTER_PAGE_NOT_FOUND');
  if (request.accepts(['html', 'json']) === 'json') return response.json(promoterFlow);
  const context = await promoterAccess(request);
  const [header, sidebar] = await Promise.all([
    liveSellerAccountHeader(request),
    promoterFlow.monthEarnedMinor !== undefined && promoterFlow.activeCampaigns !== undefined
      ? { monthEarnedMinor: promoterFlow.monthEarnedMinor, activeCampaigns: promoterFlow.activeCampaigns }
      : loadPromoterSidebar(context),
  ]);
  return response.render('approved-dashboard', {
    ...header, workspace: 'promoter', initialPage: pageId, allowedWorkspaces: ['promoter'],
    customerRoutes: { ...header.customerRoutes, ...PROMOTER_LIVE_ROUTES, profile: '/promoter/profile', dashboard: '/promoter/overview' },
    promoterFlow, pageFlow: promoterFlow, promoterPage: { id: pageId, label: page[1], eyebrow: page[3], title: page[4], description: page[5], kind: page[6], href: PROMOTER_LIVE_ROUTES[pageId] },
    livePromoter: { profileRole: 'Promoter', navigation: promoterNavigation(), market: context.market, verificationStatus: context.verification?.status || 'draft',
      domainFlow: promoterFlow, profileFlow: pageId === 'promoter-profile' ? promoterFlow : undefined,
      monthEarnedMinor: sidebar.monthEarnedMinor, activeCampaigns: sidebar.activeCampaigns },
  });
}

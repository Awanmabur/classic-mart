import { AppError } from '../core/errors.js';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { assertFinanceExportAccess, financeAccess, financePublicContext } from '../services/finance-workspace-access.js';
import { DASHBOARD_PAGES } from './registry.js';
import { FINANCE_LIVE_ROUTES } from './finance-routes.js';
import { liveSellerAccountHeader } from './live-account-header.js';
import { loadFinanceSidebar } from '../services/finance-report-pages.js';

export function financeNavigation() {
  return DASHBOARD_PAGES.finance.map(([id, label, icon, group]) => ({ id, label, icon, group, href: FINANCE_LIVE_ROUTES[id], ready: true }));
}
export function financePageGates() {
  return [noStore, (_request, response, next) => { response.set('X-Robots-Tag', 'noindex, nofollow, noarchive'); next(); },
    requireAuth, requireVerified, requireOnboarding, async (request, _response, next) => {
      try {
        const params = new URL(request.originalUrl, 'http://localhost').searchParams;
        for (const name of params.keys()) if (params.getAll(name).length > 1 || /[.\[\]]/.test(name)) throw new AppError('Provide one supported value for each Finance filter.', 422, 'FINANCE_FILTER_INVALID');
        request.financeContext = await financeAccess(request); next();
      } catch (error) { next(error); }
    }];
}
export async function renderFinancePage(request, response, pageId, financeFlow) {
  const page = DASHBOARD_PAGES.finance.find(row => row[0] === pageId);
  if (!page) throw new AppError('Finance page not found.', 404, 'FINANCE_PAGE_NOT_FOUND');
  const context = request.financeContext ? await assertFinanceExportAccess(request, request.financeContext) : await financeAccess(request);
  const snapshot = financeFlow.context || financeFlow;
  const originalCountries = snapshot.countries || financeFlow.countries;
  if (snapshot.country !== context.country || !Array.isArray(originalCountries)
    || originalCountries.length !== context.countries.length
    || originalCountries.some(row => !context.countries.some(current => current.code === row.code
      && (!row.currency || row.currency === current.currency) && (!row.timeZone || row.timeZone === current.timeZone)))) {
    throw new AppError('Your Finance scope changed while this page loaded. Reload it.', 403, 'FINANCE_SCOPE_CHANGED');
  }
  financeFlow.context = financePublicContext(context);
  if (request.accepts(['html', 'json']) === 'json') return response.json(financeFlow);
  const [header, sidebar] = await Promise.all([liveSellerAccountHeader(request), financeFlow.sidebar || loadFinanceSidebar(context)]);
  return response.render('approved-dashboard', {
    ...header, workspace: 'finance', initialPage: pageId, allowedWorkspaces: ['finance'],
    customerRoutes: { ...header.customerRoutes, ...FINANCE_LIVE_ROUTES, dashboard: '/finance/overview', profile: '/finance/settings' },
    financeFlow, pageFlow: financeFlow,
    financePage: { id: pageId, label: page[1], eyebrow: page[3], title: page[4], description: page[5], kind: page[6], href: FINANCE_LIVE_ROUTES[pageId] },
    liveFinance: { profileRole: 'Finance Operator', navigation: financeNavigation(), market: context.market, country: context.country,
      domainFlow: financeFlow, context: financePublicContext(context), sidebar },
  });
}

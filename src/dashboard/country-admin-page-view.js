import { AppError } from '../core/errors.js';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { assertCountryAdminReadAccess, countryAdminAccess, countryAdminPublicContext } from '../services/country-admin-workspace-access.js';
import { DASHBOARD_PAGES } from './registry.js';
import { COUNTRY_ADMIN_LIVE_ROUTES } from './country-admin-routes.js';
import { liveSellerAccountHeader } from './live-account-header.js';
import { loadCountryAdminSidebar } from '../services/country-admin-report-pages.js';

export function countryAdminNavigation() {
  return DASHBOARD_PAGES.admin.map(([id, label, icon, group]) => ({ id, label, icon, group, href: COUNTRY_ADMIN_LIVE_ROUTES[id], ready: true }));
}
export function countryAdminPageGates() {
  return [noStore, (_request, response, next) => { response.set('X-Robots-Tag', 'noindex, nofollow, noarchive'); next(); },
    requireAuth, requireVerified, requireOnboarding, async (request, _response, next) => {
      try {
        const params = new URL(request.originalUrl, 'http://localhost').searchParams;
        for (const name of params.keys()) if (params.getAll(name).length > 1 || /[.\[\]]/.test(name)) throw new AppError('Provide one value for each Country Admin filter.', 422, 'COUNTRY_ADMIN_FILTER_INVALID');
        request.countryAdminContext = await countryAdminAccess(request); next();
      } catch (error) { next(error); }
    }];
}
export async function renderCountryAdminPage(request, response, pageId, countryAdminFlow) {
  const page = DASHBOARD_PAGES.admin.find(row => row[0] === pageId);
  if (!page) throw new AppError('Country Admin page not found.', 404, 'COUNTRY_ADMIN_PAGE_NOT_FOUND');
  const context = request.countryAdminContext ? await assertCountryAdminReadAccess(request, request.countryAdminContext) : await countryAdminAccess(request);
  const snapshot = countryAdminFlow.context || countryAdminFlow;
  const originalCountries = snapshot.countries || countryAdminFlow.countries;
  if (snapshot.country !== context.country || !Array.isArray(originalCountries)
    || originalCountries.length !== context.countries.length
    || originalCountries.some(row => !context.countries.some(current => current.code === row.code
      && (!row.currency || row.currency === current.currency) && (!row.timeZone || row.timeZone === current.timeZone)))) {
    throw new AppError('Your Country Admin scope changed while this page loaded. Reload it.', 403, 'COUNTRY_ADMIN_SCOPE_CHANGED');
  }
  countryAdminFlow.context = countryAdminPublicContext(context);
  if (request.accepts(['html', 'json']) === 'json') {
    return response.json(countryAdminFlow);
  }
  const [header, sidebar] = await Promise.all([liveSellerAccountHeader(request), countryAdminFlow.sidebar || loadCountryAdminSidebar(context)]);
  await assertCountryAdminReadAccess(request, context);
  return response.render('approved-dashboard', {
    ...header, workspace: 'admin', initialPage: pageId, allowedWorkspaces: ['admin'],
    customerRoutes: { ...header.customerRoutes, ...Object.fromEntries(Object.entries(COUNTRY_ADMIN_LIVE_ROUTES).map(([id, href]) => [id, href + (context.country ? '?country=' + context.country : '')])), dashboard: '/admin/overview' + (context.country ? '?country=' + context.country : ''), profile: '/admin/settings' + (context.country ? '?country=' + context.country : '') },
    countryAdminFlow, adminFlow: countryAdminFlow, pageFlow: countryAdminFlow,
    formatDate: value => value ? new Intl.DateTimeFormat(context.actor.locale || 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: context.timeZone }).format(new Date(value)) : '—',
    adminPage: { id: pageId, label: page[1], eyebrow: page[3], title: page[4], description: page[5], kind: page[6], href: COUNTRY_ADMIN_LIVE_ROUTES[pageId] },
    liveAdmin: { profileRole: 'Admin', navigation: countryAdminNavigation(), market: context.market, country: context.country, preferences: { density: context.actor.preferences?.countryAdminDensity || 'comfortable', idleReminderMinutes: context.actor.preferences?.countryAdminIdleReminderMinutes || 30 },
      domainFlow: countryAdminFlow, context: countryAdminPublicContext(context), sidebar },
  });
}

import { AppError } from '../core/errors.js';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { assertSupportReadAccess, supportAccess, supportPublicContext } from '../services/support-workspace-access.js';
import { DASHBOARD_PAGES } from './registry.js';
import { SUPPORT_LIVE_ROUTES } from './support-routes.js';
import { liveSellerAccountHeader } from './live-account-header.js';
import { loadSupportSidebar } from '../services/support-report-pages.js';
import { assertSupportContactDisclosure } from '../services/support-context-pages.js';

export function supportNavigation() {
  return DASHBOARD_PAGES.support.map(([id, label, icon, group]) => ({ id, label, icon, group, href: SUPPORT_LIVE_ROUTES[id], ready: true }));
}
export function supportPageGates() {
  return [noStore, (_request, response, next) => { response.set('X-Robots-Tag', 'noindex, nofollow, noarchive'); next(); },
    requireAuth, requireVerified, requireOnboarding, async (request, _response, next) => {
      try {
        const params = new URL(request.originalUrl, 'http://localhost').searchParams;
        for (const name of params.keys()) if (params.getAll(name).length > 1 || /[.\[\]]/.test(name)) throw new AppError('Provide one supported value for each Support filter.', 422, 'SUPPORT_FILTER_INVALID');
        request.supportContext = await supportAccess(request); next();
      } catch (error) { next(error); }
    }];
}
export async function renderSupportPage(request, response, pageId, supportFlow) {
  const page = DASHBOARD_PAGES.support.find(row => row[0] === pageId);
  if (!page) throw new AppError('Support page not found.', 404, 'SUPPORT_PAGE_NOT_FOUND');
  const context = request.supportContext ? await assertSupportReadAccess(request, request.supportContext) : await supportAccess(request);
  const snapshot = supportFlow.context || supportFlow;
  const originalCountries = snapshot.countries || supportFlow.countries;
  if (snapshot.country !== context.country || !Array.isArray(originalCountries)
    || originalCountries.length !== context.countries.length
    || originalCountries.some(row => !context.countries.some(current => current.code === row.code
      && (!row.currency || row.currency === current.currency) && (!row.timeZone || row.timeZone === current.timeZone)))) {
    throw new AppError('Your Support scope changed while this page loaded. Reload it.', 403, 'SUPPORT_SCOPE_CHANGED');
  }
  supportFlow.context = supportPublicContext(context);
  if (request.accepts(['html', 'json']) === 'json') {
    if (supportFlow.contactDisclosure) await assertSupportContactDisclosure(request, context, supportFlow.contactDisclosure);
    return response.json(supportFlow);
  }
  const [header, sidebar] = await Promise.all([liveSellerAccountHeader(request), supportFlow.sidebar || loadSupportSidebar(context)]);
  await assertSupportReadAccess(request, context);
  if (supportFlow.contactDisclosure) await assertSupportContactDisclosure(request, context, supportFlow.contactDisclosure);
  return response.render('approved-dashboard', {
    ...header, workspace: 'support', initialPage: pageId, allowedWorkspaces: ['support'],
    customerRoutes: { ...header.customerRoutes, ...SUPPORT_LIVE_ROUTES, dashboard: '/support/overview', profile: '/support/settings' },
    supportFlow, pageFlow: supportFlow,
    formatDate: value => value ? new Intl.DateTimeFormat(context.actor.locale || 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: context.timeZone }).format(new Date(value)) : '—',
    supportPage: { id: pageId, label: page[1], eyebrow: page[3], title: page[4], description: page[5], kind: page[6], href: SUPPORT_LIVE_ROUTES[pageId] },
    liveSupport: { profileRole: 'Support Operator', navigation: supportNavigation(), market: context.market, country: context.country, preferences: { density: context.actor.preferences?.supportDensity || 'comfortable', idleReminderMinutes: context.actor.preferences?.supportIdleReminderMinutes || 30 },
      domainFlow: supportFlow, context: supportPublicContext(context), sidebar },
  });
}

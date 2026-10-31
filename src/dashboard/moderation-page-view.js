import { AppError } from '../core/errors.js';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { assertModerationReadAccess, moderationAccess, moderationPublicContext } from '../services/moderation-workspace-access.js';
import { DASHBOARD_PAGES } from './registry.js';
import { MODERATION_LIVE_ROUTES } from './moderation-routes.js';
import { liveSellerAccountHeader } from './live-account-header.js';
import { loadModerationSidebar } from '../services/moderation-report-pages.js';

export function moderationNavigation() {
  return DASHBOARD_PAGES.moderator.map(([id, label, icon, group]) => ({ id, label, icon, group, href: MODERATION_LIVE_ROUTES[id], ready: true }));
}
export function moderationPageGates() {
  return [noStore, (_request, response, next) => { response.set('X-Robots-Tag', 'noindex, nofollow, noarchive'); next(); },
    requireAuth, requireVerified, requireOnboarding, async (request, _response, next) => {
      try {
        const params = new URL(request.originalUrl, 'http://localhost').searchParams;
        for (const name of params.keys()) if (params.getAll(name).length > 1 || /[.\[\]]/.test(name)) throw new AppError('Provide one value for each Moderation filter.', 422, 'MODERATION_FILTER_INVALID');
        request.moderationContext = await moderationAccess(request); next();
      } catch (error) { next(error); }
    }];
}
export async function renderModerationPage(request, response, pageId, moderationFlow) {
  const page = DASHBOARD_PAGES.moderator.find(row => row[0] === pageId);
  if (!page) throw new AppError('Moderation page not found.', 404, 'MODERATION_PAGE_NOT_FOUND');
  const context = request.moderationContext ? await assertModerationReadAccess(request, request.moderationContext) : await moderationAccess(request);
  const snapshot = moderationFlow.context || moderationFlow;
  const originalCountries = snapshot.countries || moderationFlow.countries;
  if (snapshot.country !== context.country || !Array.isArray(originalCountries)
    || originalCountries.length !== context.countries.length
    || originalCountries.some(row => !context.countries.some(current => current.code === row.code
      && (!row.currency || row.currency === current.currency) && (!row.timeZone || row.timeZone === current.timeZone)))) {
    throw new AppError('Your Moderation scope changed while this page loaded. Reload it.', 403, 'MODERATION_SCOPE_CHANGED');
  }
  moderationFlow.context = moderationPublicContext(context);
  if (request.accepts(['html', 'json']) === 'json') {
    return response.json(moderationFlow);
  }
  const [header, sidebar] = await Promise.all([liveSellerAccountHeader(request), moderationFlow.sidebar || loadModerationSidebar(context)]);
  await assertModerationReadAccess(request, context);
  return response.render('approved-dashboard', {
    ...header, workspace: 'moderator', initialPage: pageId, allowedWorkspaces: ['moderator'],
    customerRoutes: { ...header.customerRoutes, ...MODERATION_LIVE_ROUTES, dashboard: '/moderation/overview', profile: '/moderation/settings' },
    moderationFlow, pageFlow: moderationFlow,
    formatDate: value => value ? new Intl.DateTimeFormat(context.actor.locale || 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: context.timeZone }).format(new Date(value)) : '—',
    moderationPage: { id: pageId, label: page[1], eyebrow: page[3], title: page[4], description: page[5], kind: page[6], href: MODERATION_LIVE_ROUTES[pageId] },
    liveModeration: { profileRole: 'Moderator', navigation: moderationNavigation(), market: context.market, country: context.country, preferences: { density: context.actor.preferences?.moderationDensity || 'comfortable', idleReminderMinutes: context.actor.preferences?.moderationIdleReminderMinutes || 30 },
      domainFlow: moderationFlow, context: moderationPublicContext(context), sidebar },
  });
}

import { primaryWorkspaceFor } from './access.js';
import { routeForPage, defaultPageFor } from './registry.js';
import { FINANCE_LIVE_ROUTES } from './finance-routes.js';
import { MODERATION_LIVE_ROUTES } from './moderation-routes.js';
import { SUPPORT_LIVE_ROUTES } from './support-routes.js';
import { COUNTRY_ADMIN_LIVE_ROUTES } from './country-admin-routes.js';

export function dashboardLanding(user) {
  const workspace = primaryWorkspaceFor(user);
  if (workspace === 'admin' && COUNTRY_ADMIN_LIVE_ROUTES[user.preferences?.countryAdminLandingPage]) return COUNTRY_ADMIN_LIVE_ROUTES[user.preferences.countryAdminLandingPage];
  if (workspace === 'finance' && FINANCE_LIVE_ROUTES[user.preferences?.financeLandingPage]) return FINANCE_LIVE_ROUTES[user.preferences.financeLandingPage];
  if (workspace === 'moderator' && MODERATION_LIVE_ROUTES[user.preferences?.moderationLandingPage]) return MODERATION_LIVE_ROUTES[user.preferences.moderationLandingPage];
  if (workspace === 'support' && SUPPORT_LIVE_ROUTES[user.preferences?.supportLandingPage]) return SUPPORT_LIVE_ROUTES[user.preferences.supportLandingPage];
  return routeForPage(defaultPageFor(workspace));
}

function localDestination(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  const destination = new URL(value, 'https://classicmart.invalid');
  return destination.origin === 'https://classicmart.invalid' ? destination : null;
}

export function hasSellerSignupIntent(next) {
  const destination = localDestination(next);
  if (!destination) return false;
  return destination.pathname === '/onboarding/seller' || destination.pathname === '/seller' || destination.pathname.startsWith('/seller/') ||
    (['/signup', '/onboarding'].includes(destination.pathname) && destination.searchParams.get('role') === 'seller');
}

export function signupDestination(next) {
  return hasSellerSignupIntent(next) ? '/signup?role=seller' : '/signup';
}

export function loginDestination(user, next) {
  const destination = localDestination(next);
  if (destination?.pathname === '/account/profile' && dashboardLanding(user) === '/dashboard') return next;
  if (!destination || ['/', '/dashboard', '/account', '/account/profile'].includes(destination.pathname)) {
    return dashboardLanding(user);
  }
  if (user.role === 'customer' && !user.platformAccessManagedAt && hasSellerSignupIntent(next)) return '/onboarding/seller';
  return next;
}

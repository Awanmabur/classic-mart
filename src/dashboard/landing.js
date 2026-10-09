import { primaryWorkspaceFor } from './access.js';
import { routeForPage, defaultPageFor } from './registry.js';

export function dashboardLanding(user) {
  return routeForPage(defaultPageFor(primaryWorkspaceFor(user)));
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

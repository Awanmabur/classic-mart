import { DASHBOARD_WORKSPACES, DASHBOARD_PAGES, routeForPage } from './registry.js';
import { canAccessWorkspace } from './access.js';

const LOCAL_ORIGIN = 'https://classicmart.invalid';

function localDestination(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/')
      || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const destination = new URL(value, LOCAL_ORIGIN);
    if (destination.origin !== LOCAL_ORIGIN || destination.hash
        || /%(?:0[0-9a-f]|1[0-9a-f]|20|2f|5c|7f)/i.test(destination.pathname)) return null;
    return destination;
  } catch { return null; }
}

/** Continuations are navigation destinations, never arbitrary local endpoints.
 * The view already resolves current account grants and store membership without
 * creating a store. Its ready navigation is checked again on every GET/POST.
 * Destination routes still enforce their own authorization and tenant scope.
 */
export function mfaContinuation(value, user, view) {
  const workspace = view.workspace || 'customer';
  const currentNavigation = view.accountNavigation || view.liveSeller?.navigation;
  const navigation = Array.isArray(currentNavigation)
    ? currentNavigation.filter(item => item.ready && localDestination(item.href))
    : (canAccessWorkspace(user, workspace) ? (DASHBOARD_PAGES[workspace] || []).map(([id, label]) => ({
      id, label, href: routeForPage(id), ready: true,
    })) : []);
  const preferredHome = navigation.find(item => item.id === DASHBOARD_WORKSPACES[workspace]?.defaultPage);
  const home = preferredHome?.href || navigation[0]?.href || '/account/security';
  const destination = localDestination(value);
  let next = '';
  if (destination) {
    const item = navigation.find(entry => destination.pathname === entry.href
      || destination.pathname === `/dashboard/${entry.id}`
      || (entry.id === 'seller-overview' && destination.pathname === '/seller'));
    // The owned inbox remains reachable before an accepted store can be selected.
    if (destination.pathname === '/account/store-invitations' && user?.status === 'active'
        && ['customer', 'seller'].includes(user.role) && !user.platformAccessManagedAt
        && !user.authorizationContext?.platformManaged) next = '/account/store-invitations';
    else if (item) next = item.href + destination.search;
    // Keep a selected order/product after enrollment. Mutation and export URLs
    // cannot become continuation targets, even with the same store capability.
    else if (/^\/seller\/orders\/[A-Za-z0-9_-]{1,160}$/.test(destination.pathname)
        && !destination.pathname.endsWith('/export.csv')
        && navigation.some(entry => entry.href === '/seller/orders')) next = destination.pathname + destination.search;
    else if (/^\/seller\/products\/[A-Za-z0-9_-]{1,160}$/.test(destination.pathname)
        && navigation.some(entry => entry.href === '/seller/products')) next = destination.pathname + destination.search;
  }
  return {
    next,
    url: next || home,
    label: next === '/account/store-invitations' ? 'Continue to store invitations'
      : workspace === 'customer' ? 'Continue to dashboard' : `Continue to ${DASHBOARD_WORKSPACES[workspace]?.label || 'your'} workspace`,
  };
}

export function mfaSecurityPath(continuation) {
  return '/account/security' + (continuation.next ? `?next=${encodeURIComponent(continuation.next)}` : '');
}

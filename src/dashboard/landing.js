import { primaryWorkspaceFor } from './access.js';
import { routeForPage, defaultPageFor } from './registry.js';

export function dashboardLanding(user) {
  return routeForPage(defaultPageFor(primaryWorkspaceFor(user)));
}

export function loginDestination(user, next) {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || /[\\\r\n]/.test(next) || next === '/') {
    return dashboardLanding(user);
  }
  return next;
}

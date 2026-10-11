import { AppError } from '../core/errors.js';
import { env } from '../config/env.js';
import { noStore } from '../middleware/request.js';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { loadSellerStore, requireStoreCapability } from '../middleware/store.js';
import { allowedWorkspacesFor } from './access.js';
import { DASHBOARD_PAGES, routeForPage } from './registry.js';
import { sellerNavigation, SELLER_LIVE_ROUTES } from './seller-navigation.js';
import { liveSellerAccountHeader } from './live-account-header.js';

const privatePage = (_request, response, next) => {
  response.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  next();
};

function storeMfa(request, response, next) {
  // Invited staff can have a Customer identity while exercising operational
  // capabilities. Enforce the boundary for their store access as well.
  if (env.auth.simpleLogin || !env.security.privilegedMfaRequired || request.user.security?.mfaEnabled) return next();
  if (request.accepts(['html', 'json']) === 'json') return next(new AppError('Authenticator enrollment is required for store operations.', 403, 'MFA_ENROLLMENT_REQUIRED'));
  return response.redirect('/account/security?next=' + encodeURIComponent(request.originalUrl));
}

export function sellerPageGates(capability) {
  return [noStore, privatePage, requireAuth, requireVerified, requireOnboarding,
    loadSellerStore, requireStoreCapability(capability), storeMfa];
}

export async function renderSellerPage(request, response, pageId, pageFlow) {
  const page = DASHBOARD_PAGES.seller.find(([id]) => id === pageId);
  if (!page) throw new AppError('Seller page not found.', 404, 'SELLER_PAGE_NOT_FOUND');
  if (request.accepts(['html', 'json']) === 'json') return response.json(pageFlow);
  const header = await liveSellerAccountHeader(request);
  return response.render('approved-dashboard', {
    ...header, workspace: 'seller', initialPage: pageId,
    allowedWorkspaces: [...new Set([...allowedWorkspacesFor(request.user), 'seller'])],
    customerRoutes: { ...header.customerRoutes, ...SELLER_LIVE_ROUTES },
    pageFlow, sellerPage: { id: pageId, label: page[1], eyebrow: page[3], title: page[4], description: page[5], kind: page[6], href: routeForPage(pageId) },
    liveSeller: { profileRole: 'Seller', store: request.store.toObject(), navigation: sellerNavigation(request), pageFlow },
  });
}

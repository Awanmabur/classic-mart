import { DASHBOARD_PAGES, routeForPage } from './registry.js';
import { storeCapabilities } from '../services/store.js';
import { canAccessWorkspace } from './access.js';
import { SELLER_LIVE_ROUTES } from './seller-routes.js';

export { SELLER_LIVE_ROUTES };

const PAGE_CAPABILITY = Object.freeze({
  'seller-overview': 'staff', 'seller-store': 'staff', 'seller-subscription': 'staff',
  'seller-products': 'catalogue', 'seller-add-product': 'catalogue',
  'seller-inventory': 'inventory', 'seller-orders': 'fulfilment', 'seller-shipping': 'fulfilment',
  'seller-returns': 'support', 'seller-customers': 'support', 'seller-reviews': 'support', 'seller-messages': 'support',
  'seller-promotions': 'growth', 'seller-coupons': 'growth',
  'seller-earnings': 'finance', 'seller-payouts': 'finance', 'seller-analytics': 'analytics',
});

export function sellerNavigation(request) {
  const capabilities = storeCapabilities(request.storeMembership?.role);
  const can = capability => capabilities.has('*') || capabilities.has(capability);
  const catalogueWorkspace = canAccessWorkspace(request.user, 'seller');
  return DASHBOARD_PAGES.seller.map(([id, label, icon, group]) => ({
    id, label, icon, group, href: routeForPage(id),
    ready: Boolean(SELLER_LIVE_ROUTES[id] && can(PAGE_CAPABILITY[id])
      && (!['seller-overview', 'seller-store', 'seller-products', 'seller-add-product'].includes(id) || catalogueWorkspace)),
  }));
}

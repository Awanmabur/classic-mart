import { DASHBOARD_PAGES, routeForPage } from './registry.js';
import { storeCapabilities } from '../services/store.js';
import { canAccessWorkspace } from './access.js';

export const SELLER_LIVE_ROUTES = Object.freeze({
  'seller-store': '/seller/store',
  'seller-products': '/seller/products',
  'seller-add-product': '/seller/products/new',
  'seller-orders': '/seller/orders',
  'seller-shipping': '/seller/shipping',
});

export function sellerNavigation(request) {
  const capabilities = storeCapabilities(request.storeMembership?.role);
  const can = capability => capabilities.has('*') || capabilities.has(capability);
  const catalogueWorkspace = canAccessWorkspace(request.user, 'seller');
  return DASHBOARD_PAGES.seller.map(([id, label, icon]) => ({
    id, label, icon, href: routeForPage(id),
    ready: (id === 'seller-store' && catalogueWorkspace && can('staff')) || (['seller-products', 'seller-add-product'].includes(id) && catalogueWorkspace && can('catalogue'))
      || (['seller-orders', 'seller-shipping'].includes(id) && can('fulfilment')),
  }));
}

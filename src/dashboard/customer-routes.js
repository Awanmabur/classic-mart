// Canonical customer pages share this registry with server rendering and navigation.
export const CUSTOMER_ROUTES = Object.freeze({
  dashboard: '/dashboard', orders: '/orders', wishlist: '/wishlist',
  addresses: '/addresses', rewards: '/rewards', wallet: '/wallet',
  returns: '/returns', support: '/support', profile: '/profile',
  categories: '/categories', cart: '/cart', notifications: '/notifications', club: '/club',
});
export const PUBLIC_CUSTOMER_PAGES = Object.freeze(new Set(['categories', 'cart', 'returns']));
export function customerRoute(page = 'dashboard') {
  return CUSTOMER_ROUTES[page] || CUSTOMER_ROUTES.dashboard;
}

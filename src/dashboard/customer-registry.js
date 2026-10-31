import { customerRoute } from './customer-routes.js';
export const CUSTOMER_DASHBOARD_PAGES = Object.freeze([
  { id: 'dashboard', label: 'Overview', icon: 'fa-solid fa-house', title: 'Customer Overview' },
  { id: 'orders', label: 'Orders', icon: 'fa-solid fa-box', title: 'My Orders' },
  { id: 'wishlist', label: 'Wishlist', icon: 'fa-solid fa-heart', title: 'Wishlist' },
  { id: 'addresses', label: 'Addresses', icon: 'fa-solid fa-location-dot', title: 'Addresses' },
  { id: 'rewards', label: 'Rewards', icon: 'fa-solid fa-gift', title: 'Rewards' },
  { id: 'wallet', label: 'Wallet', icon: 'fa-solid fa-wallet', title: 'Wallet' },
  { id: 'returns', label: 'Returns', icon: 'fa-solid fa-arrow-rotate-left', title: 'Returns & Refunds' },
  { id: 'support', label: 'Support', icon: 'fa-solid fa-headset', title: 'Support' },
  { id: 'profile', label: 'Profile', icon: 'fa-solid fa-user', title: 'Profile Settings' },
  { id: 'categories', label: 'Categories', icon: 'fa-solid fa-border-all', title: 'Categories' },
  { id: 'cart', label: 'Cart', icon: 'fa-solid fa-cart-shopping', title: 'Cart' },
  { id: 'notifications', label: 'Notifications', icon: 'fa-solid fa-bell', title: 'Notifications' },
  { id: 'club', label: 'Classic Club', icon: 'fa-solid fa-crown', title: 'Classic Club' },
]);

export const CUSTOMER_DASHBOARD_PAGE_IDS = Object.freeze(CUSTOMER_DASHBOARD_PAGES.map((page) => page.id));
const byId = new Map(CUSTOMER_DASHBOARD_PAGES.map((page) => [page.id, page]));

export function customerDashboardPage(pageId) {
  return byId.get(String(pageId || '').trim()) || null;
}

export function customerDashboardPath(pageId = 'dashboard') {
  const page = customerDashboardPage(pageId);
  return customerRoute(page?.id);
}

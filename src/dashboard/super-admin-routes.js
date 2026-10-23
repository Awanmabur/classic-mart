export const SUPER_ADMIN_LIVE_ROUTES = Object.freeze(Object.fromEntries([
  'overview', 'analytics', 'users', 'roles', 'admins', 'sellers', 'promoters', 'customers',
  'products', 'categories', 'orders', 'finance', 'commissions', 'subscriptions', 'disputes',
  'reports', 'audit', 'security', 'notifications', 'support', 'settings',
].map(slug => ['super-' + slug, '/super/' + slug])));

export function superAdminPath(page = 'overview') {
  return SUPER_ADMIN_LIVE_ROUTES['super-' + String(page).replace(/^super-/, '')] || '/super/overview';
}

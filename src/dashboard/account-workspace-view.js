import { canAccessWorkspace, allowedWorkspacesFor, primaryWorkspaceFor } from './access.js';
import { DASHBOARD_PAGES, DASHBOARD_WORKSPACES, routeForPage } from './registry.js';
import { CUSTOMER_ROUTES } from './customer-routes.js';
import { customerView } from './customer-view.js';
import { customerUnread } from './customer-reads.js';
import { sellerNavigation, SELLER_LIVE_ROUTES } from './seller-navigation.js';
import { sellerStoreAccesses } from '../services/store.js';
import { PROMOTER_LIVE_ROUTES } from './promoter-routes.js';
import { FINANCE_LIVE_ROUTES } from './finance-routes.js';
import { MODERATION_LIVE_ROUTES } from './moderation-routes.js';
import { SUPPORT_LIVE_ROUTES } from './support-routes.js';
import { COUNTRY_ADMIN_LIVE_ROUTES } from './country-admin-routes.js';
import { BUSINESS_LIVE_ROUTES } from './business-routes.js';
import { DELIVERY_ROUTES } from './delivery-routes.js';
import { SUPER_ADMIN_LIVE_ROUTES } from './super-admin-routes.js';
import { customerAvatarUrl } from '../services/customer-avatars.js';

/** Personal account data stays scoped to the signed-in user. The surrounding
 * navigation uses current store access, never an account label or saved preview
 * preference. Reading an account page does not provision a store or change roles.
 */
export async function accountWorkspaceView(request, section = 'profile') {
  const primaryWorkspace = primaryWorkspaceFor(request.user);
  const sellerAccount = primaryWorkspace === 'seller' && canAccessWorkspace(request.user, 'seller');
  const preferredStore = String(request.session?.activeStorePublicId || '');
  const customerAccount = async () => ({ workspace: 'customer', initialPage: 'profile', allowedWorkspaces: ['customer'],
    ...await customerView(request, 'profile'), accountSupplement: section });

  // Personal settings must preserve the current, server-authorized operational
  // workspace even before MFA is enrolled. Only connected operational pages are
  // enabled here; an account read never invents preview statistics or grants.
  if (!['customer', 'seller'].includes(primaryWorkspace)) {
    const config = DASHBOARD_WORKSPACES[primaryWorkspace];
    const connected = primaryWorkspace === 'warehouse'
      ? new Set(DASHBOARD_PAGES.warehouse.map(([id]) => id))
      : primaryWorkspace === 'delivery' ? new Set(Object.keys(DELIVERY_ROUTES))
      : primaryWorkspace === 'business' ? new Set(Object.keys(BUSINESS_LIVE_ROUTES))
      : primaryWorkspace === 'superadmin' ? new Set(Object.keys(SUPER_ADMIN_LIVE_ROUTES))
      : primaryWorkspace === 'admin' ? new Set(Object.keys(COUNTRY_ADMIN_LIVE_ROUTES))
      : primaryWorkspace === 'moderator' ? new Set(Object.keys(MODERATION_LIVE_ROUTES))
        : primaryWorkspace === 'promoter' ? new Set(Object.keys(PROMOTER_LIVE_ROUTES))
          : primaryWorkspace === 'finance' ? new Set(Object.keys(FINANCE_LIVE_ROUTES))
            : primaryWorkspace === 'support' ? new Set(Object.keys(SUPPORT_LIVE_ROUTES)) : new Set();
    const navigation = DASHBOARD_PAGES[primaryWorkspace].map(([id, label, icon, group]) => ({
      id, label, icon, group, href: routeForPage(id), ready: connected.has(id),
    }));
    const home = navigation.find(item => item.ready);
    const [unread, avatarUrl] = await Promise.all([customerUnread(request), customerAvatarUrl(request.user._id)]);
    return {
      workspace: primaryWorkspace, initialPage: `${primaryWorkspace}-account`,
      allowedWorkspaces: allowedWorkspacesFor(request.user), accountSupplement: section,
      accountNavigation: navigation, accountHome: home?.href || '/account/security',
      avatarUrl, profileRoleLabel: config.label,
      customerRoutes: { notifications: '/notifications', profile: '/account/profile',
        dashboard: home?.href || '/account/security', ...Object.fromEntries(navigation.filter(item => item.ready).map(item => [item.id, item.href])) },
      liveHeader: { unread, wishlistCount: 0, cartCount: 0, points: 0, balanceMinor: 0, tier: '' },
      liveAccountWorkspace: { profileRole: config.label, navigation, accountFlow: section,
        search: config.search, quickLabel: config.quickLabel, quickPage: config.quickPage },
    };
  }

  // Ordinary customer pages retain their existing reads, layout and destinations.
  if (!sellerAccount && !preferredStore) return customerAccount();
  const accesses = await sellerStoreAccesses(request.user);
  const personalSeller = request.user.role === 'seller';
  const selected = accesses.find(access => access.store.publicId === preferredStore)
    || (personalSeller && sellerAccount ? accesses.find(access => access.role === 'owner') || accesses[0] : null);
  // A stale store selection and mere ownership do not reclassify a customer.
  // Explicit, currently active staff membership may keep the operational shell
  // while its member configures personal MFA before entering store operations.
  if (!personalSeller && (!selected?.membership || selected.membership.status !== 'active'
    || !(selected.membership.acceptedAt instanceof Date))) return customerAccount();

  const navigation = sellerNavigation({ ...request, storeMembership: { role: selected?.role || 'owner' } });
  const home = navigation.find(item => item.id === 'seller-overview' && item.ready) || navigation.find(item => item.ready);
  const settings = navigation.find(item => item.id === 'seller-store' && item.ready);
  const [unread, avatarUrl] = await Promise.all([customerUnread(request), customerAvatarUrl(request.user._id)]);
  return {
    workspace: 'seller', initialPage: 'seller-account',
    allowedWorkspaces: [...new Set([...allowedWorkspacesFor(request.user), 'seller'])],
    accountSupplement: section, accountNavigation: navigation, accountHome: home?.href || '/account/security',
    avatarUrl, profileRoleLabel: 'Seller',
    customerRoutes: { ...CUSTOMER_ROUTES, ...SELLER_LIVE_ROUTES,
      dashboard: home?.href || '/account/security', profile: settings?.href || '/account/profile' },
    liveHeader: { unread, wishlistCount: 0, cartCount: 0, points: 0, balanceMinor: 0, tier: '' },
    liveSeller: { profileRole: 'Seller', store: selected?.store || null, navigation, accountFlow: section },
  };
}

import { canAccessWorkspace, allowedWorkspacesFor, primaryWorkspaceFor } from './access.js';
import { DASHBOARD_PAGES, DASHBOARD_WORKSPACES, routeForPage } from './registry.js';
import { CUSTOMER_ROUTES } from './customer-routes.js';
import { customerView } from './customer-view.js';
import { customerUnread } from './customer-reads.js';
import { sellerNavigation, SELLER_LIVE_ROUTES } from './seller-navigation.js';
import { sellerStoreAccesses } from '../services/store.js';
import { PROMOTER_LIVE_ROUTES } from './promoter-routes.js';

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
      : primaryWorkspace === 'moderator' ? new Set(['moderator-sellers', 'moderator-products'])
        : primaryWorkspace === 'promoter' ? new Set(Object.keys(PROMOTER_LIVE_ROUTES)) : new Set();
    const navigation = DASHBOARD_PAGES[primaryWorkspace].map(([id, label, icon, group]) => ({
      id, label, icon, group, href: routeForPage(id), ready: connected.has(id),
    }));
    const home = navigation.find(item => item.ready);
    return {
      workspace: primaryWorkspace, initialPage: `${primaryWorkspace}-account`,
      allowedWorkspaces: allowedWorkspacesFor(request.user), accountSupplement: section,
      accountNavigation: navigation, accountHome: home?.href || '/account/security',
      customerRoutes: { notifications: '/notifications', profile: '/account/security',
        dashboard: home?.href || '/account/security', ...Object.fromEntries(navigation.filter(item => item.ready).map(item => [item.id, item.href])) },
      liveHeader: { unread: await customerUnread(request), wishlistCount: 0, cartCount: 0, points: 0, balanceMinor: 0, tier: '' },
      liveAccountWorkspace: { profileRole: config.label, navigation, accountFlow: section,
        search: config.search, quickLabel: config.quickLabel, quickPage: config.quickPage },
    };
  }

  // Ordinary customer pages retain their existing reads, layout and destinations.
  if (!sellerAccount && !preferredStore) return customerAccount();
  const accesses = await sellerStoreAccesses(request.user);
  const selected = accesses.find(access => access.store.publicId === preferredStore) || (sellerAccount ? accesses[0] : null);
  // A stale store selection and mere ownership do not reclassify a customer.
  // Explicit, currently active staff membership may keep the operational shell
  // while its member configures personal MFA before entering store operations.
  if (!sellerAccount && (!selected?.membership || selected.membership.status !== 'active')) return customerAccount();

  const navigation = sellerNavigation({ ...request, storeMembership: { role: selected?.role || 'owner' } });
  const home = navigation.find(item => item.id === 'seller-overview' && item.ready) || navigation.find(item => item.ready);
  const settings = navigation.find(item => item.id === 'seller-store' && item.ready);
  const unread = await customerUnread(request);
  return {
    workspace: 'seller', initialPage: 'seller-account',
    allowedWorkspaces: [...new Set([...allowedWorkspacesFor(request.user), 'seller'])],
    accountSupplement: section, accountNavigation: navigation, accountHome: home?.href || '/account/security',
    customerRoutes: { ...CUSTOMER_ROUTES, ...SELLER_LIVE_ROUTES,
      dashboard: home?.href || '/account/security', profile: settings?.href || '/account/security' },
    liveHeader: { unread, wishlistCount: 0, cartCount: 0, points: 0, balanceMinor: 0, tier: '' },
    liveSeller: { profileRole: 'Seller', store: selected?.store || null, navigation, accountFlow: section },
  };
}

import { customerLoyalty, customerWallet, customerCatalogue, customerCartBadge, customerUnread } from './customer-reads.js';
import { CUSTOMER_ROUTES } from './customer-routes.js';

export async function liveAccountHeader(request) {
  const [loyalty, wallet, catalogue, cart, unread] = await Promise.all([
    customerLoyalty(request), customerWallet(request), customerCatalogue(request), customerCartBadge(request), customerUnread(request),
  ]);
  return { customerRoutes: CUSTOMER_ROUTES,
    liveHeader: { points: Math.max(0, loyalty?.points || 0), balanceMinor: wallet.balanceMinor, tier: loyalty?.tier || 'Classic',
      wishlistCount: catalogue?.wishlistProductIds?.length || 0, cartCount: (cart?.items || []).reduce((sum, item) => sum + item.quantity, 0), unread } };
}

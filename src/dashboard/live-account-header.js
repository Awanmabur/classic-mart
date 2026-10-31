import { customerLoyalty, customerWallet, customerCatalogue, customerCartBadge, customerUnread } from './customer-reads.js';
import { CUSTOMER_ROUTES } from './customer-routes.js';
import { customerAvatarUrl } from '../services/customer-avatars.js';

// The Seller shell has no buyer loyalty, wallet, wishlist or cart controls.
// Keep its personal notification count without reading or provisioning those records.
export async function liveSellerAccountHeader(request) {
  const [unread, avatarUrl] = await Promise.all([customerUnread(request), customerAvatarUrl(request.user._id)]);
  return { customerRoutes: { ...CUSTOMER_ROUTES, profile: '/account/profile' }, avatarUrl,
    liveHeader: { unread, points: 0, balanceMinor: 0, tier: '', wishlistCount: 0, cartCount: 0 } };
}

export async function liveAccountHeader(request) {
  const [loyalty, wallet, catalogue, cart, unread] = await Promise.all([
    customerLoyalty(request), customerWallet(request), customerCatalogue(request), customerCartBadge(request), customerUnread(request),
  ]);
  return { customerRoutes: CUSTOMER_ROUTES,
    liveHeader: { points: Math.max(0, loyalty?.points || 0), balanceMinor: wallet.balanceMinor, tier: loyalty?.tier || 'Classic',
      wishlistCount: catalogue?.wishlistProductIds?.length || 0, cartCount: (cart?.items || []).reduce((sum, item) => sum + item.quantity, 0), unread } };
}

import { CUSTOMER_ROUTES } from './customer-routes.js';
import { customerLoyalty, customerWallet, customerCatalogue, customerCartBadge, customerUnread } from './customer-reads.js';
import { loadCustomerDashboardPage } from './customer-data.js';
import { publicId } from '../core/ids.js';
import { customerAvatarUrl } from '../services/customer-avatars.js';

export async function customerView(request, page) {
  const pagePromise = loadCustomerDashboardPage(request, page);
  const [pageData, loyalty, wallet, state, cart, unread, avatarUrl] = await Promise.all([
    pagePromise, customerLoyalty(request), customerWallet(request), customerCatalogue(request),
    ['dashboard', 'cart'].includes(page) ? pagePromise.then(data => data.cart) : customerCartBadge(request),
    customerUnread(request),customerAvatarUrl(request.user._id),
  ]);
  return {
    pageData, customerRoutes: CUSTOMER_ROUTES, walletIdempotencyKey: publicId('idem'), avatarUrl,
    liveHeader: {
      points: Math.max(0, loyalty?.points || 0), balanceMinor: wallet.balanceMinor, currency: wallet.currency,
      tier: pageData.club?.current?.label || loyalty?.tier || 'Classic',
      wishlistCount: state?.wishlistProductIds?.length || 0,
      cartCount: (cart?.items || []).reduce((sum, item) => sum + item.quantity, 0),
      unread,
    },
  };
}

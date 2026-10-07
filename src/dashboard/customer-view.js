import { Cart, CustomerCatalogueState, LoyaltyAccount, Notification } from '../models/index.js';
import { customerWalletSummary } from '../services/customer-wallet.js';
import { loadCustomerDashboardPage } from './customer-data.js';
import { publicId } from '../core/ids.js';

export async function customerView(request, page) {
  const pageData = await loadCustomerDashboardPage(request, page);
  const id = request.user._id;
  const [loyalty, wallet, state, cart, unread] = await Promise.all([
    pageData.loyalty || LoyaltyAccount.findOne({ userId: id }).lean(),
    pageData.wallet || customerWalletSummary(request.user),
    CustomerCatalogueState.findOne({ userId: id }).select('wishlistProductIds').lean(),
    pageData.cart || Cart.findOne({ userId: id, country: request.country.code }).sort({ updatedAt: -1 }).select('items').lean(),
    pageData.unread ?? Notification.countDocuments({ userId: id, readAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }),
  ]);
  return {
    pageData, walletIdempotencyKey: publicId('idem'),
    liveHeader: {
      points: Math.max(0, loyalty?.points || 0), balanceMinor: wallet.balanceMinor,
      tier: pageData.club?.current?.label || loyalty?.tier || 'Classic',
      wishlistCount: state?.wishlistProductIds?.length || 0,
      cartCount: (cart?.items || []).reduce((sum, item) => sum + item.quantity, 0),
      unread,
    },
  };
}

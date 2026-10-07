import { Cart, CustomerCatalogueState, LoyaltyAccount, Notification, WalletTopUp } from '../models/index.js';
import { customerWalletSummary } from '../services/customer-wallet.js';

// Only deduplicate within one authenticated request. Nothing survives a request,
// so balances, revocations, preference changes and another user's data stay fresh.
const reads = new WeakMap();
export function customerRead(request, key, loader) {
  let cache = reads.get(request);
  if (!cache) { cache = new Map(); reads.set(request, cache); }
  if (!cache.has(key)) cache.set(key, Promise.resolve().then(loader));
  return cache.get(key);
}
export const customerLoyalty = request => customerRead(request, 'loyalty', () => LoyaltyAccount.findOne({ userId: request.user._id }).lean().exec());
export const customerCatalogue = request => customerRead(request, 'catalogue', () => CustomerCatalogueState.findOne({ userId: request.user._id }).select('wishlistProductIds').lean().exec());
export const customerUnread = request => customerRead(request, 'unread', () => Notification.countDocuments({ userId: request.user._id, readAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }).exec());
export const customerWallet = (request, includeTopUps = false) => {
  const balance = customerRead(request, 'wallet-balance', () => customerWalletSummary(request.user, { includeTopUps: false }));
  if (!includeTopUps) return balance;
  return customerRead(request, 'wallet-full', async () => {
    const [summary, topUps] = await Promise.all([balance, WalletTopUp.find({ userId: request.user._id }).sort({ createdAt: -1 }).limit(12).lean().exec()]);
    return { ...summary, topUps };
  });
};
export const customerCartBadge = request => customerRead(request, 'cart-badge', () => Cart.findOne({ userId: request.user._id, country: request.country.code }).sort({ updatedAt: -1 }).select('items.quantity').lean().exec());

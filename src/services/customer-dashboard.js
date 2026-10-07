import {
  Cart,
  Category,
  CustomerAddress,
  CustomerCatalogueState,
  LedgerAccount,
  LedgerTransaction,
  LoyaltyAccount,
  LoyaltyEntry,
  Notification,
  Order,
  Product,
  ProductMedia,
  ProductVariant,
  ReturnRequest,
  SupportTicket,
} from '../models/index.js';
import { accountBalanceMinor } from './money.js';
import { publicProductImageUrl } from './product-media-url.js';
import { getCountries } from './country.js';

const MAX_ROWS = 50;
const ZERO_DECIMAL = new Set(['UGX', 'RWF', 'JPY', 'KRW']);

function money(minor, currency = 'UGX', locale = 'en-UG') {
  const code = String(currency || 'UGX').toUpperCase();
  const amount = ZERO_DECIMAL.has(code) ? Number(minor || 0) : Number(minor || 0) / 100;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency', currency: code, maximumFractionDigits: ZERO_DECIMAL.has(code) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${code} ${amount.toLocaleString('en-US')}`;
  }
}

function safeDate(value) {
  return value ? new Date(value) : null;
}

function humanStatus(value) {
  return String(value || 'pending').replaceAll('_', ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

async function productCards(productIds, { locale, currency }) {
  const ids = [...new Set((productIds || []).filter(Boolean).map(String))];
  if (!ids.length) return [];
  const products = await Product.find({ _id: { $in: ids }, status: { $nin: ['archived', 'suspended', 'rejected'] } })
    .select('publicId title status categoryId updatedAt')
    .lean();
  const mongoIds = products.map((row) => row._id);
  const [variants, mediaRows] = await Promise.all([
    ProductVariant.find({ productId: { $in: mongoIds }, active: true }).sort({ priceMinor: 1 }).lean(),
    ProductMedia.find({ productId: { $in: mongoIds }, status: { $in: ['approved', 'ready'] } }).sort({ productId: 1, position: 1, createdAt: 1 }).lean(),
  ]);
  const firstVariant = new Map();
  for (const variant of variants) if (!firstVariant.has(String(variant.productId))) firstVariant.set(String(variant.productId), variant);
  const firstMedia = new Map();
  for (const media of mediaRows) if (!firstMedia.has(String(media.productId))) firstMedia.set(String(media.productId), media);
  return products.map((product) => {
    const variant = firstVariant.get(String(product._id));
    const media = firstMedia.get(String(product._id));
    return {
      id: product.publicId,
      mongoId: String(product._id),
      title: product.title,
      status: product.status,
      image: publicProductImageUrl(media, true),
      variantId: variant?.publicId || '',
      priceMinor: Number(variant?.priceMinor || 0),
      currency: variant?.currency || currency,
      price: variant ? money(variant.priceMinor, variant.currency || currency, locale) : 'Price unavailable',
      updatedAt: product.updatedAt,
    };
  });
}

async function customerWallet(user, locale) {
  const accounts = await LedgerAccount.find({ ownerType: 'customer', ownerPublicId: user.publicId, active: true }).sort({ createdAt: 1 }).lean();
  const balances = await Promise.all(accounts.map(async (account) => ({
    ...account,
    balanceMinor: await accountBalanceMinor(account._id),
  })));
  const preferred = balances.filter((row) => row.currency === user.currency);
  const visible = preferred.length ? preferred : balances;
  const balanceMinor = visible.reduce((sum, row) => sum + Number(row.balanceMinor || 0), 0);
  const accountIds = accounts.map((row) => row._id);
  const transactions = accountIds.length
    ? await LedgerTransaction.find({ 'entries.accountId': { $in: accountIds } }).sort({ postedAt: -1 }).limit(MAX_ROWS).lean()
    : [];
  return {
    accounts: balances.map((row) => ({ ...row, balance: money(row.balanceMinor, row.currency, locale) })),
    balanceMinor,
    balance: money(balanceMinor, user.currency, locale),
    transactions,
  };
}

export async function loadCustomerDashboard(request) {
  const user = request.user;
  const locale = user.locale || request.country?.locale || 'en-UG';
  const currency = user.currency || request.country?.currency || 'UGX';
  const userId = user._id;

  const [
    orders,
    orderCount,
    state,
    addresses,
    loyalty,
    loyaltyEntries,
    wallet,
    returns,
    tickets,
    categories,
    cart,
    notifications,
    countries,
  ] = await Promise.all([
    Order.find({ userId }).sort({ createdAt: -1 }).limit(MAX_ROWS).lean(),
    Order.countDocuments({ userId }),
    CustomerCatalogueState.findOne({ userId }).lean(),
    CustomerAddress.find({ userId, archivedAt: null }).sort({ isDefault: -1, updatedAt: -1 }).limit(MAX_ROWS).lean(),
    LoyaltyAccount.findOne({ userId }).lean(),
    LoyaltyEntry.find({ userId }).sort({ createdAt: -1 }).limit(MAX_ROWS).lean(),
    customerWallet(user, locale),
    ReturnRequest.find({ userId }).sort({ createdAt: -1 }).limit(MAX_ROWS).lean(),
    SupportTicket.find({ userId }).sort({ createdAt: -1 }).limit(MAX_ROWS).lean(),
    Category.find({ active: true, $or: [{ countries: { $size: 0 } }, { countries: user.shoppingCountry || user.country }] }).sort({ name: 1 }).limit(MAX_ROWS).lean(),
    Cart.findOne({ userId }).populate('items.productId', 'publicId title status').populate('items.variantId', 'publicId title sku priceMinor currency active').lean(),
    Notification.find({ userId, $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }] }).sort({ createdAt: -1 }).limit(MAX_ROWS).lean(),
    getCountries(),
  ]);

  const wishlistIds = state?.wishlistProductIds || [];
  const wishlist = await productCards(wishlistIds, { locale, currency });

  const orderProductIds = orders.flatMap((order) => (order.items || []).map((item) => item.productId).filter(Boolean));
  const orderProductCards = await productCards(orderProductIds, { locale, currency });
  const orderImageByMongoId = new Map(orderProductCards.map((row) => [row.mongoId, row.image]));

  const cartItems = (cart?.items || []).map((item) => ({
    productId: item.productId?.publicId || '',
    variantId: item.variantId?.publicId || '',
    title: item.productId?.title || item.variantId?.title || 'Cart item',
    variantTitle: item.variantId?.title || '',
    sku: item.variantId?.sku || '',
    quantity: Number(item.quantity || 1),
    unitPriceMinor: Number(item.variantId?.priceMinor || 0),
    currency: item.variantId?.currency || currency,
    active: item.variantId?.active !== false,
  }));
  const cartProductIds = (cart?.items || []).map((item) => item.productId?._id).filter(Boolean);
  const cartCards = await productCards(cartProductIds, { locale, currency });
  const cartImageByProduct = new Map(cartCards.map((row) => [row.id, row.image]));
  for (const item of cartItems) {
    item.image = cartImageByProduct.get(item.productId) || '/assets/product-placeholder.svg';
    item.lineTotalMinor = item.unitPriceMinor * item.quantity;
    item.lineTotal = money(item.lineTotalMinor, item.currency, locale);
    item.unitPrice = money(item.unitPriceMinor, item.currency, locale);
  }
  const cartSubtotalMinor = cartItems.reduce((sum, item) => sum + item.lineTotalMinor, 0);

  const orderRows = orders.map((order) => {
    const first = order.items?.[0];
    return {
      ...order,
      image: first?.productId ? orderImageByMongoId.get(String(first.productId)) || '/assets/product-placeholder.svg' : '/assets/product-placeholder.svg',
      itemTitle: first?.title || `${order.items?.length || 0} item order`,
      itemCount: order.items?.reduce((sum, item) => sum + Number(item.quantity || 0), 0) || 0,
      total: money(order.totals?.totalMinor, order.totals?.currency || currency, locale),
      statusLabel: humanStatus(order.fulfillmentState !== 'unfulfilled' ? order.fulfillmentState : order.status),
      placedAt: safeDate(order.createdAt),
    };
  });

  const unreadNotifications = notifications.filter((row) => !row.readAt).length;
  const activeOrders = orders.filter((row) => !['delivered', 'cancelled'].includes(row.fulfillmentState) && !['cancelled', 'expired', 'refunded'].includes(row.status)).length;
  const points = Number(loyalty?.points || 0);
  const tier = loyalty?.tier || 'classic';
  const nextTier = tier === 'classic' ? 'Silver' : tier === 'silver' ? 'Gold' : 'Gold';
  const tierTarget = tier === 'classic' ? 1000 : tier === 'silver' ? 5000 : Math.max(5000, Number(loyalty?.lifetimeEarned || 0));
  const progress = tier === 'gold' ? 100 : Math.min(100, Math.round((Number(loyalty?.lifetimeEarned || 0) / tierTarget) * 100));

  return {
    user: {
      publicId: user.publicId,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      country: user.shoppingCountry || user.country,
      currency,
      locale,
      createdAt: user.createdAt,
      marketing: Boolean(user.consents?.marketing),
    },
    summary: {
      totalOrders: orderCount,
      activeOrders,
      wishlistCount: wishlist.length,
      cartCount: cartItems.reduce((sum, item) => sum + item.quantity, 0),
      notificationCount: unreadNotifications,
      points,
      walletBalance: wallet.balance,
      walletBalanceMinor: wallet.balanceMinor,
      tier,
    },
    orders: orderRows,
    recentOrders: orderRows.slice(0, 3),
    wishlist,
    addresses,
    loyalty: {
      ...(loyalty || {}),
      points,
      tier,
      tierLabel: `${tier.charAt(0).toUpperCase()}${tier.slice(1)} Member`,
      nextTier,
      progress,
      target: tierTarget,
      entries: loyaltyEntries,
    },
    wallet,
    returns: returns.map((row) => ({ ...row, statusLabel: humanStatus(row.status), createdAt: safeDate(row.createdAt) })),
    tickets: tickets.map((row) => ({ ...row, statusLabel: humanStatus(row.status), createdAt: safeDate(row.createdAt) })),
    categories,
    cart: {
      publicId: cart?.publicId || '',
      items: cartItems,
      subtotalMinor: cartSubtotalMinor,
      subtotal: money(cartSubtotalMinor, cartItems[0]?.currency || currency, locale),
      promotionCodes: cart?.promotionCodes || [],
    },
    notifications: notifications.map((row) => ({ ...row, createdAt: safeDate(row.createdAt) })),
    countries,
  };
}

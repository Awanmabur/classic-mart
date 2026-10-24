import { Order, SellerOrder, Store, User } from '../models/index.js';
import { optionalProcessingUser } from './optional-processing.js';

// Keep legacy/missing values consistent with the persisted User schema. Offers
// always require an explicit opt-in as well as current marketing consent.
const defaults = Object.freeze({ orders: true, wishlist: true, offers: false, club: true });
export function customerNotificationEnabled(user, category) {
  if (!Object.hasOwn(defaults, category)) return false;
  const selected = user?.preferences?.notifications?.[category];
  return typeof selected === 'boolean' ? selected : defaults[category];
}

/** Optional outbound updates never replace required order/account records. */
export async function optionalNotificationRecipient(userId, category, { session = null } = {}) {
  const user = await optionalProcessingUser(userId, { session, marketing: category === 'offers' });
  return user && (category === 'general' || customerNotificationEnabled(user, category)) ? user : null;
}

/** Routine progress email is bound to its actual registered order at dispatch.
 * OTPs, receipts, security notices and requested support replies use their own
 * mandatory delivery paths and must not be routed through this preference.
 */
export const SELLER_FULFILMENT_EMAIL_SUBJECT = 'Your Classic Mart order is ready for carrier pickup';
export async function prepareSellerOrderNotificationDelivery(event) {
  const payload = event.payload || {}, category = payload.notificationCategory;
  if (category !== undefined && !['orders', 'service'].includes(category)) return null;
  if (typeof payload.subject !== 'string' || !payload.subject.trim() || payload.subject.length > 180
    || typeof payload.body !== 'string' || !payload.body.trim() || payload.body.length > 10000) return null;
  if (category && (typeof payload.orderPublicId !== 'string' || !payload.orderPublicId
    || typeof payload.country !== 'string' || !/^[A-Z]{2}$/.test(payload.country))) return null;
  if (category === 'orders' && (typeof payload.userPublicId !== 'string' || !payload.userPublicId)) return null;
  const seller = await SellerOrder.findOne({ publicId: event.aggregatePublicId,
    ...(category ? { orderPublicId: payload.orderPublicId, country: payload.country } : {}) })
    .select('orderId orderPublicId country storeId storePublicId currency status').lean();
  const order = seller && await Order.findOne({ _id: seller.orderId, publicId: seller.orderPublicId, country: seller.country,
    'totals.currency': seller.currency, items: { $elemMatch: { storeId: seller.storeId, storePublicId: seller.storePublicId, currency: seller.currency } } })
    .select('publicId userId contact.email status fulfillmentState cancellationState').lean();
  if (!order) return null;
  const routine = category === 'orders' || !category && payload.subject === SELLER_FULFILMENT_EMAIL_SUBJECT;
  if (routine && (seller.status !== 'ready' || !['confirmed', 'paid', 'partially_refunded'].includes(order.status)
    || !['none', 'rejected'].includes(order.cancellationState)
    || ['shipped', 'delivered', 'cancelled'].includes(order.fulfillmentState))) return null;
  const user = order.userId && await User.findOne({ _id: order.userId,
    ...(category && payload.userPublicId ? { publicId: payload.userPublicId } : {}), status: 'active', emailVerifiedAt: { $type: 'date' } })
    .select('email preferences.notifications').lean();
  if (routine) return user && (!category || payload.userPublicId) && customerNotificationEnabled(user, 'orders')
    ? { email: user.email, subject: payload.subject, text: payload.body } : null;
  const store = await Store.findOne({ _id: seller.storeId, publicId: seller.storePublicId, country: seller.country,
    currency: seller.currency, status: { $in: ['verified', 'pending_verification', 'suspended'] } }).select('name').lean();
  // Historical service messages used this exact source-bound envelope. Unknown
  // old work is cancelled instead of treating its cached email as authority.
  if (!store || typeof payload.subject !== 'string' || !category && !payload.subject.startsWith(`${store.name}: `)
    || typeof payload.body !== 'string' || !payload.body.startsWith(`About order ${order.publicId}\n\n`)) return null;
  const email = order.userId ? user?.email : order.contact?.email;
  return email ? { email, subject: payload.subject, text: payload.body } : null;
}

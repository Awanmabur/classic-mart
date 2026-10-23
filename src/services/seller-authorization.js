import mongoose from 'mongoose';
import { CountrySetting, PlatformGrant, Store, StoreMember } from '../models/index.js';

/** Navigation context only. Every operational service reloads its authority. */
export async function hydrateSellerAuthorization(request) {
  const actor = request.user;
  if (actor?.storeMembershipContext) delete actor.storeMembershipContext;
  const selected = request.session?.activeStorePublicId;
  if (!actor?._id || actor.status !== 'active' || !['customer', 'seller'].includes(actor.role)
    || actor.platformAccessManagedAt || actor.authorizationContext?.platformManaged
    || typeof selected !== 'string' || !/^[A-Za-z0-9_-]{4,120}$/.test(selected)) return null;
  if (await PlatformGrant.exists({ userId: actor._id })) return null;
  const store = await Store.findOne({ publicId: selected, status: mongoose.trusted({ $in: ['verified', 'pending_verification', 'suspended'] }) }).lean();
  if (!store) return null;
  const membership = await StoreMember.findOne({ storeId: store._id, userId: actor._id, status: 'active',
    acceptedAt: mongoose.trusted({ $type: 'date' }) }).lean();
  const owns = String(store.ownerUserId) === String(actor._id);
  if (!membership || (membership.role === 'owner') !== owns || owns && actor.role !== 'seller') return null;
  if (!await CountrySetting.exists({ code: store.country, currency: store.currency, active: true })) return null;
  const context = { active: true, storePublicId: store.publicId, role: membership.role };
  Object.defineProperty(actor, 'storeMembershipContext', { value: context, configurable: true, enumerable: false });
  return context;
}

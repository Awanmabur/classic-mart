import { publicId, slugify } from '../core/ids.js';
import { AppError } from '../core/errors.js';
import { Store, StoreMember } from '../models/index.js';

const capabilityMap = Object.freeze({
  owner: ['*'],
  admin: ['catalogue','inventory','fulfilment','support','finance','growth','staff'],
  catalogue: ['catalogue','inventory'],
  fulfilment: ['inventory','fulfilment'],
  finance: ['finance'],
  support: ['support'],
});
export function storeCapabilities(role) { return new Set(capabilityMap[role] || []); }

async function ensureOwnerMembership(store, user) {
  return StoreMember.findOneAndUpdate(
    { storeId: store._id, userId: user._id },
    { $set: { role: 'owner', status: 'active', acceptedAt: store.createdAt || new Date() }, $setOnInsert: { publicId: publicId('stm'), invitedByUserId: user._id, invitedAt: store.createdAt || new Date() } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
}

export async function getOrCreateStore(user) {
  const owned = await Store.findOne({ ownerUserId: user._id });
  if (owned) return { store: owned, membership: await ensureOwnerMembership(owned, user) };

  const membership = await StoreMember.findOne({ userId: user._id, status: 'active' }).sort({ acceptedAt: 1 });
  if (membership) {
    const store = await Store.findOne({ _id: membership.storeId, status: { $ne: 'closed' } });
    if (store) return { store, membership };
  }

  if (user.role !== 'seller') throw new AppError('You are not an active member of a seller store.', 403, 'SELLER_STORE_ACCESS_REQUIRED');
  const baseName = user.roleProfile?.businessName || user.roleProfile?.publicName || `${user.name}'s Store`;
  const baseSlug = slugify(baseName); let slug = baseSlug; let suffix = 1;
  while (await Store.exists({ slug })) { suffix += 1; slug = `${baseSlug.slice(0, 88)}-${suffix}`; }
  const store = await Store.create({ publicId: publicId('str'), ownerUserId: user._id, name: baseName, slug, description: user.roleProfile?.bio || '', country: user.country, currency: user.currency });
  return { store, membership: await ensureOwnerMembership(store, user) };
}

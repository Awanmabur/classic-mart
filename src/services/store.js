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

export async function sellerStoreAccesses(user) {
  const [ownedStores, memberships] = await Promise.all([
    Store.find({ ownerUserId: user._id, status: { $ne: 'closed' } }).sort({ createdAt: 1 }).lean(),
    StoreMember.find({ userId: user._id, status: 'active' }).sort({ acceptedAt: 1 }).lean(),
  ]);
  const memberStoreIds = memberships.map((row) => row.storeId);
  const memberStores = memberStoreIds.length
    ? await Store.find({ _id: { $in: memberStoreIds }, status: { $ne: 'closed' } }).lean()
    : [];
  const membershipByStore = new Map(memberships.map((row) => [String(row.storeId), row]));
  const access = new Map();
  for (const store of ownedStores) access.set(store.publicId, { store, role: 'owner', membership: membershipByStore.get(String(store._id)) || null });
  for (const store of memberStores) {
    if (access.has(store.publicId)) continue;
    const membership = membershipByStore.get(String(store._id));
    if (membership) access.set(store.publicId, { store, role: membership.role, membership });
  }
  return [...access.values()];
}

export async function getOrCreateStore(user, { preferredStorePublicId = '', strictPreferred = false } = {}) {
  let accesses = await sellerStoreAccesses(user);
  const preferred = String(preferredStorePublicId || '').trim();
  let selected = preferred ? accesses.find((row) => row.store.publicId === preferred) : null;
  if (preferred && !selected && strictPreferred) throw new AppError('Selected seller workspace is unavailable.', 403, 'SELLER_WORKSPACE_FORBIDDEN');
  selected ||= accesses[0] || null;

  if (!selected) {
    if (user.role !== 'seller') throw new AppError('You are not an active member of a seller store.', 403, 'SELLER_STORE_ACCESS_REQUIRED');
    const baseName = user.roleProfile?.businessName || user.roleProfile?.publicName || `${user.name}'s Store`;
    const baseSlug = slugify(baseName); let slug = baseSlug; let suffix = 1;
    while (await Store.exists({ slug })) { suffix += 1; slug = `${baseSlug.slice(0, 88)}-${suffix}`; }
    const store = await Store.create({ publicId: publicId('str'), ownerUserId: user._id, name: baseName, slug, description: user.roleProfile?.bio || '', country: user.country, currency: user.currency });
    const membership = await ensureOwnerMembership(store, user);
    accesses = [{ store: store.toObject(), role: 'owner', membership }];
    selected = accesses[0];
  }

  const store = await Store.findById(selected.store._id);
  let membership = selected.membership ? await StoreMember.findById(selected.membership._id) : null;
  if (store.ownerUserId.equals(user._id)) membership = await ensureOwnerMembership(store, user);
  if (!membership || membership.status !== 'active') throw new AppError('Selected seller workspace membership is inactive.', 403, 'SELLER_WORKSPACE_FORBIDDEN');
  const availableStores = accesses.map((row) => ({
    publicId: row.store.publicId,
    name: row.store.name,
    country: row.store.country,
    currency: row.store.currency,
    status: row.store.status,
    role: row.role,
  }));
  return { store, membership, availableStores };
}

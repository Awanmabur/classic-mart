import { publicId, slugify } from '../core/ids.js';
import { AppError } from '../core/errors.js';
import { Store, StoreMember, User, PlatformGrant, CountrySetting } from '../models/index.js';

const capabilityMap = Object.freeze({
  owner: ['*'],
  admin: ['catalogue','inventory','fulfilment','support','finance','growth','staff','analytics'],
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
  const actor = await User.findById(user?._id);
  if (!actor || actor.status !== 'active' || !['seller', 'customer'].includes(actor.role)
    || actor.security.tokenVersion !== user.security?.tokenVersion || actor.platformAccessManagedAt
    || await PlatformGrant.exists({ userId: actor._id })) throw new AppError('This account cannot access a seller workspace.', 403, 'SELLER_IDENTITY_FORBIDDEN');
  const [ownedStores, memberships] = await Promise.all([
    actor.role === 'seller' ? Store.find({ ownerUserId: actor._id, status: { $in: ['pending_verification', 'verified', 'suspended'] } }).sort({ createdAt: 1 }).lean() : [],
    StoreMember.find({ userId: actor._id, status: 'active', acceptedAt: { $type: 'date' } }).sort({ acceptedAt: 1 }).lean(),
  ]);
  const memberStoreIds = memberships.map((row) => row.storeId);
  const memberStores = memberStoreIds.length
    ? await Store.find({ _id: { $in: memberStoreIds }, status: { $in: ['pending_verification', 'verified', 'suspended'] } }).lean()
    : [];
  const membershipByStore = new Map(memberships.map((row) => [String(row.storeId), row]));
  const access = new Map();
  for (const store of ownedStores) access.set(store.publicId, { store, role: 'owner', membership: membershipByStore.get(String(store._id)) || null });
  for (const store of memberStores) {
    if (access.has(store.publicId)) continue;
    const membership = membershipByStore.get(String(store._id));
    if (membership) access.set(store.publicId, { store, role: membership.role, membership });
  }
  const rows = [...access.values()], ownerIds = rows.map(row => row.store.ownerUserId);
  const [owners, markets, ownerGrants] = await Promise.all([
    User.find({ _id: { $in: ownerIds }, role: 'seller', status: 'active', platformAccessManagedAt: null }).select('_id').lean(),
    CountrySetting.find({ active: true }).select('code currency').lean(),
    PlatformGrant.find({ userId: { $in: ownerIds } }).select('userId').lean(),
  ]);
  const validOwners = new Set(owners.map(row => String(row._id)));
  return rows.filter(row => validOwners.has(String(row.store.ownerUserId))
    && !ownerGrants.some(grant => String(grant.userId) === String(row.store.ownerUserId))
    && markets.some(market => market.code === row.store.country && market.currency === row.store.currency)
    && (row.role !== 'owner' || actor.role === 'seller' && String(row.store.ownerUserId) === String(actor._id))
    && (String(row.store.ownerUserId) !== String(actor._id) || row.role === 'owner'));
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
    let store;
    for (let attempt = 0; attempt < 5 && !store; attempt += 1) {
      try {
        store = await Store.create({ publicId: publicId('str'), ownerUserId: user._id, name: baseName, slug, description: user.roleProfile?.bio || '', country: user.country, currency: user.currency });
      } catch (error) {
        if (error.code !== 11000) throw error;
        // A simultaneous first request may already have created this owner's store.
        store = await Store.findOne({ ownerUserId: user._id });
        if (store?.status === 'closed') throw new AppError('Your store is closed.', 409, 'SELLER_STORE_CLOSED');
        if (!store) { suffix += 1; slug = `${baseSlug.slice(0, 88)}-${suffix}`; }
      }
    }
    if (!store) throw new AppError('Store creation conflicted. Please retry.', 409, 'SELLER_STORE_CONFLICT');
    const membership = await ensureOwnerMembership(store, user);
    accesses = [{ store: store.toObject(), role: 'owner', membership }];
    selected = accesses[0];
  }

  const store = await Store.findOne({ _id: selected.store._id, status: { $in: ['pending_verification', 'verified', 'suspended'] } });
  if (!store) throw new AppError('Selected seller workspace is unavailable.', 403, 'SELLER_WORKSPACE_FORBIDDEN');
  let membership = selected.membership ? await StoreMember.findById(selected.membership._id) : null;
  if (user.role === 'seller' && store.ownerUserId.equals(user._id)) membership = await ensureOwnerMembership(store, user);
  if (!membership || membership.status !== 'active' || membership.role !== 'owner' && !(membership.acceptedAt instanceof Date)) throw new AppError('Selected seller workspace membership is inactive.', 403, 'SELLER_WORKSPACE_FORBIDDEN');
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

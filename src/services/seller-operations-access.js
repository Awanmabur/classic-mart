import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { env } from '../config/env.js';
import { CountrySetting, Store, StoreMember, PlatformGrant, User } from '../models/index.js';
import { currentCustomerAccess } from './customer-access.js';
import { storeCapabilities } from './store.js';
export const sellerConflict = () => new AppError('This record changed. Reload before continuing.', 409, 'SELLER_VERSION_CONFLICT');
export const sameSellerId = (a, b) => String(a || '') === String(b || '');
export async function sellerTransaction(work) {
  const session = await mongoose.startSession();
  try { return await session.withTransaction(() => work(session)); }
  finally { await session.endSession(); }
}
export function sellerVersion(record, version) {
  if (!/^(0|[1-9]\d*)$/.test(String(version)) || !Number.isSafeInteger(Number(version)) || Number(record.__v || 0) !== Number(version)) throw sellerConflict();
}
export async function sellerOperationsActor(request, { session = null, write = false, requireMfa = true } = {}) {
  if (!request.mobileSession && (typeof request.sessionID !== 'string' || !request.sessionID)) throw new AppError('A current signed-in device is required for store operations.', 403, 'ACCOUNT_UNAVAILABLE');
  const actor = await currentCustomerAccess(request, { session, write });
  if (!['seller', 'customer'].includes(actor.role) || actor.platformAccessManagedAt
    || await PlatformGrant.exists({ userId: actor._id }).session(session)) {
    throw new AppError('This account cannot exercise seller permissions.', 403, 'SELLER_IDENTITY_FORBIDDEN');
  }
  if (requireMfa && !env.auth.simpleLogin && env.security.privilegedMfaRequired && !actor.security.mfaEnabled) throw new AppError('Authenticator enrollment is required for store operations.', 403, 'MFA_ENROLLMENT_REQUIRED');
  return actor;
}
/** Current device, identity, membership, owner and active market share the write transaction. */
export async function sellerOperationsAccess(request, capability, { session = null, write = false, allowSuspended = false, storePublicId } = {}) {
  if (!storePublicId && !request.store?._id) throw new AppError('Select an available seller store.', 403, 'SELLER_STORE_ACCESS_REQUIRED');
  const actorQuery = () => sellerOperationsActor(request, { session, write });
  const storeQuery = () => Store.findOne(storePublicId ? { publicId: storePublicId } : { _id: request.store._id }).session(session);
  // Independent reads can overlap outside a transaction. MongoDB transaction
  // operations remain ordered, including every write fence below.
  const [actor, store] = session ? [await actorQuery(), await storeQuery()]
    : await Promise.all([actorQuery(), storeQuery()]);
  if (!store || !['pending_verification', 'verified', ...(allowSuspended ? ['suspended'] : [])].includes(store.status)) throw new AppError('This store is unavailable for trading.', 409, 'STORE_LOCKED');
  const owns = sameSellerId(store.ownerUserId, actor._id);
  const memberQuery = () => StoreMember.findOne({ storeId: store._id, userId: actor._id, status: 'active' }).session(session);
  const ownerQuery = () => User.findOne({ _id: store.ownerUserId, role: 'seller', status: 'active', platformAccessManagedAt: null }).session(session);
  const grantQuery = () => PlatformGrant.exists({ userId: store.ownerUserId }).session(session);
  const countryQuery = () => CountrySetting.findOne({ code: store.country, currency: store.currency, active: true }).session(session);
  const [member, owner, ownerGrant, country] = session
    ? [await memberQuery(), await ownerQuery(), await grantQuery(), await countryQuery()]
    : await Promise.all([memberQuery(), owns ? actor.role === 'seller' ? actor : null : ownerQuery(),
      // sellerOperationsActor just checked this same current actor's grants.
      owns ? null : grantQuery(), countryQuery()]);
  const capabilities = storeCapabilities(member?.role);
  if (!owner || !member || ownerGrant
    || member.role !== 'owner' && !(member.acceptedAt instanceof Date)
    || capability && !capabilities.has('*') && !capabilities.has(capability)
    || member.role === 'owner' && (!sameSellerId(store.ownerUserId, actor._id) || actor.role !== 'seller')
    || sameSellerId(store.ownerUserId, actor._id) && member.role !== 'owner') throw new AppError('Your current store role does not allow this action.', 403, 'STORE_PERMISSION_DENIED');
  if (!country) throw new AppError('The store market is unavailable.', 409, 'STORE_MARKET_UNAVAILABLE');
  if (!storePublicId && (store.country !== request.store.country || store.currency !== request.store.currency)) throw sellerConflict();
  if (write) {
    if (!session?.inTransaction()) throw new AppError('Store changes require a transaction.', 500, 'SELLER_TRANSACTION_REQUIRED');
    for (const [Model, record, scope] of [[StoreMember, member, { status: 'active', role: member.role }], [Store, store, { status: store.status, country: store.country, currency: store.currency }], [CountrySetting, country, { active: true, code: store.country, currency: store.currency }], ...(!sameSellerId(owner._id, actor._id) ? [[User, owner, { status: 'active', role: 'seller', 'security.tokenVersion': owner.security.tokenVersion }]] : [])]) {
      const changed = await Model.updateOne({ _id: record._id, __v: record.__v || 0, ...scope }, { $inc: { __v: 1 }, ...(Model === StoreMember ? { $set: { permissionVersion: member.permissionVersion || 0 } } : {}) }, { session });
      if (changed.modifiedCount !== 1) throw sellerConflict();
      record.__v = (record.__v || 0) + 1;
    }
  }
  return { actor, member, store, country };
}
export function sellerCapabilityLanding(role) {
  return ({ owner: '/seller/overview', admin: '/seller/overview', catalogue: '/seller/products', fulfilment: '/seller/orders', finance: '/seller/earnings', support: '/seller/messages' })[role] || '/dashboard';
}

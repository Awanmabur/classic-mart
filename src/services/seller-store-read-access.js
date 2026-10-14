import { AppError } from '../core/errors.js';
import { Store, StoreMember, User } from '../models/index.js';
import { storeCapabilities } from './store.js';

/** Fresh settings reads preserve the existing locked view for suspended stores. */
export async function sellerStoreReadAccess(request) {
  if (!request.user?._id || !request.store?._id) throw new AppError('Seller authentication is required.', 401, 'UNAUTHENTICATED');
  const [actor, store, member] = await Promise.all([
    User.findById(request.user._id).select('status security.tokenVersion'),
    Store.findById(request.store._id),
    StoreMember.findOne({ storeId: request.store._id, userId: request.user._id, status: 'active' }),
  ]);
  if (!actor || actor.status !== 'active' || actor.security.tokenVersion !== request.user.security?.tokenVersion ||
    (request.session?.tokenVersion !== undefined && request.session.tokenVersion !== actor.security.tokenVersion)) {
    throw new AppError('Your account or session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
  }
  const capabilities = storeCapabilities(member?.role);
  if (!member || (!capabilities.has('*') && !capabilities.has('staff'))) {
    throw new AppError('Your store role cannot view store settings.', 403, 'STORE_PERMISSION_DENIED');
  }
  if (!store || !['pending_verification', 'verified', 'suspended'].includes(store.status)) {
    throw new AppError('This store is unavailable.', 409, 'STORE_LOCKED');
  }
  return { store, member };
}

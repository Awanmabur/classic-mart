import { AppError } from '../core/errors.js';
import { getOrCreateStore, storeCapabilities } from '../services/store.js';

export async function loadSellerStore(request, response, next) {
  try {
    const access = await getOrCreateStore(request.user);
    request.store = access.store;
    request.storeMembership = access.membership;
    response.locals.store = access.store;
    response.locals.storeMembership = access.membership;
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireStoreCapability(capability) {
  return function storeCapability(request, _response, next) {
    const granted = storeCapabilities(request.storeMembership?.role);
    if (granted.has('*') || granted.has(capability)) return next();
    return next(new AppError('Your store staff role does not allow that action.', 403, 'STORE_PERMISSION_DENIED'));
  };
}

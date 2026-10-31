import { AppError } from '../core/errors.js';
import { getOrCreateStore, storeCapabilities } from '../services/store.js';
import { currentCustomerAccess } from '../services/customer-access.js';

export async function loadSellerStore(request, response, next) {
  try {
    await currentCustomerAccess(request);
    const access = await getOrCreateStore(request.user, { preferredStorePublicId: request.session?.activeStorePublicId || '', strictPreferred: Boolean(request.session?.activeStorePublicId) });
    request.store = access.store;
    request.storeMembership = access.membership;
    response.locals.store = access.store;
    response.locals.storeMembership = access.membership;
    response.locals.availableStores = access.availableStores;
    if (request.session) request.session.activeStorePublicId = access.store.publicId;
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireStoreCapability(capability) {
  return function storeCapability(request, _response, next) {
    if (request.store?.status === 'suspended') {
      const path = request.path.toLowerCase().replace(/\/$/, '');
      const policyCase = /^\/seller\/(?:trust-cases|cases)(?:\/|$)/.test(path);
      const billingRead = request.method === 'GET' && path === '/seller/subscription';
      const lockedSettingsRead = request.method === 'GET' && path === '/seller/store';
      const billingControl = request.method === 'POST' && /^\/seller\/subscription\/(?:enrollments\/[^/]+\/cancel|payments\/[^/]+\/reconcile)$/.test(path);
      if (!policyCase && !billingRead && !lockedSettingsRead && !billingControl) return next(new AppError('Trading is suspended. Review your private policy cases.', 409, 'STORE_LOCKED'));
    }
    const granted = storeCapabilities(request.storeMembership?.role);
    if (granted.has('*') || granted.has(capability)) return next();
    return next(new AppError('Your store staff role does not allow that action.', 403, 'STORE_PERMISSION_DENIED'));
  };
}

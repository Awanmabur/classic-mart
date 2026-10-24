import { sellerOperationsAccess } from './seller-operations-access.js';

/** Settings reads share current identity, device and store authorization while
 * retaining the private locked view for suspended stores. */
export async function sellerStoreReadAccess(request) {
  return sellerOperationsAccess(request, 'staff', { allowSuspended: true });
}

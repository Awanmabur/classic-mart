import mongoose from 'mongoose';
import { Store, StoreMember } from '../models/index.js';
import { AppError } from '../core/errors.js';
import { storeCapabilities } from './store.js';
import { writeAudit } from './audit.js';
import { clearStorefrontCache } from './storefront.js';
import { sellerStoreIdentitySchema, sellerStoreOperationsSchema } from '../validation/seller-store.js';
import { getPhoneCountries } from './phone-countries.js';

// Recheck membership in the transaction; never accept a store ID from a form.
export async function saveSellerStoreSettings(request, section) {
  const schema = section === 'identity' ? sellerStoreIdentitySchema :
    section === 'operations' ? sellerStoreOperationsSchema : null;
  if (!schema) throw new AppError('Unknown store settings section.', 422, 'STORE_SECTION_INVALID');
  const input = schema.parse(request.body);
  if (section === 'identity' && !getPhoneCountries().some(country => country.code === input.supportPhoneCountry)) {
    throw new AppError('Choose an available phone country.', 422, 'COUNTRY_UNAVAILABLE');
  }
  const session = await mongoose.startSession();
  let saved;
  try {
    await session.withTransaction(async () => {
      const membership = await StoreMember.findOne({ storeId: request.store._id, userId: request.user._id, status: 'active' }).session(session);
      const capabilities = storeCapabilities(membership?.role);
      if (!capabilities.has('*') && !capabilities.has('staff')) throw new AppError('Your store staff role does not allow that action.', 403, 'STORE_PERMISSION_DENIED');
      const store = await Store.findById(request.store._id).session(session);
      if (!store || !['pending_verification', 'verified'].includes(store.status)) throw new AppError('This store cannot be edited in its current state.', 409, 'STORE_LOCKED');
      if (store.__v !== input.version) throw new AppError('Store settings changed. Reload this page before saving.', 409, 'STORE_VERSION_CONFLICT');
      const operations = store.operations?.toObject?.() || {};
      if (section === 'identity') {
        store.name = input.name;
        store.description = input.description;
        store.operations = { ...operations, supportEmail: input.supportEmail, supportPhone: input.supportPhone };
      } else {
        store.operations = { ...operations, primaryCategory: input.primaryCategory, pickupCity: input.pickupCity, fulfillmentMode: input.fulfillmentMode };
      }
      // Explicitly increment even for an unchanged submission so stale forms fail.
      store.increment();
      await store.save({ session });
      await writeAudit(request, 'seller.store_settings_updated', {
        targetType: 'store', targetPublicId: store.publicId, metadata: { section }, session,
      });
      saved = store;
    });
  } finally { await session.endSession(); }
  clearStorefrontCache();
  return saved;
}

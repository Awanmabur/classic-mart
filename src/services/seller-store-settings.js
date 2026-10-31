import mongoose from 'mongoose';
import { Store } from '../models/index.js';
import { AppError } from '../core/errors.js';
import { sellerOperationsAccess, sellerConflict } from './seller-operations-access.js';
import { writeAudit } from './audit.js';
import { clearStorefrontCache } from './storefront.js';
import { sellerStoreIdentitySchema, sellerStoreOperationsSchema } from '../validation/seller-store.js';
import { getPhoneCountries } from './phone-countries.js';

// Recheck and fence authority in the transaction; never accept a form store ID.
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
      const initial = await sellerOperationsAccess(request, 'staff', { session });
      // Compare the form revision before the shared authority fence advances it.
      if (Number(initial.store.__v || 0) !== input.version) throw new AppError('Store settings changed. Reload this page before saving.', 409, 'STORE_VERSION_CONFLICT');
      const { store, actor } = await sellerOperationsAccess(request, 'staff', { session, write: true });
      const operations = store.operations?.toObject?.() || {};
      const changes = {};
      if (section === 'identity') {
        changes.name = input.name;
        changes.description = input.description;
        changes.operations = { ...operations, supportEmail: input.supportEmail, supportPhone: input.supportPhone };
      } else {
        changes.operations = { ...operations, primaryCategory: input.primaryCategory, pickupCity: input.pickupCity, fulfillmentMode: input.fulfillmentMode };
      }
      // The shared fence already advances the Store revision, including no-op
      // forms. Apply only the permitted fields without a second revision bump.
      saved = await Store.findOneAndUpdate({ _id: store._id, __v: store.__v }, { $set: changes },
        { session, returnDocument: 'after', runValidators: true });
      if (!saved) throw sellerConflict();
      await writeAudit(request, 'seller.store_settings_updated', {
        actor, country: store.country, targetType: 'store', targetPublicId: store.publicId, metadata: { section }, session,
      });
    });
  } finally { await session.endSession(); }
  clearStorefrontCache();
  return saved;
}

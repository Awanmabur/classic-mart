import mongoose from 'mongoose';
import { Store, StoreMember, User } from '../models/index.js';
import { AppError } from '../core/errors.js';
import { env } from '../config/env.js';
import { storeCapabilities } from './store.js';
import { writeAudit } from './audit.js';
import { clearStorefrontCache } from './storefront.js';
import { sellerStoreIdentitySchema, sellerStoreOperationsSchema } from '../validation/seller-store.js';
import { getPhoneCountries } from './phone-countries.js';

async function lockSettingsAuthority(request, session) {
  if (!request.user?._id || !request.store?._id) throw new AppError('Seller authentication is required.', 401, 'UNAUTHENTICATED');
  const actor = await User.findById(request.user._id)
    .select('status security.tokenVersion security.mfaEnabled emailVerifiedAt onboardingCompletedAt').session(session).lean();
  if (!actor || actor.status !== 'active' || !Number.isSafeInteger(actor.security?.tokenVersion) || actor.security.tokenVersion < 0 ||
    actor.security.tokenVersion !== request.user.security?.tokenVersion ||
    (request.session?.tokenVersion !== undefined && actor.security.tokenVersion !== request.session.tokenVersion)) {
    throw new AppError('Your account or session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
  }
  if (!env.auth.simpleLogin && (!actor.emailVerifiedAt || !actor.onboardingCompletedAt)) {
    throw new AppError('Complete verification and onboarding before managing store settings.', 403, 'ACCOUNT_UNAVAILABLE');
  }
  if (!env.auth.simpleLogin && env.security.privilegedMfaRequired && !actor.security.mfaEnabled) {
    throw new AppError('Authenticator enrollment is required for store operations.', 403, 'MFA_ENROLLMENT_REQUIRED');
  }
  const membership = await StoreMember.findOne({ storeId: request.store._id, userId: actor._id, status: 'active' }).session(session);
  const capabilities = storeCapabilities(membership?.role);
  if (!capabilities.has('*') && !capabilities.has('staff')) {
    throw new AppError('Your store staff role does not allow that action.', 403, 'STORE_PERMISSION_DENIED');
  }
  // A snapshot read alone can outlive a concurrent suspension or revocation.
  // Write both authority records so MongoDB retries and rechecks that change
  // before any store settings or audit evidence can commit.
  const actorFence = await User.updateOne({ _id: actor._id, status: 'active', 'security.tokenVersion': actor.security.tokenVersion },
    { $inc: { __v: 1 } }, { session });
  if (actorFence.modifiedCount !== 1) throw new AppError('Your account or session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
  const memberFence = await StoreMember.updateOne({ _id: membership._id, storeId: request.store._id, userId: actor._id,
    status: 'active', role: membership.role }, { $inc: { __v: 1 } }, { session });
  if (memberFence.modifiedCount !== 1) throw new AppError('Your store staff role does not allow that action.', 403, 'STORE_PERMISSION_DENIED');
}

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
      await lockSettingsAuthority(request, session);
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

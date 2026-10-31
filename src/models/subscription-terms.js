import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
export const DEFAULT_SELLER_ENTITLEMENTS = Object.freeze({ productLimit: 50, seatLimit: 1, campaignLimit: 1, analyticsDays: 30, analyticsExport: false });
const limit = n => ({ type: Number, min: 0, max: 1000000, default: n, validate: Number.isSafeInteger });
export const subscriptionEntitlementsSchema = new mongoose.Schema({
  productLimit: limit(50), seatLimit: { ...limit(1), min: 1 }, campaignLimit: limit(1), analyticsDays: { ...limit(30), min: 1, max: 3660 }, analyticsExport: { type: Boolean, default: false },
}, { _id: false });
export const subscriptionTermsSchema = new mongoose.Schema({
  planPublicId: { type: String, required: true }, planVersion: { type: Number, required: true, min: 0 }, name: { type: String, required: true, maxlength: 140 },
  priceMinor: { type: Number, required: true, min: 0, validate: Number.isSafeInteger }, currency: { type: String, required: true }, country: { type: String, required: true },
  cadence: { type: String, required: true, enum: ['monthly', 'quarterly', 'yearly', 'one_time'] }, entitlements: { type: subscriptionEntitlementsSchema, required: true },
}, { _id: false });

/** Single-nested immutable paths also need to reject edits to their child fields. */
export function protectSubscriptionTerms(schema, paths = ['terms']) {
  schema.pre('save', async function protectSavedTerms() {
    const changed = paths.filter(path => this.isModified(path));
    if (this.isNew || !changed.length) return;
    const original = await this.constructor.findById(this._id).select(changed.join(' ')).session(this.$session()).lean();
    for (const path of changed) {
      const value = this.get(path)?.toObject?.() || this.get(path);
      if (original?.[path] && JSON.stringify(original[path]) !== JSON.stringify(value)) throw new AppError('Reviewed subscription terms cannot be changed.', 409, 'SUBSCRIPTION_TERMS_IMMUTABLE');
    }
  });
}

import mongoose from 'mongoose';

const { Schema } = mongoose;

const subscriptionChangeRequestSchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true, immutable: true, index: true },
    audience: { type: String, enum: ['seller', 'promoter'], required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', index: true },
    storePublicId: { type: String, trim: true, maxlength: 100, default: '', index: true },
    planId: { type: Schema.Types.ObjectId, ref: 'SubscriptionPlan', required: true, index: true },
    planPublicId: { type: String, required: true, trim: true, maxlength: 100, index: true },
    country: { type: String, required: true, uppercase: true, minlength: 2, maxlength: 2, index: true },
    currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },
    requestedPriceMinor: { type: Number, required: true, min: 0 },
    requestedCadence: { type: String, required: true, enum: ['monthly', 'quarterly', 'yearly', 'one_time'] },
    note: { type: String, trim: true, maxlength: 1000, default: '' },
    status: { type: String, enum: ['requested', 'approved', 'rejected', 'cancelled'], default: 'requested', index: true },
    reviewedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    reviewReason: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  { timestamps: true, optimisticConcurrency: true },
);

subscriptionChangeRequestSchema.index({ audience: 1, storeId: 1, status: 1, createdAt: -1 });
subscriptionChangeRequestSchema.index({ userId: 1, status: 1, createdAt: -1 });

export const SubscriptionChangeRequest = mongoose.model(
  'SubscriptionChangeRequest',
  subscriptionChangeRequestSchema,
);

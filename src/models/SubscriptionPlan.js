import mongoose from 'mongoose';

const { Schema } = mongoose;

const subscriptionPlanSchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true, immutable: true, index: true },
    key: { type: String, required: true, trim: true, lowercase: true, maxlength: 80, index: true },
    name: { type: String, required: true, trim: true, maxlength: 140 },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
    audience: { type: String, required: true, enum: ['seller', 'promoter'], index: true },
    country: { type: String, required: true, uppercase: true, minlength: 2, maxlength: 2, index: true },
    currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },
    priceMinor: { type: Number, required: true, min: 0 },
    cadence: { type: String, required: true, enum: ['monthly', 'quarterly', 'yearly', 'one_time'] },
    features: { type: [String], default: [] },
    sortOrder: { type: Number, min: 0, default: 100 },
    status: { type: String, enum: ['draft', 'active', 'retired'], default: 'draft', index: true },
    createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, optimisticConcurrency: true },
);

subscriptionPlanSchema.index({ key: 1, audience: 1, country: 1, currency: 1 }, { unique: true });
subscriptionPlanSchema.index({ audience: 1, country: 1, status: 1, sortOrder: 1 });

export const SubscriptionPlan = mongoose.model('SubscriptionPlan', subscriptionPlanSchema);

import mongoose from 'mongoose';

const { Schema } = mongoose;

const couponSchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true, immutable: true, index: true },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, minlength: 3, maxlength: 32, index: true },
    name: { type: String, required: true, trim: true, maxlength: 140 },
    description: { type: String, trim: true, maxlength: 500, default: '' },
    scope: { type: String, enum: ['platform', 'seller'], default: 'platform', index: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', index: true },
    storePublicId: { type: String, maxlength: 100, default: '', index: true },
    country: { type: String, required: true, uppercase: true, minlength: 2, maxlength: 2, index: true },
    currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },
    status: { type: String, enum: ['draft', 'active', 'paused', 'expired', 'archived'], default: 'draft', index: true },
    discountType: { type: String, enum: ['percent', 'fixed', 'free_shipping'], required: true },
    discountBps: { type: Number, min: 0, max: 10000, default: 0 },
    discountMinor: { type: Number, min: 0, default: 0 },
    minimumSubtotalMinor: { type: Number, min: 0, default: 0 },
    maximumDiscountMinor: { type: Number, min: 0, default: 0 },
    usageLimit: { type: Number, min: 0, default: 0 },
    usageCount: { type: Number, min: 0, default: 0 },
    perUserLimit: { type: Number, min: 0, max: 1000, default: 1 },
    eligibleRoles: { type: [String], default: [] },
    eligibleCategoryPublicIds: { type: [String], default: [] },
    eligibleStorePublicIds: { type: [String], default: [] },
    firstOrderOnly: { type: Boolean, default: false },
    startsAt: { type: Date, index: true },
    endsAt: { type: Date, index: true },
    createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, optimisticConcurrency: true },
);

couponSchema.index({ country: 1, status: 1, startsAt: 1, endsAt: 1 });
couponSchema.index({ country: 1, updatedAt: -1 });

export const Coupon = mongoose.model('Coupon', couponSchema);

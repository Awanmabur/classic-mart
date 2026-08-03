import mongoose from 'mongoose';

const { Schema } = mongoose;

const storeSchema = new Schema(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      index: true,
    },
    ownerUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 140 },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 100,
      index: true,
    },
    description: { type: String, trim: true, maxlength: 1_500, default: '' },
    country: {
      type: String,
      required: true,
      uppercase: true,
      minlength: 2,
      maxlength: 2,
      index: true,
    },
    currency: {
      type: String,
      required: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
    },
    status: {
      type: String,
      enum: ['pending_verification', 'verified', 'suspended', 'closed'],
      default: 'pending_verification',
      index: true,
    },
    verifiedAt: Date,
    suspendedAt: Date,
    suspensionReason: { type: String, maxlength: 1000, default: '' },
    suspendedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, optimisticConcurrency: true },
);

storeSchema.index({ country: 1, status: 1, createdAt: -1 });

export const Store = mongoose.model('Store', storeSchema);

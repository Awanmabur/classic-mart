import mongoose from 'mongoose';

const { Schema } = mongoose;

const productMediaSchema = new Schema(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      index: true,
    },
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      index: true,
    },
    storeId: {
      type: Schema.Types.ObjectId,
      ref: 'Store',
      required: true,
      index: true,
    },
    source: {
      type: String,
      enum: ['upload', 'seed_asset'],
      default: 'upload',
    },
    storageKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
      select: false,
    },
    thumbnailStorageKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
      select: false,
    },
    originalName: { type: String, trim: true, maxlength: 180, default: '' },
    mimeType: { type: String, required: true, enum: ['image/webp'] },
    sizeBytes: { type: Number, required: true, min: 1, max: 12_000_000 },
    width: { type: Number, required: true, min: 1, max: 10_000 },
    height: { type: Number, required: true, min: 1, max: 10_000 },
    checksumSha256: {
      type: String,
      required: true,
      minlength: 64,
      maxlength: 64,
      select: false,
    },
    altText: { type: String, trim: true, maxlength: 180, default: '' },
    position: { type: Number, min: 0, max: 30, default: 0 },
    status: {
      type: String,
      enum: ['quarantined', 'ready', 'approved', 'rejected'],
      default: 'quarantined',
      index: true,
    },
    moderationReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    reviewedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
  },
  { timestamps: true },
);

productMediaSchema.index({ productId: 1, position: 1, createdAt: 1 });
productMediaSchema.index({ storeId: 1, status: 1 });

export const ProductMedia = mongoose.model('ProductMedia', productMediaSchema);

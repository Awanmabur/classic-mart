import mongoose from 'mongoose';

const { Schema } = mongoose;

const productSchema = new Schema(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      index: true,
    },
    storeId: {
      type: Schema.Types.ObjectId,
      ref: 'Store',
      required: true,
      index: true,
    },
    ownerUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    categoryId: {
      type: Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
      index: true,
    },
    brandId: { type: Schema.Types.ObjectId, ref: 'Brand', index: true },
    title: { type: String, required: true, trim: true, maxlength: 180 },
    slug: { type: String, required: true, trim: true, maxlength: 120 },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5_000,
    },
    countries: {
      type: [
        {
          type: String,
          uppercase: true,
          minlength: 2,
          maxlength: 2,
        },
      ],
      validate: {
        validator: (items) => items.length > 0 && items.length <= 20,
        message: 'Choose between 1 and 20 selling countries.',
      },
    },
    tags: {
      type: [{ type: String, trim: true, lowercase: true, maxlength: 40 }],
      validate: {
        validator: (items) => items.length <= 20,
        message: 'A product can have at most 20 tags.',
      },
      default: [],
    },
    attributes: {
      type: Map,
      of: String,
      default: () => new Map(),
    },
    status: {
      type: String,
      enum: [
        'draft',
        'submitted',
        'changes_requested',
        'approved',
        'published',
        'rejected',
        'suspended',
        'archived',
      ],
      default: 'draft',
      index: true,
    },
    qualityScore: { type: Number, min: 0, max: 100, default: 0 },
    moderation: {
      submittedAt: Date,
      reviewedAt: Date,
      reviewedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
      reason: { type: String, trim: true, maxlength: 1_000, default: '' },
    },
    publishedAt: Date,
    suspension: { previousStatus: { type: String, maxlength: 40, default: '' }, reason: { type: String, maxlength: 1000, default: '' }, suspendedAt: Date, suspendedByUserId: { type: Schema.Types.ObjectId, ref: 'User' } },
    archivedAt: Date,
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
  },
);

productSchema.index({ storeId: 1, slug: 1 }, { unique: true });
productSchema.index({ storeId: 1, status: 1, updatedAt: -1 });
productSchema.index({ status: 1, countries: 1, publishedAt: -1 });
productSchema.index({ title: 'text', description: 'text', tags: 'text' });

export const Product = mongoose.model('Product', productSchema);

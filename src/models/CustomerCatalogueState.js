import mongoose from 'mongoose';

const { Schema } = mongoose;

const recentProductSchema = new Schema(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    viewedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const customerCatalogueStateSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      immutable: true,
      index: true,
    },
    wishlistProductIds: {
      type: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
      default: [],
      validate: {
        validator: (items) => items.length <= 500,
        message: 'A wishlist can contain at most 500 products.',
      },
    },
    comparisonProductIds: {
      type: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
      default: [],
      validate: {
        validator: (items) => items.length <= 4,
        message: 'Compare up to four products at a time.',
      },
    },
    recentProducts: {
      type: [recentProductSchema],
      default: [],
      validate: {
        validator: (items) => items.length <= 50,
        message: 'Recent product history can contain at most 50 products.',
      },
    },
    followedStoreIds: {
      type: [{ type: Schema.Types.ObjectId, ref: 'Store' }],
      default: [],
      validate: {
        validator: (items) => items.length <= 100,
        message: 'Follow up to 100 stores.',
      },
    },
    followedPromoterUserIds: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: [],
      validate: {
        validator: (items) => items.length <= 100,
        message: 'Follow up to 100 promoters.',
      },
    },
  },
  { timestamps: true, optimisticConcurrency: true },
);

customerCatalogueStateSchema.index({ 'recentProducts.viewedAt': -1 });

export const CustomerCatalogueState = mongoose.model(
  'CustomerCatalogueState',
  customerCatalogueStateSchema,
);

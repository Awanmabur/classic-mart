import mongoose from 'mongoose';

const { Schema } = mongoose;

const productVariantSchema = new Schema(
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
    sku: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      minlength: 2,
      maxlength: 64,
    },
    barcode: { type: String, trim: true, maxlength: 64, default: '' },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    options: { type: Map, of: String, default: () => new Map() },
    priceMinor: { type: Number, required: true, min: 0, max: 2_000_000_000 },
    costMinor: { type: Number, min: 0, max: 2_000_000_000, default: 0 },
    minimumPriceMinor: { type: Number, min: 0, max: 2_000_000_000, default: 0 },
    compareAtMinor: { type: Number, min: 0, max: 2_000_000_000 },
    currency: {
      type: String,
      required: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
    },
    active: { type: Boolean, default: true, index: true },
    weightGrams: { type: Number, min: 0, max: 2_000_000, default: 0 },
  },
  { timestamps: true, optimisticConcurrency: true },
);

productVariantSchema.index({ storeId: 1, sku: 1 }, { unique: true });
productVariantSchema.index({ storeId: 1, barcode: 1 }, { unique: true, partialFilterExpression: { barcode: { $type: 'string', $gt: '' } } });
productVariantSchema.index({ productId: 1, active: 1, priceMinor: 1 });

export const ProductVariant = mongoose.model(
  'ProductVariant',
  productVariantSchema,
);

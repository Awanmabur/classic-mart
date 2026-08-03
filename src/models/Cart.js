import mongoose from 'mongoose';

const { Schema } = mongoose;

const cartItemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', required: true },
    quantity: { type: Number, required: true, min: 1, max: 99 },
  },
  { _id: false },
);

const cartSchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true, immutable: true, index: true },
    sessionKey: { type: String, required: true, unique: true, immutable: true, index: true, maxlength: 160 },
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    country: { type: String, required: true, uppercase: true, minlength: 2, maxlength: 2, index: true },
    items: { type: [cartItemSchema], default: [] },
    promotionCodes: { type: [String], default: [], validate: { validator: (items) => items.length <= 10, message: 'A cart can contain at most 10 promotion codes.' } },
  },
  { timestamps: true, optimisticConcurrency: true },
);

cartSchema.index({ userId: 1, updatedAt: -1 });

export const Cart = mongoose.model('Cart', cartSchema);

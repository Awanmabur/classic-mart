import mongoose from 'mongoose';

const { Schema } = mongoose;

const inventoryReservationSchema = new Schema(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      index: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
      immutable: true,
      maxlength: 120,
    },
    storeId: {
      type: Schema.Types.ObjectId,
      ref: 'Store',
      required: true,
      index: true,
    },
    stockItemId: {
      type: Schema.Types.ObjectId,
      ref: 'StockItem',
      required: true,
      index: true,
    },
    variantId: {
      type: Schema.Types.ObjectId,
      ref: 'ProductVariant',
      required: true,
      index: true,
    },
    quantity: { type: Number, required: true, min: 1, max: 100_000 },
    status: {
      type: String,
      enum: ['active', 'released', 'committed', 'expired'],
      default: 'active',
      index: true,
    },
    expiresAt: { type: Date, required: true, index: true },
    releasedAt: Date,
    committedAt: Date,
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, optimisticConcurrency: true },
);

inventoryReservationSchema.index({ status: 1, expiresAt: 1 });
inventoryReservationSchema.index(
  { storeId: 1, idempotencyKey: 1 },
  { unique: true },
);

export const InventoryReservation = mongoose.model(
  'InventoryReservation',
  inventoryReservationSchema,
);

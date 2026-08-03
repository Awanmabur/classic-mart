import mongoose from 'mongoose';

const { Schema } = mongoose;

const inventoryMovementSchema = new Schema(
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
    warehouseId: {
      type: Schema.Types.ObjectId,
      ref: 'Warehouse',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: [
        'receipt',
        'adjustment',
        'reservation',
        'release',
        'sale',
        'return',
        'condition',
        'transfer',
        'put_away',
        'pick',
      ],
      required: true,
      index: true,
    },
    quantity: { type: Number, required: true },
    onHandBefore: { type: Number, required: true },
    onHandAfter: { type: Number, required: true },
    reservedBefore: { type: Number, required: true },
    reservedAfter: { type: Number, required: true },
    damagedBefore: { type: Number, default: 0 },
    damagedAfter: { type: Number, default: 0 },
    quarantinedBefore: { type: Number, default: 0 },
    quarantinedAfter: { type: Number, default: 0 },
    binBefore: { type: String, maxlength: 80, default: '' },
    binAfter: { type: String, maxlength: 80, default: '' },
    reason: { type: String, required: true, trim: true, maxlength: 300 },
    reference: { type: String, trim: true, maxlength: 120, default: '' },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

inventoryMovementSchema.index({ storeId: 1, createdAt: -1 });
inventoryMovementSchema.index({ stockItemId: 1, createdAt: -1 });

for (const operation of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'deleteOne',
  'deleteMany',
]) {
  inventoryMovementSchema.pre(operation, function immutableMovement() {
    throw new Error('Inventory movements are immutable.');
  });
}

export const InventoryMovement = mongoose.model(
  'InventoryMovement',
  inventoryMovementSchema,
);

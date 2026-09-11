import mongoose from 'mongoose';

const { Schema } = mongoose;

const inventoryDiscrepancySchema = new Schema({
  publicId: { type: String, required: true, unique: true, immutable: true, index: true },
  sourceKey: { type: String, required: true, unique: true, immutable: true, maxlength: 180 },
  stockItemId: { type: Schema.Types.ObjectId, ref: 'StockItem', required: true, immutable: true, index: true },
  warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse', required: true, immutable: true, index: true },
  storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true, immutable: true, index: true },
  variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', required: true, immutable: true, index: true },
  country: { type: String, required: true, uppercase: true, minlength: 2, maxlength: 2, immutable: true, index: true },
  expectedOnHand: { type: Number, required: true, min: 0, immutable: true },
  countedOnHand: { type: Number, required: true, min: 0, immutable: true },
  variance: { type: Number, required: true, immutable: true },
  reservedSnapshot: { type: Number, required: true, min: 0, immutable: true },
  damagedSnapshot: { type: Number, required: true, min: 0, immutable: true },
  quarantinedSnapshot: { type: Number, required: true, min: 0, immutable: true },
  reason: { type: String, required: true, trim: true, maxlength: 300, immutable: true },
  status: { type: String, enum: ['pending_review', 'no_variance', 'approved', 'rejected'], required: true, index: true },
  countedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
  countedAt: { type: Date, required: true, default: Date.now, immutable: true },
  reviewedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
  reviewNote: { type: String, trim: true, maxlength: 300, default: '' },
  adjustmentMovementId: { type: Schema.Types.ObjectId, ref: 'InventoryMovement' },
}, { timestamps: true, optimisticConcurrency: true });

inventoryDiscrepancySchema.index({ country: 1, status: 1, createdAt: -1 });
inventoryDiscrepancySchema.index({ warehouseId: 1, status: 1, createdAt: -1 });

export const InventoryDiscrepancy = mongoose.model('InventoryDiscrepancy', inventoryDiscrepancySchema);

import mongoose from 'mongoose';

const { Schema } = mongoose;

const stockItemSchema = new Schema(
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
    warehouseId: {
      type: Schema.Types.ObjectId,
      ref: 'Warehouse',
      required: true,
      index: true,
    },
    variantId: {
      type: Schema.Types.ObjectId,
      ref: 'ProductVariant',
      required: true,
      index: true,
    },
    onHand: { type: Number, min: 0, max: 2_000_000_000, default: 0 },
    reserved: { type: Number, min: 0, max: 2_000_000_000, default: 0 },
    damaged: { type: Number, min: 0, max: 2_000_000_000, default: 0 },
    quarantined: { type: Number, min: 0, max: 2_000_000_000, default: 0 },
    binCode: { type: String, trim: true, maxlength: 80, default: '' },
    reorderPoint: { type: Number, min: 0, max: 2_000_000_000, default: 0 },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

stockItemSchema.virtual('available').get(function available() {
  return this.onHand - this.reserved - this.damaged - this.quarantined;
});
function unavailableState(document, reservedOverride) {
  const reserved = reservedOverride ?? document.reserved ?? 0;
  const damaged = document.damaged ?? 0;
  const quarantined = document.quarantined ?? 0;
  const onHand = document.onHand;
  return typeof onHand !== 'number' || reserved + damaged + quarantined <= onHand;
}
for (const pathName of ['reserved','damaged','quarantined']) {
  stockItemSchema.path(pathName).validate(function validUnavailable(value) {
    if (typeof this.getUpdate === 'function') {
      const update = this.getUpdate() || {};
      const set = update.$set || {};
      const current = {
        onHand: set.onHand ?? update.onHand,
        reserved: pathName === 'reserved' ? value : (set.reserved ?? update.reserved ?? 0),
        damaged: pathName === 'damaged' ? value : (set.damaged ?? update.damaged ?? 0),
        quarantined: pathName === 'quarantined' ? value : (set.quarantined ?? update.quarantined ?? 0),
      };
      return unavailableState(current);
    }
    return unavailableState(this, pathName === 'reserved' ? value : undefined);
  }, 'Reserved, damaged and quarantined stock cannot exceed on-hand stock.');
}
stockItemSchema.index({ warehouseId: 1, variantId: 1 }, { unique: true });
stockItemSchema.index({ storeId: 1, updatedAt: -1 });

export const StockItem = mongoose.model('StockItem', stockItemSchema);

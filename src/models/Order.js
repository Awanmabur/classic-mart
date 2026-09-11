import mongoose from 'mongoose';

const { Schema } = mongoose;

const moneySchema = new Schema(
  {
    subtotalMinor: { type: Number, required: true, min: 0 },
    shippingMinor: { type: Number, required: true, min: 0 },
    discountMinor: { type: Number, required: true, min: 0 },
    taxMinor: { type: Number, required: true, min: 0 },
    totalMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },
  },
  { _id: false },
);

const orderItemSchema = new Schema(
  {
    linePublicId: { type: String, required: true, immutable: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', required: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    reservationPublicId: { type: String, required: true },
    productPublicId: { type: String, required: true },
    variantPublicId: { type: String, required: true },
    storePublicId: { type: String, required: true },
    title: { type: String, required: true, maxlength: 220 },
    variantTitle: { type: String, required: true, maxlength: 120 },
    sku: { type: String, required: true, maxlength: 64 },
    quantity: { type: Number, required: true, min: 1, max: 9999 },
    deliveredQuantity: { type: Number, min: 0, default: 0 },
    returnReservedQuantity: { type: Number, min: 0, default: 0 },
    returnedQuantity: { type: Number, min: 0, default: 0 },
    refundedQuantity: { type: Number, min: 0, default: 0 },
    unitPriceMinor: { type: Number, required: true, min: 0 },
    unitCostMinor: { type: Number, min: 0, default: null, immutable: true },
    costSnapshotStatus: { type: String, enum: ['captured', 'legacy_unknown'], default: 'legacy_unknown', immutable: true },
    lineTotalMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },
  },
  { _id: false },
);

const addressSchema = new Schema(
  {
    fullName: { type: String, required: true, maxlength: 120 },
    email: { type: String, required: true, maxlength: 254 },
    phone: { type: String, required: true, maxlength: 32 },
    address: { type: String, required: true, maxlength: 240 },
    city: { type: String, required: true, maxlength: 120 },
    country: { type: String, required: true, maxlength: 80 },
    note: { type: String, maxlength: 500, default: '' },
  },
  { _id: false },
);

const timelineSchema = new Schema(
  {
    type: { type: String, required: true, maxlength: 80 },
    message: { type: String, required: true, maxlength: 240 },
    at: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true, immutable: true, index: true },
    traceId: { type: String, maxlength: 32, default: '', immutable: true, index: true },
    traceSpanId: { type: String, maxlength: 16, default: '', immutable: true },
    idempotencyKey: { type: String, required: true, immutable: true, maxlength: 120 },
    checkoutId: { type: String, required: true, immutable: true, maxlength: 120 },
    cartPublicId: { type: String, required: true, immutable: true },
    sessionKey: { type: String, required: true, immutable: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    country: { type: String, required: true, uppercase: true, minlength: 2, maxlength: 2, index: true },
    status: {
      type: String,
      enum: ['pending_payment', 'payment_failed', 'confirmed', 'paid', 'cancellation_pending', 'cancelled', 'expired', 'partially_refunded', 'refunded'],
      default: 'pending_payment',
      index: true,
    },
    deliveryMethod: { type: String, enum: ['standard', 'express', 'pickup'], required: true },
    shippingZonePublicId: { type: String, maxlength: 100, default: '' },
    pickupPointPublicId: { type: String, maxlength: 100, default: '' },
    paymentMethod: { type: String, enum: ['card', 'mobile', 'cod', 'exchange', 'pesapal', 'credit_terms'], required: true },
    businessOrganizationId: { type: Schema.Types.ObjectId, ref: 'BusinessOrganization', index: true },
    purchaseOrderId: { type: Schema.Types.ObjectId, ref: 'PurchaseOrder', index: true },
    purchaseOrderPublicId: { type: String, maxlength: 100, default: '', index: true },
    businessInvoiceId: { type: Schema.Types.ObjectId, ref: 'BusinessInvoice', index: true },
    businessInvoicePublicId: { type: String, maxlength: 100, default: '', index: true },
    paymentState: { type: String, enum: ['unpaid','pending','authorized','paid','credit_due','partially_refunded','refunded','failed'], default: 'unpaid', index: true },
    fulfillmentState: { type: String, enum: ['unfulfilled','processing','partially_ready','ready','partially_shipped','shipped','partially_delivered','delivered','cancelled'], default: 'unfulfilled', index: true },
    cancellationState: { type: String, enum: ['none','requested','processing','cancelled','rejected'], default: 'none', index: true },
    returnState: { type: String, enum: ['none','requested','partial_return','returned'], default: 'none', index: true },
    refundState: { type: String, enum: ['none','pending','processing','partial','complete'], default: 'none', index: true },
    contact: { type: addressSchema, required: true },
    totals: { type: moneySchema, required: true },
    items: { type: [orderItemSchema], required: true, validate: value => value.length > 0 },
    sellerOrderPublicIds: { type: [String], default: [] },
    policySnapshot: { returnWindowDays: { type: Number, min: 0, default: 30 }, policyVersion: { type: String, maxlength: 40, default: '2026-07' }, platformFeeBps: { type: Number, min: 0, max: 5000, default: 500 }, taxBps: { type: Number, min: 0, max: 10000, default: 0 } },
    cancellation: { requestedAt: Date, reason: { type: String, maxlength: 300, default: '' }, inventoryRestoredAt: Date, refundPublicId: { type: String, maxlength: 100, default: '' } },
    timeline: { type: [timelineSchema], default: [] },
    reservationExpiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true, optimisticConcurrency: true },
);

orderSchema.index({ sessionKey: 1, idempotencyKey: 1 }, { unique: true });
orderSchema.index({ sessionKey: 1, createdAt: -1 });
orderSchema.index({ userId: 1, createdAt: -1 });

export const Order = mongoose.model('Order', orderSchema);

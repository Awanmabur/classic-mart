import mongoose from 'mongoose';

const { Schema } = mongoose;

const businessDocumentSchema = new Schema({
  publicId: { type: String, required: true, unique: true, immutable: true, index: true },
  eventKey: { type: String, required: true, unique: true, immutable: true, maxlength: 200 },
  documentNumber: { type: String, required: true, unique: true, immutable: true, maxlength: 140, index: true },
  type: { type: String, enum: ['quotation', 'purchase_order', 'tax_invoice', 'delivery_note'], required: true, immutable: true, index: true },
  organizationId: { type: Schema.Types.ObjectId, ref: 'BusinessOrganization', required: true, immutable: true, index: true },
  organizationPublicId: { type: String, required: true, immutable: true, maxlength: 100, index: true },
  storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true, immutable: true, index: true },
  storePublicId: { type: String, required: true, immutable: true, maxlength: 100, index: true },
  quoteRequestId: { type: Schema.Types.ObjectId, ref: 'QuoteRequest', immutable: true, index: true },
  quoteRequestPublicId: { type: String, immutable: true, maxlength: 100, default: '' },
  purchaseOrderId: { type: Schema.Types.ObjectId, ref: 'PurchaseOrder', immutable: true, index: true },
  purchaseOrderPublicId: { type: String, immutable: true, maxlength: 100, default: '' },
  businessInvoiceId: { type: Schema.Types.ObjectId, ref: 'BusinessInvoice', immutable: true, index: true },
  businessInvoicePublicId: { type: String, immutable: true, maxlength: 100, default: '' },
  orderId: { type: Schema.Types.ObjectId, ref: 'Order', immutable: true, index: true },
  orderPublicId: { type: String, immutable: true, maxlength: 100, default: '' },
  shipmentId: { type: Schema.Types.ObjectId, ref: 'Shipment', immutable: true, index: true },
  shipmentPublicId: { type: String, immutable: true, maxlength: 100, default: '' },
  country: { type: String, required: true, uppercase: true, minlength: 2, maxlength: 2, immutable: true, index: true },
  currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3, immutable: true },
  revision: { type: Number, min: 1, max: 1000000, default: 1, immutable: true },
  legacySnapshot: { type: Boolean, default: false, immutable: true },
  amountMinor: { type: Number, min: 0, required: true, immutable: true },
  snapshot: { type: Schema.Types.Mixed, required: true, immutable: true },
  snapshotDigest: { type: String, required: true, immutable: true, minlength: 64, maxlength: 64 },
  issuedByUserId: { type: Schema.Types.ObjectId, ref: 'User', immutable: true },
  issuedAt: { type: Date, required: true, default: Date.now, immutable: true, index: true },
}, { timestamps: { createdAt: true, updatedAt: false }, minimize: false });

businessDocumentSchema.index({ organizationId: 1, issuedAt: -1, _id: -1 });
businessDocumentSchema.index({ organizationId: 1, type: 1, issuedAt: -1 });
businessDocumentSchema.index({ quoteRequestId: 1, type: 1, revision: 1 }, { unique: true, partialFilterExpression: { quoteRequestId: { $exists: true }, type: 'quotation' } });

for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany']) {
  businessDocumentSchema.pre(op, function immutableBusinessDocument() {
    throw new Error('Issued business documents are immutable.');
  });
}

export const BusinessDocument = mongoose.model('BusinessDocument', businessDocumentSchema);

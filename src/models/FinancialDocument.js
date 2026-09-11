import mongoose from 'mongoose';

const { Schema } = mongoose;

const financialDocumentSchema = new Schema({
  publicId: { type: String, required: true, unique: true, immutable: true, index: true },
  eventKey: { type: String, required: true, unique: true, immutable: true, maxlength: 180 },
  documentNumber: { type: String, required: true, unique: true, immutable: true, maxlength: 120, index: true },
  type: { type: String, enum: ['payment_receipt', 'cod_receipt', 'refund_credit_note', 'chargeback_notice'], required: true, immutable: true, index: true },
  orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, immutable: true, index: true },
  orderPublicId: { type: String, required: true, immutable: true, maxlength: 100, index: true },
  ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', immutable: true, index: true },
  paymentIntentId: { type: Schema.Types.ObjectId, ref: 'PaymentIntent', immutable: true, index: true },
  paymentIntentPublicId: { type: String, maxlength: 100, immutable: true, default: '' },
  refundId: { type: Schema.Types.ObjectId, ref: 'Refund', immutable: true, index: true },
  refundPublicId: { type: String, maxlength: 100, immutable: true, default: '' },
  country: { type: String, required: true, uppercase: true, minlength: 2, maxlength: 2, immutable: true, index: true },
  currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3, immutable: true },
  amountMinor: { type: Number, required: true, min: 0, immutable: true },
  snapshot: { type: Schema.Types.Mixed, required: true, immutable: true },
  issuedAt: { type: Date, required: true, default: Date.now, immutable: true, index: true },
}, { timestamps: { createdAt: true, updatedAt: false }, minimize: false });

for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany']) {
  financialDocumentSchema.pre(op, function immutableFinancialDocument() {
    throw new Error('Financial documents are immutable.');
  });
}

export const FinancialDocument = mongoose.model('FinancialDocument', financialDocumentSchema);

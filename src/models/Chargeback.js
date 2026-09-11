import mongoose from 'mongoose';

const { Schema } = mongoose;

const commissionReversalSchema = new Schema({
  commissionId: { type: Schema.Types.ObjectId, ref: 'CommissionEntry', required: true },
  commissionPublicId: { type: String, required: true, maxlength: 100 },
  amountMinor: { type: Number, required: true, min: 0 },
  priorStatus: { type: String, required: true, maxlength: 60 },
  priorReversedAmountMinor: { type: Number, required: true, min: 0, default: 0 },
}, { _id: false });

const timelineSchema = new Schema({
  type: { type: String, required: true, maxlength: 80 },
  message: { type: String, required: true, maxlength: 300 },
  actorUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  at: { type: Date, default: Date.now, required: true },
}, { _id: false });

const chargebackSchema = new Schema({
  publicId: { type: String, required: true, unique: true, immutable: true, index: true },
  orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, immutable: true, index: true },
  orderPublicId: { type: String, required: true, immutable: true, maxlength: 100, index: true },
  paymentIntentId: { type: Schema.Types.ObjectId, ref: 'PaymentIntent', required: true, immutable: true, unique: true, index: true },
  paymentIntentPublicId: { type: String, required: true, immutable: true, maxlength: 100, index: true },
  provider: { type: String, enum: ['pesapal'], default: 'pesapal', immutable: true, index: true },
  providerTrackingId: { type: String, maxlength: 180, immutable: true, default: '' },
  providerReference: { type: String, maxlength: 120, immutable: true, default: '' },
  providerPayloadHash: { type: String, maxlength: 64, immutable: true, default: '' },
  country: { type: String, required: true, uppercase: true, minlength: 2, maxlength: 2, immutable: true, index: true },
  currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3, immutable: true },
  amountMinor: { type: Number, required: true, min: 0, immutable: true },
  status: { type: String, enum: ['open', 'reviewing', 'won', 'lost'], default: 'open', index: true },
  reversalLedgerTransactionPublicId: { type: String, maxlength: 100, default: '' },
  recoveryLedgerTransactionPublicId: { type: String, maxlength: 100, default: '' },
  commissionReversals: { type: [commissionReversalSchema], default: [] },
  reviewedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
  reviewNote: { type: String, maxlength: 500, default: '' },
  resolvedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  resolvedAt: Date,
  resolutionNote: { type: String, maxlength: 500, default: '' },
  openedAt: { type: Date, default: Date.now, required: true },
  timeline: { type: [timelineSchema], default: [] },
}, { timestamps: true, optimisticConcurrency: true });

chargebackSchema.index({ country: 1, status: 1, openedAt: -1 });

export const Chargeback = mongoose.model('Chargeback', chargebackSchema);

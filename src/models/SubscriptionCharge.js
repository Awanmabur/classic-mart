import mongoose from 'mongoose';
import { subscriptionTermsSchema, protectSubscriptionTerms } from './subscription-terms.js';
const { Schema } = mongoose;
const schema = new Schema({
  publicId: { type: String, required: true, unique: true, immutable: true },
  requestId: { type: Schema.Types.ObjectId, ref: 'SubscriptionChangeRequest', required: true, immutable: true }, requestPublicId: { type: String, required: true, immutable: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  payerTokenVersion: { type: Number, min: 0, required: true, immutable: true },
  payerMembershipId: { type: Schema.Types.ObjectId, ref: 'StoreMember', required: true, immutable: true },
  activationAuthorization: { type: new Schema({ userId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, membershipId: { type: Schema.Types.ObjectId, ref: 'StoreMember', required: true }, tokenVersion: { type: Number, min: 0, required: true }, at: { type: Date, required: true }, reason: { type: String, maxlength: 300, required: true } }, { _id: false }) },
  storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true, immutable: true }, storePublicId: { type: String, required: true, immutable: true },
  country: { type: String, required: true, immutable: true }, currency: { type: String, required: true, immutable: true },
  amountMinor: { type: Number, min: 0, required: true, immutable: true, validate: Number.isSafeInteger }, terms: { type: subscriptionTermsSchema, required: true, immutable: true },
  idempotencyKey: { type: String, required: true, immutable: true, maxlength: 120 },
  providerReference: { type: String, required: true, unique: true, immutable: true },
  providerTrackingId: { type: String, maxlength: 160 }, providerStatus: { type: String, maxlength: 80 }, providerConfirmationCode: { type: String, maxlength: 180 },
  status: { type: String, enum: ['created', 'submitting', 'requires_action', 'pending', 'held', 'succeeded', 'failed', 'cancelled', 'reversed'], default: 'created', index: true },
  activeKey: { type: String, maxlength: 120 }, checkoutUrl: { type: String, maxlength: 1600 },
  submissionAttemptedAt: Date, paidAt: Date, lastVerifiedAt: Date, reversedAt: Date,
  nextReconcileAt: { type: Date, default: Date.now, index: true },
  reconcileLease: { type: String, maxlength: 120, select: false }, reconcileLeaseUntil: Date,
  enrollmentId: { type: Schema.Types.ObjectId, ref: 'SubscriptionEnrollment' }, enrollmentPublicId: String,
  failureCode: { type: String, maxlength: 100 }, holdReason: { type: String, maxlength: 300 },
}, { timestamps: true, optimisticConcurrency: true });
schema.index({ storeId: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ activeKey: 1 }, { unique: true, sparse: true });
schema.index({ providerTrackingId: 1 }, { unique: true, sparse: true });
schema.index({ storeId: 1, createdAt: -1, _id: -1 });
protectSubscriptionTerms(schema);
export const SubscriptionCharge = mongoose.model('SubscriptionCharge', schema);

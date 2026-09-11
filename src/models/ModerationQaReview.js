import mongoose from 'mongoose';

const { Schema } = mongoose;

const moderationQaReviewSchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true, immutable: true, index: true },
    targetType: { type: String, enum: ['product', 'seller_verification'], required: true, index: true },
    targetObjectId: { type: Schema.Types.ObjectId, required: true, index: true },
    targetPublicId: { type: String, required: true, immutable: true, index: true },
    country: { type: String, required: true, uppercase: true, trim: true, index: true },
    riskLevel: { type: String, enum: ['standard', 'high'], default: 'standard', index: true },
    decision: { type: String, enum: ['approved', 'changes_requested', 'rejected'], required: true },
    decisionReason: { type: String, trim: true, maxlength: 1_000, default: '' },
    originalReviewerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sampledAt: { type: Date, default: Date.now, required: true, index: true },
    status: { type: String, enum: ['pending', 'completed'], default: 'pending', index: true },
    qaReviewerUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    outcome: { type: String, enum: ['', 'upheld', 'coaching', 'escalated'], default: '' },
    note: { type: String, trim: true, maxlength: 1_000, default: '' },
  },
  { timestamps: true, optimisticConcurrency: true },
);

moderationQaReviewSchema.index({ country: 1, status: 1, sampledAt: 1 });
moderationQaReviewSchema.index({ targetType: 1, targetPublicId: 1, sampledAt: -1 });

export const ModerationQaReview = mongoose.model('ModerationQaReview', moderationQaReviewSchema);

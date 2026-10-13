import mongoose from 'mongoose';

const { Schema } = mongoose;

const moderationQaReviewSchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true, immutable: true, index: true },
    targetType: { type: String, enum: ['product', 'seller_verification'], required: true, immutable: true, index: true },
    targetObjectId: { type: Schema.Types.ObjectId, required: true, immutable: true, index: true },
    targetPublicId: { type: String, required: true, immutable: true, index: true },
    country: { type: String, required: true, uppercase: true, trim: true, immutable: true, index: true },
    riskLevel: { type: String, enum: ['standard', 'high'], default: 'standard', index: true },
    decision: { type: String, enum: ['approved', 'changes_requested', 'rejected'], required: true, immutable: true },
    decisionReason: { type: String, trim: true, maxlength: 1_000, default: '', immutable: true },
    decisionVersionSnapshot: { type: Number, min: 0, max: Number.MAX_SAFE_INTEGER, immutable: true, validate: { validator: value => value === undefined || Number.isSafeInteger(value), message: 'A saved decision version must be an integer.' } },
    decisionEventAt: { type: Date, immutable: true },
    originalReviewerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
    sampledAt: { type: Date, default: Date.now, required: true, immutable: true, index: true },
    status: { type: String, enum: ['pending', 'completed'], default: 'pending', index: true },
    assignedUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    assignedAt: { type: Date, default: null },
    qaReviewerUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    outcome: { type: String, enum: ['', 'upheld', 'coaching', 'escalated'], default: '' },
    note: { type: String, trim: true, maxlength: 1_000, default: '' },
    escalationCaseId: { type: Schema.Types.ObjectId, ref: 'TrustCase', default: null },
    escalationCasePublicId: { type: String, trim: true, maxlength: 100, default: '' },
  },
  { timestamps: true, optimisticConcurrency: true },
);

moderationQaReviewSchema.index({ country: 1, status: 1, sampledAt: 1 });
moderationQaReviewSchema.index({ targetType: 1, targetPublicId: 1, sampledAt: -1 });
moderationQaReviewSchema.index({ country: 1, reviewedAt: -1, _id: -1 });
moderationQaReviewSchema.index({ country: 1, createdAt: -1, _id: -1 });
moderationQaReviewSchema.index({ targetType: 1, targetObjectId: 1, decisionVersionSnapshot: 1 }, { unique: true, partialFilterExpression: { decisionVersionSnapshot: { $type: 'number' } } });

moderationQaReviewSchema.add({ moderationEvidenceReadRevision: { type: Number, min: 0, select: false } });

export const ModerationQaReview = mongoose.model('ModerationQaReview', moderationQaReviewSchema);

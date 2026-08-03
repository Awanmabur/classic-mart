import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true, immutable: true, index: true },
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      immutable: true,
      index: true,
    },
    actorPublicId: { type: String, immutable: true, index: true },
    action: { type: String, required: true, immutable: true, index: true },
    targetType: { type: String, immutable: true, index: true },
    targetPublicId: { type: String, immutable: true, index: true },
    country: {
      type: String,
      uppercase: true,
      maxlength: 2,
      immutable: true,
      index: true,
    },
    result: {
      type: String,
      enum: ['success', 'denied', 'failure'],
      required: true,
      immutable: true,
    },
    ipHash: { type: String, immutable: true, select: false },
    userAgentHash: { type: String, immutable: true, select: false },
    metadata: { type: mongoose.Schema.Types.Mixed, immutable: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    strict: 'throw',
  },
);

auditLogSchema.index({ actorId: 1, createdAt: -1 });
auditLogSchema.index({ targetType: 1, targetPublicId: 1, createdAt: -1 });

auditLogSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany'],
  function rejectMutation() {
    throw new Error('Audit logs are immutable.');
  },
);

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);

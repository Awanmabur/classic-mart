import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  publicId: { type: String, required: true, unique: true, immutable: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
  storageKey: { type: String, required: true, immutable: true, select: false, maxlength: 300 },
  mimeType: { type: String, required: true, enum: ['image/webp'] },
  sizeBytes: { type: Number, required: true, min: 1 },
  width: { type: Number, required: true, enum: [320] },
  height: { type: Number, required: true, enum: [320] },
  checksumSha256: { type: String, required: true, maxlength: 64, select: false },
  current: { type: Boolean, default: false, index: true },
  status: { type: String, enum: ['staged', 'active', 'pending_delete', 'deleting', 'deleted'], default: 'staged', index: true },
  cleanupAfter: { type: Date, index: true },
  deletedAt: Date,
  lockedUntil: { type: Date, index: true },
  leaseToken: { type: String, default: '', select: false, maxlength: 80 },
  attempts: { type: Number, default: 0, min: 0 },
  lastError: { type: String, default: '', maxlength: 500 },
}, { timestamps: true, optimisticConcurrency: true });
schema.index({ userId: 1, current: 1 }, { unique: true, partialFilterExpression: { current: true } });
schema.index({ status: 1, cleanupAfter: 1, lockedUntil: 1 });
export const CustomerAvatar = mongoose.models.CustomerAvatar || mongoose.model('CustomerAvatar', schema);

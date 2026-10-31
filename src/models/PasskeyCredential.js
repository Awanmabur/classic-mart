import mongoose from 'mongoose';

const passkeyCredentialSchema = new mongoose.Schema({
  publicId: { type: String, required: true, unique: true, immutable: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
  credentialId: { type: String, required: true, unique: true, immutable: true, maxlength: 4096, select: false },
  publicKey: { type: Buffer, required: true, immutable: true, select: false },
  counter: { type: Number, required: true, min: 0, select: false },
  name: { type: String, required: true, maxlength: 80 },
  transports: { type: [String], default: [] },
  deviceType: { type: String, enum: ['singleDevice', 'multiDevice'], required: true },
  backedUp: { type: Boolean, required: true },
  lastUsedAt: Date,
  revokedAt: Date,
}, { timestamps: true, optimisticConcurrency: true });
passkeyCredentialSchema.index({ userId: 1, revokedAt: 1, createdAt: -1 });
export const PasskeyCredential = mongoose.model('PasskeyCredential', passkeyCredentialSchema);

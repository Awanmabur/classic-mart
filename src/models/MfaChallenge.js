import mongoose from 'mongoose';

const mfaChallengeSchema = new mongoose.Schema({
  publicId: { type: String, required: true, unique: true, immutable: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
  sessionHash: { type: String, required: true, immutable: true, select: false },
  tokenVersion: { type: Number, required: true, immutable: true, min: 0 },
  purpose: { type: String, required: true, enum: ['sms_enroll', 'sms_auth', 'sms_manage', 'passkey_enroll', 'passkey_auth', 'passkey_manage'] },
  action: { type: String, maxlength: 40 },
  credentialPublicId: { type: String, maxlength: 80 },
  tokenHash: { type: String, required: true, select: false },
  passwordHashDigest: { type: String, select: false },
  phoneHash: { type: String, select: false },
  name: { type: String, maxlength: 80 },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  attempts: { type: Number, default: 0, min: 0, max: 5 },
  deliveredAt: Date,
  consumedAt: Date,
}, { timestamps: true });
mfaChallengeSchema.index({ userId: 1, purpose: 1, sessionHash: 1, consumedAt: 1, expiresAt: 1 });
export const MfaChallenge = mongoose.model('MfaChallenge', mfaChallengeSchema);

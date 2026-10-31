import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  publicId: { type: String, required: true, unique: true, immutable: true },
  storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true, immutable: true },
  storePublicId: { type: String, required: true, immutable: true },
  country: { type: String, required: true, immutable: true }, currency: { type: String, required: true, immutable: true },
  emailHash: { type: String, required: true, immutable: true, select: false },
  emailEncrypted: { type: String, required: true, immutable: true, select: false },
  emailMasked: { type: String, required: true, immutable: true, maxlength: 254 },
  role: { type: String, enum: ['admin', 'catalogue', 'fulfilment', 'finance', 'support'], required: true, immutable: true },
  status: { type: String, enum: ['pending', 'accepted', 'rejected', 'revoked', 'expired'], default: 'pending', index: true },
  invitedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  invitedByTokenVersion: { type: Number, required: true, min: 0, immutable: true },
  invitedByMembershipId: { type: Schema.Types.ObjectId, ref: 'StoreMember', required: true, immutable: true },
  invitedByRole: { type: String, enum: ['owner', 'admin'], required: true, immutable: true },
  invitedByPermissionVersion: { type: Number, required: true, min: 0, immutable: true },
  recipientUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  expiresAt: { type: Date, required: true, immutable: true }, respondedAt: Date, revokedAt: Date,
  revokedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true, optimisticConcurrency: true });
schema.index({ storeId: 1, emailHash: 1, status: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } });
schema.index({ emailHash: 1, status: 1, createdAt: -1, _id: -1 });
schema.index({ storeId: 1, createdAt: -1, _id: -1 });
export const StoreTeamInvitation = mongoose.model('StoreTeamInvitation', schema);

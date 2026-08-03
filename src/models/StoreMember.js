import mongoose from 'mongoose';

const { Schema } = mongoose;

const schema = new Schema({
  publicId: { type: String, required: true, unique: true, immutable: true, index: true },
  storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  role: { type: String, enum: ['owner','admin','catalogue','fulfilment','finance','support'], required: true, index: true },
  status: { type: String, enum: ['invited','active','revoked'], default: 'invited', index: true },
  invitedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  invitedAt: { type: Date, default: Date.now }, acceptedAt: Date, revokedAt: Date,
}, { timestamps: true, optimisticConcurrency: true });

schema.index({ storeId: 1, userId: 1 }, { unique: true });
export const StoreMember = mongoose.model('StoreMember', schema);

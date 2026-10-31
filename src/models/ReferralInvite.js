import mongoose from 'mongoose';

// A reusable invitation is separate from each signup's qualification history.
// Referral retains its existing unique receipt code and referred-user indexes.
const schema = new mongoose.Schema({
  publicId: { type: String, required: true, unique: true, immutable: true },
  code: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 24 },
  referrerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  country: { type: String, required: true, uppercase: true, minlength: 2, maxlength: 2 },
}, { timestamps: true });
schema.index({ referrerUserId: 1, country: 1 }, { unique: true });
export const ReferralInvite = mongoose.model('ReferralInvite', schema);

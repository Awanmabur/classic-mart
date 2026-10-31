import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  publicId: { type: String, required: true, unique: true, immutable: true },
  promoterUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true },
  country: { type: String, required: true, uppercase: true, minlength: 2, maxlength: 2 },
  status: { type: String, enum: ['followed', 'unfollowed'], default: 'followed', required: true },
}, { timestamps: true, optimisticConcurrency: true });
schema.index({ promoterUserId: 1, storeId: 1, country: 1 }, { unique: true });
schema.index({ promoterUserId: 1, country: 1, status: 1, createdAt: -1 });
export const PromoterBrandFollow = mongoose.model('PromoterBrandFollow', schema);

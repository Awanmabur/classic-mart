import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  publicId: { type: String, required: true, unique: true, immutable: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
  weekKey: { type: String, required: true, maxlength: 10, immutable: true },
  country: { type: String, default: '', maxlength: 2, uppercase: true, immutable: true },
  timeZone: { type: String, required: true, maxlength: 100, immutable: true },
  scopeCountries: { type: [String], required: true, immutable: true },
  scopeCurrencies: { type: [String], required: true, immutable: true },
  tokenVersion: { type: Number, required: true, min: 0, immutable: true, select: false },
  email: { type: String, required: true, maxlength: 320, immutable: true, select: false },
  periodStart: { type: Date, required: true, immutable: true },
  periodEnd: { type: Date, required: true, immutable: true },
  groups: { type: [mongoose.Schema.Types.Mixed], default: [], immutable: true, select: false },
  status: { type: String, enum: ['queued', 'sent', 'development_sink', 'cancelled'], default: 'queued', index: true },
  processedAt: Date,
  cancellationReason: { type: String, maxlength: 160, default: '' },
}, { timestamps: true });
schema.index({ userId: 1, weekKey: 1 }, { unique: true });
export const FinanceDigest = mongoose.model('FinanceDigest', schema);

import mongoose from 'mongoose';

const { Schema } = mongoose;

const newsletterSubscriptionSchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true, immutable: true, index: true },
    emailHash: { type: String, required: true, unique: true, index: true, minlength: 64, maxlength: 64, select: false },
    emailEncrypted: { type: String, required: true, select: false },
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    country: { type: String, uppercase: true, minlength: 2, maxlength: 2, index: true },
    status: { type: String, enum: ['active', 'unsubscribed'], default: 'active', index: true },
    source: { type: String, enum: ['storefront', 'account'], default: 'storefront' },
    policyVersion: { type: String, default: '2026-07', maxlength: 32 },
    consentRecordedAt: { type: Date, required: true },
    lastSubscribedAt: { type: Date, required: true },
    lastUnsubscribedAt: Date,
  },
  { timestamps: true },
);

newsletterSubscriptionSchema.index({ country: 1, status: 1, createdAt: -1 });

export const NewsletterSubscription = mongoose.model('NewsletterSubscription', newsletterSubscriptionSchema);

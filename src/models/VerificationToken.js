import mongoose from 'mongoose';

const verificationTokenSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    purpose: {
      type: String,
      enum: ['verify_email', 'verify_phone', 'password_reset'],
      required: true,
      index: true,
    },
    tokenHash: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    consumedAt: Date,
    attempts: { type: Number, default: 0, min: 0, max: 10 },
    requestedIpHash: { type: String, select: false },
  },
  { timestamps: true },
);

verificationTokenSchema.index({
  userId: 1,
  purpose: 1,
  consumedAt: 1,
  createdAt: -1,
});

export const VerificationToken = mongoose.model(
  'VerificationToken',
  verificationTokenSchema,
);

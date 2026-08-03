import mongoose from 'mongoose';

const deviceSchema = new mongoose.Schema(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    sessionHash: {
      type: String,
      required: true,
      unique: true,
      select: false,
    },
    label: { type: String, required: true, maxlength: 180 },
    userAgent: { type: String, required: true, maxlength: 500, select: false },
    ipHash: { type: String, required: true, select: false },
    lastSeenAt: { type: Date, required: true },
    revokedAt: Date,
    revokedReason: { type: String, maxlength: 160 },
  },
  { timestamps: true },
);

deviceSchema.index({ userId: 1, revokedAt: 1, lastSeenAt: -1 });

export const Device = mongoose.model('Device', deviceSchema);

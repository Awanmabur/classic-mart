import mongoose from 'mongoose';

const { Schema } = mongoose;

const verificationDocumentSchema = new Schema(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      index: true,
    },
    verificationId: {
      type: Schema.Types.ObjectId,
      ref: 'SellerVerification',
      required: true,
      index: true,
    },
    storeId: {
      type: Schema.Types.ObjectId,
      ref: 'Store',
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    documentType: {
      type: String,
      enum: ['identity', 'registration', 'tax', 'address'],
      required: true,
    },
    storageKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
      select: false,
    },
    mimeType: { type: String, required: true, enum: ['image/webp'] },
    sizeBytes: { type: Number, required: true, min: 1, max: 12_000_000 },
    width: { type: Number, required: true, min: 1, max: 10_000 },
    height: { type: Number, required: true, min: 1, max: 10_000 },
    checksumSha256: {
      type: String,
      required: true,
      minlength: 64,
      maxlength: 64,
      select: false,
    },
    status: {
      type: String,
      enum: ['ready', 'approved', 'rejected'],
      default: 'ready',
      index: true,
    },
    reviewedAt: Date,
    reviewedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

verificationDocumentSchema.index({
  verificationId: 1,
  documentType: 1,
  createdAt: -1,
});

export const VerificationDocument = mongoose.model(
  'VerificationDocument',
  verificationDocumentSchema,
);

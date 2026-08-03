import mongoose from 'mongoose';

const { Schema } = mongoose;

const documentSchema = new Schema(
  {
    type: {
      type: String,
      enum: ['identity', 'registration', 'tax', 'address'],
      required: true,
    },
    mediaPublicId: { type: String, required: true },
  },
  { _id: false },
);

const sellerVerificationSchema = new Schema(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      index: true,
    },
    storeId: {
      type: Schema.Types.ObjectId,
      ref: 'Store',
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    sellerType: {
      type: String,
      enum: ['individual', 'business'],
      required: true,
    },
    legalName: { type: String, required: true, trim: true, maxlength: 180 },
    registrationNumber: {
      type: String,
      trim: true,
      maxlength: 500,
      select: false,
      default: '',
    },
    taxNumber: {
      type: String,
      trim: true,
      maxlength: 500,
      select: false,
      default: '',
    },
    documents: {
      type: [documentSchema],
      validate: {
        validator: (items) => items.length <= 8,
        message: 'A verification can contain at most 8 documents.',
      },
      default: [],
    },
    status: {
      type: String,
      enum: [
        'draft',
        'submitted',
        'approved',
        'rejected',
        'appealed',
      ],
      default: 'draft',
      index: true,
    },
    declarationAcceptedAt: Date,
    submittedAt: Date,
    reviewedAt: Date,
    reviewedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewReason: { type: String, trim: true, maxlength: 1_000, default: '' },
    appeal: {
      message: { type: String, trim: true, maxlength: 1_000, default: '' },
      submittedAt: Date,
    },
  },
  { timestamps: true, optimisticConcurrency: true },
);

sellerVerificationSchema.index({ status: 1, submittedAt: 1 });
sellerVerificationSchema.index({ userId: 1, status: 1 });

export const SellerVerification = mongoose.model(
  'SellerVerification',
  sellerVerificationSchema,
);

import mongoose from 'mongoose';

const { Schema } = mongoose;

const brandSchema = new Schema(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 100,
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'approved',
      index: true,
    },
    requestedByStoreId: { type: Schema.Types.ObjectId, ref: 'Store' },
    reviewedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

brandSchema.index({ status: 1, name: 1 });

export const Brand = mongoose.model('Brand', brandSchema);

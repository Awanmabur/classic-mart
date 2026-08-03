import mongoose from 'mongoose';

const { Schema } = mongoose;

const replySchema = new Schema(
  {
    sender: { type: String, enum: ['customer', 'seller'], required: true },
    senderUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true, trim: true, maxlength: 2_000 },
    at: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const sellerContactRequestSchema = new Schema(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      index: true,
    },
    customerUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    storeId: {
      type: Schema.Types.ObjectId,
      ref: 'Store',
      required: true,
      index: true,
    },
    country: {
      type: String,
      required: true,
      uppercase: true,
      minlength: 2,
      maxlength: 2,
      index: true,
    },
    subject: { type: String, required: true, trim: true, maxlength: 160 },
    message: { type: String, required: true, trim: true, maxlength: 2_000 },
    status: {
      type: String,
      enum: ['new', 'read', 'resolved'],
      default: 'new',
      index: true,
    },
    replies: { type: [replySchema], default: [] },
    lastMessageAt: { type: Date, default: Date.now, index: true },
    resolvedAt: Date,
  },
  { timestamps: true, optimisticConcurrency: true },
);

sellerContactRequestSchema.index({ storeId: 1, status: 1, lastMessageAt: -1 });
sellerContactRequestSchema.index({
  customerUserId: 1,
  storeId: 1,
  createdAt: -1,
});

export const SellerContactRequest = mongoose.model(
  'SellerContactRequest',
  sellerContactRequestSchema,
);

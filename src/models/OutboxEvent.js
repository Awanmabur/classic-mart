import mongoose from 'mongoose';

const { Schema } = mongoose;

const outboxEventSchema = new Schema(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      index: true,
    },
    aggregateType: { type: String, required: true, maxlength: 80 },
    aggregatePublicId: { type: String, required: true, maxlength: 100 },
    type: { type: String, required: true, maxlength: 120, index: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: ['pending', 'processing', 'processed', 'failed'],
      default: 'pending',
      index: true,
    },
    attempts: { type: Number, min: 0, max: 100, default: 0 },
    availableAt: { type: Date, default: Date.now, index: true },
    processedAt: Date,
    lastError: { type: String, maxlength: 1_000, default: '' },
  },
  { timestamps: true },
);

outboxEventSchema.index({ status: 1, availableAt: 1, createdAt: 1 });

export const OutboxEvent = mongoose.model('OutboxEvent', outboxEventSchema);

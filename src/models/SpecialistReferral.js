import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  publicId: { type: String, required: true, immutable: true, unique: true, index: true },
  activeKey: { type: String, maxlength: 100 },
  disputeId: { type: Schema.Types.ObjectId, ref: 'Dispute', required: true, immutable: true, index: true },
  disputePublicId: { type: String, required: true, immutable: true, index: true },
  orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, immutable: true, index: true },
  orderPublicId: { type: String, required: true, immutable: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  country: { type: String, required: true, immutable: true, uppercase: true, minlength: 2, maxlength: 2 },
  currency: { type: String, required: true, immutable: true, uppercase: true, minlength: 3, maxlength: 3 },
  department: { type: String, required: true, immutable: true, enum: ['finance', 'delivery', 'moderation', 'seller', 'support'] },
  receivingWorkspace: { type: String, required: true, immutable: true, enum: ['finance', 'moderator', 'admin', 'seller'] },
  storeId: { type: Schema.Types.ObjectId, ref: 'Store', immutable: true },
  storePublicId: { type: String, immutable: true, maxlength: 100, default: '' },
  ticketId: { type: Schema.Types.ObjectId, ref: 'SupportTicket', required: true, immutable: true },
  ticketPublicId: { type: String, required: true, immutable: true, maxlength: 100 },
  requestedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  requestedAt: { type: Date, required: true, immutable: true, default: Date.now },
  reason: { type: String, required: true, immutable: true, maxlength: 1000 },
  recipientMessage: { type: String, immutable: true, maxlength: 1000, default: '' },
  sourceEvidenceDocumentIds: { type: [Schema.Types.ObjectId], ref: 'EvidenceDocument', immutable: true, default: [] },
  status: { type: String, enum: ['pending', 'claimed', 'responded'], default: 'pending', index: true },
  assignedUserId: { type: Schema.Types.ObjectId, ref: 'User' }, assignedAt: Date,
  response: { finding: { type: String, enum: ['recommendation', 'further_action', 'no_action'] },
    summary: { type: String, maxlength: 2000 }, respondedByUserId: { type: Schema.Types.ObjectId, ref: 'User' }, respondedAt: Date },
  evidenceDocumentIds: { type: [Schema.Types.ObjectId], ref: 'EvidenceDocument', default: [] },
  evidenceReadRevision: { type: Number, min: 0, default: 0, select: false },
}, { timestamps: true, optimisticConcurrency: true });
schema.index({ activeKey: 1 }, { unique: true, sparse: true });
schema.index({ receivingWorkspace: 1, country: 1, status: 1, createdAt: -1, _id: -1 });
schema.index({ storeId: 1, status: 1, createdAt: -1, _id: -1 });
export const SpecialistReferral = mongoose.model('SpecialistReferral', schema);

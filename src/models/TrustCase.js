import mongoose from 'mongoose';
const { Schema }=mongoose;

const assignmentEntry = new Schema({ action: { type: String, enum: ['claim', 'release'], required: true }, actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, at: { type: Date, default: Date.now } }, { _id: false });
const decisionEntry = new Schema({ action: { type: String, required: true, maxlength: 40 }, status: { type: String, required: true, maxlength: 40 }, actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, reason: { type: String, maxlength: 1000, default: '' }, at: { type: Date, default: Date.now } }, { _id: false });
const publicMessage = new Schema({ author: { type: String, enum: ['customer', 'seller', 'moderation'], required: true }, message: { type: String, required: true, maxlength: 1000 }, actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, at: { type: Date, default: Date.now } }, { _id: false });
const schema=new Schema({publicId:{type:String,required:true,unique:true,index:true,immutable:true},reporterUserId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},country:{type:String,required:true,uppercase:true,index:true},type:{type:String,enum:['counterfeit','prohibited_product','unsafe_product','review_manipulation','seller_conduct','moderation_quality'],required:true,index:true},productId:{type:Schema.Types.ObjectId,ref:'Product',index:true},productPublicId:{type:String,index:true},storeId:{type:Schema.Types.ObjectId,ref:'Store',index:true},storePublicId:{type:String,index:true},
  reviewId:{type:Schema.Types.ObjectId,ref:'Review',immutable:true},reviewPublicId:{type:String,maxlength:100,immutable:true},
  supportTicketId:{type:Schema.Types.ObjectId,ref:'SupportTicket',immutable:true},supportTicketPublicId:{type:String,maxlength:100,immutable:true},
  reviewStatusSnapshot:{type:String,enum:['pending','published','rejected','disputed'],immutable:true},reviewVersionSnapshot:{type:Number,min:0,immutable:true},
  description:{type:String,required:true,maxlength:2500},status:{type:String,enum:['open','investigating','actioned','dismissed','appealed','closed'],default:'open',index:true},assignedUserId:{type:Schema.Types.ObjectId,ref:'User'},evidenceDocumentIds:{type:[Schema.Types.ObjectId],ref:'EvidenceDocument',default:[]},decision:{type:String,maxlength:1000,default:''},resolvedAt:Date},{timestamps:true,optimisticConcurrency:true});
schema.index({country:1,status:1,type:1,createdAt:-1});
schema.index({reporterUserId:1,createdAt:-1});
// One durable moderation case owns a Support review referral, including its subsequent outcome.
schema.index({reviewId:1},{unique:true,sparse:true});

schema.add({ assignedAt: Date, assignmentHistory: { type: [assignmentEntry], default: [] }, decisionHistory: { type: [decisionEntry], default: [] } });
schema.index({ country: 1, status: 1, createdAt: -1, _id: -1 });
schema.index({ country: 1, assignedUserId: 1, status: 1, createdAt: -1, _id: -1 });
schema.add({ qaReviewId: { type: Schema.Types.ObjectId, ref: 'ModerationQaReview', immutable: true }, qaReviewPublicId: { type: String, maxlength: 100, immutable: true }, decisionByUserId: { type: Schema.Types.ObjectId, ref: 'User' }, decisionAt: Date, appealCount: { type: Number, default: 0, min: 0 }, appealOriginalDecisionByUserId: { type: Schema.Types.ObjectId, ref: 'User' }, appealMessage: { type: String, maxlength: 1000, default: '' }, publicMessages: { type: [publicMessage], default: [] } });
schema.index({qaReviewId:1},{unique:true,sparse:true});
schema.add({ moderationEvidenceReadRevision: { type: Number, min: 0, select: false } });
const sellerResponse = new Schema({ action: { type: String, enum: ['response', 'correction', 'appeal', 'evidence'], required: true }, message: { type: String, maxlength: 2000, default: '' }, actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, evidenceDocumentIds: { type: [Schema.Types.ObjectId], ref: 'EvidenceDocument', default: [] }, at: { type: Date, default: Date.now } }, { _id: false });
schema.add({ sellerResponses: { type: [sellerResponse], default: [] }, sellerEvidenceDocumentIds: { type: [Schema.Types.ObjectId], ref: 'EvidenceDocument', default: [] }, sellerAppealCount: { type: Number, min: 0, default: 0 }, sellerAppealedAt: Date });
schema.index({ storeId: 1, createdAt: -1, _id: -1 });

export const TrustCase=mongoose.model('TrustCase',schema);

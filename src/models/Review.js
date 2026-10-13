import mongoose from 'mongoose';
const { Schema }=mongoose;

const assignmentEntry = new Schema({ action: { type: String, enum: ['claim', 'release'], required: true }, actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, at: { type: Date, default: Date.now } }, { _id: false });
const decisionEntry = new Schema({ action: { type: String, required: true, maxlength: 40 }, status: { type: String, required: true, maxlength: 40 }, actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, reason: { type: String, maxlength: 1000, default: '' }, at: { type: Date, default: Date.now } }, { _id: false });
const publicMessage = new Schema({ author: { type: String, enum: ['customer', 'seller', 'moderation'], required: true }, message: { type: String, required: true, maxlength: 1000 }, actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, at: { type: Date, default: Date.now } }, { _id: false });
const schema=new Schema({publicId:{type:String,required:true,unique:true,index:true,immutable:true},userId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},orderId:{type:Schema.Types.ObjectId,ref:'Order',required:true},orderPublicId:{type:String,required:true},productId:{type:Schema.Types.ObjectId,ref:'Product',required:true,index:true},productPublicId:{type:String,required:true,index:true},country:{type:String,required:true,uppercase:true,index:true},rating:{type:Number,required:true,min:1,max:5},title:{type:String,maxlength:140,default:''},body:{type:String,required:true,maxlength:2500},verifiedPurchase:{type:Boolean,required:true,default:true,immutable:true},status:{type:String,enum:['pending','published','rejected','disputed'],default:'pending',index:true},moderationReason:{type:String,maxlength:500,default:''},disputeReason:{type:String,maxlength:1000,default:''},disputedByUserId:{type:Schema.Types.ObjectId,ref:'User'},disputedAt:Date,publishedAt:Date},{timestamps:true,optimisticConcurrency:true});
schema.index({userId:1,orderId:1,productId:1},{unique:true}); schema.index({productId:1,status:1,createdAt:-1});

schema.add({ assignedAt: Date, assignmentHistory: { type: [assignmentEntry], default: [] }, decisionHistory: { type: [decisionEntry], default: [] } });
schema.index({ country: 1, status: 1, createdAt: -1, _id: -1 });
schema.index({ country: 1, assignedUserId: 1, status: 1, createdAt: -1, _id: -1 });
schema.add({ orderLinePublicId: { type: String, maxlength: 100, immutable: true }, assignedUserId: { type: Schema.Types.ObjectId, ref: 'User' }, moderatedByUserId: { type: Schema.Types.ObjectId, ref: 'User' }, moderatedAt: Date, publicMessages: { type: [publicMessage], default: [] } });
schema.add({ moderationEvidenceReadRevision: { type: Number, min: 0, select: false } });

export const Review=mongoose.model('Review',schema);

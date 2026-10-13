import mongoose from 'mongoose';
const { Schema }=mongoose;

const assignmentEntry = new Schema({ action: { type: String, enum: ['claim', 'release'], required: true }, actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, at: { type: Date, default: Date.now } }, { _id: false });
const decisionEntry = new Schema({ action: { type: String, required: true, maxlength: 40 }, status: { type: String, required: true, maxlength: 40 }, actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, reason: { type: String, maxlength: 1000, default: '' }, at: { type: Date, default: Date.now } }, { _id: false });
const publicMessage = new Schema({ author: { type: String, enum: ['customer', 'seller', 'moderation'], required: true }, message: { type: String, required: true, maxlength: 1000 }, actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, at: { type: Date, default: Date.now } }, { _id: false });
const schema=new Schema({publicId:{type:String,required:true,unique:true,immutable:true,index:true},country:{type:String,required:true,uppercase:true,index:true},subjectType:{type:String,enum:['user','order','store','product','promoter','delivery'],required:true,index:true},subjectPublicId:{type:String,required:true,index:true},type:{type:String,required:true,maxlength:100,index:true},severity:{type:String,enum:['low','medium','high','critical'],required:true,index:true},score:{type:Number,min:0,max:100,default:0},status:{type:String,enum:['open','reviewed','dismissed','actioned'],default:'open',index:true},evidence:{type:[String],default:[]},createdBy:{type:String,enum:['system','user','operator'],default:'system'},reviewedByUserId:{type:Schema.Types.ObjectId,ref:'User'},decision:{type:String,maxlength:1000,default:''},reviewedAt:Date},{timestamps:true,optimisticConcurrency:true});
schema.index({country:1,status:1,severity:1,createdAt:-1});

schema.add({ assignedAt: Date, assignmentHistory: { type: [assignmentEntry], default: [] }, decisionHistory: { type: [decisionEntry], default: [] } });
schema.index({ country: 1, status: 1, createdAt: -1, _id: -1 });
schema.index({ country: 1, assignedUserId: 1, status: 1, createdAt: -1, _id: -1 });
schema.add({ reporterUserId: { type: Schema.Types.ObjectId, ref: 'User', immutable: true }, assignedUserId: { type: Schema.Types.ObjectId, ref: 'User' } });
export const RiskSignal=mongoose.model('RiskSignal',schema);

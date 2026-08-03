import mongoose from 'mongoose';
const {Schema}=mongoose;
const schema=new Schema({publicId:{type:String,required:true,unique:true,immutable:true,index:true},storeId:{type:Schema.Types.ObjectId,ref:'Store',required:true,index:true},storePublicId:{type:String,required:true},country:{type:String,required:true,uppercase:true,index:true},subject:{type:String,required:true,maxlength:180},body:{type:String,required:true,maxlength:4000},status:{type:String,enum:['draft','queued','sent','cancelled'],default:'draft',index:true},recipientCount:{type:Number,min:0,default:0},createdByUserId:{type:Schema.Types.ObjectId,ref:'User',required:true},queuedAt:Date},{timestamps:true,optimisticConcurrency:true});
export const StoreBroadcast=mongoose.model('StoreBroadcast',schema);

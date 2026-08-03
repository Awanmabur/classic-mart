import mongoose from 'mongoose';
const { Schema }=mongoose;
const payoutSchema=new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true}, idempotencyKey:{type:String,required:true,unique:true,immutable:true,maxlength:120}, ownerUserId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true}, ownerStoreId:{type:Schema.Types.ObjectId,ref:'Store',index:true}, ownerStorePublicId:{type:String,index:true,maxlength:100}, requestedByUserId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},
  payoutAccountId:{type:Schema.Types.ObjectId,ref:'PayoutAccount',required:true}, amountMinor:{type:Number,required:true,min:1},currency:{type:String,required:true,uppercase:true},
  status:{type:String,enum:['requested','approved','submitted','paid','failed','rejected'],default:'requested',index:true}, requestedAt:{type:Date,default:Date.now}, approvedByUserId:{type:Schema.Types.ObjectId,ref:'User'},approvedAt:Date,submittedByUserId:{type:Schema.Types.ObjectId,ref:'User'},submittedAt:Date,providerReference:{type:String,maxlength:160},failureMessage:{type:String,maxlength:300}
},{timestamps:true,optimisticConcurrency:true});
export const Payout=mongoose.model('Payout',payoutSchema);

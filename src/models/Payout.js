import mongoose from 'mongoose';
const { Schema }=mongoose;
const payoutSchema=new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  idempotencyKey:{type:String,required:true,unique:true,immutable:true,maxlength:120},
  ownerUserId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},
  ownerStoreId:{type:Schema.Types.ObjectId,ref:'Store',index:true},
  ownerStorePublicId:{type:String,index:true,maxlength:100},
  requestedByUserId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},
  payoutAccountId:{type:Schema.Types.ObjectId,ref:'PayoutAccount',required:true},
  amountMinor:{type:Number,required:true,min:1},currency:{type:String,required:true,uppercase:true},
  status:{type:String,enum:['requested','approved','submitting','submitted','unknown','paid','failed','rejected'],default:'requested',index:true},
  requestedAt:{type:Date,default:Date.now},
  approvedByUserId:{type:Schema.Types.ObjectId,ref:'User'},approvedAt:Date,
  submittedByUserId:{type:Schema.Types.ObjectId,ref:'User'},submissionStartedAt:Date,submittedAt:Date,
  submissionAttemptId:{type:String,maxlength:80,index:true},
  unknownByUserId:{type:Schema.Types.ObjectId,ref:'User'},unknownAt:Date,ambiguityReason:{type:String,maxlength:400},
  completedByUserId:{type:Schema.Types.ObjectId,ref:'User'},completedAt:Date,
  disbursementProvider:{type:String,maxlength:80,default:'external'},
  providerReference:{type:String,maxlength:180},
  failureMessage:{type:String,maxlength:400}
},{timestamps:true,optimisticConcurrency:true});
export const Payout=mongoose.model('Payout',payoutSchema);

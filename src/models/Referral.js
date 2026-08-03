import mongoose from 'mongoose';
const referralSchema=new mongoose.Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  code:{type:String,required:true,unique:true,uppercase:true,trim:true,maxlength:24,index:true},
  referrerUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true,index:true},
  referredUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User',unique:true,sparse:true,index:true},
  country:{type:String,uppercase:true,maxlength:2,required:true,index:true},
  status:{type:String,enum:['available','pending','qualified','rewarded','rejected'],default:'available',index:true},
  qualifiedOrderPublicId:{type:String,maxlength:120,default:''},
  referrerRewardPoints:{type:Number,min:0,default:0},
  referredRewardPoints:{type:Number,min:0,default:0},
  acceptedAt:Date,qualifiedAt:Date,rewardedAt:Date,
},{timestamps:true});
export const Referral=mongoose.model('Referral',referralSchema);

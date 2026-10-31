import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  idempotencyKey:{type:String,required:true,unique:true,immutable:true,maxlength:160},
  userId:{type:Schema.Types.ObjectId,ref:'User',required:true,immutable:true,index:true},
  country:{type:String,required:true,uppercase:true,minlength:2,maxlength:2,immutable:true},
  currency:{type:String,required:true,uppercase:true,minlength:3,maxlength:3,immutable:true},
  rewardKey:{type:String,required:true,maxlength:80,immutable:true},
  label:{type:String,required:true,maxlength:120,immutable:true},
  kind:{type:String,enum:['voucher','shipping','gold_trial'],required:true,immutable:true},
  pointsCost:{type:Number,required:true,min:1,validate:Number.isSafeInteger,immutable:true},
  valueMinor:{type:Number,min:0,default:0,validate:Number.isSafeInteger,immutable:true},
  minimumSpendMinor:{type:Number,min:0,default:0,validate:Number.isSafeInteger,immutable:true},
  maximumDiscountMinor:{type:Number,min:0,default:0,validate:Number.isSafeInteger,immutable:true},
  multiplierBps:{type:Number,min:10000,max:50000,default:10000,validate:Number.isSafeInteger,immutable:true},
  trialShippingDiscountBps:{type:Number,min:0,max:10000,default:0,validate:Number.isSafeInteger,immutable:true},
  status:{type:String,enum:['issued','reserved','used','expired'],default:'issued',index:true},
  expiresAt:{type:Date,required:true,immutable:true,index:true},
  orderPublicId:{type:String,maxlength:100,default:''},
  consumedAt:Date, restoredAt:Date,
},{timestamps:true,optimisticConcurrency:true});
schema.index({userId:1,country:1,currency:1,status:1,expiresAt:1});
schema.index({orderPublicId:1},{unique:true,partialFilterExpression:{status:{$in:['reserved','used']},kind:{$in:['voucher','shipping']}}});
export const CustomerReward=mongoose.model('CustomerReward',schema);

import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  planId:{type:Schema.Types.ObjectId,ref:'SubscriptionPlan',required:true,index:true},
  planPublicId:{type:String,required:true,index:true},
  audience:{type:String,enum:['seller','promoter'],required:true,index:true},
  userId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},
  storeId:{type:Schema.Types.ObjectId,ref:'Store',index:true},
  storePublicId:{type:String,maxlength:100,default:'',index:true},
  country:{type:String,required:true,uppercase:true,minlength:2,maxlength:2,index:true},
  currency:{type:String,required:true,uppercase:true,minlength:3,maxlength:3},
  priceMinor:{type:Number,required:true,min:0},
  status:{type:String,enum:['trialing','active','past_due','cancelled','expired'],default:'active',index:true},
  startsAt:{type:Date,default:Date.now,required:true},
  currentPeriodEndsAt:Date,
  cancelledAt:Date,
  assignedByUserId:{type:Schema.Types.ObjectId,ref:'User'},
},{timestamps:true,optimisticConcurrency:true});
schema.index({audience:1,userId:1,storeId:1,status:1});
export const SubscriptionEnrollment=mongoose.model('SubscriptionEnrollment',schema);

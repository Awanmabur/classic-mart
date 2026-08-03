import mongoose from 'mongoose';
const loyaltyAccountSchema=new mongoose.Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  userId:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true,unique:true,index:true},
  country:{type:String,uppercase:true,maxlength:2,required:true,index:true},
  points:{type:Number,min:0,default:0},
  lifetimeEarned:{type:Number,min:0,default:0},
  lifetimeRedeemed:{type:Number,min:0,default:0},
  tier:{type:String,enum:['classic','silver','gold'],default:'classic'},
},{timestamps:true,optimisticConcurrency:true});
export const LoyaltyAccount=mongoose.model('LoyaltyAccount',loyaltyAccountSchema);

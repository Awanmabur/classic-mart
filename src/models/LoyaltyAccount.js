import mongoose from 'mongoose';
const loyaltyAccountSchema=new mongoose.Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  userId:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true,index:true},
  country:{type:String,uppercase:true,minlength:2,maxlength:2,match:/^[A-Z]{2}$/,required:true,index:true},
  points:{type:Number,min:0,default:0,validate:Number.isSafeInteger},
  lifetimeEarned:{type:Number,min:0,default:0,validate:Number.isSafeInteger},
  lifetimeRedeemed:{type:Number,min:0,default:0,validate:Number.isSafeInteger},
  reversalDebtPoints:{type:Number,min:0,default:0,validate:Number.isSafeInteger},
  tier:{type:String,enum:['classic','silver','gold'],default:'classic'},
},{timestamps:true,optimisticConcurrency:true});
loyaltyAccountSchema.index({userId:1,country:1},{unique:true,name:'loyalty_user_country_unique'});
export const LoyaltyAccount=mongoose.model('LoyaltyAccount',loyaltyAccountSchema);

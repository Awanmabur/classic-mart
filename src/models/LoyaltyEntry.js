import mongoose from 'mongoose';
const loyaltyEntrySchema=new mongoose.Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  idempotencyKey:{type:String,required:true,unique:true,immutable:true,index:true},
  userId:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true,index:true},
  country:{type:String,uppercase:true,maxlength:2,required:true,index:true},
  type:{type:String,enum:['order_earn','referral_earn','gift_card_redeem','manual_adjustment'],required:true,index:true},
  pointsDelta:{type:Number,required:true},
  balanceAfter:{type:Number,min:0,required:true},
  referenceType:{type:String,maxlength:80,default:''},
  referencePublicId:{type:String,maxlength:120,default:''},
  reason:{type:String,maxlength:500,default:''},
  actorUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User'},
},{timestamps:{createdAt:true,updatedAt:false}});
loyaltyEntrySchema.pre(['updateOne','updateMany','findOneAndUpdate','deleteOne','deleteMany'],function(){throw new Error('Loyalty entries are immutable.');});
export const LoyaltyEntry=mongoose.model('LoyaltyEntry',loyaltyEntrySchema);

import mongoose from 'mongoose';
const loyaltyEntrySchema=new mongoose.Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  idempotencyKey:{type:String,required:true,unique:true,immutable:true,index:true},
  userId:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true,index:true},
  country:{type:String,uppercase:true,maxlength:2,required:true,index:true},
  type:{type:String,enum:['order_earn','referral_earn','gift_card_redeem','manual_adjustment','reward_redeem','order_refund','referral_refund','order_chargeback','referral_chargeback'],required:true,index:true},
  pointsDelta:{type:Number,required:true,validate:Number.isSafeInteger},
  balanceAfter:{type:Number,min:0,required:true,validate:Number.isSafeInteger},
  earnedPoints:{type:Number,min:0,default:0,validate:Number.isSafeInteger},
  reversedPoints:{type:Number,min:0,default:0,validate:Number.isSafeInteger},
  debtDelta:{type:Number,default:0,validate:Number.isSafeInteger},
  debtAfter:{type:Number,min:0,default:0,validate:Number.isSafeInteger},
  reversalOfEntryPublicId:{type:String,maxlength:100,default:'',immutable:true,index:true},
  refundPublicId:{type:String,maxlength:100,default:'',immutable:true},
  chargebackPublicId:{type:String,maxlength:100,default:'',immutable:true},
  referenceType:{type:String,maxlength:80,default:''},
  referencePublicId:{type:String,maxlength:120,default:''},
  reason:{type:String,maxlength:500,default:''},
  actorUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User'},
},{timestamps:{createdAt:true,updatedAt:false}});
loyaltyEntrySchema.pre(['updateOne','updateMany','findOneAndUpdate','replaceOne','findOneAndReplace','deleteOne','deleteMany'],function(){throw new Error('Loyalty entries are immutable.');});
loyaltyEntrySchema.pre('save',function(){if(!this.isNew&&this.isModified())throw new Error('Loyalty entries are immutable.');});
loyaltyEntrySchema.index({userId:1,createdAt:-1});
loyaltyEntrySchema.index({type:1,reversalOfEntryPublicId:1},{unique:true,name:'chargeback_earning_reversal_unique',partialFilterExpression:{type:{$in:['order_chargeback','referral_chargeback']}}});
export const LoyaltyEntry=mongoose.model('LoyaltyEntry',loyaltyEntrySchema);

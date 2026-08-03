import mongoose from 'mongoose';
const giftCardSchema=new mongoose.Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  codeHash:{type:String,required:true,unique:true,select:false,index:true},
  codeEncrypted:{type:String,required:true,select:false},
  codeLast4:{type:String,required:true,maxlength:4},
  country:{type:String,uppercase:true,maxlength:2,required:true,index:true},
  currency:{type:String,uppercase:true,maxlength:3,required:true},
  initialValueMinor:{type:Number,min:1,required:true},
  balanceMinor:{type:Number,min:0,required:true},
  status:{type:String,enum:['active','redeemed','expired','cancelled'],default:'active',index:true},
  issuedByUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true},
  redeemedByUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User'},
  redeemedAt:Date,
  expiresAt:{type:Date,index:true},
  note:{type:String,maxlength:500,default:''},
},{timestamps:true});
export const GiftCard=mongoose.model('GiftCard',giftCardSchema);

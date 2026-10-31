import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  userId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},
  userPublicId:{type:String,required:true,index:true,maxlength:100},
  country:{type:String,required:true,uppercase:true,minlength:2,maxlength:2,index:true},
  currency:{type:String,required:true,uppercase:true,minlength:3,maxlength:3},
  amountMinor:{type:Number,required:true,min:1},
  idempotencyKey:{type:String,required:true,unique:true,immutable:true,maxlength:140},
  provider:{type:String,enum:['pesapal'],default:'pesapal',required:true},
  providerReference:{type:String,required:true,unique:true,index:true,maxlength:120},
  providerTrackingId:{type:String,index:true,maxlength:180,default:''},
  providerConfirmationCode:{type:String,maxlength:180,default:''},
  providerPaymentMethod:{type:String,maxlength:80,default:''},
  providerStatus:{type:String,maxlength:80,default:''},
  checkoutUrl:{type:String,maxlength:1000,default:''},
  status:{type:String,enum:['created','requires_action','pending','succeeded','failed'],default:'created',index:true},
  failureCode:{type:String,maxlength:100,default:''},
  failureMessage:{type:String,maxlength:400,default:''},
  paidAt:Date,
  lastVerifiedAt:Date,
},{timestamps:true,optimisticConcurrency:true});
schema.index({userId:1,createdAt:-1});
export const WalletTopUp=mongoose.model('WalletTopUp',schema);

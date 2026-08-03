import mongoose from 'mongoose';
const { Schema } = mongoose;
const paymentIntentSchema = new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  orderId:{type:Schema.Types.ObjectId,ref:'Order',required:true,index:true},
  orderPublicId:{type:String,required:true,index:true},
  idempotencyKey:{type:String,required:true,immutable:true,maxlength:120},
  provider:{type:String,enum:['flutterwave','cod','sandbox'],required:true,index:true},
  method:{type:String,enum:['card','mobile','cod'],required:true},
  status:{type:String,enum:['created','requires_action','pending','succeeded','failed','cancelled','pending_collection','refunded','partially_refunded'],default:'created',index:true},
  amountMinor:{type:Number,required:true,min:0}, currency:{type:String,required:true,uppercase:true,minlength:3,maxlength:3},
  providerReference:{type:String,maxlength:160,index:true}, providerTransactionId:{type:String,maxlength:120,index:true}, checkoutUrl:{type:String,maxlength:1200},
  failureCode:{type:String,maxlength:80}, failureMessage:{type:String,maxlength:300},
  paidAt:Date, lastVerifiedAt:Date,
},{timestamps:true,optimisticConcurrency:true});
paymentIntentSchema.index({orderId:1,idempotencyKey:1},{unique:true});
export const PaymentIntent=mongoose.model('PaymentIntent',paymentIntentSchema);

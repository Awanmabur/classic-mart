import mongoose from 'mongoose';
const { Schema } = mongoose;
const paymentIntentSchema = new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  traceId:{type:String,maxlength:32,default:'',immutable:true,index:true},
  traceSpanId:{type:String,maxlength:16,default:'',immutable:true},
  orderId:{type:Schema.Types.ObjectId,ref:'Order',required:true,index:true},
  orderPublicId:{type:String,required:true,index:true},
  country:{type:String,required:true,uppercase:true,minlength:2,maxlength:2,index:true,immutable:true},
  idempotencyKey:{type:String,required:true,immutable:true,maxlength:120},
  provider:{type:String,enum:['pesapal','cod','sandbox'],required:true,index:true},
  purpose:{type:String,enum:['order_payment','business_invoice'],default:'order_payment',index:true},method:{type:String,enum:['card','mobile','cod','pesapal'],required:true},
  status:{type:String,enum:['created','requires_action','pending','succeeded','failed','cancelled','pending_collection','refunded','partially_refunded','reversed'],default:'created',index:true},
  amountMinor:{type:Number,required:true,min:0},
  refundReservedMinor:{type:Number,default:0,min:0},
  refundedMinor:{type:Number,default:0,min:0},
  currency:{type:String,required:true,uppercase:true,minlength:3,maxlength:3},
  providerReference:{type:String,maxlength:80,index:true},
  providerTrackingId:{type:String,maxlength:160,index:true},
  providerTransactionId:{type:String,maxlength:160,index:true},
  providerConfirmationCode:{type:String,maxlength:180,index:true},
  providerPaymentMethod:{type:String,maxlength:80,default:''},
  providerStatus:{type:String,maxlength:80,default:''},
  checkoutUrl:{type:String,maxlength:1600},
  activeKey:{type:String,maxlength:120},
  failureCode:{type:String,maxlength:80},
  failureMessage:{type:String,maxlength:400},
  paidAt:Date,
  reversedAt:Date,
  lastVerifiedAt:Date,
},{timestamps:true,optimisticConcurrency:true});
paymentIntentSchema.index({orderId:1,idempotencyKey:1},{unique:true});
paymentIntentSchema.index({activeKey:1},{unique:true,sparse:true});
paymentIntentSchema.index({country:1,status:1,createdAt:-1});
paymentIntentSchema.index({provider:1,providerTrackingId:1},{unique:true,partialFilterExpression:{provider:'pesapal',providerTrackingId:{$type:'string'}}});
export const PaymentIntent=mongoose.model('PaymentIntent',paymentIntentSchema);

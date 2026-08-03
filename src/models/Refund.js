import mongoose from 'mongoose';
const { Schema }=mongoose;
const allocationSchema=new Schema({storePublicId:{type:String,required:true,maxlength:100},productPublicId:{type:String,maxlength:100,default:''},grossMinor:{type:Number,required:true,min:1}},{_id:false});
const refundSchema=new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true}, idempotencyKey:{type:String,required:true,unique:true,immutable:true,maxlength:120},
  orderId:{type:Schema.Types.ObjectId,ref:'Order',required:true,index:true}, paymentIntentId:{type:Schema.Types.ObjectId,ref:'PaymentIntent',required:true,index:true},
  amountMinor:{type:Number,required:true,min:1}, currency:{type:String,required:true,uppercase:true}, reason:{type:String,required:true,maxlength:300},
  allocations:{type:[allocationSchema],default:[]},
  providerRefundId:{type:String,maxlength:120}, provider:{type:String,enum:['flutterwave','cod_manual'],default:'flutterwave',index:true},
  requestedByUserId:{type:Schema.Types.ObjectId,ref:'User'}, completedByUserId:{type:Schema.Types.ObjectId,ref:'User'}, manualReference:{type:String,maxlength:180,default:''},
  status:{type:String,enum:['pending','processing','completed','failed'],default:'pending',index:true}, completedAt:Date
},{timestamps:true,optimisticConcurrency:true});
export const Refund=mongoose.model('Refund',refundSchema);

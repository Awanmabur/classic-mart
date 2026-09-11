import mongoose from 'mongoose';
const { Schema }=mongoose;
const allocationSchema=new Schema({storePublicId:{type:String,required:true,maxlength:100},productPublicId:{type:String,maxlength:100,default:''},variantPublicId:{type:String,maxlength:100,default:''},sku:{type:String,maxlength:100,default:''},costSnapshotStatus:{type:String,enum:['captured','legacy_unknown'],default:'legacy_unknown'},orderLineId:{type:String,maxlength:100,default:''},grossMinor:{type:Number,required:true,min:1},platformFeeMinor:{type:Number,min:0,default:0},sellerReceivableMinor:{type:Number,min:0,default:0}},{_id:false});
const refundSchema=new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  idempotencyKey:{type:String,required:true,unique:true,immutable:true,maxlength:120},
  orderId:{type:Schema.Types.ObjectId,ref:'Order',required:true,index:true},
  paymentIntentId:{type:Schema.Types.ObjectId,ref:'PaymentIntent',required:true,index:true},
  amountMinor:{type:Number,required:true,min:1},
  currency:{type:String,required:true,uppercase:true},
  reason:{type:String,required:true,maxlength:300},
  allocations:{type:[allocationSchema],default:[]},
  providerRefundId:{type:String,maxlength:180},
  provider:{type:String,enum:['pesapal','cod_manual','external_manual'],default:'pesapal',index:true},
  providerStatus:{type:String,maxlength:120,default:''},
  providerMessage:{type:String,maxlength:400,default:''},
  requestedByUserId:{type:Schema.Types.ObjectId,ref:'User'},
  completedByUserId:{type:Schema.Types.ObjectId,ref:'User'},
  manualReference:{type:String,maxlength:180,default:''},
  status:{type:String,enum:['pending','processing','completed','failed','cancelled'],default:'pending',index:true},
  completedAt:Date
},{timestamps:true,optimisticConcurrency:true});
refundSchema.index({paymentIntentId:1,provider:1,status:1});
export const Refund=mongoose.model('Refund',refundSchema);

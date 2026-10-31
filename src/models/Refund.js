import mongoose from 'mongoose';
const { Schema }=mongoose;
const allocationSchema=new Schema({storePublicId:{type:String,required:true,maxlength:100},productPublicId:{type:String,maxlength:100,default:''},variantPublicId:{type:String,maxlength:100,default:''},sku:{type:String,maxlength:100,default:''},costSnapshotStatus:{type:String,enum:['captured','legacy_unknown'],default:'legacy_unknown'},orderLineId:{type:String,maxlength:100,default:''},grossMinor:{type:Number,required:true,min:1},platformContributionMinor:{type:Number,min:0,default:0},sourceCashOffsetMinor:{type:Number,min:0,default:0},sourceHash:{type:String,maxlength:64,default:''},platformFeeMinor:{type:Number,min:0,default:0},sellerReceivableMinor:{type:Number,min:0,default:0}},{_id:false});
// An operator's historical attestation is distinct from a provider outcome.
// Ordinary saves/updates cannot replace it; the authorized service inserts it
// once using an expected-version and missing-review transaction fence.
const nonDisbursementReviewSchema=new Schema({
  actorUserId:{type:Schema.Types.ObjectId,ref:'User',required:true,immutable:true},
  reference:{type:String,required:true,minlength:4,maxlength:180,immutable:true},
  reason:{type:String,required:true,minlength:16,maxlength:400,immutable:true},
  recordedAt:{type:Date,required:true,immutable:true},
  sourceVersion:{type:Number,required:true,min:0,validate:Number.isSafeInteger,immutable:true},
},{_id:false});
const cancellationSettlementSchema=new Schema({
  sourceHash:{type:String,required:true,minlength:64,maxlength:64,immutable:true},
  originalLedgerPublicId:{type:String,required:true,maxlength:100,immutable:true},
  originalLedgerHash:{type:String,required:true,minlength:64,maxlength:64,immutable:true},
  completedRefunds:{type:[new Schema({
    refundPublicId:{type:String,required:true,maxlength:100,immutable:true},
    amountMinor:{type:Number,required:true,min:1,validate:Number.isSafeInteger,immutable:true},
    ledgerPublicId:{type:String,required:true,maxlength:100,immutable:true},
    ledgerHash:{type:String,required:true,minlength:64,maxlength:64,immutable:true},
  },{_id:false})],default:[],immutable:true},
},{_id:false});
const refundSchema=new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  idempotencyKey:{type:String,required:true,unique:true,immutable:true,maxlength:120},
  orderId:{type:Schema.Types.ObjectId,ref:'Order',required:true,index:true},
  paymentIntentId:{type:Schema.Types.ObjectId,ref:'PaymentIntent',required:true,index:true},
  returnRequestId:{type:Schema.Types.ObjectId,ref:'ReturnRequest',immutable:true},
  returnPublicId:{type:String,maxlength:100,immutable:true},
  amountMinor:{type:Number,required:true,min:1},
  currency:{type:String,required:true,uppercase:true},
  reason:{type:String,required:true,maxlength:300},
  allocations:{type:[allocationSchema],default:[]},
  settlementMode:{type:String,enum:['original_or_lines','cancellation_remainder'],default:'original_or_lines',immutable:true},
  cancellationSettlement:{type:cancellationSettlementSchema,default:undefined,immutable:true},
  providerRefundId:{type:String,maxlength:180},
  provider:{type:String,enum:['pesapal','cod_manual','external_manual','wallet'],default:'pesapal',index:true},
  providerStatus:{type:String,maxlength:120,default:''},
  providerMessage:{type:String,maxlength:400,default:''},
  requestedByUserId:{type:Schema.Types.ObjectId,ref:'User'},
  completedByUserId:{type:Schema.Types.ObjectId,ref:'User'},
  manualReference:{type:String,maxlength:180,default:''},
  nonDisbursementReview:{type:nonDisbursementReviewSchema,default:undefined,immutable:true},
  status:{type:String,enum:['pending','processing','completed','failed','cancelled'],default:'pending',index:true},
  completedAt:Date
},{timestamps:true,optimisticConcurrency:true});
refundSchema.index({paymentIntentId:1,provider:1,status:1});
refundSchema.index({orderId:1,createdAt:-1});
refundSchema.index({returnRequestId:1},{unique:true,partialFilterExpression:{returnRequestId:{$type:'objectId'}}});
export const Refund=mongoose.model('Refund',refundSchema);

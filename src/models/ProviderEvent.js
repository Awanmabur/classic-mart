import mongoose from 'mongoose';
const { Schema }=mongoose;
const providerEventSchema=new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  traceId:{type:String,maxlength:32,default:'',immutable:true,index:true},
  traceSpanId:{type:String,maxlength:16,default:'',immutable:true},
  provider:{type:String,required:true,index:true},
  eventId:{type:String,required:true,maxlength:180},
  eventType:{type:String,required:true,maxlength:120},
  merchantReference:{type:String,maxlength:100,default:'',index:true},
  providerTrackingId:{type:String,maxlength:180,default:'',index:true},
  paymentIntentPublicId:{type:String,maxlength:100,default:'',index:true},
  orderPublicId:{type:String,maxlength:100,default:'',index:true},
  country:{type:String,maxlength:3,uppercase:true,default:'',index:true},
  rawHash:{type:String,required:true,immutable:true,select:false},
  rawEncrypted:{type:String,required:true,select:false},
  verifiedAt:{type:Date,required:true},
  processedAt:Date,
  status:{type:String,enum:['received','processing','processed','ignored','failed','dead'],default:'received',index:true},
  attempts:{type:Number,min:0,default:0},
  nextAttemptAt:{type:Date,default:Date.now,index:true},
  lockedBy:{type:String,maxlength:120,default:''},
  lockedUntil:{type:Date,index:true},
  error:{type:String,maxlength:500,default:''},
  manualReplayCount:{type:Number,min:0,default:0},
  lastManualReplayAt:Date,
  lastManualReplayByUserId:{type:Schema.Types.ObjectId,ref:'User'},
  manualReplayReason:{type:String,maxlength:300,default:''}
},{timestamps:true});
providerEventSchema.index({provider:1,eventId:1},{unique:true});
providerEventSchema.index({provider:1,status:1,nextAttemptAt:1,lockedUntil:1,createdAt:1});
providerEventSchema.index({country:1,status:1,createdAt:-1});
export const ProviderEvent=mongoose.model('ProviderEvent',providerEventSchema);

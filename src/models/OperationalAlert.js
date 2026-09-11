import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  fingerprint:{type:String,required:true,unique:true,immutable:true,index:true,maxlength:128},
  type:{type:String,required:true,index:true,maxlength:120},
  severity:{type:String,enum:['info','warning','high','critical'],required:true,index:true},
  country:{type:String,uppercase:true,maxlength:2,default:'',index:true},
  resourceType:{type:String,maxlength:80,default:'',index:true},
  resourcePublicId:{type:String,maxlength:120,default:'',index:true},
  title:{type:String,required:true,maxlength:220},
  message:{type:String,required:true,maxlength:1200},
  status:{type:String,enum:['open','acknowledged','investigating','resolved','suppressed'],default:'open',index:true},
  firstSeenAt:{type:Date,default:Date.now,required:true},
  lastSeenAt:{type:Date,default:Date.now,required:true,index:true},
  resolvedAt:Date,
  acknowledgedByUserId:{type:Schema.Types.ObjectId,ref:'User'},
  acknowledgedAt:Date,
  resolvedByUserId:{type:Schema.Types.ObjectId,ref:'User'},
  resolutionNote:{type:String,maxlength:1000,default:''},
  scanToken:{type:String,maxlength:80,default:'',index:true},
  details:{type:Schema.Types.Mixed,default:{}},
},{timestamps:true,optimisticConcurrency:true,minimize:false});
schema.index({status:1,severity:1,lastSeenAt:-1});
schema.index({country:1,status:1,severity:1,lastSeenAt:-1});
export const OperationalAlert=mongoose.model('OperationalAlert',schema);

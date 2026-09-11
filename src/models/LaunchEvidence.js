import mongoose from 'mongoose';
const recoveryMetricsSchema=new mongoose.Schema({
  rpoMinutes:{type:Number,min:0},
  rtoMinutes:{type:Number,min:0},
  sourceSnapshotAt:Date,
  restoredAt:Date,
  drillId:{type:String,maxlength:160,default:''},
  provider:{type:String,maxlength:120,default:''},
  scope:{type:String,maxlength:500,default:''},
},{_id:false});
const schema=new mongoose.Schema({
  key:{type:String,required:true,unique:true,immutable:true,index:true},
  label:{type:String,required:true,maxlength:180},
  status:{type:String,enum:['missing','passed','failed','not_applicable'],default:'missing',index:true},
  evidence:{type:String,maxlength:4000,default:''},
  recoveryMetrics:{type:recoveryMetricsSchema,default:undefined},
  validUntil:Date,
  verifiedByUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User'},
  verifiedAt:Date,
},{timestamps:true});
schema.index({status:1,validUntil:1});
export const LaunchEvidence=mongoose.model('LaunchEvidence',schema);

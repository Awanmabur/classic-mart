import mongoose from 'mongoose';

const { Schema } = mongoose;

const workerHeartbeatSchema = new Schema({
  workerId:{type:String,required:true,unique:true,immutable:true,index:true,maxlength:180},
  role:{type:String,enum:['maintenance'],default:'maintenance',required:true,index:true},
  hostname:{type:String,required:true,maxlength:180},
  pid:{type:Number,required:true,min:1},
  status:{type:String,enum:['running','stopping','error'],default:'running',index:true},
  startedAt:{type:Date,required:true},
  lastHeartbeatAt:{type:Date,required:true,index:true},
  lastCycleStartedAt:Date,
  lastCycleCompletedAt:Date,
  lastCycleDurationMs:{type:Number,min:0,default:0},
  lastCycleOk:{type:Boolean,default:true},
  lastError:{type:String,maxlength:1000,default:''},
  expiresAt:{type:Date,required:true},
},{timestamps:true});

workerHeartbeatSchema.index({expiresAt:1},{expireAfterSeconds:0});
workerHeartbeatSchema.index({role:1,status:1,lastHeartbeatAt:-1});

export const WorkerHeartbeat=mongoose.model('WorkerHeartbeat',workerHeartbeatSchema);

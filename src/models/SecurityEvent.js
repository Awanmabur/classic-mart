import mongoose from 'mongoose';

const securityEventSchema = new mongoose.Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  occurredAt:{type:Date,default:Date.now,immutable:true,index:true},
  requestId:{type:String,maxlength:100,index:true,immutable:true},
  type:{type:String,required:true,maxlength:120,index:true,immutable:true},
  category:{type:String,enum:['authentication','reconnaissance','injection','abuse','authorization','integrity','operations','mfa','other'],default:'other',index:true,immutable:true},
  severity:{type:String,enum:['low','medium','high','critical'],required:true,index:true,immutable:true},
  result:{type:String,enum:['detected','blocked','failure','success','error'],default:'detected',immutable:true},
  country:{type:String,uppercase:true,maxlength:2,default:'',index:true,immutable:true},
  actorUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User',immutable:true},
  actorPublicId:{type:String,maxlength:120,index:true,immutable:true},
  ipHash:{type:String,required:true,index:true,immutable:true,select:false},
  userAgentHash:{type:String,default:'',immutable:true,select:false},
  method:{type:String,maxlength:16,default:'',immutable:true},
  path:{type:String,maxlength:500,default:'',immutable:true},
  statusCode:{type:Number,min:0,max:999,immutable:true},
  metadata:{type:mongoose.Schema.Types.Mixed,default:undefined,immutable:true},
  integrity:{type:String,required:true,select:false,immutable:true},
  siemStatus:{type:String,enum:['pending','retry','sent','dead','disabled'],default:'pending',index:true},
  siemAttempts:{type:Number,default:0,min:0},
  siemNextAttemptAt:{type:Date,default:Date.now,index:true},
  siemLastAttemptAt:Date,
  siemSentAt:Date,
  siemLastError:{type:String,maxlength:500,default:''},
},{timestamps:true});
securityEventSchema.index({country:1,severity:1,occurredAt:-1});
securityEventSchema.index({siemStatus:1,siemNextAttemptAt:1});
export const SecurityEvent=mongoose.model('SecurityEvent',securityEventSchema);

import mongoose from 'mongoose';
const schema=new mongoose.Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  targetUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true,index:true},
  targetPublicId:{type:String,required:true,maxlength:120,index:true},
  country:{type:String,uppercase:true,maxlength:2,default:'',index:true},
  reason:{type:String,required:true,minlength:3,maxlength:1000},
  status:{type:String,enum:['requested','approved','rejected','applied','expired'],default:'requested',index:true},
  requestedByUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true},
  decidedByUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User'},
  decisionReason:{type:String,maxlength:1000,default:''},
  decidedAt:Date,
  appliedAt:Date,
  expiresAt:{type:Date,required:true,index:true},
},{timestamps:true});
schema.index({country:1,status:1,createdAt:-1});
export const MfaRecoveryRequest=mongoose.model('MfaRecoveryRequest',schema);

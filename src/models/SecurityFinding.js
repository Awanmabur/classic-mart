import mongoose from 'mongoose';
const schema=new mongoose.Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  country:{type:String,uppercase:true,maxlength:2,default:'',index:true},
  severity:{type:String,enum:['low','medium','high','critical'],required:true,index:true},
  title:{type:String,required:true,trim:true,maxlength:180},
  details:{type:String,required:true,trim:true,maxlength:4000},
  status:{type:String,enum:['open','remediated','acceptance_requested','risk_accepted'],default:'open',index:true},
  remediation:{type:String,maxlength:4000,default:''},
  ownerUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User'},
  remediatedAt:Date,
  riskReason:{type:String,maxlength:2000,default:''},
  riskRequestedByUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User'},
  riskRequestedAt:Date,
  riskApprovedByUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User'},
  riskApprovedAt:Date,
},{timestamps:true});
schema.index({country:1,status:1,severity:1,createdAt:-1});
export const SecurityFinding=mongoose.model('SecurityFinding',schema);

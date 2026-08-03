import mongoose from 'mongoose';
const schema=new mongoose.Schema({
  key:{type:String,required:true,unique:true,immutable:true,index:true},
  label:{type:String,required:true,maxlength:180},
  status:{type:String,enum:['missing','passed','failed','not_applicable'],default:'missing',index:true},
  evidence:{type:String,maxlength:4000,default:''},
  verifiedByUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User'},
  verifiedAt:Date,
},{timestamps:true});
export const LaunchEvidence=mongoose.model('LaunchEvidence',schema);

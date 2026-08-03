import mongoose from 'mongoose';
const incidentEventSchema=new mongoose.Schema({type:{type:String,maxlength:80,required:true},message:{type:String,maxlength:2000,required:true},actorUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User'},at:{type:Date,default:Date.now}},{_id:false});
const incidentSchema=new mongoose.Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  country:{type:String,uppercase:true,maxlength:2,default:'',index:true},
  severity:{type:String,enum:['sev1','sev2','sev3','sev4'],required:true,index:true},
  status:{type:String,enum:['open','investigating','monitoring','resolved'],default:'open',index:true},
  title:{type:String,required:true,trim:true,maxlength:180},
  summary:{type:String,required:true,maxlength:4000},
  ownerUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User'},
  startedAt:{type:Date,default:Date.now},
  resolvedAt:Date,
  timeline:{type:[incidentEventSchema],default:[]},
},{timestamps:true});
export const Incident=mongoose.model('Incident',incidentSchema);

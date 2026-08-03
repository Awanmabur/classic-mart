import mongoose from 'mongoose';
const dataExportSchema=new mongoose.Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  type:{type:String,enum:['orders','sellers','promoters','support','audit'],required:true,index:true},
  country:{type:String,uppercase:true,maxlength:2,default:'',index:true},
  status:{type:String,enum:['requested','approved','processing','ready','failed','expired'],default:'requested',index:true},
  requestedByUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true},
  approvedByUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User'},
  reason:{type:String,required:true,maxlength:1000},
  storageKey:{type:String,select:false,maxlength:240,default:''},
  rowCount:{type:Number,min:0,default:0},
  expiresAt:Date,
  readyAt:Date,
  failureMessage:{type:String,maxlength:1000,default:''},
},{timestamps:true});
export const DataExport=mongoose.model('DataExport',dataExportSchema);

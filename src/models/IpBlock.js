import mongoose from 'mongoose';
const ipBlockSchema=new mongoose.Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  ipHash:{type:String,required:true,index:true,select:false},
  reason:{type:String,required:true,maxlength:500},
  sourceEventPublicId:{type:String,maxlength:120,default:''},
  severity:{type:String,enum:['medium','high','critical'],default:'high'},
  expiresAt:{type:Date,required:true,index:true},
  hitCount:{type:Number,default:0,min:0},
  lastHitAt:Date,
  revokedAt:Date,
  revokedByUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User'},
},{timestamps:true});
ipBlockSchema.index({ipHash:1,expiresAt:1});
export const IpBlock=mongoose.model('IpBlock',ipBlockSchema);

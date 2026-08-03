import mongoose from 'mongoose';
const {Schema}=mongoose;
const schema=new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  organizationId:{type:Schema.Types.ObjectId,ref:'BusinessOrganization',required:true,index:true},
  userId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},
  role:{type:String,enum:['owner','admin','buyer','approver','viewer'],required:true,index:true},
  status:{type:String,enum:['invited','active','revoked'],default:'invited',index:true},
  spendingLimitMinor:{type:Number,min:0,max:10_000_000_000,default:0},
  canApprove:{type:Boolean,default:false},
  invitedByUserId:{type:Schema.Types.ObjectId,ref:'User',required:true},
  invitedAt:{type:Date,default:Date.now},acceptedAt:Date,revokedAt:Date,
},{timestamps:true,optimisticConcurrency:true});
schema.index({organizationId:1,userId:1},{unique:true});
export const BusinessMember=mongoose.model('BusinessMember',schema);

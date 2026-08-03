import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({
 publicId:{type:String,required:true,unique:true,immutable:true,index:true},campaignId:{type:Schema.Types.ObjectId,ref:'Campaign',required:true,index:true},campaignPublicId:{type:String,required:true,index:true},
 promoterUserId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},country:{type:String,required:true,uppercase:true,index:true},
 note:{type:String,maxlength:1000,default:''},status:{type:String,enum:['pending','approved','rejected','revoked'],default:'pending',index:true},reason:{type:String,maxlength:500,default:''},reviewedByUserId:{type:Schema.Types.ObjectId,ref:'User'},reviewedAt:Date,
},{timestamps:true,optimisticConcurrency:true});
schema.index({campaignId:1,promoterUserId:1},{unique:true});
export const CampaignApplication=mongoose.model('CampaignApplication',schema);

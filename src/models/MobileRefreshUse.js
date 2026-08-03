import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({tokenHash:{type:String,required:true,unique:true,immutable:true,index:true,select:false},familyId:{type:String,required:true,index:true},userId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},usedAt:{type:Date,required:true,default:Date.now},expiresAt:{type:Date,required:true}},{timestamps:false});
schema.index({expiresAt:1},{expireAfterSeconds:0});
export const MobileRefreshUse=mongoose.model('MobileRefreshUse',schema);

import mongoose from 'mongoose';
const {Schema}=mongoose;
const schema=new Schema({publicId:{type:String,required:true,unique:true,immutable:true,index:true},storeId:{type:Schema.Types.ObjectId,ref:'Store',required:true,index:true},variantId:{type:Schema.Types.ObjectId,ref:'ProductVariant',required:true,index:true},variantPublicId:{type:String,required:true,index:true},previousPriceMinor:{type:Number,required:true,min:0},newPriceMinor:{type:Number,required:true,min:0},minimumPriceMinor:{type:Number,required:true,min:0},startsAt:{type:Date,required:true,index:true},status:{type:String,enum:['scheduled','applied','cancelled','failed'],default:'scheduled',index:true},appliedAt:Date,failureReason:{type:String,maxlength:500,default:''},createdByUserId:{type:Schema.Types.ObjectId,ref:'User',required:true}},{timestamps:true,optimisticConcurrency:true});
schema.index({status:1,startsAt:1});
export const PriceSchedule=mongoose.model('PriceSchedule',schema);

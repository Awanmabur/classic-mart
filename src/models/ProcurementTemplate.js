import mongoose from 'mongoose';
const {Schema}=mongoose;
const itemSchema=new Schema({productPublicId:{type:String,required:true},quantity:{type:Number,required:true,min:1,max:9999}},{_id:false});
const schema=new Schema({publicId:{type:String,required:true,unique:true,immutable:true,index:true},organizationId:{type:Schema.Types.ObjectId,ref:'BusinessOrganization',required:true,index:true},name:{type:String,required:true,maxlength:140},items:{type:[itemSchema],required:true},recurrence:{type:String,enum:['none','weekly','monthly'],default:'none'},nextDueAt:Date,active:{type:Boolean,default:true,index:true},createdByUserId:{type:Schema.Types.ObjectId,ref:'User',required:true}},{timestamps:true,optimisticConcurrency:true});
export const ProcurementTemplate=mongoose.model('ProcurementTemplate',schema);

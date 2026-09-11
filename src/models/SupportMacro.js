import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({
 publicId:{type:String,required:true,unique:true,immutable:true,index:true},country:{type:String,required:true,uppercase:true,index:true},title:{type:String,required:true,trim:true,maxlength:120},body:{type:String,required:true,trim:true,maxlength:4000},category:{type:String,enum:['','order','payment','delivery','return','refund','account','product','seller','other'],default:'',index:true},active:{type:Boolean,default:true,index:true},createdByUserId:{type:Schema.Types.ObjectId,ref:'User',required:true},updatedByUserId:{type:Schema.Types.ObjectId,ref:'User'},
},{timestamps:true,optimisticConcurrency:true});
schema.index({country:1,active:1,category:1,title:1});
export const SupportMacro=mongoose.model('SupportMacro',schema);

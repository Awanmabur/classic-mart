import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({publicId:{type:String,required:true,unique:true,immutable:true,index:true},country:{type:String,required:true,uppercase:true,index:true},title:{type:String,required:true,maxlength:180},slug:{type:String,required:true,maxlength:180},body:{type:String,required:true,maxlength:12000},category:{type:String,required:true,maxlength:80},status:{type:String,enum:['draft','published','archived'],default:'draft',index:true},createdByUserId:{type:Schema.Types.ObjectId,ref:'User',required:true},updatedByUserId:{type:Schema.Types.ObjectId,ref:'User',required:true},publishedAt:Date},{timestamps:true,optimisticConcurrency:true});
schema.index({country:1,slug:1},{unique:true});
export const SupportKnowledge=mongoose.model('SupportKnowledge',schema);

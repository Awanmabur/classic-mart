import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({publicId:{type:String,required:true,unique:true,immutable:true,index:true},clientActionId:{type:String,required:true,maxlength:120},userId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},country:{type:String,required:true,uppercase:true,index:true},action:{type:String,required:true,maxlength:80},targetPublicId:{type:String,required:true,maxlength:120},status:{type:String,enum:['processing','completed','failed'],default:'processing'},result:{type:Schema.Types.Mixed,default:{}},error:{type:String,maxlength:400,default:''}},{timestamps:true});
schema.index({userId:1,clientActionId:1},{unique:true});
export const OperationAction=mongoose.model('OperationAction',schema);

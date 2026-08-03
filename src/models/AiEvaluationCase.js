import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({publicId:{type:String,required:true,unique:true,index:true,immutable:true},suite:{type:String,required:true,index:true,maxlength:80},name:{type:String,required:true,maxlength:160},feature:{type:String,required:true,maxlength:100},input:{type:Schema.Types.Mixed,required:true,select:false},expectations:{type:Schema.Types.Mixed,required:true},active:{type:Boolean,default:true,index:true}},{timestamps:true});
export const AiEvaluationCase=mongoose.model('AiEvaluationCase',schema);

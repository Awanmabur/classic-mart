import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({publicId:{type:String,required:true,unique:true,index:true,immutable:true},suite:{type:String,required:true,index:true},country:{type:String,required:true,uppercase:true,index:true},provider:{type:String,required:true},model:{type:String,required:true},status:{type:String,enum:['running','passed','failed'],default:'running',index:true},metrics:{type:Schema.Types.Mixed,default:{}},failures:{type:[String],default:[]},startedAt:{type:Date,default:Date.now},completedAt:Date},{timestamps:true});schema.index({country:1,createdAt:-1});
export const AiEvaluationRun=mongoose.model('AiEvaluationRun',schema);

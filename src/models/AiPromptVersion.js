import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({
 publicId:{type:String,required:true,unique:true,index:true,immutable:true},key:{type:String,required:true,index:true,trim:true,maxlength:120},version:{type:Number,required:true,min:1},purpose:{type:String,required:true,maxlength:80},
 country:{type:String,default:'',uppercase:true,maxlength:2},status:{type:String,enum:['draft','active','retired'],default:'draft',index:true},schemaKey:{type:String,required:true,maxlength:100},instructions:{type:String,required:true,maxlength:16000},createdByUserId:{type:Schema.Types.ObjectId,ref:'User'},activatedAt:Date,
},{timestamps:true});
schema.index({key:1,country:1,version:1},{unique:true});schema.index({key:1,country:1,status:1});
export const AiPromptVersion=mongoose.model('AiPromptVersion',schema);

import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({
 publicId:{type:String,required:true,unique:true,index:true,immutable:true},entityType:{type:String,required:true,enum:['product'],index:true},entityPublicId:{type:String,required:true,index:true},country:{type:String,required:true,uppercase:true,index:true},modelKey:{type:String,required:true,index:true},dimensions:{type:Number,required:true,min:8,max:4096},vector:{type:[Number],required:true,select:false},sourceHash:{type:String,required:true,maxlength:64},sourceUpdatedAt:{type:Date,required:true},
},{timestamps:true});
schema.index({entityType:1,entityPublicId:1,country:1,modelKey:1},{unique:true});schema.index({country:1,modelKey:1,updatedAt:-1});
export const AiEmbedding=mongoose.model('AiEmbedding',schema);

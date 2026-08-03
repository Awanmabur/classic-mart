import mongoose from 'mongoose';
const { Schema }=mongoose;
const item=new Schema({productPublicId:{type:String,required:true},variantPublicId:{type:String,required:true},quantity:{type:Number,required:true,min:1,max:20}},{_id:false});
const schema=new Schema({publicId:{type:String,required:true,unique:true,index:true,immutable:true},sessionKey:{type:String,required:true,index:true,maxlength:160},userId:{type:Schema.Types.ObjectId,ref:'User',index:true},country:{type:String,required:true,uppercase:true,index:true},items:{type:[item],default:[]},status:{type:String,enum:['proposed','applied','expired','cancelled'],default:'proposed',index:true},expiresAt:{type:Date,required:true},appliedAt:Date},{timestamps:true});schema.index({expiresAt:1},{expireAfterSeconds:0});
export const AiCartDraft=mongoose.model('AiCartDraft',schema);

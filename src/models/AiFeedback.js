import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({publicId:{type:String,required:true,unique:true,index:true,immutable:true},usagePublicId:{type:String,required:true,index:true},actorUserId:{type:Schema.Types.ObjectId,ref:'User',index:true},country:{type:String,required:true,uppercase:true,index:true},rating:{type:String,enum:['helpful','not_helpful','incorrect','unsafe'],required:true},comment:{type:String,default:'',maxlength:1000}},{timestamps:true});schema.index({usagePublicId:1,actorUserId:1},{unique:true,sparse:true});
export const AiFeedback=mongoose.model('AiFeedback',schema);

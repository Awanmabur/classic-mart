import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({publicId:{type:String,required:true,unique:true,immutable:true,index:true},ticketId:{type:Schema.Types.ObjectId,ref:'SupportTicket',required:true,index:true},ticketPublicId:{type:String,required:true,index:true},userId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},rating:{type:Number,required:true,min:1,max:5},comment:{type:String,maxlength:1000,default:''}},{timestamps:true});
schema.index({ticketId:1,userId:1},{unique:true});
export const SatisfactionSurvey=mongoose.model('SatisfactionSurvey',schema);

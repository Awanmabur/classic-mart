import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({
 ticketId:{type:Schema.Types.ObjectId,ref:'SupportTicket',required:true,index:true},userId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},country:{type:String,required:true,uppercase:true,index:true},expiresAt:{type:Date,required:true},
},{timestamps:true});
schema.index({ticketId:1,userId:1},{unique:true});
schema.index({expiresAt:1},{expireAfterSeconds:0});
export const SupportTicketPresence=mongoose.model('SupportTicketPresence',schema);

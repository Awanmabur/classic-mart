import mongoose from 'mongoose';
const { Schema }=mongoose;
const messageSchema=new Schema({
  publicId:{type:String,required:true},
  senderUserId:{type:Schema.Types.ObjectId,ref:'User',required:true},
  body:{type:String,required:true,maxlength:4000},
  sentAt:{type:Date,default:Date.now,required:true},
  readByUserIds:{type:[Schema.Types.ObjectId],ref:'User',default:[]},
},{_id:false});
const schema=new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  participantUserIds:{type:[Schema.Types.ObjectId],ref:'User',required:true,index:true},
  country:{type:String,uppercase:true,minlength:2,maxlength:2,index:true},
  contextType:{type:String,enum:['general','order','product','campaign','store','support'],default:'general',index:true},
  contextPublicId:{type:String,trim:true,maxlength:120,default:'',index:true},
  subject:{type:String,trim:true,maxlength:180,default:''},
  status:{type:String,enum:['open','archived','closed'],default:'open',index:true},
  lastMessageAt:{type:Date,default:Date.now,index:true},
  messages:{type:[messageSchema],default:[],validate:{validator:v=>v.length<=500,message:'Conversation message history is capped at 500 messages.'}},
},{timestamps:true,optimisticConcurrency:true});
schema.index({participantUserIds:1,lastMessageAt:-1});
export const MarketplaceConversation=mongoose.model('MarketplaceConversation',schema);

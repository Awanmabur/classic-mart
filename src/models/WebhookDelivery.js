import mongoose from 'mongoose';
const {Schema}=mongoose;
const schema=new Schema({
 publicId:{type:String,required:true,unique:true,immutable:true,index:true},endpointId:{type:Schema.Types.ObjectId,ref:'WebhookEndpoint',required:true,index:true},storeId:{type:Schema.Types.ObjectId,ref:'Store',required:true,index:true},
 eventId:{type:String,required:true,index:true},eventType:{type:String,required:true,index:true},payload:{type:Schema.Types.Mixed,required:true},attempt:{type:Number,default:0,min:0,max:10},
 status:{type:String,enum:['queued','processing','delivered','failed','dead'],default:'queued',index:true},nextAttemptAt:{type:Date,default:Date.now,index:true},lastAttemptAt:{type:Date,default:null},responseStatus:{type:Number,default:0},responseHash:{type:String,default:''},lockedBy:{type:String,maxlength:120,default:''},lockedUntil:{type:Date,default:null,index:true},errorMessage:{type:String,trim:true,maxlength:500,default:''},deliveredAt:{type:Date,default:null}
},{timestamps:true});
schema.index({endpointId:1,eventId:1},{unique:true});
schema.index({status:1,nextAttemptAt:1,lockedUntil:1});
export const WebhookDelivery=mongoose.model('WebhookDelivery',schema);

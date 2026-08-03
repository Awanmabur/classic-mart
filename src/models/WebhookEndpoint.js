import mongoose from 'mongoose';
const {Schema}=mongoose;
const schema=new Schema({
 publicId:{type:String,required:true,unique:true,immutable:true,index:true},storeId:{type:Schema.Types.ObjectId,ref:'Store',required:true,index:true},createdByUserId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},
 url:{type:String,required:true,trim:true,maxlength:1000},events:{type:[String],default:[]},secretEncrypted:{type:String,required:true,select:false},secretLast4:{type:String,required:true,maxlength:4},
 status:{type:String,enum:['active','paused','revoked'],default:'active',index:true},lastDeliveryAt:{type:Date,default:null},lastSuccessAt:{type:Date,default:null},failureCount:{type:Number,default:0,min:0,max:1000},rotatedAt:{type:Date,default:null},revokedAt:{type:Date,default:null}
},{timestamps:true});
schema.index({storeId:1,status:1,createdAt:-1});
export const WebhookEndpoint=mongoose.model('WebhookEndpoint',schema);

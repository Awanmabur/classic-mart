import mongoose from 'mongoose';
const {Schema}=mongoose;
const schema=new Schema({apiClientId:{type:Schema.Types.ObjectId,ref:'ApiClient',required:true,index:true},key:{type:String,required:true,maxlength:160},requestHash:{type:String,required:true,immutable:true},status:{type:String,enum:['in_progress','completed','failed'],default:'in_progress',index:true},statusCode:{type:Number,min:100,max:599,default:null},responseBody:{type:Schema.Types.Mixed,default:null},lockedUntil:{type:Date,index:true},failureCode:{type:String,maxlength:100,default:''},failureMessage:{type:String,maxlength:500,default:''},expiresAt:{type:Date,required:true}},{timestamps:true});
schema.index({apiClientId:1,key:1},{unique:true});
schema.index({expiresAt:1},{expireAfterSeconds:0});
export const ApiIdempotency=mongoose.model('ApiIdempotency',schema);

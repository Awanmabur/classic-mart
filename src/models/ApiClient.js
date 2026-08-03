import mongoose from 'mongoose';
const {Schema}=mongoose;
const schema=new Schema({
 publicId:{type:String,required:true,unique:true,immutable:true,index:true},storeId:{type:Schema.Types.ObjectId,ref:'Store',required:true,index:true},createdByUserId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},
 name:{type:String,required:true,trim:true,maxlength:120},keyPrefix:{type:String,required:true,unique:true,immutable:true,index:true},secretHash:{type:String,required:true,select:false},
 scopes:{type:[String],default:[]},status:{type:String,enum:['active','revoked'],default:'active',index:true},requestsPerMinute:{type:Number,default:120,min:10,max:1200},
 quotaWindowAt:{type:Date,default:Date.now},quotaCount:{type:Number,default:0,min:0},lastUsedAt:{type:Date,default:null},expiresAt:{type:Date,default:null,index:true},rotatedAt:{type:Date,default:null},revokedAt:{type:Date,default:null}
},{timestamps:true});
schema.index({storeId:1,status:1,createdAt:-1});
export const ApiClient=mongoose.model('ApiClient',schema);

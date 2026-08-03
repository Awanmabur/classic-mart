import mongoose from 'mongoose';
const {Schema}=mongoose;
const schema=new Schema({
 publicId:{type:String,required:true,unique:true,immutable:true,index:true},userId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},
 platform:{type:String,enum:['web','android','ios'],required:true,index:true},tokenHash:{type:String,required:true,index:true},tokenEncrypted:{type:String,required:true,select:false},
 label:{type:String,trim:true,maxlength:120,default:''},country:{type:String,uppercase:true,minlength:2,maxlength:2,index:true},status:{type:String,enum:['active','revoked','invalid'],default:'active',index:true},
 lastSeenAt:{type:Date,default:Date.now},revokedAt:{type:Date,default:null},failureCount:{type:Number,default:0,min:0,max:50}
},{timestamps:true});
schema.index({userId:1,tokenHash:1},{unique:true});
export const PushDevice=mongoose.model('PushDevice',schema);

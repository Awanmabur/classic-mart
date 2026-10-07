import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  userId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},
  country:{type:String,uppercase:true,minlength:2,maxlength:2,index:true},
  type:{type:String,required:true,trim:true,maxlength:80,index:true},
  title:{type:String,required:true,trim:true,maxlength:180},
  body:{type:String,required:true,maxlength:1500},
  href:{type:String,trim:true,maxlength:500,default:''},
  importance:{type:String,enum:['normal','high','urgent'],default:'normal',index:true},
  readAt:Date,
  expiresAt:{type:Date,index:true},
},{timestamps:true});
schema.index({userId:1,readAt:1,createdAt:-1});
export const Notification=mongoose.model('Notification',schema);

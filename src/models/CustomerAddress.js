import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  userId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},
  label:{type:String,trim:true,maxlength:80,default:'Address'},
  fullName:{type:String,required:true,trim:true,maxlength:120},
  phone:{type:String,required:true,trim:true,maxlength:32},
  address:{type:String,required:true,trim:true,maxlength:240},
  city:{type:String,required:true,trim:true,maxlength:120},
  country:{type:String,required:true,uppercase:true,minlength:2,maxlength:2,index:true},
  note:{type:String,trim:true,maxlength:500,default:''},
  isDefault:{type:Boolean,default:false,index:true},
  archivedAt:Date,
},{timestamps:true,optimisticConcurrency:true});
schema.index({userId:1,isDefault:-1,updatedAt:-1});
export const CustomerAddress=mongoose.model('CustomerAddress',schema);

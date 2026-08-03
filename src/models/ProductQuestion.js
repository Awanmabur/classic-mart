import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  productId:{type:Schema.Types.ObjectId,ref:'Product',required:true,index:true}, productPublicId:{type:String,required:true,index:true},
  storeId:{type:Schema.Types.ObjectId,ref:'Store',required:true,index:true},
  customerUserId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},
  country:{type:String,required:true,uppercase:true,index:true},
  question:{type:String,required:true,minlength:5,maxlength:1000},
  status:{type:String,enum:['open','answered','hidden'],default:'open',index:true},
  answer:{body:{type:String,maxlength:2000,default:''},sellerUserId:{type:Schema.Types.ObjectId,ref:'User'},answeredAt:Date},
  moderationReason:{type:String,maxlength:500,default:''},
},{timestamps:true,optimisticConcurrency:true});
schema.index({productId:1,status:1,createdAt:-1});
export const ProductQuestion=mongoose.model('ProductQuestion',schema);

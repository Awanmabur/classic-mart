import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({
 publicId:{type:String,required:true,unique:true,immutable:true,index:true}, userId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},
 productId:{type:Schema.Types.ObjectId,ref:'Product',required:true,index:true}, productPublicId:{type:String,required:true,index:true}, country:{type:String,required:true,uppercase:true,index:true},
 type:{type:String,enum:['price_drop','restock'],required:true,index:true}, targetPriceMinor:{type:Number,min:0}, lastKnownPriceMinor:{type:Number,min:0},
 status:{type:String,enum:['active','triggered','cancelled'],default:'active',index:true}, triggeredAt:Date,
},{timestamps:true,optimisticConcurrency:true});
schema.index({userId:1,productId:1,type:1},{unique:true});
export const ProductAlert=mongoose.model('ProductAlert',schema);

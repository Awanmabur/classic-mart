import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({
 publicId:{type:String,required:true,unique:true,immutable:true,index:true},shipmentId:{type:Schema.Types.ObjectId,ref:'Shipment',required:true,index:true},shipmentPublicId:{type:String,required:true,index:true},
 deliveryUserId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},country:{type:String,required:true,uppercase:true,index:true},earningMinor:{type:Number,required:true,min:0},currency:{type:String,required:true,uppercase:true},
 status:{type:String,enum:['offered','accepted','declined','expired','cancelled'],default:'offered',index:true},expiresAt:{type:Date,required:true,index:true},respondedAt:Date,
},{timestamps:true,optimisticConcurrency:true});
schema.index({shipmentId:1,deliveryUserId:1},{unique:true});
export const DeliveryOffer=mongoose.model('DeliveryOffer',schema);

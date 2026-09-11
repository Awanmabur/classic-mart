import mongoose from 'mongoose';
const { Schema }=mongoose;
const timelineSchema=new Schema({type:{type:String,required:true,maxlength:80},message:{type:String,required:true,maxlength:240},actorUserId:{type:Schema.Types.ObjectId,ref:'User'},at:{type:Date,default:Date.now}},{_id:false});
const schema=new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  orderId:{type:Schema.Types.ObjectId,ref:'Order',required:true,index:true},orderPublicId:{type:String,required:true,index:true},
  sellerOrderId:{type:Schema.Types.ObjectId,ref:'SellerOrder',required:true,unique:true,index:true},sellerOrderPublicId:{type:String,required:true,unique:true,index:true},
  storeId:{type:Schema.Types.ObjectId,ref:'Store',required:true,index:true},storePublicId:{type:String,required:true,index:true},country:{type:String,required:true,uppercase:true,index:true},
  rootShipmentId:{type:Schema.Types.ObjectId,ref:'Shipment',required:true,index:true},rootShipmentPublicId:{type:String,required:true,index:true},
  parcelId:{type:Schema.Types.ObjectId,ref:'Parcel',required:true,unique:true,index:true},parcelPublicId:{type:String,required:true,unique:true,index:true},
  status:{type:String,enum:['created','picking','picked','packed','handed_over','in_transit','delivered','returned','cancelled'],default:'created',index:true},
  lineCount:{type:Number,min:1,default:1},quantity:{type:Number,min:1,default:1},handedOverAt:Date,deliveredAt:Date,
  timeline:{type:[timelineSchema],default:[]},
},{timestamps:true,optimisticConcurrency:true});
schema.index({storeId:1,status:1,createdAt:-1});
schema.index({orderId:1,storeId:1},{unique:true});
export const SellerShipment=mongoose.model('SellerShipment',schema);

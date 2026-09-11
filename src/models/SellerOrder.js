import mongoose from 'mongoose';
const { Schema }=mongoose;
const itemSchema=new Schema({orderLineId:{type:String,maxlength:100,default:'',immutable:true},productPublicId:String,variantPublicId:String,title:String,variantTitle:String,sku:String,quantity:Number,unitPriceMinor:Number,unitCostMinor:{type:Number,min:0,default:null,immutable:true},costSnapshotStatus:{type:String,enum:['captured','legacy_unknown'],default:'legacy_unknown',immutable:true},lineTotalMinor:Number,currency:String,grossMinor:{type:Number,min:0,default:0,immutable:true},discountMinor:{type:Number,min:0,default:0,immutable:true},customerPaidMinor:{type:Number,min:0,default:0,immutable:true},platformFeeMinor:{type:Number,min:0,default:0,immutable:true},sellerReceivableMinor:{type:Number,min:0,default:0,immutable:true}},{_id:false});
const schema=new Schema({
 publicId:{type:String,required:true,unique:true,immutable:true,index:true}, orderId:{type:Schema.Types.ObjectId,ref:'Order',required:true,index:true}, orderPublicId:{type:String,required:true,index:true},
 storeId:{type:Schema.Types.ObjectId,ref:'Store',required:true,index:true},storePublicId:{type:String,required:true,index:true},country:{type:String,required:true,uppercase:true,index:true},
 status:{type:String,enum:['pending_payment','confirmed','processing','ready','fulfilled','cancellation_pending','cancelled','expired','partially_refunded','refunded'],default:'pending_payment',index:true},
 subtotalMinor:{type:Number,required:true,min:0},platformFeeMinor:{type:Number,default:0,min:0},shippingMinor:{type:Number,default:0,min:0},taxMinor:{type:Number,default:0,min:0},discountMinor:{type:Number,default:0,min:0},currency:{type:String,required:true,uppercase:true},items:{type:[itemSchema],required:true},
 timeline:{type:[new Schema({type:String,message:String,at:{type:Date,default:Date.now}},{_id:false})],default:[]},
},{timestamps:true,optimisticConcurrency:true});
schema.index({orderId:1,storeId:1},{unique:true});
export const SellerOrder=mongoose.model('SellerOrder',schema);

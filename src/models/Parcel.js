import mongoose from 'mongoose';
const { Schema }=mongoose;
const parcelItemSchema=new Schema({productPublicId:{type:String,required:true,maxlength:100},variantPublicId:{type:String,required:true,maxlength:100},sku:{type:String,maxlength:120,default:''},title:{type:String,maxlength:240,default:''},quantity:{type:Number,required:true,min:1,max:100000}},{_id:false});
const schema=new Schema({
 publicId:{type:String,required:true,unique:true,immutable:true,index:true},shipmentId:{type:Schema.Types.ObjectId,ref:'Shipment',required:true,index:true},orderPublicId:{type:String,required:true,index:true},storePublicId:{type:String,required:true,index:true},barcode:{type:String,required:true,unique:true,index:true},
 status:{type:String,enum:['created','picking','picked','packed','handed_over','in_transit','delivered','returned','cancelled'],default:'created',index:true},items:{type:[parcelItemSchema],default:[]},pickedQuantity:{type:Number,min:0,default:0},weightGrams:{type:Number,min:0,default:0},condition:{type:String,enum:['unknown','good','damaged'],default:'unknown'},timeline:{type:[new Schema({type:String,message:String,actorUserId:{type:Schema.Types.ObjectId,ref:'User'},at:{type:Date,default:Date.now}},{_id:false})],default:[]}
},{timestamps:true,optimisticConcurrency:true});
export const Parcel=mongoose.model('Parcel',schema);

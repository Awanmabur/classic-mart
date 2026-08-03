import mongoose from 'mongoose';
const { Schema }=mongoose;
const warehouseTaskSchema=new Schema({
 publicId:{type:String,required:true,unique:true,immutable:true,index:true},warehouseId:{type:Schema.Types.ObjectId,ref:'Warehouse',required:true,index:true},storeId:{type:Schema.Types.ObjectId,ref:'Store',required:true,index:true},orderId:{type:Schema.Types.ObjectId,ref:'Order',index:true},shipmentId:{type:Schema.Types.ObjectId,ref:'Shipment',index:true},parcelId:{type:Schema.Types.ObjectId,ref:'Parcel',index:true},stockItemId:{type:Schema.Types.ObjectId,ref:'StockItem',index:true},variantId:{type:Schema.Types.ObjectId,ref:'ProductVariant',index:true},destinationWarehouseId:{type:Schema.Types.ObjectId,ref:'Warehouse',index:true},quantity:{type:Number,min:0,max:2_000_000_000,default:0},binCode:{type:String,trim:true,maxlength:80,default:''},disposition:{type:String,enum:['','good','damaged','quarantine'],default:''},
 type:{type:String,enum:['receive','put_away','pick','pack','dispatch','cycle_count','transfer','return_inspection'],required:true,index:true},status:{type:String,enum:['open','in_progress','completed','cancelled'],default:'open',index:true},assignedUserId:{type:Schema.Types.ObjectId,ref:'User',index:true},reference:{type:String,maxlength:120,default:''},notes:{type:String,maxlength:500,default:''},result:{type:Schema.Types.Mixed,default:{}},completedAt:Date,
},{timestamps:true,optimisticConcurrency:true});
warehouseTaskSchema.index({warehouseId:1,status:1,createdAt:-1});
export const WarehouseTask=mongoose.model('WarehouseTask',warehouseTaskSchema);

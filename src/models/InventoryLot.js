import mongoose from 'mongoose';
const { Schema } = mongoose;
const inventoryLotSchema = new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  storeId:{type:Schema.Types.ObjectId,ref:'Store',required:true,index:true},
  warehouseId:{type:Schema.Types.ObjectId,ref:'Warehouse',required:true,index:true},
  stockItemId:{type:Schema.Types.ObjectId,ref:'StockItem',required:true,index:true},
  variantId:{type:Schema.Types.ObjectId,ref:'ProductVariant',required:true,index:true},
  batchNumber:{type:String,trim:true,maxlength:120,default:''},
  serialNumbers:{type:[String],default:[],validate:{validator:v=>v.length<=500,message:'Too many serial numbers in one lot.'}},
  quantity:{type:Number,required:true,min:1,max:2_000_000_000},
  expiresAt:{type:Date,default:null,index:true},
  status:{type:String,enum:['active','quarantined','expired','depleted'],default:'active',index:true},
  notes:{type:String,trim:true,maxlength:500,default:''},
},{timestamps:true,optimisticConcurrency:true});
inventoryLotSchema.index({warehouseId:1,variantId:1,batchNumber:1});
inventoryLotSchema.path('serialNumbers').validate(v=>new Set(v).size===v.length,'Serial numbers must be unique within a lot.');
export const InventoryLot=mongoose.model('InventoryLot',inventoryLotSchema);

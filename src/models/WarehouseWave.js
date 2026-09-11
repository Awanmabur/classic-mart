import mongoose from 'mongoose';
const { Schema }=mongoose;
const historySchema=new Schema({action:{type:String,enum:['created','task_completed','released','completed'],required:true},actorUserId:{type:Schema.Types.ObjectId,ref:'User'},taskPublicId:{type:String,maxlength:100,default:''},at:{type:Date,default:Date.now}},{_id:false});
const warehouseWaveSchema=new Schema({
 publicId:{type:String,required:true,unique:true,immutable:true,index:true},warehouseId:{type:Schema.Types.ObjectId,ref:'Warehouse',required:true,index:true},storeId:{type:Schema.Types.ObjectId,ref:'Store',required:true,index:true},country:{type:String,required:true,uppercase:true,index:true},type:{type:String,enum:['pick'],default:'pick',required:true,index:true},status:{type:String,enum:['in_progress','completed','released'],default:'in_progress',index:true},assignedUserId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},taskIds:{type:[Schema.Types.ObjectId],default:[]},parcelIds:{type:[Schema.Types.ObjectId],default:[]},taskCount:{type:Number,min:1,max:50,required:true},totalQuantity:{type:Number,min:0,required:true},dueAt:{type:Date,index:true},startedAt:{type:Date,default:Date.now},completedAt:Date,releasedAt:Date,history:{type:[historySchema],default:[]},
},{timestamps:true,optimisticConcurrency:true});
warehouseWaveSchema.index({warehouseId:1,status:1,createdAt:-1});
warehouseWaveSchema.index({assignedUserId:1,status:1,createdAt:-1});
export const WarehouseWave=mongoose.model('WarehouseWave',warehouseWaveSchema);

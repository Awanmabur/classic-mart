import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({
 publicId:{type:String,required:true,unique:true,immutable:true,index:true},country:{type:String,required:true,uppercase:true,index:true},provider:{type:String,required:true,index:true},
 startedByUserId:{type:Schema.Types.ObjectId,ref:'User',required:true},deliveryUserId:{type:Schema.Types.ObjectId,ref:'User',index:true},businessDate:{type:String,maxlength:10,index:true},currency:{type:String,uppercase:true,maxlength:3},expectedAmountMinor:{type:Number,min:0},declaredAmountMinor:{type:Number,min:0},shipmentPublicIds:{type:[String],default:[]},status:{type:String,enum:['running','completed','failed'],default:'running',index:true},
 checked:{type:Number,default:0,min:0},matched:{type:Number,default:0,min:0},updated:{type:Number,default:0,min:0},failed:{type:Number,default:0,min:0},
 errorMessages:{type:[String],default:[],select:false},startedAt:{type:Date,default:Date.now},completedAt:Date,
},{timestamps:true});
export const ReconciliationRun=mongoose.model('ReconciliationRun',schema);

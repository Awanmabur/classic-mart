import mongoose from 'mongoose';
const {Schema}=mongoose;
const itemSchema=new Schema({productPublicId:{type:String,required:true,maxlength:100},quantity:{type:Number,required:true,min:1,max:9999},requestedUnitMinor:{type:Number,min:0,default:0}},{_id:false});
const messageSchema=new Schema({actorType:{type:String,enum:['buyer','seller'],required:true},actorUserId:{type:Schema.Types.ObjectId,ref:'User',required:true},message:{type:String,required:true,maxlength:2000},offeredTotalMinor:{type:Number,min:0},at:{type:Date,default:Date.now}},{_id:false});
const schema=new Schema({
 publicId:{type:String,required:true,unique:true,immutable:true,index:true},organizationId:{type:Schema.Types.ObjectId,ref:'BusinessOrganization',required:true,index:true},procurementRequestId:{type:Schema.Types.ObjectId,ref:'ProcurementRequest',required:true,index:true},requesterUserId:{type:Schema.Types.ObjectId,ref:'User',required:true},storeId:{type:Schema.Types.ObjectId,ref:'Store',required:true,index:true},storePublicId:{type:String,required:true,index:true},country:{type:String,required:true,uppercase:true,index:true},currency:{type:String,required:true,uppercase:true},approvedAmountMinor:{type:Number,required:true,min:0,default:0},items:{type:[itemSchema],required:true,validate:v=>v.length>0},status:{type:String,enum:['requested','negotiating','responded','accepted','rejected','expired'],default:'requested',index:true},offeredTotalMinor:{type:Number,min:0,default:0},validUntil:Date,messages:{type:[messageSchema],default:[]},acceptedAt:Date
},{timestamps:true,optimisticConcurrency:true});
schema.index({organizationId:1,status:1,createdAt:-1});
export const QuoteRequest=mongoose.model('QuoteRequest',schema);

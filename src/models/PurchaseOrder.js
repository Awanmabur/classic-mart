import mongoose from 'mongoose';
const {Schema}=mongoose;
const itemSchema=new Schema({productPublicId:{type:String,required:true},quantity:{type:Number,required:true,min:1},unitMinor:{type:Number,required:true,min:0},lineMinor:{type:Number,required:true,min:0}},{_id:false});
const eventSchema=new Schema({type:{type:String,required:true},message:{type:String,required:true,maxlength:500},actorUserId:{type:Schema.Types.ObjectId,ref:'User'},at:{type:Date,default:Date.now}},{_id:false});
const schema=new Schema({
 publicId:{type:String,required:true,unique:true,immutable:true,index:true},poNumber:{type:String,required:true,unique:true,index:true},organizationId:{type:Schema.Types.ObjectId,ref:'BusinessOrganization',required:true,index:true},quoteRequestId:{type:Schema.Types.ObjectId,ref:'QuoteRequest'},procurementRequestId:{type:Schema.Types.ObjectId,ref:'ProcurementRequest'},storeId:{type:Schema.Types.ObjectId,ref:'Store',required:true,index:true},storePublicId:{type:String,required:true},issuedByUserId:{type:Schema.Types.ObjectId,ref:'User',required:true},country:{type:String,required:true,uppercase:true},currency:{type:String,required:true,uppercase:true},items:{type:[itemSchema],required:true},approvedAmountMinor:{type:Number,required:true,min:0,default:0},totalMinor:{type:Number,required:true,min:0},invoiceTermsDays:{type:Number,min:0,max:120,default:0},status:{type:String,enum:['issued','accepted','rejected','fulfilled','cancelled'],default:'issued',index:true},timeline:{type:[eventSchema],default:[]}
},{timestamps:true,optimisticConcurrency:true});
schema.index({organizationId:1,createdAt:-1});
export const PurchaseOrder=mongoose.model('PurchaseOrder',schema);

import mongoose from 'mongoose';
const { Schema } = mongoose;
const itemSchema=new Schema({orderLineId:{type:String,required:true,maxlength:100},productPublicId:{type:String,required:true,maxlength:100},variantPublicId:{type:String,required:true,maxlength:100},sku:{type:String,maxlength:64,default:''},title:{type:String,required:true,maxlength:220},variantTitle:{type:String,maxlength:120,default:''},quantity:{type:Number,required:true,min:1,max:99},requestedRefundMinor:{type:Number,required:true,min:0},sellerReceivableReversalMinor:{type:Number,min:0},platformFeeReversalMinor:{type:Number,min:0}},{_id:false});
const eventSchema=new Schema({type:{type:String,required:true,maxlength:80},message:{type:String,required:true,maxlength:1000},actorUserId:{type:Schema.Types.ObjectId,ref:'User'},at:{type:Date,default:Date.now}},{_id:false});
const schema=new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  returnRequestId:{type:Schema.Types.ObjectId,ref:'ReturnRequest',required:true,index:true},returnPublicId:{type:String,required:true,index:true},orderPublicId:{type:String,required:true,index:true},
  storeId:{type:Schema.Types.ObjectId,ref:'Store',required:true,index:true},storePublicId:{type:String,required:true,index:true},country:{type:String,required:true,uppercase:true,minlength:2,maxlength:2,index:true},
  status:{type:String,enum:['pending','acknowledged','contested','escalated','resolved'],default:'pending',index:true},items:{type:[itemSchema],required:true,validate:v=>Array.isArray(v)&&v.length>0},
  responseMessage:{type:String,maxlength:2000,default:''},respondedByUserId:{type:Schema.Types.ObjectId,ref:'User'},respondedAt:Date,
  evidenceDocumentIds:{type:[Schema.Types.ObjectId],ref:'EvidenceDocument',default:[]},slaDueAt:{type:Date,default:()=>new Date(Date.now()+48*60*60*1000),index:true},timeline:{type:[eventSchema],default:[]},
},{timestamps:true,optimisticConcurrency:true});
schema.index({returnRequestId:1,storeId:1},{unique:true});
schema.index({storeId:1,status:1,slaDueAt:1,createdAt:-1});
export const SellerReturnCase=mongoose.model('SellerReturnCase',schema);

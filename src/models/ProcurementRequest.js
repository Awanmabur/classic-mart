import mongoose from 'mongoose';
const {Schema}=mongoose;
const itemSchema=new Schema({productPublicId:{type:String,required:true,maxlength:100},quantity:{type:Number,required:true,min:1,max:9999},estimatedUnitMinor:{type:Number,min:0,default:0},note:{type:String,maxlength:300,default:''}},{_id:false});
const eventSchema=new Schema({type:{type:String,required:true,maxlength:80},message:{type:String,required:true,maxlength:500},actorUserId:{type:Schema.Types.ObjectId,ref:'User'},at:{type:Date,default:Date.now}},{_id:false});
const schema=new Schema({
 publicId:{type:String,required:true,unique:true,immutable:true,index:true},organizationId:{type:Schema.Types.ObjectId,ref:'BusinessOrganization',required:true,index:true},requesterUserId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},budgetId:{type:Schema.Types.ObjectId,ref:'BusinessBudget'},title:{type:String,required:true,trim:true,maxlength:160},items:{type:[itemSchema],required:true,validate:v=>v.length>0},estimatedTotalMinor:{type:Number,required:true,min:0},currency:{type:String,required:true,uppercase:true},status:{type:String,enum:['submitted','approved','partially_ordered','rejected','ordered','cancelled'],default:'submitted',index:true},approvedByUserId:{type:Schema.Types.ObjectId,ref:'User'},approvedAt:Date,rejectedAt:Date,closedAt:Date,closeReason:{type:String,maxlength:500,default:''},rejectionReason:{type:String,maxlength:500,default:''},timeline:{type:[eventSchema],default:[]}
},{timestamps:true,optimisticConcurrency:true});
schema.index({organizationId:1,status:1,createdAt:-1});
export const ProcurementRequest=mongoose.model('ProcurementRequest',schema);

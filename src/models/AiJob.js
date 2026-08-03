import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({
 publicId:{type:String,required:true,unique:true,index:true,immutable:true},type:{type:String,required:true,enum:['product_draft','category_attributes','translation','image_quality','embedding','review_summary','seller_assistant','support_assistant','promoter_content','admin_triage','demand_forecast'],index:true},
 status:{type:String,enum:['queued','running','pending_approval','completed','rejected','failed','cancelled'],default:'queued',index:true},country:{type:String,required:true,uppercase:true,index:true},actorUserId:{type:Schema.Types.ObjectId,ref:'User',index:true},storeId:{type:Schema.Types.ObjectId,ref:'Store',index:true},productId:{type:Schema.Types.ObjectId,ref:'Product',index:true},ticketId:{type:Schema.Types.ObjectId,ref:'SupportTicket',index:true},
 input:{type:Schema.Types.Mixed,default:{},select:false},result:{type:Schema.Types.Mixed,default:{}},resultSchemaKey:{type:String,default:''},provider:{type:String,default:''},model:{type:String,default:''},promptKey:{type:String,default:''},promptVersion:{type:Number,default:0},
 attempts:{type:Number,default:0,min:0,max:10},availableAt:{type:Date,default:Date.now,index:true},startedAt:Date,completedAt:Date,expiresAt:{type:Date,index:true},errorCode:{type:String,default:'',maxlength:100},errorMessage:{type:String,default:'',maxlength:1000},
 approval:{status:{type:String,enum:['none','pending','approved','rejected'],default:'none'},reviewedByUserId:{type:Schema.Types.ObjectId,ref:'User'},reviewedAt:Date,note:{type:String,default:'',maxlength:1000}},usagePublicId:{type:String,default:''},
},{timestamps:true,optimisticConcurrency:true});
schema.index({status:1,availableAt:1,createdAt:1});schema.index({actorUserId:1,createdAt:-1});schema.index({storeId:1,createdAt:-1});
export const AiJob=mongoose.model('AiJob',schema);

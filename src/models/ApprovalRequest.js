import mongoose from 'mongoose';
const approvalRequestSchema=new mongoose.Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  type:{type:String,enum:['country_settings','feature_flag','cms_publish','cms_rollback','gift_card_issue','data_export','impersonation','ai_model_registry','business_credit_terms','platform_staff_access'],required:true,index:true},
  country:{type:String,uppercase:true,maxlength:2,default:'',index:true},
  targetType:{type:String,maxlength:80,default:''},
  targetPublicId:{type:String,maxlength:120,default:''},
  payload:{type:mongoose.Schema.Types.Mixed,required:true},
  reason:{type:String,required:true,trim:true,minlength:3,maxlength:1000},
  status:{type:String,enum:['requested','approved','rejected','applied','failed','cancelled'],default:'requested',index:true},
  requestedByUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true,index:true},
  decidedByUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User'},
  decisionReason:{type:String,maxlength:1000,default:''},
  decidedAt:Date,
  appliedAt:Date,
  consumedAt:Date,
  failureMessage:{type:String,maxlength:1000,default:''},
},{timestamps:true});
approvalRequestSchema.index({country:1,status:1,createdAt:-1});
export const ApprovalRequest=mongoose.model('ApprovalRequest',approvalRequestSchema);

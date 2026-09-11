import mongoose from 'mongoose';
const {Schema}=mongoose;
const schema=new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  templateId:{type:Schema.Types.ObjectId,ref:'ProcurementTemplate',required:true,index:true},
  templatePublicId:{type:String,required:true,index:true},
  organizationId:{type:Schema.Types.ObjectId,ref:'BusinessOrganization',required:true,index:true},
  scheduledFor:{type:Date,required:true,index:true},
  status:{type:String,enum:['processing','completed','failed'],default:'processing',index:true},
  procurementRequestId:{type:Schema.Types.ObjectId,ref:'ProcurementRequest'},
  procurementRequestPublicId:{type:String,default:''},
  attempts:{type:Number,default:1,min:1,max:100},
  errorMessage:{type:String,maxlength:1000,default:''},
  completedAt:Date,
},{timestamps:true});
schema.index({templateId:1,scheduledFor:1},{unique:true});
export const ProcurementRun=mongoose.model('ProcurementRun',schema);

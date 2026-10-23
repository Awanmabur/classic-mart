import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({publicId:{type:String,required:true,unique:true,immutable:true,index:true},ownerUserId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},country:{type:String,required:true,uppercase:true,index:true},contextType:{type:String,enum:['return','seller_return','dispute','trust_case','support','delivery_verification','delivery_job'],required:true,index:true},contextPublicId:{type:String,required:true,index:true},documentType:{type:String,enum:['general','identity','vehicle','permit','delivery_photo','delivery_signature','failed_attempt','address_exception','cod_handover','return_receipt'],default:'general',index:true},storageKey:{type:String,required:true,select:false},mimeType:{type:String,enum:['image/webp'],required:true},size:{type:Number,required:true,min:1,max:8*1024*1024},status:{type:String,enum:['ready','quarantined','rejected'],default:'ready',index:true},description:{type:String,maxlength:300,default:''}},{timestamps:true});
schema.add({contextLinePublicId:{type:String,maxlength:100,default:'',immutable:true}});
// Refund disbursement evidence retains its own immutable financial source reference.
schema.add({refundPublicId:{type:String,maxlength:100,default:'',immutable:true}});
schema.add({refundEvidenceReadRevision:{type:Number,min:0,select:false}});
schema.path('documentType').enum('refund_disbursement');
schema.path('documentType').enum('seller_policy_response');
schema.path('contextType').enum('specialist_referral');
schema.path('documentType').enum('specialist_response');
schema.pre('validate',function validateRefundEvidenceSource(){
  if(this.documentType==='refund_disbursement'&&(!/^rfd_[a-zA-Z0-9_-]{1,95}$/.test(this.refundPublicId)||this.contextType!=='return'||this.contextLinePublicId))
    this.invalidate('refundPublicId','Refund evidence requires its exact financial source and return context.');
  if(this.refundPublicId&&this.documentType!=='refund_disbursement')this.invalidate('documentType','A refund source requires disbursement evidence.');
});
schema.index({contextType:1,contextPublicId:1,createdAt:-1});
schema.add({ moderationEvidenceReadRevision: { type: Number, min: 0, select: false } });

export const EvidenceDocument=mongoose.model('EvidenceDocument',schema);

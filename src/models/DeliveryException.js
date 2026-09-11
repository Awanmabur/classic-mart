import mongoose from 'mongoose';
const { Schema }=mongoose;
const eventSchema=new Schema({type:{type:String,required:true,maxlength:80},message:{type:String,required:true,maxlength:300},actorUserId:{type:Schema.Types.ObjectId,ref:'User'},at:{type:Date,default:Date.now}},{_id:false});
const schema=new Schema({
 publicId:{type:String,required:true,unique:true,immutable:true,index:true},
 shipmentId:{type:Schema.Types.ObjectId,ref:'Shipment',required:true,index:true},shipmentPublicId:{type:String,required:true,index:true},
 country:{type:String,required:true,uppercase:true,minlength:2,maxlength:2,index:true},deliveryUserId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},
 type:{type:String,enum:['failed_delivery','address_exception','cod_mismatch','proof_missing'],required:true,index:true},
 reasonCode:{type:String,enum:['recipient_unavailable','address_not_found','address_incorrect','recipient_refused','unsafe_location','parcel_damaged','vehicle_issue','cod_amount_mismatch','proof_missing','other'],required:true,index:true},
 description:{type:String,required:true,maxlength:600},
 evidenceRequired:{type:Boolean,default:false},evidenceDocumentIds:{type:[Schema.Types.ObjectId],ref:'EvidenceDocument',default:[]},
 expectedAmountMinor:{type:Number,min:0},observedAmountMinor:{type:Number,min:0},currency:{type:String,uppercase:true,maxlength:3,default:''},
 status:{type:String,enum:['open','investigating','resolved','dismissed'],default:'open',index:true},escalatedAt:{type:Date,default:Date.now,index:true},
 resolvedAt:Date,resolvedByUserId:{type:Schema.Types.ObjectId,ref:'User'},resolutionNote:{type:String,maxlength:600,default:''},
 timeline:{type:[eventSchema],default:[]},
},{timestamps:true,optimisticConcurrency:true});
schema.index({country:1,status:1,type:1,createdAt:-1});
schema.index({shipmentId:1,status:1,createdAt:-1});
export const DeliveryException=mongoose.model('DeliveryException',schema);

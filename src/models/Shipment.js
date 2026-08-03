import mongoose from 'mongoose';
const { Schema }=mongoose;
const proofSchema=new Schema({type:{type:String,enum:['otp','photo','signature','qr','none'],default:'none'},reference:{type:String,maxlength:240,default:''},recordedAt:Date},{_id:false});
const shipmentSchema=new Schema({
 publicId:{type:String,required:true,unique:true,immutable:true,index:true},
 orderId:{type:Schema.Types.ObjectId,ref:'Order',required:true,index:true},
 orderPublicId:{type:String,required:true,index:true},
 kind:{type:String,enum:['outbound','return'],default:'outbound',index:true},returnRequestId:{type:Schema.Types.ObjectId,ref:'ReturnRequest',index:true},
 country:{type:String,required:true,uppercase:true,minlength:2,maxlength:2,index:true},
 deliveryUserId:{type:Schema.Types.ObjectId,ref:'User',index:true},
 status:{type:String,enum:['ready','offered','assigned','picked_up','in_transit','delivered','failed','rescheduled','return_to_sender','returned','cancelled'],default:'ready',index:true},
 mode:{type:String,enum:['standard','express','pickup'],required:true},
 parcelCount:{type:Number,min:1,max:999,default:1},
 pickupCodeHash:{type:String,select:false},deliveryCodeHash:{type:String,select:false},pickupCodeEncrypted:{type:String,select:false},deliveryCodeEncrypted:{type:String,select:false},
 assignedAt:Date,pickedUpAt:Date,deliveredAt:Date,
 failedReason:{type:String,maxlength:300,default:''},
 rescheduledFor:Date,
 proof:{type:proofSchema,default:()=>({type:'none'})},
 cod:{required:{type:Boolean,default:false},amountMinor:{type:Number,min:0,default:0},currency:{type:String,uppercase:true,maxlength:3,default:'UGX'},collectedMinor:{type:Number,min:0,default:0},reconciledAt:Date},
 timeline:{type:[new Schema({type:{type:String,required:true,maxlength:80},message:{type:String,required:true,maxlength:240},actorUserId:{type:Schema.Types.ObjectId,ref:'User'},at:{type:Date,default:Date.now}},{_id:false})],default:[]},
},{timestamps:true,optimisticConcurrency:true});
shipmentSchema.index({country:1,status:1,createdAt:-1});
shipmentSchema.index({deliveryUserId:1,status:1,createdAt:-1});
export const Shipment=mongoose.model('Shipment',shipmentSchema);

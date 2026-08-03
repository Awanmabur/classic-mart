import mongoose from 'mongoose';
const { Schema } = mongoose;
const deliveryProfileSchema = new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  userId:{type:Schema.Types.ObjectId,ref:'User',required:true,unique:true,index:true},
  country:{type:String,required:true,uppercase:true,minlength:2,maxlength:2,index:true},
  transport:{type:String,enum:['bicycle','motorcycle','car','van','truck','other'],required:true},
  vehicleLabel:{type:String,trim:true,maxlength:120,default:''},
  serviceAreas:{type:[String],default:[],validate:v=>v.length<=30},
  verificationStatus:{type:String,enum:['draft','submitted','approved','rejected','suspended'],default:'draft',index:true},
  available:{type:Boolean,default:false,index:true},
  codEnabled:{type:Boolean,default:false},
  approvedAt:Date, reviewReason:{type:String,trim:true,maxlength:500,default:''}, reviewedAt:Date, reviewedByUserId:{type:Schema.Types.ObjectId,ref:'User'},
},{timestamps:true,optimisticConcurrency:true});
export const DeliveryProfile=mongoose.model('DeliveryProfile',deliveryProfileSchema);

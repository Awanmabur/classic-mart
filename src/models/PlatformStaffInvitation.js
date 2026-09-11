import mongoose from 'mongoose';
const { Schema } = mongoose;
const platformStaffInvitationSchema = new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  emailHash:{type:String,required:true,index:true,select:false},
  emailEncrypted:{type:String,required:true,select:false},
  emailMasked:{type:String,required:true,maxlength:254},
  role:{type:String,enum:['warehouse','support','moderator','finance','country_admin'],required:true,index:true},
  operationalCountries:{type:[String],default:[],validate:v=>v.length<=20},
  warehouseScopes:{type:[String],default:[],validate:v=>Array.isArray(v)&&v.length<=100},
  grantDurationDays:{type:Number,min:1,max:365,default:180},
  approvalCountry:{type:String,uppercase:true,maxlength:3,default:'',index:true},
  reason:{type:String,required:true,maxlength:1000},
  status:{type:String,enum:['pending','accepted','revoked','expired'],default:'pending',index:true},
  tokenHash:{type:String,required:true,select:false},
  expiresAt:{type:Date,required:true,index:true},
  invitedByUserId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},
  acceptedByUserId:{type:Schema.Types.ObjectId,ref:'User'},
  acceptedAt:Date,
  approvalRequestId:{type:Schema.Types.ObjectId,ref:'ApprovalRequest'},
  approvalRequestPublicId:{type:String,maxlength:100,default:'',index:true},
  revokedByUserId:{type:Schema.Types.ObjectId,ref:'User'},
  revokedAt:Date,
},{timestamps:true});
platformStaffInvitationSchema.index({emailHash:1,status:1,expiresAt:1});
platformStaffInvitationSchema.index({approvalCountry:1,status:1,createdAt:-1});
export const PlatformStaffInvitation=mongoose.model('PlatformStaffInvitation',platformStaffInvitationSchema);

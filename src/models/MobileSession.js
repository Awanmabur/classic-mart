import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  familyId:{type:String,required:true,unique:true,immutable:true,index:true},
  userId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},userTokenVersion:{type:Number,required:true,min:0,default:0},
  cartKey:{type:String,required:true,immutable:true,index:true,maxlength:180},
  deviceName:{type:String,trim:true,maxlength:120,default:'Mobile client'},
  platform:{type:String,enum:['android','ios','web','other'],default:'other',index:true},
  accessTokenHash:{type:String,required:true,select:false,unique:true,index:true},
  refreshTokenHash:{type:String,required:true,select:false,unique:true,index:true},
  accessExpiresAt:{type:Date,required:true,index:true},
  refreshExpiresAt:{type:Date,required:true},
  checkoutReview:{type:Schema.Types.Mixed,default:null,select:false},
  lastUsedAt:{type:Date,default:Date.now},
  revokedAt:{type:Date,default:null,index:true},
  revokedReason:{type:String,trim:true,maxlength:120,default:''},
  reuseDetectedAt:{type:Date,default:null},
},{timestamps:true});
schema.index({userId:1,revokedAt:1,updatedAt:-1});
schema.index({refreshExpiresAt:1},{expireAfterSeconds:0});
export const MobileSession=mongoose.model('MobileSession',schema);

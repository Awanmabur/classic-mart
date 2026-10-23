import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  userId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},userPublicId:{type:String,required:true,index:true},
  country:{type:String,required:true,uppercase:true,minlength:2,maxlength:2,index:true},
  type:{type:String,enum:['export','deletion','correction','restriction','consent_withdrawal'],required:true,index:true},
  status:{type:String,enum:['requested','approved','processing','ready','blocked','completed','rejected','cancelled','failed','expired'],default:'requested',index:true},
  details:{type:String,maxlength:2000,default:''},decision:{type:String,maxlength:2000,default:''},
  identityVerifiedAt:{type:Date,required:true},
  legalHold:{active:{type:Boolean,default:false},reason:{type:String,maxlength:1000,default:''},setByUserId:{type:Schema.Types.ObjectId,ref:'User'},setAt:Date},
  storageKey:{type:String,select:false,maxlength:240,default:''},readyAt:Date,expiresAt:Date,exportCleanupAfter:Date,
  exportArtifacts:{type:[new Schema({key:{type:String,required:true,maxlength:240},expiresAt:{type:Date,required:true},cleanupAfter:Date,cleanupError:{type:String,maxlength:500,default:''}},{_id:false})],select:false,default:[]},
  processedByUserId:{type:Schema.Types.ObjectId,ref:'User'},completedAt:Date,
  approvedAt:Date,
  restrictionActive:{type:Boolean,default:false,index:true},restrictionReleasedAt:Date,restrictionReleasedByUserId:{type:Schema.Types.ObjectId,ref:'User'},
  leaseToken:{type:String,maxlength:80,select:false,default:''},
  attempts:{type:Number,min:0,default:0},nextAttemptAt:{type:Date,default:Date.now,index:true},lockedBy:{type:String,maxlength:120,default:''},lockedUntil:{type:Date,index:true},lastError:{type:String,maxlength:1000,default:''},
},{timestamps:true,optimisticConcurrency:true});
schema.index({country:1,status:1,createdAt:-1});
schema.index({status:1,nextAttemptAt:1,lockedUntil:1});
schema.index({userId:1,type:1,restrictionActive:1});
export const PrivacyRequest=mongoose.model('PrivacyRequest',schema);

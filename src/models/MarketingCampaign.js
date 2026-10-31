import mongoose from 'mongoose';
const marketingCampaignSchema=new mongoose.Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  name:{type:String,required:true,trim:true,maxlength:160},
  country:{type:String,uppercase:true,maxlength:2,default:'',index:true},
  status:{type:String,enum:['draft','scheduled','running','completed','cancelled'],default:'draft',index:true},
  subject:{type:String,required:true,trim:true,maxlength:180},
  body:{type:String,required:true,maxlength:10000},
  roles:{type:[String],default:[]},
  scheduledAt:Date,
  startedAt:Date,
  completedAt:Date,
  eligibleCount:{type:Number,min:0,default:0},
  queuedCount:{type:Number,min:0,default:0},
  dispatchGrantPublicId:{type:String,maxlength:120,default:''},
  dispatchActorUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User'},
  dispatchTokenVersion:{type:Number,min:0},
  dispatchStoredRole:{type:String,maxlength:30,default:''},
  createdByUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true},
},{timestamps:true,optimisticConcurrency:true});
export const MarketingCampaign=mongoose.model('MarketingCampaign',marketingCampaignSchema);

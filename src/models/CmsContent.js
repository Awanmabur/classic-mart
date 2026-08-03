import mongoose from 'mongoose';
const revisionSchema=new mongoose.Schema({
  version:{type:Number,required:true,min:1},
  title:{type:String,trim:true,maxlength:180,default:''},
  body:{type:String,maxlength:20000,default:''},
  data:{type:mongoose.Schema.Types.Mixed,default:{}},
  reason:{type:String,trim:true,maxlength:1000,required:true},
  createdByUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true},
  createdAt:{type:Date,default:Date.now},
  scheduledFor:Date,
  publishedAt:Date,
  rolledBackFromVersion:{type:Number,min:1},
},{_id:false});
const cmsContentSchema=new mongoose.Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  key:{type:String,required:true,trim:true,lowercase:true,maxlength:120,index:true},
  type:{type:String,enum:['home_module','banner','collection','hero','press','help','legal'],required:true,index:true},
  country:{type:String,uppercase:true,maxlength:2,default:'',index:true},
  status:{type:String,enum:['draft','scheduled','published','archived'],default:'draft',index:true},
  activeVersion:{type:Number,min:0,default:0},
  scheduledVersion:{type:Number,min:0,default:0},
  revisions:{type:[revisionSchema],default:[]},
},{timestamps:true,optimisticConcurrency:true});
cmsContentSchema.index({key:1,country:1},{unique:true});
export const CmsContent=mongoose.model('CmsContent',cmsContentSchema);

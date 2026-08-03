import mongoose from 'mongoose';

const featureFlagSchema = new mongoose.Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  key:{type:String,required:true,unique:true,trim:true,lowercase:true,maxlength:80,index:true},
  description:{type:String,trim:true,maxlength:500,default:''},
  enabled:{type:Boolean,default:false,index:true},
  countries:{type:[String],default:[],set:v=>(v||[]).map(x=>String(x).toUpperCase())},
  roles:{type:[String],default:[]},
  rolloutPercentage:{type:Number,min:0,max:100,default:100},
  startsAt:Date,
  endsAt:Date,
  version:{type:Number,min:1,default:1},
  lastReason:{type:String,maxlength:1000,default:''},
  updatedByUserId:{type:mongoose.Schema.Types.ObjectId,ref:'User'},
},{timestamps:true,optimisticConcurrency:true});

featureFlagSchema.index({enabled:1,startsAt:1,endsAt:1});
export const FeatureFlag=mongoose.model('FeatureFlag',featureFlagSchema);

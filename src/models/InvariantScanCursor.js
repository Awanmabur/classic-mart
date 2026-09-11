import mongoose from 'mongoose';
const {Schema}=mongoose;
const schema=new Schema({
  checkName:{type:String,required:true,unique:true,index:true,maxlength:120},
  lastId:{type:Schema.Types.ObjectId,default:null},
  completedPasses:{type:Number,default:0,min:0},
  lastBatchSize:{type:Number,default:0,min:0},
  lastScannedAt:{type:Date,default:null},
},{timestamps:true,optimisticConcurrency:true});
export const InvariantScanCursor=mongoose.model('InvariantScanCursor',schema);

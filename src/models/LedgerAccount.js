import mongoose from 'mongoose';
const { Schema }=mongoose;
const ledgerAccountSchema=new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true}, code:{type:String,required:true,maxlength:80},
  type:{type:String,enum:['asset','liability','revenue','expense'],required:true}, ownerType:{type:String,enum:['platform','store','promoter','delivery','provider','customer'],required:true},
  ownerId:{type:Schema.Types.ObjectId}, ownerPublicId:{type:String,maxlength:100}, country:{type:String,required:true,uppercase:true,minlength:2,maxlength:2}, currency:{type:String,required:true,uppercase:true,minlength:3,maxlength:3}, active:{type:Boolean,default:true}, mutationVersion:{type:Number,default:0,min:0,select:false}
},{timestamps:true});
ledgerAccountSchema.index({code:1,ownerType:1,ownerPublicId:1,country:1,currency:1},{unique:true});
export const LedgerAccount=mongoose.model('LedgerAccount',ledgerAccountSchema);

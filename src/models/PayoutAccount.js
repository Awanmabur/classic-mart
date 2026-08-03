import mongoose from 'mongoose';
const { Schema }=mongoose;
const payoutAccountSchema=new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true}, ownerUserId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true}, ownerStoreId:{type:Schema.Types.ObjectId,ref:'Store',index:true}, ownerStorePublicId:{type:String,index:true,maxlength:100}, ownerType:{type:String,enum:['seller','promoter','delivery'],required:true},
  country:{type:String,required:true,uppercase:true}, currency:{type:String,required:true,uppercase:true}, method:{type:String,enum:['mobile_money','bank'],required:true}, label:{type:String,required:true,maxlength:100},
  destinationEncrypted:{type:String,required:true,select:false}, verifiedAt:Date, status:{type:String,enum:['pending','verified','disabled'],default:'pending',index:true}
},{timestamps:true});
payoutAccountSchema.index({ownerUserId:1,status:1});
payoutAccountSchema.index({ownerStoreId:1,status:1});
export const PayoutAccount=mongoose.model('PayoutAccount',payoutAccountSchema);

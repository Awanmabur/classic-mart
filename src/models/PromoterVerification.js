import mongoose from 'mongoose';
const {Schema}=mongoose;
const schema=new Schema({publicId:{type:String,required:true,unique:true,immutable:true,index:true},userId:{type:Schema.Types.ObjectId,ref:'User',required:true,unique:true,index:true},country:{type:String,required:true,uppercase:true,index:true},status:{type:String,enum:['draft','submitted','verified','rejected'],default:'draft',index:true},channels:{type:[String],default:[]},niches:{type:[String],default:[]},disclosureAcceptedAt:Date,submittedAt:Date,reviewedAt:Date,reviewedByUserId:{type:Schema.Types.ObjectId,ref:'User'},reason:{type:String,default:'',maxlength:500}},{timestamps:true,optimisticConcurrency:true});
export const PromoterVerification=mongoose.model('PromoterVerification',schema);

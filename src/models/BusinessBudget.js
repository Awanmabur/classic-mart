import mongoose from 'mongoose';
const {Schema}=mongoose;
const schema=new Schema({
 publicId:{type:String,required:true,unique:true,immutable:true,index:true},organizationId:{type:Schema.Types.ObjectId,ref:'BusinessOrganization',required:true,index:true},name:{type:String,required:true,trim:true,maxlength:120},currency:{type:String,required:true,uppercase:true},limitMinor:{type:Number,required:true,min:0,max:10_000_000_000},committedMinor:{type:Number,min:0,default:0},spentMinor:{type:Number,min:0,default:0},periodStart:{type:Date,required:true},periodEnd:{type:Date,required:true},active:{type:Boolean,default:true,index:true},createdByUserId:{type:Schema.Types.ObjectId,ref:'User',required:true}
},{timestamps:true,optimisticConcurrency:true});
schema.index({organizationId:1,active:1,periodEnd:1});
export const BusinessBudget=mongoose.model('BusinessBudget',schema);

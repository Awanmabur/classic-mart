import mongoose from 'mongoose';
const {Schema}=mongoose;
const schema=new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  ownerUserId:{type:Schema.Types.ObjectId,ref:'User',required:true,unique:true,index:true},
  companyName:{type:String,required:true,trim:true,maxlength:180},
  country:{type:String,required:true,uppercase:true,minlength:2,maxlength:2,index:true},
  currency:{type:String,required:true,uppercase:true,minlength:3,maxlength:3},
  taxIdEncrypted:{type:String,select:false,default:''},
  billingEmail:{type:String,trim:true,maxlength:254,default:''},

  billingContactName:{type:String,trim:true,maxlength:120,default:''},
  billingPhone:{type:String,trim:true,maxlength:32,default:''},
  billingAddress:{type:String,trim:true,maxlength:240,default:''},
  billingCity:{type:String,trim:true,maxlength:120,default:''},
  deliveryContactName:{type:String,trim:true,maxlength:120,default:''},
  deliveryPhone:{type:String,trim:true,maxlength:32,default:''},
  deliveryAddress:{type:String,trim:true,maxlength:240,default:''},
  deliveryCity:{type:String,trim:true,maxlength:120,default:''},
  status:{type:String,enum:['active','risk_review','suspended'],default:'active',index:true},
  invoiceTermsApproved:{type:Boolean,default:false},
  invoiceTermsDays:{type:Number,min:0,max:120,default:0},
  creditLimitMinor:{type:Number,min:0,max:10_000_000_000,default:0},
},{timestamps:true,optimisticConcurrency:true});
schema.index({country:1,status:1,createdAt:-1});
export const BusinessOrganization=mongoose.model('BusinessOrganization',schema);

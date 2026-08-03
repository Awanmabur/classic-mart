import mongoose from 'mongoose';
const { Schema }=mongoose;
const assetSchema=new Schema({type:{type:String,enum:['image','video','document','copy'],required:true},url:{type:String,maxlength:800,default:''},label:{type:String,maxlength:120,default:''},approved:{type:Boolean,default:false}},{_id:false});
const schema=new Schema({
 publicId:{type:String,required:true,unique:true,immutable:true,index:true},ownerUserId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},storeId:{type:Schema.Types.ObjectId,ref:'Store',required:true,index:true},country:{type:String,required:true,uppercase:true,index:true},name:{type:String,required:true,trim:true,maxlength:140},
 status:{type:String,enum:['draft','submitted','active','rejected','paused','ended'],default:'draft',index:true},visibility:{type:String,enum:['public','invite_only'],default:'public'},commissionBps:{type:Number,min:0,max:5000,default:500},attributionDays:{type:Number,min:1,max:90,default:30},
 allowedChannels:{type:[String],default:[]},facts:{type:[String],default:[]},productPublicIds:{type:[String],default:[]},assets:{type:[assetSchema],default:[]},disclosureText:{type:String,maxlength:300,default:'Sponsored/affiliate promotion for Classic Mart.'},policyVersion:{type:String,maxlength:40,default:'2026-07'},
 startsAt:Date,endsAt:Date,submittedAt:Date,reviewedAt:Date,reviewedByUserId:{type:Schema.Types.ObjectId,ref:'User'},reviewReason:{type:String,maxlength:500,default:''}
},{timestamps:true,optimisticConcurrency:true});
schema.index({country:1,status:1,createdAt:-1});
export const Campaign=mongoose.model('Campaign',schema);

import mongoose from 'mongoose';
const {Schema}=mongoose;
const schema=new Schema({
 publicId:{type:String,required:true,unique:true,immutable:true,index:true},storeId:{type:Schema.Types.ObjectId,ref:'Store',required:true,index:true},storePublicId:{type:String,required:true,index:true},country:{type:String,required:true,uppercase:true,index:true},currency:{type:String,required:true,uppercase:true},type:{type:String,enum:['voucher','bundle','quantity_break','free_shipping','sponsored'],required:true,index:true},name:{type:String,required:true,trim:true,maxlength:140},code:{type:String,uppercase:true,trim:true,maxlength:40,default:''},productPublicIds:{type:[String],default:[]},discountBps:{type:Number,min:0,max:9000,default:0},fixedDiscountMinor:{type:Number,min:0,max:2_000_000_000,default:0},minQuantity:{type:Number,min:1,max:9999,default:1},minSubtotalMinor:{type:Number,min:0,default:0},disclosureText:{type:String,maxlength:300,default:'Sponsored placement.'},startsAt:{type:Date,default:Date.now,index:true},endsAt:{type:Date,index:true},status:{type:String,enum:['draft','active','paused','expired'],default:'draft',index:true},createdByUserId:{type:Schema.Types.ObjectId,ref:'User',required:true}
},{timestamps:true,optimisticConcurrency:true});
schema.index({country:1,status:1,startsAt:1,endsAt:1});
schema.index({code:1},{unique:true,partialFilterExpression:{code:{$type:'string',$gt:''}}});
export const SellerPromotion=mongoose.model('SellerPromotion',schema);

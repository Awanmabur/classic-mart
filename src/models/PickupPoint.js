import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({publicId:{type:String,required:true,unique:true,immutable:true,index:true},country:{type:String,required:true,uppercase:true,index:true},name:{type:String,required:true,maxlength:140},city:{type:String,required:true,index:true,maxlength:120},address:{type:String,required:true,maxlength:300},phone:{type:String,maxlength:32,default:''},active:{type:Boolean,default:true,index:true},openingHours:{type:String,maxlength:300,default:''}},{timestamps:true,optimisticConcurrency:true});
schema.index({country:1,city:1,active:1});
export const PickupPoint=mongoose.model('PickupPoint',schema);

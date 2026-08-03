import mongoose from 'mongoose';
const { Schema }=mongoose;
const shippingZoneSchema=new Schema({
 publicId:{type:String,required:true,unique:true,immutable:true,index:true},
 country:{type:String,required:true,uppercase:true,minlength:2,maxlength:2,index:true},
 name:{type:String,required:true,trim:true,maxlength:120},
 cities:{type:[String],default:[]},
 standardFeeMinor:{type:Number,required:true,min:0,max:1e12},
 expressFeeMinor:{type:Number,min:0,max:1e12,default:0},
 currency:{type:String,required:true,uppercase:true,minlength:3,maxlength:3},
 standardSlaHours:{type:Number,min:1,max:720,default:120},
 expressSlaHours:{type:Number,min:1,max:240,default:48},
 active:{type:Boolean,default:true,index:true},
},{timestamps:true});
shippingZoneSchema.index({country:1,name:1},{unique:true});
export const ShippingZone=mongoose.model('ShippingZone',shippingZoneSchema);

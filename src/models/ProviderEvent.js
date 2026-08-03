import mongoose from 'mongoose';
const { Schema }=mongoose;
const providerEventSchema=new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true}, provider:{type:String,required:true,index:true},
  eventId:{type:String,required:true,maxlength:180}, eventType:{type:String,required:true,maxlength:120}, rawHash:{type:String,required:true,immutable:true,select:false}, rawEncrypted:{type:String,required:true,select:false},
  verifiedAt:{type:Date,required:true}, processedAt:Date, status:{type:String,enum:['received','processed','ignored','failed'],default:'received'}, error:{type:String,maxlength:400}
},{timestamps:true});
providerEventSchema.index({provider:1,eventId:1},{unique:true});
export const ProviderEvent=mongoose.model('ProviderEvent',providerEventSchema);

import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  sessionKey:{type:String,required:true,index:true,maxlength:160},
  userId:{type:Schema.Types.ObjectId,ref:'User',index:true},
  country:{type:String,required:true,uppercase:true,index:true,minlength:2,maxlength:2},
  query:{type:String,default:'',maxlength:120},
  category:{type:String,default:'',maxlength:100}, brand:{type:String,default:'',maxlength:100}, seller:{type:String,default:'',maxlength:100},
  resultCount:{type:Number,required:true,min:0,max:100000},
  clickedProductPublicId:{type:String,default:'',maxlength:100},
  zeroResult:{type:Boolean,default:false,index:true},
},{timestamps:true});
schema.index({country:1,createdAt:-1});
schema.index({createdAt:1},{expireAfterSeconds:90*24*60*60});
export const SearchEvent=mongoose.model('SearchEvent',schema);

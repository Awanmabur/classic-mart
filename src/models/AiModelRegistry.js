import mongoose from 'mongoose';
const { Schema } = mongoose;
const schema = new Schema({
  publicId:{type:String,required:true,unique:true,index:true,immutable:true},
  provider:{type:String,required:true,enum:['openai','openai_compatible','local'],index:true},
  purpose:{type:String,required:true,enum:['chat','embedding','moderation','vision'],index:true},
  model:{type:String,required:true,trim:true,maxlength:160},
  enabled:{type:Boolean,default:true,index:true},priority:{type:Number,default:100,min:0,max:10000},
  capabilities:{type:[String],default:[]},maxInputChars:{type:Number,default:24000,min:1000,max:500000},
  inputCostMicrosPerMillion:{type:Number,default:0,min:0},outputCostMicrosPerMillion:{type:Number,default:0,min:0},embeddingCostMicrosPerMillion:{type:Number,default:0,min:0},
  countries:{type:[String],default:[]},roles:{type:[String],default:[]},updatedByUserId:{type:Schema.Types.ObjectId,ref:'User'},
},{timestamps:true});
schema.index({purpose:1,enabled:1,priority:1});
schema.index({provider:1,purpose:1,model:1},{unique:true});
export const AiModelRegistry=mongoose.model('AiModelRegistry',schema);

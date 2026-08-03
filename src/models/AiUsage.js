import mongoose from 'mongoose';
const { Schema }=mongoose;
const schema=new Schema({
 publicId:{type:String,required:true,unique:true,index:true,immutable:true},feature:{type:String,required:true,index:true,maxlength:100},country:{type:String,required:true,uppercase:true,index:true},actorUserId:{type:Schema.Types.ObjectId,ref:'User',index:true},sessionKeyHash:{type:String,default:'',maxlength:64,index:true},provider:{type:String,required:true,index:true},model:{type:String,required:true,index:true},promptKey:{type:String,default:''},promptVersion:{type:Number,default:0},
 inputClassifications:{type:[String],default:[]},inputChars:{type:Number,default:0},outputChars:{type:Number,default:0},inputTokens:{type:Number,default:0},outputTokens:{type:Number,default:0},estimatedCostMicros:{type:Number,default:0,min:0},latencyMs:{type:Number,default:0,min:0},outcome:{type:String,enum:['success','blocked','fallback','failed'],required:true,index:true},moderationFlagged:{type:Boolean,default:false},toolNames:{type:[String],default:[]},errorCode:{type:String,default:'',maxlength:100},
},{timestamps:true});schema.index({country:1,createdAt:-1});schema.index({actorUserId:1,createdAt:-1});schema.index({createdAt:1},{expireAfterSeconds:180*24*60*60});
export const AiUsage=mongoose.model('AiUsage',schema);

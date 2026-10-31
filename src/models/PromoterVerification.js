import mongoose from 'mongoose';
const {Schema}=mongoose;
const schema=new Schema({publicId:{type:String,required:true,unique:true,immutable:true,index:true},userId:{type:Schema.Types.ObjectId,ref:'User',required:true,unique:true,index:true},country:{type:String,required:true,uppercase:true,index:true},status:{type:String,enum:['draft','submitted','verified','rejected','appealed'],default:'draft',index:true},channels:{type:[String],default:[]},niches:{type:[String],default:[]},audienceSize:{type:Number,min:0,max:1000000000,default:0},audienceLocation:{type:String,trim:true,maxlength:180,default:''},disclosureAcceptedAt:Date,submittedAt:Date,reviewedAt:Date,reviewedByUserId:{type:Schema.Types.ObjectId,ref:'User'},reason:{type:String,default:'',maxlength:500}},{timestamps:true,optimisticConcurrency:true});
schema.add({
  assignedUserId:{type:Schema.Types.ObjectId,ref:'User',default:null},assignedAt:Date,
  reviewHistory:{type:[new Schema({action:{type:String,enum:['claim','release','approve','reject','appeal'],required:true},actorUserId:{type:Schema.Types.ObjectId,ref:'User',required:true},reason:{type:String,trim:true,maxlength:1000,default:''},at:{type:Date,default:Date.now}},{_id:false})],default:[]},
  appeal:{message:{type:String,trim:true,maxlength:1000,default:''},submittedAt:Date,originalReviewerUserId:{type:Schema.Types.ObjectId,ref:'User'}},
});
schema.index({country:1,status:1,submittedAt:1,_id:1});
schema.add({ moderationEvidenceReadRevision:{type:Number,min:0,select:false} });
export const PromoterVerification=mongoose.model('PromoterVerification',schema);

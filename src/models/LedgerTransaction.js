import mongoose from 'mongoose';
const { Schema }=mongoose;
const entrySchema=new Schema({accountId:{type:Schema.Types.ObjectId,ref:'LedgerAccount',required:true},accountPublicId:{type:String,required:true},debitMinor:{type:Number,required:true,min:0,default:0},creditMinor:{type:Number,required:true,min:0,default:0},memo:{type:String,maxlength:200,default:''}},{_id:false});
const ledgerTransactionSchema=new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true}, traceId:{type:String,maxlength:32,default:'',immutable:true,index:true}, traceSpanId:{type:String,maxlength:16,default:'',immutable:true}, idempotencyKey:{type:String,required:true,unique:true,immutable:true,maxlength:160},
  referenceType:{type:String,required:true,maxlength:80,index:true}, referencePublicId:{type:String,required:true,maxlength:120,index:true}, country:{type:String,required:true,uppercase:true,minlength:2,maxlength:2,index:true}, currency:{type:String,required:true,uppercase:true,minlength:3,maxlength:3},
  description:{type:String,required:true,maxlength:260}, entries:{type:[entrySchema],required:true,validate:{validator(entries){if(entries.length<2)return false;const d=entries.reduce((s,e)=>s+e.debitMinor,0);const c=entries.reduce((s,e)=>s+e.creditMinor,0);return d>0&&d===c&&entries.every(e=>(e.debitMinor===0)!==(e.creditMinor===0));},message:'Ledger transaction must contain balanced one-sided entries.'}},
  postedAt:{type:Date,default:Date.now,immutable:true}
},{timestamps:{createdAt:true,updatedAt:false}});
for(const op of ['updateOne','updateMany','findOneAndUpdate','replaceOne','deleteOne','deleteMany']) ledgerTransactionSchema.pre(op,function(){throw new Error('Ledger transactions are immutable.');});
export const LedgerTransaction=mongoose.model('LedgerTransaction',ledgerTransactionSchema);

import mongoose from 'mongoose';
const {Schema}=mongoose;
const PLATFORM_ROLES=['warehouse','support','moderator','finance','country_admin','super_admin'];
const schema=new Schema({
  publicId:{type:String,required:true,unique:true,immutable:true,index:true},
  userId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true,immutable:true},
  role:{type:String,enum:PLATFORM_ROLES,required:true,index:true},
  operationalCountries:{type:[String],default:[],validate:{validator(values){return Array.isArray(values)&&values.length>0&&values.length<=20&&values.every(value=>value==='*'||/^[A-Z]{2}$/.test(String(value)));},message:'Platform grant requires valid operational country scopes.'}},
  warehouseScopes:{type:[String],default:[],validate:v=>Array.isArray(v)&&v.length<=100},
  capabilities:{type:[String],default:[],validate:v=>Array.isArray(v)&&v.length<=100},
  startsAt:{type:Date,required:true,index:true},
  expiresAt:{type:Date,required:true,index:true},
  status:{type:String,enum:['active','suspended','revoked','expired'],default:'active',index:true},
  reason:{type:String,required:true,maxlength:1000},
  approvalPublicId:{type:String,required:true,maxlength:120,index:true},
  approvedByUserId:{type:Schema.Types.ObjectId,ref:'User',required:true,index:true},
  revokedByUserId:{type:Schema.Types.ObjectId,ref:'User'},
  revokedAt:Date,
  statusReason:{type:String,maxlength:1000,default:''},
},{timestamps:true});
schema.index({userId:1,status:1},{unique:true,partialFilterExpression:{status:'active'}});
schema.index({status:1,expiresAt:1});
schema.pre('validate',function(){if(this.expiresAt<=this.startsAt)throw new Error('Platform grant expiry must be after its start time.');if(this.role==='super_admin'&&!this.operationalCountries.includes('*'))throw new Error('Super Admin grant must use global operational scope.');if(this.role!=='super_admin'&&this.operationalCountries.includes('*'))throw new Error('Only Super Admin may receive global operational scope.');});
export const PlatformGrant=mongoose.model('PlatformGrant',schema);

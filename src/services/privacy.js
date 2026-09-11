import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { hashPassword, verifyPassword } from '../core/crypto.js';
import { publicId } from '../core/ids.js';
import { decryptSensitive, encryptSensitive } from '../core/sensitive.js';
import { BusinessMember, BusinessOrganization, Device, Dispute, Order, Payout, PlatformGrant, PrivacyRequest, Refund, ReturnRequest, Review, SellerContactRequest, Store, StoreMember, SupportTicket, User } from '../models/index.js';
import { env } from '../config/env.js';

const exportDir=env.privacyExportDir;
const TERMINAL_ORDERS=['cancelled','expired','refunded'];

export async function createPrivacyRequest(request,{type,password,details=''}){
  const user=await User.findById(request.user._id).select('+passwordHash');
  if(!user||!(await verifyPassword(user.passwordHash,String(password||''))))throw new AppError('The current password is incorrect.',422,'INVALID_CURRENT_PASSWORD');
  if(type==='consent_withdrawal'){
    user.consents.marketing=false;await user.save();
    return PrivacyRequest.create({publicId:publicId('prv'),userId:user._id,userPublicId:user.publicId,country:user.country,type,status:'completed',details,identityVerifiedAt:new Date(),completedAt:new Date(),decision:'Marketing consent withdrawn immediately.'});
  }
  const active=await PrivacyRequest.findOne({userId:user._id,type,status:{$in:['requested','approved','processing','ready','blocked']}}).lean();
  if(active)throw new AppError('An active request of this type already exists.',409,'PRIVACY_REQUEST_ACTIVE');
  return PrivacyRequest.create({publicId:publicId('prv'),userId:user._id,userPublicId:user.publicId,country:user.country,type,details,identityVerifiedAt:new Date(),status:'requested',nextAttemptAt:new Date()});
}

async function exportPayload(userId){
  const user=await User.findById(userId).select('+operationalCountries').lean();if(!user)throw new AppError('Account not found.',404,'ACCOUNT_NOT_FOUND');
  const [orders,returns,disputes,tickets,reviews,sellerContacts,storeMemberships,businessMemberships,devices]=await Promise.all([
    Order.find({userId}).lean(),ReturnRequest.find({userId}).lean(),Dispute.find({userId}).lean(),SupportTicket.find({userId}).select('-requesterEmailEncrypted').lean(),Review.find({userId}).lean(),SellerContactRequest.find({customerUserId:userId}).lean(),StoreMember.find({userId}).lean(),BusinessMember.find({userId}).lean(),Device.find({userId}).select('-ipHash').lean(),
  ]);
  const cleanUser={publicId:user.publicId,name:user.name,email:user.email,phone:user.phone,role:user.role,status:user.status,country:user.country,shoppingCountry:user.shoppingCountry,currency:user.currency,locale:user.locale,timeZone:user.timeZone,consents:user.consents,roleProfile:user.roleProfile,preferences:user.preferences,createdAt:user.createdAt,updatedAt:user.updatedAt};
  return {generatedAt:new Date().toISOString(),retentionNotice:'Financial, fraud-prevention and legal records may be retained when required by applicable law or contractual obligations.',account:cleanUser,orders,returns,disputes,supportTickets:tickets,reviews,sellerContacts,storeMemberships,businessMemberships,devices};
}

async function deletionBlockers(userId){
  const [activeOrders,activeRefunds,activePayouts,ownedStores,ownedBusinesses]=await Promise.all([
    Order.countDocuments({userId,status:{$nin:TERMINAL_ORDERS}}),Refund.countDocuments({requestedByUserId:userId,status:{$in:['pending','processing']}}),Payout.countDocuments({ownerUserId:userId,status:{$in:['requested','approved','submitting','submitted','unknown']}}),Store.countDocuments({ownerUserId:userId,status:{$ne:'closed'}}),BusinessOrganization.countDocuments({ownerUserId:userId,status:{$ne:'closed'}}),
  ]);
  const blockers=[];if(activeOrders)blockers.push(`${activeOrders} active order(s)`);if(activeRefunds)blockers.push(`${activeRefunds} pending refund(s)`);if(activePayouts)blockers.push(`${activePayouts} unsettled payout(s)`);if(ownedStores)blockers.push(`${ownedStores} owned seller store(s)`);if(ownedBusinesses)blockers.push(`${ownedBusinesses} owned business organization(s)`);return blockers;
}

async function processExport(doc){
  await fs.mkdir(exportDir,{recursive:true});const payload=await exportPayload(doc.userId);const key=`${doc.publicId}.enc`;await fs.writeFile(path.join(exportDir,key),encryptSensitive(JSON.stringify(payload)),{mode:0o600});doc.storageKey=key;doc.status='ready';doc.readyAt=new Date();doc.expiresAt=new Date(Date.now()+24*60*60*1000);doc.lockedBy='';doc.lockedUntil=undefined;doc.lastError='';await doc.save();
}
async function processDeletion(doc){
  if(doc.legalHold?.active){doc.status='blocked';doc.decision=`Legal hold: ${doc.legalHold.reason||'Retention required.'}`;doc.lockedBy='';doc.lockedUntil=undefined;await doc.save();return;}
  const blockers=await deletionBlockers(doc.userId);if(blockers.length){doc.status='blocked';doc.decision=`Deletion blocked until obligations are resolved: ${blockers.join(', ')}.`;doc.lockedBy='';doc.lockedUntil=undefined;await doc.save();return;}
  const session=await mongoose.startSession();try{await session.withTransaction(async()=>{
    const user=await User.findById(doc.userId).select('+operationalCountries +passwordHash').session(session);if(!user){doc.status='completed';doc.completedAt=new Date();await doc.save({session});return;}
    const suffix=user.publicId.toLowerCase().replace(/[^a-z0-9]/g,'').slice(-24)||crypto.randomBytes(8).toString('hex');
    await PlatformGrant.updateMany({userId:user._id,status:{$in:['active','suspended']}},{$set:{status:'revoked',revokedAt:new Date(),statusReason:'Identity deleted through verified privacy workflow.'}},{session});
    user.name='Deleted user';user.email=`deleted-${suffix}@invalid.local`;user.emailNormalized=user.email;user.phone=`deleted-${suffix}`;user.phoneNormalized=user.phone;user.passwordHash=await hashPassword(crypto.randomBytes(48).toString('base64url'));user.role='customer';user.status='deleted';user.operationalCountries=[];user.platformAccessManagedAt=user.platformAccessManagedAt||new Date();user.roleProfile={};user.preferences={lowData:false};user.consents={terms:true,privacy:true,marketing:false,recordedAt:new Date(),policyVersion:user.consents?.policyVersion||'2026-07'};user.emailVerifiedAt=undefined;user.phoneVerifiedAt=undefined;user.security.tokenVersion=Number(user.security?.tokenVersion||0)+1;user.security.mfaEnabled=false;user.security.mfaSecretEncrypted=undefined;user.security.mfaPendingSecretEncrypted=undefined;user.security.mfaRecoveryCodeHashes=undefined;await user.save({session});
    await StoreMember.updateMany({userId:user._id,status:'invited'},{$set:{status:'revoked',revokedAt:new Date()}},{session});await BusinessMember.updateMany({userId:user._id,status:'invited'},{$set:{status:'revoked',revokedAt:new Date()}},{session});await Device.deleteMany({userId:user._id},{session});
    doc.status='completed';doc.completedAt=new Date();doc.decision='Account identity anonymized. Financial and legally required transaction records remain retained under restricted access.';doc.lockedBy='';doc.lockedUntil=undefined;await doc.save({session});
  });}finally{await session.endSession();}
}

export async function processPrivacyRequests({workerId=`privacy-${process.pid}`,limit=10}={}){
  let processed=0;for(let i=0;i<limit;i++){
    const now=new Date(),doc=await PrivacyRequest.findOneAndUpdate({$and:[{$or:[{status:'requested',type:'export'},{status:'approved',type:'deletion'}]},{nextAttemptAt:{$lte:now}},{$or:[{lockedUntil:{$exists:false}},{lockedUntil:{$lte:now}}]}]},{$set:{status:'processing',lockedBy:workerId,lockedUntil:new Date(Date.now()+2*60*1000)},$inc:{attempts:1}},{sort:{createdAt:1},returnDocument:'after'}).select('+storageKey');
    if(!doc)break;try{if(doc.type==='export')await processExport(doc);else await processDeletion(doc);processed++;}catch(error){doc.status='failed';doc.lastError=String(error.message||error).slice(0,1000);doc.nextAttemptAt=new Date(Date.now()+Math.min(60,2**Math.min(doc.attempts,5))*60_000);doc.lockedBy='';doc.lockedUntil=undefined;await doc.save();}
  }return processed;
}
export async function privacyExportPayload(doc){if(doc.status!=='ready'||!doc.storageKey||!doc.expiresAt||doc.expiresAt<=new Date())throw new AppError('Privacy export is not available.',404,'PRIVACY_EXPORT_NOT_READY');return decryptSensitive(await fs.readFile(path.join(exportDir,doc.storageKey),'utf8'));}
export async function expirePrivacyExports(now=new Date()){const docs=await PrivacyRequest.find({type:'export',status:'ready',expiresAt:{$lte:now}}).select('+storageKey');for(const doc of docs){if(doc.storageKey)await fs.rm(path.join(exportDir,doc.storageKey),{force:true}).catch(()=>{});doc.storageKey='';doc.status='expired';await doc.save();}return docs.length;}
export async function approvePrivacyRequest(doc,actor,decision='Approved after identity and obligation review.'){
  if(doc.status!=='requested'&&doc.status!=='blocked')throw new AppError('Privacy request is not awaiting review.',409,'PRIVACY_REQUEST_STATE');if(doc.type==='export')throw new AppError('Verified exports are processed automatically.',409,'PRIVACY_EXPORT_AUTO');if(doc.legalHold?.active)throw new AppError('This request is under legal hold.',409,'PRIVACY_LEGAL_HOLD');doc.status=doc.type==='deletion'?'approved':'completed';doc.processedByUserId=actor._id;doc.decision=String(decision||'').slice(0,2000);if(doc.status==='completed')doc.completedAt=new Date();doc.nextAttemptAt=new Date();await doc.save();return doc;
}
export async function setPrivacyLegalHold(doc,actor,{active,reason}){doc.legalHold={active:Boolean(active),reason:Boolean(active)?String(reason||'').trim().slice(0,1000):'',setByUserId:actor._id,setAt:new Date()};if(active&&['requested','approved','processing'].includes(doc.status))doc.status='blocked';else if(!active&&doc.status==='blocked')doc.status='requested';await doc.save();return doc;}

import crypto from 'node:crypto';
import { AppError } from '../core/errors.js';
import { hashToken, verifyPassword } from '../core/crypto.js';
import { decryptSensitive, encryptSensitive } from '../core/sensitive.js';
import { Device, User } from '../models/index.js';
import { PRIVILEGED_MFA_ROLES } from '../middleware/privileged-mfa-paths.js';

const BASE32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buffer){
  let bits='';
  for(const byte of buffer)bits+=byte.toString(2).padStart(8,'0');
  let out='';
  for(let i=0;i<bits.length;i+=5){const chunk=bits.slice(i,i+5).padEnd(5,'0');out+=BASE32[Number.parseInt(chunk,2)];}
  return out;
}

function base32Decode(value){
  const clean=String(value||'').toUpperCase().replace(/[^A-Z2-7]/g,'');
  let bits='';
  for(const char of clean){const index=BASE32.indexOf(char);if(index<0)throw new AppError('Authenticator secret is invalid.',500,'MFA_SECRET_INVALID');bits+=index.toString(2).padStart(5,'0');}
  const bytes=[];
  for(let i=0;i+8<=bits.length;i+=8)bytes.push(Number.parseInt(bits.slice(i,i+8),2));
  return Buffer.from(bytes);
}

function hotp(secret,counter,digits=6){
  const key=base32Decode(secret);
  const message=Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest=crypto.createHmac('sha1',key).update(message).digest();
  const offset=digest[digest.length-1]&0x0f;
  const binary=((digest[offset]&0x7f)<<24)|((digest[offset+1]&0xff)<<16)|((digest[offset+2]&0xff)<<8)|(digest[offset+3]&0xff);
  return String(binary%(10**digits)).padStart(digits,'0');
}

export function totpCode(secret,{time=Date.now(),stepSeconds=30}={}){
  return hotp(secret,Math.floor(time/1000/stepSeconds));
}

function normalizeCode(value){return String(value||'').replace(/\s+/g,'').trim();}
function recoveryHash(code){return hashToken(`mfa-recovery:${String(code||'').replace(/[^A-Za-z0-9]/g,'').toUpperCase()}`);}
function recoveryCodes(){return Array.from({length:10},()=>{const raw=crypto.randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g,'').toUpperCase().slice(0,12).padEnd(12,'X');return `${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8,12)}`;});}

function verifyTotpAgainstSecret(secret,code,{window=1,time=Date.now()}={}){
  const supplied=normalizeCode(code);
  if(!/^\d{6}$/.test(supplied))return null;
  const current=Math.floor(time/1000/30);
  for(let offset=-window;offset<=window;offset+=1){const counter=current+offset;if(counter>=0&&crypto.timingSafeEqual(Buffer.from(hotp(secret,counter)),Buffer.from(supplied)))return counter;}
  return null;
}

export function mfaRequiredForUser(user,required=true){return Boolean(required&&user&&PRIVILEGED_MFA_ROLES.has(user.role));}

function assertInitialEnrollmentAllowed(user){
  if(!user||user.status!=='active')throw new AppError('This account is unavailable.',403,'ACCOUNT_UNAVAILABLE');
  if(user.security?.mfaEnabled)throw new AppError('Authenticator MFA is already enabled. Use your existing factor to disable it before starting new setup.',409,'MFA_ALREADY_ENABLED');
}

function enrollmentFence(user){
  // Enrollment must not revive a revoked password/session proof or replace a
  // factor activated after the initial read. Match the actual pending secret,
  // too: raw administrative writes may not increment the document version.
  // Hydrated legacy defaults represent missing stored fields, so preserve that
  // distinction instead of accepting a concurrent explicit false/zero write.
  const missingEnabled=user.security.mfaEnabled===false&&user.$isDefault('security.mfaEnabled');
  const missingVersion=user.security.tokenVersion===0&&user.$isDefault('security.tokenVersion');
  return {_id:user._id,status:'active','security.mfaEnabled':missingEnabled?{$exists:false}:false,
    'security.tokenVersion':missingVersion?{$exists:false}:user.security.tokenVersion,__v:user.__v===undefined?{$exists:false}:user.__v,
    'security.mfaPendingSecretEncrypted':user.security.mfaPendingSecretEncrypted===undefined?{$exists:false}:user.security.mfaPendingSecretEncrypted};
}

function enrollmentChanged(){
  return new AppError('Authenticator setup changed. Reload your security settings and start again.',409,'MFA_ENROLLMENT_CHANGED');
}

export async function beginMfaEnrollment(userId,password){
  const user=await User.findById(userId).select('+passwordHash +security.mfaPendingSecretEncrypted');
  assertInitialEnrollmentAllowed(user);
  if(!(await verifyPassword(user.passwordHash,String(password||''))))throw new AppError('The current password is incorrect.',422,'INVALID_CURRENT_PASSWORD');
  const secret=base32Encode(crypto.randomBytes(20));
  const result=await User.updateOne({...enrollmentFence(user),passwordHash:user.passwordHash},
    {$set:{'security.mfaPendingSecretEncrypted':encryptSensitive(secret)},$inc:{__v:1}});
  if(result.modifiedCount!==1)throw enrollmentChanged();
  return mfaEnrollmentDetails(user,secret);
}

function mfaEnrollmentDetails(user,secret){
  const issuer='Classic Mart';
  const label=`${issuer}:${user.email}`;
  const uri=`otpauth://totp/${encodeURIComponent(label)}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  return {secret,uri};
}

export async function pendingMfaEnrollment(userId){
  const user=await User.findById(userId).select('+security.mfaPendingSecretEncrypted');
  if(!user||user.status!=='active'||user.security?.mfaEnabled||!user.security?.mfaPendingSecretEncrypted)return null;
  return mfaEnrollmentDetails(user,decryptSensitive(user.security.mfaPendingSecretEncrypted));
}

export async function confirmMfaEnrollment(userId,code,currentDevicePublicId=''){
  const user=await User.findById(userId).select('+security.mfaPendingSecretEncrypted +security.mfaSecretEncrypted +security.mfaRecoveryCodeHashes +security.mfaLastCounter');
  assertInitialEnrollmentAllowed(user);
  if(!user.security?.mfaPendingSecretEncrypted)throw new AppError('Start authenticator setup first.',409,'MFA_SETUP_REQUIRED');
  const secret=decryptSensitive(user.security.mfaPendingSecretEncrypted);
  const counter=verifyTotpAgainstSecret(secret,code,{window:1});
  if(counter===null)throw new AppError('The authenticator code is invalid.',422,'MFA_CODE_INVALID');
  const codes=recoveryCodes();
  const now=new Date();
  const updated=await User.findOneAndUpdate(enrollmentFence(user),{
    $set:{'security.mfaEnabled':true,'security.mfaSecretEncrypted':encryptSensitive(secret),
      'security.mfaRecoveryCodeHashes':codes.map(recoveryHash),'security.mfaLastCounter':counter,
      'security.mfaEnrolledAt':now,'security.mfaRecoveryGeneratedAt':now},
    $unset:{'security.mfaPendingSecretEncrypted':1},$inc:{'security.tokenVersion':1,__v:1},
  },{returnDocument:'after'}).select('+security.mfaSecretEncrypted +security.mfaRecoveryCodeHashes +security.mfaLastCounter');
  if(!updated)throw enrollmentChanged();
  await Device.updateMany({userId:updated._id,revokedAt:null,...(currentDevicePublicId?{publicId:{$ne:currentDevicePublicId}}:{})},{$set:{revokedAt:new Date(),revokedReason:'mfa_enabled'}});
  return {user:updated,codes};
}

export async function verifyMfa(userId,token){
  const user=await User.findById(userId).select('+security.mfaSecretEncrypted +security.mfaRecoveryCodeHashes +security.mfaLastCounter');
  if(!user?.security?.mfaEnabled||!user.security.mfaSecretEncrypted)throw new AppError('Multi-factor authentication is not configured.',409,'MFA_NOT_CONFIGURED');
  const clean=normalizeCode(token);
  if(/^\d{6}$/.test(clean)){
    const secret=decryptSensitive(user.security.mfaSecretEncrypted);
    const counter=verifyTotpAgainstSecret(secret,clean,{window:1});
    if(counter!==null){
      const result=await User.updateOne({_id:user._id,'security.mfaEnabled':true,$or:[{'security.mfaLastCounter':{$lt:counter}},{'security.mfaLastCounter':{$exists:false}}]},{$set:{'security.mfaLastCounter':counter}});
      if(result.modifiedCount===1)return {user,method:'totp'};
      throw new AppError('That authenticator code was already used. Wait for the next code.',422,'MFA_REPLAY');
    }
  }
  const hashed=recoveryHash(clean);
  const result=await User.updateOne({_id:user._id,'security.mfaEnabled':true,'security.mfaRecoveryCodeHashes':hashed},{$pull:{'security.mfaRecoveryCodeHashes':hashed}});
  if(result.modifiedCount===1)return {user,method:'recovery'};
  throw new AppError('The authentication code is invalid.',422,'MFA_CODE_INVALID');
}

async function verifyPasswordAndMfa(userId,password,token){
  const user=await User.findById(userId).select('+passwordHash');
  if(!user||!(await verifyPassword(user.passwordHash,String(password||''))))throw new AppError('The current password is incorrect.',422,'INVALID_CURRENT_PASSWORD');
  await verifyMfa(userId,token);
  return user;
}

export async function regenerateRecoveryCodes(userId,password,token){
  await verifyPasswordAndMfa(userId,password,token);
  const codes=recoveryCodes();
  await User.updateOne({_id:userId,'security.mfaEnabled':true},{$set:{'security.mfaRecoveryCodeHashes':codes.map(recoveryHash),'security.mfaRecoveryGeneratedAt':new Date()}});
  return codes;
}

export async function disableMfa(userId,password,token,reason='user_disabled',currentDevicePublicId=''){
  const user=await verifyPasswordAndMfa(userId,password,token);
  return clearMfa(user,reason,currentDevicePublicId);
}

export async function clearMfa(user,reason='administrative_recovery',currentDevicePublicId='',session=null){
  const updated=await User.findByIdAndUpdate(user._id,{
    $set:{'security.mfaEnabled':false,'security.mfaLastCounter':-1},
    $unset:{'security.mfaSecretEncrypted':1,'security.mfaPendingSecretEncrypted':1,'security.mfaRecoveryCodeHashes':1,'security.mfaEnrolledAt':1,'security.mfaRecoveryGeneratedAt':1},
    $inc:{'security.tokenVersion':1},
  },{returnDocument:'after',...(session?{session}:{})});
  await Device.updateMany({userId:user._id,revokedAt:null,...(currentDevicePublicId?{publicId:{$ne:currentDevicePublicId}}:{})},{$set:{revokedAt:new Date(),revokedReason:reason}},session?{session}:{});
  return updated;
}

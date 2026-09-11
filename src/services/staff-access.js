import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { hashToken, hashValue, normalizeEmail, randomToken } from '../core/crypto.js';
import { encryptSensitive } from '../core/sensitive.js';
import { env } from '../config/env.js';
import { PlatformStaffInvitation, User } from '../models/index.js';
import { addOutboxEvent } from './outbox.js';
import { createApproval } from './stage9.js';
import { assertOperationalCountry, operationalCountriesFor } from './authorization.js';
import { hydratePlatformAuthorization } from './platform-grants.js';
import { cursorScope, cursorSort, pageResult } from './pagination.js';

const STAFF_ROLES=new Set(['warehouse','support','moderator','finance','country_admin']);
const INVITE_TTL_MS=72*60*60*1000;

function maskEmail(email){
  const [local,domain]=normalizeEmail(email).split('@');
  if(!local||!domain)return '';
  return `${local.slice(0,2)}${'*'.repeat(Math.max(1,Math.min(8,local.length-2)))}@${domain}`;
}
function normalizeCountries(values=[]){return [...new Set(values.map(v=>String(v||'').trim().toUpperCase()).filter(v=>/^[A-Z]{2}$/.test(v)))];}

export async function createPlatformStaffInvitation(request,{email,role,operationalCountries=[],warehouseScopes=[],grantDurationDays=180,reason}){
  const cleanEmail=normalizeEmail(email),countries=normalizeCountries(operationalCountries),warehouses=[...new Set((warehouseScopes||[]).map(v=>String(v||'').trim()).filter(Boolean))].slice(0,100),duration=Math.max(1,Math.min(365,Math.floor(Number(grantDurationDays)||180)));
  if(!cleanEmail.includes('@'))throw new AppError('Enter a valid staff email address.',422,'STAFF_INVITE_EMAIL');
  if(!STAFF_ROLES.has(role))throw new AppError('Staff role is invalid.',422,'STAFF_INVITE_ROLE');
  const scopes=operationalCountriesFor(request.user);
  let approvalCountry='';
  if(request.user?.role==='country_admin'){
    if(['finance','country_admin'].includes(role))throw new AppError('Only Super Admin can invite Finance or Country Admin staff.',403,'STAFF_ROLE_SCOPE');
    if(countries.length!==1)throw new AppError('Country Admin invitations must target exactly one operational country.',422,'COUNTRY_REQUIRED');
    assertOperationalCountry(request.user,countries[0]);approvalCountry=countries[0];
  }else if(request.user?.role==='super_admin'){
    if(!countries.length)throw new AppError('Choose at least one operational country for privileged staff.',422,'COUNTRY_REQUIRED');
  }else throw new AppError('Administrator access required.',403,'FORBIDDEN');
  if(!scopes.includes('*'))for(const country of countries)assertOperationalCountry(request.user,country);
  const emailHash=hashValue(cleanEmail),now=new Date();
  await PlatformStaffInvitation.updateMany({emailHash,status:'pending',expiresAt:{$lte:now}},{$set:{status:'expired'}});
  const active=await PlatformStaffInvitation.findOne({emailHash,status:'pending',expiresAt:{$gt:now}}).select('+emailHash');
  if(active)throw new AppError('An active staff invitation already exists for this email.',409,'STAFF_INVITE_EXISTS');
  const token=randomToken(32),expiresAt=new Date(Date.now()+INVITE_TTL_MS);
  const invitation=await PlatformStaffInvitation.create({publicId:publicId('sinv'),emailHash,emailEncrypted:encryptSensitive(cleanEmail),emailMasked:maskEmail(cleanEmail),role,operationalCountries:countries,warehouseScopes:warehouses,grantDurationDays:duration,approvalCountry,reason:String(reason||'').trim(),status:'pending',tokenHash:hashToken(token),expiresAt,invitedByUserId:request.user._id});
  const link=`${String(env.baseUrl).replace(/\/$/,'')}/staff/invitations/${encodeURIComponent(token)}`;
  await addOutboxEvent({type:'platform.staff_invitation',aggregateType:'platform_staff_invitation',aggregatePublicId:invitation.publicId,payload:{email:cleanEmail,subject:'Classic Mart staff invitation',body:`You have been invited to Classic Mart as ${role.replaceAll('_',' ')} for ${countries.join(', ')}. Create or sign in to a dedicated account using this email, verify email and phone, enroll MFA, then open this link within 72 hours: ${link}. Accepting the invitation does not grant access immediately; a different administrator must approve activation.`}});
  return invitation;
}


export async function platformStaffInvitationPreview(request,rawToken){
  if(!request.user)throw new AppError('Sign in before viewing a staff invitation.',401,'UNAUTHENTICATED');
  const invitation=await PlatformStaffInvitation.findOne({tokenHash:hashToken(rawToken),status:'pending'}).select('+tokenHash +emailHash');
  if(!invitation)throw new AppError('Staff invitation is invalid or no longer active.',404,'STAFF_INVITE_NOT_FOUND');
  if(invitation.expiresAt<=new Date())throw new AppError('Staff invitation expired. Ask an administrator to send a new invitation.',410,'STAFF_INVITE_EXPIRED');
  if(hashValue(normalizeEmail(request.user.email))!==invitation.emailHash)throw new AppError(`This invitation belongs to ${invitation.emailMasked}. Sign in with that dedicated account.`,403,'STAFF_INVITE_EMAIL_MISMATCH');
  return {id:invitation.publicId,emailMasked:invitation.emailMasked,role:invitation.role,operationalCountries:invitation.operationalCountries,warehouseScopes:invitation.warehouseScopes||[],grantDurationDays:Number(invitation.grantDurationDays||180),expiresAt:invitation.expiresAt,ready:Boolean(request.user.emailVerifiedAt&&request.user.phoneVerifiedAt&&request.user.security?.mfaEnabled),emailVerified:Boolean(request.user.emailVerifiedAt),phoneVerified:Boolean(request.user.phoneVerifiedAt),mfaEnabled:Boolean(request.user.security?.mfaEnabled)};
}

export async function acceptPlatformStaffInvitation(request,rawToken){
  if(!request.user)throw new AppError('Sign in before accepting a staff invitation.',401,'UNAUTHENTICATED');
  if(!request.user.emailVerifiedAt||!request.user.phoneVerifiedAt)throw new AppError('Verify email and phone before accepting privileged staff access.',409,'STAFF_VERIFICATION_REQUIRED');
  if(!request.user.security?.mfaEnabled)throw new AppError('Enroll MFA before accepting privileged staff access.',409,'STAFF_MFA_REQUIRED');
  const tokenHash=hashToken(rawToken),now=new Date();
  const invitation=await PlatformStaffInvitation.findOne({tokenHash,status:'pending'}).select('+tokenHash +emailHash +emailEncrypted');
  if(!invitation)throw new AppError('Staff invitation is invalid or no longer active.',404,'STAFF_INVITE_NOT_FOUND');
  if(invitation.expiresAt<=now){invitation.status='expired';await invitation.save();throw new AppError('Staff invitation expired. Ask an administrator to send a new invitation.',410,'STAFF_INVITE_EXPIRED');}
  const userEmail=normalizeEmail(request.user.email);
  if(hashValue(userEmail)!==invitation.emailHash)throw new AppError(`This invitation belongs to ${invitation.emailMasked}. Sign in with that dedicated account.`,403,'STAFF_INVITE_EMAIL_MISMATCH');
  const inviter=await User.findById(invitation.invitedByUserId).select('+operationalCountries');
  if(inviter)await hydratePlatformAuthorization(inviter);
  if(!inviter||inviter.status!=='active'||!['country_admin','super_admin'].includes(inviter.role))throw new AppError('The inviting administrator is no longer authorized. Ask for a new invitation.',409,'STAFF_INVITER_INACTIVE');
  const approval=await createApproval({user:inviter,type:'platform_staff_access',country:invitation.approvalCountry,targetType:'user',targetPublicId:request.user.publicId,payload:{action:'grant',role:invitation.role,operationalCountries:invitation.operationalCountries,warehouseScopes:invitation.warehouseScopes||[],grantDurationDays:Number(invitation.grantDurationDays||180)},reason:`Accepted staff invitation ${invitation.publicId}: ${invitation.reason}`});
  invitation.status='accepted';invitation.acceptedByUserId=request.user._id;invitation.acceptedAt=now;invitation.approvalRequestId=approval._id;invitation.approvalRequestPublicId=approval.publicId;invitation.tokenHash='accepted';await invitation.save();
  return {invitation,approval};
}

export async function revokePlatformStaffInvitation(request,publicId){
  const invitation=await PlatformStaffInvitation.findOne({publicId,status:'pending'}).select('+emailEncrypted');
  if(!invitation)throw new AppError('Pending staff invitation not found.',404,'STAFF_INVITE_NOT_FOUND');
  if(request.user?.role==='country_admin'){
    if(!invitation.approvalCountry)throw new AppError('Global staff invitations can only be revoked by Super Admin.',403,'COUNTRY_SCOPE');
    assertOperationalCountry(request.user,invitation.approvalCountry);
  }
  invitation.status='revoked';invitation.revokedByUserId=request.user._id;invitation.revokedAt=new Date();await invitation.save();return invitation;
}

export async function staffInvitationsForAdmin(user,{cursor='',limit=50}={}){
  const scopes=operationalCountriesFor(user),base=user.role==='super_admin'?{}:{approvalCountry:{$in:scopes}};
  const size=Math.max(1,Math.min(100,Number(limit)||50));
  const [rows,total]=await Promise.all([
    PlatformStaffInvitation.find(cursorScope(base,cursor)).select('-emailEncrypted -emailHash -tokenHash').sort(cursorSort()).limit(size+1).lean(),
    PlatformStaffInvitation.countDocuments(base),
  ]);
  return pageResult(rows,{limit:size,total});
}

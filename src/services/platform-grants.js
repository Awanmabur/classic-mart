import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { PlatformGrant, User } from '../models/index.js';
import { cursorScope, cursorSort, pageResult } from './pagination.js';

export const PLATFORM_GRANT_ROLES=Object.freeze(new Set(['warehouse','support','moderator','finance','country_admin','super_admin']));
export const DEFAULT_PLATFORM_GRANT_DAYS=180;

function normalizedCountries(values=[]){return [...new Set((values||[]).map(value=>String(value||'').trim().toUpperCase()).filter(value=>value==='*'||/^[A-Z]{2}$/.test(value)))];}
function normalizedStrings(values=[],limit=100){return [...new Set((values||[]).map(value=>String(value||'').trim()).filter(Boolean))].slice(0,limit);}
function attach(user,context){Object.defineProperty(user,'authorizationContext',{value:context,writable:true,configurable:true,enumerable:false});return user;}
function grantSnapshot(grant){return {publicId:grant.publicId,role:grant.role,operationalCountries:[...(grant.operationalCountries||[])],warehouseScopes:[...(grant.warehouseScopes||[])],capabilities:[...(grant.capabilities||[])],startsAt:grant.startsAt,expiresAt:grant.expiresAt,status:grant.status};}

export async function hydratePlatformAuthorization(user,now=new Date()){
  if(!user)return user;
  if(!user.platformAccessManagedAt){attach(user,{platformManaged:false,activePlatformGrants:[]});return user;}
  const grants=await PlatformGrant.find({userId:user._id,status:'active',startsAt:{$lte:now},expiresAt:{$gt:now}}).sort({createdAt:-1}).limit(2).lean();
  if(grants.length>1)throw new AppError('Multiple active platform grants detected. Access is blocked pending administrator reconciliation.',403,'PLATFORM_GRANT_CONFLICT');
  const active=grants[0];
  const context={platformManaged:true,activePlatformGrants:active?[grantSnapshot(active)]:[]};
  attach(user,context);
  if(active){user.role=active.role;user.operationalCountries=[...(active.operationalCountries||[])];}
  else{user.role='customer';user.operationalCountries=[];}
  return user;
}

export async function activatePlatformGrant({user,role,operationalCountries,warehouseScopes=[],capabilities=[],approvedByUserId,approvalPublicId,reason,expiresAt,durationDays=DEFAULT_PLATFORM_GRANT_DAYS,session=null}={}){
  if(!user)throw new AppError('Staff account is required.',422,'PLATFORM_GRANT_USER_REQUIRED');
  if(!PLATFORM_GRANT_ROLES.has(role)||role==='super_admin')throw new AppError('Platform grant role is invalid for staff provisioning.',422,'PLATFORM_GRANT_ROLE_INVALID');
  const countries=normalizedCountries(operationalCountries);
  if(!countries.length||countries.includes('*'))throw new AppError('Platform staff grants require one or more explicit country scopes.',422,'PLATFORM_GRANT_COUNTRY_REQUIRED');
  const days=Math.max(1,Math.min(365,Math.floor(Number(durationDays)||DEFAULT_PLATFORM_GRANT_DAYS)));
  const now=new Date(),end=expiresAt?new Date(expiresAt):new Date(now.getTime()+days*86_400_000);
  if(Number.isNaN(end.getTime())||end<=now)throw new AppError('Platform grant expiry must be in the future.',422,'PLATFORM_GRANT_EXPIRY_INVALID');
  // Security-first transition: once managed, a missing active grant means no platform privilege. This prevents a stale User.role mirror from granting access if a write is interrupted.
  user.platformAccessManagedAt=user.platformAccessManagedAt||now;user.role='customer';user.operationalCountries=[];user.status='active';user.security.tokenVersion=Number(user.security?.tokenVersion||0)+1;await user.save(session?{session}:undefined);
  await PlatformGrant.updateMany({userId:user._id,status:{$in:['active','suspended']}},{$set:{status:'revoked',revokedAt:now,revokedByUserId:approvedByUserId,statusReason:'Superseded by a newly approved platform grant.'}},session?{session}:undefined);
  const grantDocument={publicId:publicId('pgr'),userId:user._id,role,operationalCountries:countries,warehouseScopes:normalizedStrings(warehouseScopes),capabilities:normalizedStrings(capabilities),startsAt:now,expiresAt:end,status:'active',reason:String(reason||'Approved platform access.').trim().slice(0,1000),approvalPublicId:String(approvalPublicId||'').trim(),approvedByUserId};
  const grant=session?(await PlatformGrant.create([grantDocument],{session}))[0]:await PlatformGrant.create(grantDocument);
  // Compatibility mirror only. Request authorization remains grant-authoritative after platformAccessManagedAt is set.
  user.role=role;user.operationalCountries=countries;user.country=countries[0];await user.save(session?{session}:undefined);
  return grant;
}

export async function currentPlatformGrantForUser(userId,{includeInactive=false}={}){
  const query={userId};if(!includeInactive){const now=new Date();Object.assign(query,{status:'active',startsAt:{$lte:now},expiresAt:{$gt:now}});}
  return PlatformGrant.findOne(query).sort({createdAt:-1}).lean();
}

export async function platformGrantRowsForAdmin(user,{cursor='',limit=50}={}){
  const now=new Date();const scopes=user?.role==='super_admin'?null:(user?.authorizationContext?.activePlatformGrants?.[0]?.operationalCountries||user?.operationalCountries||[]).filter(v=>v!=='*');
  const base={};if(scopes)base.operationalCountries={$in:scopes};
  const size=Math.max(1,Math.min(100,Number(limit)||50));
  const [rows,total]=await Promise.all([
    PlatformGrant.find(cursorScope(base,cursor)).populate('userId','publicId name email phone status country emailVerifiedAt phoneVerifiedAt security.mfaEnabled platformAccessManagedAt').populate('approvedByUserId','publicId name').sort(cursorSort()).limit(size+1).lean(),
    PlatformGrant.countDocuments(base),
  ]);
  const page=pageResult(rows,{limit:size,total});
  page.items=page.items.map(row=>({...row,isCurrent:row.status==='active'&&row.startsAt<=now&&row.expiresAt>now}));
  return page;
}

export async function suspendPlatformGrant({user,actorUserId,reason='Platform access suspended.',session=null}={}){
  const now=new Date();
  if(user.platformAccessManagedAt)await PlatformGrant.updateMany({userId:user._id,status:'active'},{$set:{status:'suspended',statusReason:String(reason).slice(0,1000),revokedByUserId:actorUserId,revokedAt:now}},session?{session}:undefined);
  user.status='suspended';user.security.tokenVersion=Number(user.security?.tokenVersion||0)+1;await user.save(session?{session}:undefined);
}

export async function revokePlatformGrant({user,actorUserId,reason='Platform access revoked.',session=null}={}){
  const now=new Date();
  if(user.platformAccessManagedAt)await PlatformGrant.updateMany({userId:user._id,status:{$in:['active','suspended']}},{$set:{status:'revoked',statusReason:String(reason).slice(0,1000),revokedByUserId:actorUserId,revokedAt:now}},session?{session}:undefined);
  user.platformAccessManagedAt=user.platformAccessManagedAt||now;user.role='customer';user.status='active';user.operationalCountries=[];user.security.tokenVersion=Number(user.security?.tokenVersion||0)+1;await user.save(session?{session}:undefined);
}

export async function expirePlatformGrants(now=new Date(),{limit=100}={}){
  const rows=await PlatformGrant.find({status:'active',expiresAt:{$lte:now}}).sort({expiresAt:1}).limit(limit);
  let expired=0;
  for(const grant of rows){
    const claimed=await PlatformGrant.findOneAndUpdate({_id:grant._id,status:'active',expiresAt:{$lte:now}},{$set:{status:'expired',statusReason:'Grant reached its approved expiry.'}},{returnDocument:'after'});
    if(!claimed)continue;
    await User.updateOne({_id:grant.userId,platformAccessManagedAt:{$exists:true}},{$set:{role:'customer',operationalCountries:[]},$inc:{'security.tokenVersion':1}});
    expired++;
  }
  return expired;
}

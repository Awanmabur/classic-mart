import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { env } from '../config/env.js';
import { CountrySetting, Device, PlatformGrant, Store, StoreMember, User } from '../models/index.js';
import { businessSame, fenceBusinessRecord } from './business-access.js';
import { currentRequestDevice } from './country-admin-workspace-access.js';

export async function sellerBusinessAccess(request, { session = null, write = false } = {}) {
  const actor = request.user?._id && await User.findById(request.user._id).session(session);
  if (!actor || actor.status !== 'active' || !['seller','customer'].includes(actor.role) || actor.platformAccessManagedAt
    || !Number.isSafeInteger(actor.security?.tokenVersion) || actor.security.tokenVersion < 0
    || actor.security.tokenVersion !== request.user.security?.tokenVersion
    || (request.session?.tokenVersion !== undefined && actor.security.tokenVersion !== request.session.tokenVersion)
    || await PlatformGrant.exists({ userId: actor._id }).session(session)) throw new AppError('A current Seller account is required.',403,'SELLER_BUSINESS_ACCOUNT_UNAVAILABLE');
  if (!env.auth.simpleLogin && (!actor.emailVerifiedAt || !actor.onboardingCompletedAt)) throw new AppError('Complete account verification first.',403,'ACCOUNT_UNAVAILABLE');
  if (!env.auth.simpleLogin && env.security.privilegedMfaRequired && !actor.security.mfaEnabled) throw new AppError('Authenticator enrollment is required for supplier operations.',403,'MFA_ENROLLMENT_REQUIRED');
  const device = await currentRequestDevice(request,{userId:actor._id,session});
  const selected = request.session?.activeStorePublicId || request.store?.publicId;
  if (selected !== undefined && (typeof selected !== 'string' || !/^[A-Za-z0-9_-]{4,120}$/.test(selected))) throw new AppError('Select a valid Seller workspace.',422,'SELLER_WORKSPACE_INVALID');
  if (!selected && actor.role !== 'seller') throw new AppError('Select your accepted store before opening supplier operations.',403,'SELLER_WORKSPACE_REQUIRED');
  const memberships = await StoreMember.find({ userId:actor._id,status:'active',acceptedAt:mongoose.trusted({$type:'date'}),role:mongoose.trusted({$in:['owner','admin','finance']}) }).session(session);
  // Only an owner may use the default workspace; staff explicitly select theirs.
  const store = await Store.findOne({ ...(selected?{publicId:selected}:{ownerUserId:actor._id}),_id:mongoose.trusted({$in:memberships.map(row=>row.storeId)}),status:mongoose.trusted({$in:write?['verified']:['verified','pending_verification']}) }).sort({createdAt:1,_id:1}).session(session);
  const member = store && memberships.find(row=>businessSame(row.storeId,store._id));
  const owner = store && await User.findOne({_id:store.ownerUserId,role:'seller',status:'active',platformAccessManagedAt:null}).session(session);
  if (!store || !member || !owner || (member.role==='owner')!==businessSame(store.ownerUserId,actor._id)
    || await PlatformGrant.exists({userId:store.ownerUserId}).session(session)) throw new AppError('Current Seller Finance permission for this store is required.',403,'SELLER_BUSINESS_FORBIDDEN');
  const market=await CountrySetting.findOne({code:store.country,currency:store.currency,active:true}).session(session);
  if(!market?.timeZone)throw new AppError('The supplier market is unavailable.',409,'SELLER_BUSINESS_MARKET_UNAVAILABLE');
  const context={request,actor,device,store,member,market,owner};
  if(write)await fenceSellerBusinessAccess(context,session);
  return context;
}
export async function fenceSellerBusinessAccess(context,session){
  const {actor,device,member,store,market,owner}=context;
  await fenceBusinessRecord(User,actor,session,{status:'active',role:actor.role,'security.tokenVersion':actor.security.tokenVersion});
  if(device)await fenceBusinessRecord(Device,device,session,{userId:actor._id,sessionHash:device.sessionHash,revokedAt:null});
  if(!businessSame(owner._id,actor._id))await fenceBusinessRecord(User,owner,session,{status:'active',role:'seller',platformAccessManagedAt:null});
  await fenceBusinessRecord(StoreMember,member,session,{status:'active',role:member.role,acceptedAt:member.acceptedAt});
  await fenceBusinessRecord(Store,store,session,{status:'verified',ownerUserId:owner._id,country:store.country,currency:store.currency});
  await fenceBusinessRecord(CountrySetting,market,session,{active:true,currency:market.currency,timeZone:market.timeZone});
}

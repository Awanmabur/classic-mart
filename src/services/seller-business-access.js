import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { env } from '../config/env.js';
import { CountrySetting, Device, PlatformGrant, Store, StoreMember, User } from '../models/index.js';
import { businessSame, fenceBusinessRecord } from './business-access.js';
import { currentRequestDevice } from './country-admin-workspace-access.js';

export async function sellerBusinessAccess(request, { session = null, write = false } = {}) {
  const actor = request.user?._id && await User.findById(request.user._id).session(session);
  if (!actor || actor.status !== 'active' || !['seller','customer'].includes(actor.role) || actor.platformAccessManagedAt
    || actor.security.tokenVersion !== request.user.security?.tokenVersion
    || (request.session?.tokenVersion !== undefined && actor.security.tokenVersion !== request.session.tokenVersion)
    || await PlatformGrant.exists({ userId: actor._id }).session(session)) throw new AppError('A current Seller account is required.',403,'SELLER_BUSINESS_ACCOUNT_UNAVAILABLE');
  if (!env.auth.simpleLogin && (!actor.emailVerifiedAt || !actor.onboardingCompletedAt)) throw new AppError('Complete account verification first.',403,'ACCOUNT_UNAVAILABLE');
  if (!env.auth.simpleLogin && env.security.privilegedMfaRequired && !actor.security.mfaEnabled) throw new AppError('Authenticator enrollment is required for supplier operations.',403,'MFA_ENROLLMENT_REQUIRED');
  const device = await currentRequestDevice(request,{userId:actor._id,session});
  const selected = request.session?.activeStorePublicId || request.store?.publicId;
  const memberships = await StoreMember.find({ userId:actor._id,status:'active',acceptedAt:mongoose.trusted({$type:'date'}),role:mongoose.trusted({$in:['owner','admin','finance']}) }).session(session);
  const store = await Store.findOne({ ...(selected?{publicId:selected}:{}),_id:mongoose.trusted({$in:memberships.map(row=>row.storeId)}),status:mongoose.trusted({$in:write?['verified']:['verified','pending_verification']}) }).sort({createdAt:1,_id:1}).session(session);
  const member = store && memberships.find(row=>businessSame(row.storeId,store._id));
  if (!store || !member || (member.role==='owner')!==businessSame(store.ownerUserId,actor._id)) throw new AppError('Current Seller Finance permission for this store is required.',403,'SELLER_BUSINESS_FORBIDDEN');
  const market=await CountrySetting.findOne({code:store.country,currency:store.currency,active:true}).session(session);
  if(!market?.timeZone)throw new AppError('The supplier market is unavailable.',409,'SELLER_BUSINESS_MARKET_UNAVAILABLE');
  const context={request,actor,device,store,member,market};
  if(write)await fenceSellerBusinessAccess(context,session);
  return context;
}
export async function fenceSellerBusinessAccess(context,session){
  const {actor,device,member,store,market}=context;
  await fenceBusinessRecord(User,actor,session,{status:'active',role:actor.role,'security.tokenVersion':actor.security.tokenVersion});
  if(device)await fenceBusinessRecord(Device,device,session,{userId:actor._id,sessionHash:device.sessionHash,revokedAt:null});
  await fenceBusinessRecord(StoreMember,member,session,{status:'active',role:member.role,acceptedAt:member.acceptedAt});
  await fenceBusinessRecord(Store,store,session,{status:'verified',country:store.country,currency:store.currency});
  await fenceBusinessRecord(CountrySetting,market,session,{active:true,currency:market.currency,timeZone:market.timeZone});
}

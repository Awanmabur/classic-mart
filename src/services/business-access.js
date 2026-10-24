import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { env } from '../config/env.js';
import { BusinessMember, BusinessOrganization, CountrySetting, Device, PlatformGrant, User } from '../models/index.js';
import { currentRequestDevice } from './country-admin-workspace-access.js';

export const businessSame = (left, right) => String(left?._id ?? left ?? '') === String(right?._id ?? right ?? '');
export const businessCapabilities = Object.freeze({ owner: ['*'], admin: ['members','budgets','buy','quotes','po','templates'], buyer: ['buy','quotes','templates'], approver: ['quotes','po'], viewer: [] });
export function businessCapabilitiesFor(member) {
  const capabilities = [...(businessCapabilities[member?.role] || [])];
  if (member?.role !== 'owner' && member?.canApprove === true && Object.hasOwn(businessCapabilities, member?.role)) capabilities.push('approve');
  return capabilities;
}
const unavailable = () => new AppError('Your business account or session is unavailable.', 403, 'BUSINESS_ACCOUNT_UNAVAILABLE');
export function asBusinessRequest(value) {
  if (value?.user) return value;
  return { user: value, session: { tokenVersion: value?.security?.tokenVersion }, get: () => '', ip: '' };
}
export function requireBusinessCapability(context, capability) {
  const allowed = businessCapabilitiesFor(context.member);
  if (capability && !allowed.includes('*') && !allowed.includes(capability)) throw new AppError('Your business membership does not allow this action.', 403, 'BUSINESS_CAPABILITY_REQUIRED');
  return context;
}
export async function businessActor(value, { session = null } = {}) {
  const request = asBusinessRequest(value);
  if (!request.user?._id) throw new AppError('Sign in to your business account.', 401, 'UNAUTHENTICATED');
  const actor = await User.findById(request.user._id).session(session);
  if (!actor || actor.status !== 'active' || !['customer','business'].includes(actor.role) || actor.platformAccessManagedAt
    || actor.security?.tokenVersion !== request.user.security?.tokenVersion
    || (request.session?.tokenVersion !== undefined && actor.security.tokenVersion !== request.session.tokenVersion)) throw unavailable();
  if (await PlatformGrant.exists({ userId: actor._id }).session(session)) throw unavailable();
  if (!env.auth.simpleLogin && (!actor.emailVerifiedAt || !actor.onboardingCompletedAt)) throw unavailable();
  if (!env.auth.simpleLogin && env.security.privilegedMfaRequired && !actor.security?.mfaEnabled) throw new AppError('Set up an authenticator before using Business purchasing.', 403, 'MFA_ENROLLMENT_REQUIRED');
  const device = await currentRequestDevice(request, { userId: actor._id, session });
  return { request, actor, device };
}
export async function businessAccess(value, { session = null, capability, organizationPublicId, allowEmpty = false } = {}) {
  const context = await businessActor(value, { session });
  const { request, actor } = context;
  const members = await BusinessMember.find({ userId: actor._id, status: 'active', acceptedAt: mongoose.trusted({ $type: 'date' }) }).session(session);
  const orgs = await BusinessOrganization.find({ _id: mongoose.trusted({ $in: members.map(row => row.organizationId) }), status: 'active' }).sort({ createdAt: 1, _id: 1 }).session(session);
  const requested = organizationPublicId ?? request.session?.activeBusinessPublicId;
  if (requested !== undefined && (typeof requested !== 'string' || !/^[A-Za-z0-9_-]{4,100}$/.test(requested))) throw new AppError('Select a valid business.', 422, 'BUSINESS_ORGANIZATION_INVALID');
  const org = requested ? orgs.find(row => row.publicId === requested) : orgs.find(row => businessSame(row.ownerUserId, actor._id)) || orgs[0];
  if (!org) {
    if (allowEmpty && !requested && !members.length) return { ...context, org: null, member: null, market: null, organizations: [] };
    throw new AppError('An accepted membership in an active business is required.', 403, 'BUSINESS_MEMBERSHIP_REQUIRED');
  }
  const member = members.find(row => businessSame(row.organizationId, org._id));
  if (!member || (member.role === 'owner') !== businessSame(org.ownerUserId, actor._id)) throw new AppError('Business ownership and membership do not agree.', 403, 'BUSINESS_MEMBERSHIP_REQUIRED');
  const market = await CountrySetting.findOne({ code: org.country, active: true, currency: org.currency }).session(session);
  if (!market?.timeZone) throw new AppError('The business market is unavailable.', 409, 'BUSINESS_MARKET_UNAVAILABLE');
  return requireBusinessCapability({ ...context, org, member, market, organizations: orgs }, capability);
}
export async function fenceBusinessRecord(Model, row, session, conditions = {}) {
  if (!session?.inTransaction()) throw new AppError('Business changes require a transaction.', 500, 'BUSINESS_TRANSACTION_REQUIRED');
  const version = row.__v;
  const changed = await Model.updateOne({ _id: row._id, ...conditions, __v: version === undefined ? mongoose.trusted({ $exists: false }) : version }, { $inc: { __v: 1 } }, { session });
  if (changed.modifiedCount !== 1) throw new AppError('Business information changed. Reload before continuing.', 409, 'BUSINESS_VERSION_CONFLICT');
  row.__v = Number(version || 0) + 1;
  return row;
}
export async function fenceBusinessAccess(context, session, { organization = true } = {}) {
  const { actor, device, member, org, market } = context;
  await fenceBusinessRecord(User, actor, session, { status: 'active', role: actor.role, 'security.tokenVersion': actor.security.tokenVersion });
  if (device) await fenceBusinessRecord(Device, device, session, { userId: actor._id, sessionHash: device.sessionHash, revokedAt: null });
  if (member) await fenceBusinessRecord(BusinessMember, member, session, { status: 'active', role: member.role, acceptedAt: member.acceptedAt });
  if (org && organization) await fenceBusinessRecord(BusinessOrganization, org, session, { status: 'active', country: org.country, currency: org.currency });
  if (market) await fenceBusinessRecord(CountrySetting, market, session, { active: true, currency: market.currency, timeZone: market.timeZone });
}
export async function assertBusinessReadAccess(value, original) {
  const current = await businessAccess(value, { organizationPublicId: original.org.publicId });
  if (!businessSame(current.member, original.member) || current.member.role !== original.member.role
    || current.member.canApprove !== original.member.canApprove
    || current.actor.security.tokenVersion !== original.actor.security.tokenVersion
    || current.org.currency !== original.org.currency || current.org.country !== original.org.country
    || current.market.timeZone !== original.market.timeZone) throw new AppError('Business access changed during this request.', 403, 'BUSINESS_ACCESS_CHANGED');
  return current;
}
export async function businessTransaction(value, capability, operation, options = {}) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const context = await businessAccess(value, { ...options, capability, session });
      await fenceBusinessAccess(context, session);
      result = await operation(context, session);
    });
    return result;
  } catch (error) {
    if (error?.code === 11000 || error?.name === 'VersionError') throw new AppError('This business action was already submitted or changed. Reload before continuing.', 409, 'BUSINESS_VERSION_CONFLICT');
    throw error;
  } finally { await session.endSession(); }
}

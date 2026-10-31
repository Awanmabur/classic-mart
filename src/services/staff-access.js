import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { hashToken, hashValue, normalizeEmail, randomToken } from '../core/crypto.js';
import { encryptSensitive } from '../core/sensitive.js';
import { env } from '../config/env.js';
import { CountrySetting, PlatformStaffInvitation, User, Warehouse } from '../models/index.js';
import { addOutboxEvent } from './outbox.js';
import { createApproval, currentAdministrativeAuthority } from './stage9.js';
import { currentCustomerAccess } from './customer-access.js';
import { operationalCountriesFor } from './authorization.js';
import { cursorScope, cursorSort, pageResult } from './pagination.js';
import { writeAudit } from './audit.js';
import { strongMfaFence } from './mfa-policy.js';
import { hasCurrentStrongMfa, hasCurrentStrongSessionMfa } from './mfa-assurance.js';

const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
const inputSchema = z.object({
  email: z.string().trim().email().max(254), role: z.enum(['warehouse','support','moderator','finance','country_admin']),
  operationalCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(20),
  warehouseScopes: z.array(z.string().regex(/^[A-Za-z0-9_-]{4,120}$/)).max(100).default([]),
  grantDurationDays: z.coerce.number().int().min(1).max(365).default(180), reason: z.string().trim().min(3).max(1000),
});
const maskEmail = value => { const [local, domain] = normalizeEmail(value).split('@'); return `${local.slice(0,2)}${'*'.repeat(Math.max(1,Math.min(8,local.length-2)))}@${domain}`; };
async function transaction(work, supplied = null) {
  if (supplied) { if (!supplied.inTransaction()) throw new AppError('Staff changes require a transaction.',500,'STAFF_TRANSACTION_REQUIRED'); return work(supplied); }
  const session = await mongoose.startSession();
  try { return await session.withTransaction(() => work(session)); } finally { await session.endSession(); }
}
async function assignment(context, input, session) {
  const countries = [...new Set(input.operationalCountries)], warehouses = [...new Set(input.warehouseScopes || [])];
  if (context.actor.role === 'country_admin' && (['finance','country_admin'].includes(input.role) || countries.length !== 1 || !context.scopes.includes(countries[0]))) throw new AppError('The requested staff assignment is outside your authority.',403,'STAFF_ROLE_SCOPE');
  if (await CountrySetting.countDocuments({ code: { $in: countries }, active: true }).session(session) !== countries.length) throw new AppError('Choose active operational countries.',422,'STAFF_COUNTRY_INVALID');
  if ((input.role === 'warehouse' && !warehouses.length) || (input.role !== 'warehouse' && warehouses.length)) throw new AppError('Warehouse staff need explicit warehouses; other roles cannot receive warehouse scopes.',422,'STAFF_WAREHOUSE_SCOPE_ROLE');
  if (warehouses.length) {
    const rows = await Warehouse.find({ publicId: { $in: warehouses }, active: true }).select('publicId country').session(session).lean();
    if (rows.length !== warehouses.length || rows.some(row => !countries.includes(row.country))) throw new AppError('Warehouse scopes must belong to the selected countries.',422,'STAFF_WAREHOUSE_SCOPE_INVALID');
  }
  return { ...input, operationalCountries: countries, warehouseScopes: warehouses };
}

export async function createPlatformStaffInvitation(request, raw, { session: supplied = null } = {}) {
  const parsed = inputSchema.parse(raw);
  return transaction(async session => {
    const context = await currentAdministrativeAuthority(request.user, { country: request.user.role === 'country_admin' ? parsed.operationalCountries[0] : '', request, session });
    const input = await assignment(context, parsed, session), email = normalizeEmail(input.email), emailHash = hashValue(email), now = new Date();
    if (normalizeEmail(context.actor.email) === email) throw new AppError('Use an independent dedicated staff account.',409,'STAFF_DEDICATED_ACCOUNT_REQUIRED');
    const target = await User.findOne({ emailNormalized: email }).select('role').session(session).lean();
    if (target && ['seller','business','promoter','delivery','super_admin'].includes(target.role)) throw new AppError('Use a dedicated staff account.',409,'STAFF_DEDICATED_ACCOUNT_REQUIRED');
    await PlatformStaffInvitation.updateMany({ emailHash, status: 'pending', expiresAt: { $lte: now } }, { $set: { status: 'expired' }, $inc: { __v: 1 } }, { session });
    if (await PlatformStaffInvitation.exists({ emailHash, status: 'pending' }).session(session)) throw new AppError('An active staff invitation already exists for this email.',409,'STAFF_INVITE_EXISTS');
    const token = randomToken(32);
    const [invitation] = await PlatformStaffInvitation.create([{ publicId: publicId('sinv'), role:input.role,operationalCountries:input.operationalCountries,warehouseScopes:input.warehouseScopes,grantDurationDays:input.grantDurationDays,reason:input.reason,
      emailHash, emailEncrypted: encryptSensitive(email), emailMasked: maskEmail(email), status: 'pending', tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS), approvalCountry: context.actor.role === 'country_admin' ? input.operationalCountries[0] : '',
      invitedByUserId: context.actor._id, inviterGrantPublicId: context.grant?.publicId || '', inviterTokenVersion: context.actor.security.tokenVersion }], { session });
    const link = `${String(env.baseUrl).replace(/\/$/,'')}/staff/invitations/${encodeURIComponent(token)}`;
    await addOutboxEvent({ type: 'platform.staff_invitation', aggregateType: 'platform_staff_invitation', aggregatePublicId: invitation.publicId,
      payload: { email, subject: 'Classic Mart staff invitation', body: `You have been invited as ${input.role.replaceAll('_',' ')} for ${input.operationalCountries.join(', ')}. Sign in with this dedicated email, verify email and phone, enroll MFA, and open ${link} within 72 hours. Acceptance does not activate access; another administrator must approve it.` } }, session);
    await writeAudit(request,'admin.staff_invited',{actor:context.actor,session,targetType:'platform_staff_invitation',targetPublicId:invitation.publicId,country:invitation.approvalCountry,metadata:{role:input.role,countries:input.operationalCountries}});
    return invitation;
  }, supplied);
}

async function ownedInvitation(request, token, session) {
  const actor = await currentCustomerAccess(request,{ session, write: Boolean(session) });
  const invitation = await PlatformStaffInvitation.findOne({ tokenHash: hashToken(token), status:'pending' }).select('+tokenHash +emailHash').session(session);
  if (!invitation) throw new AppError('Staff invitation is invalid or no longer active.',404,'STAFF_INVITE_NOT_FOUND');
  if (invitation.expiresAt <= new Date()) throw new AppError('Staff invitation expired. Ask for a new invitation.',410,'STAFF_INVITE_EXPIRED');
  if (hashValue(normalizeEmail(actor.email)) !== invitation.emailHash) throw new AppError(`This invitation belongs to ${invitation.emailMasked}. Sign in with that dedicated account.`,403,'STAFF_INVITE_EMAIL_MISMATCH');
  return { actor, invitation };
}
export async function platformStaffInvitationPreview(request, token) {
  const { actor, invitation } = await ownedInvitation(request, token, null);
  const strongMfa = await hasCurrentStrongMfa(actor);
  return { id:invitation.publicId,emailMasked:invitation.emailMasked,role:invitation.role,operationalCountries:invitation.operationalCountries,warehouseScopes:invitation.warehouseScopes||[],grantDurationDays:invitation.grantDurationDays,expiresAt:invitation.expiresAt,
    ready:Boolean(actor.emailVerifiedAt&&actor.phoneVerifiedAt&&strongMfa),emailVerified:Boolean(actor.emailVerifiedAt),phoneVerified:Boolean(actor.phoneVerifiedAt),mfaEnabled:strongMfa };
}
export async function acceptPlatformStaffInvitation(request, token) {
  return transaction(async session => {
    const { actor, invitation } = await ownedInvitation(request, token, session);
    if (!actor.emailVerifiedAt || !actor.phoneVerifiedAt || !actor.onboardingCompletedAt) throw new AppError('Complete verified staff identity first.',409,'STAFF_VERIFICATION_REQUIRED');
    if (!await hasCurrentStrongSessionMfa(request, actor, { session })) throw new AppError('Enroll and verify a passkey or authenticator before accepting privileged staff access.',409,'STAFF_MFA_REQUIRED');
    const factorFence = await User.updateOne({ _id: actor._id, status: 'active', 'security.tokenVersion': actor.security.tokenVersion,
      $and: [strongMfaFence()] }, { $inc: { __v: 1 } }, { session });
    if (factorFence.modifiedCount !== 1) throw new AppError('Your staff MFA changed. Reload before continuing.',409,'STAFF_MFA_REQUIRED');
    if (['seller','business','promoter','delivery','super_admin'].includes(actor.role)) throw new AppError('Use a dedicated staff account.',409,'STAFF_DEDICATED_ACCOUNT_REQUIRED');
    const inviter = await User.findById(invitation.invitedByUserId).select('+operationalCountries').session(session);
    if (!inviter || String(inviter._id) === String(actor._id)) throw new AppError('The inviting administrator is unavailable.',403,'STAFF_INVITER_INACTIVE');
    const authority = await currentAdministrativeAuthority(inviter,{country:invitation.approvalCountry,session});
    if (invitation.inviterTokenVersion !== undefined && invitation.inviterTokenVersion !== authority.actor.security.tokenVersion
      || invitation.inviterGrantPublicId && invitation.inviterGrantPublicId !== authority.grant?.publicId) throw new AppError('The inviting administrator authorization changed. Ask for a new invitation.',409,'STAFF_INVITER_INACTIVE');
    await assignment(authority, invitation, session);
    const acceptedAccount = await User.findById(actor._id).select('__v security.tokenVersion').session(session);
    const approval = await createApproval({user:authority.actor,type:'platform_staff_access',country:invitation.approvalCountry,targetType:'user',targetPublicId:actor.publicId,
      payload:{action:'grant',role:invitation.role,operationalCountries:invitation.operationalCountries,warehouseScopes:invitation.warehouseScopes,grantDurationDays:invitation.grantDurationDays,invitationPublicId:invitation.publicId,acceptedByUserId:String(actor._id),sourceVersion:acceptedAccount.__v||0,targetTokenVersion:acceptedAccount.security.tokenVersion},reason:`Accepted staff invitation ${invitation.publicId}: ${invitation.reason}`},{session});
    invitation.status='accepted';invitation.acceptedByUserId=actor._id;invitation.acceptedAt=new Date();invitation.approvalRequestId=approval._id;invitation.approvalRequestPublicId=approval.publicId;invitation.tokenHash='accepted';
    await invitation.save({session});
    await writeAudit(request,'staff.invitation_accepted',{actor,session,targetType:'platform_staff_invitation',targetPublicId:invitation.publicId,country:invitation.approvalCountry,metadata:{approvalPublicId:approval.publicId}});
    return {invitation,approval};
  });
}
export async function revokePlatformStaffInvitation(request, id, input = {}) {
  return transaction(async session => {
    const invitation = await PlatformStaffInvitation.findOne({publicId:id,status:'pending'}).session(session);
    if (!invitation) throw new AppError('Pending staff invitation not found.',404,'STAFF_INVITE_NOT_FOUND');
    if (input.version !== undefined && (!/^\d+$/.test(String(input.version)) || Number(input.version) !== Number(invitation.__v || 0))) throw new AppError('The invitation changed. Reload before continuing.',409,'STAFF_INVITE_CHANGED');
    const context = await currentAdministrativeAuthority(request.user,{country:invitation.approvalCountry,request,session});
    invitation.status='revoked';invitation.revokedByUserId=context.actor._id;invitation.revokedAt=new Date();await invitation.save({session});
    await writeAudit(request,'admin.staff_invitation_revoked',{actor:context.actor,session,targetType:'platform_staff_invitation',targetPublicId:id,country:invitation.approvalCountry});
    return invitation;
  });
}
export async function staffInvitationsForAdmin(user,{cursor='',limit=50}={}) {
  const scopes=operationalCountriesFor(user),base=user.role==='super_admin'?{}:{approvalCountry:{$in:scopes}},size=Math.max(1,Math.min(100,Number(limit)||50));
  const [rows,total]=await Promise.all([PlatformStaffInvitation.find(cursorScope(base,cursor)).select('-emailEncrypted -emailHash -tokenHash').sort(cursorSort()).limit(size+1).lean(),PlatformStaffInvitation.countDocuments(base)]);
  return pageResult(rows,{limit:size,total});
}

import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { normalizeEmail, hashValue } from '../core/crypto.js';
import { encryptSensitive, decryptSensitive } from '../core/sensitive.js';
import { env } from '../config/env.js';
import { addOutboxEvent } from './outbox.js';
import { Store, StoreMember, User, Notification, CountrySetting, PlatformGrant } from '../models/index.js';
import { StoreTeamInvitation } from '../models/StoreTeamInvitation.js';
import { sellerOperationsAccess, sellerOperationsActor, sellerTransaction, sellerVersion, sellerCapabilityLanding, sameSellerId, sellerConflict } from './seller-operations-access.js';
import { assertSellerCapacity, sellerEntitlements } from './seller-entitlements.js';
import { writeAudit } from './audit.js';
import { cursorScope, cursorSort, pageResult } from './pagination.js';
const roles = ['admin', 'catalogue', 'fulfilment', 'finance', 'support'];
const version = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const mask = email => { const [name, domain] = email.split('@'); return `${name.slice(0, 1)}***@${domain}`; };
const dto = row => ({ publicId: row.publicId, role: row.role, status: row.status === 'pending' && row.expiresAt <= new Date() ? 'expired' : row.status, emailMasked: row.emailMasked, storePublicId: row.storePublicId, expiresAt: row.expiresAt, createdAt: row.createdAt, version: Number(row.__v || 0) });
const audit = (request, action, context, target, session, metadata = {}) => writeAudit(request, action, { actor: context.actor, targetType: 'store_team', targetPublicId: target.publicId, country: context.store.country, session, metadata: { storePublicId: context.store.publicId, ...metadata } });
function canManage(actorRole, targetRole) { return actorRole === 'owner' || actorRole === 'admin' && targetRole !== 'admin' && targetRole !== 'owner'; }

export async function inviteStoreTeamMember(request, raw) {
  const input = z.object({ email: z.string().trim().email().max(254), role: z.enum(roles) }).parse(raw);
  return sellerTransaction(async session => {
    const context = await sellerOperationsAccess(request, 'staff', { session, write: true });
    if (!canManage(context.member.role, input.role)) throw new AppError('Only the store owner can appoint an administrator.', 403, 'STORE_OWNER_REQUIRED');
    const email = normalizeEmail(input.email), emailHash = hashValue(email);
    if (email === normalizeEmail(context.actor.email)) throw new AppError('You already belong to this store.', 409, 'STORE_MEMBER_EXISTS');
    await StoreTeamInvitation.updateMany({ storeId: context.store._id, emailHash, status: 'pending', expiresAt: { $lte: new Date() } }, { $set: { status: 'expired' }, $inc: { __v: 1 } }, { session });
    const recipient = await User.findOne({ emailNormalized: email }).select('role status emailVerifiedAt platformAccessManagedAt').session(session);
    if (recipient && (!['seller', 'customer'].includes(recipient.role) || recipient.status !== 'active' || recipient.platformAccessManagedAt)) throw new AppError('This recipient cannot join a store team.', 409, 'STORE_RECIPIENT_UNAVAILABLE');
    if (recipient && await StoreMember.exists({ storeId: context.store._id, userId: recipient._id, status: 'active' }).session(session)) throw new AppError('This person already belongs to the store.', 409, 'STORE_MEMBER_EXISTS');
    if (await StoreTeamInvitation.exists({ storeId: context.store._id, emailHash, status: 'pending' }).session(session)) throw new AppError('An invitation is already awaiting a response.', 409, 'STORE_INVITATION_PENDING');
    await assertSellerCapacity(context.store, 'seats', { session });
    const [invitation] = await StoreTeamInvitation.create([{ publicId: publicId('sti'), storeId: context.store._id, storePublicId: context.store.publicId, country: context.store.country, currency: context.store.currency, emailHash, emailEncrypted: encryptSensitive(email), emailMasked: mask(email), role: input.role, invitedByUserId: context.actor._id, invitedByTokenVersion: context.actor.security.tokenVersion, invitedByMembershipId: context.member._id, invitedByRole: context.member.role, invitedByPermissionVersion: context.member.permissionVersion || 0, expiresAt: new Date(Date.now() + 7 * 86400000) }], { session });
    if (recipient) await Notification.create([{ publicId: publicId('ntf'), userId: recipient._id, country: context.store.country, type: 'store_team_invitation', title: 'Store team invitation', body: `${context.store.name} invited you to join as ${input.role}. Review and accept the invitation to grant access.`, href: '/account/store-invitations', expiresAt: invitation.expiresAt }], { session });
    await addOutboxEvent({ type: 'seller.team_invitation', aggregateType: 'store_team_invitation', aggregatePublicId: invitation.publicId, payload: { country: context.store.country } }, session);
    await audit(request, 'seller.team_invited', context, invitation, session, { role: input.role });
    return dto(invitation);
  });
}

export async function decideStoreTeamInvitation(request, id, raw) {
  const input = z.object({ decision: z.enum(['accept', 'reject']), version }).parse(raw);
  return sellerTransaction(async session => {
    const actor = await sellerOperationsActor(request, { session, write: true, requireMfa: input.decision === 'accept' });
    if (!actor.emailVerifiedAt) throw new AppError('Verify the invited email address before responding.', 403, 'STORE_RECIPIENT_UNVERIFIED');
    const invitation = await StoreTeamInvitation.findOne({ publicId: id, emailHash: hashValue(normalizeEmail(actor.email)) }).session(session);
    if (!invitation) throw new AppError('Invitation not found.', 404, 'STORE_INVITATION_NOT_FOUND');
    sellerVersion(invitation, input.version);
    if (invitation.status !== 'pending' || invitation.expiresAt <= new Date()) throw new AppError('This invitation is no longer available.', 409, 'STORE_INVITATION_EXPIRED');
    if (input.decision === 'reject') {
      invitation.status = 'rejected'; invitation.recipientUserId = actor._id; invitation.respondedAt = new Date(); await invitation.save({ session });
      await audit(request, 'seller.team_invitation_rejected', { actor, store: { publicId: invitation.storePublicId, country: invitation.country } }, invitation, session);
      return { ...dto(invitation), landing: '/account/store-invitations' };
    }
    const store = await Store.findOne({ _id: invitation.storeId, publicId: invitation.storePublicId, country: invitation.country, currency: invitation.currency, status: { $in: ['pending_verification', 'verified'] } }).session(session);
    const inviter = invitation.invitedByMembershipId && await StoreMember.findOne({ _id: invitation.invitedByMembershipId, storeId: invitation.storeId, userId: invitation.invitedByUserId, role: invitation.invitedByRole, permissionVersion: invitation.invitedByPermissionVersion, status: 'active' }).session(session);
    const inviterUser = await User.findOne({ _id: invitation.invitedByUserId, status: 'active', role: { $in: ['seller', 'customer'] }, platformAccessManagedAt: null,
      'security.tokenVersion': invitation.invitedByTokenVersion }).session(session);
    const owner = store && await User.findOne({ _id: store.ownerUserId, status: 'active', role: 'seller', platformAccessManagedAt: null }).session(session);
    const market = store && await CountrySetting.findOne({ code: store.country, currency: store.currency, active: true }).session(session);
    if (!store || !inviter || !inviterUser || !owner || !market || !canManage(inviter.role, invitation.role)
      || inviter.role !== 'owner' && !(inviter.acceptedAt instanceof Date)
      || inviter.role === 'owner' && !sameSellerId(store.ownerUserId, inviter.userId)
      || sameSellerId(store.ownerUserId, inviter.userId) && inviter.role !== 'owner'
      || !env.auth.simpleLogin && (!inviterUser.emailVerifiedAt || !inviterUser.onboardingCompletedAt || env.security.privilegedMfaRequired && !inviterUser.security.mfaEnabled)
      || await PlatformGrant.exists({ userId: { $in: [inviterUser._id, owner._id] } }).session(session)) throw new AppError('The store or inviting authority is no longer available.', 409, 'STORE_INVITATION_UNAVAILABLE');
    if (sameSellerId(inviterUser._id, actor._id)) throw new AppError('You cannot accept your own invitation.', 409, 'STORE_MEMBER_EXISTS');
    for (const record of new Map([inviterUser, owner].map(row => [String(row._id), row])).values()) {
      const result = await User.updateOne({ _id: record._id, status: 'active', role: record.role, __v: record.__v || 0,
        'security.tokenVersion': record.security.tokenVersion }, { $inc: { __v: 1 } }, { session });
      if (result.modifiedCount !== 1) throw sellerConflict();
    }
    const marketFence = await CountrySetting.updateOne({ _id: market._id, __v: market.__v || 0, active: true }, { $inc: { __v: 1 } }, { session });
    if (marketFence.modifiedCount !== 1) throw sellerConflict();
    const fenced = await StoreMember.updateOne({ _id: inviter._id, status: 'active', role: inviter.role, __v: inviter.__v || 0 }, { $inc: { __v: 1 } }, { session });
    if (fenced.modifiedCount !== 1) throw sellerConflict();
    if (input.decision === 'accept') {
      if (sameSellerId(store.ownerUserId, actor._id)) throw new AppError('The store owner cannot accept a staff invitation.', 409, 'STORE_OWNER_PROTECTED');
      const existing = await StoreMember.findOne({ storeId: store._id, userId: actor._id }).session(session);
      if (existing?.status === 'active' || existing?.role === 'owner') throw new AppError('You already belong to this store.', 409, 'STORE_MEMBER_EXISTS');
      // The pending invitation reserved the seat. Excluding it converts the same seat atomically.
      await assertSellerCapacity(store, 'seats', { session, excludeId: invitation._id });
      if (existing) { existing.role = invitation.role; existing.status = 'active'; existing.permissionVersion = (existing.permissionVersion || 0) + 1; existing.invitationId = invitation._id; existing.invitedByUserId = invitation.invitedByUserId; existing.acceptedAt = new Date(); existing.revokedAt = undefined; await existing.save({ session }); }
      else await StoreMember.create([{ publicId: publicId('stm'), storeId: store._id, userId: actor._id, role: invitation.role, status: 'active', invitedByUserId: invitation.invitedByUserId, invitationId: invitation._id, acceptedAt: new Date() }], { session });
    }
    invitation.status = input.decision === 'accept' ? 'accepted' : 'rejected'; invitation.recipientUserId = actor._id; invitation.respondedAt = new Date(); await invitation.save({ session });
    await audit(request, `seller.team_invitation_${invitation.status}`, { actor, store }, invitation, session, { role: invitation.role });
    return { ...dto(invitation), landing: input.decision === 'accept' ? sellerCapabilityLanding(invitation.role) : '/account/store-invitations' };
  });
}

export async function updateStoreTeamMember(request, id, raw) {
  const input = z.object({ action: z.enum(['role', 'revoke']), role: z.enum(roles).optional(), version }).parse(raw);
  return sellerTransaction(async session => {
    const context = await sellerOperationsAccess(request, 'staff', { session, write: true });
    const member = await StoreMember.findOne({ publicId: id, storeId: context.store._id }).session(session);
    if (!member) throw new AppError('Store member not found.', 404, 'STORE_MEMBER_NOT_FOUND');
    sellerVersion(member, input.version);
    if (member.role === 'owner' || sameSellerId(member.userId, context.store.ownerUserId) || sameSellerId(member.userId, context.actor._id) || !canManage(context.member.role, member.role) || input.action === 'role' && (!input.role || !canManage(context.member.role, input.role))) throw new AppError('Only the owner can manage administrators. The owner and your own access are protected.', 403, 'STORE_OWNER_PROTECTED');
    if (member.status !== 'active') throw new AppError('This store membership is inactive.', 409, 'STORE_MEMBER_INACTIVE');
    if (input.action === 'role') member.role = input.role;
    else { member.status = 'revoked'; member.revokedAt = new Date(); }
    member.permissionVersion = (member.permissionVersion || 0) + 1;
    member.lastChangedByUserId = context.actor._id; await member.save({ session });
    // A previous invitation cannot regain authority if this member later regains a role.
    await StoreTeamInvitation.updateMany({ storeId: context.store._id, invitedByMembershipId: member._id, status: 'pending' }, { $set: { status: 'revoked', revokedAt: new Date(), revokedByUserId: context.actor._id }, $inc: { __v: 1 } }, { session });
    await audit(request, `seller.team_${input.action}`, context, member, session, { role: member.role });
    return { publicId: member.publicId, role: member.role, status: member.status };
  });
}

export async function revokeStoreTeamInvitation(request, id, raw) {
  const input = z.object({ version }).parse(raw);
  return sellerTransaction(async session => {
    const context = await sellerOperationsAccess(request, 'staff', { session, write: true });
    const invitation = await StoreTeamInvitation.findOne({ publicId: id, storeId: context.store._id }).session(session);
    if (!invitation) throw new AppError('Invitation not found.', 404, 'STORE_INVITATION_NOT_FOUND');
    sellerVersion(invitation, input.version);
    if (invitation.status !== 'pending' || !canManage(context.member.role, invitation.role)) throw new AppError('You cannot revoke this invitation.', 409, 'STORE_INVITATION_UNAVAILABLE');
    invitation.status = 'revoked'; invitation.revokedAt = new Date(); invitation.revokedByUserId = context.actor._id; await invitation.save({ session });
    await audit(request, 'seller.team_invitation_revoked', context, invitation, session); return dto(invitation);
  });
}

async function page(Model, scope, after) {
  const [rows, total] = await Promise.all([Model.find(cursorScope(scope, typeof after === 'string' ? after : '')).sort(cursorSort()).limit(26).lean(), Model.countDocuments(scope)]);
  return pageResult(rows, { limit: 25, total });
}
export async function storeInvitationInbox(request) {
  const actor = await sellerOperationsActor(request, { requireMfa: false });
  if (!actor.emailVerifiedAt) throw new AppError('Verify your email before viewing store invitations.', 403, 'STORE_RECIPIENT_UNVERIFIED');
  const result = await page(StoreTeamInvitation, { emailHash: hashValue(normalizeEmail(actor.email)) }, request.query?.after);
  const stores = await Store.find({ _id: { $in: result.items.map(row => row.storeId) } }).select('publicId name').lean();
  return { requiresMfa: !env.auth.simpleLogin && env.security.privilegedMfaRequired && !actor.security.mfaEnabled,
    invitations: result.items.map(row => ({ ...dto(row), storeName: stores.find(store => sameSellerId(store._id, row.storeId))?.name || row.storePublicId })), page: result.page };
}
export async function sellerTeamPage(request) {
  const context = await sellerOperationsAccess(request, 'staff');
  const [members, invitations, entitlements] = await Promise.all([page(StoreMember, { storeId: context.store._id }, request.query?.after), page(StoreTeamInvitation, { storeId: context.store._id }, request.query?.invitationsAfter), sellerEntitlements(context.store)]);
  const users = await User.find({ _id: { $in: members.items.map(row => row.userId) } }).select('publicId name status').lean();
  const rows = members.items.map(row => ({ publicId: row.publicId, name: users.find(user => sameSellerId(user._id, row.userId))?.name || 'Store member', role: row.role, status: row.status, version: Number(row.__v || 0), canManage: row.status === 'active' && !sameSellerId(row.userId, context.actor._id) && canManage(context.member.role, row.role) }));
  return { kind: 'team', domain: 'team', baseHref: '/seller/team', members: rows, invitations: invitations.items.map(dto), invitationsPage: invitations.page, page: members.page, entitlements, roleOptions: roles.filter(role => canManage(context.member.role, role)),
    columns: ['Member', 'Role', 'Status'], rows: rows.map(row => ({ id: row.publicId, cells: [row.name, row.role, row.status], href: row.canManage ? `#member-${row.publicId}` : '' })),
    metrics: [{ label: 'Team seats', value: entitlements.seatLimit }, { label: 'Members', value: members.page.total }, { label: 'Invitations', value: invitations.page.total }, { label: 'Your role', value: context.member.role }],
    insights: ['Each recipient must verify their own email and explicitly accept before access is granted.', 'Owners remain protected. Store permissions never change the account role.'], health: { label: 'Access controls', rows: [{ label: 'Current workspace', value: context.store.name }] }, workflow: [{ title: 'Invite', text: 'Choose the least privilege needed.' }, { title: 'Accept', text: 'The verified recipient accepts the invitation.' }, { title: 'Review', text: 'Revoke access promptly when duties change.' }] };
}
export async function selectSellerWorkspace(request, raw) {
  const input = z.object({ storePublicId: z.string().trim().min(4).max(100) }).parse(raw);
  const result = await sellerTransaction(async session => {
    const context = await sellerOperationsAccess(request, null, { session, write: true, allowSuspended: true, storePublicId: input.storePublicId });
    await audit(request, 'seller.workspace_selected', context, context.store, session);
    return { storePublicId: context.store.publicId, landing: context.store.status === 'suspended' ? '/seller/trust-cases' : sellerCapabilityLanding(context.member.role) };
  });
  if (request.session) request.session.activeStorePublicId = result.storePublicId;
  return result;
}

/** Delivery resolves encrypted recipient data only after checking current inviting authority. */
export async function prepareStoreTeamInvitationDelivery(event) {
  const invitation = await StoreTeamInvitation.findOne({ publicId: event.aggregatePublicId, status: 'pending', country: event.payload?.country, expiresAt: { $gt: new Date() } }).select('+emailEncrypted').lean();
  if (!invitation) return null;
  const store = await Store.findOne({ _id: invitation.storeId, publicId: invitation.storePublicId, country: invitation.country, currency: invitation.currency, status: { $in: ['pending_verification', 'verified'] } }).select('name').lean();
  const inviter = invitation.invitedByMembershipId && await StoreMember.findOne({ _id: invitation.invitedByMembershipId, storeId: invitation.storeId, userId: invitation.invitedByUserId, role: invitation.invitedByRole, permissionVersion: invitation.invitedByPermissionVersion, status: 'active' }).select('role acceptedAt userId').lean();
  const actor = await User.findOne({ _id: invitation.invitedByUserId, status: 'active', role: { $in: ['seller', 'customer'] }, platformAccessManagedAt: null,
    'security.tokenVersion': invitation.invitedByTokenVersion }).select('_id emailVerifiedAt onboardingCompletedAt security.mfaEnabled').lean();
  const owner = store && await Store.findById(invitation.storeId).select('ownerUserId').lean();
  if (!store || !inviter || !actor || !owner || !canManage(inviter.role, invitation.role)
    || inviter.role !== 'owner' && !(inviter.acceptedAt instanceof Date)
    || inviter.role === 'owner' && !sameSellerId(inviter.userId, owner.ownerUserId)
    || !env.auth.simpleLogin && (!actor.emailVerifiedAt || !actor.onboardingCompletedAt || env.security.privilegedMfaRequired && !actor.security.mfaEnabled)
    || !await User.exists({ _id: owner.ownerUserId, role: 'seller', status: 'active', platformAccessManagedAt: null })
    || await PlatformGrant.exists({ userId: { $in: [actor._id, owner.ownerUserId] } })
    || !await CountrySetting.exists({ code: invitation.country, currency: invitation.currency, active: true })) return null;
  return { email: decryptSensitive(invitation.emailEncrypted), subject: 'Classic Mart store team invitation', text: `${store.name} invited you to join its store team as ${invitation.role}. Create or sign in to a Classic Mart account using this email, verify it, complete your profile and authenticator setup, then review the invitation at ${String(env.baseUrl).replace(/\/$/, '')}/account/store-invitations. Accepting gives only this store's permissions and never changes your account type. The invitation expires in seven days. If you do not recognise this store, decline the invitation.` };
}

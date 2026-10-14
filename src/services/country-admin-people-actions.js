import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { env } from '../config/env.js';
import { BusinessMember, BusinessOrganization, CountrySetting, Device, MobileSession, Notification, Order,
  PlatformGrant, PlatformStaffInvitation, PromoterVerification, Store, StoreMember, SupportTicket, User } from '../models/index.js';
import { writeAudit } from './audit.js';
import { countryAdminAccess, fenceCountryAdminAccess } from './country-admin-workspace-access.js';
import { currentRequestDevice } from './moderation-workspace-access.js';
import { queueCountryAdminAlert } from './country-admin-notifications.js';

const idSchema = z.string().trim().regex(/^[a-z][a-z0-9_-]{4,99}$/, 'Choose a valid record.');
const versionSchema = z.union([z.number(), z.string().regex(/^\d+$/, 'Provide the record version.')])
  .pipe(z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER));
const decisionSchema = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().min(10).max(500) });
const same = (a, b) => String(a || '') === String(b || '');
const reviewable = new Set(['submitted', 'appealed']);
const trusted = value => mongoose.trusted(value);
const conflict = () => new AppError('This record changed. Reload before continuing.', 409, 'COUNTRY_ADMIN_PEOPLE_VERSION_CONFLICT');
const unavailable = type => new AppError(`${type === 'promoter' ? 'Promoter verification' : 'Customer'} not found in this country.`, 404, 'COUNTRY_ADMIN_PEOPLE_NOT_FOUND');
const maskedEmail = value => { const [local, domain] = String(value || '').split('@'); return domain ? `${local.slice(0, 1)}***@${domain}` : ''; };
const maskedPhone = value => value ? `••••${String(value).slice(-4)}` : '';

async function transaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await work(session); });
    return result;
  } catch (error) {
    if (error.name === 'VersionError') throw conflict();
    throw error;
  } finally { await session.endSession(); }
}

function assertVersion(row, version) { if (Number(row.__v || 0) !== version) throw conflict(); }

/** Marketplace records never grant Country Admin authority over a platform or merchant identity. */
export async function countryAdminPersonalAccountEligible(user, role, session = null) {
  if (!user || user.role !== role || user.platformAccessManagedAt || !['active', 'suspended'].includes(user.status)) return false;
  // Keep session operations sequential: MongoDB transactions cannot run concurrent queries.
  if (await PlatformGrant.exists({ userId: user._id }).session(session)) return false;
  if (await PlatformStaffInvitation.exists({ acceptedByUserId: user._id }).session(session)) return false;
  if (await StoreMember.exists({ userId: user._id, status: trusted({ $in: ['active', 'invited'] }) }).session(session)) return false;
  if (await Store.exists({ ownerUserId: user._id }).session(session)) return false;
  if (await BusinessMember.exists({ userId: user._id, status: trusted({ $in: ['active', 'invited'] }) }).session(session)) return false;
  if (await BusinessOrganization.exists({ ownerUserId: user._id }).session(session)) return false;
  return true;
}

async function sourcePromoter(request, id, session = null, { workspace = true } = {}) {
  const initial = await countryAdminAccess(request, { session, workspace });
  const row = await PromoterVerification.findOne({ publicId: id, ...initial.countryScope }).session(session);
  if (!row) throw unavailable('promoter');
  if (request.query?.country && request.query.country !== row.country) throw unavailable('promoter');
  const access = await countryAdminAccess(request, { session, workspace, country: row.country });
  const owner = await User.findById(row.userId).session(session);
  if (!await countryAdminPersonalAccountEligible(owner, 'promoter', session)) throw unavailable('promoter');
  return { row, owner, access };
}

async function sourceCustomer(request, id, session = null) {
  const initial = await countryAdminAccess(request, { session });
  const row = await User.findOne({ publicId: id, role: 'customer', ...initial.countryScope }).session(session);
  if (!row || !await countryAdminPersonalAccountEligible(row, 'customer', session)) throw unavailable('customer');
  if (request.query?.country && request.query.country !== row.country) throw unavailable('customer');
  const access = await countryAdminAccess(request, { session, country: row.country });
  return { row, access };
}

function independentPromoter(actor, row) {
  if (same(actor._id, row.userId)) throw new AppError('An independent administrator must review this promoter.', 403, 'COUNTRY_ADMIN_PEOPLE_SELF_ACTION');
  if (row.status === 'appealed' && (!row.appeal?.submittedAt || !row.appeal?.message || !row.appeal?.originalReviewerUserId)) {
    throw new AppError('This appeal has no current owner submission.', 409, 'COUNTRY_ADMIN_PROMOTER_APPEAL_INVALID');
  }
  if (row.status === 'appealed' && same(actor._id, row.appeal.originalReviewerUserId)) {
    throw new AppError('A different administrator must review this appeal.', 403, 'COUNTRY_ADMIN_PROMOTER_APPEAL_INDEPENDENCE');
  }
}

async function fencePersonalAccount(user, session, extra = {}) {
  const result = await User.updateOne({ _id: user._id, role: user.role, status: user.status, country: user.country,
    platformAccessManagedAt: trusted({ $exists: false }), __v: user.__v || 0,
    'security.tokenVersion': user.security.tokenVersion, ...extra }, { $inc: { __v: 1 } }, { session });
  if (result.modifiedCount !== 1) throw conflict();
  user.__v = (user.__v || 0) + 1;
}

async function recheckRead(request, previous, country) {
  const current = await countryAdminAccess(request, { country });
  if (!same(current.grant?._id, previous.grant?._id) || current.actor.security.tokenVersion !== previous.actor.security.tokenVersion
    || current.currency !== previous.currency || current.timeZone !== previous.timeZone) {
    throw new AppError('Country Admin access changed. Reload before continuing.', 403, 'COUNTRY_ADMIN_ACCESS_CHANGED');
  }
}

async function historyDTO(row) {
  const history = (row.reviewHistory || []).slice(-50);
  const users = await User.find({ _id: trusted({ $in: history.map(entry => entry.actorUserId) }) }).select('publicId name').lean();
  const byId = new Map(users.map(user => [String(user._id), user]));
  return history.map(entry => ({ action: entry.action, reason: entry.reason, at: entry.at,
    actor: byId.get(String(entry.actorUserId)) ? { publicId: byId.get(String(entry.actorUserId)).publicId, name: byId.get(String(entry.actorUserId)).name } : { name: 'Previous reviewer' } }));
}

export async function loadCountryAdminPromoterDetail(request, id = request.params?.publicId) {
  const { row, owner, access } = await sourcePromoter(request, idSchema.parse(id));
  const history = await historyDTO(row);
  const assignment = row.assignedUserId ? same(row.assignedUserId, access.actor._id) ? 'mine' : 'other' : 'unassigned';
  const independent = !same(owner._id, access.actor._id) && !(row.status === 'appealed' && same(row.appeal?.originalReviewerUserId, access.actor._id));
  const genuineAppeal = row.status !== 'appealed' || Boolean(row.appeal?.submittedAt && row.appeal?.message && row.appeal?.originalReviewerUserId);
  const result = { type: 'promoter', record: { publicId: row.publicId, userPublicId: owner.publicId, name: owner.roleProfile?.publicName || owner.name,
    country: row.country, status: row.status, version: row.__v || 0, __v: row.__v || 0, accountStatus: owner.status,
    emailMasked: maskedEmail(owner.email), phoneMasked: maskedPhone(owner.phone), emailVerified: Boolean(owner.emailVerifiedAt), phoneVerified: Boolean(owner.phoneVerifiedAt),
    channels: [...row.channels], niches: [...row.niches], audienceSize: row.audienceSize, audienceLocation: row.audienceLocation,
    disclosureAcceptedAt: row.disclosureAcceptedAt, submittedAt: row.submittedAt, reviewedAt: row.reviewedAt, reason: row.reason,
    documents: [], evidenceSource: 'Current account verification, submitted channels, content categories, audience and accepted disclosure.',
    appeal: row.appeal?.submittedAt ? { message: row.appeal.message, submittedAt: row.appeal.submittedAt } : null, reviewHistory: history },
    assignment, actionable: independent && genuineAppeal && owner.status === 'active' && reviewable.has(row.status),
    independenceReason: !independent ? 'A different independent administrator must review this appeal.' : '', error: '', draft: {} };
  await recheckRead(request, access, row.country);
  return result;
}

async function mutatePromoter(request, action, { id, input, legacy = false } = {}) {
  if (!['claim', 'release', 'decision'].includes(action)) throw new AppError('Choose a supported promoter action.', 422, 'COUNTRY_ADMIN_PEOPLE_ACTION_INVALID');
  const parsedId = idSchema.parse(id || request.params?.publicId);
  const body = input || request.body || {};
  const version = legacy && body.version === undefined ? null : versionSchema.parse(body.version);
  const decision = action === 'decision' ? (legacy
    ? z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(500).default('') }).parse(body)
    : decisionSchema.parse(body)) : null;
  return transaction(async session => {
    const { row, owner, access } = await sourcePromoter(request, parsedId, session, { workspace: !legacy });
    assertVersion(row, version === null ? Number(row.__v || 0) : version);
    if (!reviewable.has(row.status) || owner.status !== 'active') throw new AppError('This promoter verification is not reviewable.', 409, 'COUNTRY_ADMIN_PROMOTER_LOCKED');
    independentPromoter(access.actor, row);
    const mine = same(row.assignedUserId, access.actor._id);
    if (action === 'claim' && row.assignedUserId) throw new AppError('This verification already has a reviewer.', 409, 'COUNTRY_ADMIN_PROMOTER_ALREADY_CLAIMED');
    if (action !== 'claim' && !mine && !(legacy && action === 'decision' && !row.assignedUserId)) {
      throw new AppError('Claim this promoter verification before continuing.', 409, 'COUNTRY_ADMIN_PROMOTER_CLAIM_REQUIRED');
    }
    if (decision?.decision === 'approve' && (!owner.emailVerifiedAt || !owner.onboardingCompletedAt || !row.submittedAt
      || !row.disclosureAcceptedAt || !row.channels.length || !row.niches.length)) {
      throw new AppError('The current verified account and submitted programme evidence are required.', 409, 'COUNTRY_ADMIN_PROMOTER_EVIDENCE_REQUIRED');
    }
    await fenceCountryAdminAccess(access, session);
    await fencePersonalAccount(owner, session);
    const now = new Date(), previousStatus = row.status;
    if (action === 'claim') { row.assignedUserId = access.actor._id; row.assignedAt = now; }
    if (action === 'release') { row.assignedUserId = null; row.assignedAt = null; }
    if (decision) {
      row.status = decision.decision === 'approve' ? 'verified' : 'rejected'; row.reason = decision.reason;
      row.reviewedAt = now; row.reviewedByUserId = access.actor._id; row.assignedUserId = null; row.assignedAt = null;
      await Notification.create([{ publicId: publicId('ntf'), userId: owner._id, country: row.country, type: 'promoter_verification',
        title: decision.decision === 'approve' ? 'Promoter verification approved' : 'Promoter verification needs attention',
        body: decision.reason, href: '/promoter/profile?section=business' }], { session });
    }
    row.reviewHistory.push({ action: decision ? decision.decision : action, actorUserId: access.actor._id, reason: decision?.reason || '', at: now });
    row.reviewHistory = row.reviewHistory.slice(-200); row.increment(); await row.save({ session });
    await writeAudit(request, `country_admin.promoter_${decision ? decision.decision : action}`, { session, actor: access.actor,
      country: row.country, targetType: 'promoter_verification', targetPublicId: row.publicId,
      metadata: { previousStatus, status: row.status, appealReview: previousStatus === 'appealed', version: row.__v } });
    return { publicId: row.publicId, status: row.status, version: row.__v, __v: row.__v };
  });
}

export async function actCountryAdminPromoter(request, action) { return mutatePromoter(request, action); }

/** Existing trusted core callers retain their review contract; the HTTP API supplies its explicit version. */
export async function reviewCountryAdminPromoterLegacy(request, id, input) {
  return mutatePromoter(request, 'decision', { id, input, legacy: true });
}

export async function loadCountryAdminCustomerDetail(request, id = request.params?.publicId) {
  const { row, access } = await sourceCustomer(request, idSchema.parse(id));
  const [orders, ticketCount] = await Promise.all([
    Order.find({ userId: row._id, country: row.country }).select('publicId status paymentState fulfillmentState totals createdAt')
      .sort({ createdAt: -1, _id: -1 }).limit(10).lean(),
    SupportTicket.countDocuments({ userId: row._id, country: row.country }),
  ]);
  const result = { type: 'customer', record: { publicId: row.publicId, name: row.name, country: row.country, status: row.status,
    role: 'customer', version: row.__v || 0, __v: row.__v || 0, createdAt: row.createdAt,
    emailMasked: maskedEmail(row.email), phoneMasked: maskedPhone(row.phone), emailVerified: Boolean(row.emailVerifiedAt), phoneVerified: Boolean(row.phoneVerifiedAt),
    orders: orders.map(order => ({ publicId: order.publicId, status: order.status, paymentState: order.paymentState,
      fulfillmentState: order.fulfillmentState, totalMinor: order.totals?.totalMinor, currency: order.totals?.currency, createdAt: order.createdAt })), ticketCount },
    assignment: 'unassigned', actionable: !same(row._id, access.actor._id), error: '', draft: {} };
  await recheckRead(request, access, row.country);
  return result;
}

export async function actCountryAdminCustomer(request, action) {
  if (!['suspend', 'reactivate'].includes(action)) throw new AppError('Choose a supported customer action.', 422, 'COUNTRY_ADMIN_PEOPLE_ACTION_INVALID');
  const id = idSchema.parse(request.params?.publicId), version = versionSchema.parse(request.body?.version);
  const reason = z.string().trim().min(10).max(500).parse(request.body?.reason);
  return transaction(async session => {
    const { row, access } = await sourceCustomer(request, id, session);
    assertVersion(row, version);
    if (same(row._id, access.actor._id)) throw new AppError('A different administrator must manage this account.', 403, 'COUNTRY_ADMIN_PEOPLE_SELF_ACTION');
    const previousStatus = action === 'suspend' ? 'active' : 'suspended';
    if (row.status !== previousStatus) throw new AppError('This customer account is not in the required state.', 409, 'COUNTRY_ADMIN_CUSTOMER_STATE');
    await fenceCountryAdminAccess(access, session);
    const now = new Date(), status = action === 'suspend' ? 'suspended' : 'active';
    const result = await User.updateOne({ _id: row._id, role: 'customer', country: row.country, status: previousStatus,
      platformAccessManagedAt: trusted({ $exists: false }), __v: version, 'security.tokenVersion': row.security.tokenVersion },
    { $set: { status }, $inc: { __v: 1, 'security.tokenVersion': 1 } }, { session });
    if (result.modifiedCount !== 1) throw conflict();
    // A fresh login is required after either transition; no old browser/mobile token is revived.
    await Device.updateMany({ userId: row._id, revokedAt: null }, { $set: { revokedAt: now, revokedReason: `country_admin_customer_${action}` }, $inc: { __v: 1 } }, { session });
    await MobileSession.updateMany({ userId: row._id, revokedAt: null }, { $set: { revokedAt: now, revokedReason: `country_admin_customer_${action}` }, $inc: { __v: 1 } }, { session });
    await Notification.create([{ publicId: publicId('ntf'), userId: row._id, country: row.country, type: 'customer_account',
      title: action === 'suspend' ? 'Your account has been suspended' : 'Your account has been reactivated', body: reason, href: '/account/security' }], { session });
    await writeAudit(request, `country_admin.customer_${action}`, { session, actor: access.actor, country: row.country,
      targetType: 'user', targetPublicId: row.publicId, metadata: { previousStatus, status, reason, version: version + 1 } });
    return { publicId: row.publicId, status, version: version + 1, __v: version + 1 };
  });
}

/** A real owner appeal keeps the submitted programme country and cannot overwrite the original decision. */
export async function appealCountryAdminPromoterVerification(request) {
  const version = versionSchema.parse(request.body?.version), message = z.string().trim().min(10).max(1000).parse(request.body?.message);
  return transaction(async session => {
    const owner = await User.findById(request.user?._id).session(session);
    if (!await countryAdminPersonalAccountEligible(owner, 'promoter', session) || owner.status !== 'active'
      || owner.security.tokenVersion !== request.user?.security?.tokenVersion
      || (request.session?.tokenVersion !== undefined && owner.security.tokenVersion !== request.session.tokenVersion)
      || !env.auth.simpleLogin && (!owner.emailVerifiedAt || !owner.onboardingCompletedAt)) {
      throw new AppError('Your current Promoter account is required.', 403, 'ACCOUNT_UNAVAILABLE');
    }
    const device = await currentRequestDevice(request, { userId: owner._id, session });
    const row = await PromoterVerification.findOne({ userId: owner._id }).session(session);
    if (!row) throw unavailable('promoter');
    assertVersion(row, version);
    if (row.status !== 'rejected' || !row.reviewedByUserId || !row.reviewedAt || !row.submittedAt || !row.disclosureAcceptedAt) {
      throw new AppError('Only a rejected submitted verification can be appealed.', 409, 'COUNTRY_ADMIN_PROMOTER_APPEAL_STATE');
    }
    const market = await CountrySetting.findOne({ code: row.country, active: true }).session(session).lean();
    if (!market?.currency || !market.timeZone) throw new AppError('The Promoter programme country is unavailable.', 409, 'PROMOTER_MARKET_UNAVAILABLE');
    await fencePersonalAccount(owner, session);
    if (device) {
      const changed = await Device.updateOne({ _id: device._id, userId: owner._id, sessionHash: device.sessionHash,
        revokedAt: null, __v: device.__v || 0 }, { $inc: { __v: 1 } }, { session });
      if (changed.modifiedCount !== 1) throw conflict();
    }
    const countryFence = await CountrySetting.updateOne({ _id: market._id, code: row.country, active: true, currency: market.currency,
      timeZone: market.timeZone, __v: market.__v || 0 }, { $inc: { __v: 1 } }, { session });
    if (countryFence.modifiedCount !== 1) throw conflict();
    const now = new Date();
    row.status = 'appealed'; row.assignedUserId = null; row.assignedAt = null;
    row.appeal = { message, submittedAt: now, originalReviewerUserId: row.reviewedByUserId };
    row.reviewHistory.push({ action: 'appeal', actorUserId: owner._id, reason: message, at: now });
    row.reviewHistory = row.reviewHistory.slice(-200); row.increment(); await row.save({ session });
    await Notification.create([{ publicId: publicId('ntf'), userId: owner._id, country: row.country, type: 'promoter_verification',
      title: 'Your promoter appeal was received', body: 'A different administrator will review your submitted programme evidence and appeal.', href: '/promoter/profile?section=business' }], { session });
    await writeAudit(request, 'promoter.verification_appealed', { session, actor: owner, country: row.country,
      targetType: 'promoter_verification', targetPublicId: row.publicId, metadata: { version: row.__v } });
    await queueCountryAdminAlert({country:row.country,kind:'escalation',sourceType:'promoter_verification',sourcePublicId:row.publicId},session);
    return { publicId: row.publicId, status: row.status, version: row.__v, __v: row.__v };
  });
}

import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { hashValue, normalizeEmail } from '../core/crypto.js';
import { ApprovalRequest, CountrySetting, PlatformStaffInvitation, User, Warehouse } from '../models/index.js';
import { authenticateOperator, authorizeOperator, fenceOperatorAuthentication } from './operator-auth.js';
import { createPlatformStaffInvitation } from './staff-access.js';
import { currentAdministrativeAuthority, applyApproval } from './stage9.js';
import { writeAudit } from './audit.js';

const identifier = z.string().trim().regex(/^[A-Za-z0-9_-]{4,120}$/);
const staffRole = z.enum(['country_admin', 'finance', 'moderator', 'support', 'warehouse']);
const invitationInput = z.object({
  email: z.string().trim().email().max(254), role: staffRole,
  operationalCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(20),
  warehouseScopes: z.array(identifier).max(100).default([]),
  grantDurationDays: z.number().int().min(1).max(365).default(180),
  reason: z.string().trim().min(3).max(1000),
}).strict();
const approvalInput = z.object({ approvalPublicId: identifier, expectedVersion: z.number().int().min(0) }).strict();

function cliRequest(actor) {
  return { id: publicId('req'), user: actor, ip: '', get: () => 'ClassicMartStaffOperations/1.0', query: {} };
}
function actorSummary(context) { return { publicId: context.actor.publicId, role: context.role }; }
function staffAuthority(context) {
  if (!context.grant || !context.actor.phoneVerifiedAt) throw new AppError('Verified current staff authority is required.', 403, 'OPERATOR_AUTH_FAILED');
  return context;
}
function maskEmail(value) {
  const [local, domain] = normalizeEmail(value).split('@');
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(1, Math.min(8, local.length - 2)))}@${domain}`;
}
function scopedApprovalQuery(context) {
  return { type: 'platform_staff_access', status: 'requested', ...(context.role === 'super_admin' ? {} : { country: { $in: context.scopes } }) };
}

async function validateAssignment(context, input, session = null) {
  const countries = [...new Set(input.operationalCountries)], warehouses = [...new Set(input.warehouseScopes)];
  if (context.role === 'country_admin' && (['finance', 'country_admin'].includes(input.role) || countries.length !== 1 || !context.scopes.includes(countries[0]))) {
    throw new AppError('The staff role or country is outside your authority.', 403, 'STAFF_ROLE_SCOPE');
  }
  const active = await CountrySetting.countDocuments({ code: { $in: countries }, active: true }).session(session);
  if (active !== countries.length) throw new AppError('Choose active operational countries.', 422, 'STAFF_COUNTRY_INVALID');
  if ((input.role === 'warehouse' && !warehouses.length) || (input.role !== 'warehouse' && warehouses.length)) {
    throw new AppError('Warehouse staff need explicit warehouse scopes; other roles cannot receive them.', 422, 'STAFF_WAREHOUSE_SCOPE_ROLE');
  }
  if (warehouses.length) {
    const rows = await Warehouse.find({ publicId: { $in: warehouses }, active: true }).select('publicId country').session(session).lean();
    if (rows.length !== warehouses.length || rows.some(row => !countries.includes(row.country))) throw new AppError('Warehouse scopes must belong to the selected countries.', 422, 'STAFF_WAREHOUSE_SCOPE_INVALID');
  }
  return { ...input, operationalCountries: countries, warehouseScopes: warehouses };
}

async function validateInvitation(context, input, session = null) {
  input = await validateAssignment(context, input, session);
  if (normalizeEmail(context.actor.email) === normalizeEmail(input.email)) throw new AppError('Use an independent dedicated staff identity.', 409, 'STAFF_DEDICATED_ACCOUNT_REQUIRED');
  const existing = await User.findOne({ emailNormalized: normalizeEmail(input.email) }).select('role').session(session).lean();
  if (existing && ['seller', 'business', 'promoter', 'delivery', 'super_admin'].includes(existing.role)) throw new AppError('Use a dedicated staff identity.', 409, 'STAFF_DEDICATED_ACCOUNT_REQUIRED');
  if (await PlatformStaffInvitation.exists({ emailHash: hashValue(normalizeEmail(input.email)), status: 'pending', expiresAt: { $gt: new Date() } }).session(session)) throw new AppError('An active invitation already exists.', 409, 'STAFF_INVITE_EXISTS');
  return input;
}

export async function runStaffOperation(credentials, { action, apply = false, ...raw } = {}) {
  if (!['invite', 'list', 'approve'].includes(action) || typeof apply !== 'boolean') throw new AppError('Choose invite, list or approve.', 422, 'STAFF_OPERATION_INVALID');
  const baseline = staffAuthority(await authenticateOperator(credentials, { roles: ['super_admin', 'country_admin'] }));
  const current = baseline;
  const operator = actorSummary(current);
  if (action === 'list') {
    if (apply || Object.keys(raw).length) throw new AppError('Listing takes no write options.', 422, 'STAFF_OPERATION_INVALID');
    const session = await mongoose.startSession(); let rows;
    try { await session.withTransaction(async () => {
      const authorized = staffAuthority(await authorizeOperator(baseline, { session }));
      rows = await ApprovalRequest.find(scopedApprovalQuery(authorized)).sort({ createdAt: 1, _id: 1 }).limit(100).select('publicId type country status targetPublicId payload.role payload.action requestedByUserId __v createdAt').session(session).lean();
    }); } finally { await session.endSession(); }
    return { mode: 'read-only', action, operator, approvals: rows.map(row => ({ publicId: row.publicId, version: row.__v || 0, country: row.country, status: row.status, targetPublicId: row.targetPublicId, role: row.payload?.role, action: row.payload?.action, requestedByMe: String(row.requestedByUserId) === String(current.actor._id) })) };
  }
  if (action === 'invite') {
    const parsed = invitationInput.parse(raw);
    let input;
    const session = await mongoose.startSession();
    let invitation;
    try {
      await session.withTransaction(async () => {
        const context = staffAuthority(await authorizeOperator(baseline, { session }));
        input = await validateInvitation(context, parsed, session);
        if (!apply) return;
        await fenceOperatorAuthentication(context, { session, code: credentials.code });
        // Reuse the same current administrative scope/market fences as approval.
        const authority = await currentAdministrativeAuthority(context.actor, { session, country: context.role === 'country_admin' ? input.operationalCountries[0] : '' });
        const request = cliRequest(authority.actor);
        invitation = await createPlatformStaffInvitation(request, input, { session });
        await writeAudit(request, 'admin.staff_invited', { session, actor: context.actor, targetType: 'platform_staff_invitation', targetPublicId: invitation.publicId, country: invitation.approvalCountry, metadata: { source: 'operations_cli', role: invitation.role, countries: invitation.operationalCountries, warehouseScopes: invitation.warehouseScopes } });
      });
    } finally { await session.endSession(); }
    if (!apply) return { mode: 'dry-run', action, operator, invitation: { emailMasked: maskEmail(input.email), role: input.role, operationalCountries: input.operationalCountries, warehouseScopes: input.warehouseScopes, grantDurationDays: input.grantDurationDays }, activationRequiresIndependentApproval: true };
    return { mode: 'applied', action, operator, invitation: { publicId: invitation.publicId, emailMasked: invitation.emailMasked, role: invitation.role, operationalCountries: invitation.operationalCountries, warehouseScopes: invitation.warehouseScopes, grantDurationDays: invitation.grantDurationDays, expiresAt: invitation.expiresAt }, activationRequiresIndependentApproval: true };
  }
  const input = approvalInput.parse(raw);
  const approval = await ApprovalRequest.findOne({ ...scopedApprovalQuery(current), publicId: input.approvalPublicId });
  if (!approval) throw new AppError('Pending staff approval not found.', 404, 'STAFF_APPROVAL_NOT_FOUND');
  if (input.expectedVersion !== (approval.__v || 0)) throw new AppError('Staff approval changed. Review it again.', 409, 'APPROVAL_VERSION_CONFLICT');
  const result = await applyApproval(approval, current.actor, {
    request: cliRequest(current.actor), dryRun: !apply,
    beforeApply: async ({ session, approval: freshApproval }) => {
      if (freshApproval.type !== 'platform_staff_access') throw new AppError('Only staff access approvals are supported.', 403, 'STAFF_APPROVAL_TYPE');
      const context = staffAuthority(await authorizeOperator(baseline, { session }));
      if ((freshApproval.payload?.action || 'grant') === 'grant') {
        const payload = freshApproval.payload || {};
        const assignment = invitationInput.omit({ email: true, reason: true }).parse({ role: payload.role, operationalCountries: payload.operationalCountries, warehouseScopes: payload.warehouseScopes, grantDurationDays: payload.grantDurationDays });
        await validateAssignment(context, assignment, session);
      }
      if (apply) await fenceOperatorAuthentication(context, { session, code: credentials.code });
    },
  });
  return { mode: apply ? 'applied' : 'dry-run', action, operator, approvalPublicId: approval.publicId, result: { userPublicId: result.user, role: result.role, operationalCountries: result.operationalCountries, warehouseScopes: result.warehouseScopes, status: result.status, ...(apply ? { grantPublicId: result.platformGrant } : {}), expiresAt: result.expiresAt } };
}

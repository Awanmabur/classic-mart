import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { encryptSensitive } from '../core/sensitive.js';
import { Brand, Category, BusinessBudget, BusinessMember, BusinessOrganization, BusinessInvoice, CountrySetting, ProcurementRequest, ProcurementRun, ProcurementTemplate, Product, ProductVariant, PurchaseOrder, QuoteRequest, Store, User, PlatformGrant } from '../models/index.js';
import { asBusinessRequest, businessAccess, businessSame, businessTransaction, fenceBusinessRecord, requireBusinessCapability } from './business-access.js';
import { businessCommercialPolicy, reviewedMarketPolicy } from './business-policy.js';
import { issuePurchaseOrderDocument, issueQuotationDocument } from './business-documents.js';
import { writeAudit } from './audit.js';
import { hasPublicProductApproval } from './storefront.js';
import { countryAdminAccess } from './country-admin-workspace-access.js';
import { canonicalPhone } from '../core/phone.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{4,100}$/);
const money = z.coerce.number().int().min(0).max(10_000_000_000);
const version = z.coerce.number().int().min(0);
const key = z.string().regex(/^[A-Za-z0-9:_-]{8,120}$/).optional();
const itemInput = z.object({ variantPublicId: id, quantity: z.coerce.number().int().min(1).max(9999), note: z.string().trim().max(300).optional() }).strict();
const itemsInput = z.array(itemInput).min(1).max(500);
const procurementInput = z.object({ title: z.string().trim().min(1).max(160), budgetId: id.optional().or(z.literal('')), items: itemsInput, idempotencyKey: key }).strict();
const clean = row => ({ publicId: row.publicId, version: Number(row.__v || 0), status: row.status });
const event = (type, message, actor) => ({ type, message, actorUserId: actor._id });
export function businessInput(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('Check the business form and submit valid values.', 422, 'BUSINESS_INPUT_INVALID');
  return parsed.data;
}
export function assertBusinessVersion(row, expected) {
  if (!row || Number(row.__v || 0) !== expected) throw new AppError('This business record changed. Reload before continuing.', 409, 'BUSINESS_VERSION_CONFLICT');
}
async function audit(context, session, action, row, metadata = {}) {
  await writeAudit(context.request, action, { actor: context.actor, country: context.org?.country || context.actor.country, targetType: 'business', targetPublicId: row.publicId, metadata, session });
}
function safeTotal(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000_000_000) throw new AppError('The procurement total is outside the supported limit.', 422, 'BUSINESS_TOTAL_INVALID');
  return value;
}
const taxFor = (subtotal, bps) => Number(BigInt(subtotal) * BigInt(bps) / 10000n);
const boolean = z.union([z.boolean(),z.enum(['true','false','on','off','1','0'])]).transform(value=>value===true||value==='true'||value==='on'||value==='1');

export async function createBusinessOrganization(value, input) {
  const data = businessInput(z.object({ companyName: z.string().trim().min(2).max(180), billingEmail: z.string().trim().toLowerCase().email().max(254) }).strict(), input);
  return businessTransaction(value, null, async (context, session) => {
    if (await BusinessOrganization.exists({ ownerUserId: context.actor._id }).session(session)) throw new AppError('Your business already exists.', 409, 'BUSINESS_ALREADY_EXISTS');
    const market = await CountrySetting.findOne({ code: context.actor.country, active: true }).session(session);
    if (!market?.timeZone) throw new AppError('Your business market is unavailable.', 409, 'BUSINESS_MARKET_UNAVAILABLE');
    await fenceBusinessRecord(CountrySetting, market, session, { active: true, currency: market.currency });
    const [org] = await BusinessOrganization.create([{ publicId: publicId('biz'), ownerUserId: context.actor._id, ...data, country: market.code, currency: market.currency }], { session });
    await BusinessMember.create([{ publicId: publicId('bmem'), organizationId: org._id, userId: context.actor._id, role: 'owner', status: 'active', canApprove: true, invitedByUserId: context.actor._id, acceptedAt: new Date() }], { session });
    await audit(context, session, 'business.organization.created', org);
    return clean(org);
  }, { allowEmpty: true });
}
export async function saveBusinessProfile(value, input) {
  const text = maximum => z.string().trim().max(maximum).optional();
  const data = businessInput(z.object({ version, companyName: z.string().trim().min(2).max(180), billingEmail: z.string().trim().toLowerCase().email().max(254), taxId: text(120),clearTaxId:boolean.optional(), billingContactName: text(120), billingPhone: text(32), billingAddress: text(240), billingCity: text(120), deliveryContactName: text(120), deliveryPhone: text(32), deliveryAddress: text(240), deliveryCity: text(120) }).strict(), input);
  return businessTransaction(value, 'members', async (context, session) => {
    // Access fencing increments the authoritative organization version once.
    assertBusinessVersion(context.org, data.version + 1);
    const { version: ignored, taxId,clearTaxId, ...fields } = data;
    for (const key of ['billingPhone','deliveryPhone']) if (fields[key]) fields[key] = canonicalPhone(fields[key], fields[key].startsWith('+') ? undefined : context.org.country);
    Object.assign(context.org, fields);
    if (clearTaxId&&taxId)throw new AppError('Enter a replacement tax ID or clear the current ID.',422,'BUSINESS_INPUT_INVALID');
    if (taxId) context.org.taxIdEncrypted=encryptSensitive(taxId);
    else if(clearTaxId)context.org.taxIdEncrypted='';
    await context.org.save({ session });
    await audit(context, session, 'business.profile.updated', context.org);
    return clean(context.org);
  });
}
export async function inviteBusinessMember(value, input) {
  const data = businessInput(z.object({ email: z.string().trim().toLowerCase().email().max(254), role: z.enum(['admin','buyer','approver','viewer']), spendingLimitMinor: money.default(0), canApprove: boolean.default(false) }).strict(), input);
  return businessTransaction(value, 'members', async (context, session) => {
    if (data.role === 'admin' && context.member.role !== 'owner') throw new AppError('Only the business owner can appoint administrators.', 403, 'BUSINESS_OWNER_REQUIRED');
    const user = await User.findOne({ email: data.email, status: 'active', role: mongoose.trusted({ $in: ['customer','business'] }), platformAccessManagedAt: null }).session(session);
    if (!user || businessSame(user._id, context.org.ownerUserId) || !user.emailVerifiedAt || await PlatformGrant.exists({userId:user._id}).session(session)) throw new AppError('An eligible verified registered business member is required.', 422, 'BUSINESS_MEMBER_INVALID');
    await fenceBusinessRecord(User, user, session, { status: 'active', role: user.role, 'security.tokenVersion': user.security.tokenVersion });
    const existing = await BusinessMember.findOne({ organizationId: context.org._id, userId: user._id }).session(session);
    if (existing?.status !== 'revoked' && existing) throw new AppError('This person already has a membership or invitation.', 409, 'BUSINESS_MEMBER_EXISTS');
    let member;
    if (existing) {
      Object.assign(existing, { role: data.role, spendingLimitMinor: data.spendingLimitMinor, canApprove: data.canApprove, status: 'invited', invitedByUserId: context.actor._id, inviterTokenVersion:context.actor.security.tokenVersion, invitedAt: new Date(), acceptedAt: undefined, revokedAt: undefined });
      member = await existing.save({ session });
    } else [member] = await BusinessMember.create([{ publicId: publicId('bmem'), organizationId: context.org._id, userId: user._id, role: data.role, spendingLimitMinor: data.spendingLimitMinor, canApprove: data.canApprove, status: 'invited', invitedByUserId: context.actor._id,inviterTokenVersion:context.actor.security.tokenVersion }], { session });
    await audit(context, session, 'business.member.invited', member, { role: data.role });
    return clean(member);
  });
}
export async function acceptBusinessInvitation(value, publicIdValue, input) {
  const data = businessInput(z.object({ version }).strict(), input);
  return businessTransaction(value, null, async (context, session) => {
    const member = await BusinessMember.findOne({ publicId: businessInput(id, publicIdValue), userId: context.actor._id, status: 'invited' }).session(session);
    if (!member) throw new AppError('Business invitation not found.', 404, 'BUSINESS_INVITATION_NOT_FOUND');
    assertBusinessVersion(member, data.version);
    const org = await BusinessOrganization.findOne({ _id: member.organizationId, status: 'active' }).session(session);
    if (!org) throw new AppError('This business is unavailable.', 403, 'BUSINESS_ORGANIZATION_UNAVAILABLE');
    const inviter = await BusinessMember.findOne({ organizationId: org._id, userId: member.invitedByUserId, status: 'active', acceptedAt: mongoose.trusted({ $type: 'date' }) }).session(session);
    if (!inviter || !['owner','admin'].includes(inviter.role) || (member.role === 'admin' && (!businessSame(member.invitedByUserId, org.ownerUserId) || inviter.role !== 'owner'))) throw new AppError('This invitation must be reissued by an authorized owner or administrator.', 403, 'BUSINESS_INVITER_UNAVAILABLE');
    const issuer = await User.findOne({ _id: member.invitedByUserId, status: 'active', role: mongoose.trusted({ $in: ['customer','business'] }) }).session(session);
    if (!issuer || member.inviterTokenVersion===undefined) throw new AppError('The invitation issuer is unavailable. Ask the company to reissue the invitation.', 403, 'BUSINESS_INVITER_UNAVAILABLE');
    const source=await businessAccess({user:{_id:issuer._id,security:{tokenVersion:member.inviterTokenVersion}},get:()=>''},{session,capability:'members',organizationPublicId:org.publicId});
    await fenceBusinessRecord(User,source.actor,session,{status:'active',role:source.actor.role,'security.tokenVersion':member.inviterTokenVersion});
    await fenceBusinessRecord(BusinessMember,source.member,session,{status:'active',role:source.member.role});
    await fenceBusinessRecord(BusinessOrganization,org,session,{status:'active',country:source.org.country,currency:source.org.currency});
    await fenceBusinessRecord(CountrySetting,source.market,session,{active:true,currency:org.currency});
    member.status = 'active'; member.acceptedAt = new Date(); await member.save({ session });
    await audit({ ...context, org }, session, 'business.invitation.accepted', member);
    return clean(member);
  }, { allowEmpty: true });
}
export async function changeBusinessMember(value, publicIdValue, input) {
  const data = businessInput(z.object({ version, action: z.enum(['update','revoke']), role: z.enum(['admin','buyer','approver','viewer']).optional(), spendingLimitMinor: money.optional(), canApprove: boolean.optional() }).strict(), input);
  return businessTransaction(value, 'members', async (context, session) => {
    const member = await BusinessMember.findOne({ publicId: businessInput(id, publicIdValue), organizationId: context.org._id }).session(session);
    if (!member) throw new AppError('Business member not found.', 404, 'BUSINESS_MEMBER_NOT_FOUND');
    assertBusinessVersion(member, data.version);
    if (member.role === 'owner' || businessSame(member.userId, context.actor._id)) throw new AppError('The owner and your own membership cannot be changed here.', 403, 'BUSINESS_OWNER_REQUIRED');
    if ((member.role === 'admin' || data.role === 'admin') && context.member.role !== 'owner') throw new AppError('Only the owner can manage administrators.', 403, 'BUSINESS_OWNER_REQUIRED');
    if (data.action === 'revoke') { member.status = 'revoked'; member.revokedAt = new Date(); }
    else for (const field of ['role','spendingLimitMinor','canApprove']) if (data[field] !== undefined) member[field] = data[field];
    await member.save({ session }); await audit(context, session, 'business.member.' + data.action, member);
    return clean(member);
  });
}
export async function createBusinessBudget(value, input) {
  const data = businessInput(z.object({ name: z.string().trim().min(1).max(120), limitMinor: money.refine(v => v > 0), periodStart: z.coerce.date(), periodEnd: z.coerce.date(), idempotencyKey: key }).strict(), input);
  if (data.periodEnd <= data.periodStart) throw new AppError('The budget end must follow its start.', 422, 'BUSINESS_BUDGET_PERIOD_INVALID');
  return businessTransaction(value, 'budgets', async (context, session) => {
    const [budget] = await BusinessBudget.create([{ publicId: publicId('bbud'), organizationId: context.org._id, createdByUserId: context.actor._id, currency: context.org.currency, ...data, operationKey: data.idempotencyKey }], { session });
    await audit(context, session, 'business.budget.created', budget); return clean(budget);
  });
}
export async function validateBusinessItems(context, input, session, { prices = true } = {}) {
  if (new Set(input.map(item => item.variantPublicId)).size !== input.length) throw new AppError('Combine duplicate SKU rows before submitting.', 422, 'BUSINESS_DUPLICATE_SKU');
  const rows = [];
  for (const item of input) {
    const variant = await ProductVariant.findOne({ publicId: item.variantPublicId, active: true, currency: context.org.currency }).session(session);
    const product = variant && await Product.findOne({ _id: variant.productId, storeId: variant.storeId, status: 'published', countries: context.org.country }).session(session);
    const store = product && await Store.findOne({ _id: variant.storeId, country: context.org.country, currency: context.org.currency, status: 'verified' }).session(session);
    const category=product&&await Category.findOne({_id:product.categoryId,active:true,$or:[{countries:mongoose.trusted({$size:0})},{countries:context.org.country}]}).session(session);
    const brand=product?.brandId?await Brand.findOne({_id:product.brandId,status:'approved'}).session(session):null;
    if (!variant || !product || !store || !category || (product.brandId&&!brand) || !hasPublicProductApproval(product,category,store) || !Number.isSafeInteger(variant.priceMinor) || variant.priceMinor <= 0) throw new AppError('One of the selected SKUs is no longer available in this business market.', 409, 'BUSINESS_SKU_UNAVAILABLE');
    await fenceBusinessRecord(ProductVariant, variant, session, { active: true, currency: context.org.currency, sku: variant.sku });
    await fenceBusinessRecord(Product, product, session, { status: 'published', storeId: store._id });
    await fenceBusinessRecord(Store, store, session, { status: 'verified', country: context.org.country, currency: context.org.currency });
    await fenceBusinessRecord(Category,category,session,{active:true});
    if(brand)await fenceBusinessRecord(Brand,brand,session,{status:'approved'});
    rows.push({ productPublicId: product.publicId, variantPublicId: variant.publicId, storePublicId: store.publicId, sku: variant.sku, title: product.title, variantTitle: variant.title, quantity: item.quantity, estimatedUnitMinor: prices ? variant.priceMinor : 0, minimumPriceMinor:Number(variant.minimumPriceMinor||0), note: item.note || '' });
  }
  return rows;
}
async function submitWithin(context, data, session) {
  const items = await validateBusinessItems(context, data.items, session);
  const policy = reviewedMarketPolicy(context.market);
  const subtotal = safeTotal(items.reduce((sum, row) => sum + row.estimatedUnitMinor * row.quantity, 0));
  const tax = taxFor(subtotal, policy.taxBps), total = safeTotal(subtotal + tax);
  if (context.member.role !== 'owner' && context.member.spendingLimitMinor > 0 && total > context.member.spendingLimitMinor) throw new AppError('This request exceeds your membership spending limit.', 403, 'BUSINESS_SPENDING_LIMIT');
  const budget = data.budgetId ? await BusinessBudget.findOne({ publicId: data.budgetId, organizationId: context.org._id, currency: context.org.currency, active: true, periodStart: mongoose.trusted({ $lte: new Date() }), periodEnd: mongoose.trusted({ $gt: new Date() }) }).session(session) : null;
  if (data.budgetId && !budget) throw new AppError('Select an active budget in this business.', 409, 'BUSINESS_BUDGET_UNAVAILABLE');
  if (budget) await fenceBusinessRecord(BusinessBudget, budget, session, { active: true });
  const [row] = await ProcurementRequest.create([{ publicId: publicId('bpr'), organizationId: context.org._id, requesterUserId: context.actor._id, requesterTokenVersion: context.actor.security.tokenVersion, budgetId: budget?._id, title: data.title, items, estimatedSubtotalMinor: subtotal, taxBps: policy.taxBps, estimatedTaxMinor: tax, taxPolicyVersion: policy.policyVersion, commercialPolicy: policy, estimatedTotalMinor: total, currency: context.org.currency, operationKey: data.idempotencyKey, timeline: [event('submitted','Request submitted for independent approval.',context.actor)] }], { session });
  await audit(context, session, 'business.procurement.submitted', row); return row;
}
export async function submitBusinessProcurement(value, input) {
  const data = businessInput(procurementInput, input);
  return businessTransaction(value, 'buy', async (context, session) => clean(await submitWithin(context, data, session)));
}
export async function decideBusinessProcurement(value, publicIdValue, input) {
  const data = businessInput(z.object({ version, decision: z.enum(['approve','reject']), reason: z.string().trim().max(500).default('') }).strict(), input);
  return businessTransaction(value, 'approve', async (context, session) => {
    const row = await ProcurementRequest.findOne({ publicId: businessInput(id, publicIdValue), organizationId: context.org._id, status: 'submitted' }).session(session);
    if (!row) throw new AppError('Submitted procurement request not found.', 404, 'BUSINESS_REQUEST_NOT_FOUND');
    assertBusinessVersion(row, data.version);
    if (businessSame(row.requesterUserId, context.actor._id)) throw new AppError('Another authorized member must approve your request.', 403, 'BUSINESS_INDEPENDENT_APPROVAL_REQUIRED');
    if (data.decision === 'approve') {
      const policy = businessCommercialPolicy(row.commercialPolicy);
      if (policy.taxBps !== row.taxBps || policy.policyVersion !== row.taxPolicyVersion || row.estimatedSubtotalMinor + row.estimatedTaxMinor !== row.estimatedTotalMinor || taxFor(row.estimatedSubtotalMinor, row.taxBps) !== row.estimatedTaxMinor) throw new AppError('The reviewed procurement totals do not balance.', 409, 'BUSINESS_POLICY_REVIEW_REQUIRED');
      const user = await User.findById(row.requesterUserId).session(session);
      if (!user || row.requesterTokenVersion === undefined) throw new AppError('The requester must resubmit this request.', 409, 'BUSINESS_REQUESTER_UNAVAILABLE');
      const requester = await businessAccess({ user: { _id: user._id, security: { tokenVersion: row.requesterTokenVersion } }, get: () => '' }, { session, capability: 'buy', organizationPublicId: context.org.publicId });
      if (requester.member.role !== 'owner' && requester.member.spendingLimitMinor > 0 && row.estimatedTotalMinor > requester.member.spendingLimitMinor) throw new AppError('The request exceeds its requester’s current limit.', 409, 'BUSINESS_SPENDING_LIMIT');
      await fenceBusinessRecord(User, requester.actor, session, { status: 'active', 'security.tokenVersion': row.requesterTokenVersion });
      await fenceBusinessRecord(BusinessMember, requester.member, session, { status: 'active', role: requester.member.role });
      // Publication, SKU identity and current market availability must still agree; reviewed prices stay immutable.
      const current = await validateBusinessItems(context, row.items, session);
      if (current.some((item,index) => item.productPublicId !== row.items[index].productPublicId || item.sku !== row.items[index].sku || item.storePublicId !== row.items[index].storePublicId)) throw new AppError('The approved catalogue source changed.', 409, 'BUSINESS_SKU_UNAVAILABLE');
      if (row.budgetId) {
        const updated = await BusinessBudget.updateOne({ _id: row.budgetId, organizationId: context.org._id, active: true, currency: row.currency, periodStart: mongoose.trusted({ $lte: new Date() }), periodEnd: mongoose.trusted({ $gt: new Date() }), $expr: { $lte: [{ $add: ['$committedMinor','$spentMinor',row.estimatedTotalMinor] },'$limitMinor'] } }, { $inc: { committedMinor: row.estimatedTotalMinor, __v: 1 } }, { session });
        if (updated.modifiedCount !== 1) throw new AppError('The budget has insufficient available funds.', 409, 'BUSINESS_BUDGET_EXCEEDED');
      }
      row.status = 'approved'; row.approvedByUserId = context.actor._id; row.approvedAt = new Date();
    } else { row.status = 'rejected'; row.rejectedAt = new Date(); row.rejectionReason = data.reason; }
    row.timeline.push(event('decision.' + data.decision, data.reason || `Request ${data.decision}d by an independent approver.`, context.actor));
    await row.save({ session }); await audit(context, session, 'business.procurement.' + data.decision, row); return clean(row);
  });
}

export async function businessCoverage(request, session = null) {
  const orders = await PurchaseOrder.find({ procurementRequestId: request._id, status: mongoose.trusted({ $in: ['issued','accepted','payment_pending','processing','fulfilled'] }) }).session(session).lean();
  const quantities = new Map();
  for (const order of orders) for (const line of order.items) quantities.set(line.variantPublicId, (quantities.get(line.variantPublicId) || 0) + line.quantity);
  return { orders, quantities };
}
export function businessApprovedAmount(request, selected, quantities = new Map()) {
  let cumulative = 0, amount = 0;
  for (const line of request.items) {
    const lineSubtotal = line.estimatedUnitMinor * line.quantity;
    const lineTax = taxFor(cumulative + lineSubtotal, request.taxBps) - taxFor(cumulative, request.taxBps);
    cumulative += lineSubtotal;
    const found = selected.find(item => item.variantPublicId === line.variantPublicId);
    if (!found) continue;
    const covered = quantities.get(line.variantPublicId) || 0;
    if (covered + found.quantity > line.quantity) throw new AppError('The requested quantity is already covered.', 409, 'BUSINESS_QUANTITY_EXCEEDED');
    amount += line.estimatedUnitMinor * found.quantity + Math.floor((covered + found.quantity) * lineTax / line.quantity) - Math.floor(covered * lineTax / line.quantity);
  }
  return safeTotal(amount);
}
export async function requestBusinessQuotation(value, input) {
  const data = businessInput(z.object({ procurementRequestId: id, version, storeId: id, message: z.string().trim().max(2000).default('') }).strict(), input);
  return businessTransaction(value, 'quotes', async (context, session) => {
    const procurement = await ProcurementRequest.findOne({ publicId: data.procurementRequestId, organizationId: context.org._id, status: mongoose.trusted({ $in: ['approved','partially_ordered'] }), closedAt: null }).session(session);
    if (!procurement) throw new AppError('An independently approved open request is required.', 409, 'BUSINESS_APPROVAL_REQUIRED');
    assertBusinessVersion(procurement, data.version); businessCommercialPolicy(procurement.commercialPolicy);
    if (businessSame(procurement.requesterUserId, procurement.approvedByUserId)) throw new AppError('Independent approval is required.', 409, 'BUSINESS_INDEPENDENT_APPROVAL_REQUIRED');
    const store = await Store.findOne({ publicId: data.storeId, country: context.org.country, currency: context.org.currency, status: 'verified' }).session(session);
    if (!store) throw new AppError('A verified supplier in your market is required.', 409, 'BUSINESS_SUPPLIER_UNAVAILABLE');
    if (await QuoteRequest.exists({ procurementRequestId: procurement._id, storeId: store._id, status: mongoose.trusted({ $in: ['requested','negotiating','responded'] }) }).session(session)) throw new AppError('An open quotation already exists for this supplier.', 409, 'BUSINESS_QUOTE_EXISTS');
    const coverage = await businessCoverage(procurement, session);
    const selected = procurement.items.filter(line => line.storePublicId === store.publicId).map(line => ({ ...line.toObject(), quantity: line.quantity - (coverage.quantities.get(line.variantPublicId) || 0) })).filter(line => line.quantity > 0);
    if (!selected.length) throw new AppError('There are no remaining approved items for this supplier.', 409, 'BUSINESS_QUANTITY_EXCEEDED');
    await validateBusinessItems(context, selected, session);
    await fenceBusinessRecord(ProcurementRequest, procurement, session, { status: procurement.status, closedAt: null });
    const [quote] = await QuoteRequest.create([{ publicId: publicId('bqr'), organizationId: context.org._id, procurementRequestId: procurement._id, requesterUserId: context.actor._id, storeId: store._id, storePublicId: store.publicId, country: context.org.country, currency: context.org.currency, approvedAmountMinor: businessApprovedAmount(procurement, selected, coverage.quantities), items: selected.map(line => ({ productPublicId: line.productPublicId, variantPublicId: line.variantPublicId, sku: line.sku, title: line.title, variantTitle: line.variantTitle, quantity: line.quantity, requestedUnitMinor: line.estimatedUnitMinor })), messages: data.message ? [{ actorType: 'buyer', actorUserId: context.actor._id, message: data.message }] : [] }], { session });
    await audit(context, session, 'business.quotation.requested', quote); return clean(quote);
  });
}
export async function replyBusinessQuotation(value, publicIdValue, input) {
  const data = businessInput(z.object({ version, message: z.string().trim().min(1).max(2000) }).strict(), input);
  return businessTransaction(value, 'quotes', async (context, session) => {
    const row = await QuoteRequest.findOne({ publicId: businessInput(id, publicIdValue), organizationId: context.org._id, status: mongoose.trusted({ $in: ['requested','responded','negotiating'] }) }).session(session);
    if (!row) throw new AppError('Open quotation not found.', 404, 'BUSINESS_QUOTE_NOT_FOUND');
    assertBusinessVersion(row, data.version);
    row.messages.push({ actorType: 'buyer', actorUserId: context.actor._id, message: data.message }); row.status = 'negotiating';
    await row.save({ session }); await audit(context, session, 'business.quotation.replied', row); return clean(row);
  });
}
export async function businessCreditExposure(organizationId, session) {
  const invoices = await BusinessInvoice.find({ organizationId, paymentTerms: 'credit', status: mongoose.trusted({ $in: ['credit_pending_delivery','open','overdue'] }) }).select('totalMinor paidMinor').session(session).lean();
  const issued = await PurchaseOrder.find({ organizationId, paymentTerms: 'credit', status: 'issued' }).select('totalMinor').session(session).lean();
  return invoices.reduce((sum,row) => sum + Math.max(0,row.totalMinor-row.paidMinor),0) + issued.reduce((sum,row) => sum+row.totalMinor,0);
}
export async function acceptBusinessQuotation(value, publicIdValue, input) {
  const data = businessInput(z.object({ version, paymentTerms: z.enum(['immediate','credit']).default('immediate') }).strict(), input);
  return businessTransaction(value, 'po', async (context, session) => {
    const quote = await QuoteRequest.findOne({ publicId: businessInput(id, publicIdValue), organizationId: context.org._id, status: 'responded', validUntil: mongoose.trusted({ $gt: new Date() }) }).session(session);
    if (!quote) throw new AppError('A current seller quotation is required.', 409, 'BUSINESS_QUOTE_UNAVAILABLE');
    assertBusinessVersion(quote, data.version);
    const procurement = await ProcurementRequest.findOne({ _id: quote.procurementRequestId, organizationId: context.org._id, status: mongoose.trusted({ $in: ['approved','partially_ordered'] }), closedAt: null }).session(session);
    if (!procurement || !procurement.approvedAt || !procurement.approvedByUserId || businessSame(procurement.requesterUserId, procurement.approvedByUserId)) throw new AppError('Independent procurement approval is required.', 409, 'BUSINESS_APPROVAL_REQUIRED');
    const policy = businessCommercialPolicy(procurement.commercialPolicy);
    const coverage = await businessCoverage(procurement, session);
    const remaining = procurement.items.filter(line => line.storePublicId === quote.storePublicId && line.quantity > (coverage.quantities.get(line.variantPublicId) || 0));
    if (remaining.length !== quote.items.length || quote.items.some(line => { const source=remaining.find(item=>item.variantPublicId===line.variantPublicId); return !source || source.productPublicId!==line.productPublicId || source.sku!==line.sku || line.quantity!==source.quantity-(coverage.quantities.get(line.variantPublicId)||0); })) throw new AppError('The quotation no longer matches remaining approved quantities.', 409, 'BUSINESS_QUANTITY_EXCEEDED');
    await validateBusinessItems(context, quote.items, session);
    const subtotal = safeTotal(quote.items.reduce((sum,line) => sum+safeTotal(line.offeredUnitMinor*line.quantity),0));
    const taxMinor = taxFor(subtotal, policy.taxBps), total = safeTotal(subtotal+taxMinor);
    const approvedAmount = businessApprovedAmount(procurement, quote.items, coverage.quantities);
    if (quote.items.some(line => !Number.isSafeInteger(line.offeredUnitMinor) || line.offeredLineMinor!==line.offeredUnitMinor*line.quantity) || quote.offeredTotalMinor!==total || total>approvedAmount || quote.approvedAmountMinor!==approvedAmount) throw new AppError('The seller offer exceeds or no longer matches its approved amount.', 409, 'BUSINESS_OFFER_INVALID');
    if (data.paymentTerms==='credit' && (!context.org.invoiceTermsApproved || !context.org.creditApprovedAt || !context.org.creditApprovedByUserId || businessSame(context.org.creditApprovedByUserId,context.org.creditRequestedByUserId) || context.org.invoiceTermsDays<=0 || await businessCreditExposure(context.org._id,session)+total>context.org.creditLimitMinor)) throw new AppError('Independently approved credit terms and sufficient credit are required.',409,'BUSINESS_CREDIT_NOT_APPROVED');
    await fenceBusinessRecord(ProcurementRequest,procurement,session,{status:procurement.status,closedAt:null});
    await issueQuotationDocument(quote,{session,issuedByUserId:context.actor._id});
    quote.status='accepted';quote.acceptedAt=new Date();await quote.save({session});
    const poId=publicId('bpo');
    const [po]=await PurchaseOrder.create([{publicId:poId,poNumber:`CM-${poId.toUpperCase()}`,organizationId:context.org._id,quoteRequestId:quote._id,procurementRequestId:procurement._id,storeId:quote.storeId,storePublicId:quote.storePublicId,issuedByUserId:context.actor._id,issuerTokenVersion:context.actor.security.tokenVersion,country:context.org.country,currency:context.org.currency,items:quote.items.map(line=>({productPublicId:line.productPublicId,variantPublicId:line.variantPublicId,sku:line.sku,title:line.title,variantTitle:line.variantTitle,quantity:line.quantity,unitMinor:line.offeredUnitMinor,lineMinor:line.offeredLineMinor})),approvedAmountMinor:approvedAmount,subtotalMinor:subtotal,taxBps:policy.taxBps,taxMinor,taxPolicyVersion:policy.policyVersion,totalMinor:total,commercialPolicy:policy,paymentTerms:data.paymentTerms,invoiceTermsDays:data.paymentTerms==='credit'?context.org.invoiceTermsDays:0,timeline:[event('issued','Buyer reviewed the seller offer and issued this purchase order.',context.actor)]}],{session});
    await issuePurchaseOrderDocument(po,{session,issuedByUserId:context.actor._id});await audit(context,session,'business.purchase_order.issued',po);return clean(po);
  });
}
export async function cancelBusinessProcurement(value, publicIdValue, input) {
  const data=businessInput(z.object({version,reason:z.string().trim().min(1).max(500)}).strict(),input);
  return businessTransaction(value,'buy',async(context,session)=>{
    const row=await ProcurementRequest.findOne({publicId:businessInput(id,publicIdValue),organizationId:context.org._id,closedAt:null,status:mongoose.trusted({$in:['submitted','approved','partially_ordered','ordered']})}).session(session);
    if(!row)throw new AppError('Open procurement request not found.',404,'BUSINESS_REQUEST_NOT_FOUND');assertBusinessVersion(row,data.version);
    if(!businessSame(row.requesterUserId,context.actor._id)&&!['owner','admin'].includes(context.member.role))throw new AppError('Only the requester or a business administrator may close this request.',403,'BUSINESS_CAPABILITY_REQUIRED');
    const orders=await PurchaseOrder.find({procurementRequestId:row._id,status:mongoose.trusted({$in:['issued','accepted','payment_pending','processing','fulfilled']})}).session(session);
    const consumed=orders.filter(po=>po.status!=='issued').reduce((sum,po)=>sum+po.approvedAmountMinor,0);
    const release=row.approvedAt?Math.max(0,row.estimatedTotalMinor-consumed):0;
    if(release&&row.budgetId){const update=await BusinessBudget.updateOne({_id:row.budgetId,organizationId:context.org._id,committedMinor:mongoose.trusted({$gte:release})},{$inc:{committedMinor:-release,__v:1}},{session});if(update.modifiedCount!==1)throw new AppError('The remaining approved budget could not be released safely.',409,'BUSINESS_BUDGET_CONFLICT');}
    for(const po of orders.filter(item=>item.status==='issued')){po.status='cancelled';po.timeline.push(event('cancelled',data.reason,context.actor));await po.save({session});}
    await QuoteRequest.updateMany({procurementRequestId:row._id,status:mongoose.trusted({$in:['requested','responded','negotiating']})},{$set:{status:'rejected'},$inc:{__v:1}},{session});
    row.status=consumed?'ordered':'cancelled';row.closedAt=new Date();row.closeReason=data.reason;row.timeline.push(event('closed',data.reason,context.actor));await row.save({session});await audit(context,session,'business.procurement.closed',row,{releasedMinor:release});return clean(row);
  });
}
export async function saveBusinessTemplate(value,input){
  const data=businessInput(z.object({name:z.string().trim().min(1).max(140),recurrence:z.enum(['none','weekly','monthly']),budgetId:id.optional().or(z.literal('')),items:itemsInput,idempotencyKey:key}).strict(),input);
  return businessTransaction(value,'templates',async(context,session)=>{
    await validateBusinessItems(context,data.items,session);
    const budget=data.budgetId?await BusinessBudget.findOne({publicId:data.budgetId,organizationId:context.org._id,active:true}).session(session):null;
    if(data.budgetId&&!budget)throw new AppError('Select an active business budget.',409,'BUSINESS_BUDGET_UNAVAILABLE');
    const items=[];for(const item of data.items){const variant=await ProductVariant.findOne({publicId:item.variantPublicId}).session(session);const product=await Product.findById(variant.productId).session(session);items.push({productPublicId:product.publicId,variantPublicId:variant.publicId,quantity:item.quantity});}
    const [row]=await ProcurementTemplate.create([{publicId:publicId('bpt'),organizationId:context.org._id,name:data.name,items,recurrence:data.recurrence,nextDueAt:data.recurrence==='none'?undefined:nextRun(new Date(),data.recurrence),createdByUserId:context.actor._id,creatorTokenVersion:context.actor.security.tokenVersion,budgetId:budget?._id,operationKey:data.idempotencyKey}],{session});await audit(context,session,'business.template.created',row);return clean(row);
  });
}
function nextRun(date,recurrence){const next=new Date(date);if(recurrence==='weekly')next.setUTCDate(next.getUTCDate()+7);else{const day=next.getUTCDate();next.setUTCDate(1);next.setUTCMonth(next.getUTCMonth()+1);const last=new Date(Date.UTC(next.getUTCFullYear(),next.getUTCMonth()+1,0)).getUTCDate();next.setUTCDate(Math.min(day,last));}return next;}
async function runTemplateAuthority(context,row,session){
  const user=await User.findById(row.createdByUserId).session(session);
  if(!user||row.creatorTokenVersion===undefined)throw new AppError('The template creator must create a new template after account access changes.',403,'BUSINESS_TEMPLATE_CREATOR_UNAVAILABLE');
  const creator=await businessAccess({user:{_id:user._id,security:{tokenVersion:row.creatorTokenVersion}},get:()=>''},{session,capability:'buy',organizationPublicId:context.org.publicId});
  requireBusinessCapability(creator,'templates');
  // The current administrator may resume a creator's schedule only while that
  // creator retains the exact original account and accepted purchasing access.
  if(!businessSame(creator.actor._id,context.actor._id)){
    await fenceBusinessRecord(User,creator.actor,session,{status:'active','security.tokenVersion':row.creatorTokenVersion});
    await fenceBusinessRecord(BusinessMember,creator.member,session,{status:'active',role:creator.member.role});
  }
  if(row.budgetId&&!await BusinessBudget.exists({_id:row.budgetId,organizationId:context.org._id,active:true,currency:context.org.currency,periodStart:mongoose.trusted({$lte:new Date()}),periodEnd:mongoose.trusted({$gt:new Date()})}).session(session))throw new AppError('The template needs an active company budget.',409,'BUSINESS_BUDGET_UNAVAILABLE');
  return creator;
}
async function runTemplate(context,row,session,operationKey){
  if(!businessSame(row.createdByUserId,context.actor._id)||row.creatorTokenVersion!==context.actor.security.tokenVersion)throw new AppError('Only the currently authorized template creator can run this template.',403,'BUSINESS_TEMPLATE_CREATOR_UNAVAILABLE');
  requireBusinessCapability(context,'buy');
  const budget=row.budgetId?await BusinessBudget.findOne({_id:row.budgetId,organizationId:context.org._id}).session(session):null;
  if(row.budgetId&&!budget)throw new AppError('The original template budget is unavailable.',409,'BUSINESS_BUDGET_UNAVAILABLE');
  return submitWithin(context,{title:row.name,items:row.items.map(item=>({variantPublicId:item.variantPublicId,quantity:item.quantity})),budgetId:budget?.publicId,idempotencyKey:operationKey},session);
}
export async function actBusinessTemplate(value,publicIdValue,input){
  const data=businessInput(z.object({version,action:z.enum(['run','pause','resume'])}).strict(),input);
  return businessTransaction(value,'templates',async(context,session)=>{
    const row=await ProcurementTemplate.findOne({publicId:businessInput(id,publicIdValue),organizationId:context.org._id}).session(session);if(!row)throw new AppError('Procurement template not found.',404,'BUSINESS_TEMPLATE_NOT_FOUND');assertBusinessVersion(row,data.version);
    if(!businessSame(row.createdByUserId,context.actor._id)&&!['owner','admin'].includes(context.member.role))throw new AppError('Only its creator or business administrator may manage this template.',403,'BUSINESS_CAPABILITY_REQUIRED');
    let request;
    if(data.action==='run'){if(!row.active)throw new AppError('Resume this template before running it.',409,'BUSINESS_TEMPLATE_PAUSED');request=await runTemplate(context,row,session,`manual:${row.publicId}:${data.version}`);row.markModified('active');}
    else{row.active=data.action==='resume';if(row.active&&row.recurrence!=='none'){await runTemplateAuthority(context,row,session);row.nextDueAt=nextRun(new Date(),row.recurrence);}if(row.active){row.lastFailureAt=undefined;row.lastFailureCode=undefined;}}
    await row.save({session});await audit(context,session,'business.template.'+data.action,row);return request?clean(request):clean(row);
  });
}
export async function processBusinessRecurrence(now=new Date(),{limit=50}={}){
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||!Number.isSafeInteger(limit)||limit<1)throw new AppError('The recurring request batch is invalid.',422,'BUSINESS_RECURRENCE_INPUT_INVALID');
  const due=await ProcurementTemplate.find({active:true,recurrence:mongoose.trusted({$in:['weekly','monthly']}),nextDueAt:mongoose.trusted({$lte:now})}).sort({nextDueAt:1,_id:1}).limit(Math.min(100,limit)).select('_id __v nextDueAt').lean();
  let created=0,skipped=0;
  for(const candidate of due){const session=await mongoose.startSession();try{await session.withTransaction(async()=>{
    const row=await ProcurementTemplate.findOne({_id:candidate._id,active:true,nextDueAt:mongoose.trusted({$lte:now})}).session(session);if(!row){skipped++;return;}
    const scheduledFor=row.nextDueAt;
    if(await ProcurementRun.exists({templateId:row._id,scheduledFor}).session(session)){skipped++;return;}
    const user=await User.findById(row.createdByUserId).session(session);const org=await BusinessOrganization.findById(row.organizationId).session(session);
    if(!user||!org||row.creatorTokenVersion===undefined)throw new AppError('Recurring template creator needs current authorization.',403,'BUSINESS_TEMPLATE_CREATOR_UNAVAILABLE');
    const request={id:`business-recurrence:${row.publicId}:${scheduledFor.toISOString()}`,user:{_id:user._id,security:{tokenVersion:row.creatorTokenVersion}},get:()=>'',ip:''};
    const context=await businessAccess(request,{session,capability:'templates',organizationPublicId:org.publicId});
    const {fenceBusinessAccess}=await import('./business-access.js');await fenceBusinessAccess(context,session);
    const [run]=await ProcurementRun.create([{publicId:publicId('bprun'),templateId:row._id,templatePublicId:row.publicId,organizationId:row.organizationId,scheduledFor}],{session});
    const procurement=await runTemplate(context,row,session,`recurrence:${run.publicId}`);
    run.status='completed';run.procurementRequestId=procurement._id;run.procurementRequestPublicId=procurement.publicId;run.completedAt=new Date();await run.save({session});
    row.nextDueAt=nextRun(scheduledFor,row.recurrence);await row.save({session});await audit(context,session,'business.recurrence.created',row,{requestPublicId:procurement.publicId,scheduledFor});created++;
  });}catch(error){if(error?.code===11000||error?.name==='VersionError')skipped++;else if(error instanceof AppError&&error.status<500){
    await session.withTransaction(async()=>{const paused=await ProcurementTemplate.findOneAndUpdate({_id:candidate._id,active:true,__v:candidate.__v,nextDueAt:candidate.nextDueAt},{$set:{active:false,lastFailureAt:new Date(),lastFailureCode:String(error.code||'BUSINESS_TEMPLATE_UNAVAILABLE').slice(0,100)},$inc:{__v:1}},{session,returnDocument:'after'});if(paused)await writeAudit({id:`business-recurrence-pause:${paused.publicId}:${candidate.nextDueAt.toISOString()}`,get:()=>'',ip:''},'business.recurrence.paused',{targetType:'procurement_template',targetPublicId:paused.publicId,metadata:{reason:error.code,organizationId:String(paused.organizationId)},session});});skipped++;
  }else throw error;}finally{await session.endSession();}}
  return{checked:due.length,created,skipped};
}
export async function requestBusinessCreditTerms(value,input){
  const data=businessInput(z.object({version,limitMinor:money.refine(v=>v>0),termsDays:z.coerce.number().int().min(1).max(120)}).strict(),input);
  return businessTransaction(value,'members',async(context,session)=>{assertBusinessVersion(context.org,data.version+1);context.org.creditRequestedAt=new Date();context.org.creditRequestedByUserId=context.actor._id;context.org.creditRequesterTokenVersion=context.actor.security.tokenVersion;context.org.creditRequestedLimitMinor=data.limitMinor;context.org.creditRequestedTermsDays=data.termsDays;await context.org.save({session});await audit(context,session,'business.credit.requested',context.org);return clean(context.org);});
}

/** Actual independently reviewed credit terms; never inferred from a staff form. */
export async function reviewBusinessCreditTerms(request,organizationPublicId,input){
  const data=businessInput(z.object({version,decision:z.enum(['approve','reject','revoke']),limitMinor:money.optional(),termsDays:z.coerce.number().int().min(1).max(120).optional(),reason:z.string().trim().min(10).max(1000)}).strict(),input);
  const session=await mongoose.startSession();
  try{return await session.withTransaction(async()=>{
    const org=await BusinessOrganization.findOne({publicId:businessInput(id,organizationPublicId)}).session(session);
    if(!org)throw new AppError('Business organization not found.',404,'BUSINESS_ORG_NOT_FOUND');
    const staff=await countryAdminAccess(request,{session,write:true,workspace:false,country:org.country});
    if(!staff.grant)throw new AppError('An active reviewed staff grant is required.',403,'BUSINESS_CREDIT_REVIEW_FORBIDDEN');
    assertBusinessVersion(org,data.version);
    if(businessSame(staff.actor._id,org.ownerUserId)||businessSame(staff.actor._id,org.creditRequestedByUserId))throw new AppError('Another authorized staff reviewer must decide these terms.',403,'BUSINESS_INDEPENDENT_APPROVAL_REQUIRED');
    if(data.decision!=='revoke'){
      if(!org.creditRequestedAt||!org.creditRequestedByUserId||org.creditRequesterTokenVersion===undefined||org.creditReviewedAt&&org.creditReviewedAt>=org.creditRequestedAt)throw new AppError('A current unreviewed company credit request is required.',409,'BUSINESS_CREDIT_REQUEST_UNAVAILABLE');
      const requester=await businessAccess({user:{_id:org.creditRequestedByUserId,security:{tokenVersion:org.creditRequesterTokenVersion}},get:()=>''},{session,capability:'members',organizationPublicId:org.publicId});
      await fenceBusinessRecord(User,requester.actor,session,{status:'active','security.tokenVersion':org.creditRequesterTokenVersion});
      await fenceBusinessRecord(BusinessMember,requester.member,session,{status:'active',role:requester.member.role});
      if(data.decision==='approve'){
        if(!Number.isSafeInteger(data.limitMinor)||data.limitMinor<=0||data.limitMinor>org.creditRequestedLimitMinor||!data.termsDays||data.termsDays>org.creditRequestedTermsDays)throw new AppError('Approved credit must stay within the company’s requested limit and term.',422,'BUSINESS_CREDIT_TERMS_INVALID');
        if(await businessCreditExposure(org._id,session)>data.limitMinor)throw new AppError('The credit limit is below current invoice and purchase-order exposure.',409,'BUSINESS_CREDIT_LIMIT');
        org.invoiceTermsApproved=true;org.creditLimitMinor=data.limitMinor;org.invoiceTermsDays=data.termsDays;org.creditApprovedByUserId=staff.actor._id;org.creditApprovedAt=new Date();org.creditApprovedRequestAt=org.creditRequestedAt;
      }
    }else{org.invoiceTermsApproved=false;org.creditLimitMinor=0;org.invoiceTermsDays=0;}
    org.creditReviewedAt=new Date();org.creditReviewedByUserId=staff.actor._id;org.creditReviewDecision=data.decision;org.creditReviewReason=data.reason;
    await org.save({session});
    await writeAudit(request,'business.credit.'+data.decision,{actor:staff.actor,country:org.country,targetType:'business_organization',targetPublicId:org.publicId,metadata:{limitMinor:org.creditLimitMinor,termsDays:org.invoiceTermsDays,reason:data.reason},session});
    return clean(org);
  });}finally{await session.endSession();}
}
export function parseProcurementCsv(source){
  if(typeof source!=='string'||Buffer.byteLength(source)>500_000)throw new AppError('Upload a CSV smaller than 500 KB.',422,'BUSINESS_CSV_INVALID');
  const rows=source.replace(/^\uFEFF/,'').trim().split(/\r?\n/);
  if(rows.shift()?.trim()!=='variantPublicId,quantity,note'||rows.length>500)throw new AppError('Use the supplied CSV template with at most 500 rows.',422,'BUSINESS_CSV_INVALID');
  // Quoted notes may contain commas; embedded line breaks are intentionally unsupported.
  const items=rows.filter(Boolean).map(line=>{const match=/^([^,]+),(\d+),(?:"((?:[^"]|"")*)"|([^",]*))$/.exec(line);if(!match)throw new AppError('A CSV row is malformed.',422,'BUSINESS_CSV_INVALID');return{variantPublicId:match[1].trim(),quantity:Number(match[2]),note:(match[3]??match[4]??'').replaceAll('""','"').trim()};});
  return businessInput(itemsInput,items);
}

import { z } from 'zod';
import crypto from 'node:crypto';
import { AppError } from '../core/errors.js';
import { env } from '../config/env.js';
import { publicId } from '../core/ids.js';
import { SubscriptionPlan, SubscriptionChangeRequest, SubscriptionEnrollment, Store, StoreMember, User, CountrySetting, PlatformGrant } from '../models/index.js';
import { SubscriptionCharge } from '../models/SubscriptionCharge.js';
import { DEFAULT_SELLER_ENTITLEMENTS } from '../models/subscription-terms.js';
import { sellerOperationsAccess, sellerTransaction, sellerVersion, sellerConflict, sameSellerId } from './seller-operations-access.js';
import { submitPesapalOrder, getPesapalTransactionStatus } from './pesapal.js';
import { writeAudit } from './audit.js';
import { ensureLedgerAccount, postLedgerTransaction } from './money.js';
import { cursorScope, cursorSort, pageResult } from './pagination.js';
const systemRequest = { id: 'pesapal-subscription', ip: '', get: () => '' };
const version = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const factor = currency => ['UGX', 'RWF', 'JPY', 'KRW'].includes(currency) ? 1 : 100;
export function sellerPlanTerms(plan) { return { planPublicId: plan.publicId, planVersion: plan.__v || 0, name: plan.name, priceMinor: plan.priceMinor, currency: plan.currency, country: plan.country, cadence: plan.cadence, entitlements: { ...DEFAULT_SELLER_ENTITLEMENTS, ...(plan.entitlements?.toObject?.() || plan.entitlements || {}) } }; }
function termsEqual(left, right) {
  if (!left || !right) return false;
  return ['planPublicId', 'planVersion', 'name', 'priceMinor', 'currency', 'country', 'cadence'].every(key => left[key] === right[key])
    && Object.keys(DEFAULT_SELLER_ENTITLEMENTS).every(key => left.entitlements?.[key] === right.entitlements?.[key]);
}
function exactMinor(amount, currency) {
  const raw = String(amount ?? '');
  if (!/^(?:0|[1-9]\d{0,14})(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, decimals = ''] = raw.split('.');
  if (factor(currency) === 1 && Number(decimals || 0) !== 0) return null;
  const result = Number(BigInt(whole) * BigInt(factor(currency)) + BigInt(factor(currency) === 1 ? 0 : decimals.padEnd(2, '0')));
  return Number.isSafeInteger(result) ? result : null;
}
const chargeDto = row => ({ publicId: row.publicId, requestPublicId: row.requestPublicId, planName: row.terms.name, amountMinor: row.amountMinor, currency: row.currency, status: row.status, checkoutUrl: row.checkoutUrl || '', paidAt: row.paidAt, holdReason: row.holdReason || '', canCheck: row.amountMinor === 0 || Boolean(row.providerTrackingId), createdAt: row.createdAt, version: row.__v || 0 });
function safeCheckout(value) { try { const url = new URL(value); const api = new URL(env.pesapal.baseUrl); return url.protocol === 'https:' && (url.hostname === api.hostname || /(?:^|\.)pesapal\.com$/.test(url.hostname)) && !url.username && !url.password ? url.href : ''; } catch { return ''; } }
function periodEnd(start, cadence) {
  if (cadence === 'one_time') return null;
  const end = new Date(start);
  const months = { monthly: 1, quarterly: 3, yearly: 12 }[cadence];
  const day = end.getUTCDate(); end.setUTCDate(1); end.setUTCMonth(end.getUTCMonth() + months); const targetMonth = end.getUTCMonth(); end.setUTCDate(day);
  if (end.getUTCMonth() !== targetMonth) end.setUTCDate(0);
  return end;
}
async function audit(request, action, row, session, metadata = {}) { return writeAudit(request || systemRequest, action, { targetType: 'subscription_charge', targetPublicId: row.publicId, country: row.country, session, metadata: { storePublicId: row.storePublicId, ...metadata } }); }

export async function requestReviewedSellerSubscription(request, raw) {
  const input = z.object({ planPublicId: z.string().trim().min(4).max(100), note: z.string().trim().max(1000).default('') }).parse(raw);
  return sellerTransaction(async session => {
    const context = await sellerOperationsAccess(request, 'staff', { session, write: true });
    const plan = await SubscriptionPlan.findOne({ publicId: input.planPublicId, audience: 'seller', country: context.store.country, currency: context.store.currency, status: 'active' }).session(session);
    if (!plan) throw new AppError('Plan not found for this market.', 422, 'SUBSCRIPTION_PLAN_UNAVAILABLE');
    if (await SubscriptionChangeRequest.exists({ audience: 'seller', storeId: context.store._id, status: 'requested' }).session(session)) throw new AppError('A subscription change is already awaiting review.', 409, 'SUBSCRIPTION_CHANGE_PENDING');
    const fenced = await SubscriptionPlan.updateOne({ _id: plan._id, status: 'active', __v: plan.__v || 0 }, { $inc: { subscriptionReadRevision: 1 } }, { session }); if (fenced.modifiedCount !== 1) throw sellerConflict();
    const [row] = await SubscriptionChangeRequest.create([{ publicId: publicId('scr'), audience: 'seller', userId: context.actor._id, storeId: context.store._id, storePublicId: context.store.publicId, planId: plan._id, planPublicId: plan.publicId, country: context.store.country, currency: context.store.currency, requestedPriceMinor: plan.priceMinor, requestedCadence: plan.cadence, terms: sellerPlanTerms(plan), note: input.note }], { session });
    await writeAudit(request, 'seller.subscription_change_requested', { actor: context.actor, session, targetType: 'subscription_change_request', targetPublicId: row.publicId, country: row.country, metadata: { storePublicId: context.store.publicId } });
    return row;
  });
}

/** Called by the independently authorized Super Admin review transaction. */
export async function reviewSellerSubscriptionRequest(request, id, raw, { session, actor } = {}) {
  const input = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().min(5).max(1000), version }).parse(raw);
  if (!session?.inTransaction()) throw new AppError('Independent Super Admin authorization is required.', 403, 'SUBSCRIPTION_REVIEW_FORBIDDEN');
  const { superAdminAccess } = await import('./super-admin-access.js');
  const authority = await superAdminAccess(request, { session, write: true });
  if (actor && !sameSellerId(authority.actor._id, actor._id)) throw new AppError('The reviewing identity changed.', 403, 'SUBSCRIPTION_REVIEW_FORBIDDEN');
  actor = authority.actor;
  const row = await SubscriptionChangeRequest.findOne({ publicId: id, audience: 'seller' }).session(session);
  if (!row) throw new AppError('Subscription request not found.', 404, 'SUBSCRIPTION_REQUEST_NOT_FOUND');
  sellerVersion(row, input.version);
  if (row.status !== 'requested' || !row.terms) throw new AppError('This request is no longer reviewable. Submit a current plan request.', 409, 'SUBSCRIPTION_REQUEST_STATE');
  const store = await Store.findOne({ _id: row.storeId, publicId: row.storePublicId, country: row.country, currency: row.currency }).session(session);
  const plan = await SubscriptionPlan.findOne({ _id: row.planId, publicId: row.planPublicId, country: row.country, currency: row.currency, audience: 'seller', status: 'active' }).session(session);
  if (input.decision === 'approve' && (!store || !['pending_verification', 'verified'].includes(store.status) || !plan
    || !authority.countries.some(country => country.code === row.country && country.currency === row.currency)
    || !termsEqual(row.terms, sellerPlanTerms(plan)))) throw new AppError('The plan or store changed. Submit a new request with current terms.', 409, 'SUBSCRIPTION_TERMS_CHANGED');
  if (sameSellerId(actor._id, row.userId) || sameSellerId(actor._id, store?.ownerUserId) || await StoreMember.exists({ storeId: row.storeId, userId: actor._id, status: { $in: ['active', 'invited'] } }).session(session)) throw new AppError('An independent reviewer must decide this subscription.', 403, 'SUBSCRIPTION_REVIEW_CONFLICT');
  if (store) { const fence = await Store.updateOne({ _id: store._id, __v: store.__v || 0 }, { $inc: { __v: 1 } }, { session }); if (fence.modifiedCount !== 1) throw sellerConflict(); }
  if (input.decision === 'approve') { const planFence = await SubscriptionPlan.updateOne({ _id: plan._id, __v: plan.__v || 0, status: 'active' }, { $inc: { subscriptionReadRevision: 1 } }, { session }); if (planFence.modifiedCount !== 1) throw sellerConflict(); }
  row.status = input.decision === 'approve' ? 'approved' : 'rejected'; row.reviewReason = input.reason; row.reviewedByUserId = actor._id; row.reviewedAt = new Date(); if (row.status === 'approved') row.approvedTerms = row.terms.toObject(); await row.save({ session });
  await writeAudit(request, 'super_admin.subscription_request_reviewed', { actor, session, targetType: 'subscription_change_request', targetPublicId: row.publicId, country: row.country, metadata: { decision: input.decision, storePublicId: row.storePublicId } });
  return row;
}

export async function startSellerSubscriptionPayment(request, raw) {
  const input = z.object({ requestPublicId: z.string().trim().min(4).max(100), idempotencyKey: z.string().trim().min(12).max(120), version }).parse(raw);
  const prepared = await sellerTransaction(async session => {
    const context = await sellerOperationsAccess(request, 'staff', { session, write: true });
    const change = await SubscriptionChangeRequest.findOne({ publicId: input.requestPublicId, audience: 'seller', storeId: context.store._id, country: context.store.country, currency: context.store.currency }).session(session);
    if (!change) throw new AppError('Approved subscription request not found.', 404, 'SUBSCRIPTION_REQUEST_NOT_FOUND');
    const prior = await SubscriptionCharge.findOne({ storeId: context.store._id, idempotencyKey: input.idempotencyKey }).session(session);
    if (prior) { if (!sameSellerId(prior.requestId, change._id)) throw new AppError('This payment key belongs to a different request.', 409, 'SUBSCRIPTION_IDEMPOTENCY_CONFLICT'); return { charge: prior, actor: context.actor, submit: false }; }
    sellerVersion(change, input.version);
    if (change.status !== 'approved' || !change.approvedTerms || !change.reviewedByUserId || sameSellerId(change.reviewedByUserId, change.userId)) throw new AppError('An independently approved request is required before payment.', 409, 'SUBSCRIPTION_APPROVAL_REQUIRED');
    const active = await SubscriptionCharge.findOne({ activeKey: String(context.store._id) }).session(session);
    if (active) throw new AppError('A subscription payment is pending or held. Reconcile it before another charge.', 409, 'SUBSCRIPTION_CHARGE_PENDING');
    const upcoming = await SubscriptionEnrollment.exists({ storeId: context.store._id, audience: 'seller', status: 'active', startsAt: { $gt: new Date() }, reversedAt: null }).session(session);
    if (change.approvedTerms.cadence === 'one_time' && await SubscriptionEnrollment.exists({ storeId: context.store._id, audience: 'seller', planPublicId: change.planPublicId, status: 'active', reversedAt: null }).session(session)) throw new AppError('This one-time plan is already active.', 409, 'SUBSCRIPTION_ALREADY_ACTIVE');
    if (upcoming) throw new AppError('The next subscription period is already paid.', 409, 'SUBSCRIPTION_RENEWAL_ALREADY_PAID');
    const terms = change.approvedTerms.toObject(), id = publicId('sch');
    const changeFence = await SubscriptionChangeRequest.updateOne({ _id: change._id, status: 'approved', __v: change.__v || 0 }, { $inc: { __v: 1 } }, { session }); if (changeFence.modifiedCount !== 1) throw sellerConflict();
    const [charge] = await SubscriptionCharge.create([{ publicId: id, requestId: change._id, requestPublicId: change.publicId, userId: context.actor._id, payerTokenVersion: context.actor.security.tokenVersion, payerMembershipId: context.member._id, storeId: context.store._id, storePublicId: context.store.publicId, country: context.store.country, currency: context.store.currency, amountMinor: terms.priceMinor, terms, idempotencyKey: input.idempotencyKey, providerReference: id, status: terms.priceMinor ? 'submitting' : 'pending', submissionAttemptedAt: new Date(), activeKey: String(context.store._id) }], { session });
    await audit(request, 'seller.subscription_payment_started', charge, session, { amountMinor: charge.amountMinor, currency: charge.currency }); return { charge, actor: context.actor, submit: Boolean(terms.priceMinor) };
  });
  if (!prepared.submit) {
    if (prepared.charge.amountMinor === 0 && prepared.charge.status === 'pending') await applySubscriptionVerification(prepared.charge.publicId, { payment_status_description: 'COMPLETED', merchant_reference: prepared.charge.providerReference, amount: 0, currency: prepared.charge.currency }, '', request);
    return chargeDto(await SubscriptionCharge.findById(prepared.charge._id));
  }
  const { charge, actor } = prepared;
  const parts = actor.name.trim().split(/\s+/), firstName = parts.shift() || 'Seller';
  try {
    const result = await submitPesapalOrder({ id: charge.providerReference, amount: charge.amountMinor / factor(charge.currency), currency: charge.currency, description: `Classic Mart ${charge.terms.name} subscription`, callback_url: `${env.baseUrl}/seller/subscription/return`, billing_address: { email_address: actor.email, phone_number: actor.phone, country_code: charge.country, first_name: firstName, last_name: parts.join(' ') || 'Seller', line_1: 'Classic Mart subscription', city: '', state: '', postal_code: '', zip_code: '' } });
    const checkoutUrl = safeCheckout(result?.redirect_url), tracking = String(result?.order_tracking_id || '');
    if (!checkoutUrl || !/^[A-Za-z0-9_-]{4,160}$/.test(tracking) || result.merchant_reference && result.merchant_reference !== charge.providerReference) throw new AppError('The payment submission requires reconciliation.', 502, 'SUBSCRIPTION_SUBMIT_UNKNOWN');
    await SubscriptionCharge.updateOne({ _id: charge._id, status: 'submitting' }, { $set: { checkoutUrl, providerTrackingId: tracking, status: 'requires_action' }, $inc: { __v: 1 } });
    return chargeDto(await SubscriptionCharge.findById(charge._id));
  } catch (error) {
    const notSubmitted = ['PAYMENT_PROVIDER_UNAVAILABLE', 'PESAPAL_IPN_NOT_CONFIGURED'].includes(error.code);
    await SubscriptionCharge.updateOne({ _id: charge._id, status: 'submitting' }, { $set: { status: notSubmitted ? 'failed' : 'held', failureCode: notSubmitted ? error.code : 'SUBMISSION_OUTCOME_UNKNOWN', holdReason: notSubmitted ? '' : 'Submission outcome is unknown. Reconcile this reference before another payment.' }, ...(notSubmitted ? { $unset: { activeKey: 1 } } : {}), $inc: { __v: 1 } });
    throw error;
  }
}

async function postChargeMoney(charge, session, reversal = false) {
  if (!charge.amountMinor) return;
  const clearing = await ensureLedgerAccount({ code: 'provider_clearing', type: 'asset', ownerType: 'provider', ownerPublicId: 'pesapal', country: charge.country, currency: charge.currency }, session);
  const revenue = await ensureLedgerAccount({ code: 'subscription_revenue', type: 'revenue', ownerType: 'platform', ownerPublicId: 'classic-mart', country: charge.country, currency: charge.currency }, session);
  await postLedgerTransaction({ idempotencyKey: `subscription-${reversal ? 'reversal' : 'payment'}:${charge.publicId}`, referenceType: reversal ? 'subscription_reversal' : 'subscription_payment', referencePublicId: charge.publicId, country: charge.country, currency: charge.currency, description: `Verified subscription ${reversal ? 'reversal' : 'payment'} ${charge.publicId}`, entries: [{ account: clearing, debitMinor: reversal ? 0 : charge.amountMinor, creditMinor: reversal ? charge.amountMinor : 0 }, { account: revenue, debitMinor: reversal ? charge.amountMinor : 0, creditMinor: reversal ? 0 : charge.amountMinor }] }, session);
}

async function applySubscriptionVerification(id, data, tracking, request = null, administrativeRecovery = null) {
  return sellerTransaction(async session => {
    const charge = await SubscriptionCharge.findOne({ publicId: id }).session(session);
    if (!charge) throw new AppError('Subscription payment not found.', 404, 'SUBSCRIPTION_CHARGE_NOT_FOUND');
    if (administrativeRecovery) {
      const { superAdminAccess } = await import('./super-admin-access.js');
      const authority = await superAdminAccess(request, { session, write: true, country: charge.country });
      sellerVersion(charge, administrativeRecovery.version);
      const recoveryStore = await Store.findById(charge.storeId).session(session);
      if (sameSellerId(authority.actor._id, charge.userId) || sameSellerId(authority.actor._id, recoveryStore?.ownerUserId)
        || await StoreMember.exists({ storeId: charge.storeId, userId: authority.actor._id, status: { $in: ['active', 'invited'] } }).session(session)) throw new AppError('An independent reviewer must reconcile this payment.', 403, 'SUBSCRIPTION_REVIEW_CONFLICT');
      await writeAudit(request, 'super_admin.subscription_payment_reconciled', { actor: authority.actor, session, targetType: 'subscription_charge', targetPublicId: charge.publicId, country: charge.country, metadata: { reason: administrativeRecovery.reason } });
    }
    if (charge.providerTrackingId && tracking !== charge.providerTrackingId) throw new AppError('Provider tracking reference mismatch.', 400, 'PESAPAL_REFERENCE_MISMATCH');
    if (String(data?.merchant_reference || '') !== charge.providerReference || String(data?.currency || '').toUpperCase() !== charge.currency || exactMinor(data?.amount, charge.currency) !== charge.amountMinor) throw new AppError('Provider amount, currency or reference did not match the subscription.', 409, 'SUBSCRIPTION_VERIFICATION_MISMATCH');
    const providerStatus = String(data?.payment_status_description || data?.status_description || '').trim().toUpperCase();
    charge.lastVerifiedAt = new Date(); charge.providerStatus = providerStatus; if (tracking) charge.providerTrackingId = tracking;
    if (data?.confirmation_code) charge.providerConfirmationCode = String(data.confirmation_code).slice(0, 180);
    if (['REVERSED', 'REFUNDED'].includes(providerStatus)) {
      if (charge.status === 'reversed') return charge;
      // Capacity writes take this same lock, so reversal cannot race a paid-limit write.
      await Store.updateOne({ _id: charge.storeId }, { $inc: { __v: 1 } }, { session });
      if (charge.paidAt) await postChargeMoney(charge, session, true);
      charge.status = 'reversed'; charge.reversedAt = new Date(); charge.activeKey = undefined;
      if (charge.enrollmentId) await SubscriptionEnrollment.updateOne({ _id: charge.enrollmentId, subscriptionChargeId: charge._id }, { $set: { status: 'cancelled', reversedAt: new Date() }, $inc: { __v: 1 } }, { session });
      await charge.save({ session }); await audit(request, 'subscription.payment_reversed', charge, session); return charge;
    }
    if (charge.status === 'reversed') return charge;
    if (providerStatus !== 'COMPLETED') {
      if (charge.paidAt) { await charge.save({ session }); return charge; }
      if (['FAILED', 'INVALID', 'CANCELLED'].includes(providerStatus)) { charge.status = providerStatus === 'CANCELLED' ? 'cancelled' : 'failed'; charge.activeKey = undefined; }
      else if (charge.status !== 'held') charge.status = 'pending';
      await charge.save({ session }); return charge;
    }
    // Verified money is posted even if authority was revoked while the provider was responding.
    if (!charge.paidAt) { await postChargeMoney(charge, session); charge.paidAt = new Date(); }
    if (charge.enrollmentId) { charge.status = 'succeeded'; charge.activeKey = undefined; await charge.save({ session }); return charge; }
    const change = await SubscriptionChangeRequest.findOne({ _id: charge.requestId, publicId: charge.requestPublicId, audience: 'seller', storeId: charge.storeId, country: charge.country, currency: charge.currency }).session(session);
    const store = await Store.findOne({ _id: charge.storeId, publicId: charge.storePublicId, country: charge.country, currency: charge.currency, status: { $in: ['verified', 'pending_verification'] } }).session(session);
    const owner = store && await User.findOne({ _id: store.ownerUserId, role: 'seller', status: 'active', platformAccessManagedAt: null }).session(session);
    const market = await CountrySetting.findOne({ code: charge.country, currency: charge.currency, active: true }).session(session);
    const authorization = charge.activationAuthorization || { userId: charge.userId, tokenVersion: charge.payerTokenVersion, membershipId: charge.payerMembershipId };
    const payer = Number.isSafeInteger(authorization.tokenVersion) && authorization.membershipId
      ? await User.findOne({ _id: authorization.userId, status: 'active', role: { $in: ['seller', 'customer'] }, platformAccessManagedAt: null,
        'security.tokenVersion': authorization.tokenVersion }).session(session) : null;
    const payerMember = payer && await StoreMember.findOne({ _id: authorization.membershipId, userId: payer._id, storeId: charge.storeId, status: 'active', role: { $in: ['owner', 'admin'] } }).session(session);
    const payerAvailable = payer && payerMember && (payerMember.role === 'owner' ? store && sameSellerId(store.ownerUserId, payer._id) && payer.role === 'seller' : payerMember.acceptedAt instanceof Date)
      && (env.auth.simpleLogin || payer.emailVerifiedAt && payer.onboardingCompletedAt && (!env.security.privilegedMfaRequired || payer.security.mfaEnabled))
      && !await PlatformGrant.exists({ userId: { $in: [payer._id, ...(store ? [store.ownerUserId] : [])] } }).session(session);
    if (!store || !owner || !market || !change || change.status !== 'approved' || !change.reviewedByUserId
      || !termsEqual(change.approvedTerms, charge.terms) || !payerAvailable) {
      charge.status = 'held'; charge.holdReason = 'Payment verified; activation is held until the store and reviewed request are available.'; await charge.save({ session }); await audit(request, 'subscription.payment_activation_held', charge, session); return charge;
    }
    for (const [Model, record] of [[Store, store], [SubscriptionChangeRequest, change], [CountrySetting, market], [User, payer], [StoreMember, payerMember], ...(!sameSellerId(owner._id, payer._id) ? [[User, owner]] : [])]) { const fence = await Model.updateOne({ _id: record._id, __v: record.__v || 0 }, { $inc: { __v: 1 } }, { session }); if (fence.modifiedCount !== 1) throw sellerConflict(); }
    const previous = await SubscriptionEnrollment.findOne({ audience: 'seller', storeId: store._id, status: 'active', reversedAt: null, currentPeriodEndsAt: { $gt: new Date() } }).sort({ currentPeriodEndsAt: -1 }).session(session);
    const startsAt = previous?.currentPeriodEndsAt || new Date(), endsAt = periodEnd(startsAt, charge.terms.cadence);
    const [enrollment] = await SubscriptionEnrollment.create([{ publicId: publicId('sen'), audience: 'seller', planId: change.planId, planPublicId: change.planPublicId, userId: change.userId, storeId: store._id, storePublicId: store.publicId, country: charge.country, currency: charge.currency, priceMinor: charge.amountMinor, terms: charge.terms.toObject(), subscriptionChargeId: charge._id, subscriptionChargePublicId: charge.publicId, startsAt, periodStartsAt: startsAt, periodEndsAt: endsAt, currentPeriodEndsAt: endsAt, status: 'active', assignedByUserId: change.reviewedByUserId }], { session });
    await SubscriptionChangeRequest.updateOne({ _id: change._id }, { $set: { paymentSettledAt: new Date() } }, { session });
    charge.enrollmentId = enrollment._id; charge.enrollmentPublicId = enrollment.publicId; charge.status = 'succeeded'; charge.activeKey = undefined; charge.holdReason = ''; await charge.save({ session }); await audit(request, 'subscription.payment_settled', charge, session, { enrollmentPublicId: enrollment.publicId }); return charge;
  });
}

export async function verifySellerSubscriptionPayment(id, trackingId = '', request = null) {
  const charge = await SubscriptionCharge.findOne({ publicId: id }); if (!charge) throw new AppError('Subscription payment not found.', 404, 'SUBSCRIPTION_CHARGE_NOT_FOUND');
  const tracking = String(trackingId || charge.providerTrackingId || '').trim();
  if (!tracking || charge.providerTrackingId && charge.providerTrackingId !== tracking) throw new AppError('The original payment tracking reference is required.', 409, 'PESAPAL_TRACKING_ID_REQUIRED');
  const data = await getPesapalTransactionStatus(tracking);
  return applySubscriptionVerification(id, data, tracking, request);
}
export async function processSubscriptionPesapalNotification(request, body = {}, query = {}) {
  const read = name => body?.[name] ?? query?.[name] ?? body?.[name[0].toLowerCase() + name.slice(1)] ?? query?.[name[0].toLowerCase() + name.slice(1)];
  const reference = read('OrderMerchantReference'), tracking = read('OrderTrackingId');
  if (typeof reference !== 'string' || typeof tracking !== 'string' || reference.length > 100 || tracking.length > 160) throw new AppError('Payment notification references are invalid.', 422, 'PESAPAL_NOTIFICATION_INVALID');
  const charge = await SubscriptionCharge.findOne({ providerReference: reference }); if (!charge) return null;
  await verifySellerSubscriptionPayment(charge.publicId, tracking, request); return { subscription: true, chargePublicId: charge.publicId };
}
export async function cancelSellerSubscription(request, id, raw) {
  const input = z.object({ version }).parse(raw);
  return sellerTransaction(async session => {
    const context = await sellerOperationsAccess(request, 'staff', { session, write: true, allowSuspended: true });
    const row = await SubscriptionEnrollment.findOne({ publicId: id, audience: 'seller', storeId: context.store._id, country: context.store.country, currency: context.store.currency }).session(session);
    if (!row) throw new AppError('Subscription enrollment not found.', 404, 'SUBSCRIPTION_ENROLLMENT_NOT_FOUND'); sellerVersion(row, input.version);
    if (row.status !== 'active' || !row.currentPeriodEndsAt || row.currentPeriodEndsAt <= new Date() || row.cancelAtPeriodEnd) throw new AppError('This period cannot be cancelled again.', 409, 'SUBSCRIPTION_CANCEL_STATE');
    row.cancelAtPeriodEnd = true; row.cancellationRequestedAt = new Date(); await row.save({ session });
    await writeAudit(request, 'seller.subscription_cancel_at_period_end', { actor: context.actor, session, country: row.country, targetType: 'subscription_enrollment', targetPublicId: row.publicId }); return row;
  });
}
export async function reconcileOwnedSellerSubscription(request, id, raw = {}) {
  const input = z.object({ authorizeActivation: z.union([z.literal('on'), z.literal('true'), z.literal(true)]).optional(),
    reason: z.string().trim().max(300).default(''), version: version.optional() }).parse(raw);
  if (input.authorizeActivation && input.reason.length < 10) throw new AppError('Explain why you are authorizing activation of this verified payment.', 422, 'SUBSCRIPTION_ACTIVATION_REASON_REQUIRED');
  const context = await sellerOperationsAccess(request, 'staff', { allowSuspended: true });
  const row = await SubscriptionCharge.findOne({ publicId: id, storeId: context.store._id, country: context.store.country, currency: context.store.currency });
  if (!row) throw new AppError('Subscription payment not found.', 404, 'SUBSCRIPTION_CHARGE_NOT_FOUND');
  if (input.authorizeActivation) await sellerTransaction(async session => {
    const current = await sellerOperationsAccess(request, 'staff', { session, write: true });
    if (current.member.role !== 'owner') throw new AppError('Only the current owner may authorize a held subscription activation.', 403, 'STORE_OWNER_REQUIRED');
    const charge = await SubscriptionCharge.findOne({ _id: row._id, storeId: current.store._id, status: 'held' }).session(session);
    if (!charge || charge.enrollmentId || charge.amountMinor > 0 && !charge.providerTrackingId) throw new AppError('This charge is not eligible for activation authorization.', 409, 'SUBSCRIPTION_ACTIVATION_STATE');
    sellerVersion(charge, input.version);
    charge.activationAuthorization = { userId: current.actor._id, membershipId: current.member._id, tokenVersion: current.actor.security.tokenVersion, at: new Date(), reason: input.reason };
    await charge.save({ session });
    await audit(request, 'seller.subscription_activation_authorized', charge, session, { reason: input.reason });
  });
  if (row.amountMinor === 0) await applySubscriptionVerification(row.publicId, { payment_status_description: 'COMPLETED', merchant_reference: row.providerReference, amount: 0, currency: row.currency }, '', request);
  else await verifySellerSubscriptionPayment(row.publicId, row.providerTrackingId, request);
  await sellerOperationsAccess(request, 'staff', { allowSuspended: true }); return chargeDto(await SubscriptionCharge.findById(row._id));
}

export async function cancelSellerSubscriptionRequest(request, id, raw) {
  const input = z.object({ version }).parse(raw);
  return sellerTransaction(async session => {
    const context = await sellerOperationsAccess(request, 'staff', { session, write: true });
    const row = await SubscriptionChangeRequest.findOne({ publicId: id, audience: 'seller', storeId: context.store._id, country: context.store.country, currency: context.store.currency }).session(session);
    if (!row) throw new AppError('Subscription request not found.', 404, 'SUBSCRIPTION_REQUEST_NOT_FOUND');
    sellerVersion(row, input.version);
    if (!['requested', 'approved'].includes(row.status) || await SubscriptionCharge.exists({ requestId: row._id, activeKey: { $exists: true } }).session(session)) throw new AppError('Reconcile the active payment before cancelling this request.', 409, 'SUBSCRIPTION_REQUEST_STATE');
    row.status = 'cancelled'; await row.save({ session });
    await writeAudit(request, 'seller.subscription_request_cancelled', { actor: context.actor, session, targetType: 'subscription_change_request', targetPublicId: row.publicId, country: row.country });
    return row;
  });
}

export async function reconcileSellerSubscriptionCharge(request, id, raw) {
  const input = z.object({ trackingId: z.string().trim().regex(/^[A-Za-z0-9_-]{4,160}$/), reason: z.string().trim().min(10).max(1000), version }).parse(raw);
  const { superAdminAccess } = await import('./super-admin-access.js');
  await superAdminAccess(request);
  const charge = await SubscriptionCharge.findOne({ publicId: id }).lean();
  if (!charge) throw new AppError('Subscription payment not found.', 404, 'SUBSCRIPTION_CHARGE_NOT_FOUND');
  sellerVersion(charge, input.version);
  if (charge.providerTrackingId && charge.providerTrackingId !== input.trackingId) throw new AppError('Use the original provider tracking reference.', 409, 'PESAPAL_REFERENCE_MISMATCH');
  const data = await getPesapalTransactionStatus(input.trackingId);
  const result = await applySubscriptionVerification(id, data, input.trackingId, request, input);
  return chargeDto(result);
}

/** Claims are independent of payment truth. Stale workers can only perform the
 * same idempotent, source-verified reconciliation, never another submission. */
export async function sellerSubscriptionMaintenance({ limit = 20 } = {}) {
  const now = new Date(), size = Math.max(1, Math.min(50, Number(limit) || 20));
  const expired = await SubscriptionEnrollment.updateMany({ audience: 'seller', status: { $in: ['active', 'trialing'] }, currentPeriodEndsAt: { $lte: now } },
    [{ $set: { status: { $cond: ['$cancelAtPeriodEnd', 'cancelled', 'expired'] }, cancelledAt: { $cond: ['$cancelAtPeriodEnd', now, '$cancelledAt'] }, __v: { $add: [{ $ifNull: ['$__v', 0] }, 1] } } }], { updatePipeline: true });
  const held = await SubscriptionCharge.updateMany({ status: 'submitting', submissionAttemptedAt: { $lte: new Date(now.getTime() - 5 * 60000) } },
    { $set: { status: 'held', holdReason: 'The submission did not finish locally. Reconcile the original reference before another payment.' }, $inc: { __v: 1 } });
  let checked = 0, failed = 0;
  if (env.pesapal.consumerKey && env.pesapal.consumerSecret) for (let i = 0; i < size; i++) {
    const lease = crypto.randomUUID();
    const row = await SubscriptionCharge.findOneAndUpdate({ providerTrackingId: { $exists: true, $ne: '' }, status: { $in: ['requires_action', 'pending', 'held', 'succeeded'] },
      nextReconcileAt: { $lte: now }, $or: [{ reconcileLeaseUntil: null }, { reconcileLeaseUntil: { $lte: now } }] },
    { $set: { reconcileLease: lease, reconcileLeaseUntil: new Date(Date.now() + 60000) } }, { sort: { nextReconcileAt: 1, _id: 1 }, returnDocument: 'after' });
    if (!row) break;
    try { await verifySellerSubscriptionPayment(row.publicId, row.providerTrackingId); checked++; }
    catch { failed++; }
    const current = await SubscriptionCharge.findById(row._id).select('status').lean();
    await SubscriptionCharge.updateOne({ _id: row._id, reconcileLease: lease }, { $set: { nextReconcileAt: new Date(Date.now() + (current?.status === 'succeeded' ? 86400000 : 10 * 60000)) }, $unset: { reconcileLease: 1, reconcileLeaseUntil: 1 } });
  }
  return { expired: expired.modifiedCount, held: held.modifiedCount, checked, failed };
}
export async function sellerSubscriptionOperationsPage(request) {
  const context = await sellerOperationsAccess(request, 'staff', { allowSuspended: true }), scope = { audience: 'seller', storeId: context.store._id, country: context.store.country, currency: context.store.currency };
  const load = async (Model, match, after) => { const [rows, total] = await Promise.all([Model.find(cursorScope(match, typeof after === 'string' ? after : '')).sort(cursorSort()).limit(26).lean(), Model.countDocuments(match)]); return pageResult(rows, { limit: 25, total }); };
  const [charges, enrollments, changes] = await Promise.all([load(SubscriptionCharge, { storeId: context.store._id, country: context.store.country, currency: context.store.currency }, request.query?.chargesAfter), load(SubscriptionEnrollment, scope, request.query?.enrollmentsAfter), load(SubscriptionChangeRequest, scope, request.query?.after)]);
  return { canAuthorizeHeldActivation: context.member.role === 'owner', charges: charges.items.map(chargeDto), chargesPage: charges.page, enrollments: enrollments.items.map(row => ({ publicId: row.publicId, planName: row.terms?.name || row.planPublicId, status: row.currentPeriodEndsAt && row.currentPeriodEndsAt <= new Date() && row.status === 'active' ? 'expired' : row.status, startsAt: row.startsAt, endsAt: row.currentPeriodEndsAt, cancelAtPeriodEnd: row.cancelAtPeriodEnd, version: row.__v || 0 })), enrollmentsPage: enrollments.page, reviewedRequests: changes.items.map(row => ({ publicId: row.publicId, planName: row.terms?.name || row.planPublicId, status: row.status, terms: row.approvedTerms || row.terms, version: row.__v || 0, paymentKey: publicId('subpay') })), reviewedRequestsPage: changes.page };
}

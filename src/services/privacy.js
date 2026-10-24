import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { hashPassword, hashToken, hashValue, normalizeEmail, verifyPassword } from '../core/crypto.js';
import { publicId } from '../core/ids.js';
import { decryptSensitive, encryptSensitive } from '../core/sensitive.js';
import {
  AiCartDraft, AiFeedback, AiJob, ApiClient, BusinessMember, BusinessOrganization, Cart,
  CustomerAddress, CustomerCatalogueState, Device, Dispute, LedgerAccount, LedgerTransaction, LoyaltyAccount, LoyaltyEntry, MobileSession,
  NewsletterSubscription, Notification, Order, OutboxEvent, Payout, PlatformGrant, PlatformStaffInvitation,
  PrivacyRequest, ProductAlert, PushDevice, Refund, ReturnRequest, Review, SearchEvent,
  SellerContactRequest, Shipment, Store, StoreMember, StoreTeamInvitation, SubscriptionCharge, SubscriptionEnrollment, SupportTicket,
  User, VerificationToken, WalletTopUp,
} from '../models/index.js';
import { env } from '../config/env.js';
import { accountBalanceMinor } from './money.js';
import { countryAdminAccess } from './country-admin-workspace-access.js';
import { writeAudit } from './audit.js';
import { queueCustomerAvatarRemoval } from './customer-avatars.js';
import { CustomerReward } from '../models/CustomerReward.js';
import { CustomerAvatar } from '../models/CustomerAvatar.js';
import { customerReturnDto, customerRefundDto } from './customer-case-projections.js';
import { customerDisputeDto } from './customer-dispute-pages.js';
import { supportTicketCustomerDto } from './support-ticket-pages.js';
import { currentCustomerAccess } from './customer-access.js';

const exportDir = env.privacyExportDir;
const MAX_ATTEMPTS = 10;
const LEASE_MS = 2 * 60_000;
const TYPES = new Set(['export', 'deletion', 'correction', 'restriction', 'consent_withdrawal']);
const workerRequest = actor => ({ id: publicId('req'), user: actor, ip: '', get: () => 'Classic-Mart-Privacy-Worker' });
const transaction = async work => { const session = await mongoose.startSession(); try { let result; await session.withTransaction(async () => { result = await work(session); }); return result; } finally { await session.endSession(); } };
const changed = () => new AppError('The privacy request changed. Reload before continuing.', 409, 'PRIVACY_REQUEST_CHANGED');
const clearLease = { lockedBy: '', lockedUntil: null, leaseToken: '' };

async function currentOwner(request, password, session) {
  const user = await User.findById(request.user?._id).where({ 'security.tokenVersion': mongoose.trusted({ $type: 'number' }) }).select('+passwordHash').session(session);
  const tokenVersion = user?.security?.tokenVersion, callerVersion = request.user?.security?.tokenVersion, sessionVersion = request.session?.tokenVersion;
  if (!user || user.status !== 'active' || !Number.isSafeInteger(tokenVersion) || tokenVersion < 0
    || !Number.isSafeInteger(callerVersion) || callerVersion < 0 || callerVersion !== tokenVersion
    || (sessionVersion !== undefined && (!Number.isSafeInteger(sessionVersion) || sessionVersion < 0 || sessionVersion !== tokenVersion))) {
    throw new AppError('Your account or session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
  }
  if (typeof request.sessionID !== 'string' || !request.sessionID) throw new AppError('Sign in again to confirm this request.', 401, 'UNAUTHENTICATED');
  const device = await Device.findOne({ userId: user._id, sessionHash: hashToken(request.sessionID), revokedAt: null }).session(session);
  if (!device || (request.device?._id && String(device._id) !== String(request.device._id))) throw new AppError('Your account or session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
  if (!(await verifyPassword(user.passwordHash, String(password || '')))) throw new AppError('The current password is incorrect.', 422, 'INVALID_CURRENT_PASSWORD');
  const fenced = await Device.updateOne({ _id: device._id, revokedAt: null, __v: device.__v || 0 }, { $inc: { __v: 1 } }, { session });
  if (fenced.modifiedCount !== 1) throw changed();
  return user;
}

async function stopOptionalProcessing(user, session, { restriction = true } = {}) {
  user.consents.marketing = false;
  user.preferences.notifications = { orders: user.preferences?.notifications?.orders !== false, wishlist: false, offers: false, club: false };
  user.preferences.promoterMessages = false;
  await user.save({ session });
  const emailHash = crypto.createHash('sha256').update(String(user.email).trim().toLowerCase()).digest('hex');
  await NewsletterSubscription.updateMany({ $or: [{ userId: user._id }, { emailHash }] }, { $set: { status: 'unsubscribed', lastUnsubscribedAt: new Date() } }, { session });
  if (!restriction) return;
  await CustomerCatalogueState.updateOne({ userId: user._id }, { $set: { recentProducts: [] } }, { session });
  await SearchEvent.deleteMany({ userId: user._id }, { session });
  await AiCartDraft.deleteMany({ userId: user._id, status: 'proposed' }, { session });
  await AiJob.updateMany({ actorUserId: user._id, status: { $in: ['queued', 'running', 'pending_approval'] } }, { $set: { status: 'cancelled', input: {}, result: {}, completedAt: new Date(), lockedUntil: null, errorCode: 'PRIVACY_PROCESSING_RESTRICTED', errorMessage: 'Optional processing was withdrawn.' }, $inc: { __v: 1 } }, { session });
  await PushDevice.updateMany({ userId: user._id, status: 'active' }, { $set: { status: 'revoked', revokedAt: new Date() } }, { session });
}

export async function createPrivacyRequest(request, { type, password, details = '' }) {
  if (!TYPES.has(type)) throw new AppError('Choose a valid privacy request.', 422, 'PRIVACY_REQUEST_TYPE');
  const cleanDetails = z.string().trim().max(2000).parse(details);
  return transaction(async session => {
    const user = await currentOwner(request, password, session);
    const active = await PrivacyRequest.exists({ userId: user._id, type, $or: [{ status: { $in: ['requested', 'approved', 'processing', 'ready', 'blocked', 'failed'] } }, ...(type === 'restriction' ? [{ restrictionActive: true }] : [])] }).session(session);
    if (active) throw new AppError('An active request of this type already exists.', 409, 'PRIVACY_REQUEST_ACTIVE');
    // The account write serializes simultaneous privacy requests for this identity.
    const fence = await User.updateOne({ _id: user._id, status: 'active', __v: user.__v || 0, 'security.tokenVersion': user.security.tokenVersion }, { $inc: { __v: 1 } }, { session });
    if (fence.modifiedCount !== 1) throw changed();
    user.__v = (user.__v || 0) + 1;
    if (type === 'consent_withdrawal') await stopOptionalProcessing(user, session, { restriction: false });
    const [doc] = await PrivacyRequest.create([{ publicId: publicId('prv'), userId: user._id, userPublicId: user.publicId, country: user.country, type, details: cleanDetails, identityVerifiedAt: new Date(), status: type === 'consent_withdrawal' ? 'completed' : 'requested', ...(type === 'consent_withdrawal' ? { completedAt: new Date(), decision: 'Marketing consent withdrawn immediately; queued outreach rechecks current consent before dispatch.' } : {}), nextAttemptAt: new Date() }], { session });
    await writeAudit(request, 'privacy.request_recorded', { session, targetType: 'privacy_request', targetPublicId: doc.publicId, country: doc.country, metadata: { type } });
    return doc;
  });
}

const EXPORT_BATCH_SIZE = 100;
const EXPORT_MAX_RECORDS = 100_000;
const EXPORT_MAX_BYTES = 32 * 1024 * 1024;
const exportFields = (row, fields) => Object.fromEntries(fields.split(' ').map(field => [field, row[field]]));
const exportTooLarge = () => new AppError('This account requires a supervised privacy export because it exceeds the private download safety limit. No partial download was created.', 413, 'PRIVACY_EXPORT_TOO_LARGE');

async function exportPayload(userId) {
  const accountFields = 'publicId name email phone role status country shoppingCountry currency locale timeZone consents roleProfile preferences createdAt updatedAt';
  const user = await User.findById(userId).select(accountFields).lean();
  if (!user || user.status === 'deleted') throw new AppError('Account not found.', 404, 'ACCOUNT_NOT_FOUND');
  const cleanUser = exportFields(user, accountFields);
  const budget = { records: 1, bytes: Buffer.byteLength(JSON.stringify(cleanUser)) };
  // Drain every matching record in bounded Mongo batches. A safety bound fails
  // the entire job explicitly; it must never publish a silently truncated file.
  const read = async (Model, fields, filter = { userId }, project = row => exportFields(row, fields)) => {
    const cursor = Model.find(filter).select(fields).sort({ _id: 1 }).lean().cursor({ batchSize: EXPORT_BATCH_SIZE });
    const rows = [];
    try {
      for await (const source of cursor) {
        const row = project(source);
        budget.records++;
        budget.bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
        if (budget.records > EXPORT_MAX_RECORDS || budget.bytes > EXPORT_MAX_BYTES) throw exportTooLarge();
        rows.push(row);
      }
    } finally { await cursor.close(); }
    return rows;
  };
  const orderOwners = new Map();
  const orders = await read(Order, 'publicId country status paymentState fulfillmentState cancellationState returnState refundState deliveryMethod paymentMethod contact totals items timeline createdAt updatedAt', { userId }, row => {
    orderOwners.set(String(row._id), row.publicId);
    return { ...exportFields(row, 'publicId country status paymentState fulfillmentState cancellationState returnState refundState deliveryMethod paymentMethod contact totals createdAt updatedAt'),
      items: (row.items || []).map(item => ({ orderLineId: item.linePublicId, ...exportFields(item, 'productPublicId variantPublicId storePublicId title variantTitle sku quantity deliveredQuantity returnedQuantity refundedQuantity unitPriceMinor lineTotalMinor currency') })),
      timeline: (row.timeline || []).map(event => exportFields(event, 'type message at')) };
  });
  const refunds = orderOwners.size ? await read(Refund, 'publicId orderId returnPublicId amountMinor currency status provider completedAt createdAt updatedAt', { orderId: { $in: [...orderOwners.keys()] } }, row => ({ ...customerRefundDto(row), orderPublicId: orderOwners.get(String(row.orderId)) })) : [];
  const returns = await read(ReturnRequest, 'publicId orderPublicId country status reason details resolution returnMethod dropoffPointPublicId eligibleUntil policyVersion createdAt updatedAt refundPublicId returnShipmentPublicId replacementOrderPublicId resolutionChange financeReferral inspection items evidenceDocumentIds timeline', { userId }, customerReturnDto);
  const disputes = await read(Dispute, 'publicId userId orderPublicId country category status subject description priority createdAt updatedAt resolvedAt events resolution', { userId }, customerDisputeDto);
  const supportTickets = await read(SupportTicket, 'publicId userId country category subject status priority orderPublicId createdAt updatedAt resolvedAt reopenedAt notes', { userId }, supportTicketCustomerDto);
  const reviews = await read(Review, 'publicId orderPublicId productPublicId country rating title body status createdAt updatedAt publicMessages', { userId }, row => ({ ...exportFields(row, 'publicId orderPublicId productPublicId country rating title body status createdAt updatedAt'), publicMessages: (row.publicMessages || []).map(message => exportFields(message, 'author message at')) }));
  const sellerContacts = await read(SellerContactRequest, 'publicId country subject message status createdAt updatedAt replies', { customerUserId: userId }, row => ({ ...exportFields(row, 'publicId country subject message status createdAt updatedAt'), replies: (row.replies || []).map(reply => exportFields(reply, 'sender body at')) }));
  const storeMemberships = await read(StoreMember, 'publicId storeId role status invitedAt acceptedAt revokedAt createdAt updatedAt');
  const businessMemberships = await read(BusinessMember, 'publicId organizationId role status spendingLimitMinor canApprove invitedAt acceptedAt revokedAt createdAt updatedAt');
  const devices = await read(Device, 'publicId label lastSeenAt revokedAt createdAt updatedAt');
  const addresses = await read(CustomerAddress, 'publicId label fullName phone address region postalCode city country note isDefault archivedAt createdAt updatedAt');
  const [catalogue = null] = await read(CustomerCatalogueState, 'wishlistProductIds comparisonProductIds recentProducts followedStoreIds followedPromoterUserIds createdAt updatedAt');
  const notifications = await read(Notification, 'publicId country type title body href importance readAt expiresAt createdAt updatedAt');
  const avatars = await read(CustomerAvatar, 'publicId mimeType sizeBytes width height current status createdAt');
  const carts = await read(Cart, 'publicId country items promotionCodes createdAt updatedAt');
  const productAlerts = await read(ProductAlert, 'publicId productPublicId country type targetPriceMinor lastKnownPriceMinor status triggeredAt createdAt updatedAt');
  const searchHistory = await read(SearchEvent, 'publicId country query category brand seller resultCount clickedProductPublicId zeroResult createdAt updatedAt');
  const emailHash = crypto.createHash('sha256').update(String(user.email).trim().toLowerCase()).digest('hex');
  const newsletterSubscriptions = await read(NewsletterSubscription, 'publicId country status source policyVersion consentRecordedAt lastSubscribedAt lastUnsubscribedAt createdAt updatedAt', { $or: [{ userId }, { emailHash }] });
  const walletTopUps = await read(WalletTopUp, 'publicId country currency amountMinor provider providerReference providerPaymentMethod status paidAt createdAt updatedAt');
  const accountRows = await read(LedgerAccount, 'publicId code type ownerType country currency active createdAt updatedAt', { $or: [{ ownerId: userId }, { ownerPublicId: user.publicId, ownerId: null }] }, row => ({ _id: row._id, ...exportFields(row, 'publicId code type ownerType country currency active createdAt updatedAt') }));
  const ownedAccountIds = new Set(accountRows.map(row => String(row._id)));
  const ledgerAccounts = accountRows.map(({ _id, ...row }) => row);
  const ledgerTransactions = accountRows.length ? await read(LedgerTransaction, 'publicId referenceType referencePublicId country currency postedAt createdAt entries', { 'entries.accountId': { $in: accountRows.map(row => row._id) } }, row => ({
    ...exportFields(row, 'publicId referenceType referencePublicId country currency postedAt createdAt'),
    // A balanced posting also contains platform/merchant/counterparty entries.
    // Export only this identity's lines; never serialize their accounts or memos.
    entries: (row.entries || []).filter(entry => ownedAccountIds.has(String(entry.accountId))).map(entry => exportFields(entry, 'accountPublicId debitMinor creditMinor')),
  })) : [];
  const loyaltyAccounts = await read(LoyaltyAccount, 'publicId country points lifetimeEarned lifetimeRedeemed reversalDebtPoints tier createdAt updatedAt');
  const loyaltyEntries = await read(LoyaltyEntry, 'publicId country type pointsDelta balanceAfter earnedPoints reversedPoints debtDelta debtAfter reversalOfEntryPublicId refundPublicId chargebackPublicId referenceType referencePublicId createdAt');
  const rewards = await read(CustomerReward, 'publicId country currency rewardKey label kind pointsCost valueMinor minimumSpendMinor maximumDiscountMinor multiplierBps trialShippingDiscountBps status expiresAt orderPublicId consumedAt restoredAt createdAt updatedAt');
  const subscriptionEnrollments = await read(SubscriptionEnrollment, 'publicId planPublicId audience storePublicId country currency priceMinor status startsAt currentPeriodEndsAt cancelledAt terms subscriptionChargePublicId periodStartsAt periodEndsAt cancelAtPeriodEnd cancellationRequestedAt reversedAt createdAt updatedAt');
  const subscriptionCharges = await read(SubscriptionCharge, 'publicId requestPublicId storePublicId country currency amountMinor terms providerReference status paidAt reversedAt enrollmentPublicId createdAt updatedAt');
  const payload = { generatedAt: new Date().toISOString(), retentionNotice: 'Financial, fraud-prevention and legal records may be retained when required by applicable law or contractual obligations.', account: cleanUser, orders, refunds, returns, disputes, supportTickets, reviews, sellerContacts, storeMemberships, businessMemberships, devices, addresses, catalogue, notifications, avatars, carts, productAlerts, searchHistory, newsletterSubscriptions, walletTopUps, ledgerAccounts, ledgerTransactions, loyaltyAccounts, loyaltyEntries, rewards, subscriptionEnrollments, subscriptionCharges };
  if (Buffer.byteLength(JSON.stringify(payload)) > EXPORT_MAX_BYTES) throw exportTooLarge();
  return payload;
}

export async function deletionBlockers(userId, { session = null } = {}) {
  const user = await User.findById(userId).select('publicId').session(session).lean();
  if (!user) return [];
  const counts = [];
  const check = async (Model, query, label) => { const count = await Model.countDocuments(query).session(session); if (count) counts.push(`${count} ${label}`); };
  await check(Order, { userId, status: { $nin: ['cancelled', 'expired', 'refunded'] }, $or: [{ paymentState: { $in: ['unpaid', 'pending', 'authorized', 'credit_due'] } }, { fulfillmentState: { $nin: ['delivered', 'cancelled'] } }, { cancellationState: { $in: ['requested', 'processing'] } }, { refundState: { $in: ['pending', 'processing'] } }] }, 'active order(s)');
  const orderIds = await Order.distinct('_id', { userId }).session(session);
  if (orderIds.length) await check(Refund, { orderId: { $in: orderIds }, status: { $in: ['pending', 'processing'] } }, 'pending refund(s)');
  await check(ReturnRequest, { userId, status: { $nin: ['rejected', 'refunded', 'exchanged', 'closed'] } }, 'active return(s)');
  await check(Dispute, { userId, status: { $nin: ['resolved', 'rejected', 'closed'] } }, 'active dispute(s)');
  await check(Payout, { ownerUserId: userId, status: { $in: ['requested', 'approved', 'submitting', 'submitted', 'unknown'] } }, 'unsettled payout(s)');
  await check(Store, { ownerUserId: userId, status: { $ne: 'closed' } }, 'owned seller store(s)');
  await check(BusinessOrganization, { ownerUserId: userId }, 'owned business organization(s) requiring ownership transfer');
  await check(Shipment, { deliveryUserId: userId, $or: [{ status: { $nin: ['delivered', 'cancelled', 'returned'] } }, { 'cod.collectedMinor': { $gt: 0 }, 'cod.reconciledAt': null }] }, 'outstanding delivery/COD obligation(s)');
  await check(WalletTopUp, { userId, status: { $in: ['created', 'requires_action', 'pending'] } }, 'pending wallet funding attempt(s)');
  await check(SubscriptionEnrollment, { userId, status: { $in: ['trialing', 'active', 'past_due'] } }, 'active subscription(s)');
  await check(LoyaltyAccount, { userId, reversalDebtPoints: { $gt: 0 } }, 'unsettled loyalty reversal(s)');
  await check(CustomerReward, { userId, status: 'reserved' }, 'reserved reward(s)');
  const accounts = await LedgerAccount.find({ $or: [{ ownerId: userId }, { ownerPublicId: user.publicId }] }).select('_id type +mutationVersion').session(session).lean();
  for (const account of accounts) {
    if (session?.inTransaction()) {
      const fenced = await LedgerAccount.updateOne({ _id: account._id, mutationVersion: account.mutationVersion || 0 }, { $inc: { mutationVersion: 1 } }, { session });
      if (fenced.modifiedCount !== 1) throw changed();
    }
    if (await accountBalanceMinor(account._id, session, account.type) !== 0) counts.push('an unsettled ledger balance');
  }
  return counts;
}

function leaseScope(doc) { return { _id: doc._id, status: 'processing', leaseToken: doc.leaseToken, lockedBy: doc.lockedBy, lockedUntil: { $gt: new Date() }, 'legalHold.active': { $ne: true } }; }
async function finishClaim(doc, update, session = null) {
  const saved = await PrivacyRequest.findOneAndUpdate(leaseScope(doc), { $set: { ...update, ...clearLease }, $inc: { __v: 1 } }, { session, returnDocument: 'after' }).select('+storageKey');
  if (!saved) throw changed();
  return saved;
}

async function processExport(doc) {
  const current = await PrivacyRequest.exists(leaseScope(doc));
  if (!current) throw changed();
  await fs.mkdir(exportDir, { recursive: true });
  const payload = await exportPayload(doc.userId);
  const key = `${doc.publicId}-${doc.leaseToken}.enc`, file = exportFile(key);
  // Record the storage obligation before writing. Interrupted workers retain a
  // durable artifact to remove, even when no ready export was ever published.
  const expiry = new Date(Date.now() + 24 * 60 * 60_000);
  const reserved = await PrivacyRequest.updateOne(leaseScope(doc), { $push: { exportArtifacts: { key, expiresAt: expiry } }, $inc: { __v: 1 } });
  if (reserved.modifiedCount !== 1) throw changed();
  try {
    await fs.writeFile(file, encryptSensitive(JSON.stringify(payload)), { mode: 0o600, flag: 'wx' });
    await finishClaim(doc, { storageKey: key, status: 'ready', readyAt: new Date(), expiresAt: expiry, exportCleanupAfter: null, lastError: '' });
  } catch (error) { await fs.rm(file, { force: true }).catch(() => {}); throw error; }
}

async function processIdentityRequest(claim) {
  return transaction(async session => {
    // Lock the request inside the same transaction as identity changes. A legal
    // hold, review, cancellation or recovered worker causes a write conflict.
    const doc = await PrivacyRequest.findOneAndUpdate(leaseScope(claim), { $inc: { __v: 1 } }, { session, returnDocument: 'after' }).select('+leaseToken');
    if (!doc) throw changed();
    const user = await User.findById(doc.userId).select('+operationalCountries +passwordHash').session(session);
    if (!user || user.status === 'deleted') return finishClaim(doc, { status: 'completed', completedAt: new Date(), decision: 'Account identity was already removed.' }, session);
    if (doc.type === 'restriction') {
      await stopOptionalProcessing(user, session);
      await writeAudit(workerRequest({ _id: doc.processedByUserId }), 'privacy.restriction_applied', { session, targetType: 'privacy_request', targetPublicId: doc.publicId, country: doc.country });
      return finishClaim(doc, { status: 'completed', restrictionActive: true, completedAt: new Date(), lastError: '', decision: 'Optional marketing, push delivery and personalized profiling are restricted. Required account, order, financial and security processing continues.' }, session);
    }
    const blockers = await deletionBlockers(user._id, { session });
    if (blockers.length) return finishClaim(doc, { status: 'blocked', decision: `Deletion requires resolved obligations: ${blockers.join(', ')}.` }, session);
    const suffix = user.publicId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-20) || crypto.randomBytes(8).toString('hex');
    const oldEmailHash = crypto.createHash('sha256').update(String(user.email).trim().toLowerCase()).digest('hex');
    const invitationEmailHash = hashValue(normalizeEmail(user.email));
    await PlatformGrant.updateMany({ userId: user._id, status: { $in: ['active', 'suspended'] } }, { $set: { status: 'revoked', revokedAt: new Date(), statusReason: 'Identity deleted through verified privacy workflow.' }, $inc: { __v: 1 } }, { session });
    for (const Model of [StoreMember, BusinessMember]) await Model.updateMany({ userId: user._id, status: { $in: ['active', 'invited'] } }, { $set: { status: 'revoked', revokedAt: new Date() }, $inc: { __v: 1 } }, { session });
    await PlatformStaffInvitation.updateMany({ status: 'pending', $or: [{ emailHash: invitationEmailHash }, { invitedByUserId: user._id }] },
      { $set: { status: 'revoked', revokedAt: new Date(), revokedByUserId: doc.processedByUserId }, $inc: { __v: 1 } }, { session });
    await StoreTeamInvitation.updateMany({ status: 'pending', $or: [{ emailHash: invitationEmailHash }, { recipientUserId: user._id }, { invitedByUserId: user._id }] },
      { $set: { status: 'revoked', revokedAt: new Date(), revokedByUserId: doc.processedByUserId }, $inc: { __v: 1 } }, { session });
    await MobileSession.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: 'privacy_deletion', checkoutReview: null } }, { session });
    await ApiClient.updateMany({ createdByUserId: user._id, status: 'active' }, { $set: { status: 'revoked', revokedAt: new Date() } }, { session });
    for (const Model of [Device, PushDevice, VerificationToken, CustomerAddress, CustomerCatalogueState, Cart, Notification, ProductAlert, SearchEvent]) await Model.deleteMany({ userId: user._id }, { session });
    await AiCartDraft.deleteMany({ userId: user._id }, { session });
    await AiFeedback.deleteMany({ actorUserId: user._id }, { session });
    await AiJob.updateMany({ actorUserId: user._id }, { $set: { status: 'cancelled', input: {}, result: {}, completedAt: new Date(), lockedUntil: null, errorCode: 'PRIVACY_ACCOUNT_DELETED', errorMessage: '' }, $inc: { __v: 1 } }, { session });
    await NewsletterSubscription.deleteMany({ $or: [{ userId: user._id }, { emailHash: oldEmailHash }] }, { session });
    await OutboxEvent.updateMany({ type: { $in: ['mobile.push', 'store.broadcast', 'marketing.campaign_message'] }, $or: [{ 'payload.userId': String(user._id) }, { 'payload.userPublicId': user.publicId }] }, { $set: { status: 'processed', processedAt: new Date(), payload: { userPublicId: user.publicId, deliveryStatus: 'cancelled', reason: 'privacy_deletion' }, lockedBy: '', lockedUntil: null } }, { session });
    await queueCustomerAvatarRemoval(user._id, session);
    await PrivacyRequest.updateMany({ userId: user._id, type: 'export' }, { $set: { status: 'expired', expiresAt: new Date(), ...clearLease } }, { session });
    await PrivacyRequest.updateMany({ userId: user._id, type: 'export', exportArtifacts: { $exists: true } }, { $set: { 'exportArtifacts.$[].expiresAt': new Date() } }, { session });
    user.name = 'Deleted user'; user.email = `deleted-${suffix}@invalid.local`; user.emailNormalized = user.email; user.phone = `deleted-${suffix}`; user.phoneNormalized = user.phone;
    user.passwordHash = await hashPassword(crypto.randomBytes(48).toString('base64url')); user.role = 'customer'; user.status = 'deleted'; user.operationalCountries = []; user.platformAccessManagedAt ||= new Date(); user.roleProfile = {}; user.preferences = { lowData: false };
    user.consents = { terms: true, privacy: true, marketing: false, recordedAt: new Date(), policyVersion: user.consents?.policyVersion || '2026-07' };
    user.emailVerifiedAt = undefined; user.phoneVerifiedAt = undefined; user.security = { tokenVersion: Number(user.security?.tokenVersion || 0) + 1, mfaEnabled: false, failedLoginCount: 0 }; await user.save({ session });
    await writeAudit(workerRequest({ _id: doc.processedByUserId }), 'privacy.identity_deleted', { session, targetType: 'privacy_request', targetPublicId: doc.publicId, country: doc.country, metadata: { retained: 'Financial, order, fraud and legal records retain controlled access.' } });
    return finishClaim(doc, { status: 'completed', completedAt: new Date(), lastError: '', decision: 'Account identity anonymized, access revoked and optional personal data removed. Financial and legally required transaction records remain under restricted access.' }, session);
  });
}

export async function processPrivacyRequests({ workerId = `privacy-${process.pid}`, limit = 10 } = {}) {
  let processed = 0;
  await PrivacyRequest.updateMany({ status: 'processing', attempts: { $gte: MAX_ATTEMPTS }, lockedUntil: { $lte: new Date() } }, { $set: { status: 'failed', lastError: 'Privacy worker reached its recovery attempt limit; an independent reviewed retry is required.', ...clearLease }, $inc: { __v: 1 } });
  for (let i = 0; i < Math.min(100, Math.max(1, Number(limit) || 10)); i++) {
    const now = new Date();
    const doc = await PrivacyRequest.findOneAndUpdate({ type: { $in: ['export', 'deletion', 'restriction'] }, attempts: { $lt: MAX_ATTEMPTS }, nextAttemptAt: { $lte: now }, 'legalHold.active': { $ne: true }, $or: [
      { type: 'export', status: 'requested' },
      { type: { $in: ['deletion', 'restriction'] }, status: 'approved', processedByUserId: { $type: 'objectId' } },
      { status: 'failed', $or: [{ type: 'export' }, { approvedAt: { $type: 'date' } }, { processedByUserId: { $type: 'objectId' } }] },
      { status: 'processing', $and: [{ $or: [{ lockedUntil: { $lte: now } }, { lockedUntil: null }] }, { $or: [{ type: 'export' }, { approvedAt: { $type: 'date' } }, { processedByUserId: { $type: 'objectId' } }] }] },
    ] }, { $set: { status: 'processing', lockedBy: String(workerId).slice(0, 120), leaseToken: crypto.randomBytes(20).toString('hex'), lockedUntil: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1, __v: 1 } }, { sort: { nextAttemptAt: 1, createdAt: 1 }, returnDocument: 'after' }).select('+storageKey +leaseToken');
    if (!doc) break;
    try { if (doc.type === 'export') await processExport(doc); else await processIdentityRequest(doc); processed++; }
    catch (error) {
      // A superseded worker may neither mark a new claim failed nor undo a hold.
      await PrivacyRequest.updateOne(leaseScope(doc), { $set: { status: 'failed', lastError: String(error.message || error).slice(0, 1000), nextAttemptAt: new Date(Date.now() + Math.min(60, 2 ** Math.min(doc.attempts, 5)) * 60_000), ...clearLease }, $inc: { __v: 1 } });
    }
  }
  return processed;
}

function exportFile(key) {
  if (!/^[A-Za-z0-9_-]+\.enc$/.test(String(key))) throw new AppError('Privacy export storage is invalid.', 500, 'PRIVACY_EXPORT_STORAGE_INVALID');
  return path.join(exportDir, key);
}
export async function privacyExportPayload(doc, { request } = {}) {
  if (request) {
    const actor = await currentCustomerAccess(request);
    if (String(actor._id) !== String(doc.userId)) throw new AppError('Privacy export is not available.', 404, 'PRIVACY_EXPORT_NOT_READY');
  }
  const current = await PrivacyRequest.findOne({ _id: doc._id, userId: doc.userId, type: 'export', status: 'ready', expiresAt: { $gt: new Date() }, 'legalHold.active': { $ne: true } }).select('+storageKey');
  if (!current?.storageKey) throw new AppError('Privacy export is not available.', 404, 'PRIVACY_EXPORT_NOT_READY');
  const user = await User.exists({ _id: current.userId, status: 'active' });
  if (!user) throw new AppError('Privacy export is not available.', 404, 'PRIVACY_EXPORT_NOT_READY');
  const payload = decryptSensitive(await fs.readFile(exportFile(current.storageKey), 'utf8'));
  // Storage may be slow. A hold, replacement, expiry, deletion or session
  // revocation applied during the read must prevent disclosure of its bytes.
  if (request) await currentCustomerAccess(request);
  const [available, owner] = await Promise.all([
    PrivacyRequest.exists({ _id: current._id, userId: current.userId, type: 'export', status: 'ready',
      storageKey: current.storageKey, expiresAt: { $gt: new Date() }, 'legalHold.active': { $ne: true } }),
    User.exists({ _id: current.userId, status: 'active' }),
  ]);
  if (!available || !owner) throw new AppError('Privacy export is not available.', 404, 'PRIVACY_EXPORT_NOT_READY');
  return payload;
}
export async function expirePrivacyExports(now = new Date()) {
  const docs = await PrivacyRequest.find({ type: 'export', $or: [{ expiresAt: { $lte: now }, storageKey: { $exists: true, $ne: '' },
    $or: [{ exportCleanupAfter: { $lte: now } }, { exportCleanupAfter: null }] },
    { exportArtifacts: { $elemMatch: { expiresAt: { $lte: now }, $or: [{ cleanupAfter: { $lte: now } }, { cleanupAfter: null }] } } },
  ] }).select('+storageKey +exportArtifacts').limit(100);
  let removed = 0;
  for (const doc of docs) {
    const keys = new Set((doc.exportArtifacts || []).filter(row => row.expiresAt <= now && (!row.cleanupAfter || row.cleanupAfter <= now)).map(row => row.key));
    if (doc.storageKey && doc.expiresAt && doc.expiresAt <= now && (!doc.exportCleanupAfter || doc.exportCleanupAfter <= now)) keys.add(doc.storageKey);
    for (const key of keys) {
      // Legacy ready files also acquire an obligation before the reference is
      // cleared. Tombstones remain scheduled because an old interrupted writer
      // can resume after a previous cleanup removed its file.
      await PrivacyRequest.updateOne({ _id: doc._id, 'exportArtifacts.key': { $ne: key } },
        { $push: { exportArtifacts: { key, expiresAt: now } }, $inc: { __v: 1 } });
      try {
        await fs.rm(exportFile(key), { force: true });
        await PrivacyRequest.updateOne({ _id: doc._id, 'exportArtifacts.key': key },
          { $set: { 'exportArtifacts.$.cleanupAfter': new Date(now.getTime() + 24 * 60 * 60_000), 'exportArtifacts.$.cleanupError': '' }, $inc: { __v: 1 } });
        // A stale cleanup reader cannot clear a newer ready claim.
        await PrivacyRequest.updateOne({ _id: doc._id, storageKey: key, expiresAt: { $lte: now } },
          { $set: { storageKey: '', status: 'expired', exportCleanupAfter: null }, $inc: { __v: 1 } });
        removed++;
      } catch {
        // One failed object cannot starve cleanup of other account exports.
        await PrivacyRequest.updateOne({ _id: doc._id, 'exportArtifacts.key': key },
          { $set: { 'exportArtifacts.$.cleanupAfter': new Date(now.getTime() + 5 * 60_000),
            'exportArtifacts.$.cleanupError': 'Private export cleanup failed; retry scheduled.' }, $inc: { __v: 1 } });
        await PrivacyRequest.updateOne({ _id: doc._id, storageKey: key, expiresAt: { $lte: now } },
          { $set: { exportCleanupAfter: new Date(now.getTime() + 5 * 60_000) }, $inc: { __v: 1 } });
      }
    }
  }
  return removed;
}

async function reviewedMutation(original, actor, options, work) {
  if (!options?.request || String(options.request.user?._id) !== String(actor?._id)) throw new AppError('A current authenticated review session is required.', 403, 'PRIVACY_REVIEW_SESSION_REQUIRED');
  return transaction(async session => {
    const doc = await PrivacyRequest.findById(original._id).session(session);
    if (!doc || doc.__v !== original.__v) throw changed();
    const context = await countryAdminAccess(options.request, { session, write: true, workspace: false, country: doc.country });
    if (String(doc.userId) === String(context.actor._id)) throw new AppError('A different authorized reviewer must review this privacy request.', 403, 'PRIVACY_INDEPENDENT_REVIEW_REQUIRED');
    const result = await work(doc, context.actor, session);
    await writeAudit(options.request, 'privacy.review_changed', { session, actor: context.actor, targetType: 'privacy_request', targetPublicId: doc.publicId, country: doc.country, metadata: { type: doc.type, status: doc.status, restrictionActive: doc.restrictionActive } });
    return result;
  });
}

const correctionSchema = z.object({ name: z.string().trim().min(2).max(120).optional(), publicName: z.string().trim().max(100).optional(), location: z.string().trim().max(180).optional(), bio: z.string().trim().max(1000).optional() }).strict().refine(value => Object.keys(value).length > 0, 'Record at least one supported correction.');
export async function approvePrivacyRequest(original, actor, decision = 'Approved after identity and obligation review.', options = {}) {
  return reviewedMutation(original, actor, options, async (doc, reviewer, session) => {
    if (!['requested', 'blocked'].includes(doc.status)) throw new AppError('Privacy request is not awaiting review.', 409, 'PRIVACY_REQUEST_STATE');
    if (doc.type === 'export') throw new AppError('Verified exports are processed automatically.', 409, 'PRIVACY_EXPORT_AUTO');
    if (doc.legalHold?.active) throw new AppError('This request is under legal hold.', 409, 'PRIVACY_LEGAL_HOLD');
    doc.processedByUserId = reviewer._id; doc.approvedAt = new Date(); doc.decision = z.string().trim().min(3).max(2000).parse(decision); doc.nextAttemptAt = new Date(); Object.assign(doc, clearLease);
    if (doc.type === 'correction') {
      if (!options.corrections) throw new AppError('Apply the verified corrections before completing this request. Email and phone changes must use their verified account flows.', 422, 'PRIVACY_CORRECTION_REQUIRED');
      const corrections = correctionSchema.parse(options.corrections), user = await User.findOne({ _id: doc.userId, status: 'active' }).session(session);
      if (!user) throw new AppError('Account is unavailable.', 409, 'ACCOUNT_UNAVAILABLE');
      if (corrections.name !== undefined) user.name = corrections.name;
      for (const key of ['publicName', 'location', 'bio']) if (corrections[key] !== undefined) user.roleProfile[key] = corrections[key];
      await user.save({ session }); doc.status = 'completed'; doc.completedAt = new Date();
    } else if (['deletion', 'restriction'].includes(doc.type)) {
      doc.status = 'approved';
      if (doc.type === 'restriction') {
        const user = await User.findById(doc.userId).session(session);
        if (!user || user.status === 'deleted') throw new AppError('Account is unavailable.', 409, 'ACCOUNT_UNAVAILABLE');
        // Apply opt-outs at approval, in the same transaction as the restriction,
        // so a concurrently queued audience cannot retain stale consent.
        await stopOptionalProcessing(user, session); doc.restrictionActive = true;
      }
    }
    else throw new AppError('This request is already handled through the account consent controls.', 409, 'PRIVACY_REQUEST_STATE');
    await doc.save({ session }); return doc;
  });
}
export async function setPrivacyLegalHold(original, actor, { active, reason, request } = {}) {
  return reviewedMutation(original, actor, { request }, async (doc, reviewer, session) => {
    if (['completed', 'cancelled', 'rejected', 'expired'].includes(doc.status)) throw new AppError('A finished privacy request cannot change legal hold.', 409, 'PRIVACY_REQUEST_STATE');
    const cleanReason = z.string().trim().min(3).max(1000).parse(reason || (active ? '' : 'Legal hold reviewed and released.'));
    doc.legalHold = { active: Boolean(active), reason: active ? cleanReason : '', setByUserId: reviewer._id, setAt: new Date() };
    doc.status = 'blocked'; doc.decision = active ? `Legal hold: ${cleanReason}` : 'Legal hold released; a fresh independent review is required before processing.';
    Object.assign(doc, clearLease); await doc.save({ session }); return doc;
  });
}
export async function retryPrivacyRequest(original, actor, reason, options = {}) {
  return reviewedMutation(original, actor, options, async (doc, reviewer, session) => {
    if (!['export', 'deletion', 'restriction'].includes(doc.type)) throw new AppError('This privacy request requires a direct reviewed correction.', 409, 'PRIVACY_RECOVERY_UNAVAILABLE');
    if (!['failed', 'blocked'].includes(doc.status) || doc.legalHold?.active) throw new AppError('Only failed or unheld blocked requests can be recovered.', 409, 'PRIVACY_RECOVERY_UNAVAILABLE');
    doc.decision = z.string().trim().min(10).max(2000).parse(reason); doc.processedByUserId = reviewer._id;
    doc.status = doc.type === 'export' ? 'requested' : 'approved'; doc.approvedAt = new Date(); doc.attempts = 0; doc.lastError = ''; doc.nextAttemptAt = new Date(); Object.assign(doc, clearLease); await doc.save({ session }); return doc;
  });
}
export async function releasePrivacyRestriction(original, actor, reason, options = {}) {
  return reviewedMutation(original, actor, options, async (doc, reviewer, session) => {
    if (doc.type !== 'restriction' || !doc.restrictionActive) throw new AppError('An active privacy restriction was not found.', 409, 'PRIVACY_RESTRICTION_UNAVAILABLE');
    if (doc.legalHold?.active) throw new AppError('Release the legal hold through its reviewed workflow first.', 409, 'PRIVACY_LEGAL_HOLD');
    doc.decision = z.string().trim().min(10).max(2000).parse(reason); doc.restrictionActive = false; doc.restrictionReleasedAt = new Date(); doc.restrictionReleasedByUserId = reviewer._id; doc.status = 'completed'; Object.assign(doc, clearLease); await doc.save({ session }); return doc;
  });
}

export async function cancelPrivacyRequest(request, publicIdValue) {
  return transaction(async session => {
    const actor = await currentCustomerAccess(request, { session, write: true });
    const doc = await PrivacyRequest.findOneAndUpdate({ publicId: publicIdValue, userId: actor._id,
      status: { $in: ['requested', 'blocked', 'failed'] }, restrictionActive: { $ne: true } },
    { $set: { status: 'cancelled', completedAt: new Date(), ...clearLease }, $inc: { __v: 1 } }, { session, returnDocument: 'after' });
    if (!doc) throw new AppError('This request cannot be cancelled. An active restriction requires a reviewed release.', 409, 'PRIVACY_CANCELLATION_UNAVAILABLE');
    await writeAudit(request, 'privacy.request_cancelled', { session, targetType: 'privacy_request', targetPublicId: doc.publicId, country: doc.country });
    return doc;
  });
}

export async function rejectPrivacyRequest(original, actor, reason, options = {}) {
  return reviewedMutation(original, actor, options, async (doc, reviewer, session) => {
    if (!['requested', 'blocked', 'failed'].includes(doc.status) || doc.restrictionActive) throw new AppError('This request cannot be rejected. An active restriction requires a reviewed release.', 409, 'PRIVACY_REJECTION_UNAVAILABLE');
    doc.status = 'rejected'; doc.decision = z.string().trim().min(3).max(2000).parse(reason); doc.processedByUserId = reviewer._id; doc.completedAt = new Date(); Object.assign(doc, clearLease); await doc.save({ session }); return doc;
  });
}

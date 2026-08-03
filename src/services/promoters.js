import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import {
  AttributionTouch,
  Campaign,
  CampaignApplication,
  CommissionEntry,
  Order,
  PromoterContactRequest,
  PromoterLink,
  PromoterVerification,
  Product,
  Refund,
  Store,
  StoreMember,
  User,
} from '../models/index.js';
import { publishedProductsByPublicIds } from './storefront.js';
import { ensureLedgerAccount, postLedgerTransaction } from './money.js';

const hash = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const DAY_MS = 86_400_000;

function campaignIsLive(campaign, now = new Date()) {
  if (!campaign || campaign.status !== 'active') return false;
  if (campaign.startsAt && campaign.startsAt > now) return false;
  if (campaign.endsAt && campaign.endsAt <= now) return false;
  return true;
}

export async function submitPromoterVerification(request, input) {
  let row = await PromoterVerification.findOne({ userId: request.user._id });
  if (!row) row = new PromoterVerification({ publicId: publicId('prv'), userId: request.user._id, country: request.user.country });
  row.channels = input.channels;
  row.niches = input.niches;
  row.disclosureAcceptedAt = new Date();
  row.submittedAt = new Date();
  row.status = 'submitted';
  await row.save();
  return row;
}

export async function reviewPromoterVerification(request, verificationId, { decision, reason = '' }) {
  const row = await PromoterVerification.findOne({ publicId: verificationId, status: 'submitted' });
  if (!row) throw new AppError('Submitted promoter verification not found.', 404, 'PROMOTER_VERIFICATION_NOT_FOUND');
  if (request.user.role !== 'super_admin' && row.country !== request.user.country) throw new AppError('Verification is outside your country scope.', 403, 'COUNTRY_SCOPE');
  row.status = decision === 'approve' ? 'verified' : 'rejected';
  row.reason = reason;
  row.reviewedAt = new Date();
  row.reviewedByUserId = request.user._id;
  await row.save();
  return row;
}

export async function createCampaign(request, input) {
  const store = request.store || await Store.findOne({ ownerUserId: request.user._id, status: 'verified' });
  if (!store || store.status !== 'verified') throw new AppError('Verified seller store required.', 409, 'STORE_REQUIRED');
  const productIds = [...new Set((input.productPublicIds || []).map(value => String(value).trim()).filter(Boolean))];
  const ownedProducts = await Product.find({ publicId: mongoose.trusted({ $in: productIds }), storeId: store._id, status: 'published', countries: store.country }).select('publicId').lean();
  if (!productIds.length || ownedProducts.length !== productIds.length) throw new AppError('Campaign products must be published products owned by your verified store in this country.', 422, 'CAMPAIGN_PRODUCT_SCOPE');
  return Campaign.create({
    publicId: publicId('cmp'), ownerUserId: store.ownerUserId, storeId: store._id, country: store.country,
    name: input.name, visibility: input.visibility, commissionBps: input.commissionBps, attributionDays: input.attributionDays,
    allowedChannels: input.allowedChannels, facts: input.facts, productPublicIds: productIds, assets: input.assets || [],
    disclosureText: input.disclosureText, startsAt: input.startsAt || null, endsAt: input.endsAt || null, status: 'draft', policyVersion: '2026-07',
  });
}

export async function submitCampaign(request, campaignPublicId) {
  const query = { publicId: campaignPublicId };
  if (request.store?._id) query.storeId = request.store._id; else query.ownerUserId = request.user._id;
  const campaign = await Campaign.findOne(query);
  if (!campaign) throw new AppError('Campaign not found.', 404, 'CAMPAIGN_NOT_FOUND');
  if (!['draft', 'rejected'].includes(campaign.status)) throw new AppError('Only a draft or rejected campaign can be submitted.', 409, 'CAMPAIGN_STATE');
  if (!campaign.facts.length) throw new AppError('Add at least one approved factual claim before submitting.', 422, 'CAMPAIGN_FACTS_REQUIRED');
  if (!campaign.productPublicIds.length) throw new AppError('Select at least one product for the campaign.', 422, 'CAMPAIGN_PRODUCTS_REQUIRED');
  campaign.status = 'submitted'; campaign.submittedAt = new Date(); campaign.reviewReason = '';
  await campaign.save(); return campaign;
}

export async function reviewCampaign(request, campaignPublicId, { decision, reason = '' }) {
  const campaign = await Campaign.findOne({ publicId: campaignPublicId, status: 'submitted' });
  if (!campaign) throw new AppError('Submitted campaign not found.', 404, 'CAMPAIGN_NOT_FOUND');
  if (request.user.role !== 'super_admin' && campaign.country !== request.user.country) throw new AppError('Campaign is outside your country scope.', 403, 'COUNTRY_SCOPE');
  campaign.status = decision === 'approve' ? 'active' : 'rejected';
  campaign.reviewReason = reason; campaign.reviewedAt = new Date(); campaign.reviewedByUserId = request.user._id;
  if (campaign.status === 'active' && !campaign.startsAt) campaign.startsAt = new Date();
  await campaign.save(); return campaign;
}

export async function applyToCampaign(request, campaignPublicId, note = '') {
  const verification = await PromoterVerification.findOne({ userId: request.user._id, status: 'verified' });
  if (!verification) throw new AppError('Verified promoter account required.', 403, 'PROMOTER_VERIFICATION_REQUIRED');
  const campaign = await Campaign.findOne({ publicId: campaignPublicId, country: request.user.country, status: 'active' });
  if (!campaign || !campaignIsLive(campaign)) throw new AppError('Active campaign not found.', 404, 'CAMPAIGN_NOT_FOUND');
  if (campaign.ownerUserId.equals(request.user._id) || await StoreMember.exists({ storeId: campaign.storeId, userId: request.user._id, status: 'active' })) throw new AppError('You cannot promote a campaign belonging to a store you operate.', 409, 'SELF_REFERRAL');
  if (campaign.visibility === 'public') {
    return CampaignApplication.findOneAndUpdate(
      { campaignId: campaign._id, promoterUserId: request.user._id },
      { $setOnInsert: { publicId: publicId('cap'), campaignPublicId: campaign.publicId, country: campaign.country, note, status: 'approved', reviewedAt: new Date() } },
      { upsert: true, returnDocument: 'after' },
    );
  }
  return CampaignApplication.findOneAndUpdate(
    { campaignId: campaign._id, promoterUserId: request.user._id },
    { $setOnInsert: { publicId: publicId('cap'), campaignPublicId: campaign.publicId, country: campaign.country, note, status: 'pending' } },
    { upsert: true, returnDocument: 'after' },
  );
}

export async function reviewCampaignApplication(request, applicationPublicId, { decision, reason = '' }) {
  const application = await CampaignApplication.findOne({ publicId: applicationPublicId, status: 'pending' });
  if (!application) throw new AppError('Pending application not found.', 404, 'CAMPAIGN_APPLICATION_NOT_FOUND');
  const campaign = await Campaign.findById(application.campaignId);
  const ownsCampaign = campaign && (request.store?._id ? campaign.storeId.equals(request.store._id) : campaign.ownerUserId.equals(request.user._id));
  if (!ownsCampaign) throw new AppError('Your store cannot review this application.', 403, 'FORBIDDEN');
  application.status = decision === 'approve' ? 'approved' : 'rejected'; application.reason = reason; application.reviewedAt = new Date(); application.reviewedByUserId = request.user._id;
  await application.save(); return application;
}

export async function createPromoterLink(request, input) {
  const verification = await PromoterVerification.findOne({ userId: request.user._id, status: 'verified' });
  if (!verification) throw new AppError('Verified promoter account required.', 403, 'PROMOTER_VERIFICATION_REQUIRED');
  const campaign = await Campaign.findOne({ publicId: input.campaignId, country: request.user.country, status: 'active' });
  if (!campaign || !campaignIsLive(campaign)) throw new AppError('Active campaign not found.', 404, 'CAMPAIGN_NOT_FOUND');
  if (campaign.ownerUserId.equals(request.user._id) || await StoreMember.exists({ storeId: campaign.storeId, userId: request.user._id, status: 'active' })) throw new AppError('You cannot create a tracked link for a store you operate.', 409, 'SELF_REFERRAL');
  const application = await CampaignApplication.findOne({ campaignId: campaign._id, promoterUserId: request.user._id, status: 'approved' });
  if (!application) throw new AppError('Campaign approval is required before creating a tracked link.', 403, 'CAMPAIGN_APPROVAL_REQUIRED');
  if (input.channel && campaign.allowedChannels.length && !campaign.allowedChannels.includes(input.channel)) throw new AppError('That channel is not allowed for this campaign.', 422, 'CAMPAIGN_CHANNEL_NOT_ALLOWED');
  const couponCode = String(input.couponCode || '').trim().toUpperCase();
  if (couponCode && await PromoterLink.exists({ couponCode })) throw new AppError('That promoter code is already in use.', 409, 'COUPON_CODE_EXISTS');
  const token = crypto.randomBytes(18).toString('base64url');
  return PromoterLink.create({
    publicId: publicId('plk'), campaignId: campaign._id, promoterUserId: request.user._id, token, destination: input.destination,
    couponCode, subId: input.subId || '', channel: input.channel || '', utmSource: input.utmSource || 'classicmart-promoter',
    utmMedium: input.utmMedium || 'affiliate', utmCampaign: input.utmCampaign || campaign.publicId, utmContent: input.utmContent || '',
  });
}

async function recordTouchForLink(request, link) {
  if (!link) throw new AppError('Promotion link not found.', 404, 'PROMO_LINK_NOT_FOUND');
  const campaign = await Campaign.findById(link.campaignId);
  if (!campaignIsLive(campaign)) throw new AppError('Campaign is not active.', 410, 'CAMPAIGN_INACTIVE');
  if (campaign.country !== request.country.code) throw new AppError('Campaign is unavailable in this country.', 403, 'COUNTRY_SCOPE');
  const sessionKey = request.session.cartKey || request.sessionID;
  const ipHash = hash(request.ip); const userAgentHash = hash(request.get('user-agent')); const referrerHash = hash(request.get('referer'));
  const duplicate = await AttributionTouch.findOne({ sessionKey, linkId: link._id, status: 'valid', landedAt: { $gte: new Date(Date.now() - 60_000) } });
  if (duplicate) { request.session.promoterTouchId = duplicate.publicId; return { link, touch: duplicate }; }
  const recentIpCount = await AttributionTouch.countDocuments({ promoterUserId: link.promoterUserId, ipHash, landedAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) } });
  const fraudFlags = []; let fraudScore = 0;
  if (recentIpCount >= 20) { fraudFlags.push('ip_velocity'); fraudScore += 60; }
  if (!request.get('user-agent')) { fraudFlags.push('missing_user_agent'); fraudScore += 20; }
  const blocked = fraudScore >= 60;
  const touch = await AttributionTouch.create({ publicId: publicId('tch'), linkId: link._id, campaignId: campaign._id, promoterUserId: link.promoterUserId, sessionKey, country: request.country.code, ipHash, userAgentHash, referrerHash, expiresAt: new Date(Date.now() + campaign.attributionDays * DAY_MS), fraudScore, fraudFlags, status: blocked ? 'blocked' : 'valid', blockReason: blocked ? 'automated_fraud_rule' : '' });
  if (!blocked) request.session.promoterTouchId = touch.publicId;
  return { link, touch };
}

export async function recordTouch(request, token) {
  const link = await PromoterLink.findOne({ token, active: true });
  return recordTouchForLink(request, link);
}

export async function redeemPromoterCoupon(request, code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) throw new AppError('Enter a promoter code.', 422, 'PROMO_CODE_REQUIRED');
  const links = await PromoterLink.find({ couponCode: normalized, active: true }).sort({ createdAt: -1 }).limit(2);
  if (!links.length) throw new AppError('Promoter code is invalid or inactive.', 404, 'PROMO_CODE_INVALID');
  if (links.length > 1) throw new AppError('Promoter code is ambiguous. Ask the promoter for a current code.', 409, 'PROMO_CODE_AMBIGUOUS');
  return recordTouchForLink(request, links[0]);
}

export async function attributeOrder(request, orderPublicId) {
  const touchId = request.session.promoterTouchId; if (!touchId) return;
  const touch = await AttributionTouch.findOne({ publicId: touchId, status: 'valid', expiresAt: { $gt: new Date() } }); if (!touch) return;
  const order = await Order.findOne({ publicId: orderPublicId }); const campaign = await Campaign.findById(touch.campaignId);
  if (!order || !campaignIsLive(campaign) || campaign.country !== order.country) return;
  if (order.userId && order.userId.equals(touch.promoterUserId)) { touch.status = 'blocked'; touch.blockReason = 'self_referral'; await touch.save(); return; }
  for (const item of order.items) {
    if (!item.storeId.equals(campaign.storeId)) continue;
    if (campaign.productPublicIds.length && !campaign.productPublicIds.includes(item.productPublicId)) continue;
    const amount = Math.floor(item.lineTotalMinor * campaign.commissionBps / 10000); if (amount <= 0) continue;
    await CommissionEntry.findOneAndUpdate(
      { orderId: order._id, promoterUserId: touch.promoterUserId, productPublicId: item.productPublicId },
      { $setOnInsert: { publicId: publicId('com'), orderPublicId: order.publicId, campaignId: campaign._id, touchId: touch._id, storePublicId: item.storePublicId, amountMinor: amount, currency: item.currency, commissionBps: campaign.commissionBps, policyVersion: campaign.policyVersion, status: 'pending' } },
      { upsert: true, returnDocument: 'after' },
    );
  }
  touch.status = 'converted'; await touch.save();
}

export async function makeOrderCommissionsPayable(order, session = null) {
  const commissions = await CommissionEntry.find({ orderId: order._id, status: 'pending' }).session(session);
  for (const commission of commissions) {
    const payable = await ensureLedgerAccount({ code: 'promoter_payable', type: 'liability', ownerType: 'promoter', ownerId: commission.promoterUserId, ownerPublicId: String(commission.promoterUserId), country: order.country, currency: commission.currency }, session);
    const expense = await ensureLedgerAccount({ code: 'promoter_commission_expense', type: 'expense', ownerType: 'platform', ownerPublicId: 'classic-mart', country: order.country, currency: commission.currency }, session);
    await postLedgerTransaction({ idempotencyKey: `commission:${commission.publicId}`, referenceType: 'commission', referencePublicId: commission.publicId, currency: commission.currency, country: order.country, description: `Promoter commission ${commission.publicId}`, entries: [{ account: expense, debitMinor: commission.amountMinor, creditMinor: 0, memo: 'Promoter acquisition cost' }, { account: payable, debitMinor: 0, creditMinor: commission.amountMinor, memo: 'Promoter payable' }] }, session);
    commission.status = 'payable'; commission.payableAt = new Date(); await commission.save({ session });
  }
}

export async function reverseOrderCommissions(order, refund, session = null) {
  const commissions = await CommissionEntry.find({ orderId: order._id, status: { $in: ['pending', 'payable', 'partially_reversed', 'paid'] } }).session(session);
  const allocations = Array.isArray(refund.allocations) ? refund.allocations.filter(row => Number(row.grossMinor) > 0) : [];
  let priorAllocatedRefunds = [];
  if (allocations.length) {
    priorAllocatedRefunds = await Refund.find({ orderId: order._id, status: 'completed', _id: { $ne: refund._id }, 'allocations.0': { $exists: true } }).select('allocations').session(session).lean();
  }
  for (const commission of commissions) {
    const remaining = commission.amountMinor - (commission.reversedAmountMinor || 0);
    if (remaining <= 0) continue;
    let targetReversed;
    if (allocations.length) {
      const originalGross = order.items.filter(item => item.productPublicId === commission.productPublicId && item.storePublicId === commission.storePublicId).reduce((sum, item) => sum + item.lineTotalMinor, 0);
      if (!originalGross) continue;
      const currentGross = allocations.filter(row => row.productPublicId === commission.productPublicId && row.storePublicId === commission.storePublicId).reduce((sum, row) => sum + Number(row.grossMinor || 0), 0);
      if (!currentGross) continue;
      const priorGross = priorAllocatedRefunds.reduce((sum, prior) => sum + (prior.allocations || []).filter(row => row.productPublicId === commission.productPublicId && row.storePublicId === commission.storePublicId).reduce((inner, row) => inner + Number(row.grossMinor || 0), 0), 0);
      const cumulativeGross = Math.min(originalGross, priorGross + currentGross);
      targetReversed = Math.floor(commission.amountMinor * cumulativeGross / Math.max(1, originalGross));
    } else {
      const ratio = Math.min(1, refund.amountMinor / Math.max(1, order.totals.totalMinor));
      targetReversed = (commission.reversedAmountMinor || 0) + Math.max(0, Math.floor(commission.amountMinor * ratio));
    }
    const reversal = Math.min(remaining, Math.max(0, targetReversed - (commission.reversedAmountMinor || 0)));
    if (!reversal) continue;
    if (commission.status !== 'pending') {
      const payable = await ensureLedgerAccount({ code: 'promoter_payable', type: 'liability', ownerType: 'promoter', ownerId: commission.promoterUserId, ownerPublicId: String(commission.promoterUserId), country: order.country, currency: commission.currency }, session);
      const expense = await ensureLedgerAccount({ code: 'promoter_commission_expense', type: 'expense', ownerType: 'platform', ownerPublicId: 'classic-mart', country: order.country, currency: commission.currency }, session);
      await postLedgerTransaction({ idempotencyKey: `commission-reversal:${refund.publicId}:${commission.publicId}`, referenceType: 'commission_reversal', referencePublicId: commission.publicId, currency: commission.currency, country: order.country, description: `Commission reversal for refund ${refund.publicId}`, entries: [{ account: payable, debitMinor: reversal, creditMinor: 0, memo: 'Reverse promoter payable' }, { account: expense, debitMinor: 0, creditMinor: reversal, memo: 'Reverse acquisition expense' }] }, session);
    }
    commission.reversedAmountMinor = (commission.reversedAmountMinor || 0) + reversal;
    commission.reversalRefundPublicId = refund.publicId; commission.reversalReason = `Refund ${refund.publicId}`; commission.reversedAt = new Date();
    commission.status = commission.reversedAmountMinor >= commission.amountMinor ? 'reversed' : 'partially_reversed'; await commission.save({ session });
  }
}

export async function settlePromoterCommissions(userId, amountMinor) {
  let remaining = Math.max(0, Number(amountMinor || 0));
  const commissions = await CommissionEntry.find({ promoterUserId: userId, status: { $in: ['payable', 'partially_reversed'] } }).sort({ payableAt: 1, createdAt: 1 });
  for (const commission of commissions) {
    if (remaining <= 0) break;
    const net = Math.max(0, commission.amountMinor - (commission.reversedAmountMinor || 0));
    const unpaid = Math.max(0, net - (commission.paidAmountMinor || 0));
    if (!unpaid) continue;
    const applied = Math.min(unpaid, remaining);
    commission.paidAmountMinor = (commission.paidAmountMinor || 0) + applied;
    remaining -= applied;
    if (commission.paidAmountMinor >= net) { commission.status = 'paid'; commission.paidAt = new Date(); }
    await commission.save();
  }
  return { appliedMinor: Math.max(0, Number(amountMinor || 0)) - remaining, unappliedMinor: remaining };
}


export async function buildCampaignContentKit(request, input) {
  const verification = await PromoterVerification.findOne({ userId: request.user._id, status: 'verified' });
  if (!verification) throw new AppError('Verified promoter account is required.', 403, 'PROMOTER_NOT_VERIFIED');
  const campaign = await Campaign.findOne({ publicId: input.campaignId, country: request.user.country, status: 'active' });
  if (!campaign || !campaignIsLive(campaign)) throw new AppError('Active campaign not found.', 404, 'CAMPAIGN_NOT_FOUND');
  const application = await CampaignApplication.findOne({ campaignId: campaign._id, promoterUserId: request.user._id, status: 'approved' });
  if (!application) throw new AppError('Campaign approval is required.', 403, 'CAMPAIGN_APPROVAL_REQUIRED');
  const channel = String(input.channel || '').trim();
  if (channel && campaign.allowedChannels.length && !campaign.allowedChannels.includes(channel)) throw new AppError('That channel is not allowed for this campaign.', 422, 'CAMPAIGN_CHANNEL_NOT_ALLOWED');
  const couponCode = String(input.couponCode || '').trim().toUpperCase();
  const link = await createPromoterLink(request, { campaignId: campaign.publicId, destination: input.destination, couponCode, subId: input.subId || '', channel, utmSource: 'classicmart-promoter', utmMedium: 'affiliate', utmCampaign: campaign.publicId, utmContent: input.utmContent || 'content-studio' });
  const facts = campaign.facts.slice(0, 4);
  const factSentence = facts.length ? facts.join(' • ') : 'See the approved Classic Mart listing for current product details.';
  const disclosure = campaign.disclosureText || 'Sponsored/affiliate promotion for Classic Mart.';
  const linkPath = `/r/${link.token}`;
  const campaignTag = campaign.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 3).map(x => `#${x.replace(/[^a-z0-9]/g, '')}`).join(' ');
  const channelTag = channel ? `#${channel.toLowerCase().replace(/[^a-z0-9]/g, '')}` : '';
  return {
    campaignId: campaign.publicId, campaignName: campaign.name, channel, trackedUrl: linkPath, couponCode: link.couponCode || '', disclosure,
    caption: `${campaign.name}: ${factSentence} ${disclosure} Shop: ${linkPath}`,
    whatsapp: `Classic Mart — ${campaign.name}\n${factSentence}\n${link.couponCode ? `Code: ${link.couponCode}\n` : ''}${disclosure}\n${linkPath}`,
    posterText: `${campaign.name}\n${facts[0] || 'Shop the approved offer on Classic Mart'}\n${link.couponCode ? `Use code ${link.couponCode}\n` : ''}${disclosure}`,
    hashtags: [campaignTag, channelTag, '#ClassicMart', '#Sponsored'].filter(Boolean).join(' '),
    postingTimeSuggestion: ['whatsapp','facebook'].includes(channel.toLowerCase()) ? '18:00–20:00 local time; test against your own audience analytics.' : '12:00–14:00 or 18:00–20:00 local time; test against your own audience analytics.',
    approvedFacts: facts,
  };
}

export async function appealCommissionReversal(request, commissionPublicId, message) {
  const commission = await CommissionEntry.findOne({ publicId: commissionPublicId, promoterUserId: request.user._id, status: { $in: ['reversed', 'partially_reversed'] } });
  if (!commission) throw new AppError('Reversed commission not found.', 404, 'COMMISSION_NOT_FOUND');
  if (commission.appeal?.status === 'pending') throw new AppError('This commission appeal is already pending.', 409, 'COMMISSION_APPEAL_PENDING');
  commission.appeal = { status: 'pending', message, decision: '', submittedAt: new Date() };
  await commission.save(); return commission;
}

export async function reviewCommissionAppeal(request, commissionPublicId, { decision, reason }) {
  const commission = await CommissionEntry.findOne({ publicId: commissionPublicId, 'appeal.status': 'pending' });
  if (!commission) throw new AppError('Pending commission appeal not found.', 404, 'COMMISSION_APPEAL_NOT_FOUND');
  const campaign = await Campaign.findById(commission.campaignId).lean();
  if (!campaign || (request.user.role !== 'super_admin' && campaign.country !== request.user.country)) throw new AppError('Commission is outside your country scope.', 403, 'COUNTRY_SCOPE');
  if (decision === 'accept' && commission.reversedAmountMinor > 0) {
    const session = await mongoose.startSession();
    try { await session.withTransaction(async () => {
      const current = await CommissionEntry.findById(commission._id).session(session);
      if (!current || current.appeal?.status !== 'pending') throw new AppError('Commission appeal changed.', 409, 'COMMISSION_APPEAL_STATE');
      const restore = current.reversedAmountMinor;
      const payable = await ensureLedgerAccount({ code: 'promoter_payable', type: 'liability', ownerType: 'promoter', ownerId: current.promoterUserId, ownerPublicId: String(current.promoterUserId), country: campaign.country, currency: current.currency }, session);
      const expense = await ensureLedgerAccount({ code: 'promoter_commission_expense', type: 'expense', ownerType: 'platform', ownerPublicId: 'classic-mart', country: campaign.country, currency: current.currency }, session);
      await postLedgerTransaction({ idempotencyKey: `commission-appeal:${current.publicId}:${current.appeal.submittedAt?.getTime?.() || Date.now()}`, referenceType: 'commission_appeal', referencePublicId: current.publicId, currency: current.currency, country: campaign.country, description: `Accepted commission reversal appeal ${current.publicId}`, entries: [{ account: expense, debitMinor: restore, creditMinor: 0, memo: 'Restore commission expense after accepted appeal' }, { account: payable, debitMinor: 0, creditMinor: restore, memo: 'Restore promoter payable after accepted appeal' }] }, session);
      current.reversedAmountMinor = 0; current.reversalReason = ''; current.reversalRefundPublicId = ''; current.reversedAt = undefined;
      const netPaid = Number(current.paidAmountMinor || 0); current.status = netPaid >= current.amountMinor ? 'paid' : 'payable';
      current.appeal.status = 'accepted'; current.appeal.decision = reason; current.appeal.reviewedAt = new Date(); current.appeal.reviewedByUserId = request.user._id;
      await current.save({ session });
    }); } finally { await session.endSession(); }
  } else {
    commission.appeal.status = 'rejected'; commission.appeal.decision = reason; commission.appeal.reviewedAt = new Date(); commission.appeal.reviewedByUserId = request.user._id; await commission.save();
  }
  return CommissionEntry.findById(commission._id).lean();
}

export async function promoterSummary(user) {
  const [verification, links, commissions, applications, campaigns, contacts] = await Promise.all([
    PromoterVerification.findOne({ userId: user._id }).lean(),
    PromoterLink.find({ promoterUserId: user._id }).sort({ createdAt: -1 }).limit(50).lean(),
    CommissionEntry.find({ promoterUserId: user._id }).sort({ createdAt: -1 }).limit(100).lean(),
    CampaignApplication.find({ promoterUserId: user._id }).sort({ createdAt: -1 }).limit(100).lean(),
    Campaign.find({ country: user.country, status: 'active' }).sort({ createdAt: -1 }).limit(100).lean(),
    PromoterContactRequest.find({ promoterUserId: user._id }).populate('customerUserId', 'name').sort({ lastMessageAt: -1, createdAt: -1 }).limit(100).lean(),
  ]);
  const linkIds = links.map(link => link._id);
  const touches = linkIds.length ? await AttributionTouch.find(mongoose.trusted({ linkId: { $in: linkIds } })).select('-ipHash -userAgentHash -referrerHash').lean() : [];
  const totals = commissions.reduce((result, commission) => { const net = Math.max(0, commission.amountMinor - (commission.reversedAmountMinor || 0)); const unpaid = Math.max(0, net - (commission.paidAmountMinor || 0)); result[commission.status] = (result[commission.status] || 0) + (commission.status === 'paid' ? net : unpaid); result.paid = (result.paid || 0) + Math.min(net, commission.paidAmountMinor || 0); result.outstanding = (result.outstanding || 0) + unpaid; return result; }, {});
  const linkById = new Map(links.map(link => [String(link._id), link]));
  const campaignById = new Map(campaigns.map(campaign => [String(campaign._id), campaign]));
  const bucket = (map, key, seed = {}) => { const name = key || 'Unspecified'; if (!map.has(name)) map.set(name, { key: name, clicks: 0, conversions: 0, commissionMinor: 0, ...seed }); return map.get(name); };
  const byLink = new Map(), byChannel = new Map(), byCampaign = new Map(), byProduct = new Map(), bySeller = new Map(), byDate = new Map();
  for (const touch of touches) {
    const link = linkById.get(String(touch.linkId));
    const linkRow = bucket(byLink, link?.publicId || String(touch.linkId), { channel: link?.channel || '', couponCode: link?.couponCode || '' });
    const channelRow = bucket(byChannel, link?.channel || 'direct');
    const campaignRow = bucket(byCampaign, link ? String(link.campaignId) : String(touch.campaignId), { name: campaignById.get(String(touch.campaignId))?.name || '' });
    const dateRow = bucket(byDate, new Date(touch.landedAt).toISOString().slice(0, 10));
    for (const row of [linkRow, channelRow, campaignRow, dateRow]) { row.clicks += 1; if (touch.status === 'converted') row.conversions += 1; }
  }
  for (const commission of commissions) {
    const net = Math.max(0, commission.amountMinor - (commission.reversedAmountMinor || 0));
    bucket(byCampaign, String(commission.campaignId), { name: campaignById.get(String(commission.campaignId))?.name || '' }).commissionMinor += net;
    bucket(byProduct, commission.productPublicId).commissionMinor += net;
    bucket(bySeller, commission.storePublicId).commissionMinor += net;
    bucket(byDate, new Date(commission.createdAt).toISOString().slice(0, 10)).commissionMinor += net;
  }
  const analytics = { byLink: [...byLink.values()], byChannel: [...byChannel.values()], byCampaign: [...byCampaign.values()], byProduct: [...byProduct.values()], bySeller: [...bySeller.values()], byDate: [...byDate.values()].sort((a,b)=>b.key.localeCompare(a.key)).slice(0,90) };
  return { verification, links, commissions, applications, campaigns, contacts, touches, totals, analytics, clicks: touches.length, conversions: touches.filter(t => t.status === 'converted').length };
}


function publicPromoterName(user) {
  return user?.roleProfile?.publicName || user?.roleProfile?.businessName || user?.name || 'Classic Mart promoter';
}

function livePublicCampaign(campaign, now = new Date()) {
  return campaign?.visibility === 'public' && campaignIsLive(campaign, now);
}

async function promoterPublicRows(country, { verificationPublicId = '', includeProducts = false } = {}) {
  const countryCode = String(country?.code || country || '').toUpperCase();
  const verificationQuery = { country: countryCode, status: 'verified' };
  if (verificationPublicId) verificationQuery.publicId = verificationPublicId;
  const verifications = await PromoterVerification.find(verificationQuery).sort({ reviewedAt: -1, createdAt: -1 }).limit(100).lean();
  if (!verifications.length) return [];

  const userIds = verifications.map((row) => row.userId);
  const users = await User.find({ _id: mongoose.trusted({ $in: userIds }), role: 'promoter', status: 'active', country: countryCode })
    .select('publicId name roleProfile country locale')
    .lean();
  const activeUserIds = users.map((user) => user._id);
  if (!activeUserIds.length) return [];

  const [applications, links, touchGroups, commissionGroups] = await Promise.all([
    CampaignApplication.find({ promoterUserId: mongoose.trusted({ $in: activeUserIds }), country: countryCode, status: 'approved' }).select('promoterUserId campaignId').lean(),
    PromoterLink.find({ promoterUserId: mongoose.trusted({ $in: activeUserIds }), active: true }).select('promoterUserId campaignId').lean(),
    AttributionTouch.aggregate([
      { $match: { promoterUserId: { $in: activeUserIds }, country: countryCode, status: { $in: ['valid', 'converted'] } } },
      { $group: { _id: '$promoterUserId', clicks: { $sum: 1 }, conversions: { $sum: { $cond: [{ $eq: ['$status', 'converted'] }, 1, 0] } } } },
    ]),
    CommissionEntry.aggregate([
      { $match: { promoterUserId: { $in: activeUserIds } } },
      { $group: { _id: '$promoterUserId', earnedMinor: { $sum: { $cond: [{ $gt: [{ $subtract: [{ $ifNull: ['$amountMinor', 0] }, { $ifNull: ['$reversedAmountMinor', 0] }] }, 0] }, { $subtract: [{ $ifNull: ['$amountMinor', 0] }, { $ifNull: ['$reversedAmountMinor', 0] }] }, 0] } } } },
    ]),
  ]);

  const campaignIds = [...new Set(applications.map((row) => String(row.campaignId)))];
  const campaigns = campaignIds.length
    ? await Campaign.find({ _id: mongoose.trusted({ $in: campaignIds }), country: countryCode, status: 'active', visibility: 'public' }).lean()
    : [];
  const liveCampaigns = campaigns.filter((campaign) => livePublicCampaign(campaign));
  const campaignById = new Map(liveCampaigns.map((campaign) => [String(campaign._id), campaign]));
  const userById = new Map(users.map((user) => [String(user._id), user]));
  const verificationByUser = new Map(verifications.map((row) => [String(row.userId), row]));
  const applicationsByUser = new Map();
  for (const application of applications) {
    const campaign = campaignById.get(String(application.campaignId));
    if (!campaign) continue;
    const key = String(application.promoterUserId);
    const rows = applicationsByUser.get(key) || [];
    rows.push(campaign);
    applicationsByUser.set(key, rows);
  }
  const linkCountByUser = new Map();
  for (const link of links) {
    if (!campaignById.has(String(link.campaignId))) continue;
    const key = String(link.promoterUserId);
    linkCountByUser.set(key, (linkCountByUser.get(key) || 0) + 1);
  }
  const touchByUser = new Map(touchGroups.map((row) => [String(row._id), row]));
  const commissionByUser = new Map(commissionGroups.map((row) => [String(row._id), row]));

  const rows = [];
  for (const userId of activeUserIds) {
    const key = String(userId);
    const user = userById.get(key);
    const verification = verificationByUser.get(key);
    if (!user || !verification) continue;
    const userCampaigns = applicationsByUser.get(key) || [];
    const touches = touchByUser.get(key) || { clicks: 0, conversions: 0 };
    const commission = commissionByUser.get(key) || { earnedMinor: 0 };
    const productPublicIds = [...new Set(userCampaigns.flatMap((campaign) => campaign.productPublicIds || []))];
    const products = includeProducts && productPublicIds.length
      ? await publishedProductsByPublicIds(productPublicIds.slice(0, 30), country)
      : [];
    rows.push({
      id: verification.publicId,
      userPublicId: user.publicId,
      userMongoId: key,
      name: publicPromoterName(user),
      description: user.roleProfile?.bio || user.roleProfile?.focus || 'Verified Classic Mart marketplace promoter.',
      focus: user.roleProfile?.focus || '',
      location: user.roleProfile?.location || '',
      country: user.country,
      locale: user.locale || country?.locale || 'en-UG',
      image: '/assets/image-placeholder.svg',
      channels: verification.channels || [],
      niches: verification.niches || [],
      campaignCount: userCampaigns.length,
      linkCount: linkCountByUser.get(key) || 0,
      clicks: Number(touches.clicks || 0),
      conversions: Number(touches.conversions || 0),
      earnedMinor: Number(commission.earnedMinor || 0),
      campaigns: userCampaigns.map((campaign) => ({
        id: campaign.publicId,
        name: campaign.name,
        facts: (campaign.facts || []).slice(0, 4),
        disclosure: campaign.disclosureText,
        productPublicIds: campaign.productPublicIds || [],
      })),
      products,
    });
  }
  return rows.sort((a, b) => b.conversions - a.conversions || b.clicks - a.clicks || a.name.localeCompare(b.name));
}

export async function publicPromoters(country) {
  return promoterPublicRows(country);
}

export async function publicPromoter(verificationPublicId, country) {
  const [row] = await promoterPublicRows(country, { verificationPublicId, includeProducts: true });
  return row || null;
}

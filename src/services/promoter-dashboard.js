import mongoose from 'mongoose';
import { MarketplaceConversation, Referral, Store } from '../models/index.js';
import { promoterSummary } from './promoters.js';
import { ensureReferralCode } from './stage9.js';
import { payoutAccountsForRequest, payoutsForRequest } from './payments.js';

function safeNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function campaignIsApprovedForPromoter(campaign) {
  return campaign?.promoterApplication?.status === 'approved';
}

function contentRows(campaigns) {
  const rows = [];
  for (const campaign of campaigns.filter(campaignIsApprovedForPromoter)) {
    for (const asset of campaign.assets || []) {
      if (!asset?.approved) continue;
      rows.push({
        campaignPublicId: campaign.publicId,
        campaignName: campaign.name,
        type: asset.type,
        label: asset.label || asset.type,
        url: asset.url || '',
        disclosureText: campaign.disclosureText || '',
      });
    }
    for (const fact of campaign.facts || []) {
      rows.push({
        campaignPublicId: campaign.publicId,
        campaignName: campaign.name,
        type: 'copy',
        label: 'Approved campaign fact',
        url: '',
        text: fact,
        disclosureText: campaign.disclosureText || '',
      });
    }
  }
  return rows;
}

function activeApplications(summary) {
  const campaignById = new Map((summary.campaigns || []).map((row) => [String(row._id), row]));
  return (summary.applications || []).map((application) => ({
    ...application,
    campaign: campaignById.get(String(application.campaignId)) || null,
  }));
}

function payoutTotals(payouts) {
  return payouts.reduce((acc, row) => {
    const amount = safeNumber(row.amountMinor);
    acc.totalMinor += amount;
    acc.count += 1;
    acc.byStatus[row.status] = (acc.byStatus[row.status] || 0) + amount;
    return acc;
  }, { totalMinor: 0, count: 0, byStatus: {} });
}

export async function loadPromoterDashboard(request) {
  const user = request.user;
  const summary = await promoterSummary(user, {
    linksAfter: request.query.linksAfter || '',
    commissionsAfter: request.query.commissionsAfter || '',
    applicationsAfter: request.query.applicationsAfter || '',
    campaignsAfter: request.query.campaignsAfter || '',
    contactsAfter: request.query.contactsAfter || '',
  });

  const storeIds = [...new Set((summary.campaigns || []).map((row) => String(row.storeId || '')).filter((id) => mongoose.isValidObjectId(id)))].map((id) => new mongoose.Types.ObjectId(id));
  const sellerPublicIds = [...new Set((summary.analytics?.bySeller || []).map((row) => String(row.key || '')).filter(Boolean))];

  const [referralCode, referrals, payoutAccounts, payouts, campaignStores, earnedStores, conversations] = await Promise.all([
    ensureReferralCode(user),
    Referral.find({ referrerUserId: user._id }).populate('referredUserId', 'name email role status').sort({ createdAt: -1 }).limit(100).lean(),
    payoutAccountsForRequest(request),
    payoutsForRequest(request, { limit: 100 }),
    storeIds.length ? Store.find({ _id: { $in: storeIds } }).select('publicId name status country currency').lean() : Promise.resolve([]),
    sellerPublicIds.length ? Store.find({ publicId: { $in: sellerPublicIds } }).select('publicId name status country currency').lean() : Promise.resolve([]),
    MarketplaceConversation.find({ participantUserIds: user._id }).populate('participantUserIds', 'name role').sort({ lastMessageAt: -1 }).limit(100).lean(),
  ]);

  const stores = new Map();
  for (const store of [...campaignStores, ...earnedStores]) stores.set(store.publicId, store);
  const storeById = new Map(campaignStores.map((store) => [String(store._id), store]));
  const campaigns = (summary.campaigns || []).map((campaign) => ({ ...campaign, store: storeById.get(String(campaign.storeId)) || null }));
  const applications = activeApplications({ ...summary, campaigns });

  return {
    user,
    verification: summary.verification,
    campaigns,
    applications,
    links: summary.links || [],
    commissions: summary.commissions || [],
    contacts: summary.contacts || [],
    conversations,
    totals: summary.totals || { earned: 0, paid: 0, outstanding: 0, currency: user.currency },
    commissionStages: summary.commissionStages || {},
    risk: summary.risk || {},
    analytics: summary.analytics || { byLink: [], byChannel: [], byCampaign: [], byProduct: [], bySeller: [], byDate: [] },
    clicks: safeNumber(summary.clicks),
    conversions: safeNumber(summary.conversions),
    content: contentRows(campaigns),
    referralCode,
    referrals,
    stores: [...stores.values()],
    payoutAccounts,
    payouts,
    payoutTotals: payoutTotals(payouts),
    queuePages: summary.queuePages || {},
  };
}

import {
  ApprovalRequest, AuditLog, Category, CommissionEntry, CountrySetting, Dispute, FeatureFlag, Incident,
  IpBlock, LaunchEvidence, MarketingCampaign, OperationalAlert, Order, PaymentIntent, Payout, Product,
  PromoterVerification, SecurityFinding, Store, SubscriptionEnrollment, SupportTicket, User, WorkerHeartbeat,
} from '../models/index.js';

const LIMIT = 50;
export const SUPER_ADMIN_PAGES = new Set([
  'super-overview','super-analytics','super-users','super-roles','super-admins','super-sellers','super-promoters',
  'super-customers','super-products','super-categories','super-orders','super-finance','super-commissions',
  'super-subscriptions','super-disputes','super-reports','super-audit','super-security','super-notifications',
  'super-support','super-settings',
]);

const emptySummary = () => ({
  totalUsers:0,totalStores:0,totalProducts:0,totalOrders:0,totalPayments:0,totalPayouts:0,totalCommissions:0,
  totalSubscriptions:0,totalDisputes:0,totalTickets:0,totalCategories:0,pendingApprovals:0,openDisputes:0,
  paymentExceptions:0,payoutExceptions:0,openFindings:0,activeAlerts:0,openSupport:0,activeCountries:0,
  adminAccounts:0,promoterQueue:0,moderationQueue:0,activeSubscriptions:0,activeCampaigns:0,overdueTickets:0,
  openIncidents:0,activeWorkers:0,launchMissing:0,activeBlocks:0,
});
const emptyAnalytics = () => ({roleCounts:{},countryCounts:{},orderStatuses:{},paymentStatuses:{},recentUsers:0,recentOrders:0});
const toCounts = (rows=[]) => Object.fromEntries(rows.map((row)=>[String(row._id||'unknown'),Number(row.count||0)]));
const requestedPage = (request) => {
  const value=String(request.query?.page||'').trim();
  return SUPER_ADMIN_PAGES.has(value)?value:'super-overview';
};

export async function loadSuperAdminDashboard(request){
  const user=request.user;
  const page=requestedPage(request);
  const now=new Date();
  const sevenDaysAgo=new Date(now.getTime()-7*86_400_000);
  const dashboard={
    page,
    user:{publicId:user.publicId,name:user.name,preferences:user.preferences||{}},
    users:[],admins:[],stores:[],promoters:[],customers:[],products:[],categories:[],orders:[],payments:[],payouts:[],
    commissions:[],subscriptions:[],disputes:[],auditLogs:[],securityFindings:[],alerts:[],tickets:[],countrySettings:[],
    featureFlags:[],approvals:[],incidents:[],workers:[],campaigns:[],ipBlocks:[],launchEvidence:[],attention:[],
    analytics:emptyAnalytics(),summary:emptySummary(),
  };

  switch(page){
    case 'super-analytics': {
      const [roles,countries,orderStatuses,paymentStatuses,recentUsers,recentOrders,totalStores,activeCountries] = await Promise.all([
        User.aggregate([{$group:{_id:'$role',count:{$sum:1}}}]),
        User.aggregate([{$group:{_id:'$country',count:{$sum:1}}}]),
        Order.aggregate([{$group:{_id:'$status',count:{$sum:1}}}]),
        PaymentIntent.aggregate([{$group:{_id:'$status',count:{$sum:1}}}]),
        User.countDocuments({createdAt:{$gte:sevenDaysAgo}}),
        Order.countDocuments({createdAt:{$gte:sevenDaysAgo}}),
        Store.estimatedDocumentCount(),
        CountrySetting.countDocuments({active:true}),
      ]);
      dashboard.analytics={roleCounts:toCounts(roles),countryCounts:toCounts(countries),orderStatuses:toCounts(orderStatuses),paymentStatuses:toCounts(paymentStatuses),recentUsers,recentOrders};
      Object.assign(dashboard.summary,{totalStores,activeCountries});
      break;
    }
    case 'super-users':
      dashboard.users=await User.find({}).select('publicId name role status country security.mfaEnabled createdAt updatedAt').sort({createdAt:-1}).limit(LIMIT).lean();
      break;
    case 'super-roles': {
      dashboard.analytics.roleCounts=toCounts(await User.aggregate([{$group:{_id:'$role',count:{$sum:1}}}]));
      break;
    }
    case 'super-admins':
      dashboard.admins=await User.find({role:{$in:['super_admin','country_admin','finance','support','moderator','warehouse']}})
        .select('publicId name role status country security.mfaEnabled createdAt updatedAt').sort({role:1,name:1}).limit(LIMIT).lean();
      break;
    case 'super-sellers': {
      const [stores,totalStores]=await Promise.all([
        Store.find({}).select('publicId name country status createdAt updatedAt').sort({updatedAt:-1}).limit(LIMIT).lean(),
        Store.estimatedDocumentCount(),
      ]);
      dashboard.stores=stores; dashboard.summary.totalStores=totalStores; break;
    }
    case 'super-promoters': {
      const [promoterQueue,activeCampaigns]=await Promise.all([
        PromoterVerification.countDocuments({status:{$nin:['approved','rejected']}}),
        MarketingCampaign.countDocuments({status:{$in:['scheduled','running']}}),
      ]);
      Object.assign(dashboard.summary,{promoterQueue,activeCampaigns}); break;
    }
    case 'super-customers':
      dashboard.customers=await User.find({role:'customer'}).select('publicId name role status country createdAt updatedAt').sort({createdAt:-1}).limit(LIMIT).lean();
      break;
    case 'super-products': {
      const [products,totalProducts,moderationQueue]=await Promise.all([
        Product.find({}).select('publicId title status countries qualityScore moderation.riskLevel moderation.secondReviewRequired createdAt updatedAt').sort({updatedAt:-1}).limit(LIMIT).lean(),
        Product.estimatedDocumentCount(),
        Product.countDocuments({$or:[{status:{$in:['submitted','changes_requested']}},{'moderation.secondReviewRequired':true}]}),
      ]);
      dashboard.products=products; Object.assign(dashboard.summary,{totalProducts,moderationQueue}); break;
    }
    case 'super-categories': {
      const [categories,totalCategories]=await Promise.all([
        Category.find({}).select('publicId name active restricted countries createdAt updatedAt').sort({name:1}).limit(LIMIT).lean(),
        Category.estimatedDocumentCount(),
      ]);
      dashboard.categories=categories; dashboard.summary.totalCategories=totalCategories; break;
    }
    case 'super-orders': {
      const [orders,totalOrders,recentOrders,statuses]=await Promise.all([
        Order.find({}).select('publicId country status paymentState fulfillmentState totals.currency totals.totalMinor createdAt updatedAt').sort({createdAt:-1}).limit(LIMIT).lean(),
        Order.estimatedDocumentCount(),
        Order.countDocuments({createdAt:{$gte:sevenDaysAgo}}),
        Order.aggregate([{$group:{_id:'$status',count:{$sum:1}}}]),
      ]);
      dashboard.orders=orders; dashboard.summary.totalOrders=totalOrders; dashboard.analytics.recentOrders=recentOrders; dashboard.analytics.orderStatuses=toCounts(statuses); break;
    }
    case 'super-finance': {
      const [totalPayments,paymentExceptions,payoutExceptions]=await Promise.all([
        PaymentIntent.estimatedDocumentCount(),
        PaymentIntent.countDocuments({status:{$in:['pending','failed','unknown']}}),
        Payout.countDocuments({status:{$in:['pending_approval','failed','unknown']}}),
      ]);
      Object.assign(dashboard.summary,{totalPayments,paymentExceptions,payoutExceptions}); break;
    }
    case 'super-commissions': {
      const [commissions,totalCommissions]=await Promise.all([
        CommissionEntry.find({}).select('publicId status currency amountMinor commissionBps storePublicId productPublicId createdAt updatedAt').sort({createdAt:-1}).limit(LIMIT).lean(),
        CommissionEntry.estimatedDocumentCount(),
      ]);
      dashboard.commissions=commissions; dashboard.summary.totalCommissions=totalCommissions; break;
    }
    case 'super-subscriptions': {
      const [subscriptions,totalSubscriptions,activeSubscriptions]=await Promise.all([
        SubscriptionEnrollment.find({}).select('publicId audience country currency priceMinor status planPublicId startsAt currentPeriodEndsAt createdAt updatedAt').sort({updatedAt:-1}).limit(LIMIT).lean(),
        SubscriptionEnrollment.estimatedDocumentCount(),
        SubscriptionEnrollment.countDocuments({status:{$in:['trialing','active']}}),
      ]);
      dashboard.subscriptions=subscriptions; Object.assign(dashboard.summary,{totalSubscriptions,activeSubscriptions}); break;
    }
    case 'super-disputes': {
      const [openDisputes,openFindings,openIncidents]=await Promise.all([
        Dispute.countDocuments({status:{$nin:['resolved','rejected','closed']}}),
        SecurityFinding.countDocuments({status:{$nin:['remediated','closed']}}),
        Incident.countDocuments({status:{$ne:'resolved'}}),
      ]);
      Object.assign(dashboard.summary,{openDisputes,openFindings,openIncidents}); break;
    }
    case 'super-reports': {
      const [totalUsers,totalOrders,totalPayments,totalTickets]=await Promise.all([
        User.estimatedDocumentCount(),Order.estimatedDocumentCount(),PaymentIntent.estimatedDocumentCount(),SupportTicket.estimatedDocumentCount(),
      ]);
      Object.assign(dashboard.summary,{totalUsers,totalOrders,totalPayments,totalTickets}); break;
    }
    case 'super-audit':
      dashboard.auditLogs=await AuditLog.find({}).select('requestId actorPublicId action targetType targetPublicId country result createdAt').sort({createdAt:-1}).limit(LIMIT).lean();
      break;
    case 'super-security': {
      const [workers,launchEvidence,activeBlocks,openFindings]=await Promise.all([
        WorkerHeartbeat.find({}).select('workerId hostname status lastHeartbeatAt lastCycleOk lastCycleCompletedAt lastCycleDurationMs').sort({lastHeartbeatAt:-1}).limit(LIMIT).lean(),
        LaunchEvidence.find({}).select('key status verifiedAt validUntil updatedAt').sort({key:1}).lean(),
        IpBlock.countDocuments({expiresAt:{$gt:now}}),
        SecurityFinding.countDocuments({status:{$nin:['remediated','closed']}}),
      ]);
      dashboard.workers=workers; dashboard.launchEvidence=launchEvidence;
      Object.assign(dashboard.summary,{
        activeBlocks,openFindings,
        activeWorkers:workers.filter((row)=>row.status==='active'&&row.lastHeartbeatAt&&now-new Date(row.lastHeartbeatAt)<5*60_000).length,
        launchMissing:launchEvidence.filter((row)=>!['passed','not_applicable'].includes(row.status)).length,
      });
      break;
    }
    case 'super-notifications':
      dashboard.campaigns=await MarketingCampaign.find({}).select('publicId name country status roles scheduledAt startedAt completedAt eligibleCount queuedCount createdAt updatedAt').sort({updatedAt:-1}).limit(LIMIT).lean();
      break;
    case 'super-support': {
      const [tickets,openSupport,overdueTickets]=await Promise.all([
        SupportTicket.find({status:{$nin:['resolved','closed']}}).select('publicId status priority country queue category slaDueAt createdAt updatedAt').sort({updatedAt:-1}).limit(LIMIT).lean(),
        SupportTicket.countDocuments({status:{$nin:['resolved','closed']}}),
        SupportTicket.countDocuments({status:{$nin:['resolved','closed']},slaDueAt:{$lt:now}}),
      ]);
      dashboard.tickets=tickets; Object.assign(dashboard.summary,{openSupport,overdueTickets}); break;
    }
    case 'super-settings': {
      const [featureFlags,pendingApprovals,openIncidents]=await Promise.all([
        FeatureFlag.find({}).select('publicId key enabled countries roles rolloutPercentage startsAt endsAt version updatedAt').sort({key:1}).limit(LIMIT).lean(),
        ApprovalRequest.countDocuments({status:{$in:['requested','approved']}}),
        Incident.countDocuments({status:{$ne:'resolved'}}),
      ]);
      dashboard.featureFlags=featureFlags; Object.assign(dashboard.summary,{pendingApprovals,openIncidents}); break;
    }
    case 'super-overview':
    default: {
      const [alerts,findings,incidents,disputes,tickets,approvals,totalUsers,totalOrders,activeAlerts,pendingApprovals]=await Promise.all([
        OperationalAlert.find({status:{$nin:['resolved','suppressed']}}).select('publicId status severity country type title message lastSeenAt').sort({lastSeenAt:-1}).limit(12).lean(),
        SecurityFinding.find({status:{$nin:['remediated','closed']}}).select('publicId status severity country title updatedAt').sort({updatedAt:-1}).limit(10).lean(),
        Incident.find({status:{$ne:'resolved'}}).select('publicId status severity country title updatedAt').sort({updatedAt:-1}).limit(8).lean(),
        Dispute.find({status:{$nin:['resolved','rejected','closed']},priority:{$in:['high','urgent']}}).select('publicId country priority subject status updatedAt').sort({updatedAt:-1}).limit(8).lean(),
        SupportTicket.find({status:{$nin:['resolved','closed']},slaDueAt:{$lt:now}}).select('publicId priority country slaDueAt status').sort({slaDueAt:1}).limit(8).lean(),
        ApprovalRequest.find({status:{$in:['requested','approved']}}).select('publicId type status country targetPublicId createdAt').sort({createdAt:-1}).limit(8).lean(),
        User.estimatedDocumentCount(),Order.estimatedDocumentCount(),
        OperationalAlert.countDocuments({status:{$nin:['resolved','suppressed']}}),
        ApprovalRequest.countDocuments({status:{$in:['requested','approved']}}),
      ]);
      dashboard.alerts=alerts;dashboard.securityFindings=findings;dashboard.incidents=incidents;dashboard.disputes=disputes;dashboard.tickets=tickets;dashboard.approvals=approvals;
      dashboard.attention=[
        ...alerts.map((row)=>({kind:'Operational alert',severity:row.severity||'medium',title:row.title||row.type,country:row.country||'Global',href:'/admin/health'})),
        ...findings.map((row)=>({kind:'Security finding',severity:row.severity||'medium',title:row.title,country:row.country||'Global',href:'/admin/security'})),
        ...incidents.map((row)=>({kind:'Incident',severity:row.severity==='sev1'?'critical':row.severity==='sev2'?'high':'medium',title:row.title,country:row.country||'Global',href:'/admin/incidents'})),
        ...disputes.map((row)=>({kind:'Dispute',severity:row.priority==='urgent'?'critical':'high',title:row.subject||row.publicId,country:row.country||'Global',href:'/moderation'})),
        ...tickets.map((row)=>({kind:'Support SLA',severity:row.priority==='urgent'?'critical':'high',title:`${row.publicId} overdue`,country:row.country||'Global',href:'/operations/support'})),
        ...approvals.map((row)=>({kind:'Four-eyes approval',severity:'medium',title:`${row.type} · ${row.targetPublicId||row.publicId}`,country:row.country||'Global',href:'/admin/approvals'})),
      ].slice(0,40);
      Object.assign(dashboard.summary,{totalUsers,totalOrders,activeAlerts,pendingApprovals});
      break;
    }
  }

  return dashboard;
}

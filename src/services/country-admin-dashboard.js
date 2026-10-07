import {
  ApprovalRequest, AuditLog, CmsContent, CountrySetting, Incident, OperationalAlert, PaymentIntent, Payout,
  Product, PromoterVerification, ReconciliationRun, SecurityFinding, SellerVerification, Shipment, SupportTicket,
  TrustCase, User,
} from '../models/index.js';
import { operationalCountriesFor } from './authorization.js';

const LIMIT = 40;
export const COUNTRY_ADMIN_PAGES = new Set([
  'country-attention','country-users','country-catalogue','country-orders','country-finance','country-promoters',
  'country-logistics','country-cms','country-settings','country-risk','country-system',
]);

const emptySummary = () => ({
  userCount:0,pendingUsers:0,productQueue:0,orderSupport:0,overdueTickets:0,paymentExceptions:0,
  payoutExceptions:0,promoterQueue:0,deliveryExceptions:0,moderationQueue:0,openFindings:0,
  activeAlerts:0,pendingApprovals:0,openIncidents:0,userRoles:{},paymentStatuses:{},shipmentStatuses:{},
});

function requestedPage(request) {
  const value = String(request.query?.page || '').trim();
  return COUNTRY_ADMIN_PAGES.has(value) ? value : 'country-attention';
}

export async function loadCountryAdminDashboard(request) {
  const user = request.user;
  const page = requestedPage(request);
  const allowedCountries = operationalCountriesFor(user).filter((code) => code && code !== '*');
  const countryScope = { country: { $in: allowedCountries } };
  const productScope = { countries: { $in: allowedCountries } };
  const now = new Date();
  const dashboard = {
    page,
    user:{publicId:user.publicId,name:user.name,email:user.email,country:user.country,preferences:user.preferences||{}},
    operationalCountries:allowedCountries,
    users:[],products:[],payments:[],payouts:[],reconciliations:[],promoters:[],shipments:[],tickets:[],
    sellerVerifications:[],trustCases:[],securityFindings:[],alerts:[],cms:[],countrySettings:[],approvals:[],
    incidents:[],auditLogs:[],attention:[],summary:emptySummary(),filters:{},
  };

  switch (page) {
    case 'country-users': {
      dashboard.users = await User.find(countryScope)
        .select('publicId name role status country security.mfaEnabled createdAt')
        .sort({createdAt:-1}).limit(LIMIT).lean();
      dashboard.summary.userCount = dashboard.users.length;
      dashboard.summary.pendingUsers = dashboard.users.filter((row)=>row.status !== 'active').length;
      break;
    }
    case 'country-catalogue': {
      dashboard.products = await Product.find(productScope)
        .select('publicId title status countries moderation updatedAt')
        .sort({updatedAt:-1}).limit(LIMIT).lean();
      dashboard.summary.productQueue = dashboard.products.filter((row)=>['submitted','draft'].includes(row.status)).length;
      break;
    }
    case 'country-orders': {
      const [orderSupport, overdueTickets, deliveryExceptions] = await Promise.all([
        SupportTicket.countDocuments({...countryScope,status:{$nin:['resolved','closed']}}),
        SupportTicket.countDocuments({...countryScope,status:{$nin:['resolved','closed']},slaDueAt:{$lt:now}}),
        Shipment.countDocuments({...countryScope,status:{$in:['failed','exception','return_to_sender','rescheduled']}}),
      ]);
      Object.assign(dashboard.summary,{orderSupport,overdueTickets,deliveryExceptions});
      break;
    }
    case 'country-finance': {
      const [paymentExceptions,payoutExceptions,reconciliations] = await Promise.all([
        PaymentIntent.countDocuments({...countryScope,status:{$in:['failed','unknown','pending']}}),
        Payout.countDocuments({...countryScope,status:{$in:['failed','unknown','pending_approval']}}),
        ReconciliationRun.find(countryScope).select('publicId status country provider startedAt completedAt').sort({createdAt:-1}).limit(LIMIT).lean(),
      ]);
      dashboard.reconciliations = reconciliations;
      Object.assign(dashboard.summary,{paymentExceptions,payoutExceptions});
      break;
    }
    case 'country-promoters': {
      dashboard.summary.promoterQueue = await PromoterVerification.countDocuments({...countryScope,status:{$nin:['approved','rejected']}});
      break;
    }
    case 'country-logistics': {
      dashboard.shipments = await Shipment.find(countryScope)
        .select('publicId status country kind createdAt updatedAt').sort({updatedAt:-1}).limit(LIMIT).lean();
      break;
    }
    case 'country-cms': {
      dashboard.cms = await CmsContent.find(countryScope)
        .select('publicId status country key type updatedAt').sort({updatedAt:-1}).limit(LIMIT).lean();
      break;
    }
    case 'country-settings': {
      dashboard.countrySettings = await CountrySetting.find({code:{$in:allowedCountries}})
        .select('code name currency active taxBps platformFeeBps updatedAt').sort({name:1}).lean();
      break;
    }
    case 'country-risk': {
      const [sellerQueue,trustQueue,openFindings,openIncidents] = await Promise.all([
        SellerVerification.countDocuments({...countryScope,status:{$in:['submitted','pending','appealed']}}),
        TrustCase.countDocuments({...countryScope,status:{$in:['open','appealed','investigating']}}),
        SecurityFinding.countDocuments({...countryScope,status:{$nin:['remediated','closed']}}),
        Incident.countDocuments({...countryScope,status:{$ne:'resolved'}}),
      ]);
      Object.assign(dashboard.summary,{moderationQueue:sellerQueue+trustQueue,openFindings,openIncidents});
      break;
    }
    case 'country-system': {
      dashboard.auditLogs = await AuditLog.find(countryScope)
        .select('action targetType targetPublicId country actorPublicId result createdAt requestId')
        .sort({createdAt:-1}).limit(LIMIT).lean();
      break;
    }
    case 'country-attention':
    default: {
      const [alerts,overdue,findings,trustCases,activeAlerts,pendingApprovals,paymentExceptions,openIncidents] = await Promise.all([
        OperationalAlert.find({...countryScope,status:{$nin:['resolved','suppressed']}})
          .select('publicId status severity country type title lastSeenAt').sort({lastSeenAt:-1}).limit(15).lean(),
        SupportTicket.find({...countryScope,status:{$nin:['resolved','closed']},slaDueAt:{$lt:now}})
          .select('publicId status priority country slaDueAt category').sort({slaDueAt:1}).limit(10).lean(),
        SecurityFinding.find({...countryScope,status:{$nin:['remediated','closed']}})
          .select('publicId status severity country title').sort({updatedAt:-1}).limit(10).lean(),
        TrustCase.find({...countryScope,status:{$in:['open','appealed','investigating']}})
          .select('publicId status severity country type').sort({updatedAt:-1}).limit(10).lean(),
        OperationalAlert.countDocuments({...countryScope,status:{$nin:['resolved','suppressed']}}),
        ApprovalRequest.countDocuments({...countryScope,status:{$in:['requested','approved']}}),
        PaymentIntent.countDocuments({...countryScope,status:{$in:['failed','unknown','pending']}}),
        Incident.countDocuments({...countryScope,status:{$ne:'resolved'}}),
      ]);
      dashboard.alerts = alerts;
      dashboard.tickets = overdue;
      dashboard.securityFindings = findings;
      dashboard.trustCases = trustCases;
      dashboard.attention = [
        ...alerts.map((row)=>({kind:'Operational alert',severity:row.severity||'medium',title:row.title||row.type,country:row.country,href:'/admin/health'})),
        ...overdue.map((row)=>({kind:'Support SLA',severity:row.priority==='urgent'?'high':'medium',title:`${row.publicId} overdue`,country:row.country,href:'/operations/support'})),
        ...findings.map((row)=>({kind:'Security finding',severity:row.severity||'medium',title:row.title,country:row.country,href:'/admin/security'})),
        ...trustCases.map((row)=>({kind:'Trust case',severity:row.severity||'medium',title:row.publicId,country:row.country,href:'/moderation'})),
      ].slice(0,40);
      Object.assign(dashboard.summary,{activeAlerts,pendingApprovals,paymentExceptions,openIncidents,overdueTickets:overdue.length});
      break;
    }
  }

  return dashboard;
}

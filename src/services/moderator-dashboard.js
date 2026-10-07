import { AppError } from '../core/errors.js';
import {
  AuditLog,
  Category,
  ModerationQaReview,
  Product,
  Review,
  RiskSignal,
  SellerVerification,
  Store,
  TrustCase,
} from '../models/index.js';
import { operationalCountriesFor } from './authorization.js';

const REVIEW_STATUSES=['pending','disputed'];
const CASE_STATUSES=['open','investigating','appealed'];
const VERIFICATION_STATUSES=['submitted','appealed','rejected'];
const RISK_SEVERITIES=['low','medium','high','critical'];

function escapeRegex(value){return String(value||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function pattern(value){return value?new RegExp(escapeRegex(value),'i'):null;}
function countBy(rows,field){const result={};for(const row of rows){const key=String(row?.[field]||'unknown');result[key]=(result[key]||0)+1;}return result;}

function moderatorScope(user,requestedCountry=''){
  const scopes=operationalCountriesFor(user);
  const allowedCountries=scopes.includes('*')?[]:scopes;
  const requested=String(requestedCountry||'').trim().toUpperCase();
  if(requested&&!/^[A-Z]{2}$/.test(requested))throw new AppError('Choose a valid two-letter moderation country.',422,'MODERATION_COUNTRY_INVALID');
  if(requested&&!scopes.includes('*')&&!allowedCountries.includes(requested))throw new AppError('Moderation country is outside your operational scope.',403,'MODERATION_COUNTRY_FORBIDDEN');
  if(requested)return {allowedCountries,countryScope:{country:requested},productScope:{countries:requested},storeScope:{country:requested},selectedCountry:requested};
  if(scopes.includes('*'))return {allowedCountries,countryScope:{},productScope:{},storeScope:{},selectedCountry:''};
  return {
    allowedCountries,
    countryScope:{country:{$in:allowedCountries}},
    productScope:{countries:{$in:allowedCountries}},
    storeScope:{country:{$in:allowedCountries}},
    selectedCountry:'',
  };
}

function filtersFor(query={}){
  return {
    requestedCountry:String(query.country||'').trim().toUpperCase(),
    productSearch:String(query.productSearch||'').trim().slice(0,160),
    reviewSearch:String(query.reviewSearch||'').trim().slice(0,160),
    sellerSearch:String(query.sellerSearch||'').trim().slice(0,160),
    caseSearch:String(query.caseSearch||'').trim().slice(0,160),
    riskSeverity:RISK_SEVERITIES.includes(String(query.riskSeverity||''))?String(query.riskSeverity):'',
  };
}

export async function loadModeratorDashboard(request){
  const user=request.user;
  const filters=filtersFor(request.query||{});
  const {allowedCountries,countryScope,productScope,storeScope,selectedCountry}=moderatorScope(user,filters.requestedCountry);
  const productQuery={status:'submitted',...productScope};
  if(filters.productSearch){const rx=pattern(filters.productSearch);productQuery.$or=[{publicId:rx},{title:rx}];}
  const reviewQuery={status:{$in:['pending','disputed']},...countryScope};
  if(filters.reviewSearch){const rx=pattern(filters.reviewSearch);reviewQuery.$or=[{publicId:rx},{productPublicId:rx},{orderPublicId:rx},{title:rx},{body:rx}];}
  const caseQuery={status:{$in:CASE_STATUSES},...countryScope};
  if(filters.caseSearch){const rx=pattern(filters.caseSearch);caseQuery.$or=[{publicId:rx},{productPublicId:rx},{storePublicId:rx},{type:rx}];}
  const riskQuery={status:'open',...countryScope};
  if(filters.riskSeverity)riskQuery.severity=filters.riskSeverity;

  const storeIds=await Store.find(storeScope).distinct('_id');
  const verificationQuery={storeId:{$in:storeIds},status:{$in:VERIFICATION_STATUSES}};
  const productIds=filters.sellerSearch?await Store.find({...storeScope,$or:[{publicId:pattern(filters.sellerSearch)},{name:pattern(filters.sellerSearch)}]}).distinct('_id'):storeIds;
  if(filters.sellerSearch)verificationQuery.storeId={$in:productIds};

  const auditAction=/^(?:catalogue\.|seller\.verification|moderation\.|trust\.|review\.)/;
  const [products,reviews,verifications,trustCases,riskSignals,qaSamples,auditLogs,restrictedCategories,productCount,reviewCount,verificationCount,caseCount,riskCount,qaPendingCount]=await Promise.all([
    Product.find(productQuery).select('publicId storeId categoryId title status qualityScore countries moderation submittedAt createdAt updatedAt').populate('storeId','publicId name country status').populate('categoryId','publicId name restricted').populate('moderation.assignedUserId','publicId name role').sort({'moderation.submittedAt':1,createdAt:1}).limit(100).lean(),
    Review.find(reviewQuery).select('publicId userId orderPublicId productId productPublicId country rating title body verifiedPurchase status moderationReason disputeReason disputedAt publishedAt createdAt updatedAt').populate('userId','publicId name').populate('productId','publicId title storeId').sort({updatedAt:1,createdAt:1}).limit(100).lean(),
    SellerVerification.find(verificationQuery).select('publicId storeId userId sellerType legalName status submittedAt assignedUserId assignedAt escalatedAt escalationReason reviewedAt reviewedByUserId reviewReason appeal createdAt updatedAt').populate('storeId','publicId name country status').populate('assignedUserId','publicId name role').populate('reviewedByUserId','publicId name role').sort({submittedAt:1,createdAt:1}).limit(100).lean(),
    TrustCase.find(caseQuery).select('publicId reporterUserId country type productPublicId storePublicId description status assignedUserId decision resolvedAt createdAt updatedAt').populate('assignedUserId','publicId name role').sort({updatedAt:1,createdAt:1}).limit(100).lean(),
    RiskSignal.find(riskQuery).select('publicId country subjectType subjectPublicId type severity score status evidence createdBy reviewedByUserId decision reviewedAt createdAt updatedAt').sort({severity:-1,score:-1,createdAt:1}).limit(100).lean(),
    ModerationQaReview.find(countryScope).select('publicId targetType targetPublicId country riskLevel decision decisionReason originalReviewerUserId sampledAt status qaReviewerUserId reviewedAt outcome note createdAt').populate('originalReviewerUserId','publicId name').populate('qaReviewerUserId','publicId name').sort({sampledAt:-1}).limit(120).lean(),
    AuditLog.find({...countryScope,action:auditAction}).select('requestId actorPublicId action targetType targetPublicId country result metadata createdAt').sort({createdAt:-1}).limit(160).lean(),
    Category.find(allowedCountries.length?{$or:[{countries:{$size:0}},{countries:{$in:allowedCountries}}],restricted:true}:{restricted:true}).select('publicId name countries active restricted').sort({name:1}).limit(80).lean(),
    Product.countDocuments(productQuery),
    Review.countDocuments(reviewQuery),
    SellerVerification.countDocuments(verificationQuery),
    TrustCase.countDocuments(caseQuery),
    RiskSignal.countDocuments(riskQuery),
    ModerationQaReview.countDocuments({...countryScope,status:'pending'}),
  ]);

  const completedQa=qaSamples.filter(row=>row.status==='completed');
  const upheldQa=completedQa.filter(row=>row.outcome==='upheld').length;
  const decisionQuality=completedQa.length?Math.round((upheldQa/completedQa.length)*100):100;
  const appealedCases=trustCases.filter(row=>row.status==='appealed').length;
  const secondReviews=products.filter(row=>row.moderation?.secondReviewRequired).length;
  const highRiskProducts=products.filter(row=>row.categoryId?.restricted||row.moderation?.riskLevel==='high').length;

  return {
    user:{
      publicId:user.publicId,name:user.name,email:user.email,country:user.country,currency:user.currency,locale:user.locale,
      role:user.role,preferences:user.preferences?.dashboard||{},
    },
    operationalCountries:operationalCountriesFor(user),
    selectedCountry,
    filters:{...filters,requestedCountry:selectedCountry},
    products,reviews,verifications,trustCases,riskSignals,qaSamples,auditLogs,restrictedCategories,
    summary:{
      productCount,reviewCount,verificationCount,caseCount,riskCount,qaPendingCount,appealedCases,secondReviews,highRiskProducts,decisionQuality,
      reviewStatuses:countBy(reviews,'status'),caseTypes:countBy(trustCases,'type'),riskSeverities:countBy(riskSignals,'severity'),qaOutcomes:countBy(completedQa,'outcome'),
    },
  };
}

import mongoose from 'mongoose';
import { z } from 'zod';
import { Product, Store, StoreMember, SellerVerification, PromoterVerification, User, Category, Brand, Review, PlatformGrant, BusinessMember, BusinessOrganization, PlatformStaffInvitation, VerificationDocument } from '../models/index.js';
import { AppError } from '../core/errors.js';
import { cursorScope, decodeCursor, pageResult } from './pagination.js';
import { countryAdminAccess, fenceCountryAdminAccess, assertCountryAdminReadAccess, countryAdminPublicContext } from './country-admin-workspace-access.js';
import { writeAudit } from './audit.js';
import { reviewerProductDetail, reviewProduct } from './product-moderation.js';
import { reviewerVerificationRecord, verificationDetail, reviewSellerVerification } from './seller-verification.js';
import { readVerificationDocumentBuffer } from './verification-media.js';
import { moderationReviewPipeline } from './moderation-trust-pages.js';
import { loadCountryAdminPromoterDetail, actCountryAdminPromoter, loadCountryAdminCustomerDetail, actCountryAdminCustomer } from './country-admin-people-actions.js';
import { loadCountryAdminCategoryDetail, actCountryAdminCategory, loadCountryAdminReviewDetail, actCountryAdminReview } from './country-admin-catalogue-actions.js';

const SIZE = 25;
export const COUNTRY_ADMIN_CATALOGUE_PATHS = Object.freeze({
  'admin-seller-approvals': '/admin/seller-approvals', 'admin-promoter-approvals': '/admin/promoter-approvals',
  'admin-customers': '/admin/customers', 'admin-products': '/admin/products', 'admin-categories': '/admin/categories', 'admin-reviews': '/admin/reviews',
});
const STATUSES = {
  'admin-seller-approvals': ['all','submitted','appealed'], 'admin-promoter-approvals': ['all','submitted','appealed','verified','rejected'],
  'admin-customers': ['all','active','suspended'], 'admin-products': ['all','draft','submitted','changes_requested','approved','published','rejected','archived','suspended'],
  'admin-categories': ['all','active','inactive','pending','approved','rejected'], 'admin-reviews': ['all','pending','published','rejected','disputed'],
};
const escaped = value => new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');
const label = value => String(value || '').replaceAll('_',' ');
const iso = value => value ? new Date(value).toISOString() : '';
const assignment = (id, actor) => !id ? 'unassigned' : String(id) === String(actor._id) ? 'mine' : 'other';
const assignmentLabel = value => ({ mine:'Assigned to you',other:'Assigned to another reviewer',unassigned:'Unassigned' })[value];
const codes = context => context.country ? [context.country] : context.countries.map(row => row.code);
const adminRequest = request => ({ ...request, user:request.user, session:request.session, sessionID:request.sessionID, device:request.device, query:request.query, get:request.get.bind(request), requiredOperationalWorkspace:'admin' });
function filters(request,pageId) {
  const value = z.object({ search:z.string().trim().max(100).default(''),status:z.enum(STATUSES[pageId]).default('all'),
    assignment:z.enum(['all','mine','unassigned']).default('all'),risk:z.enum(['all','high','standard']).default('all'),
    type:z.enum(['categories','brands']).default('categories'),after:z.string().max(512).default(''),record:z.string().max(100).regex(/^[A-Za-z0-9_-]+$/).optional() }).parse(request.query || {});
  if(value.after && !decodeCursor(value.after)) throw new AppError('The catalogue cursor is invalid.',422,'COUNTRY_ADMIN_FILTER_INVALID');
  if(pageId === 'admin-categories' && value.status !== 'all' && !(value.type === 'categories' ? ['active','inactive'] : ['pending','approved','rejected']).includes(value.status)) throw new AppError('Select a valid catalogue status.',422,'COUNTRY_ADMIN_FILTER_INVALID');
  return value;
}
function storePipeline(context,{seller=false}={}) {
  const prefix = Object.fromEntries(Object.entries(context.countryScope).map(([key,value])=>['store.'+key,value]));
  return [{ $lookup:{from:Store.collection.name,localField:'storeId',foreignField:'_id',as:'store',pipeline:[{$project:{publicId:1,name:1,country:1,status:1,ownerUserId:1}}]} },{$unwind:'$store'},
    {$match:{...prefix,'store.status':seller?'pending_verification':{$in:['pending_verification','verified','suspended']},...(seller?{$expr:{$eq:['$userId','$store.ownerUserId']}}:{$expr:{$eq:['$ownerUserId','$store.ownerUserId']}})}}];
}
/** Account lists exclude platform identities and marketplace staff even when their role mirror is customer. */
function personalIdentityExclusions(localField='_id') {
  return [...[[PlatformGrant,'userId','platformGrants',{}],[PlatformStaffInvitation,'acceptedByUserId','staffInvitations',{}],
      [Store,'ownerUserId','ownedStores',{}],[StoreMember,'userId','storeMemberships',{status:{$in:['active','invited']}}],
      [BusinessOrganization,'ownerUserId','ownedBusinesses',{}],[BusinessMember,'userId','businessMemberships',{status:{$in:['active','invited']}}]].map(([Model,field,as,match])=>({$lookup:{from:Model.collection.name,localField,foreignField:field,as,pipeline:[{$match:match},{$limit:1},{$project:{_id:1}}]}})),
    {$match:Object.fromEntries(['platformGrants','staffInvitations','ownedStores','storeMemberships','ownedBusinesses','businessMemberships'].map(key=>[key+'.0',{$exists:false}]))}];
}
function shoppingIdentityPipeline(context) {
  return [{$match:{...context.countryScope,role:'customer',status:{$in:['active','suspended']},platformAccessManagedAt:null}},...personalIdentityExclusions()];
}
function catalogueConfig(context,pageId,query) {
  let Model,base,fields,columns,title;
  if(pageId === 'admin-products' || pageId === 'admin-seller-approvals') {
    const seller = pageId === 'admin-seller-approvals'; Model=seller?SellerVerification:Product;
    base=[...(seller?[{$match:{status:{$in:['submitted','appealed']}}}]:[]),...storePipeline(context,{seller})];
    fields=seller?['publicId','legalName','store.name']:['publicId','title','store.name'];
    columns=seller?['Seller','Country','Submitted','Assigned','Status']:['Product','Seller','Country','Assigned','Status']; title=seller?'Seller verification queue':'Product catalogue';
    base.push({$set:{queueAt:{$ifNull:[seller?'$submittedAt':'$moderation.submittedAt','$createdAt']},queueAssigned:seller?'$assignedUserId':'$moderation.assignedUserId',
      queueHigh:seller?{$eq:['$sellerType','business']}:{$or:[{$eq:['$moderation.riskLevel','high']},{$eq:['$moderation.secondReviewRequired',true]}]}}});
  } else if(pageId === 'admin-promoter-approvals') {
    Model=PromoterVerification;fields=['publicId','sourceUser.name','audienceLocation'];columns=['Promoter','Country','Audience','Assigned','Status'];title='Promoter verification queue';
    base=[{$match:{...context.countryScope,status:{$in:['submitted','appealed','verified','rejected']}}},
      {$lookup:{from:User.collection.name,localField:'userId',foreignField:'_id',as:'sourceUser',pipeline:[{$match:{role:'promoter',status:'active',platformAccessManagedAt:null,emailVerifiedAt:{$type:'date'},onboardingCompletedAt:{$type:'date'}}},{$project:{publicId:1,name:1,country:1}}]}},{$unwind:'$sourceUser'},
      ...personalIdentityExclusions('sourceUser._id'),{$set:{queueAt:{$ifNull:['$submittedAt','$createdAt']},queueAssigned:'$assignedUserId',queueHigh:{$eq:['$status','appealed']}}}];
  } else if(pageId === 'admin-customers') {
    Model=User;fields=['publicId','name'];columns=['Customer','Country','Email verified','Joined','Status'];title='Customer accounts';
    base=[...shoppingIdentityPipeline(context),{$set:{queueAt:'$createdAt',queueAssigned:null,queueHigh:{$eq:['$status','suspended']}}}];
  } else if(pageId === 'admin-categories') {
    const brands=query.type === 'brands';Model=brands?Brand:Category;fields=['publicId','name','slug'];columns=brands?['Brand','Slug','Source country','Scope','Status']:['Category','Slug','Markets','Policy','Status'];title=brands?'Brand catalogue':'Category catalogue';
    base=brands?[{$lookup:{from:Store.collection.name,localField:'requestedByStoreId',foreignField:'_id',as:'sourceStore',pipeline:[{$project:{publicId:1,name:1,country:1}}]}},{$set:{sourceStore:{$first:'$sourceStore'}}},
      {$match:{$or:[{status:'approved'},{'sourceStore.country':{$in:codes(context)}}]}}]:[{$match:{$or:[{countries:{$size:0}},{countries:{$in:codes(context)}}]}}];
    base.push({$set:{queueAt:'$createdAt',queueAssigned:null,queueHigh:brands?{$eq:['$status','pending']}:{$eq:['$restricted',true]}}});
  } else {
    Model=Review;fields=['publicId','title','body','orderPublicId','productPublicId'];columns=['Review','Product','Rating','Assigned','Status'];title='Verified purchase reviews';
    base=[...moderationReviewPipeline(context),{$match:{'sourceStore.country':{$in:context.countries.map(row=>row.code)}}},{$set:{queueAt:'$createdAt',queueAssigned:'$assignedUserId',queueHigh:{$eq:['$status','disputed']}}}];
  }
  const match={};
  if(query.status !== 'all') pageId === 'admin-categories' && query.type === 'categories' ? match.active=query.status === 'active' : match.status=query.status;
  if(query.search) match.$or=fields.map(key=>({[key]:escaped(query.search)}));
  if(query.assignment === 'mine') match.queueAssigned=context.actor._id;
  if(query.assignment === 'unassigned') match.queueAssigned=null;
  if(query.risk !== 'all') match.queueHigh=query.risk === 'high';
  return {Model,base,filtered:[...base,{$match:match}],columns,title};
}
const safeHistory = entries => (entries || []).slice(-200).map(row=>({action:row.action,reason:row.reason || '',at:row.at}));
function listDto(row,context,pageId,query) {
  const dto={publicId:row.publicId,status:pageId === 'admin-categories' && query.type === 'categories' ? row.active?'active':'inactive':row.status,version:row.__v || 0,
    country:row.store?.country || row.sourceStore?.country || row.country || '',createdAt:iso(row.queueAt),assignment:assignment(row.queueAssigned,context.actor),risk:row.queueHigh?'high':'standard'};
  if(pageId === 'admin-products') Object.assign(dto,{title:row.title,store:{publicId:row.store.publicId,name:row.store.name,country:row.store.country},secondReviewRequired:Boolean(row.moderation?.secondReviewRequired)});
  else if(pageId === 'admin-seller-approvals') Object.assign(dto,{legalName:row.legalName,sellerType:row.sellerType,store:{publicId:row.store.publicId,name:row.store.name,country:row.store.country}});
  else if(pageId === 'admin-promoter-approvals') Object.assign(dto,{name:row.sourceUser.name,audienceSize:row.audienceSize});
  else if(pageId === 'admin-customers') Object.assign(dto,{name:row.name,emailVerified:Boolean(row.emailVerifiedAt)});
  else if(pageId === 'admin-categories') Object.assign(dto,{name:row.name,slug:row.slug,countries:row.countries || [],restricted:Boolean(row.restricted),type:query.type,shared:query.type === 'brands'?row.status === 'approved':!(row.countries || []).length});
  else Object.assign(dto,{title:row.title || row.publicId,productTitle:row.sourceProduct.title,rating:row.rating,verifiedPurchase:true});
  return dto;
}
function cells(row,pageId) {
  if(pageId === 'admin-products') return [row.title,row.store.name,row.country,assignmentLabel(row.assignment),label(row.status)];
  if(pageId === 'admin-seller-approvals') return [row.legalName || row.store.name,row.country,row.createdAt?row.createdAt.slice(0,10):'Not recorded',assignmentLabel(row.assignment),label(row.status)];
  if(pageId === 'admin-promoter-approvals') return [row.name,row.country,row.audienceSize,assignmentLabel(row.assignment),label(row.status)];
  if(pageId === 'admin-customers') return [row.name,row.country,row.emailVerified?'Verified':'Pending',row.createdAt.slice(0,10),label(row.status)];
  if(pageId === 'admin-categories') return [row.name,row.slug,row.type === 'brands'?row.country || 'Shared':row.countries.join(', ') || 'Global',row.type === 'brands'?row.shared?'Shared catalogue':'Requested brand':row.restricted?'Restricted':'Standard',label(row.status)];
  return [row.title,row.productTitle,row.rating+' / 5',assignmentLabel(row.assignment),label(row.status)];
}
async function selectedRecord(request,context,pageId,id,query) {
  const guarded=adminRequest(request);
  if(pageId === 'admin-products') {
    const detail=await reviewerProductDetail(guarded,id),p=detail.product;
    if(!codes(context).includes(detail.store.country)) throw new AppError('Product not found.',404,'PRODUCT_NOT_FOUND');
    const product={publicId:p.publicId,title:p.title,description:p.description,tags:p.tags || [],attributes:p.attributes,videoUrl:p.videoUrl || '',status:p.status,version:p.__v || 0,
      assignment:assignment(p.moderation?.assignedUserId,context.actor),firstReviewOwn:String(p.moderation?.firstApprovalByUserId || '') === String(context.actor._id),moderation:{reason:p.moderation?.reason || '',secondReviewRequired:Boolean(p.moderation?.secondReviewRequired),firstApprovalRecorded:Boolean(p.moderation?.firstApprovalByUserId),reviewHistory:safeHistory(p.moderation?.reviewHistory)}};
    return {type:'product',productFlow:{product,store:{publicId:detail.store.publicId,name:detail.store.name,country:detail.store.country,status:detail.store.status},category:detail.category?{name:detail.category.name,attributes:detail.category.attributes}:null,brand:detail.brand?{name:detail.brand.name,status:detail.brand.status}:null,
      variants:detail.variants.map(row=>({publicId:row.publicId,title:row.title,sku:row.sku,priceMinor:row.priceMinor,compareAtMinor:row.compareAtMinor,currency:row.currency,weightGrams:row.weightGrams,active:row.active})),
      media:detail.media.map(row=>({publicId:row.publicId,altText:row.altText,status:row.status})),stocks:detail.stocks.map(row=>({sku:detail.variants.find(v=>String(v._id) === String(row.variantId))?.sku || 'Unavailable',warehouse:detail.warehouses.find(w=>String(w._id) === String(row.warehouseId))?.name || 'Unavailable',onHand:row.onHand,reserved:row.reserved,available:Number(row.onHand || 0)-Number(row.reserved || 0)-Number(row.damaged || 0)-Number(row.quarantined || 0)})),stockHasMore:detail.stockHasMore,error:'',draft:{}}};
  }
  if(pageId === 'admin-seller-approvals') {
    const {record,store}=await reviewerVerificationRecord(guarded,id);
    if(!codes(context).includes(store.country) || String(record.userId) !== String(store.ownerUserId)) throw new AppError('Verification not found.',404,'VERIFICATION_NOT_FOUND');
    const detail=await verificationDetail(record);
    return {type:'verification',reviewFlow:{record:{publicId:record.publicId,legalName:record.legalName,sellerType:record.sellerType,status:record.status,version:record.__v || 0,assignment:assignment(record.assignedUserId,context.actor),reviewReason:record.reviewReason || '',reviewHistory:safeHistory(record.reviewHistory),appeal:{message:record.appeal?.message || '',submittedAt:record.appeal?.submittedAt}},store:{publicId:store.publicId,name:store.name,country:store.country,status:store.status},documents:detail.documents.map(row=>({publicId:row.publicId,documentType:row.documentType,status:row.status})),error:'',draft:{}}};
  }
  if(pageId === 'admin-promoter-approvals') return loadCountryAdminPromoterDetail(guarded,id);
  if(pageId === 'admin-customers') return loadCountryAdminCustomerDetail(guarded,id);
  if(pageId === 'admin-categories') return loadCountryAdminCategoryDetail(guarded,id,query.type);
  return loadCountryAdminReviewDetail(guarded,id);
}
export async function loadCountryAdminCataloguePage(request,pageId) {
  if(!COUNTRY_ADMIN_CATALOGUE_PATHS[pageId]) throw new AppError('Country Admin page not found.',404,'COUNTRY_ADMIN_PAGE_NOT_FOUND');
  const context=await countryAdminAccess(request),query=filters(request,pageId),config=catalogueConfig(context,pageId,query);
  const projection={publicId:1,title:1,name:1,slug:1,legalName:1,sellerType:1,status:1,active:1,countries:1,country:1,restricted:1,audienceSize:1,rating:1,emailVerifiedAt:1,store:1,sourceUser:1,sourceStore:1,'sourceProduct.title':1,'moderation.secondReviewRequired':1,queueAt:1,queueAssigned:1,queueHigh:1,__v:1};
  const [rows,count,statsRows]=await Promise.all([
    config.Model.aggregate([...config.filtered,{$match:cursorScope({},query.after,{field:'queueAt',direction:1})},{$sort:{queueAt:1,_id:1}},{$limit:SIZE+1},{$project:projection}]),
    config.Model.aggregate([...config.filtered,{$count:'total'}]),config.Model.aggregate([...config.base,{$group:{_id:null,total:{$sum:1},high:{$sum:{$cond:['$queueHigh',1,0]}},mine:{$sum:{$cond:[{$eq:['$queueAssigned',context.actor._id]},1,0]}},unassigned:{$sum:{$cond:[{$eq:[{$ifNull:['$queueAssigned',null]},null]},1,0]}}}}])]);
  const result=pageResult(rows,{field:'queueAt',direction:1,limit:SIZE,total:count[0]?.total || 0}),items=result.items.map(row=>listDto(row,context,pageId,query)),stats=statsRows[0] || {total:0,high:0,mine:0,unassigned:0};
  const id=request.params?.publicId || query.record,selected=id?await selectedRecord(request,context,pageId,id,query):null;
  await assertCountryAdminReadAccess(request,context);
  const path=COUNTRY_ADMIN_CATALOGUE_PATHS[pageId],params={country:context.country,type:query.type,assignment:query.assignment,risk:query.risk,status:query.status,search:query.search};
  const reviewQueue=['admin-products','admin-seller-approvals','admin-promoter-approvals','admin-reviews'].includes(pageId);
  return {kind:'catalogue',pageId,context:countryAdminPublicContext(context),country:context.country,items,selected,page:result.page,columns:config.columns,
    metrics:[{label:'Total records',value:stats.total,detail:'Current source records in your country scope'},{label:pageId === 'admin-customers'?'Suspended accounts':pageId === 'admin-categories'?'Policy attention':'Requires attention',value:stats.high,detail:'Recorded risk or current exceptional source state'},
      {label:reviewQueue?'Assigned to you':'Matching records',value:reviewQueue?stats.mine:result.page.total,detail:reviewQueue?'Your current claimed records':'Full count for the selected filters'},
      {label:reviewQueue?'Unassigned':'Shown on this page',value:reviewQueue?stats.unassigned:result.page.count,detail:reviewQueue?'Available for independent assignment':'At most 25 source records'}],
    rows:items.map(row=>({id:row.publicId,href:path+'/'+encodeURIComponent(row.publicId)+'?'+new URLSearchParams(params),cells:cells(row,pageId)})),filters:{...query,country:context.country,params,
      statuses:STATUSES[pageId].filter(value=>pageId !== 'admin-categories' || value === 'all' || (query.type === 'categories'?['active','inactive']:['pending','approved','rejected']).includes(value)).map(value=>({value,label:value === 'all'?'All statuses':label(value)})),
      assignments:reviewQueue?[{value:'all',label:'All assignments'},{value:'mine',label:'Assigned to you'},{value:'unassigned',label:'Unassigned'}]:[],risks:[{value:'all',label:'All risk levels'},{value:'high',label:'Requires attention'},{value:'standard',label:'Standard'}],types:pageId === 'admin-categories'?[{value:'categories',label:'Categories'},{value:'brands',label:'Brands'}]:[]},
    tableTitle:config.title,tableDescription:'Authoritative records from currently authorized markets.',exportHref:path+'/export.csv?'+new URLSearchParams(params),emptyText:'No source records match this view.',
    insights:[{text:stats.high+' source records require attention.',href:path+'?'+new URLSearchParams({...params,risk:'high'}),label:'Review records requiring attention'}],
    health:{label:'Current source records',value:null,rows:[{label:'Total',value:stats.total},{label:'Matches',value:result.page.total}],note:'Counts use the entire authorized source scope.'},
    workflow:[{title:'Inspect the current source',text:'Open a record to review its saved evidence and current version.'},{title:reviewQueue?'Claim independently':'Confirm the full affected scope',text:reviewQueue?'Owners and current or invited store staff cannot decide their own cases.':'Changes require authority over every market affected by the record.'},{title:'Save a reasoned action',text:'The change and audit record are committed together.'}],activityHref:'/admin/reports'};
}
export async function countryAdminCatalogueAction(request,pageId,action) {
  await countryAdminAccess(request);const guarded=adminRequest(request);
  if(pageId === 'admin-products') return reviewProduct(guarded,action);
  if(pageId === 'admin-seller-approvals') return reviewSellerVerification(guarded,action);
  if(pageId === 'admin-promoter-approvals') return actCountryAdminPromoter(guarded,action);
  if(pageId === 'admin-customers') return actCountryAdminCustomer(guarded,action);
  if(pageId === 'admin-categories') return actCountryAdminCategory(guarded,request.query?.type || 'categories');
  if(pageId === 'admin-reviews') return actCountryAdminReview(guarded,action);
  throw new AppError('Country Admin action not found.',404,'COUNTRY_ADMIN_ACTION_NOT_FOUND');
}
async function authorizeSellerDocument(request) {
  const context=await countryAdminAccess(request),record=await SellerVerification.findOne({publicId:request.params.publicId}),store=record && await Store.findById(record.storeId);
  if(!record || !store || !codes(context).includes(store.country) || String(record.userId) !== String(store.ownerUserId)) throw new AppError('Document not found.',404,'DOCUMENT_NOT_FOUND');
  if([store.ownerUserId,record.userId].some(id=>String(id) === String(context.actor._id)) || await StoreMember.exists({storeId:store._id,userId:context.actor._id,status:{$in:['active','invited']}})) throw new AppError('An independent reviewer must view this evidence.',403,'REVIEW_CONFLICT_OF_INTEREST');
  const document=await VerificationDocument.findOne({publicId:request.params.documentId,verificationId:record._id,storeId:store._id,status:{$ne:'superseded'}}).select('+storageKey');
  if(!document || !record.documents.some(row=>row.mediaPublicId === document.publicId)) throw new AppError('Document not found.',404,'DOCUMENT_NOT_FOUND');
  return {context,record,store,document};
}
export async function readCountryAdminSellerDocument(request) {
  const initial=await authorizeSellerDocument(request),data=await readVerificationDocumentBuffer(initial.document),session=await mongoose.startSession();
  try { await session.withTransaction(async()=>{
    const context=await countryAdminAccess(request,{session,country:initial.store.country});await fenceCountryAdminAccess(context,session);
    const store=await Store.findOne({_id:initial.store._id,country:initial.store.country,ownerUserId:initial.store.ownerUserId}).session(session),record=store && await SellerVerification.findOne({_id:initial.record._id,storeId:store._id,userId:store.ownerUserId,'documents.mediaPublicId':initial.document.publicId}).session(session);
    const document=record && await VerificationDocument.findOne({_id:initial.document._id,verificationId:record._id,storeId:store._id,status:{$ne:'superseded'},storageKey:initial.document.storageKey}).session(session).select('+storageKey');
    if(!document || [store.ownerUserId,record.userId].some(id=>String(id) === String(context.actor._id)) || await StoreMember.exists({storeId:store._id,userId:context.actor._id,status:{$in:['active','invited']}}).session(session)) throw new AppError('Document not found.',404,'DOCUMENT_NOT_FOUND');
    for(const [Model,row] of [[Store,store],[SellerVerification,record],[VerificationDocument,document]]) {
      const result=await Model.updateOne({_id:row._id,__v:row.__v || 0},{$inc:{[Model === VerificationDocument?'__v':'moderationEvidenceReadRevision']:1}},{session,timestamps:false});
      if(result.modifiedCount !== 1) throw new AppError('Evidence changed. Reload before viewing it.',409,'COUNTRY_ADMIN_SOURCE_CHANGED');
    }
    await writeAudit(request,'country_admin.seller_document_viewed',{session,actor:context.actor,targetType:'verification_document',targetPublicId:document.publicId,country:store.country,metadata:{verificationPublicId:record.publicId}});
  }); } finally {await session.endSession();}
  await authorizeSellerDocument(request);await assertCountryAdminReadAccess(request,initial.context);
  return data;
}
const csvCell=value=>{let text=String(value ?? '');if(/^[\s\u0000-\u001f]*[=+@-]/u.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
async function chunk(response,value) {
  if(response.destroyed || response.writableEnded)return false;if(response.write(value))return true;
  return new Promise((resolve,reject)=>{const cleanup=()=>{response.off('drain',drained);response.off('close',closed);response.off('error',failed);};const drained=()=>{cleanup();resolve(true);},closed=()=>{cleanup();resolve(false);},failed=error=>{cleanup();reject(error);};response.once('drain',drained);response.once('close',closed);response.once('error',failed);if(response.destroyed || response.writableEnded)closed();});
}
export async function streamCountryAdminCatalogueCsv(request,response,pageId) {
  if(!COUNTRY_ADMIN_CATALOGUE_PATHS[pageId]) throw new AppError('Country Admin page not found.',404,'COUNTRY_ADMIN_PAGE_NOT_FOUND');
  const context=await countryAdminAccess(request),query=filters(request,pageId),session=await mongoose.startSession();
  try {await session.withTransaction(async()=>{const current=await countryAdminAccess(request,{session,country:context.country});await fenceCountryAdminAccess(current,session);await writeAudit(request,'country_admin.catalogue_exported',{session,actor:current.actor,targetType:'country_admin_export',country:context.country || context.countries[0].code,metadata:{pageId}});});}finally{await session.endSession();}
  const copy=Object.create(request);Object.defineProperties(copy,{query:{value:{...request.query,after:'',record:undefined}},params:{value:{}}});let flow=await loadCountryAdminCataloguePage(copy,pageId);
  await assertCountryAdminReadAccess(request,context);response.type('text/csv').set('Content-Disposition','attachment; filename="classic-mart-country-admin-catalogue.csv"');
  if(!await chunk(response,[...flow.columns,'Reference'].map(csvCell).join(',')+'\r\n'))return;
  while(!response.destroyed && !response.writableEnded) {
    for(const row of flow.rows) {
      const current=await assertCountryAdminReadAccess(request,context),config=catalogueConfig(current,pageId,query);
      const source=await config.Model.aggregate([...config.filtered,{$match:{publicId:row.id}},{$limit:1}]);
      if(!source.length)throw new AppError('A source record changed during export.',409,'COUNTRY_ADMIN_SOURCE_CHANGED');
      await assertCountryAdminReadAccess(request,context);
      if(!await chunk(response,[...cells(listDto(source[0],current,pageId,query),pageId),row.id].map(csvCell).join(',')+'\r\n'))return;
    }
    if(!flow.page.hasMore)break;copy.query.after=flow.page.next;flow=await loadCountryAdminCataloguePage(copy,pageId);
  }
  if(!response.destroyed && !response.writableEnded)response.end();
}

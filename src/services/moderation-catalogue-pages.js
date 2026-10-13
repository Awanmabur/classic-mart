import mongoose from 'mongoose';
import { z } from 'zod';
import { Product, Store, SellerVerification } from '../models/index.js';
import { AppError } from '../core/errors.js';
import { cursorScope, decodeCursor, pageResult } from './pagination.js';
import { moderationAccess, fenceModerationAccess, assertModerationReadAccess, moderationPublicContext } from './moderation-workspace-access.js';
import { writeAudit } from './audit.js';
import { reviewerProductDetail } from './product-moderation.js';
import { reviewerVerificationRecord, verificationDetail } from './seller-verification.js';

const SIZE = 25;
const PATHS = { 'moderator-products': '/moderation/products', 'moderator-sellers': '/moderation/verifications' };
const regex = value => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const label = value => String(value || '').replaceAll('_', ' ');
const mask = value => value ? '•••• ' + String(value).slice(-3) : '';
const iso = value => value ? new Date(value).toISOString() : '';
function queryFor(request, pageId) {
  const query = z.object({ search: z.string().trim().max(100).default(''), status: z.enum(['all','submitted','appealed']).default('all'),
    assignment: z.enum(['all','mine','unassigned']).default('all'), risk: z.enum(['all','high','standard']).default('all'),
    after: z.string().max(512).default(''), record: z.string().max(100).regex(/^[a-zA-Z0-9_-]+$/).optional() }).parse(request.query || {});
  if (pageId === 'moderator-products' && query.status === 'appealed') throw new AppError('Select a valid product status.', 422, 'MODERATION_FILTER_INVALID');
  if (query.after && !decodeCursor(query.after)) throw new AppError('The review cursor is invalid.', 422, 'MODERATION_FILTER_INVALID');
  return query;
}
function queuePipeline(context, pageId) {
  const products = pageId === 'moderator-products';
  const scope = Object.fromEntries(Object.entries(context.countryScope).map(([key,value]) => ['store.' + key,value]));
  return [{ $match: { status: products ? 'submitted' : { $in: ['submitted','appealed'] } } },
    { $lookup: { from: Store.collection.name, localField: 'storeId', foreignField: '_id', as: 'store',
      pipeline: [{ $project: { publicId: 1, name: 1, country: 1, status: 1 } }] } }, { $unwind: '$store' },
    { $match: { ...scope, 'store.status': products ? 'verified' : 'pending_verification' } },
    { $addFields: { queueAt: { $ifNull: [products ? '$moderation.submittedAt' : '$submittedAt','$createdAt'] },
      queueAssigned: products ? '$moderation.assignedUserId' : '$assignedUserId',
      queueHigh: products ? { $or: [{ $eq: ['$moderation.riskLevel','high'] }, { $eq: ['$moderation.secondReviewRequired',true] }] } : { $eq: ['$sellerType','business'] } } }];
}
function filteredPipeline(base, query, pageId, context) {
  const where = {};
  if (query.status !== 'all') where.status = query.status;
  if (query.assignment === 'mine') where.queueAssigned = context.actor._id;
  if (query.assignment === 'unassigned') where.queueAssigned = null;
  if (query.risk !== 'all') where.queueHigh = query.risk === 'high';
  if (query.search) where.$or = (pageId === 'moderator-products' ? ['publicId','title','store.name'] : ['publicId','legalName','store.name']).map(key => ({ [key]: regex(query.search) }));
  return [...base, { $match: where }];
}
function dto(row, actor, products) {
  return { publicId: row.publicId, title: products ? row.title : undefined, legalName: products ? undefined : row.legalName,
    sellerType: products ? undefined : row.sellerType, status: row.status, country: row.store.country,
    store: { publicId: row.store.publicId, name: row.store.name, country: row.store.country },
    submittedAt: iso(row.queueAt), risk: row.queueHigh ? 'high' : 'standard',
    assignment: !row.queueAssigned ? 'Unassigned' : String(row.queueAssigned) === String(actor._id) ? 'Assigned to you' : 'Assigned to another reviewer',
    secondReviewRequired: products && Boolean(row.moderation?.secondReviewRequired), version: row.__v || 0 };
}
export async function loadModerationCataloguePage(request, pageId) {
  if (!PATHS[pageId]) throw new AppError('Moderation page not found.', 404, 'MODERATION_PAGE_NOT_FOUND');
  const context = await moderationAccess(request), query = queryFor(request, pageId), products = pageId === 'moderator-products';
  const model = products ? Product : SellerVerification, base = queuePipeline(context,pageId), filtered = filteredPipeline(base,query,pageId,context);
  const [listResult,countResult,statsResult] = await Promise.all([
    model.aggregate([...filtered,{ $match: cursorScope({},query.after,{ field: 'queueAt',direction: 1 }) },{ $sort: { queueAt: 1,_id: 1 } },{ $limit: SIZE + 1 },
      { $project: { publicId: 1,title: 1,legalName: 1,sellerType: 1,status: 1,store: 1,queueAt: 1,queueAssigned: 1,queueHigh: 1,'moderation.secondReviewRequired': 1,__v: 1 } }]),
    model.aggregate([...filtered,{ $count: 'total' }]),
    model.aggregate([...base,{ $group: { _id: null,total: { $sum: 1 },high: { $sum: { $cond: ['$queueHigh',1,0] } },
      mine: { $sum: { $cond: [{ $eq: ['$queueAssigned',context.actor._id] },1,0] } },unassigned: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$queueAssigned',null] },null] },1,0] } } } }])
  ]);
  const result = pageResult(listResult,{ field: 'queueAt',direction: 1,limit: SIZE,total: countResult[0]?.total || 0 }),
    items = result.items.map(row => dto(row,context.actor,products)), stats = statsResult[0] || { total: 0,high: 0,mine: 0,unassigned: 0 };
  let selected = null;
  const record = request.params?.publicId || query.record;
  if (record) {
    try {
    if (products) selected = { type: 'product',productFlow: { ...(await reviewerProductDetail(request,record)),error: '',draft: {} } };
    else {
      const { record: verification,store } = await reviewerVerificationRecord(request,record);
      const detail = await verificationDetail(verification,{ revealIdentifiers: true });
      detail.record.registrationNumber = mask(detail.record.registrationNumber); detail.record.taxNumber = mask(detail.record.taxNumber);
      delete detail.record.userId; delete detail.record.storeId;
      selected = { type: 'verification',reviewFlow: { ...detail,store: { publicId: store.publicId,name: store.name,country: store.country,status: store.status },error: '',draft: {} } };
    }
    } catch (error) { if (error.code === 'MODERATION_COUNTRY_FORBIDDEN') throw new AppError('Review record not found.',404,products?'PRODUCT_NOT_FOUND':'VERIFICATION_NOT_FOUND'); throw error; }
  }
  await assertModerationReadAccess(request,context);
  const params = { country: context.country,assignment: query.assignment,risk: query.risk }, path = PATHS[pageId], exportParams = new URLSearchParams({ ...params,status: query.status,search: query.search });
  const queueLink = values => path + '?' + new URLSearchParams({ ...params,...values });
  return { kind: 'catalogue',pageId,context: moderationPublicContext(context),country: context.country,items,page: result.page,selected,
    metrics: [{ label: 'Awaiting review',value: stats.total,detail: 'All records within the selected scope' },
      { label: 'High risk',value: stats.high,detail: products ? 'Restricted or second review required' : 'Business verification cases' },
      { label: 'Assigned to you',value: stats.mine,detail: 'Current claimed cases' },{ label: 'Unassigned',value: stats.unassigned,detail: 'Ready for independent assignment' }],
    columns: products ? ['Product','Seller','Risk','Assigned','Status'] : ['Seller','Country','Submitted','Assigned','Status'],
    rows: items.map(row => ({ id: row.publicId,href: path + '/' + encodeURIComponent(row.publicId) + '?' + new URLSearchParams(params),
      cells: products ? [row.title,row.store.name,row.risk === 'high' ? 'High risk' : 'Standard',row.assignment,label(row.status)]
        : [row.legalName || row.store.name,row.country,row.submittedAt ? new Intl.DateTimeFormat(context.actor.locale || 'en',{ dateStyle: 'medium',timeZone: context.timeZone }).format(new Date(row.submittedAt)) : 'Not recorded',row.assignment,label(row.status)] })),
    filters: { ...query,country: context.country,params,assignments: [{ value: 'all',label: 'All assignments' },{ value: 'mine',label: 'Assigned to you' },{ value: 'unassigned',label: 'Unassigned' }],
      risks: [{ value: 'all',label: 'All risk levels' },{ value: 'high',label: 'High risk' },{ value: 'standard',label: 'Standard' }],
      statuses: (products ? ['all','submitted'] : ['all','submitted','appealed']).map(value => ({ value,label: value === 'all' ? 'All' : label(value) })) },
    tableTitle: products ? 'Product review queue' : 'Seller verification queue',tableDescription: 'Current source records in your authorized countries.',
    exportHref: path + '/export.csv?' + exportParams,emptyText: 'No review cases match this view.',
    insights: [{ text: stats.unassigned + ' cases have no reviewer assignment.',href: queueLink({ assignment: 'unassigned' }),label: 'Review unassigned cases' },
      { text: stats.high + ' cases require additional scrutiny.',href: queueLink({ risk: 'high' }),label: 'Review high-risk cases' }],
    health: { label: 'Review queue',value: null,rows: [{ label: 'Pending',value: stats.total },{ label: 'Claimed by you',value: stats.mine }],note: 'Queue counts reflect recorded assignments and current source state.' },
    workflow: [{ title: 'Claim independently',text: 'Store owners and current or invited staff cannot decide their own cases.' },
      { title: products ? 'Validate the listing' : 'Check current evidence',text: products ? 'Review the category policy, images, variants and available stock.' : 'Required documents must belong to this verification.' },
      { title: 'Record a reasoned decision',text: 'Decisions persist together with the seller notice, audit and a quality review record.' }],activityHref: '/moderation/audit' };
}
const csvCell = value => { let text = String(value ?? ''); if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text)) text = "'" + text; return '"' + text.replaceAll('"','""') + '"'; };
async function writeChunk(response,chunk) {
  if (response.destroyed || response.writableEnded) return false;
  if (!chunk || response.write(chunk)) return true;
  return new Promise((resolve,reject) => {
    const cleanup = () => { response.off('drain',drained); response.off('close',closed); response.off('error',failed); };
    const drained = () => { cleanup(); resolve(true); }, closed = () => { cleanup(); resolve(false); }, failed = error => { cleanup(); reject(error); };
    response.once('drain',drained); response.once('close',closed); response.once('error',failed);
    if(response.destroyed || response.writableEnded) closed();
  });
}
export async function streamModerationCatalogueCsv(request,response,pageId) {
  const context = await moderationAccess(request), session=await mongoose.startSession();
  try { await session.withTransaction(async()=>{
    const current=await moderationAccess(request,{session,country:context.country});await fenceModerationAccess(current,session);
    await writeAudit(request,'moderation.catalogue_exported',{session,actor:current.actor,targetType:'moderation_export',country:context.country||context.countries[0].code,metadata:{pageId}});
  }); } finally { await session.endSession(); }
  const pageRequest = { ...request,query: { ...request.query,after: '' },params: {} };
  let flow = await loadModerationCataloguePage(pageRequest,pageId);
  await assertModerationReadAccess(request,context);
  response.type('text/csv').set('Content-Disposition','attachment; filename="classic-mart-moderation-catalogue.csv"');
  if(!await writeChunk(response,[...flow.columns,'Reference'].map(csvCell).join(',') + '\r\n'))return;
  while (!response.destroyed && !response.writableEnded) {
    for (const row of flow.rows) {
      await assertModerationReadAccess(request,context);
      if(!await writeChunk(response,[...row.cells,row.id].map(csvCell).join(',')+'\r\n'))return;
    }
    if (!flow.page.hasMore) break;
    pageRequest.query.after = flow.page.next; flow = await loadModerationCataloguePage(pageRequest,pageId);
  }
  if (!response.destroyed && !response.writableEnded) response.end();
}

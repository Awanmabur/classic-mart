import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { Payout, PayoutAccount, CommissionEntry, Campaign, Order, AuditLog } from '../models/index.js';
import { assertFinanceExportAccess, financeAccess, financePublicContext } from './finance-workspace-access.js';
import { cursorScope, cursorSort, decodeCursor, pageResult } from './pagination.js';
import { approvePayout, confirmPayoutSubmission, markPayoutUnknown, publicPayoutAccount, reconcilePayout, rejectPayout, revealPayoutDestination, reviewPayoutAccount, submitPayout } from './payments.js';
import { reviewCommissionAppeal } from './promoters.js';
import { writeAudit } from './audit.js';

const payoutStatuses=['requested','approved','submitting','submitted','unknown','paid','failed','rejected'];
const accountStatuses=['pending','verified','disabled'];
const appealStatuses=['pending','accepted','rejected'];
const tabs=['payouts','destinations','appeals'];
const recordId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{4,120}$/.test(value);
const escapeRegex=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const money=(amount,currency)=>new Intl.NumberFormat('en-UG',{style:'currency',currency,maximumFractionDigits:['UGX','RWF','JPY','KRW'].includes(currency)?0:2}).format(Number(amount||0)/(['UGX','RWF','JPY','KRW'].includes(currency)?1:100));
function filtersFor(request) {
  const source=request.query||{};
  for(const key of ['tab','status','q','search','after','record','destination','appeal'])if(source[key]!==undefined&&typeof source[key]!=='string')throw new AppError('Provide one value for each payout filter.',422,'FINANCE_FILTER_INVALID');
  const tab=source.tab||'payouts',status=source.status||'',search=(source.search??source.q??'').trim(),after=source.after||'';
  if(!tabs.includes(tab)||status&&!(tab==='payouts'?payoutStatuses:tab==='destinations'?accountStatuses:appealStatuses).includes(status)||search.length>120||after&&!decodeCursor(after))throw new AppError('Select supported payout filters.',422,'FINANCE_FILTER_INVALID');
  for(const key of ['record','destination','appeal'])if(source[key]&&!recordId(source[key]))throw new AppError('Select a supported payout record.',422,'FINANCE_FILTER_INVALID');
  return {tab,status,search,after};
}
function marketPairs(context) { return context.countries.filter(row=>!context.country||row.code===context.country).map(row=>({country:row.code,currency:row.currency})); }
function accountScope(context) { return {...context.countryScope}; }
function currentMarketCurrency(context,country,currency) { return context.countries.some(row=>row.code===country&&row.currency===currency); }
function payoutMarketStages(context) {
  return [{$lookup:{from:PayoutAccount.collection.name,localField:'payoutAccountId',foreignField:'_id',as:'destination',pipeline:[{$project:{publicId:1,ownerType:1,ownerUserId:1,ownerStoreId:1,ownerStorePublicId:1,country:1,currency:1,method:1,label:1,status:1,verifiedAt:1,createdAt:1,__v:1}}]}},{$unwind:'$destination'},
    {$match:Object.fromEntries(Object.entries(context.countryScope).map(([field,value])=>['destination.'+field,value]))},
    {$match:{$expr:{$and:[{$eq:['$currency','$destination.currency']},{$eq:['$ownerUserId','$destination.ownerUserId']},{$eq:[{$ifNull:['$ownerStoreId',null]},{$ifNull:['$destination.ownerStoreId',null]}]},{$eq:[{$ifNull:['$ownerStorePublicId','']},{$ifNull:['$destination.ownerStorePublicId','']}]}]}}}];
}
function appealMarketStages(context) {
  return [{$lookup:{from:Campaign.collection.name,localField:'campaignId',foreignField:'_id',as:'campaign',pipeline:[{$project:{country:1,name:1,publicId:1}}]}},{$unwind:'$campaign'},
    {$lookup:{from:Order.collection.name,localField:'orderId',foreignField:'_id',as:'order',pipeline:[{$project:{publicId:1,country:1,'totals.currency':1}}]}},{$unwind:'$order'},
    {$match:{$or:marketPairs(context).map(row=>({'campaign.country':row.country,'order.country':row.country,currency:row.currency,'order.totals.currency':row.currency}))}},
    {$match:{$expr:{$eq:['$orderPublicId','$order.publicId']}}}];
}
function payoutDto(row,context) {
  const actor=context.actor;
  const account=row.destination,own=String(row.ownerUserId)===String(actor._id)||String(row.requestedByUserId)===String(actor._id),submitted=String(row.submittedByUserId)===String(actor._id);
  const currentCurrency=currentMarketCurrency(context,account.country,row.currency);
  return {publicId:row.publicId,country:account.country,currency:row.currency,ownerType:account.ownerType,storePublicId:row.ownerStorePublicId||'',amountMinor:row.amountMinor,status:row.status,version:row.__v||0,requestedAt:row.requestedAt||row.createdAt,
    destination:{...publicPayoutAccount(account),version:account.__v||0},approvedAt:row.approvedAt||null,submissionStartedAt:row.submissionStartedAt||null,submittedAt:row.submittedAt||null,completedAt:row.completedAt||null,
    submissionAttemptId:row.submissionAttemptId||'',providerReference:row.providerReference||'',provider:row.disbursementProvider||'external',ambiguityReason:row.ambiguityReason||'',failureMessage:row.failureMessage||'',
    actions:{approve:currentCurrency&&!own&&row.status==='requested'&&account.status==='verified',reject:currentCurrency&&!own&&['requested','approved'].includes(row.status),submit:currentCurrency&&!own&&row.status==='approved'&&account.status==='verified'&&String(row.approvedByUserId)!==String(actor._id),
      confirm:currentCurrency&&submitted&&row.status==='submitting',reveal:currentCurrency&&submitted&&row.status==='submitting',unknown:currentCurrency&&!own&&['submitting','submitted'].includes(row.status),reconcile:currentCurrency&&!own&&!submitted&&['submitted','unknown'].includes(row.status)}};
}
function appealDto(row,actor) {return {publicId:row.publicId,country:row.campaign.country,currency:row.currency,orderPublicId:row.orderPublicId,campaignPublicId:row.campaign.publicId,campaignName:row.campaign.name,amountMinor:row.amountMinor,reversedAmountMinor:row.reversedAmountMinor||0,paidAmountMinor:row.paidAmountMinor||0,payablePosted:Boolean(row.payableAt),status:row.status,version:row.__v||0,appeal:{status:row.appeal.status,message:row.appeal.message||'',decision:row.appeal.decision||'',submittedAt:row.appeal.submittedAt||null,reviewedAt:row.appeal.reviewedAt||null},canReview:row.appeal.status==='pending'&&String(row.promoterUserId)!==String(actor._id)};}
function pathFor(context,values) {const params=new URLSearchParams();if(context.country)params.set('country',context.country);for(const [key,value]of Object.entries(values))if(value)params.set(key,value);return '/finance/payouts'+(params.size?'?'+params.toString():'');}
function statusTotal(rows,statuses) {return rows.filter(row=>statuses.includes(row._id.status)).reduce((sum,row)=>sum+row.count,0);}
function totalSummary(rows,statuses) {const grouped=new Map();for(const row of rows.filter(row=>statuses.includes(row._id.status)))grouped.set(row._id.currency,(grouped.get(row._id.currency)||0)+row.amountMinor);return [...grouped].sort(([a],[b])=>a.localeCompare(b)).map(([currency,amount])=>money(amount,currency)).join(' · ')||'No reserved amount';}
export async function loadFinancePayoutPage(request) {
  const context=await financeAccess(request),filters=filtersFor(request),limit=30;
  const [totals,destinationTotals,appealTotals]=await Promise.all([
    Payout.aggregate([...payoutMarketStages(context),{$group:{_id:{status:'$status',currency:'$currency'},count:{$sum:1},amountMinor:{$sum:'$amountMinor'}}}]),
    PayoutAccount.aggregate([{$match:accountScope(context)},{$group:{_id:'$status',count:{$sum:1}}}]),
    CommissionEntry.aggregate([...appealMarketStages(context),{$match:{'appeal.status':'pending'}},{$count:'count'}]),
  ]);
  let model,stages,baseScope,columns,rows,result;
  const search=filters.search?{$regex:escapeRegex(filters.search),$options:'i'}:null;
  if(filters.tab==='payouts') {
    model=Payout;stages=payoutMarketStages(context);baseScope={...(filters.status?{status:filters.status}:{}),...(search?{$or:[{publicId:search},{'destination.label':search},{ownerStorePublicId:search}]}:{})};columns=['Payout','Owner','Destination','Amount','Status','Requested'];
  } else if(filters.tab==='destinations') {
    model=PayoutAccount;stages=[];baseScope={...accountScope(context),...(filters.status?{status:filters.status}:{}),...(search?{$and:[{$or:[{publicId:search},{label:search},{ownerStorePublicId:search}]}]}:{})};columns=['Destination','Owner','Method','Market','Status'];
  } else {
    model=CommissionEntry;stages=appealMarketStages(context);baseScope={'appeal.status':filters.status||{$in:appealStatuses},...(search?{$or:[{publicId:search},{orderPublicId:search},{'campaign.name':search}]}:{})};columns=['Commission','Order','Campaign','Reversed','Appeal','Submitted'];
  }
  const [records,countRows]=await Promise.all([model.aggregate([...stages,{$match:cursorScope(baseScope,filters.after)},{$sort:cursorSort()},{$limit:limit+1},...(filters.tab==='destinations'?[{$project:{destinationEncrypted:0}}]:[])]),model.aggregate([...stages,{$match:baseScope},{$count:'count'}])]);
  result=pageResult(records,{limit,total:countRows[0]?.count||0});
  const payouts=filters.tab==='payouts'?result.items.map(row=>payoutDto(row,context)):[],destinations=filters.tab==='destinations'?result.items.map(row=>({...publicPayoutAccount(row),version:row.__v||0,canReview:currentMarketCurrency(context,row.country,row.currency)&&row.status==='pending'&&String(row.ownerUserId)!==String(context.actor._id)})):[],appeals=filters.tab==='appeals'?result.items.map(row=>appealDto(row,context.actor)):[];
  const date=value=>value?new Intl.DateTimeFormat('en-UG',{dateStyle:'medium',timeZone:context.market?.timeZone||'UTC'}).format(new Date(value)):'—';
  rows=filters.tab==='payouts'?payouts.map(row=>({id:row.publicId,href:pathFor(context,{tab:'payouts',record:row.publicId}),cells:[row.publicId,row.ownerType+(row.storePublicId?' · '+row.storePublicId:''),row.destination.label,money(row.amountMinor,row.currency),row.status.replaceAll('_',' '),date(row.requestedAt)]}))
    :filters.tab==='destinations'?destinations.map(row=>({id:row.publicId,href:pathFor(context,{tab:'destinations',destination:row.publicId}),cells:[row.label,row.ownerType,row.method.replaceAll('_',' '),row.country+' · '+row.currency,row.status]}))
      :appeals.map(row=>({id:row.publicId,href:pathFor(context,{tab:'appeals',appeal:row.publicId}),cells:[row.publicId,row.orderPublicId,row.campaignName,money(row.reversedAmountMinor,row.currency),row.appeal.status,date(row.appeal.submittedAt)]}));
  let selected=null;
  if(request.query?.record){const [row]=await Payout.aggregate([...payoutMarketStages(context),{$match:{publicId:request.query.record}},{$limit:1}]);if(!row)throw new AppError('Payout not found in your current scope.',404,'PAYOUT_NOT_FOUND');selected={type:'payout',...payoutDto(row,context)};}
  else if(request.query?.destination){const row=await PayoutAccount.findOne(mongoose.trusted({...accountScope(context),publicId:request.query.destination})).lean();if(!row)throw new AppError('Destination not found in your current scope.',404,'PAYOUT_ACCOUNT_NOT_FOUND');selected={type:'destination',...publicPayoutAccount(row),version:row.__v||0,canReview:currentMarketCurrency(context,row.country,row.currency)&&row.status==='pending'&&String(row.ownerUserId)!==String(context.actor._id)};}
  else if(request.query?.appeal){const [row]=await CommissionEntry.aggregate([...appealMarketStages(context),{$match:{publicId:request.query.appeal,'appeal.status':{$in:appealStatuses}}},{$limit:1}]);if(!row)throw new AppError('Appeal not found in your current scope.',404,'COMMISSION_APPEAL_NOT_FOUND');selected={type:'appeal',...appealDto(row,context.actor)};}
  if(selected){const logs=await AuditLog.find({targetPublicId:selected.publicId,country:selected.country,action:/^finance\.(payout_|commission_appeal)/}).select('action createdAt actorPublicId').sort({createdAt:-1}).limit(20).lean();selected.history=logs.map(row=>({action:row.action.replace(/^finance\./,'').replaceAll('_',' '),at:row.createdAt,operator:row.actorPublicId||'Recorded operator'}));}
  await assertFinanceExportAccess(request,context);
  return {kind:'payouts',pageId:'finance-payouts',context:financePublicContext(context),country:context.country,currency:context.currency,metrics:[{label:'Awaiting approval',value:statusTotal(totals,['requested']),detail:totalSummary(totals,['requested'])},{label:'Approved',value:statusTotal(totals,['approved']),detail:totalSummary(totals,['approved'])},{label:'In transfer / uncertain',value:statusTotal(totals,['submitting','submitted','unknown']),detail:totalSummary(totals,['submitting','submitted','unknown'])},{label:'Completed payouts',value:statusTotal(totals,['paid']),detail:totalSummary(totals,['paid'])}],
    columns,rows,payouts,destinations,appeals,selected,page:result.page,pagination:result.page,statuses:(filters.tab==='payouts'?payoutStatuses:filters.tab==='destinations'?accountStatuses:appealStatuses).map(value=>({value,label:value.replaceAll('_',' ')})),filters:{...filters,statuses:[{value:'',label:'All'},...(filters.tab==='payouts'?payoutStatuses:filters.tab==='destinations'?accountStatuses:appealStatuses).map(value=>({value,label:value.replaceAll('_',' ')}))],params:{tab:filters.tab,country:context.country},placeholder:'Search reference or destination'},
    tabs:tabs.map(value=>({id:value,label:value==='payouts'?'Payout queue':value==='destinations'?'Destinations':'Commission appeals',href:pathFor(context,{tab:value}),active:value===filters.tab})),
    destinationPending:Number(destinationTotals.find(row=>row._id==='pending')?.count||0),appealPending:Number(appealTotals[0]?.count||0),summary:totals.map(row=>({status:row._id.status,currency:row._id.currency,count:row.count,amountMinor:row.amountMinor})),exportHref:pathFor(context,{tab:filters.tab,status:filters.status,search:filters.search}).replace('/finance/payouts','/finance/payouts/export.csv'),
    insights:[...(Number(destinationTotals.find(row=>row._id==='pending')?.count||0)?[{text:'Payout destinations are awaiting independent verification.',label:'Review destinations',href:pathFor(context,{tab:'destinations',status:'pending'})}]:[]),...(Number(appealTotals[0]?.count||0)?[{text:'Recorded commission appeals need independent review.',label:'Review commission appeals',href:pathFor(context,{tab:'appeals',status:'pending'})}]:[]),...(statusTotal(totals,['unknown'])?[{text:'Uncertain transfers remain reserved. Check the same recorded attempts before deciding their final outcomes.',href:pathFor(context,{status:'unknown'}),label:'Review uncertain transfers'}]:[])],health:{label:'Payout queue',value:null,note:'Reserved funds stay held until a verified final outcome.',rows:[{label:'Destinations awaiting review',value:Number(destinationTotals.find(row=>row._id==='pending')?.count||0)},{label:'Commission appeals',value:Number(appealTotals[0]?.count||0)},{label:'Uncertain transfers',value:statusTotal(totals,['unknown'])}]},workflow:[{title:'Verify destination',text:'Review independent destination evidence before approving withdrawals.'},{title:'Approve reservation',text:'A different actor approves actual reserved funds.'},{title:'Transfer once',text:'Claim one immutable attempt and record the actual external reference.'},{title:'Reconcile independently',text:'Confirm external evidence, then settle or release the same reservation.'}]};
}
export async function actOnFinancePayout(request,id,action,input={}) {
  await financeAccess(request);if(!recordId(id))throw new AppError('Choose a supported payout record.',422,'PAYOUT_REQUEST_INVALID');
  if(!Number.isSafeInteger(Number(input.version))||Number(input.version)<0||input.version===undefined||input.version==='')throw new AppError('Refresh the payout before continuing.',422,'PAYOUT_VERSION_INVALID');
  const actions={approve:approvePayout,reject:rejectPayout,submit:submitPayout,'submission-confirm':confirmPayoutSubmission,unknown:markPayoutUnknown};
  if(action==='reconcile') {if(!['paid','failed'].includes(input.outcome)||typeof input.message!=='string'||input.message.trim().length<8)throw new AppError('Choose the final outcome and record the external evidence.',422,'PAYOUT_EVIDENCE_REQUIRED');return reconcilePayout(request,id,{...input,success:input.outcome==='paid'});}
  if(!actions[action])throw new AppError('Choose a supported payout action.',422,'PAYOUT_ACTION_INVALID');
  if(['submission-confirm','unknown'].includes(action)&&!recordId(input.submissionAttemptId))throw new AppError('Refresh the recorded transfer attempt.',422,'PAYOUT_ATTEMPT_REQUIRED');
  return actions[action](request,id,input);
}
export async function reviewFinanceDestination(request,id,input={}) {await financeAccess(request);if(!recordId(id)||!Number.isSafeInteger(Number(input.version))||input.version===undefined||input.version==='')throw new AppError('Refresh the payout destination before reviewing it.',422,'PAYOUT_VERSION_INVALID');return reviewPayoutAccount(request,id,input);}
export async function reviewFinanceAppeal(request,id,input={}) {await financeAccess(request);if(!recordId(id)||!Number.isSafeInteger(Number(input.version))||input.version===undefined||input.version==='')throw new AppError('Refresh the commission appeal before reviewing it.',422,'COMMISSION_APPEAL_STATE_CHANGED');const row=await reviewCommissionAppeal(request,id,input);return {publicId:row.publicId,status:row.status,appeal:{status:row.appeal.status,decision:row.appeal.decision,reviewedAt:row.appeal.reviewedAt}};}
export { revealPayoutDestination };
function csv(value) {let text=String(value??'');if(/^[\s]*[=+@-]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';}
export async function streamFinancePayoutCsv(request,response) {
  const filters=filtersFor(request),session=await mongoose.startSession();let context;
  try {await session.withTransaction(async()=>{context=await financeAccess(request,{session,write:true});await writeAudit(request,'finance.payouts_exported',{actor:context.actor,targetType:'finance_export',country:context.country||undefined,metadata:{tab:filters.tab},session});});}finally{await session.endSession();}
  const model=filters.tab==='payouts'?Payout:filters.tab==='destinations'?PayoutAccount:CommissionEntry,stages=filters.tab==='payouts'?payoutMarketStages(context):filters.tab==='appeals'?appealMarketStages(context):[];
  const search=filters.search?{$regex:escapeRegex(filters.search),$options:'i'}:null;
  const match=filters.tab==='destinations'?{...accountScope(context),...(filters.status?{status:filters.status}:{}),...(search?{$and:[{$or:[{publicId:search},{label:search},{ownerStorePublicId:search}]}]}:{})}:filters.tab==='appeals'?{'appeal.status':filters.status||{$in:appealStatuses},...(search?{$or:[{publicId:search},{orderPublicId:search},{'campaign.name':search}]}:{})}:{...(filters.status?{status:filters.status}:{}),...(search?{$or:[{publicId:search},{'destination.label':search},{ownerStorePublicId:search}]}:{})};
  await assertFinanceExportAccess(request,context);
  response.type('text/csv').set('Content-Disposition',`attachment; filename="finance-${filters.tab}.csv"`).set('Cache-Control','private, no-store');
  const header=filters.tab==='payouts'?['Payout','Country','Currency','Amount minor','Owner type','Destination label','Status','Requested at']:filters.tab==='destinations'?['Destination','Country','Currency','Label','Owner type','Method','Status']:['Commission','Country','Currency','Reversed minor','Order','Campaign','Appeal status'];response.write(header.map(csv).join(',')+'\r\n');
  const cursor=model.aggregate([...stages,{$match:match},{$sort:cursorSort()},{$project:{publicId:1,currency:1,country:1,amountMinor:1,ownerType:1,method:1,label:1,status:1,requestedAt:1,createdAt:1,'destination.country':1,'destination.ownerType':1,'destination.label':1,reversedAmountMinor:1,orderPublicId:1,'campaign.country':1,'campaign.name':1,'appeal.status':1}}]).cursor({batchSize:100});
  try {for await(const row of cursor){if(response.destroyed)break;await assertFinanceExportAccess(request,context);const values=filters.tab==='payouts'?[row.publicId,row.destination.country,row.currency,row.amountMinor,row.destination.ownerType,row.destination.label,row.status,new Date(row.requestedAt||row.createdAt).toISOString()]:filters.tab==='destinations'?[row.publicId,row.country,row.currency,row.label,row.ownerType,row.method,row.status]:[row.publicId,row.campaign.country,row.currency,row.reversedAmountMinor||0,row.orderPublicId,row.campaign.name,row.appeal.status];if(!response.write(values.map(csv).join(',')+'\r\n'))await new Promise(resolve=>{const done=()=>{response.off('drain',done);response.off('close',done);resolve();};response.once('drain',done);response.once('close',done);});}}finally{await cursor.close();}response.end();
}

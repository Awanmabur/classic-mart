import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { normalizeEmail } from '../core/crypto.js';
import { encryptSensitive, decryptSensitive } from '../core/sensitive.js';
import { remainingProcurementItems, remainingApprovedMinor } from '../core/procurement.js';
import {
  AuditLog, BusinessInvoice, BusinessOrganization, BusinessMember, BusinessBudget, CountrySetting, ProcurementRequest,
  QuoteRequest, PurchaseOrder, ProcurementTemplate, ProcurementRun, Product, ProductVariant,
  Store, User,
} from '../models/index.js';
import { cursorScope, cursorSort, decodeCursor, pageResult } from './pagination.js';
import { businessDocumentHistory, issuePurchaseOrderDocument, issueQuotationDocument } from './business-documents.js';


function escapeRegex(value){return String(value||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function taxFromSubtotal(subtotalMinor,taxBps){const subtotal=Math.max(0,Number(subtotalMinor||0));const rate=Math.max(0,Math.min(10000,Number(taxBps||0)));return Math.floor(subtotal*rate/10000);}
async function businessTaxSnapshot(country,session=null){let query=CountrySetting.findOne({code:String(country||'').toUpperCase(),active:true}).select('taxBps policyVersion');if(session)query=query.session(session);const setting=await query.lean();if(!setting)throw new AppError('Business country tax configuration is unavailable.',409,'BUSINESS_TAX_CONFIG_MISSING');return{taxBps:Number(setting.taxBps||0),taxPolicyVersion:String(setting.policyVersion||'').slice(0,40)||'unversioned'};}

async function businessCatalogue(organization,{search='',after='',limit=50}={}){
  const pageSize=Math.min(Math.max(Number(limit)||50,10),100);
  const term=String(search||'').trim().slice(0,120);
  const common=[
    {$match:{active:true,currency:organization.currency}},
    {$lookup:{from:'products',localField:'productId',foreignField:'_id',as:'product'}},
    {$unwind:'$product'},
    {$match:{'product.status':'published','product.countries':organization.country}},
    {$lookup:{from:'stores',localField:'storeId',foreignField:'_id',as:'store'}},
    {$unwind:'$store'},
    {$match:{'store.status':'verified','store.country':organization.country}},
  ];
  if(term){const re=new RegExp(escapeRegex(term),'i');common.push({$match:{$or:[{sku:re},{title:re},{'product.title':re},{'store.name':re}]}});}
  const cursor=decodeCursor(after,{type:'string'});
  const itemPipeline=[];
  if(cursor)itemPipeline.push({$match:{$or:[{sku:{$gt:cursor.value}},{sku:cursor.value,_id:{$gt:cursor.id}}]}});
  itemPipeline.push({$sort:{sku:1,_id:1}},{$limit:pageSize+1},{$project:{_id:1,publicId:1,sku:1,title:1,priceMinor:1,currency:1,productPublicId:'$product.publicId',productTitle:'$product.title',storePublicId:'$store.publicId',storeName:'$store.name'}});
  const [facet]=await ProductVariant.aggregate([...common,{$facet:{items:itemPipeline,total:[{$count:'count'}]}}]);
  const rows=facet?.items||[],total=facet?.total?.[0]?.count||0;
  return {...pageResult(rows,{field:'sku',direction:1,type:'string',limit:pageSize,total}),search:term};
}
async function quoteTargetsForRequests(requests){
  const eligible=requests.filter(row=>['approved','partially_ordered'].includes(row.status)&&!row.closedAt);
  if(!eligible.length)return[];
  const ids=eligible.map(row=>row._id);
  const [orders,activeQuotes]=await Promise.all([
    PurchaseOrder.find({procurementRequestId:mongoose.trusted({$in:ids}),status:{$in:['accepted','payment_pending','processing','fulfilled']}}).select('procurementRequestId items').lean(),
    QuoteRequest.find({procurementRequestId:mongoose.trusted({$in:ids}),status:{$in:['requested','negotiating','responded','accepted']}}).select('procurementRequestId storePublicId').lean(),
  ]);
  const coveredByRequest=new Map();
  for(const po of orders){const key=String(po.procurementRequestId);let coverage=coveredByRequest.get(key);if(!coverage){coverage=new Map();coveredByRequest.set(key,coverage);}for(const item of po.items||[]){const line=item.variantPublicId||item.productPublicId;coverage.set(line,(coverage.get(line)||0)+Number(item.quantity||0));}}
  const active=new Set(activeQuotes.map(row=>`${row.procurementRequestId}:${row.storePublicId}`));
  const grouped=[];const storeIds=new Set();
  for(const request of eligible){const remaining=remainingProcurementItems(request.items,coveredByRequest.get(String(request._id))||new Map());const byStore=new Map();for(const item of remaining){if(!item.storePublicId||!item.quantity)continue;storeIds.add(item.storePublicId);const list=byStore.get(item.storePublicId)||[];list.push(item);byStore.set(item.storePublicId,list);}for(const [storePublicId,items] of byStore){if(active.has(`${request._id}:${storePublicId}`))continue;grouped.push({procurementRequestId:request.publicId,requestTitle:request.title,storePublicId,items});}}
  const stores=storeIds.size?await Store.find({publicId:mongoose.trusted({$in:[...storeIds]}),status:'verified'}).select('publicId name').lean():[];
  const names=new Map(stores.map(row=>[row.publicId,row.name]));
  return grouped.filter(row=>names.has(row.storePublicId)).map(row=>({...row,storeName:names.get(row.storePublicId),lineCount:row.items.length,quantity:row.items.reduce((sum,item)=>sum+Number(item.quantity||0),0)}));
}


export function parseProcurementCsv(source){
  const lines=String(source||'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  if(lines.length<2)throw new AppError('CSV needs a header and at least one procurement row.',422,'PROCUREMENT_CSV_EMPTY');
  if(lines.length>501)throw new AppError('Import at most 500 procurement rows at a time.',422,'PROCUREMENT_CSV_TOO_LARGE');
  const parseLine=(line)=>{const cells=[];let current='',quoted=false;for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'&&line[i+1]==='"'&&quoted){current+='"';i++;}else if(ch==='"')quoted=!quoted;else if(ch===','&&!quoted){cells.push(current.trim());current='';}else current+=ch;}if(quoted)throw new AppError('CSV contains an unclosed quote.',422,'PROCUREMENT_CSV_INVALID');cells.push(current.trim());return cells;};
  const header=parseLine(lines[0]).map(x=>x.toLowerCase());const expected=['variantpublicid','quantity','note'];if(expected.some((x,i)=>header[i]!==x))throw new AppError('CSV header must be: variantPublicId,quantity,note',422,'PROCUREMENT_CSV_HEADER');
  return lines.slice(1).map((line,index)=>{const [variantPublicId,quantityRaw,note='']=parseLine(line);const quantity=Number(quantityRaw);if(!variantPublicId||variantPublicId.length>100||!Number.isInteger(quantity)||quantity<1||quantity>9999||note.length>300)throw new AppError(`Invalid procurement CSV row ${index+2}.`,422,'PROCUREMENT_CSV_ROW');return{variantPublicId,quantity,note};});
}

async function ensureOwnerMembership(org,user){
  return BusinessMember.findOneAndUpdate({organizationId:org._id,userId:user._id},{$set:{role:'owner',status:'active',canApprove:true,acceptedAt:org.createdAt||new Date()},$setOnInsert:{publicId:publicId('bmem'),invitedByUserId:user._id,invitedAt:org.createdAt||new Date()}},{upsert:true,returnDocument:'after',setDefaultsOnInsert:true});
}
async function businessOrganizationAccesses(user) {
  const [owned, memberships] = await Promise.all([
    BusinessOrganization.find({ ownerUserId: user._id, status: { $ne: 'suspended' } }).sort({ createdAt: 1 }).lean(),
    BusinessMember.find({ userId: user._id, status: 'active' }).sort({ acceptedAt: 1 }).lean(),
  ]);
  const memberOrgIds = memberships.map((row) => row.organizationId);
  const memberOrganizations = memberOrgIds.length
    ? await BusinessOrganization.find({ _id: { $in: memberOrgIds }, status: { $ne: 'suspended' } }).lean()
    : [];
  const membershipByOrganization = new Map(memberships.map((row) => [String(row.organizationId), row]));
  const access = new Map();
  for (const organization of owned) {
    access.set(organization.publicId, {
      organization,
      role: 'owner',
      membership: membershipByOrganization.get(String(organization._id)) || null,
    });
  }
  for (const organization of memberOrganizations) {
    if (access.has(organization.publicId)) continue;
    const membership = membershipByOrganization.get(String(organization._id));
    if (membership) access.set(organization.publicId, { organization, role: membership.role, membership });
  }
  return [...access.values()];
}

export async function businessContext(user,{create=false,preferredOrganizationPublicId='',strictPreferred=false}={}){
  let accesses=await businessOrganizationAccesses(user);
  const preferred=String(preferredOrganizationPublicId||user?.$locals?.activeBusinessPublicId||'').trim();
  let selected=preferred?accesses.find(row=>row.organization.publicId===preferred):null;
  if(preferred&&!selected&&strictPreferred)throw new AppError('Selected business workspace is unavailable.',403,'BUSINESS_WORKSPACE_FORBIDDEN');
  selected ||= accesses[0] || null;

  if(!selected){
    if(!create||user.role!=='business')throw new AppError('You are not an active member of a business purchasing organization.',403,'BUSINESS_ACCESS_REQUIRED');
    const org=await BusinessOrganization.create({publicId:publicId('borg'),ownerUserId:user._id,companyName:user.roleProfile?.businessName||`${user.name} Business`,country:user.country,currency:user.currency,billingEmail:user.email,status:'active'});
    const membership=await ensureOwnerMembership(org,user);
    accesses=[{organization:org.toObject(),role:'owner',membership}];
    selected=accesses[0];
  }

  const organization=await BusinessOrganization.findById(selected.organization._id);
  if(!organization||organization.status==='suspended')throw new AppError('Selected business workspace is unavailable.',403,'BUSINESS_WORKSPACE_FORBIDDEN');
  let membership=selected.membership?await BusinessMember.findById(selected.membership._id):null;
  if(organization.ownerUserId.equals(user._id))membership=await ensureOwnerMembership(organization,user);
  if(!membership||membership.status!=='active')throw new AppError('Selected business workspace membership is inactive.',403,'BUSINESS_WORKSPACE_FORBIDDEN');
  const availableOrganizations=accesses.map(row=>({
    publicId:row.organization.publicId,
    companyName:row.organization.companyName,
    country:row.organization.country,
    currency:row.organization.currency,
    status:row.organization.status,
    role:row.role,
  }));
  return {organization,membership,availableOrganizations};
}
export function businessCapabilities(member){
  const map={owner:['*'],admin:['members','budgets','buy','approve','quotes','po','templates'],buyer:['buy','quotes','templates'],approver:['approve','quotes','po'],viewer:[]};
  return new Set(map[member?.role]||[]);
}
export function requireBusinessCapability(member,cap){const set=businessCapabilities(member);if(!set.has('*')&&!set.has(cap))throw new AppError('Your business team role does not allow that action.',403,'BUSINESS_PERMISSION_DENIED');}
export async function updateBusinessProfile(user,input){
  const {organization,membership}=await businessContext(user,{create:true});requireBusinessCapability(membership,'members');
  organization.companyName=String(input.companyName||organization.companyName).trim().slice(0,180);
  organization.billingEmail=String(input.billingEmail||organization.billingEmail||'').trim().slice(0,254);
  for(const field of ['billingContactName','billingPhone','billingAddress','billingCity','deliveryContactName','deliveryPhone','deliveryAddress','deliveryCity']){
    if(input[field]!==undefined)organization[field]=String(input[field]||'').trim();
  }
  if(input.taxId!==undefined)organization.taxIdEncrypted=encryptSensitive(String(input.taxId||'').trim().slice(0,120));
  await organization.save();return organization;
}
export async function businessProfileView(user){const {organization,membership,availableOrganizations}=await businessContext(user,{create:true});let taxId='';try{if(organization.taxIdEncrypted)taxId=decryptSensitive(organization.taxIdEncrypted);}catch{}return {organization,membership,taxId,availableOrganizations};}
export async function inviteBusinessMember(actor,input){const {organization,membership}=await businessContext(actor,{create:true});requireBusinessCapability(membership,'members');const user=await User.findOne({emailNormalized:normalizeEmail(input.email),status:'active'});if(!user)throw new AppError('Invitee must already have an active Classic Mart account.',404,'BUSINESS_INVITEE_NOT_FOUND');if(user._id.equals(actor._id))throw new AppError('You are already a member.',409,'BUSINESS_MEMBER_EXISTS');return BusinessMember.findOneAndUpdate({organizationId:organization._id,userId:user._id},{$set:{role:input.role,status:'invited',spendingLimitMinor:Math.max(0,Number(input.spendingLimitMinor||0)),canApprove:Boolean(input.canApprove),invitedByUserId:actor._id,invitedAt:new Date(),acceptedAt:null,revokedAt:null},$setOnInsert:{publicId:publicId('bmem')}},{upsert:true,returnDocument:'after',setDefaultsOnInsert:true});}
export async function acceptBusinessInvite(user,memberId){const row=await BusinessMember.findOne({publicId:memberId,userId:user._id,status:'invited'});if(!row)throw new AppError('Business invitation not found.',404,'BUSINESS_INVITE_NOT_FOUND');row.status='active';row.acceptedAt=new Date();await row.save();return row;}
export async function createBudget(actor,input){const {organization,membership}=await businessContext(actor,{create:true});requireBusinessCapability(membership,'budgets');const start=new Date(input.periodStart),end=new Date(input.periodEnd);if(!(end>start))throw new AppError('Budget period end must be after its start.',422,'BUDGET_PERIOD_INVALID');return BusinessBudget.create({publicId:publicId('bbud'),organizationId:organization._id,name:input.name,currency:organization.currency,limitMinor:Number(input.limitMinor),periodStart:start,periodEnd:end,createdByUserId:actor._id});}
async function validateItems(org,items){
  const variantIds=[...new Set(items.map(x=>String(x.variantPublicId||'').trim()).filter(Boolean))];
  if(!variantIds.length)throw new AppError('Choose an exact product variant for every procurement line.',422,'PROCUREMENT_VARIANT_REQUIRED');
  const variants=await ProductVariant.find({publicId:mongoose.trusted({$in:variantIds}),active:true,currency:org.currency}).lean();
  const variantMap=new Map(variants.map(x=>[x.publicId,x]));
  const productIds=[...new Set(variants.map(x=>String(x.productId)))].map(id=>new mongoose.Types.ObjectId(id));
  const products=await Product.find({_id:mongoose.trusted({$in:productIds}),status:'published',countries:org.country}).lean();
  const productMap=new Map(products.map(x=>[String(x._id),x]));
  const storeIds=[...new Set(products.map(x=>String(x.storeId)))].map(id=>new mongoose.Types.ObjectId(id));
  const stores=await Store.find({_id:mongoose.trusted({$in:storeIds}),status:'verified',country:org.country}).lean();
  const storeMap=new Map(stores.map(x=>[String(x._id),x]));
  let total=0;const normalized=[];
  for(const raw of items){
    const variant=variantMap.get(String(raw.variantPublicId||'').trim());
    if(!variant)throw new AppError(`Variant ${raw.variantPublicId||''} is unavailable.`,409,'PROCUREMENT_VARIANT_UNAVAILABLE');
    const product=productMap.get(String(variant.productId));
    const store=product?storeMap.get(String(product.storeId)):null;
    if(!product||!store||String(variant.storeId)!==String(store._id))throw new AppError(`Variant ${variant.publicId} is no longer sellable in your country.`,409,'PROCUREMENT_PRODUCT_UNAVAILABLE');
    const quantity=Math.max(1,Math.min(9999,Number(raw.quantity||1)));
    total+=variant.priceMinor*quantity;
    normalized.push({productPublicId:product.publicId,variantPublicId:variant.publicId,storePublicId:store.publicId,sku:variant.sku,title:product.title,variantTitle:variant.title,quantity,estimatedUnitMinor:variant.priceMinor,note:String(raw.note||'').slice(0,300)});
  }
  return {items:normalized,total};
}
export async function createProcurementRequest(actor,input){const {organization,membership}=await businessContext(actor,{create:true});requireBusinessCapability(membership,'buy');const checked=await validateItems(organization,input.items);const tax=await businessTaxSnapshot(organization.country);const estimatedTaxMinor=taxFromSubtotal(checked.total,tax.taxBps);const estimatedTotalMinor=checked.total+estimatedTaxMinor;if(membership.spendingLimitMinor>0&&estimatedTotalMinor>membership.spendingLimitMinor)throw new AppError('Request exceeds your personal spending limit including configured tax.',403,'SPENDING_LIMIT_EXCEEDED');let budget=null;if(input.budgetId){budget=await BusinessBudget.findOne({publicId:input.budgetId,organizationId:organization._id,active:true,periodStart:{$lte:new Date()},periodEnd:{$gte:new Date()}});if(!budget)throw new AppError('Budget not found.',404,'BUDGET_NOT_FOUND');if(Number(budget.spentMinor||0)+budget.committedMinor+estimatedTotalMinor>budget.limitMinor)throw new AppError('Request exceeds the selected business budget including configured tax.',409,'BUDGET_EXCEEDED');}
 const row=await ProcurementRequest.create({publicId:publicId('preq'),organizationId:organization._id,requesterUserId:actor._id,budgetId:budget?._id,title:String(input.title).trim().slice(0,160),items:checked.items,estimatedSubtotalMinor:checked.total,taxBps:tax.taxBps,estimatedTaxMinor,taxPolicyVersion:tax.taxPolicyVersion,estimatedTotalMinor,currency:organization.currency,status:'submitted',timeline:[{type:'submitted',message:`Procurement request submitted for approval with ${tax.taxBps} bps country tax snapshot.`,actorUserId:actor._id}]});return row;}
export async function decideProcurementRequest(actor,id,{approve,reason=''}){
  const {organization,membership}=await businessContext(actor);requireBusinessCapability(membership,'approve');
  const session=await mongoose.startSession();let decided;
  try{await session.withTransaction(async()=>{const row=await ProcurementRequest.findOne({publicId:id,organizationId:organization._id,status:'submitted'}).session(session);if(!row)throw new AppError('Pending procurement request not found.',404,'PROCUREMENT_REQUEST_NOT_FOUND');if(row.requesterUserId.equals(actor._id))throw new AppError('A different approver must decide this request.',403,'FOUR_EYES_REQUIRED');if(!approve){row.status='rejected';row.rejectedAt=new Date();row.rejectionReason=String(reason).slice(0,500);row.timeline.push({type:'rejected',message:row.rejectionReason||'Procurement request rejected.',actorUserId:actor._id});await row.save({session});decided=row;return;}if(row.budgetId){const budget=await BusinessBudget.findOneAndUpdate({_id:row.budgetId,organizationId:organization._id,active:true,periodStart:{$lte:new Date()},periodEnd:{$gte:new Date()},$expr:{$lte:[{$add:[{$ifNull:['$spentMinor',0]},'$committedMinor',row.estimatedTotalMinor]},'$limitMinor']}},{$inc:{committedMinor:row.estimatedTotalMinor}},{session,returnDocument:'after'});if(!budget)throw new AppError('Budget no longer has enough available capacity.',409,'BUDGET_EXCEEDED');}row.status='approved';row.approvedByUserId=actor._id;row.approvedAt=new Date();row.timeline.push({type:'approved',message:'Procurement request approved.',actorUserId:actor._id});await row.save({session});decided=row;});return decided;}finally{await session.endSession();}
}
async function procurementCoverage(procurementId,session=null){
  let query=PurchaseOrder.find({procurementRequestId:procurementId,status:{$in:['accepted','payment_pending','processing','fulfilled']}}).select('items').lean();if(session)query=query.session(session);const rows=await query;const covered=new Map();for(const po of rows)for(const item of po.items){const key=item.variantPublicId||item.productPublicId;covered.set(key,(covered.get(key)||0)+Number(item.quantity||0));}return covered;
}
export async function createQuoteRequest(actor,input){
  const {organization,membership}=await businessContext(actor,{create:true});requireBusinessCapability(membership,'quotes');
  const approved=await ProcurementRequest.findOne({publicId:input.procurementRequestId,organizationId:organization._id,status:{$in:['approved','partially_ordered']},closedAt:null}).lean();
  if(!approved)throw new AppError('Select an open approved procurement request before requesting a seller quotation.',409,'PROCUREMENT_APPROVAL_REQUIRED');
  const store=await Store.findOne({publicId:input.storeId,status:'verified',country:organization.country});if(!store)throw new AppError('Verified seller store not found in your country.',404,'QUOTE_STORE_NOT_FOUND');
  const existing=await QuoteRequest.exists({organizationId:organization._id,procurementRequestId:approved._id,storeId:store._id,status:{$in:['requested','negotiating','responded','accepted']}});if(existing)throw new AppError('This seller already has an active quotation for that procurement request.',409,'QUOTE_ALREADY_ACTIVE');
  const covered=await procurementCoverage(approved._id);const remaining=remainingProcurementItems(approved.items,covered);
  const items=remaining.filter(item=>item.storePublicId===store.publicId).map(item=>({productPublicId:item.productPublicId,variantPublicId:item.variantPublicId,sku:item.sku,title:item.title,variantTitle:item.variantTitle,quantity:item.quantity,requestedUnitMinor:item.estimatedUnitMinor,offeredUnitMinor:0,offeredLineMinor:0}));
  const approvedAmountMinor=items.reduce((sum,item)=>sum+Number(item.requestedUnitMinor||0)*Number(item.quantity||0),0);
  if(!items.length||approvedAmountMinor<=0)throw new AppError('That seller has no remaining approved variants in this procurement request.',422,'QUOTE_ITEM_STORE_MISMATCH');
  return QuoteRequest.create({publicId:publicId('qte'),organizationId:organization._id,procurementRequestId:approved._id,requesterUserId:actor._id,storeId:store._id,storePublicId:store.publicId,country:organization.country,currency:organization.currency,approvedAmountMinor,items,status:'requested',messages:[{actorType:'buyer',actorUserId:actor._id,message:String(input.message||'Please provide a quotation.').slice(0,2000)}]});
}
export async function businessReplyQuote(actor,id,message){const {organization,membership}=await businessContext(actor);requireBusinessCapability(membership,'quotes');const quote=await QuoteRequest.findOne({publicId:id,organizationId:organization._id,status:{$in:['requested','responded','negotiating']}});if(!quote)throw new AppError('Active quotation not found.',404,'QUOTE_NOT_FOUND');quote.messages.push({actorType:'buyer',actorUserId:actor._id,message:String(message).trim().slice(0,2000)});quote.status='negotiating';await quote.save();return quote;}
export async function acceptQuote(actor,id,{paymentTerms='immediate'}={}){
  const {organization,membership}=await businessContext(actor);requireBusinessCapability(membership,'po');
  const terms=paymentTerms==='credit'?'credit':'immediate';
  if(terms==='credit'&&(!organization.invoiceTermsApproved||organization.invoiceTermsDays<=0||organization.creditLimitMinor<=0))throw new AppError('Approved business credit terms are required for a credit purchase order.',409,'INVOICE_TERMS_NOT_APPROVED');
  const session=await mongoose.startSession();let created;
  try{await session.withTransaction(async()=>{
    const quote=await QuoteRequest.findOne({publicId:id,organizationId:organization._id,status:{$in:['responded','negotiating']}}).session(session);
    if(!quote||!quote.offeredTotalMinor)throw new AppError('Seller quotation is not ready for acceptance.',409,'QUOTE_NOT_READY');
    if(quote.validUntil&&quote.validUntil<=new Date())throw new AppError('Seller quotation has expired.',409,'QUOTE_EXPIRED');
    const procurement=await ProcurementRequest.findOne({_id:quote.procurementRequestId,organizationId:organization._id,status:{$in:['approved','partially_ordered']},closedAt:null}).session(session);
    if(!procurement)throw new AppError('The procurement approval is no longer valid.',409,'PROCUREMENT_APPROVAL_REQUIRED');
    if(quote.offeredTotalMinor>quote.approvedAmountMinor)throw new AppError('Seller quotation exceeds the approved amount for this seller and requires a new procurement approval.',409,'QUOTE_EXCEEDS_APPROVAL');
    const items=[];let total=0;
    for(const q of quote.items){
      if(!q.variantPublicId||!q.sku||!q.offeredUnitMinor||q.offeredUnitMinor<0)throw new AppError('Every quoted line needs an exact variant/SKU and seller unit price.',409,'QUOTE_LINE_INCOMPLETE');
      const variant=await ProductVariant.findOne({publicId:q.variantPublicId,storeId:quote.storeId,active:true,currency:quote.currency}).session(session).lean();
      if(!variant||variant.sku!==q.sku)throw new AppError(`Quoted SKU ${q.sku} is no longer available.`,409,'QUOTE_VARIANT_UNAVAILABLE');
      const product=await Product.findOne({_id:variant.productId,publicId:q.productPublicId,storeId:quote.storeId,status:'published',countries:quote.country}).session(session).lean();
      if(!product)throw new AppError(`Quoted product ${q.productPublicId} is no longer available.`,409,'QUOTE_PRODUCT_UNAVAILABLE');
      const line=Number(q.offeredUnitMinor)*Number(q.quantity);total+=line;
      items.push({productPublicId:q.productPublicId,variantPublicId:q.variantPublicId,sku:q.sku,title:q.title||product.title,variantTitle:q.variantTitle||variant.title,quantity:q.quantity,unitMinor:q.offeredUnitMinor,lineMinor:line});
    }
    if(total!==Number(quote.offeredTotalMinor))throw new AppError('Quotation line prices do not add up to the quoted total.',409,'QUOTE_TOTAL_MISMATCH');
    const taxBps=Number(procurement.taxBps||0);const taxMinor=taxFromSubtotal(total,taxBps);const grossTotal=total+taxMinor;const approvedTaxMinor=taxFromSubtotal(quote.approvedAmountMinor,taxBps);const approvedGrossMinor=Number(quote.approvedAmountMinor||0)+approvedTaxMinor;
    if(terms==='credit'){
      const {BusinessInvoice}=await import('../models/BusinessInvoice.js');
      const outstanding=await BusinessInvoice.aggregate([{$match:{organizationId:organization._id,status:{$in:['credit_pending_delivery','open','overdue']}}},{$group:{_id:null,total:{$sum:{$subtract:['$totalMinor','$paidMinor']}}}}]).session(session);
      if(Number(outstanding[0]?.total||0)+grossTotal>Number(organization.creditLimitMinor||0))throw new AppError('This purchase order would exceed the approved business credit limit including tax.',409,'BUSINESS_CREDIT_LIMIT');
    }
    if(!quote.revision)quote.revision=1;
    await issueQuotationDocument(quote,{session,issuedByUserId:actor._id,legacySnapshot:Number(quote.revision||0)===1&&!quote.messages?.some?.(m=>m.actorType==='seller'&&m.at)});
    quote.status='accepted';quote.acceptedAt=new Date();await quote.save({session});
    const [po]=await PurchaseOrder.create([{publicId:publicId('po'),poNumber:`CM-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`,organizationId:organization._id,quoteRequestId:quote._id,procurementRequestId:procurement._id,storeId:quote.storeId,storePublicId:quote.storePublicId,issuedByUserId:actor._id,country:organization.country,currency:organization.currency,items,approvedAmountMinor:approvedGrossMinor,subtotalMinor:total,taxBps,taxMinor,taxPolicyVersion:procurement.taxPolicyVersion||'legacy-zero-tax',totalMinor:grossTotal,invoiceTermsDays:terms==='credit'?organization.invoiceTermsDays:0,paymentTerms:terms,status:'issued',timeline:[{type:'issued',message:`Purchase order issued with ${terms==='credit'?`${organization.invoiceTermsDays}-day credit`:'immediate Pesapal payment'} terms and ${taxBps} bps country tax snapshot.`,actorUserId:actor._id}]}],{session});
    await issuePurchaseOrderDocument(po,{session,issuedByUserId:actor._id});created=po;
  });return created;}finally{await session.endSession();}
}

export async function cancelProcurementRequest(actor,id,{reason=''}={}){
  const {organization,membership}=await businessContext(actor);requireBusinessCapability(membership,'buy');const session=await mongoose.startSession();let cancelled;
  try{await session.withTransaction(async()=>{
    const row=await ProcurementRequest.findOne({publicId:id,organizationId:organization._id,status:{$in:['submitted','approved','partially_ordered']},closedAt:null}).session(session);if(!row)throw new AppError('Cancellable procurement request not found.',404,'PROCUREMENT_REQUEST_NOT_FOUND');
    const covered=await procurementCoverage(row._id,session);const releaseMinor=remainingApprovedMinor(row.items,covered,{taxBps:row.taxBps});const hasAccepted=covered.size>0;
    if(hasAccepted&&releaseMinor<=0)throw new AppError('All approved quantities already have accepted purchase orders.',409,'PROCUREMENT_ALREADY_COMMITTED');
    await PurchaseOrder.updateMany({procurementRequestId:row._id,status:'issued'},{$set:{status:'cancelled'},$push:{timeline:{type:'buyer.cancelled',message:'Buyer cancelled the remaining procurement request.',actorUserId:actor._id}}},{session});
    await QuoteRequest.updateMany({procurementRequestId:row._id,status:{$in:['requested','negotiating','responded','accepted']}},{$set:{status:'rejected'}},{session});
    if(row.status!=='submitted'&&row.budgetId&&releaseMinor>0){const budget=await BusinessBudget.findOneAndUpdate({_id:row.budgetId,organizationId:organization._id,committedMinor:{$gte:releaseMinor}},{$inc:{committedMinor:-releaseMinor}},{session,returnDocument:'after'});if(!budget)throw new AppError('Committed budget could not be released safely.',409,'BUDGET_RELEASE_CONFLICT');}
    row.closedAt=new Date();row.closeReason=String(reason||'Buyer cancelled the remaining procurement request.').slice(0,500);row.status=hasAccepted?'partially_ordered':'cancelled';row.timeline.push({type:hasAccepted?'remainder_cancelled':'cancelled',message:row.closeReason,actorUserId:actor._id});await row.save({session});cancelled=row;
  });return cancelled;}finally{await session.endSession();}
}

export async function createProcurementTemplate(actor,input){const {organization,membership}=await businessContext(actor,{create:true});requireBusinessCapability(membership,'templates');const checked=await validateItems(organization,input.items);let nextDueAt=null;if(input.recurrence==='weekly')nextDueAt=new Date(Date.now()+7*86400000);if(input.recurrence==='monthly')nextDueAt=new Date(Date.now()+30*86400000);return ProcurementTemplate.create({publicId:publicId('ptpl'),organizationId:organization._id,name:String(input.name).trim().slice(0,140),items:checked.items.map(x=>({productPublicId:x.productPublicId,variantPublicId:x.variantPublicId,quantity:x.quantity})),recurrence:input.recurrence||'none',nextDueAt,createdByUserId:actor._id});}

export async function processRecurringProcurement(now=new Date()){
  const due=await ProcurementTemplate.find({active:true,recurrence:{$in:['weekly','monthly']},nextDueAt:{$lte:now}}).sort({nextDueAt:1}).limit(100);
  let created=0,failed=0,skipped=0;
  for(const snapshot of due){
    const session=await mongoose.startSession();
    try{
      await session.withTransaction(async()=>{
        const tpl=await ProcurementTemplate.findOne({_id:snapshot._id,active:true,nextDueAt:{$lte:now}}).session(session);
        if(!tpl){skipped++;return;}
        const scheduledFor=new Date(tpl.nextDueAt);
        let run;
        try{[run]=await ProcurementRun.create([{publicId:publicId('prun'),templateId:tpl._id,templatePublicId:tpl.publicId,organizationId:tpl.organizationId,scheduledFor,status:'processing'}],{session});}
        catch(error){if(error?.code===11000){skipped++;return;}throw error;}
        const org=await BusinessOrganization.findById(tpl.organizationId).session(session);
        if(!org||org.status==='suspended'){
          run.status='failed';run.errorMessage='Organization unavailable or suspended.';run.completedAt=new Date();await run.save({session});failed++;
        }else{
          try{
            const checked=await validateItems(org,tpl.items);
            const tax=await businessTaxSnapshot(org.country,session);const estimatedTaxMinor=taxFromSubtotal(checked.total,tax.taxBps);const estimatedTotalMinor=checked.total+estimatedTaxMinor;
            const [request]=await ProcurementRequest.create([{publicId:publicId('preq'),organizationId:org._id,requesterUserId:tpl.createdByUserId,title:`Recurring: ${tpl.name}`,items:checked.items,estimatedSubtotalMinor:checked.total,taxBps:tax.taxBps,estimatedTaxMinor,taxPolicyVersion:tax.taxPolicyVersion,estimatedTotalMinor,currency:org.currency,status:'submitted',timeline:[{type:'recurring.submitted',message:`Recurring procurement template ${tpl.name} became due and requires approval with ${tax.taxBps} bps country tax snapshot.`,actorUserId:tpl.createdByUserId}]}],{session});
            run.status='completed';run.procurementRequestId=request._id;run.procurementRequestPublicId=request.publicId;run.completedAt=new Date();await run.save({session});created++;
          }catch(error){run.status='failed';run.errorMessage=String(error.message||error).slice(0,1000);run.completedAt=new Date();await run.save({session});failed++;}
        }
        const periodDays=tpl.recurrence==='weekly'?7:30;let next=new Date(scheduledFor.getTime()+periodDays*86400000);while(next<=now)next=new Date(next.getTime()+periodDays*86400000);tpl.nextDueAt=next;await tpl.save({session});
      });
    }finally{await session.endSession();}
  }
  return {checked:due.length,created,failed,skipped};
}

export async function businessWorkspace(actor,paging={}){
  const {organization,membership,taxId,availableOrganizations}=await businessProfileView(actor),size=50;
  const page=async(Model,base,cursor,{populate=null}={})=>{let q=Model.find(cursorScope(base,cursor)).sort(cursorSort()).limit(size+1);if(populate)q=q.populate(...populate);const [rows,total]=await Promise.all([q.lean(),Model.countDocuments(base)]);return pageResult(rows,{limit:size,total});};
  const requestBase={organizationId:organization._id},quoteBase={organizationId:organization._id},poBase={organizationId:organization._id},invoiceBase={organizationId:organization._id};
  const quoteTargetBase={organizationId:organization._id,status:{$in:['approved','partially_ordered']},closedAt:null};
  const [members,budgets,requestPage,quotePage,poPage,invoicePage,templates,catalogue,quoteTargetRequestPage]=await Promise.all([
    BusinessMember.find({organizationId:organization._id,status:{$ne:'revoked'}}).populate('userId','name email').sort({createdAt:1}).lean(),
    BusinessBudget.find({organizationId:organization._id}).sort({createdAt:-1}).lean(),
    page(ProcurementRequest,requestBase,paging.requestsAfter,{populate:['requesterUserId','name']}),
    page(QuoteRequest,quoteBase,paging.quotesAfter,{populate:['storeId','name slug']}),
    page(PurchaseOrder,poBase,paging.purchaseOrdersAfter,{populate:['storeId','name']}),
    page(BusinessInvoice,invoiceBase,paging.invoicesAfter,{populate:['storeId','name']}),
    ProcurementTemplate.find({organizationId:organization._id,active:true}).sort({createdAt:-1}).lean(),
    businessCatalogue(organization,{search:paging.catalogQ,after:paging.catalogAfter}),
    page(ProcurementRequest,quoteTargetBase,paging.quoteTargetsAfter),
  ]);
  const requests=requestPage.items,quotes=quotePage.items,pos=poPage.items,invoices=invoicePage.items;
  const productOptions=catalogue.items.map(row=>({variantPublicId:row.publicId,sku:row.sku,variantTitle:row.title,priceMinor:row.priceMinor,currency:row.currency,productPublicId:row.productPublicId,title:row.productTitle,storeName:row.storeName,storePublicId:row.storePublicId}));
  // Quote targets are derived only from approved immutable SKU lines. They page independently
  // from the general request history so an older approved request never disappears merely
  // because the buyer is looking at a different procurement-history page.
  const quoteTargets=await quoteTargetsForRequests(quoteTargetRequestPage.items);

  // Audit history must be scoped to the whole organization, not merely the current visible pages.
  const [memberIds,budgetIds,requestIds,quoteIds,poIds,invoiceIds,templateIds]=await Promise.all([
    BusinessMember.distinct('publicId',{organizationId:organization._id}),BusinessBudget.distinct('publicId',{organizationId:organization._id}),
    ProcurementRequest.distinct('publicId',{organizationId:organization._id}),QuoteRequest.distinct('publicId',{organizationId:organization._id}),
    PurchaseOrder.distinct('publicId',{organizationId:organization._id}),BusinessInvoice.distinct('publicId',{organizationId:organization._id}),ProcurementTemplate.distinct('publicId',{organizationId:organization._id}),
  ]);
  const targetIds=[organization.publicId,...memberIds,...budgetIds,...requestIds,...quoteIds,...poIds,...invoiceIds,...templateIds];
  const auditBase=targetIds.length?{targetPublicId:{$in:targetIds}}:{_id:{$in:[]}};
  const auditRows=targetIds.length?await AuditLog.find(cursorScope(auditBase,paging.auditAfter)).populate('actorUserId','name email').sort(cursorSort()).limit(size+1).lean():[];
  const auditTotal=targetIds.length?await AuditLog.countDocuments(auditBase):0;
  const auditPage=pageResult(auditRows,{limit:size,total:auditTotal});
  const documents=await businessDocumentHistory(organization._id,{businessAfter:paging.businessDocumentsAfter,financialAfter:paging.financialDocumentsAfter,limit:size});
  return {organization:organization.toObject(),membership:membership.toObject(),availableOrganizations,taxId,members,budgets,requests,quotes,purchaseOrders:pos,invoices,templates,auditHistory:auditPage.items,productOptions,quoteTargets,catalogueSearch:catalogue.search,documents,queuePages:{requests:requestPage.page,quotes:quotePage.page,purchaseOrders:poPage.page,invoices:invoicePage.page,audit:auditPage.page,catalogue:catalogue.page,quoteTargets:quoteTargetRequestPage.page,businessDocuments:documents.pages.business,financialDocuments:documents.pages.financial}};
}
export async function businessStatement(actor){const {organization}=await businessContext(actor);const rows=await PurchaseOrder.find({organizationId:organization._id}).sort({createdAt:-1}).lean();if(!rows.length)return[];const invoices=await BusinessInvoice.find({organizationId:organization._id,purchaseOrderId:{$in:rows.map(row=>row._id)}}).select('purchaseOrderId invoiceNumber status dueAt paidMinor totalMinor').lean();const invoiceByPo=new Map(invoices.map(row=>[String(row.purchaseOrderId),row]));const now=Date.now();return rows.map(row=>{const invoice=invoiceByPo.get(String(row._id));const outstandingMinor=invoice?Math.max(0,Number(invoice.totalMinor||0)-Number(invoice.paidMinor||0)):0;let aging='not_due';if(invoice?.status==='paid')aging='paid';else if(invoice?.dueAt){const days=Math.max(0,Math.floor((now-new Date(invoice.dueAt).getTime())/86400000));aging=days<=0?'not_due':days<=30?'1-30':days<=60?'31-60':days<=90?'61-90':'90+';}return{...row,invoiceNumber:invoice?.invoiceNumber||'',invoiceStatus:invoice?.status||'',dueAt:invoice?.dueAt||null,outstandingMinor,aging};});}

import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { normalizeEmail } from '../core/crypto.js';
import { encryptSensitive, decryptSensitive } from '../core/sensitive.js';
import { remainingProcurementItems, remainingApprovedMinor } from '../core/procurement.js';
import {
  AuditLog, BusinessOrganization, BusinessMember, BusinessBudget, ProcurementRequest,
  QuoteRequest, PurchaseOrder, ProcurementTemplate, Product, ProductVariant,
  Store, User,
} from '../models/index.js';


export function parseProcurementCsv(source){
  const lines=String(source||'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  if(lines.length<2)throw new AppError('CSV needs a header and at least one procurement row.',422,'PROCUREMENT_CSV_EMPTY');
  if(lines.length>501)throw new AppError('Import at most 500 procurement rows at a time.',422,'PROCUREMENT_CSV_TOO_LARGE');
  const parseLine=(line)=>{const cells=[];let current='',quoted=false;for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'&&line[i+1]==='"'&&quoted){current+='"';i++;}else if(ch==='"')quoted=!quoted;else if(ch===','&&!quoted){cells.push(current.trim());current='';}else current+=ch;}if(quoted)throw new AppError('CSV contains an unclosed quote.',422,'PROCUREMENT_CSV_INVALID');cells.push(current.trim());return cells;};
  const header=parseLine(lines[0]).map(x=>x.toLowerCase());const expected=['productpublicid','quantity','note'];if(expected.some((x,i)=>header[i]!==x))throw new AppError('CSV header must be: productPublicId,quantity,note',422,'PROCUREMENT_CSV_HEADER');
  return lines.slice(1).map((line,index)=>{const [productPublicId,quantityRaw,note='']=parseLine(line);const quantity=Number(quantityRaw);if(!productPublicId||productPublicId.length>100||!Number.isInteger(quantity)||quantity<1||quantity>9999||note.length>300)throw new AppError(`Invalid procurement CSV row ${index+2}.`,422,'PROCUREMENT_CSV_ROW');return{productPublicId,quantity,note};});
}

async function ensureOwnerMembership(org,user){
  return BusinessMember.findOneAndUpdate({organizationId:org._id,userId:user._id},{$set:{role:'owner',status:'active',canApprove:true,acceptedAt:org.createdAt||new Date()},$setOnInsert:{publicId:publicId('bmem'),invitedByUserId:user._id,invitedAt:org.createdAt||new Date()}},{upsert:true,returnDocument:'after',setDefaultsOnInsert:true});
}
export async function businessContext(user,{create=false}={}){
  let org=await BusinessOrganization.findOne({ownerUserId:user._id});
  if(org)return {organization:org,membership:await ensureOwnerMembership(org,user)};
  const member=await BusinessMember.findOne({userId:user._id,status:'active'}).sort({acceptedAt:1});
  if(member){org=await BusinessOrganization.findById(member.organizationId);if(org&&org.status!=='suspended')return {organization:org,membership:member};}
  if(!create||user.role!=='business')throw new AppError('You are not an active member of a business purchasing organization.',403,'BUSINESS_ACCESS_REQUIRED');
  org=await BusinessOrganization.create({publicId:publicId('borg'),ownerUserId:user._id,companyName:user.roleProfile?.businessName||`${user.name} Business`,country:user.country,currency:user.currency,billingEmail:user.email,status:'active'});
  return {organization:org,membership:await ensureOwnerMembership(org,user)};
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
  if(input.taxId!==undefined)organization.taxIdEncrypted=encryptSensitive(String(input.taxId||'').trim().slice(0,120));
  await organization.save();return organization;
}
export async function businessProfileView(user){const {organization,membership}=await businessContext(user,{create:true});let taxId='';try{if(organization.taxIdEncrypted)taxId=decryptSensitive(organization.taxIdEncrypted);}catch{}return {organization,membership,taxId};}
export async function inviteBusinessMember(actor,input){const {organization,membership}=await businessContext(actor,{create:true});requireBusinessCapability(membership,'members');const user=await User.findOne({emailNormalized:normalizeEmail(input.email),status:'active'});if(!user)throw new AppError('Invitee must already have an active Classic Mart account.',404,'BUSINESS_INVITEE_NOT_FOUND');if(user._id.equals(actor._id))throw new AppError('You are already a member.',409,'BUSINESS_MEMBER_EXISTS');return BusinessMember.findOneAndUpdate({organizationId:organization._id,userId:user._id},{$set:{role:input.role,status:'invited',spendingLimitMinor:Math.max(0,Number(input.spendingLimitMinor||0)),canApprove:Boolean(input.canApprove),invitedByUserId:actor._id,invitedAt:new Date(),acceptedAt:null,revokedAt:null},$setOnInsert:{publicId:publicId('bmem')}},{upsert:true,returnDocument:'after',setDefaultsOnInsert:true});}
export async function acceptBusinessInvite(user,memberId){const row=await BusinessMember.findOne({publicId:memberId,userId:user._id,status:'invited'});if(!row)throw new AppError('Business invitation not found.',404,'BUSINESS_INVITE_NOT_FOUND');row.status='active';row.acceptedAt=new Date();await row.save();return row;}
export async function createBudget(actor,input){const {organization,membership}=await businessContext(actor,{create:true});requireBusinessCapability(membership,'budgets');const start=new Date(input.periodStart),end=new Date(input.periodEnd);if(!(end>start))throw new AppError('Budget period end must be after its start.',422,'BUDGET_PERIOD_INVALID');return BusinessBudget.create({publicId:publicId('bbud'),organizationId:organization._id,name:input.name,currency:organization.currency,limitMinor:Number(input.limitMinor),periodStart:start,periodEnd:end,createdByUserId:actor._id});}
async function validateItems(org,items){const ids=[...new Set(items.map(x=>x.productPublicId))];const products=await Product.find({publicId:mongoose.trusted({$in:ids}),status:'published',countries:org.country}).lean();const map=new Map(products.map(x=>[x.publicId,x]));let total=0;const normalized=[];for(const raw of items){const product=map.get(raw.productPublicId);if(!product)throw new AppError(`Product ${raw.productPublicId} is unavailable.`,409,'PROCUREMENT_PRODUCT_UNAVAILABLE');const variant=await ProductVariant.findOne({productId:product._id,active:true}).sort({priceMinor:1}).lean();if(!variant||variant.currency!==org.currency)throw new AppError(`Product ${raw.productPublicId} has no compatible sellable variant.`,409,'PROCUREMENT_VARIANT_UNAVAILABLE');const quantity=Math.max(1,Math.min(9999,Number(raw.quantity||1)));total+=variant.priceMinor*quantity;normalized.push({productPublicId:product.publicId,quantity,estimatedUnitMinor:variant.priceMinor,note:String(raw.note||'').slice(0,300)});}return {items:normalized,total};}
export async function createProcurementRequest(actor,input){const {organization,membership}=await businessContext(actor,{create:true});requireBusinessCapability(membership,'buy');const checked=await validateItems(organization,input.items);if(membership.spendingLimitMinor>0&&checked.total>membership.spendingLimitMinor)throw new AppError('Request exceeds your personal spending limit.',403,'SPENDING_LIMIT_EXCEEDED');let budget=null;if(input.budgetId){budget=await BusinessBudget.findOne({publicId:input.budgetId,organizationId:organization._id,active:true,periodStart:{$lte:new Date()},periodEnd:{$gte:new Date()}});if(!budget)throw new AppError('Budget not found.',404,'BUDGET_NOT_FOUND');if(Number(budget.spentMinor||0)+budget.committedMinor+checked.total>budget.limitMinor)throw new AppError('Request exceeds the selected business budget.',409,'BUDGET_EXCEEDED');}
 const row=await ProcurementRequest.create({publicId:publicId('preq'),organizationId:organization._id,requesterUserId:actor._id,budgetId:budget?._id,title:String(input.title).trim().slice(0,160),items:checked.items,estimatedTotalMinor:checked.total,currency:organization.currency,status:'submitted',timeline:[{type:'submitted',message:'Procurement request submitted for approval.',actorUserId:actor._id}]});return row;}
export async function decideProcurementRequest(actor,id,{approve,reason=''}){
  const {organization,membership}=await businessContext(actor);requireBusinessCapability(membership,'approve');
  const session=await mongoose.startSession();let decided;
  try{await session.withTransaction(async()=>{const row=await ProcurementRequest.findOne({publicId:id,organizationId:organization._id,status:'submitted'}).session(session);if(!row)throw new AppError('Pending procurement request not found.',404,'PROCUREMENT_REQUEST_NOT_FOUND');if(row.requesterUserId.equals(actor._id))throw new AppError('A different approver must decide this request.',403,'FOUR_EYES_REQUIRED');if(!approve){row.status='rejected';row.rejectedAt=new Date();row.rejectionReason=String(reason).slice(0,500);row.timeline.push({type:'rejected',message:row.rejectionReason||'Procurement request rejected.',actorUserId:actor._id});await row.save({session});decided=row;return;}if(row.budgetId){const budget=await BusinessBudget.findOneAndUpdate({_id:row.budgetId,organizationId:organization._id,active:true,periodStart:{$lte:new Date()},periodEnd:{$gte:new Date()},$expr:{$lte:[{$add:[{$ifNull:['$spentMinor',0]},'$committedMinor',row.estimatedTotalMinor]},'$limitMinor']}},{$inc:{committedMinor:row.estimatedTotalMinor}},{session,returnDocument:'after'});if(!budget)throw new AppError('Budget no longer has enough available capacity.',409,'BUDGET_EXCEEDED');}row.status='approved';row.approvedByUserId=actor._id;row.approvedAt=new Date();row.timeline.push({type:'approved',message:'Procurement request approved.',actorUserId:actor._id});await row.save({session});decided=row;});return decided;}finally{await session.endSession();}
}
async function procurementCoverage(procurementId,session=null){
  let query=PurchaseOrder.find({procurementRequestId:procurementId,status:{$in:['accepted','fulfilled']}}).select('items').lean();if(session)query=query.session(session);const rows=await query;const covered=new Map();for(const po of rows)for(const item of po.items)covered.set(item.productPublicId,(covered.get(item.productPublicId)||0)+Number(item.quantity||0));return covered;
}
export async function createQuoteRequest(actor,input){
  const {organization,membership}=await businessContext(actor,{create:true});requireBusinessCapability(membership,'quotes');
  const approved=await ProcurementRequest.findOne({publicId:input.procurementRequestId,organizationId:organization._id,status:{$in:['approved','partially_ordered']},closedAt:null}).lean();
  if(!approved)throw new AppError('Select an open approved procurement request before requesting a seller quotation.',409,'PROCUREMENT_APPROVAL_REQUIRED');
  const store=await Store.findOne({publicId:input.storeId,status:'verified',country:organization.country});if(!store)throw new AppError('Verified seller store not found in your country.',404,'QUOTE_STORE_NOT_FOUND');
  const existing=await QuoteRequest.exists({organizationId:organization._id,procurementRequestId:approved._id,storeId:store._id,status:{$in:['requested','negotiating','responded','accepted']}});if(existing)throw new AppError('This seller already has an active quotation for that procurement request.',409,'QUOTE_ALREADY_ACTIVE');
  const covered=await procurementCoverage(approved._id);const remaining=remainingProcurementItems(approved.items,covered);const requestedIds=[...new Set(remaining.map(x=>x.productPublicId))];
  const products=requestedIds.length?await Product.find({publicId:{$in:requestedIds},storeId:store._id,status:'published',countries:organization.country}).lean():[];
  if(!products.length)throw new AppError('That seller has no remaining approved items in this procurement request.',422,'QUOTE_ITEM_STORE_MISMATCH');
  const pmap=new Map(products.map(p=>[p.publicId,p]));const items=[];let approvedAmountMinor=0;
  for(const item of remaining){const product=pmap.get(item.productPublicId);if(!product)continue;const variant=await ProductVariant.findOne({productId:product._id,active:true}).sort({priceMinor:1}).lean();if(!variant||variant.currency!==organization.currency)throw new AppError(`Product ${item.productPublicId} has no compatible sellable variant.`,409,'PROCUREMENT_VARIANT_UNAVAILABLE');const snapshotUnit=Math.max(0,Number(item.estimatedUnitMinor||0));items.push({productPublicId:item.productPublicId,quantity:item.quantity,requestedUnitMinor:snapshotUnit});approvedAmountMinor+=snapshotUnit*item.quantity;}
  if(!items.length||approvedAmountMinor<=0)throw new AppError('No remaining approved amount is available for that seller.',409,'QUOTE_APPROVED_AMOUNT_EMPTY');
  return QuoteRequest.create({publicId:publicId('qte'),organizationId:organization._id,procurementRequestId:approved._id,requesterUserId:actor._id,storeId:store._id,storePublicId:store.publicId,country:organization.country,currency:organization.currency,approvedAmountMinor,items,status:'requested',messages:[{actorType:'buyer',actorUserId:actor._id,message:String(input.message||'Please provide a quotation.').slice(0,2000)}]});
}
export async function businessReplyQuote(actor,id,message){const {organization,membership}=await businessContext(actor);requireBusinessCapability(membership,'quotes');const quote=await QuoteRequest.findOne({publicId:id,organizationId:organization._id,status:{$in:['requested','responded','negotiating']}});if(!quote)throw new AppError('Active quotation not found.',404,'QUOTE_NOT_FOUND');quote.messages.push({actorType:'buyer',actorUserId:actor._id,message:String(message).trim().slice(0,2000)});quote.status='negotiating';await quote.save();return quote;}
export async function acceptQuote(actor,id){
  const {organization,membership}=await businessContext(actor);requireBusinessCapability(membership,'po');
  if(!organization.invoiceTermsApproved)throw new AppError('Purchase-order invoice terms require administrator risk approval before accepting the quotation.',409,'INVOICE_TERMS_NOT_APPROVED');
  const session=await mongoose.startSession();let created;
  try{await session.withTransaction(async()=>{
    const quote=await QuoteRequest.findOne({publicId:id,organizationId:organization._id,status:{$in:['responded','negotiating']}}).session(session);
    if(!quote||!quote.offeredTotalMinor)throw new AppError('Seller quotation is not ready for acceptance.',409,'QUOTE_NOT_READY');
    const procurement=await ProcurementRequest.findOne({_id:quote.procurementRequestId,organizationId:organization._id,status:{$in:['approved','partially_ordered']},closedAt:null}).session(session);
    if(!procurement)throw new AppError('The procurement approval is no longer valid.',409,'PROCUREMENT_APPROVAL_REQUIRED');
    if(quote.offeredTotalMinor>quote.approvedAmountMinor)throw new AppError('Seller quotation exceeds the approved amount for this seller and requires a new procurement approval.',409,'QUOTE_EXCEEDS_APPROVAL');
    const products=await Product.find({publicId:{$in:quote.items.map(x=>x.productPublicId)},storeId:quote.storeId,status:'published'}).session(session).lean();const pmap=new Map(products.map(p=>[p.publicId,p]));
    const totalQty=quote.items.reduce((sum,item)=>sum+item.quantity,0);const baseUnit=Math.floor(quote.offeredTotalMinor/Math.max(1,totalQty));let allocated=0;const items=[];
    for(let index=0;index<quote.items.length;index++){const q=quote.items[index],p=pmap.get(q.productPublicId);if(!p)throw new AppError('Quoted product is no longer available.',409,'QUOTE_PRODUCT_UNAVAILABLE');const line=index===quote.items.length-1?quote.offeredTotalMinor-allocated:baseUnit*q.quantity;allocated+=line;const unit=Math.floor(line/q.quantity);items.push({productPublicId:q.productPublicId,quantity:q.quantity,unitMinor:unit,lineMinor:line});}
    quote.status='accepted';quote.acceptedAt=new Date();await quote.save({session});
    const [po]=await PurchaseOrder.create([{publicId:publicId('po'),poNumber:`CM-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`,organizationId:organization._id,quoteRequestId:quote._id,procurementRequestId:procurement._id,storeId:quote.storeId,storePublicId:quote.storePublicId,issuedByUserId:actor._id,country:organization.country,currency:organization.currency,items,approvedAmountMinor:quote.approvedAmountMinor,totalMinor:quote.offeredTotalMinor,invoiceTermsDays:organization.invoiceTermsDays,status:'issued',timeline:[{type:'issued',message:'Purchase order issued from an approved procurement request and accepted seller quotation.',actorUserId:actor._id}]}],{session});created=po;
  });return created;}finally{await session.endSession();}
}

export async function cancelProcurementRequest(actor,id,{reason=''}={}){
  const {organization,membership}=await businessContext(actor);requireBusinessCapability(membership,'buy');const session=await mongoose.startSession();let cancelled;
  try{await session.withTransaction(async()=>{
    const row=await ProcurementRequest.findOne({publicId:id,organizationId:organization._id,status:{$in:['submitted','approved','partially_ordered']},closedAt:null}).session(session);if(!row)throw new AppError('Cancellable procurement request not found.',404,'PROCUREMENT_REQUEST_NOT_FOUND');
    const covered=await procurementCoverage(row._id,session);const releaseMinor=remainingApprovedMinor(row.items,covered);const hasAccepted=covered.size>0;
    if(hasAccepted&&releaseMinor<=0)throw new AppError('All approved quantities already have accepted purchase orders.',409,'PROCUREMENT_ALREADY_COMMITTED');
    await PurchaseOrder.updateMany({procurementRequestId:row._id,status:'issued'},{$set:{status:'cancelled'},$push:{timeline:{type:'buyer.cancelled',message:'Buyer cancelled the remaining procurement request.',actorUserId:actor._id}}},{session});
    await QuoteRequest.updateMany({procurementRequestId:row._id,status:{$in:['requested','negotiating','responded','accepted']}},{$set:{status:'rejected'}},{session});
    if(row.status!=='submitted'&&row.budgetId&&releaseMinor>0){const budget=await BusinessBudget.findOneAndUpdate({_id:row.budgetId,organizationId:organization._id,committedMinor:{$gte:releaseMinor}},{$inc:{committedMinor:-releaseMinor}},{session,returnDocument:'after'});if(!budget)throw new AppError('Committed budget could not be released safely.',409,'BUDGET_RELEASE_CONFLICT');}
    row.closedAt=new Date();row.closeReason=String(reason||'Buyer cancelled the remaining procurement request.').slice(0,500);row.status=hasAccepted?'partially_ordered':'cancelled';row.timeline.push({type:hasAccepted?'remainder_cancelled':'cancelled',message:row.closeReason,actorUserId:actor._id});await row.save({session});cancelled=row;
  });return cancelled;}finally{await session.endSession();}
}

export async function createProcurementTemplate(actor,input){const {organization,membership}=await businessContext(actor,{create:true});requireBusinessCapability(membership,'templates');const checked=await validateItems(organization,input.items);let nextDueAt=null;if(input.recurrence==='weekly')nextDueAt=new Date(Date.now()+7*86400000);if(input.recurrence==='monthly')nextDueAt=new Date(Date.now()+30*86400000);return ProcurementTemplate.create({publicId:publicId('ptpl'),organizationId:organization._id,name:String(input.name).trim().slice(0,140),items:checked.items.map(x=>({productPublicId:x.productPublicId,quantity:x.quantity})),recurrence:input.recurrence||'none',nextDueAt,createdByUserId:actor._id});}

export async function processRecurringProcurement(now=new Date()){
  const due=await ProcurementTemplate.find({active:true,recurrence:{$in:['weekly','monthly']},nextDueAt:{$lte:now}}).limit(100);
  let created=0;
  for(const tpl of due){
    const org=await BusinessOrganization.findById(tpl.organizationId);if(!org||org.status==='suspended')continue;
    const existing=await ProcurementRequest.exists({organizationId:org._id,title:`Recurring: ${tpl.name}`,createdAt:{$gte:new Date(now.getTime()-24*60*60*1000)},status:{$in:['submitted','approved']}});
    if(!existing){const checked=await validateItems(org,tpl.items);await ProcurementRequest.create({publicId:publicId('preq'),organizationId:org._id,requesterUserId:tpl.createdByUserId,title:`Recurring: ${tpl.name}`,items:checked.items,estimatedTotalMinor:checked.total,currency:org.currency,status:'submitted',timeline:[{type:'recurring.submitted',message:`Recurring procurement template ${tpl.name} became due and requires approval.`,actorUserId:tpl.createdByUserId}]});created++;}
    tpl.nextDueAt=new Date(now.getTime()+(tpl.recurrence==='weekly'?7:30)*86400000);await tpl.save();
  }
  return created;
}

export async function businessWorkspace(actor){
  const {organization,membership,taxId}=await businessProfileView(actor);
  const [members,budgets,requests,quotes,pos,templates,catalogProducts,sellerStores]=await Promise.all([
    BusinessMember.find({organizationId:organization._id,status:{$ne:'revoked'}}).populate('userId','name email').sort({createdAt:1}).lean(),
    BusinessBudget.find({organizationId:organization._id}).sort({createdAt:-1}).lean(),
    ProcurementRequest.find({organizationId:organization._id}).populate('requesterUserId','name').sort({createdAt:-1}).limit(100).lean(),
    QuoteRequest.find({organizationId:organization._id}).populate('storeId','name slug').sort({createdAt:-1}).limit(100).lean(),
    PurchaseOrder.find({organizationId:organization._id}).populate('storeId','name').sort({createdAt:-1}).limit(100).lean(),
    ProcurementTemplate.find({organizationId:organization._id,active:true}).sort({createdAt:-1}).lean(),
    Product.find({status:'published',countries:organization.country}).select('publicId title storeId').sort({title:1}).limit(250).lean(),
    Store.find({status:'verified',country:organization.country}).select('publicId name slug').sort({name:1}).limit(200).lean(),
  ]);
  const sellableProductIds=new Set((await ProductVariant.find({productId:mongoose.trusted({$in:catalogProducts.map(product=>product._id)}),active:true,currency:organization.currency}).distinct('productId')).map(String));
  const eligibleProducts=catalogProducts.filter(product=>sellableProductIds.has(String(product._id)));
  const eligibleStoreIds=new Set(eligibleProducts.map(product=>String(product.storeId)));
  const eligibleStores=sellerStores.filter(store=>eligibleStoreIds.has(String(store._id)));
  const storeNameById=new Map(eligibleStores.map(store=>[String(store._id),store.name]));
  const productOptions=eligibleProducts.map(product=>({...product,storeName:storeNameById.get(String(product.storeId))||'Verified seller'}));
  const targetIds=[organization.publicId,...members.map(x=>x.publicId),...budgets.map(x=>x.publicId),...requests.map(x=>x.publicId),...quotes.map(x=>x.publicId),...pos.map(x=>x.publicId),...templates.map(x=>x.publicId)];
  const auditHistory=targetIds.length?await AuditLog.find({targetPublicId:{$in:targetIds}}).populate('actorUserId','name email').sort({createdAt:-1}).limit(100).lean():[];
  return {organization:organization.toObject(),membership:membership.toObject(),taxId,members,budgets,requests,quotes,purchaseOrders:pos,templates,auditHistory,productOptions,sellerStores:eligibleStores};
}
export async function businessStatement(actor){const {organization}=await businessContext(actor);const rows=await PurchaseOrder.find({organizationId:organization._id}).sort({createdAt:-1}).lean();return rows;}

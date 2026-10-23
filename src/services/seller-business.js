import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { BusinessDocument, BusinessOrganization, ProcurementRequest, PurchaseOrder, QuoteRequest, SellerOrder } from '../models/index.js';
import { assertBusinessVersion, businessApprovedAmount, businessCoverage, businessInput, validateBusinessItems } from './business-operations.js';
import { businessCommercialPolicy } from './business-policy.js';
import { businessSame, fenceBusinessRecord } from './business-access.js';
import { sellerBusinessAccess } from './seller-business-access.js';
import { writeAudit } from './audit.js';
import { issueQuotationDocument } from './business-documents.js';
import { acceptPurchaseOrderIntoCommerce } from './business-fulfillment.js';
import { cursorScope, cursorSort, pageResult } from './pagination.js';

async function transaction(request,operation){const session=await mongoose.startSession();try{let result;await session.withTransaction(async()=>{const context=await sellerBusinessAccess(request,{session,write:true});result=await operation(context,session);});return result;}finally{await session.endSession();}}
async function audit(context,session,action,row){await writeAudit(context.request,action,{actor:context.actor,country:context.store.country,targetType:'business_supplier',targetPublicId:row.publicId,session});}
export async function respondSellerBusinessQuote(request,id,input){
  const data=businessInput(z.object({version:z.coerce.number().int().min(0),action:z.enum(['offer','decline']).default('offer'),message:z.string().trim().min(1).max(2000),offeredUnitMinor:z.array(z.coerce.number().int().min(0).max(10_000_000_000)).max(500).default([]),validUntil:z.coerce.date().optional()}).strict(),input);
  return transaction(request,async(context,session)=>{
    const row=await QuoteRequest.findOne({publicId:id,storeId:context.store._id,country:context.store.country,currency:context.store.currency,status:mongoose.trusted({$in:['requested','negotiating','responded']})}).session(session);
    if(!row)throw new AppError('Open supplier quotation not found.',404,'SELLER_BUSINESS_QUOTE_NOT_FOUND');assertBusinessVersion(row,data.version);
    const procurement=await ProcurementRequest.findOne({_id:row.procurementRequestId,organizationId:row.organizationId,status:mongoose.trusted({$in:['approved','partially_ordered']}),closedAt:null}).session(session);
    const org=procurement&&await BusinessOrganization.findOne({_id:row.organizationId,status:'active',country:context.store.country,currency:context.store.currency}).session(session);
    if(!procurement||!org||!procurement.approvedAt||businessSame(procurement.requesterUserId,procurement.approvedByUserId))throw new AppError('Independent buyer approval is no longer available.',409,'BUSINESS_APPROVAL_REQUIRED');
    const policy=businessCommercialPolicy(procurement.commercialPolicy),coverage=await businessCoverage(procurement,session);
    const approved=businessApprovedAmount(procurement,row.items,coverage.quantities);
    if(approved!==row.approvedAmountMinor)throw new AppError('The remaining buyer approval changed.',409,'BUSINESS_QUANTITY_EXCEEDED');
    if(data.action==='offer'){
      if(!data.validUntil||data.validUntil<=new Date()||data.validUntil>new Date(Date.now()+90*86400000)||data.offeredUnitMinor.length!==row.items.length)throw new AppError('Enter a price for every SKU and an expiry within 90 days.',422,'SELLER_BUSINESS_OFFER_INVALID');
      const current=await validateBusinessItems({...context,org},row.items,session);
      if(data.offeredUnitMinor.some((value,index)=>value<Math.max(1,current[index].minimumPriceMinor)))throw new AppError('Each offered price must respect the current published SKU minimum.',422,'SELLER_BUSINESS_OFFER_INVALID');
      let subtotal=0;for(const[index,line]of row.items.entries()){line.offeredUnitMinor=data.offeredUnitMinor[index];line.offeredLineMinor=line.quantity*line.offeredUnitMinor;if(!Number.isSafeInteger(line.offeredLineMinor))throw new AppError('The quotation amount is invalid.',422,'SELLER_BUSINESS_OFFER_INVALID');subtotal+=line.offeredLineMinor;}
      const total=subtotal+Math.floor(subtotal*policy.taxBps/10000);if(!Number.isSafeInteger(total)||total>10_000_000_000)throw new AppError('The quotation amount is invalid.',422,'SELLER_BUSINESS_OFFER_INVALID');
      row.offeredTotalMinor=total;row.validUntil=data.validUntil;row.status='responded';row.revision+=1;
    }else row.status='rejected';
    await fenceBusinessRecord(ProcurementRequest,procurement,session,{status:procurement.status,closedAt:null});
    await fenceBusinessRecord(BusinessOrganization,org,session,{status:'active',country:org.country,currency:org.currency});
    row.messages.push({actorType:'seller',actorUserId:context.actor._id,message:data.message,offeredTotalMinor:row.offeredTotalMinor});await row.save({session});
    if(data.action==='offer')await issueQuotationDocument(row,{session,issuedByUserId:context.actor._id});await audit(context,session,'seller.business.quote.'+data.action,row);return{publicId:row.publicId,version:row.__v,status:row.status};
  });
}
export async function decideSellerBusinessOrder(request,id,input){
  const data=businessInput(z.object({version:z.coerce.number().int().min(0),decision:z.enum(['accept','reject']),reason:z.string().trim().max(500).default('')}).strict(),input);
  if(data.decision==='accept'){const result=await acceptPurchaseOrderIntoCommerce({request,purchaseOrderPublicId:id,expectedVersion:data.version});return{publicId:result.po.publicId,status:result.po.status,version:result.po.__v};}
  return transaction(request,async(context,session)=>{const row=await PurchaseOrder.findOne({publicId:id,storeId:context.store._id,status:'issued'}).session(session);if(!row)throw new AppError('Issued purchase order not found.',404,'PURCHASE_ORDER_NOT_FOUND');assertBusinessVersion(row,data.version);row.status='rejected';row.timeline.push({type:'seller.rejected',message:data.reason||'Supplier declined the purchase order.',actorUserId:context.actor._id});await row.save({session});await QuoteRequest.updateOne({_id:row.quoteRequestId,status:'accepted'},{$set:{status:'rejected'},$inc:{__v:1}},{session});await audit(context,session,'seller.business.po.rejected',row);return{publicId:row.publicId,status:row.status,version:row.__v};});
}
export async function loadSellerBusinessPage(request,kind){
  if(!['quotes','orders'].includes(kind))throw new AppError('Supplier page not found.',404,'SELLER_BUSINESS_PAGE_NOT_FOUND');
  for(const value of Object.values(request.query||{}))if(typeof value!=='string')throw new AppError('Provide one value for each supplier filter.',422,'SELLER_BUSINESS_FILTER_INVALID');
  const context=await sellerBusinessAccess(request),Model=kind==='quotes'?QuoteRequest:PurchaseOrder;
  const search=typeof request.query?.search==='string'?request.query.search.trim().slice(0,100):'',after=typeof request.query?.after==='string'?request.query.after:'';
  const base={storeId:context.store._id,country:context.store.country,currency:context.store.currency,...(search?{publicId:mongoose.trusted({$regex:RegExp.escape(search),$options:'i'})}:{})};
  const [rows,total]=await Promise.all([Model.find(cursorScope(base,after)).sort(cursorSort()).limit(21).populate('organizationId','companyName publicId').lean(),Model.countDocuments(base)]);
  const result=pageResult(rows,{limit:20,total});
  const fulfilments=kind==='orders'?await SellerOrder.find({storeId:context.store._id,country:context.store.country,currency:context.store.currency,orderPublicId:mongoose.trusted({$in:result.items.map(row=>row.orderPublicId).filter(Boolean)})}).select('publicId orderPublicId').lean():[];
  const metrics=await Promise.all((kind==='quotes'?[['Awaiting offer',['requested','negotiating']],['Current offers',['responded']],['Accepted offers',['accepted']],['Closed offers',['rejected','expired']]]:[['Awaiting decision',['issued']],['Awaiting payment',['payment_pending']],['In fulfilment',['accepted','processing']],['Fulfilled',['fulfilled']]]).map(async([label,statuses])=>({label,value:await Model.countDocuments({storeId:context.store._id,country:context.store.country,currency:context.store.currency,status:mongoose.trusted({$in:statuses})}),detail:'Current store records'})));
  await sellerBusinessAccess(request);
  return{kind:'business-'+kind,baseHref:'/seller/business-'+kind,currency:context.store.currency,filters:{search,after},page:result.page,metrics,columns:['Reference','Business','Amount','Status'],rows:result.items.map(row=>({id:row.publicId,cells:[row.poNumber||row.publicId,row.organizationId?.companyName||'Business',new Intl.NumberFormat('en-GB',{style:'currency',currency:row.currency}).format(Number(row.totalMinor??row.offeredTotalMinor??0)/10**new Intl.NumberFormat('en',{style:'currency',currency:row.currency}).resolvedOptions().maximumFractionDigits),row.status],href:'#'+row.publicId})),records:result.items.map(row=>({...row,_id:undefined,organizationId:undefined,requesterUserId:undefined,issuedByUserId:undefined,sellerOrderPublicId:fulfilments.find(item=>item.orderPublicId===row.orderPublicId)?.publicId,companyName:row.organizationId?.companyName||'Business'})),tableTitle:kind==='quotes'?'Business quotations':'Business purchase orders',tableDescription:'Review the buyer’s exact approved SKUs and quantities.',insights:['Only your current store’s supplier records are shown.'],workflow:[{title:'Review request',text:'Check every SKU and quantity.'},{title:'Issue offer',text:'The buyer reviews the exact quotation before issuing a purchase order.'},{title:'Fulfil accepted order',text:'Accepted orders enter warehouse and delivery workflows.'}],health:{label:'Supplier operations',value:null,rows:[]}};
}
export async function sellerBusinessDocument(request,id){const context=await sellerBusinessAccess(request);const document=await BusinessDocument.findOne({publicId:id,storeId:context.store._id,country:context.store.country,currency:context.store.currency}).lean();if(!document)throw new AppError('Supplier document not found.',404,'BUSINESS_DOCUMENT_NOT_FOUND');await sellerBusinessAccess(request);return document;}

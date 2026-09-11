import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { decryptSensitive } from '../src/core/sensitive.js';
import { hashProofCode } from '../src/services/logistics.js';
import { allocateSellerLineSettlement, proportionalSettlementSlice } from '../src/services/money.js';
import { backfillFinancialDocuments } from '../src/services/financial-documents.js';
import { backfillBusinessDocuments } from '../src/services/business-documents.js';
import * as models from '../src/models/index.js';

const apply=process.argv.includes('--apply');
const platformRoles=new Set(['warehouse','support','moderator','finance','country_admin','super_admin']);
const supportQueueByCategory=Object.freeze({order:'orders',payment:'payments',delivery:'delivery',return:'returns',refund:'returns',account:'accounts',product:'general',seller:'seller',other:'general'});
function supportQueueForCategory(category){return supportQueueByCategory[String(category||'').toLowerCase()]||'general';}
function deterministicLineId(orderPublicId,index){return `ol_${crypto.createHash('sha256').update(`${orderPublicId}:${index}`).digest('hex').slice(0,24)}`;}
function deterministicPlatformGrantId(userId){return `pgr_mig_${crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0,22)}`;}
async function countPlatformGrantConflicts(){const rows=await models.PlatformGrant.aggregate([{$match:{status:'active'}},{$group:{_id:'$userId',count:{$sum:1}}},{$match:{count:{$gt:1}}},{$count:'count'}]);return Number(rows[0]?.count||0);}
async function countPrivilegedUsersMissingAuthoritativeGrant(now=new Date()){
  let missing=0;for await(const user of models.User.find({role:{$in:[...platformRoles]}}).select('_id platformAccessManagedAt').lean().cursor()){const active=await models.PlatformGrant.countDocuments({userId:user._id,status:'active',startsAt:{$lte:now},expiresAt:{$gt:now}});if(!user.platformAccessManagedAt||active!==1)missing+=1;}return missing;
}
async function countManagedPrivilegeMirrorWithoutGrant(now=new Date()){
  let broken=0;for await(const user of models.User.find({platformAccessManagedAt:{$exists:true},role:{$in:[...platformRoles]}}).select('_id').lean().cursor()){const active=await models.PlatformGrant.countDocuments({userId:user._id,status:'active',startsAt:{$lte:now},expiresAt:{$gt:now}});if(active!==1)broken+=1;}return broken;
}
async function countRefundCounterDrift(){
  const rows=await models.PaymentIntent.aggregate([
    {$lookup:{from:models.Refund.collection.name,localField:'_id',foreignField:'paymentIntentId',as:'refundRows'}},
    {$project:{
      amountMinor:{$ifNull:['$amountMinor',0]},
      reservedStored:{$ifNull:['$refundReservedMinor',0]},
      refundedStored:{$ifNull:['$refundedMinor',0]},
      reservedActual:{$sum:{$map:{input:{$filter:{input:'$refundRows',as:'r',cond:{$in:['$$r.status',['pending','processing']]}}},as:'r',in:{$ifNull:['$$r.amountMinor',0]}}}},
      refundedActual:{$sum:{$map:{input:{$filter:{input:'$refundRows',as:'r',cond:{$eq:['$$r.status','completed']}}},as:'r',in:{$ifNull:['$$r.amountMinor',0]}}}},
    }},
    {$match:{$expr:{$or:[{$ne:['$reservedStored','$reservedActual']},{$ne:['$refundedStored','$refundedActual']},{$gt:[{$add:['$reservedStored','$refundedStored']},'$amountMinor']},{$gt:[{$add:['$reservedActual','$refundedActual']},'$amountMinor']}]}}},
    {$count:'count'},
  ]);
  return Number(rows[0]?.count||0);
}

async function countSellerOrdersMissingSellerShipment(){
  const rows=await models.SellerOrder.aggregate([
    {$lookup:{from:models.SellerShipment.collection.name,localField:'_id',foreignField:'sellerOrderId',as:'sellerShipments'}},
    {$match:{sellerShipments:{$size:0}}},
    {$count:'count'},
  ]);
  return Number(rows[0]?.count||0);
}
async function countPlan(){
  const User=models.User,Order=models.Order,Survey=models.SatisfactionSurvey,Shipment=models.Shipment,SellerOrder=models.SellerOrder,WarehouseTask=models.WarehouseTask,ReturnRequest=models.ReturnRequest,SupportTicket=models.SupportTicket,Product=models.Product,Category=models.Category,PaymentIntent=models.PaymentIntent,CountrySetting=models.CountrySetting,ProcurementRequest=models.ProcurementRequest,PurchaseOrder=models.PurchaseOrder,BusinessInvoice=models.BusinessInvoice;
  const restrictedCategoryIds=await Category.find({restricted:true}).distinct('_id');
  const sellerPayoutAccountIds=await models.PayoutAccount.find({ownerType:'seller'}).distinct('_id');
  return {
    usersMissingShoppingCountry:await User.countDocuments({$or:[{shoppingCountry:{$exists:false}},{shoppingCountry:null},{shoppingCountry:''}]}),
    privilegedMissingOperationalGrants:await User.countDocuments({role:{$in:[...platformRoles]},$or:[{operationalCountries:{$exists:false}},{operationalCountries:{$size:0}}]}),
    privilegedUsersMissingAuthoritativeGrant:await countPrivilegedUsersMissingAuthoritativeGrant(),
    platformGrantConflicts:await countPlatformGrantConflicts(),
    ordersNeedingLineBackfill:await Order.countDocuments({items:{$elemMatch:{$or:[{linePublicId:{$exists:false}},{deliveredQuantity:{$exists:false}},{returnReservedQuantity:{$exists:false}},{returnedQuantity:{$exists:false}},{refundedQuantity:{$exists:false}}]}}}),
    ordersMissingLifecycleDimensions:await Order.countDocuments({$or:[{cancellationState:{$exists:false}},{returnState:{$exists:false}},{refundState:{$exists:false}},{paymentState:{$exists:false}},{fulfillmentState:{$exists:false}}]}),
    sellerOrdersMissingLineSettlement:await SellerOrder.countDocuments({items:{$elemMatch:{$or:[{orderLineId:{$exists:false}},{orderLineId:''},{grossMinor:{$exists:false}},{discountMinor:{$exists:false}},{customerPaidMinor:{$exists:false}},{platformFeeMinor:{$exists:false}},{sellerReceivableMinor:{$exists:false}}]}}}),
    surveysMissingCountry:await Survey.countDocuments({$or:[{country:{$exists:false}},{country:null},{country:''}]}),
    shipmentsWithEncryptedProof:await Shipment.countDocuments({$or:[{pickupCodeEncrypted:{$nin:[null,'']}},{deliveryCodeEncrypted:{$nin:[null,'']}}]}),
    warehouseTasksMissingDueAt:await WarehouseTask.countDocuments({$or:[{dueAt:{$exists:false}},{dueAt:null}]}),
    unboundOpenReturnInspectionTasks:await WarehouseTask.countDocuments({type:'return_inspection',status:{$in:['open','in_progress']},$or:[{returnRequestId:{$exists:false}},{returnRequestId:null},{returnOrderLineId:{$exists:false}},{returnOrderLineId:''}]}),
    receivedReturnsMissingWarehouseInspectionTasks:await ReturnRequest.countDocuments({status:'received',items:{$elemMatch:{$or:[{warehouseTaskPublicId:{$exists:false}},{warehouseTaskPublicId:''}]}}}),
    supportTicketsMissingQueue:await SupportTicket.countDocuments({$or:[{queue:{$exists:false}},{queue:null},{queue:''}]}),
    submittedProductsMissingModerationRisk:await Product.countDocuments({status:'submitted',$or:[{'moderation.riskLevel':{$exists:false}},{'moderation.riskLevel':{$nin:['standard','high']}},{categoryId:{$in:restrictedCategoryIds},'moderation.riskLevel':{$ne:'high'}},{categoryId:{$in:restrictedCategoryIds},'moderation.secondReviewRequired':{$ne:true}}]}),
    paymentIntentsMissingCountry:await PaymentIntent.countDocuments({$or:[{country:{$exists:false}},{country:null},{country:''}]}),
    paymentIntentsMissingRefundCounters:await PaymentIntent.countDocuments({$or:[{refundReservedMinor:{$exists:false}},{refundedMinor:{$exists:false}}]}),
    refundCounterDrift:await countRefundCounterDrift(),
    countrySettingsMissingDeliveryProofPolicy:await CountrySetting.countDocuments({$or:[{'delivery.requirePhotoForCod':{$exists:false}},{'delivery.requireSignatureForDelivery':{$exists:false}},{'delivery.requirePhotoForFailedAttempt':{$exists:false}}]}),
    shipmentsMissingDeliveryControls:await Shipment.countDocuments({$or:[{slaDueAt:{$exists:false}},{slaDueAt:null},{'proofPolicy.deliveryPhotoRequired':{$exists:false}},{'proofPolicy.signatureRequired':{$exists:false}},{'proofPolicy.failedAttemptPhotoRequired':{$exists:false}}]}),
    legacyDeliveredCodMissingHandoverEvidence:await Shipment.countDocuments({status:'delivered','cod.required':true,'cod.reconciledAt':null,$or:[{'cod.handoverAt':{$exists:false}},{'cod.handoverAt':null},{'cod.handoverEvidenceDocumentId':{$exists:false}},{'cod.handoverEvidenceDocumentId':null}]}),
    businessProcurementsMissingTaxSnapshot:await ProcurementRequest.countDocuments({$or:[{estimatedSubtotalMinor:{$exists:false}},{taxBps:{$exists:false}},{estimatedTaxMinor:{$exists:false}},{taxPolicyVersion:{$exists:false}}]}),
    businessPurchaseOrdersMissingTaxSnapshot:await PurchaseOrder.countDocuments({$or:[{subtotalMinor:{$exists:false}},{taxBps:{$exists:false}},{taxMinor:{$exists:false}},{taxPolicyVersion:{$exists:false}}]}),
    businessInvoicesMissingTaxSnapshot:await BusinessInvoice.countDocuments({$or:[{taxBps:{$exists:false}},{taxPolicyVersion:{$exists:false}}]}),
    businessOrdersMissingTaxSnapshot:await Order.countDocuments({businessOrganizationId:{$ne:null},$or:[{'policySnapshot.taxBps':{$exists:false}}]}),
    businessQuotesMissingRevision:await models.QuoteRequest.countDocuments({offeredTotalMinor:{$gt:0},$or:[{revision:{$exists:false}},{revision:{$lte:0}}]}),
    businessDocumentsExisting:await models.BusinessDocument.countDocuments({}),
    sellerReturnCasesMissingOperationalSnapshot:await models.SellerReturnCase.countDocuments({$or:[{slaDueAt:{$exists:false}},{slaDueAt:null},{items:{$elemMatch:{$or:[{sellerReceivableReversalMinor:{$exists:false}},{platformFeeReversalMinor:{$exists:false}}]}}}]}),
    sellerPayoutAccountsMissingStoreScope:await models.PayoutAccount.countDocuments({ownerType:'seller',$or:[{ownerStoreId:{$exists:false}},{ownerStoreId:null},{ownerStorePublicId:{$exists:false}},{ownerStorePublicId:''}]}),
    sellerPayoutsMissingStoreScope:await models.Payout.countDocuments({payoutAccountId:{$in:sellerPayoutAccountIds},$or:[{ownerStoreId:{$exists:false}},{ownerStoreId:null},{ownerStorePublicId:{$exists:false}},{ownerStorePublicId:''}]}),
    orderLinesMissingCostSnapshot:await Order.countDocuments({items:{$elemMatch:{$or:[{costSnapshotStatus:{$exists:false}},{costSnapshotStatus:{$nin:['captured','legacy_unknown']}}]}}}),
    sellerOrderLinesMissingCostSnapshot:await SellerOrder.countDocuments({items:{$elemMatch:{$or:[{costSnapshotStatus:{$exists:false}},{costSnapshotStatus:{$nin:['captured','legacy_unknown']}}]}}}),
    refundAllocationsMissingSkuSnapshot:await models.Refund.countDocuments({allocations:{$elemMatch:{orderLineId:{$nin:['',null]},$or:[{variantPublicId:{$exists:false}},{variantPublicId:''},{sku:{$exists:false}},{sku:''},{costSnapshotStatus:{$exists:false}},{costSnapshotStatus:{$nin:['captured','legacy_unknown']}}]}}}),
    sellerOrdersMissingSellerShipment:await countSellerOrdersMissingSellerShipment(),
  };
}
async function migrateUsers(){
  let changed=0;for await(const user of models.User.find({}).select('+operationalCountries country shoppingCountry role').cursor()){
    const set={};if(!user.shoppingCountry)set.shoppingCountry=user.country||'UG';
    const grants=Array.isArray(user.operationalCountries)?user.operationalCountries.filter(Boolean):[];
    if(platformRoles.has(user.role)&&!grants.length)set.operationalCountries=user.role==='super_admin'?['*']:[String(user.country||'UG').toUpperCase()];
    if(Object.keys(set).length){await models.User.collection.updateOne({_id:user._id},{$set:set});changed+=1;}
  }return changed;
}
async function migratePlatformGrants(){
  const now=new Date(),expiresAt=new Date(now.getTime()+180*86_400_000);let changed=0,failed=0,conflicts=0;
  await models.PlatformGrant.updateMany({status:'active',expiresAt:{$lte:now}},{$set:{status:'expired',statusReason:'Expired before PlatformGrant migration certification.'}});
  const sponsor=await models.User.findOne({role:'super_admin'}).select('_id').lean();
  for await(const user of models.User.find({role:{$in:[...platformRoles]}}).select('+operationalCountries role country platformAccessManagedAt').cursor()){
    const active=await models.PlatformGrant.find({userId:user._id,status:'active',startsAt:{$lte:now},expiresAt:{$gt:now}}).sort({createdAt:-1}).limit(2).lean();
    if(active.length>1){conflicts+=1;continue;}
    if(active.length===1){const grant=active[0];await models.User.collection.updateOne({_id:user._id},{$set:{platformAccessManagedAt:user.platformAccessManagedAt||now,role:grant.role,operationalCountries:grant.operationalCountries,country:grant.operationalCountries.includes('*')?String(user.country||'UG').toUpperCase():grant.operationalCountries[0]}});continue;}
    const countries=[...new Set((user.operationalCountries||[]).map(v=>String(v||'').trim().toUpperCase()).filter(Boolean))];if(!countries.length)countries.push(user.role==='super_admin'?'*':String(user.country||'UG').toUpperCase());
    if(user.role==='super_admin'){if(!countries.includes('*')){failed+=1;continue;}}else if(countries.includes('*')||countries.some(code=>!/^[A-Z]{2}$/.test(code))){failed+=1;continue;}
    if(user.role!=='super_admin'){const valid=await models.CountrySetting.countDocuments({code:{$in:countries}});if(valid!==countries.length){failed+=1;continue;}}
    const approverId=user.role==='super_admin'?user._id:sponsor?._id;if(!approverId){failed+=1;continue;}
    try{await models.PlatformGrant.create({publicId:deterministicPlatformGrantId(user._id),userId:user._id,role:user.role,operationalCountries:countries,warehouseScopes:[],capabilities:[],startsAt:now,expiresAt,status:'active',reason:'Legacy platform privilege migrated into an authoritative time-bounded PlatformGrant.',approvalPublicId:'migration-v2.13.25',approvedByUserId:approverId});await models.User.collection.updateOne({_id:user._id},{$set:{platformAccessManagedAt:now,operationalCountries:countries}});changed+=1;}catch(error){if(error?.code===11000){const existing=await models.PlatformGrant.findOne({userId:user._id,status:'active'}).lean();if(existing){await models.User.collection.updateOne({_id:user._id},{$set:{platformAccessManagedAt:user.platformAccessManagedAt||now,role:existing.role,operationalCountries:existing.operationalCountries}});continue;}}failed+=1;}
  }
  return{changed,failed,conflicts};
}
async function migrateOrders(){
  let changed=0;for await(const order of models.Order.find({}).select('publicId fulfillmentState items').cursor()){
    let dirty=false;const items=(order.items||[]).map((raw,index)=>{const item=raw.toObject?raw.toObject():{...raw};if(!item.linePublicId){item.linePublicId=deterministicLineId(order.publicId,index);dirty=true;}for(const key of ['returnReservedQuantity','returnedQuantity','refundedQuantity'])if(!Number.isFinite(Number(item[key]))){item[key]=0;dirty=true;}if(!Number.isFinite(Number(item.deliveredQuantity))){item.deliveredQuantity=order.fulfillmentState==='delivered'?Number(item.quantity||0):0;dirty=true;}return item;});
    if(dirty){await models.Order.collection.updateOne({_id:order._id},{$set:{items}});changed+=1;}
  }return changed;
}
async function migrateSellerSettlementSnapshots(){
  let changed=0,failed=0;
  const query={items:{$elemMatch:{$or:[{orderLineId:{$exists:false}},{orderLineId:''},{grossMinor:{$exists:false}},{discountMinor:{$exists:false}},{customerPaidMinor:{$exists:false}},{platformFeeMinor:{$exists:false}},{sellerReceivableMinor:{$exists:false}}]}}};
  for await(const sellerOrder of models.SellerOrder.collection.find(query)){
    const order=await models.Order.findById(sellerOrder.orderId).select('publicId items totals').lean();
    if(!order){failed+=1;continue;}
    const orderLines=(order.items||[]).filter(row=>String(row.storePublicId||'')===String(sellerOrder.storePublicId||''));
    const gross=orderLines.reduce((sum,row)=>sum+Number(row.lineTotalMinor||0),0);
    if(!orderLines.length||gross!==Number(sellerOrder.subtotalMinor||0)||orderLines.some(row=>!row.linePublicId)){failed+=1;continue;}
    let settlement;
    try{settlement=allocateSellerLineSettlement(orderLines,{discountMinor:Number(sellerOrder.discountMinor||0),platformFeeMinor:Number(sellerOrder.platformFeeMinor||0)});}catch{failed+=1;continue;}
    const items=settlement.map(line=>({orderLineId:line.linePublicId,productPublicId:line.productPublicId||'',variantPublicId:line.variantPublicId||'',title:line.title||'',variantTitle:line.variantTitle||'',sku:line.sku||'',quantity:Number(line.quantity||0),unitPriceMinor:Number(line.unitPriceMinor||0),lineTotalMinor:Number(line.lineTotalMinor||0),currency:line.currency||sellerOrder.currency,grossMinor:Number(line.grossMinor||0),discountMinor:Number(line.discountMinor||0),customerPaidMinor:Number(line.customerPaidMinor||0),platformFeeMinor:Number(line.platformFeeMinor||0),sellerReceivableMinor:Number(line.sellerReceivableMinor||0)}));
    await models.SellerOrder.collection.updateOne({_id:sellerOrder._id},{$set:{items},$push:{timeline:{type:'migration.settlement_snapshot',message:'Backfilled immutable line-level seller settlement snapshot for exact refund reversal.',at:new Date()}}});changed+=1;
  }
  return {changed,failed};
}
async function migrateOrderLifecycle(){
  let changed=0;
  const query={$or:[{cancellationState:{$exists:false}},{returnState:{$exists:false}},{refundState:{$exists:false}},{paymentState:{$exists:false}},{fulfillmentState:{$exists:false}}]};
  for await(const order of models.Order.collection.find(query)){
    const set={};const legacy=String(order.status||'pending_payment'),method=String(order.paymentMethod||'');
    if(!order.paymentState){
      const intent=await models.PaymentIntent.findOne({orderId:order._id}).sort({paidAt:-1,createdAt:-1}).select('status').lean();
      if(['succeeded'].includes(intent?.status)||legacy==='paid')set.paymentState='paid';
      else if(['refunded'].includes(intent?.status)||legacy==='refunded')set.paymentState='refunded';
      else if(['partially_refunded'].includes(intent?.status)||legacy==='partially_refunded')set.paymentState='partially_refunded';
      else if(method==='credit_terms'&&legacy==='confirmed')set.paymentState='credit_due';
      else if(method==='exchange'&&legacy==='confirmed')set.paymentState='paid';
      else if(['payment_failed','expired'].includes(legacy))set.paymentState='failed';
      else set.paymentState='pending';
    }
    if(!order.fulfillmentState){
      const shipment=await models.Shipment.findOne({orderId:order._id,kind:'outbound'}).select('status').lean();
      if(shipment?.status==='delivered')set.fulfillmentState='delivered';
      else if(['picked_up','in_transit','rescheduled','return_to_sender'].includes(shipment?.status))set.fulfillmentState='shipped';
      else if(shipment?.status==='cancelled'||legacy==='cancelled'||legacy==='cancellation_pending')set.fulfillmentState='cancelled';
      else set.fulfillmentState='unfulfilled';
    }
    if(!order.cancellationState)set.cancellationState=legacy==='cancelled'?'cancelled':legacy==='cancellation_pending'?'processing':'none';
    if(!order.returnState){
      const active=await models.ReturnRequest.exists({orderId:order._id,status:{$in:['requested','approved','awaiting_return','received','inspected','refund_pending','refund_processing','exchange_pending']}});
      const delivered=(order.items||[]).reduce((n,row)=>n+Number(row.deliveredQuantity||0),0),returned=(order.items||[]).reduce((n,row)=>n+Number(row.returnedQuantity||0),0);
      set.returnState=active?'requested':returned>0&&delivered>0&&returned>=delivered?'returned':returned>0?'partial_return':'none';
    }
    if(!order.refundState){
      const refunds=await models.Refund.find({orderId:order._id,status:{$in:['pending','processing','completed']}}).select('status amountMinor').lean();
      const completed=refunds.filter(r=>r.status==='completed').reduce((n,r)=>n+Number(r.amountMinor||0),0),total=Number(order.totals?.totalMinor||0);
      set.refundState=completed>0&&completed>=total?'complete':completed>0?'partial':refunds.some(r=>r.status==='processing')?'processing':refunds.some(r=>r.status==='pending')?'pending':'none';
    }
    if(Object.keys(set).length){await models.Order.collection.updateOne({_id:order._id},{$set:set});changed+=1;}
  }
  return changed;
}
async function migrateSurveys(){let changed=0;for await(const row of models.SatisfactionSurvey.find({$or:[{country:{$exists:false}},{country:null},{country:''}]}).cursor()){const ticket=await models.SupportTicket.findById(row.ticketId).select('country').lean();if(ticket?.country){await models.SatisfactionSurvey.collection.updateOne({_id:row._id},{$set:{country:ticket.country}});changed+=1;}}return changed;}
async function migrateShipmentProofs(){let changed=0,failed=0;for await(const row of models.Shipment.find({$or:[{pickupCodeEncrypted:{$nin:[null,'']}},{deliveryCodeEncrypted:{$nin:[null,'']}}]}).select('+pickupCodeHash +deliveryCodeHash +pickupCodeEncrypted +deliveryCodeEncrypted').cursor()){const set={};try{if(row.pickupCodeEncrypted)set.pickupCodeHash=hashProofCode(decryptSensitive(row.pickupCodeEncrypted));if(row.deliveryCodeEncrypted)set.deliveryCodeHash=hashProofCode(decryptSensitive(row.deliveryCodeEncrypted));}catch{failed+=1;continue;}if(Object.keys(set).length){await models.Shipment.collection.updateOne({_id:row._id},{$set:set});changed+=1;}}return {changed,failed};}
const warehouseTaskSlaHours=Object.freeze({receive:4,put_away:8,pick:2,pack:2,dispatch:2,cycle_count:24,transfer:12,return_inspection:24});
async function migrateWarehouseTaskSla(){let changed=0;for await(const task of models.WarehouseTask.collection.find({$or:[{dueAt:{$exists:false}},{dueAt:null}]},{projection:{_id:1,type:1,createdAt:1}})){const base=task.createdAt instanceof Date?task.createdAt:new Date(task.createdAt||Date.now());const dueAt=new Date(base.getTime()+Number(warehouseTaskSlaHours[task.type]||24)*60*60*1000);await models.WarehouseTask.collection.updateOne({_id:task._id},{$set:{dueAt}});changed+=1;}return changed;}
async function migrateSupportTicketQueues(){let changed=0;for await(const ticket of models.SupportTicket.collection.find({$or:[{queue:{$exists:false}},{queue:null},{queue:''}]},{projection:{_id:1,category:1}})){await models.SupportTicket.collection.updateOne({_id:ticket._id},{$set:{queue:supportQueueForCategory(ticket.category)}});changed+=1;}return changed;}
async function migrateSellerReturnCaseSnapshots(){
  let changed=0,failed=0;
  const query={$or:[{slaDueAt:{$exists:false}},{slaDueAt:null},{items:{$elemMatch:{$or:[{sellerReceivableReversalMinor:{$exists:false}},{platformFeeReversalMinor:{$exists:false}}]}}}]};
  for await(const row of models.SellerReturnCase.collection.find(query)){
    const ret=await models.ReturnRequest.findById(row.returnRequestId).select('createdAt refundPublicId items').lean();
    const sellerOrder=await models.SellerOrder.findOne({orderPublicId:row.orderPublicId,storeId:row.storeId}).select('orderId items').lean();
    if(!ret||!sellerOrder){failed+=1;continue;}
    const sellerLineById=new Map((sellerOrder.items||[]).map(item=>[String(item.orderLineId||''),item]));
    let linkedRefund=null;if(ret.refundPublicId)linkedRefund=await models.Refund.findOne({publicId:ret.refundPublicId}).select('allocations').lean();
    const priorRefunds=await models.Refund.find({orderId:sellerOrder.orderId,createdAt:{$lt:ret.createdAt},status:{$in:['pending','processing','completed']},'allocations.0':{$exists:true}}).select('allocations').lean();
    const priorGross=new Map();for(const refund of priorRefunds){for(const allocation of refund.allocations||[]){const key=`${allocation.storePublicId}:${allocation.orderLineId}`;priorGross.set(key,(priorGross.get(key)||0)+Number(allocation.grossMinor||0));}}
    let invalid=false;
    const items=(row.items||[]).map(raw=>{
      const item={...raw},line=sellerLineById.get(String(item.orderLineId||''));
      if(!line||![line.customerPaidMinor,line.platformFeeMinor,line.sellerReceivableMinor].every(value=>Number.isSafeInteger(Number(value))&&Number(value)>=0)){invalid=true;return item;}
      const linked=(linkedRefund?.allocations||[]).find(a=>String(a.storePublicId||'')===String(row.storePublicId||'')&&String(a.orderLineId||'')===String(item.orderLineId||''));
      if(linked){item.platformFeeReversalMinor=Number(linked.platformFeeMinor||0);item.sellerReceivableReversalMinor=Number(linked.sellerReceivableMinor||0);return item;}
      const gross=Number(item.requestedRefundMinor||0),base=Number(line.customerPaidMinor||0),key=`${row.storePublicId}:${item.orderLineId}`,consumed=Number(priorGross.get(key)||0);
      try{const fee=proportionalSettlementSlice(Number(line.platformFeeMinor||0),consumed,gross,base);item.platformFeeReversalMinor=fee;item.sellerReceivableReversalMinor=gross-fee;}catch{invalid=true;}
      return item;
    });
    if(invalid){failed+=1;continue;}
    const createdAt=row.createdAt instanceof Date?row.createdAt:new Date(row.createdAt||Date.now()),slaDueAt=row.slaDueAt||new Date(createdAt.getTime()+48*60*60*1000);
    await models.SellerReturnCase.collection.updateOne({_id:row._id},{$set:{items,slaDueAt},$push:{timeline:{type:'migration.seller_return_snapshot',message:'Backfilled seller return SLA and immutable financial-impact snapshot.',at:new Date()}}});changed+=1;
  }
  return {changed,failed};
}
async function migrateProductModerationRisk(){const restrictedCategoryIds=await models.Category.find({restricted:true}).distinct('_id');const high=await models.Product.updateMany({status:'submitted',categoryId:{$in:restrictedCategoryIds},$or:[{'moderation.riskLevel':{$ne:'high'}},{'moderation.secondReviewRequired':{$ne:true}}]},{$set:{'moderation.riskLevel':'high','moderation.secondReviewRequired':true}});const standard=await models.Product.updateMany({status:'submitted',categoryId:{$nin:restrictedCategoryIds},$or:[{'moderation.riskLevel':{$exists:false}},{'moderation.riskLevel':{$nin:['standard','high']}}]},{$set:{'moderation.riskLevel':'standard'}});return {high:Number(high.modifiedCount||0),standard:Number(standard.modifiedCount||0)};}
async function migrateRefundCounters(){
  const baseline=await models.PaymentIntent.collection.updateMany({$or:[{refundReservedMinor:{$exists:false}},{refundedMinor:{$exists:false}}]},[{$set:{refundReservedMinor:{$ifNull:['$refundReservedMinor',0]},refundedMinor:{$ifNull:['$refundedMinor',0]}}}]);
  let changed=Number(baseline.modifiedCount||0),failed=0;
  const cursor=models.Refund.aggregate([
    {$match:{status:{$in:['pending','processing','completed']}}},
    {$group:{_id:'$paymentIntentId',reserved:{$sum:{$cond:[{$in:['$status',['pending','processing']]},'$amountMinor',0]}},refunded:{$sum:{$cond:[{$eq:['$status','completed']},'$amountMinor',0]}}}},
  ]).cursor({batchSize:200});
  for await(const row of cursor){
    const intent=await models.PaymentIntent.findById(row._id).select('amountMinor refundReservedMinor refundedMinor').lean();
    if(!intent||Number(row.reserved||0)<0||Number(row.refunded||0)<0||Number(row.reserved||0)+Number(row.refunded||0)>Number(intent.amountMinor||0)){failed+=1;continue;}
    if(Number(intent.refundReservedMinor||0)!==Number(row.reserved||0)||Number(intent.refundedMinor||0)!==Number(row.refunded||0)){await models.PaymentIntent.updateOne({_id:intent._id},{$set:{refundReservedMinor:Number(row.reserved||0),refundedMinor:Number(row.refunded||0)}});changed+=1;}
  }
  return {changed,failed};
}

async function migratePaymentIntentCountries(){let changed=0,failed=0;for await(const intent of models.PaymentIntent.collection.find({$or:[{country:{$exists:false}},{country:null},{country:''}]},{projection:{_id:1,orderId:1}})){const order=await models.Order.findById(intent.orderId).select('country').lean();if(!order?.country){failed+=1;continue;}await models.PaymentIntent.collection.updateOne({_id:intent._id},{$set:{country:String(order.country).toUpperCase()}});changed+=1;}return {changed,failed};}

async function migrateDeliveryControls(){
  const settingsResult=await models.CountrySetting.updateMany({$or:[{'delivery.requirePhotoForCod':{$exists:false}},{'delivery.requireSignatureForDelivery':{$exists:false}},{'delivery.requirePhotoForFailedAttempt':{$exists:false}}]},{$set:{'delivery.requirePhotoForCod':true,'delivery.requireSignatureForDelivery':false,'delivery.requirePhotoForFailedAttempt':true}});
  let changedShipments=0,failed=0;
  const query={$or:[{slaDueAt:{$exists:false}},{slaDueAt:null},{'proofPolicy.deliveryPhotoRequired':{$exists:false}},{'proofPolicy.signatureRequired':{$exists:false}},{'proofPolicy.failedAttemptPhotoRequired':{$exists:false}}]};
  for await(const shipment of models.Shipment.collection.find(query,{projection:{_id:1,country:1,mode:1,cod:1,createdAt:1}})){
    const setting=await models.CountrySetting.findOne({code:shipment.country}).select('delivery').lean();if(!setting){failed+=1;continue;}const mode=String(shipment.mode||'standard');const hours=mode==='express'?Number(setting.delivery?.defaultExpressSlaHours||24):Number(setting.delivery?.defaultStandardSlaHours||72);const base=shipment.createdAt instanceof Date?shipment.createdAt:new Date(shipment.createdAt||Date.now());
    await models.Shipment.collection.updateOne({_id:shipment._id},{$set:{slaDueAt:new Date(base.getTime()+Math.max(1,Math.min(720,hours))*60*60*1000),'proofPolicy.deliveryPhotoRequired':Boolean(shipment.cod?.required&&(setting.delivery?.requirePhotoForCod??true)),'proofPolicy.signatureRequired':Boolean(setting.delivery?.requireSignatureForDelivery),'proofPolicy.failedAttemptPhotoRequired':Boolean(setting.delivery?.requirePhotoForFailedAttempt??true)}});changedShipments+=1;
  }
  return {countrySettings:Number(settingsResult.modifiedCount||0),shipments:changedShipments,failed};
}
async function migrateBusinessTaxSnapshots(){
  let procurements=0,purchaseOrders=0,invoices=0,orders=0;
  for await(const row of models.ProcurementRequest.collection.find({$or:[{estimatedSubtotalMinor:{$exists:false}},{taxBps:{$exists:false}},{estimatedTaxMinor:{$exists:false}},{taxPolicyVersion:{$exists:false}}]},{projection:{_id:1,estimatedTotalMinor:1}})){const legacyTotal=Math.max(0,Number(row.estimatedTotalMinor||0));await models.ProcurementRequest.collection.updateOne({_id:row._id},{$set:{estimatedSubtotalMinor:legacyTotal,taxBps:0,estimatedTaxMinor:0,taxPolicyVersion:'legacy-zero-tax'}});procurements+=1;}
  for await(const row of models.PurchaseOrder.collection.find({$or:[{subtotalMinor:{$exists:false}},{taxBps:{$exists:false}},{taxMinor:{$exists:false}},{taxPolicyVersion:{$exists:false}}]},{projection:{_id:1,totalMinor:1}})){const legacyTotal=Math.max(0,Number(row.totalMinor||0));await models.PurchaseOrder.collection.updateOne({_id:row._id},{$set:{subtotalMinor:legacyTotal,taxBps:0,taxMinor:0,taxPolicyVersion:'legacy-zero-tax'}});purchaseOrders+=1;}
  const invoiceResult=await models.BusinessInvoice.updateMany({$or:[{taxBps:{$exists:false}},{taxPolicyVersion:{$exists:false}}]},{$set:{taxBps:0,taxPolicyVersion:'legacy-zero-tax'}});invoices=Number(invoiceResult.modifiedCount||0);
  const orderResult=await models.Order.updateMany({businessOrganizationId:{$ne:null},'policySnapshot.taxBps':{$exists:false}},{$set:{'policySnapshot.taxBps':0}});orders=Number(orderResult.modifiedCount||0);
  return{procurements,purchaseOrders,invoices,orders};
}

async function migrateSellerPayoutScopes(){
  let accounts=0,payouts=0,ambiguousAccounts=0,ambiguousPayouts=0;
  const accountQuery={ownerType:'seller',$or:[{ownerStoreId:{$exists:false}},{ownerStoreId:null},{ownerStorePublicId:{$exists:false}},{ownerStorePublicId:''}]};
  for await(const account of models.PayoutAccount.find(accountQuery).select('ownerUserId ownerStoreId ownerStorePublicId country currency').lean().cursor()){
    let store=null;
    if(account.ownerStoreId)store=await models.Store.findOne({_id:account.ownerStoreId,status:{$ne:'closed'},country:account.country,currency:account.currency}).select('_id publicId').lean();
    if(!store){
      const candidates=await models.Store.find({ownerUserId:account.ownerUserId,status:{$ne:'closed'},country:account.country,currency:account.currency}).select('_id publicId').limit(2).lean();
      if(candidates.length===1)store=candidates[0];
    }
    if(!store){ambiguousAccounts+=1;continue;}
    await models.PayoutAccount.collection.updateOne({_id:account._id},{$set:{ownerStoreId:store._id,ownerStorePublicId:store.publicId}});accounts+=1;
  }
  const sellerAccountIds=await models.PayoutAccount.find({ownerType:'seller'}).distinct('_id');
  const payoutQuery={payoutAccountId:{$in:sellerAccountIds},$or:[{ownerStoreId:{$exists:false}},{ownerStoreId:null},{ownerStorePublicId:{$exists:false}},{ownerStorePublicId:''}]};
  for await(const payout of models.Payout.find(payoutQuery).select('payoutAccountId ownerStoreId ownerStorePublicId').lean().cursor()){
    let store=null;
    const account=await models.PayoutAccount.findById(payout.payoutAccountId).select('ownerType ownerStoreId ownerStorePublicId').lean();
    if(account?.ownerType==='seller'&&account.ownerStoreId)store=await models.Store.findById(account.ownerStoreId).select('_id publicId').lean();
    if(!store){ambiguousPayouts+=1;continue;}
    await models.Payout.collection.updateOne({_id:payout._id},{$set:{ownerStoreId:store._id,ownerStorePublicId:store.publicId}});payouts+=1;
  }
  return{accounts,payouts,ambiguousAccounts,ambiguousPayouts};
}

async function migrateSellerProfitabilitySnapshots(){
  let orders=0,sellerOrders=0,refunds=0,failedRefundAllocations=0;
  for await(const order of models.Order.collection.find({items:{$elemMatch:{$or:[{costSnapshotStatus:{$exists:false}},{costSnapshotStatus:{$nin:['captured','legacy_unknown']}}]}}})){
    let dirty=false;const items=(order.items||[]).map(raw=>{const item={...raw};if(!['captured','legacy_unknown'].includes(String(item.costSnapshotStatus||''))){item.costSnapshotStatus='legacy_unknown';item.unitCostMinor=null;dirty=true;}return item;});
    if(dirty){await models.Order.collection.updateOne({_id:order._id},{$set:{items}});orders+=1;}
  }
  for await(const sellerOrder of models.SellerOrder.collection.find({items:{$elemMatch:{$or:[{costSnapshotStatus:{$exists:false}},{costSnapshotStatus:{$nin:['captured','legacy_unknown']}}]}}})){
    let dirty=false;const items=(sellerOrder.items||[]).map(raw=>{const item={...raw};if(!['captured','legacy_unknown'].includes(String(item.costSnapshotStatus||''))){item.costSnapshotStatus='legacy_unknown';item.unitCostMinor=null;dirty=true;}return item;});
    if(dirty){await models.SellerOrder.collection.updateOne({_id:sellerOrder._id},{$set:{items}});sellerOrders+=1;}
  }
  const refundQuery={allocations:{$elemMatch:{orderLineId:{$nin:['',null]},$or:[{variantPublicId:{$exists:false}},{variantPublicId:''},{sku:{$exists:false}},{sku:''},{costSnapshotStatus:{$exists:false}},{costSnapshotStatus:{$nin:['captured','legacy_unknown']}}]}}};
  for await(const refund of models.Refund.collection.find(refundQuery)){
    const sellerOrdersForOrder=await models.SellerOrder.find({orderId:refund.orderId}).select('storePublicId items').lean();const lineByKey=new Map();
    for(const sellerOrder of sellerOrdersForOrder)for(const line of sellerOrder.items||[])if(line.orderLineId)lineByKey.set(`${sellerOrder.storePublicId}:${line.orderLineId}`,line);
    let dirty=false,failed=false;const allocations=(refund.allocations||[]).map(raw=>{const allocation={...raw};if(!allocation.orderLineId)return allocation;const missing=!allocation.variantPublicId||!allocation.sku||!['captured','legacy_unknown'].includes(String(allocation.costSnapshotStatus||''));if(!missing)return allocation;const line=lineByKey.get(`${allocation.storePublicId}:${allocation.orderLineId}`);if(!line?.variantPublicId||!line?.sku){failed=true;return allocation;}allocation.variantPublicId=String(line.variantPublicId);allocation.sku=String(line.sku);allocation.costSnapshotStatus=['captured','legacy_unknown'].includes(String(line.costSnapshotStatus||''))?String(line.costSnapshotStatus):'legacy_unknown';dirty=true;return allocation;});
    if(failed){failedRefundAllocations+=1;continue;}if(dirty){await models.Refund.collection.updateOne({_id:refund._id},{$set:{allocations}});refunds+=1;}
  }
  return{orders,sellerOrders,refunds,failedRefundAllocations};
}
async function migrateSellerShipmentLinks(){
  let changed=0,failed=0;
  for await(const sellerOrder of models.SellerOrder.find({}).select('_id publicId orderId orderPublicId storeId storePublicId country items').lean().cursor()){
    if(await models.SellerShipment.exists({sellerOrderId:sellerOrder._id}))continue;
    const rootShipment=await models.Shipment.findOne({orderId:sellerOrder.orderId,kind:'outbound'}).select('_id publicId').lean();
    if(!rootShipment){failed+=1;continue;}
    const parcel=await models.Parcel.findOne({shipmentId:rootShipment._id,storePublicId:sellerOrder.storePublicId}).select('_id publicId status').lean();
    if(!parcel){failed+=1;continue;}
    const quantity=(sellerOrder.items||[]).reduce((sum,row)=>sum+Math.max(0,Number(row.quantity||0)),0);
    try{
      await models.SellerShipment.create({publicId:`sshp_mig_${crypto.createHash('sha256').update(String(sellerOrder._id)).digest('hex').slice(0,20)}`,orderId:sellerOrder.orderId,orderPublicId:sellerOrder.orderPublicId,sellerOrderId:sellerOrder._id,sellerOrderPublicId:sellerOrder.publicId,storeId:sellerOrder.storeId,storePublicId:sellerOrder.storePublicId,country:sellerOrder.country,rootShipmentId:rootShipment._id,rootShipmentPublicId:rootShipment.publicId,parcelId:parcel._id,parcelPublicId:parcel.publicId,status:parcel.status,lineCount:Math.max(1,(sellerOrder.items||[]).length),quantity:Math.max(1,quantity),timeline:[{type:'migration.created',message:`Backfilled seller shipment from authoritative parcel ${parcel.publicId} inside root shipment ${rootShipment.publicId}.`} ]});
      changed+=1;
    }catch(error){if(error?.code===11000&&await models.SellerShipment.exists({sellerOrderId:sellerOrder._id}))continue;failed+=1;}
  }
  return {changed,failed};
}
async function createIndexes(){const results={},failures=[];for(const [name,model] of Object.entries(models)){if(!model?.createIndexes)continue;try{await model.createIndexes();results[name]='ok';}catch(error){const message=`ERROR: ${error.message}`;results[name]=message;failures.push(`${name}: ${error.message}`);}}return {results,failures};}
async function main(){await connectDatabase({autoIndex:false});try{const plan=await countPlan();console.log(JSON.stringify({mode:apply?'apply':'dry-run',plan},null,2));if(!apply){console.log('No data changed. Re-run with --apply after taking a verified backup.');return;}const result={users:await migrateUsers(),platformGrants:await migratePlatformGrants(),orders:await migrateOrders(),sellerSettlementSnapshots:await migrateSellerSettlementSnapshots(),orderLifecycle:await migrateOrderLifecycle(),surveys:await migrateSurveys(),shipmentProofs:await migrateShipmentProofs(),financialDocuments:await backfillFinancialDocuments({limit:0}),businessDocuments:await backfillBusinessDocuments({limit:0}),warehouseTaskSla:await migrateWarehouseTaskSla(),supportTicketQueues:await migrateSupportTicketQueues(),sellerReturnCaseSnapshots:await migrateSellerReturnCaseSnapshots(),productModerationRisk:await migrateProductModerationRisk(),paymentIntentCountries:await migratePaymentIntentCountries(),refundCounters:await migrateRefundCounters(),deliveryControls:await migrateDeliveryControls(),businessTaxSnapshots:await migrateBusinessTaxSnapshots(),sellerPayoutScopes:await migrateSellerPayoutScopes(),sellerProfitabilitySnapshots:await migrateSellerProfitabilitySnapshots(),sellerShipmentLinks:await migrateSellerShipmentLinks()};const indexResult=await createIndexes();result.indexes=indexResult.results;console.log(JSON.stringify({applied:true,result},null,2));const certificationFailures=[];if(result.platformGrants.failed)certificationFailures.push(`${result.platformGrants.failed} privileged user(s) could not be migrated to authoritative PlatformGrant access`);if(result.platformGrants.conflicts)certificationFailures.push(`${result.platformGrants.conflicts} privileged user(s) have conflicting active PlatformGrant records`);if(result.shipmentProofs.failed)certificationFailures.push(`${result.shipmentProofs.failed} shipment proof record(s) could not be migrated`);if(result.sellerSettlementSnapshots.failed)certificationFailures.push(`${result.sellerSettlementSnapshots.failed} seller order(s) could not receive immutable line settlement snapshots`);if(result.paymentIntentCountries.failed)certificationFailures.push(`${result.paymentIntentCountries.failed} payment intent(s) could not receive immutable country snapshots`);if(result.refundCounters.failed)certificationFailures.push(`${result.refundCounters.failed} payment intent refund counter set(s) exceed the captured payment or reference a missing payment intent`);if(result.sellerReturnCaseSnapshots.failed)certificationFailures.push(`${result.sellerReturnCaseSnapshots.failed} seller return case(s) could not receive immutable SLA/financial-impact snapshots`);if(result.deliveryControls.failed)certificationFailures.push(`${result.deliveryControls.failed} shipment(s) could not receive delivery SLA/proof-policy snapshots`);if(result.sellerPayoutScopes.ambiguousAccounts)certificationFailures.push(`${result.sellerPayoutScopes.ambiguousAccounts} legacy seller payout account(s) cannot be assigned to exactly one store safely`);if(result.sellerPayoutScopes.ambiguousPayouts)certificationFailures.push(`${result.sellerPayoutScopes.ambiguousPayouts} legacy seller payout(s) cannot be assigned to exactly one store safely`);if(result.sellerProfitabilitySnapshots.failedRefundAllocations)certificationFailures.push(`${result.sellerProfitabilitySnapshots.failedRefundAllocations} refund record(s) cannot be mapped to immutable seller SKU/cost snapshots safely`);if(result.sellerShipmentLinks.failed)certificationFailures.push(`${result.sellerShipmentLinks.failed} seller order(s) could not be linked to an authoritative seller shipment/parcel`);const unresolvedPlatformGrants=await countPrivilegedUsersMissingAuthoritativeGrant();if(unresolvedPlatformGrants)certificationFailures.push(`${unresolvedPlatformGrants} privileged user(s) still lack exactly one current authoritative PlatformGrant`);const unresolvedPlatformGrantConflicts=await countPlatformGrantConflicts();if(unresolvedPlatformGrantConflicts)certificationFailures.push(`${unresolvedPlatformGrantConflicts} user(s) still have multiple active PlatformGrant records`);const stalePrivilegeMirrors=await countManagedPrivilegeMirrorWithoutGrant();if(stalePrivilegeMirrors)certificationFailures.push(`${stalePrivilegeMirrors} managed user(s) retain a privileged role mirror without a current authoritative grant`);const unresolvedUnboundReturns=await models.WarehouseTask.countDocuments({type:'return_inspection',status:{$in:['open','in_progress']},$or:[{returnRequestId:{$exists:false}},{returnRequestId:null},{returnOrderLineId:{$exists:false}},{returnOrderLineId:''}]});const unresolvedReceivedReturns=await models.ReturnRequest.countDocuments({status:'received',items:{$elemMatch:{$or:[{warehouseTaskPublicId:{$exists:false}},{warehouseTaskPublicId:''}]}}});if(unresolvedUnboundReturns)certificationFailures.push(`${unresolvedUnboundReturns} legacy open return-inspection task(s) are not bound to an authoritative return line and require manual reconciliation`);if(unresolvedReceivedReturns)certificationFailures.push(`${unresolvedReceivedReturns} received return request(s) predate warehouse inspection binding and require manual reconciliation`);const unresolvedSupportQueues=await models.SupportTicket.countDocuments({$or:[{queue:{$exists:false}},{queue:null},{queue:''}]});if(unresolvedSupportQueues)certificationFailures.push(`${unresolvedSupportQueues} support ticket(s) still lack an operational queue`);const unresolvedSellerReturnSnapshots=await models.SellerReturnCase.countDocuments({$or:[{slaDueAt:{$exists:false}},{slaDueAt:null},{items:{$elemMatch:{$or:[{sellerReceivableReversalMinor:{$exists:false}},{platformFeeReversalMinor:{$exists:false}}]}}}]});if(unresolvedSellerReturnSnapshots)certificationFailures.push(`${unresolvedSellerReturnSnapshots} seller return case(s) still lack immutable SLA/financial-impact snapshots`);const sellerPayoutAccountIdsForCertification=await models.PayoutAccount.find({ownerType:'seller'}).distinct('_id');const unresolvedSellerPayoutScopes=await models.PayoutAccount.countDocuments({ownerType:'seller',$or:[{ownerStoreId:{$exists:false}},{ownerStoreId:null},{ownerStorePublicId:{$exists:false}},{ownerStorePublicId:''}]})+await models.Payout.countDocuments({payoutAccountId:{$in:sellerPayoutAccountIdsForCertification},$or:[{ownerStoreId:{$exists:false}},{ownerStoreId:null},{ownerStorePublicId:{$exists:false}},{ownerStorePublicId:''}]});if(unresolvedSellerPayoutScopes)certificationFailures.push(`${unresolvedSellerPayoutScopes} seller payout record(s) still lack an unambiguous store scope`);const unresolvedSellerShipmentLinks=await countSellerOrdersMissingSellerShipment();if(unresolvedSellerShipmentLinks)certificationFailures.push(`${unresolvedSellerShipmentLinks} seller order(s) still lack an explicit seller-shipment aggregate`);const unresolvedProfitabilitySnapshots=await models.Order.countDocuments({items:{$elemMatch:{$or:[{costSnapshotStatus:{$exists:false}},{costSnapshotStatus:{$nin:['captured','legacy_unknown']}}]}}})+await models.SellerOrder.countDocuments({items:{$elemMatch:{$or:[{costSnapshotStatus:{$exists:false}},{costSnapshotStatus:{$nin:['captured','legacy_unknown']}}]}}})+await models.Refund.countDocuments({allocations:{$elemMatch:{orderLineId:{$nin:['',null]},$or:[{variantPublicId:{$exists:false}},{variantPublicId:''},{sku:{$exists:false}},{sku:''},{costSnapshotStatus:{$exists:false}},{costSnapshotStatus:{$nin:['captured','legacy_unknown']}}]}}});if(unresolvedProfitabilitySnapshots)certificationFailures.push(`${unresolvedProfitabilitySnapshots} seller profitability record(s) still lack an explicit immutable cost/SKU snapshot status`);const restrictedCategoryIds=await models.Category.find({restricted:true}).distinct('_id');const unresolvedRestrictedModeration=await models.Product.countDocuments({status:'submitted',categoryId:{$in:restrictedCategoryIds},$or:[{'moderation.riskLevel':{$ne:'high'}},{'moderation.secondReviewRequired':{$ne:true}}]});if(unresolvedRestrictedModeration)certificationFailures.push(`${unresolvedRestrictedModeration} submitted restricted product(s) still lack high-risk four-eyes moderation state`);const unresolvedPaymentCountries=await models.PaymentIntent.countDocuments({$or:[{country:{$exists:false}},{country:null},{country:''}]});if(unresolvedPaymentCountries)certificationFailures.push(`${unresolvedPaymentCountries} payment intent(s) still lack immutable country snapshots`);const unresolvedRefundCounterFields=await models.PaymentIntent.countDocuments({$or:[{refundReservedMinor:{$exists:false}},{refundedMinor:{$exists:false}}]});if(unresolvedRefundCounterFields)certificationFailures.push(`${unresolvedRefundCounterFields} payment intent(s) still lack authoritative refund counters`);const unresolvedRefundCounterDrift=await countRefundCounterDrift();if(unresolvedRefundCounterDrift)certificationFailures.push(`${unresolvedRefundCounterDrift} payment intent(s) have refund reservation/completion counters that do not reconcile to refund history`);const unresolvedDeliveryControls=await models.Shipment.countDocuments({$or:[{slaDueAt:{$exists:false}},{slaDueAt:null},{'proofPolicy.deliveryPhotoRequired':{$exists:false}},{'proofPolicy.signatureRequired':{$exists:false}},{'proofPolicy.failedAttemptPhotoRequired':{$exists:false}}]});if(unresolvedDeliveryControls)certificationFailures.push(`${unresolvedDeliveryControls} shipment(s) still lack delivery SLA/proof-policy snapshots`);const legacyCodWithoutHandover=await models.Shipment.countDocuments({status:'delivered','cod.required':true,'cod.reconciledAt':null,$or:[{'cod.handoverAt':{$exists:false}},{'cod.handoverAt':null},{'cod.handoverEvidenceDocumentId':{$exists:false}},{'cod.handoverEvidenceDocumentId':null}]});if(legacyCodWithoutHandover)certificationFailures.push(`${legacyCodWithoutHandover} unreconciled delivered COD shipment(s) predate receipt-backed handover and require manual evidence/reconciliation before production certification`);const unresolvedBusinessTaxSnapshots=await models.ProcurementRequest.countDocuments({$or:[{estimatedSubtotalMinor:{$exists:false}},{taxBps:{$exists:false}},{estimatedTaxMinor:{$exists:false}},{taxPolicyVersion:{$exists:false}}]})+await models.PurchaseOrder.countDocuments({$or:[{subtotalMinor:{$exists:false}},{taxBps:{$exists:false}},{taxMinor:{$exists:false}},{taxPolicyVersion:{$exists:false}}]})+await models.BusinessInvoice.countDocuments({$or:[{taxBps:{$exists:false}},{taxPolicyVersion:{$exists:false}}]})+await models.Order.countDocuments({businessOrganizationId:{$ne:null},'policySnapshot.taxBps':{$exists:false}});if(unresolvedBusinessTaxSnapshots)certificationFailures.push(`${unresolvedBusinessTaxSnapshots} B2B commerce record(s) still lack an immutable tax snapshot`);const businessDocumentFailures=[];for await(const quote of models.QuoteRequest.find({offeredTotalMinor:{$gt:0}}).select('publicId revision').lean().cursor()){const revision=Math.max(1,Number(quote.revision||0));if(!Number(quote.revision||0)||!await models.BusinessDocument.exists({eventKey:`quotation:${quote.publicId}:r${revision}`}))businessDocumentFailures.push(`quotation ${quote.publicId} revision ${revision}`);}for await(const po of models.PurchaseOrder.find({}).select('publicId').lean().cursor()){if(!await models.BusinessDocument.exists({eventKey:`purchase_order:${po.publicId}`}))businessDocumentFailures.push(`purchase order ${po.publicId}`);}for await(const invoice of models.BusinessInvoice.find({}).select('publicId orderPublicId deliveredAt').lean().cursor()){if(!await models.BusinessDocument.exists({eventKey:`tax_invoice:${invoice.publicId}`}))businessDocumentFailures.push(`tax invoice ${invoice.publicId}`);if(invoice.deliveredAt&&!await models.BusinessDocument.exists({eventKey:`delivery_note:${invoice.orderPublicId}`}))businessDocumentFailures.push(`delivery note ${invoice.orderPublicId}`);}if(businessDocumentFailures.length)certificationFailures.push(`${businessDocumentFailures.length} B2B issued document(s) still lack immutable document snapshots: ${businessDocumentFailures.slice(0,10).join(', ')}`);if(indexResult.failures.length)certificationFailures.push(`index creation failures: ${indexResult.failures.join('; ')}`);if(certificationFailures.length){console.error(`Migration data changes completed, but release certification failed:
- ${certificationFailures.join('\n- ')}`);process.exitCode=2;}}finally{await disconnectDatabase();}}
main().catch(error=>{console.error(error);process.exitCode=1;});

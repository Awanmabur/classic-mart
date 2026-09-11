import crypto from 'node:crypto';
import { publicId } from '../core/ids.js';
import {
  BusinessInvoice, Chargeback, FinancialDocument, InvariantScanCursor, InventoryReservation, LedgerTransaction, MarketingCampaign, OperationalAlert,
  Order, OutboxEvent, PaymentIntent, Payout, PriceSchedule, ProcurementTemplate, ProviderEvent, Refund, StockItem, WebhookDelivery,
} from '../models/index.js';

const MAX_PER_CHECK=250;
const PAYOUT_STALE_MS=30*60_000;

async function scanBatch(Model,checkName,base={},select=''){
  const state=await InvariantScanCursor.findOne({checkName}).lean();
  const scope=state?.lastId?{$and:[base,{_id:{$gt:state.lastId}}]}:base;
  let query=Model.find(scope).sort({_id:1}).limit(MAX_PER_CHECK);if(select)query=query.select(select);const rows=await query.lean();
  const completed=rows.length<MAX_PER_CHECK,nextId=completed?null:rows.at(-1)?._id||null;
  await InvariantScanCursor.findOneAndUpdate({checkName},{$set:{lastId:nextId,lastBatchSize:rows.length,lastScannedAt:new Date()},...(completed?{$inc:{completedPasses:1}}:{})},{upsert:true,setDefaultsOnInsert:true});
  return rows;
}

function fp(type,resource){return crypto.createHash('sha256').update(`${type}:${resource}`).digest('hex');}
function spec(type,severity,country,resourceType,resourcePublicId,title,message,details={}){return {type,severity,country:country||'',resourceType,resourcePublicId:resourcePublicId||'',title,message,details,fingerprint:fp(type,`${resourceType}:${resourcePublicId}`)};}
async function upsertAlert(row,scanToken){
  const now=new Date();
  const existing=await OperationalAlert.findOne({fingerprint:row.fingerprint}).select('_id status').lean();
  if(!existing){
    await OperationalAlert.create({...row,publicId:publicId('ops'),firstSeenAt:now,lastSeenAt:now,scanToken,status:'open'});
    return;
  }
  const update={$set:{...row,lastSeenAt:now,scanToken}};
  // Suppression is an explicit operator decision and must survive recurring scans.
  if(existing.status==='resolved'){
    update.$set.status='open';
    update.$unset={resolvedAt:1,resolvedByUserId:1,resolutionNote:1};
  }
  await OperationalAlert.updateOne({_id:existing._id},update);
}
async function paymentChecks(out){
  const intents=await scanBatch(PaymentIntent,'payments',{provider:'pesapal',status:{$in:['succeeded','partially_refunded','refunded']}});
  for(const intent of intents){
    const order=await Order.findById(intent.orderId).select('publicId country paymentState paymentMethod businessInvoiceId').lean();if(!order)continue;
    const key=intent.purpose==='business_invoice'&&order.paymentMethod==='credit_terms'?`business-invoice-payment:${intent.publicId}`:`payment:${intent.publicId}`;
    if(!await LedgerTransaction.exists({idempotencyKey:key}))out.push(spec('PAYMENT_LEDGER_MISSING','critical',order.country,'payment_intent',intent.publicId,'Verified payment has no ledger transaction',`Pesapal payment ${intent.publicId} is successful but ledger transaction ${key} is missing.`,{orderPublicId:order.publicId,key}));
    if(!['paid','partially_refunded','refunded'].includes(order.paymentState||''))out.push(spec('PAYMENT_ORDER_MISMATCH','critical',order.country,'payment_intent',intent.publicId,'Payment and order state disagree',`Pesapal payment ${intent.publicId} succeeded but order ${order.publicId} is ${order.paymentState||'unset'}.`,{orderPublicId:order.publicId}));
  }
}
async function refundChecks(out){
  const refunds=await scanBatch(Refund,'refunds',{status:'completed'});
  for(const refund of refunds){
    const order=await Order.findById(refund.orderId).select('publicId country').lean();if(!order)continue;
    if(!await LedgerTransaction.exists({idempotencyKey:`refund:${refund.publicId}`}))out.push(spec('REFUND_LEDGER_MISSING','critical',order.country,'refund',refund.publicId,'Completed refund has no ledger reversal',`Refund ${refund.publicId} is completed but its immutable ledger reversal is missing.`,{orderPublicId:order.publicId}));
    if(!await FinancialDocument.exists({eventKey:`refund_credit_note:${refund.publicId}`}))out.push(spec('REFUND_DOCUMENT_MISSING','high',order.country,'refund',refund.publicId,'Completed refund has no credit note',`Refund ${refund.publicId} is completed but no immutable credit note exists.`,{orderPublicId:order.publicId}));
  }
}
async function returnQuantityChecks(out){
  const orders=await scanBatch(Order,'return_quantities',{},'publicId country items.linePublicId items.deliveredQuantity items.returnReservedQuantity items.returnedQuantity items.refundedQuantity');
  for(const order of orders)for(const item of order.items||[]){const delivered=Number(item.deliveredQuantity||0),reserved=Number(item.returnReservedQuantity||0),returned=Number(item.returnedQuantity||0),refunded=Number(item.refundedQuantity||0);if(reserved+returned>delivered||refunded>returned)out.push(spec('RETURN_QUANTITY_INVALID','critical',order.country,'order_line',`${order.publicId}:${item.linePublicId}`,'Return quantities violate delivered quantity',`Order ${order.publicId} line ${item.linePublicId} has impossible return/refund counters.`,{delivered,reserved,returned,refunded}));}
}
async function payoutChecks(out){
  const cutoff=new Date(Date.now()-PAYOUT_STALE_MS);const rows=await scanBatch(Payout,'payouts',{status:{$in:['submitting','unknown']},$or:[{submissionStartedAt:{$lt:cutoff}},{submissionStartedAt:null,submittedAt:{$lt:cutoff}},{submissionStartedAt:null,submittedAt:null,updatedAt:{$lt:cutoff}}]});
  for(const row of rows)out.push(spec('PAYOUT_AMBIGUOUS','critical','', 'payout',row.publicId,'Payout requires reconciliation',`Payout ${row.publicId} has remained ${row.status} beyond the reconciliation SLA.`,{status:row.status,submissionStartedAt:row.submissionStartedAt,submittedAt:row.submittedAt,unknownAt:row.unknownAt}));
}
async function workerChecks(out){
  for(const row of await scanBatch(ProviderEvent,'provider_dead',{status:'dead'}))out.push(spec('PROVIDER_EVENT_DEAD','critical','', 'provider_event',row.publicId,'Pesapal provider event is dead-lettered',`Provider event ${row.publicId} exhausted retries.`,{eventType:row.eventType,attempts:row.attempts,error:row.error}));
  for(const row of await scanBatch(OutboxEvent,'outbox_dead',{status:'dead'}))out.push(spec('OUTBOX_DEAD','high','', 'outbox_event',row.eventId,'Notification outbox event is dead-lettered',`Outbox event ${row.eventId} exhausted retries.`,{type:row.type,attempts:row.attempts,lastError:row.lastError}));
  for(const row of await scanBatch(WebhookDelivery,'webhook_dead',{status:'dead'}))out.push(spec('SELLER_WEBHOOK_DEAD','high','', 'webhook_delivery',String(row._id),'Seller webhook delivery is dead-lettered',`Seller webhook event ${row.eventId} exhausted retries.`,{eventType:row.eventType,attempt:row.attempt,error:row.errorMessage}));
  const now=new Date();
  for(const row of await scanBatch(OutboxEvent,'outbox_stale',{status:'processing',lockedUntil:{$lt:now}}))out.push(spec('WORKER_LEASE_STALE','warning','', 'outbox_event',row.eventId,'Expired worker lease detected',`Outbox event ${row.eventId} has an expired processing lease and is waiting to be reclaimed.`,{lockedUntil:row.lockedUntil}));
  for(const row of await scanBatch(ProviderEvent,'provider_stale',{status:'processing',lockedUntil:{$lt:now}}))out.push(spec('WORKER_LEASE_STALE','warning','', 'provider_event',row.publicId,'Expired provider-event lease detected',`Provider event ${row.publicId} has an expired processing lease and is waiting to be reclaimed.`,{lockedUntil:row.lockedUntil}));
}
async function inventoryChecks(out){
  const rows=await scanBatch(StockItem,'inventory');
  for(const row of rows){const onHand=Number(row.onHand||0),reserved=Number(row.reserved||0),damaged=Number(row.damaged||0),quarantined=Number(row.quarantined||0);if(onHand<0||reserved<0||damaged<0||quarantined<0||reserved+damaged+quarantined>onHand)out.push(spec('INVENTORY_INVALID','critical','', 'stock_item',row.publicId,'Inventory counters are invalid',`Stock item ${row.publicId} has negative or over-allocated stock.`,{onHand,reserved,damaged,quarantined}));}
}
async function b2bChecks(out){
  const rows=await scanBatch(BusinessInvoice,'b2b_credit',{paymentTerms:'credit',status:{$in:['open','overdue','paid']}});
  for(const inv of rows){
    if(inv.deliveredAt&&!await LedgerTransaction.exists({idempotencyKey:`business-credit-delivery:${inv.orderPublicId}`}))out.push(spec('B2B_RECEIVABLE_MISMATCH','critical',inv.country,'business_invoice',inv.publicId,'Delivered credit invoice has no receivable',`Invoice ${inv.invoiceNumber} was delivered but its accounts-receivable ledger entry is missing.`,{orderPublicId:inv.orderPublicId}));
    if(inv.status==='paid'&&inv.paymentIntentPublicId&&!await LedgerTransaction.exists({idempotencyKey:`business-invoice-payment:${inv.paymentIntentPublicId}`}))out.push(spec('B2B_RECEIVABLE_MISMATCH','critical',inv.country,'business_invoice',inv.publicId,'Paid credit invoice did not clear receivable',`Invoice ${inv.invoiceNumber} is paid but its receivable-clearing ledger entry is missing.`,{paymentIntentPublicId:inv.paymentIntentPublicId}));
  }
}
async function chargebackChecks(out){
  const rows=await scanBatch(Chargeback,'chargebacks',{status:{$in:['open','reviewing','lost','won']}});
  for(const row of rows){
    if(!row.reversalLedgerTransactionPublicId||!await LedgerTransaction.exists({publicId:row.reversalLedgerTransactionPublicId}))out.push(spec('CHARGEBACK_LEDGER_MISMATCH','critical',row.country,'chargeback',row.publicId,'Chargeback has no reversal ledger transaction',`Chargeback ${row.publicId} exists but its provider-reversal accounting is missing.`,{paymentIntentPublicId:row.paymentIntentPublicId,status:row.status}));
    if(row.status==='won'&&(!row.recoveryLedgerTransactionPublicId||!await LedgerTransaction.exists({publicId:row.recoveryLedgerTransactionPublicId})))out.push(spec('CHARGEBACK_RECOVERY_MISSING','critical',row.country,'chargeback',row.publicId,'Won chargeback has no recovery ledger transaction',`Chargeback ${row.publicId} is marked won but its ledger recovery is missing.`,{}));
  }
}
export async function scanBusinessInvariants(){
  const scanToken=crypto.randomUUID();const found=[];
  await paymentChecks(found);await refundChecks(found);await returnQuantityChecks(found);await payoutChecks(found);await workerChecks(found);await inventoryChecks(found);await b2bChecks(found);await chargebackChecks(found);
  for(const row of found)await upsertAlert(row,scanToken);
  // Checks intentionally use bounded working sets. Absence from one scan is therefore
  // not proof that an older defect is fixed. Alerts remain open until an operator resolves
  // them; if the invariant later recurs, upsertAlert reopens the resolved alert.
  return {scanToken,found:found.length,critical:found.filter(x=>x.severity==='critical').length,high:found.filter(x=>x.severity==='high').length};
}
export async function operationalMetricSnapshot(){
  const now=new Date();
  const recurringBase={active:true,recurrence:{$in:['weekly','monthly']},nextDueAt:{$lte:now}};
  const reservationBase={status:'active',expiresAt:{$lte:now}};
  const priceBase={status:'scheduled',startsAt:{$lte:now}};
  const campaignBase={status:'scheduled',scheduledAt:{$lte:now}};
  const [alerts,pesapalPending,pesapalDead,outboxPending,outboxDead,webhookDead,payoutUnknown,refundProcessing,recurringDue,reservationsExpired,pricesDue,campaignsDue,oldestRecurring,oldestReservation,oldestPrice,oldestCampaign]=await Promise.all([
    OperationalAlert.aggregate([{$match:{status:{$in:['open','acknowledged','investigating']}}},{$group:{_id:'$severity',count:{$sum:1}}}]),
    ProviderEvent.countDocuments({provider:'pesapal',status:{$in:['received','processing','failed']}}),ProviderEvent.countDocuments({provider:'pesapal',status:'dead'}),OutboxEvent.countDocuments({status:{$in:['pending','processing','failed']}}),OutboxEvent.countDocuments({status:'dead'}),WebhookDelivery.countDocuments({status:'dead'}),Payout.countDocuments({status:{$in:['submitting','unknown']}}),Refund.countDocuments({status:{$in:['pending','processing']}}),ProcurementTemplate.countDocuments(recurringBase),InventoryReservation.countDocuments(reservationBase),PriceSchedule.countDocuments(priceBase),MarketingCampaign.countDocuments(campaignBase),
    ProcurementTemplate.findOne(recurringBase).sort({nextDueAt:1}).select('nextDueAt').lean(),
    InventoryReservation.findOne(reservationBase).sort({expiresAt:1}).select('expiresAt').lean(),
    PriceSchedule.findOne(priceBase).sort({startsAt:1}).select('startsAt').lean(),
    MarketingCampaign.findOne(campaignBase).sort({scheduledAt:1}).select('scheduledAt').lean(),
  ]);
  const severity=Object.fromEntries(alerts.map(x=>[x._id,x.count]));
  const ageSeconds=(date)=>date?Math.max(0,Math.floor((now-new Date(date))/1000)):0;
  return {checkedAt:now,alerts:severity,pesapalPending,pesapalDead,outboxPending,outboxDead,webhookDead,payoutUnknown,refundProcessing,recurringDue,reservationsExpired,pricesDue,campaignsDue,recurringOldestAgeSeconds:ageSeconds(oldestRecurring?.nextDueAt),reservationsOldestAgeSeconds:ageSeconds(oldestReservation?.expiresAt),pricesOldestAgeSeconds:ageSeconds(oldestPrice?.startsAt),campaignsOldestAgeSeconds:ageSeconds(oldestCampaign?.scheduledAt)};
}
export async function prometheusMetrics(){
  const s=await operationalMetricSnapshot();const g=(name,help,value)=>`# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${Number(value||0)}\n`;
  return [
    g('classicmart_open_invariant_alerts','Open business invariant alerts',Object.values(s.alerts).reduce((a,b)=>a+b,0)),
    g('classicmart_critical_invariant_alerts','Open critical business invariant alerts',s.alerts.critical),
    g('classicmart_pesapal_events_pending','Pesapal events pending, processing or retrying',s.pesapalPending),
    g('classicmart_pesapal_events_dead','Pesapal dead-letter events',s.pesapalDead),
    g('classicmart_outbox_pending','Notification outbox events pending or retrying',s.outboxPending),
    g('classicmart_outbox_dead','Dead notification outbox events',s.outboxDead),
    g('classicmart_seller_webhooks_dead','Dead seller webhook deliveries',s.webhookDead),
    g('classicmart_payouts_unknown','Payouts requiring external reconciliation',s.payoutUnknown),
    g('classicmart_refunds_processing','Refunds awaiting completion',s.refundProcessing),
    g('classicmart_recurring_procurement_due','Recurring procurement templates waiting for a worker',s.recurringDue),
    g('classicmart_expired_reservations_backlog','Expired inventory reservations waiting for cleanup',s.reservationsExpired),
    g('classicmart_scheduled_prices_due','Scheduled prices waiting for application',s.pricesDue),
    g('classicmart_marketing_campaigns_due','Scheduled marketing campaigns waiting for dispatch',s.campaignsDue),
    g('classicmart_recurring_procurement_oldest_age_seconds','Age in seconds of the oldest due recurring procurement template',s.recurringOldestAgeSeconds),
    g('classicmart_expired_reservations_oldest_age_seconds','Age in seconds of the oldest expired active reservation',s.reservationsOldestAgeSeconds),
    g('classicmart_scheduled_prices_oldest_age_seconds','Age in seconds of the oldest due scheduled price',s.pricesOldestAgeSeconds),
    g('classicmart_marketing_campaigns_oldest_age_seconds','Age in seconds of the oldest due marketing campaign',s.campaignsOldestAgeSeconds),
  ].join('');
}

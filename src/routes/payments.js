import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { hasPermission } from '../core/roles.js';
import { requireAuth, requireVerified } from '../middleware/auth.js';
import { PaymentIntent, LedgerTransaction, LedgerAccount, Order, Refund, PayoutAccount, Payout, ReconciliationRun, Store, Chargeback, ProviderEvent, Shipment } from '../models/index.js';
import { initiatePayment, getPaymentIntentForOrder, verifyAndApplyPayment, processPesapalNotification, requeueProviderEvent, createRefund, completeManualRefund, savePayoutAccount, requestPayout, submitPayout, confirmPayoutSubmission, markPayoutUnknown, reconcilePayout, reconcilePayments, rejectPayout, payoutOwnerContext, payoutAccountsForRequest, payoutsForRequest } from '../services/payments.js';
import { moneySummary } from '../services/money.js';
import { assertOperationalCountry, operationalCountriesFor } from '../services/authorization.js';
import { reviewChargeback, resolveChargeback } from '../services/chargebacks.js';
import { cursorScope, cursorSort, pageResult } from '../services/pagination.js';
import { writeAudit } from '../services/audit.js';
import { reconcileCod } from '../services/logistics.js';
import { getCountries } from '../services/country.js';
import { sellerFinanceStatement, streamSellerLedgerCsv } from '../services/seller-finance.js';

const router=Router();
const idem=z.string().trim().min(12).max(120);
router.post('/api/v1/orders/:orderId/payment-intents',async(req,res,next)=>{try{res.status(201).json({payment:await initiatePayment(req,{orderId:req.params.orderId,idempotencyKey:idem.parse(req.body.idempotencyKey)})});}catch(e){next(e);}});
router.get('/api/v1/orders/:orderId/payment',async(req,res,next)=>{try{const {intent}=await getPaymentIntentForOrder(req,req.params.orderId);res.set('Cache-Control','private, no-store').json({payment:intent?{id:intent.publicId,status:intent.status,provider:intent.provider,method:intent.method,amountMinor:intent.amountMinor,currency:intent.currency,paidAt:intent.paidAt}:null});}catch(e){next(e);}});
router.get('/payments/return',async(req,res,next)=>{try{
  const trackingId=String(req.query.OrderTrackingId||req.query.orderTrackingId||'').trim();
  const merchantRef=String(req.query.OrderMerchantReference||req.query.orderMerchantReference||'').trim();
  let intent=merchantRef?await PaymentIntent.findOne({provider:'pesapal',providerReference:merchantRef}):null;
  if(!intent&&trackingId)intent=await PaymentIntent.findOne({provider:'pesapal',providerTrackingId:trackingId});
  if(intent&&trackingId){
    if(intent.providerTrackingId&&intent.providerTrackingId!==trackingId)throw new AppError('Pesapal callback reference mismatch.',400,'PESAPAL_REFERENCE_MISMATCH');
    await verifyAndApplyPayment(intent.publicId,trackingId);
  }
  res.redirect(`/track-order?order=${encodeURIComponent(intent?.orderPublicId||'')}`);
}catch(e){next(e);}});
async function pesapalNotification(req,res,next){try{
  const body=req.body&&typeof req.body==='object'?req.body:{};
  const result=await processPesapalNotification(req.rawBody||JSON.stringify(body),body,req.query||{});
  const trackingId=String(req.query.OrderTrackingId||req.query.orderTrackingId||body.OrderTrackingId||body.orderTrackingId||'').trim();
  const merchantRef=String(req.query.OrderMerchantReference||req.query.orderMerchantReference||body.OrderMerchantReference||body.orderMerchantReference||'').trim();
  const notificationType=String(req.query.OrderNotificationType||req.query.orderNotificationType||body.OrderNotificationType||body.orderNotificationType||'IPNCHANGE').trim()||'IPNCHANGE';
  res.status(200).json({orderNotificationType:notificationType,orderTrackingId:trackingId,orderMerchantReference:merchantRef,status:200,accepted:true,duplicate:Boolean(result?.duplicate)});
}catch(e){next(e);}}
router.get('/webhooks/pesapal',pesapalNotification);
router.post('/webhooks/pesapal',pesapalNotification);
function financeOnly(req,_res,next){if(hasPermission(req.user,'finance:manage')||hasPermission(req.user,'finance:country')||req.user?.role==='super_admin')return next();return next(new AppError('Finance permission required.',403,'FORBIDDEN'));}
function financeCountryScope(user){const scopes=operationalCountriesFor(user);return scopes.includes('*')?{}:{country:{$in:scopes}};}
function csvCell(value){let text=String(value??'');if(/^[=+@-]/.test(text))text=`'${text}`;return `"${text.replaceAll('\"','\"\"')}"`;}
router.post('/api/v1/finance/refunds',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({orderId:z.string().min(4).max(100),amountMinor:z.coerce.number().int().positive().optional(),reason:z.string().trim().min(3).max(300),idempotencyKey:idem}).parse(req.body);res.status(201).json({refund:await createRefund(req,input)});}catch(e){next(e);}});
router.post('/api/v1/finance/refunds/:id/manual-complete',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reference:z.string().trim().min(4).max(180)}).parse(req.body);res.json({refund:await completeManualRefund(req,req.params.id,input)});}catch(e){next(e);}});
router.get('/finance',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{
  const scopes=operationalCountriesFor(req.user),pageSize=50;
  const requestedCountry=String(req.query.country||'').trim().toUpperCase();
  if(requestedCountry&&!/^[A-Z]{2}$/.test(requestedCountry))throw new AppError('Choose a valid two-letter finance country.',422,'FINANCE_COUNTRY_INVALID');
  if(requestedCountry)assertOperationalCountry(req.user,requestedCountry,'Finance country is outside your operational scope.');
  const q=requestedCountry?{country:requestedCountry}:financeCountryScope(req.user);
  const orderScope={...q,paymentState:{$in:['paid','partially_refunded']}};
  const [countryOrderIds,payoutAccountIds]=await Promise.all([
    Object.keys(q).length?Order.find(q).distinct('_id'):Promise.resolve(null),
    Object.keys(q).length?PayoutAccount.find(q).distinct('_id'):Promise.resolve(null),
  ]);
  const refundScope=countryOrderIds?{orderId:{$in:countryOrderIds}}:{};
  const payoutScope=payoutAccountIds?{payoutAccountId:{$in:payoutAccountIds}}:{};
  const reconScope={...q};
  const chargebackScope={...q};
  const providerEventScope={provider:'pesapal',...q};
  const paymentScope={...q};
  const codScope={...q,kind:'outbound',status:'delivered','cod.required':true,'cod.reconciledAt':null};
  const paymentStatus=String(req.query.paymentStatus||'').trim();
  const paymentProvider=String(req.query.paymentProvider||'').trim();
  const paymentSearch=String(req.query.paymentSearch||'').trim().slice(0,180);
  const refundStatus=String(req.query.refundStatus||'').trim();
  const refundSearch=String(req.query.refundSearch||'').trim().slice(0,180);
  const payoutStatus=String(req.query.payoutStatus||'').trim();
  const payoutSearch=String(req.query.payoutSearch||'').trim().slice(0,180);
  const chargebackStatus=String(req.query.chargebackStatus||'').trim();
  const chargebackSearch=String(req.query.chargebackSearch||'').trim().slice(0,180);
  const providerEventStatus=String(req.query.providerEventStatus||'').trim();
  const providerEventSearch=String(req.query.providerEventSearch||'').trim().slice(0,180);
  const reconciliationStatus=String(req.query.reconciliationStatus||'').trim();
  if(['created','requires_action','pending','succeeded','failed','cancelled','pending_collection','refunded','partially_refunded','reversed'].includes(paymentStatus))paymentScope.status=paymentStatus;
  if(['pesapal','cod','sandbox'].includes(paymentProvider))paymentScope.provider=paymentProvider;
  if(paymentSearch)paymentScope.$or=[{publicId:paymentSearch},{orderPublicId:paymentSearch},{traceId:paymentSearch.toLowerCase()},{providerReference:paymentSearch},{providerTrackingId:paymentSearch},{providerTransactionId:paymentSearch},{providerConfirmationCode:paymentSearch}];
  if(['pending','processing','completed','failed','cancelled'].includes(refundStatus))refundScope.status=refundStatus;
  if(refundSearch)refundScope.$or=[{publicId:refundSearch},{providerRefundId:refundSearch},{manualReference:refundSearch}];
  if(['requested','approved','submitting','submitted','unknown','paid','failed','rejected'].includes(payoutStatus))payoutScope.status=payoutStatus;
  if(payoutSearch)payoutScope.$or=[{publicId:payoutSearch},{providerReference:payoutSearch},{ownerStorePublicId:payoutSearch}];
  if(['open','reviewing','won','lost'].includes(chargebackStatus))chargebackScope.status=chargebackStatus;
  if(chargebackSearch)chargebackScope.$or=[{publicId:chargebackSearch},{orderPublicId:chargebackSearch},{paymentIntentPublicId:chargebackSearch},{providerTrackingId:chargebackSearch},{providerReference:chargebackSearch}];
  if(['received','processing','processed','ignored','failed','dead'].includes(providerEventStatus))providerEventScope.status=providerEventStatus;
  if(providerEventSearch)providerEventScope.$or=[{publicId:providerEventSearch},{eventId:providerEventSearch},{traceId:providerEventSearch.toLowerCase()},{orderPublicId:providerEventSearch},{paymentIntentPublicId:providerEventSearch},{merchantReference:providerEventSearch},{providerTrackingId:providerEventSearch}];
  if(['running','completed','failed'].includes(reconciliationStatus))reconScope.status=reconciliationStatus;
  const pageQuery=(Model,base,cursor,{field='createdAt',direction=-1,select=''}={})=>{let query=Model.find(cursorScope(base,cursor,{field,direction})).sort(cursorSort(field,direction)).limit(pageSize+1);if(select)query=query.select(select);return query;};
  const [paymentRows,refundableRows,accountRows,transactionRows,refundRows,payoutRows,reconRows,payoutAccountRows,chargebackRows,providerEventRows,codRows,paymentTotal,refundableTotal,accountTotal,transactionTotal,refundTotal,payoutTotal,reconTotal,payoutAccountTotal,chargebackTotal,providerEventTotal,codTotal,providerExceptionCount,payoutUnknownCount,reconciliationExceptionCount,staleRefundCount,openChargebackCount]=await Promise.all([
    pageQuery(PaymentIntent,paymentScope,req.query.paymentsAfter).lean(),
    pageQuery(Order,orderScope,req.query.ordersAfter,{select:'publicId status paymentState refundState totals contact createdAt country'}).lean(),
    pageQuery(LedgerAccount,q,req.query.accountsAfter).lean(),
    pageQuery(LedgerTransaction,q,req.query.transactionsAfter,{field:'postedAt'}).lean(),
    pageQuery(Refund,refundScope,req.query.refundsAfter).lean(),
    pageQuery(Payout,payoutScope,req.query.payoutsAfter).lean(),
    pageQuery(ReconciliationRun,reconScope,req.query.reconciliationAfter).lean(),
    pageQuery(PayoutAccount,q,req.query.payoutAccountsAfter,{select:'-destinationEncrypted'}).lean(),
    pageQuery(Chargeback,chargebackScope,req.query.chargebacksAfter,{field:'openedAt'}).lean(),
    pageQuery(ProviderEvent,providerEventScope,req.query.providerEventsAfter,{select:'-rawEncrypted -rawHash'}).lean(),
    pageQuery(Shipment,codScope,req.query.codAfter,{field:'deliveredAt'}).lean(),
    PaymentIntent.countDocuments(paymentScope),Order.countDocuments(orderScope),LedgerAccount.countDocuments(q),LedgerTransaction.countDocuments(q),Refund.countDocuments(refundScope),Payout.countDocuments(payoutScope),ReconciliationRun.countDocuments(reconScope),PayoutAccount.countDocuments(q),Chargeback.countDocuments(chargebackScope),ProviderEvent.countDocuments(providerEventScope),Shipment.countDocuments(codScope),
    ProviderEvent.countDocuments({...q,provider:'pesapal',$or:[{status:{$in:['failed','dead']}},{orderPublicId:''}]}),
    Payout.countDocuments({...((payoutAccountIds)?{payoutAccountId:{$in:payoutAccountIds}}:{}),status:'unknown'}),
    ReconciliationRun.countDocuments({...q,$or:[{status:'failed'},{failed:{$gt:0}}]}),
    Refund.countDocuments({...((countryOrderIds)?{orderId:{$in:countryOrderIds}}:{}),status:'processing',updatedAt:{$lt:new Date(Date.now()-2*60*60_000)}}),
    Chargeback.countDocuments({...q,status:{$in:['open','reviewing']}}),
  ]);
  const pages={
    payments:pageResult(paymentRows,{limit:pageSize,total:paymentTotal}),orders:pageResult(refundableRows,{limit:pageSize,total:refundableTotal}),accounts:pageResult(accountRows,{limit:pageSize,total:accountTotal}),transactions:pageResult(transactionRows,{field:'postedAt',limit:pageSize,total:transactionTotal}),refunds:pageResult(refundRows,{limit:pageSize,total:refundTotal}),payouts:pageResult(payoutRows,{limit:pageSize,total:payoutTotal}),reconciliations:pageResult(reconRows,{limit:pageSize,total:reconTotal}),payoutAccounts:pageResult(payoutAccountRows,{limit:pageSize,total:payoutAccountTotal}),chargebacks:pageResult(chargebackRows,{field:'openedAt',limit:pageSize,total:chargebackTotal}),providerEvents:pageResult(providerEventRows,{limit:pageSize,total:providerEventTotal}),cod:pageResult(codRows,{field:'deliveredAt',limit:pageSize,total:codTotal}),
  };
  const payments=pages.payments.items,refundableOrders=pages.orders.items,accounts=pages.accounts.items,transactions=pages.transactions.items,refunds=pages.refunds.items,payouts=pages.payouts.items,reconciliations=pages.reconciliations.items,payoutAccounts=pages.payoutAccounts.items,chargebacks=pages.chargebacks.items,providerEvents=pages.providerEvents.items,codShipments=pages.cod.items;
  const accountIds=accounts.map(row=>row._id);const balanceRows=accountIds.length?await LedgerTransaction.aggregate([{$match:{...q,'entries.accountId':{$in:accountIds}}},{$unwind:'$entries'},{$match:{'entries.accountId':{$in:accountIds}}},{$group:{_id:'$entries.accountId',debits:{$sum:'$entries.debitMinor'},credits:{$sum:'$entries.creditMinor'}}}]):[];
  const balanceByAccount=new Map(balanceRows.map(row=>[String(row._id),{debits:Number(row.debits||0),credits:Number(row.credits||0)}]));
  const accountsWithBalance=accounts.map(account=>{const totals=balanceByAccount.get(String(account._id))||{debits:0,credits:0};const balanceMinor=['asset','expense'].includes(account.type)?totals.debits-totals.credits:totals.credits-totals.debits;return {...account,balanceMinor,debitsMinor:totals.debits,creditsMinor:totals.credits};});
  const orderIds=refundableOrders.map(row=>row._id);
  const refundTotals=orderIds.length?await Refund.aggregate([{$match:{orderId:{$in:orderIds},status:{$in:['processing','completed']}}},{$group:{_id:'$orderId',total:{$sum:'$amountMinor'}}}]):[];
  const refundedByOrder=new Map(refundTotals.map(row=>[String(row._id),Number(row.total||0)]));
  const eligibleRefundOrders=refundableOrders.map(order=>({...order,remainingMinor:Math.max(0,Number(order.totals.totalMinor||0)-(refundedByOrder.get(String(order._id))||0))})).filter(order=>order.remainingMinor>0);
  const financeExceptions={providerEvents:providerExceptionCount,payoutUnknown:payoutUnknownCount,reconciliation:reconciliationExceptionCount,staleRefunds:staleRefundCount,openChargebacks:openChargebackCount,codPending:codTotal,total:providerExceptionCount+payoutUnknownCount+reconciliationExceptionCount+staleRefundCount+openChargebackCount+codTotal};
  const financeFilters={country:requestedCountry,paymentStatus,paymentProvider,paymentSearch,refundStatus,refundSearch,payoutStatus,payoutSearch,chargebackStatus,chargebackSearch,providerEventStatus,providerEventSearch,reconciliationStatus};
  const paymentFilters={status:paymentStatus,provider:paymentProvider,search:paymentSearch};
  const financeQuery=new URLSearchParams(Object.entries(financeFilters).filter(([,value])=>value)).toString();
  const financeSuffix=financeQuery?`&${financeQuery}`:'';
  const availableCountries=(await getCountries()).filter(country=>scopes.includes('*')||scopes.includes(country.code));
  res.set('Cache-Control','private, no-store');res.render('money-workspace',{payments,accounts:accountsWithBalance,transactions,refunds,payouts,reconciliations,payoutAccounts,eligibleRefundOrders,chargebacks,providerEvents,codShipments,financeExceptions,financeFilters,paymentFilters,financeQuery,financeSuffix,availableCountries,queuePages:Object.fromEntries(Object.entries(pages).map(([name,value])=>[name,value.page]))});
}catch(e){next(e);}});

router.get('/finance/ledger.csv',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{
  const scope=financeCountryScope(req.user),fromRaw=String(req.query.from||'').trim(),toRaw=String(req.query.to||'').trim(),ownerType=String(req.query.ownerType||'').trim();const match={...scope};
  if(fromRaw||toRaw){match.postedAt={};if(fromRaw){const from=new Date(`${fromRaw}T00:00:00.000Z`);if(Number.isNaN(from.getTime()))throw new AppError('Invalid ledger export start date.',422,'FINANCE_DATE_INVALID');match.postedAt.$gte=from;}if(toRaw){const to=new Date(`${toRaw}T23:59:59.999Z`);if(Number.isNaN(to.getTime()))throw new AppError('Invalid ledger export end date.',422,'FINANCE_DATE_INVALID');match.postedAt.$lte=to;}}
  const accountMatch={};if(['platform','store','promoter','delivery','provider','customer'].includes(ownerType))accountMatch['account.ownerType']=ownerType;
  const pipeline=[{$match:match},{$unwind:'$entries'},{$lookup:{from:'ledgeraccounts',localField:'entries.accountId',foreignField:'_id',as:'account'}},{$unwind:'$account'},...(Object.keys(accountMatch).length?[{$match:accountMatch}]:[]),{$sort:{postedAt:1,_id:1}},{$project:{_id:0,transactionPublicId:'$publicId',traceId:1,postedAt:1,referenceType:1,referencePublicId:1,country:1,currency:1,description:1,accountCode:'$account.code',accountType:'$account.type',ownerType:'$account.ownerType',ownerPublicId:'$account.ownerPublicId',debitMinor:'$entries.debitMinor',creditMinor:'$entries.creditMinor',memo:'$entries.memo'}}];
  res.status(200);res.set('Content-Type','text/csv; charset=utf-8');res.set('Content-Disposition',`attachment; filename="classic-mart-ledger-${new Date().toISOString().slice(0,10)}.csv"`);res.set('Cache-Control','private, no-store');
  res.write(['transaction','trace_id','posted_at','reference_type','reference','country','currency','description','account_code','account_type','owner_type','owner','debit_minor','credit_minor','memo'].map(csvCell).join(',')+'\n');
  let rowCount=0;const cursor=LedgerTransaction.aggregate(pipeline).cursor({batchSize:250});for await(const row of cursor){res.write([row.transactionPublicId,row.traceId||'legacy unavailable',row.postedAt?.toISOString?.()||'',row.referenceType,row.referencePublicId,row.country,row.currency,row.description,row.accountCode,row.accountType,row.ownerType,row.ownerPublicId||'',row.debitMinor,row.creditMinor,row.memo].map(csvCell).join(',')+'\n');rowCount+=1;}
  await writeAudit(req,'finance.ledger_exported',{targetType:'ledger',targetPublicId:'scoped-export',metadata:{rowCount,from:fromRaw,to:toRaw,ownerType:ownerType||'all'}});return res.end();
}catch(e){next(e);}});

router.post('/api/v1/payout-accounts',requireAuth,requireVerified,async(req,res,next)=>{try{const input=z.object({method:z.enum(['mobile_money','bank']),label:z.string().trim().min(2).max(100),destination:z.object({account_bank:z.string().trim().min(2).max(40).optional(),network:z.string().trim().min(2).max(40).optional(),account_number:z.string().trim().min(4).max(80).optional(),phone:z.string().trim().min(7).max(32).optional(),beneficiary_name:z.string().trim().min(2).max(120)}).refine(v=>(v.account_bank||v.network)&&(v.account_number||v.phone),{message:'Bank/network and account/phone are required.'})}).parse(req.body);res.status(201).json({account:await savePayoutAccount(req,input)});}catch(e){next(e);}});
router.get('/api/v1/payout-accounts',requireAuth,requireVerified,async(req,res,next)=>{try{res.json({accounts:await payoutAccountsForRequest(req)});}catch(e){next(e);}});
router.post('/api/v1/payouts',requireAuth,requireVerified,async(req,res,next)=>{try{const input=z.object({payoutAccountId:z.string().min(4).max(100),amountMinor:z.coerce.number().int().positive(),idempotencyKey:idem}).parse(req.body);res.status(201).json({payout:await requestPayout(req,input)});}catch(e){next(e);}});
router.post('/api/v1/finance/payout-accounts/:id/verify',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const account=await PayoutAccount.findOne({publicId:req.params.id});if(account)assertOperationalCountry(req.user,account.country,'Payout account is outside your country scope.');if(!account)throw new AppError('Payout account not found.',404,'PAYOUT_ACCOUNT_NOT_FOUND');account.status='verified';account.verifiedAt=new Date();await account.save();res.json({ok:true});}catch(e){next(e);}});
router.post('/api/v1/finance/payouts/:id/approve',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const payout=await Payout.findOne({publicId:req.params.id,status:'requested'});if(payout&&req.user.role!=='super_admin'){const pa=await PayoutAccount.findById(payout.payoutAccountId).lean();if(pa)assertOperationalCountry(req.user,pa.country,'Payout is outside your country scope.');}if(!payout)throw new AppError('Requested payout not found.',404,'PAYOUT_NOT_FOUND');if((payout.requestedByUserId||payout.ownerUserId).equals(req.user._id))throw new AppError('You cannot approve a payout you requested.',403,'FOUR_EYES_REQUIRED');payout.status='approved';payout.approvedByUserId=req.user._id;payout.approvedAt=new Date();await payout.save();res.json({ok:true,payout});}catch(e){next(e);}});
router.post('/api/v1/finance/payouts/:id/reject',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reason:z.string().trim().min(3).max(300)}).parse(req.body);const payout=await rejectPayout(req,req.params.id,input);await writeAudit(req,'finance.payout_rejected',{targetType:'payout',targetPublicId:payout.publicId,metadata:{reason:input.reason}});res.json({payout});}catch(e){next(e);}});
router.post('/api/v1/finance/reconciliation',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({hours:z.coerce.number().int().min(1).max(168).default(24)}).parse(req.body||{});res.status(201).json({run:await reconcilePayments(req,input)});}catch(e){next(e);}});
router.post('/api/v1/finance/provider-events/:id/replay',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reason:z.string().trim().min(5).max(300)}).parse(req.body||{});const event=await requeueProviderEvent(req,req.params.id,input);await writeAudit(req,'finance.provider_event_requeued',{targetType:'provider_event',targetPublicId:event.publicId,metadata:{reason:input.reason,replayCount:event.manualReplayCount}});res.json({event:{id:event.publicId,status:event.status,nextAttemptAt:event.nextAttemptAt,manualReplayCount:event.manualReplayCount}});}catch(e){next(e);}});
router.post('/api/v1/finance/payouts/:id/submit',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const payout=await submitPayout(req,req.params.id);await writeAudit(req,'finance.payout_submission_started',{targetType:'payout',targetPublicId:payout.publicId,metadata:{submissionAttemptId:payout.submissionAttemptId}});res.json({payout});}catch(e){next(e);}});
router.post('/api/v1/finance/payouts/:id/submission-confirm',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reference:z.string().trim().min(4).max(180)}).parse(req.body);const payout=await confirmPayoutSubmission(req,req.params.id,input);await writeAudit(req,'finance.payout_submission_confirmed',{targetType:'payout',targetPublicId:payout.publicId,metadata:{submissionAttemptId:payout.submissionAttemptId}});res.json({payout});}catch(e){next(e);}});
router.post('/api/v1/finance/payouts/:id/unknown',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reason:z.string().trim().min(8).max(400)}).parse(req.body);const payout=await markPayoutUnknown(req,req.params.id,input);await writeAudit(req,'finance.payout_marked_unknown',{targetType:'payout',targetPublicId:payout.publicId,metadata:{reason:input.reason}});res.json({payout});}catch(e){next(e);}});
router.post('/api/v1/finance/payouts/:id/reconcile',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reference:z.string().trim().min(4).max(180),outcome:z.enum(['paid','failed']),message:z.string().trim().max(400).optional().default('')}).parse(req.body);const payout=await reconcilePayout(req,req.params.id,{reference:input.reference,success:input.outcome==='paid',message:input.message});await writeAudit(req,'finance.payout_reconciled',{targetType:'payout',targetPublicId:payout.publicId,metadata:{outcome:input.outcome}});res.json({payout});}catch(e){next(e);}});


router.post('/api/v1/finance/chargebacks/:id/review',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({note:z.string().trim().max(500).optional().default('')}).parse(req.body||{});res.json({chargeback:await reviewChargeback(req,req.params.id,input.note)});}catch(e){next(e);}});
router.post('/api/v1/finance/chargebacks/:id/resolve',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({outcome:z.enum(['won','lost']),note:z.string().trim().max(500).optional().default('')}).parse(req.body||{});res.json({chargeback:await resolveChargeback(req,req.params.id,input)});}catch(e){next(e);}});
router.post('/finance/chargebacks/:id/review',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{await reviewChargeback(req,req.params.id,String(req.body.note||'').slice(0,500));res.redirect('/finance');}catch(e){next(e);}});
router.post('/finance/chargebacks/:id/resolve',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({outcome:z.enum(['won','lost']),note:z.string().trim().max(500).optional().default('')}).parse(req.body);await resolveChargeback(req,req.params.id,input);res.redirect('/finance');}catch(e){next(e);}});


router.post('/finance/cod/:id/reconcile',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const shipment=await Shipment.findOne({publicId:req.params.id,...financeCountryScope(req.user),kind:'outbound',status:'delivered','cod.required':true,'cod.reconciledAt':null});if(!shipment)throw new AppError('Pending COD shipment not found.',404,'COD_NOT_FOUND');assertOperationalCountry(req.user,shipment.country,'COD shipment is outside your operational scope.');await reconcileCod({shipment,actorUserId:req.user._id});await writeAudit(req,'finance.cod_reconciled',{targetType:'shipment',targetPublicId:shipment.publicId,country:shipment.country});res.redirect('/finance');}catch(e){next(e);}});

router.get('/money',requireAuth,requireVerified,async(req,res,next)=>{try{
  const owner=await payoutOwnerContext(req);
  const [accounts,payoutAccounts,payoutPage,statement]=await Promise.all([
    moneySummary({ownerType:owner.ownerType,ownerPublicId:owner.ownerPublicId,country:owner.country,currency:owner.currency}),
    payoutAccountsForRequest(req),
    payoutsForRequest(req,{cursor:req.query.after,withPage:true}),
    owner.ownerType==='store'?sellerFinanceStatement({store:owner.store,activityCursor:req.query.activityAfter,orderCursor:req.query.ordersAfter,refundCursor:req.query.refundsAfter}):Promise.resolve(null),
  ]);
  res.set('Cache-Control','private, no-store').render('payout-workspace',{accounts,payoutAccounts,payouts:payoutPage.items,owner,queuePage:payoutPage.page,statement});
}catch(e){next(e);}});
router.post('/money/workspace',requireAuth,requireVerified,async(req,res,next)=>{try{
  const storePublicId=z.string().trim().min(4).max(100).parse(req.body.storePublicId);
  const owner=await payoutOwnerContext(req,{preferredStorePublicId:storePublicId,strictPreferred:true});
  if(owner.ownerType!=='store')throw new AppError('Seller finance workspace is required.',403,'PAYOUT_WORKSPACE_FORBIDDEN');
  await writeAudit(req,'seller.finance_workspace.selected',{targetType:'store',targetPublicId:owner.ownerStorePublicId,country:owner.country});
  res.redirect('/money');
}catch(e){next(e);}});
router.get('/money/statement.csv',requireAuth,requireVerified,async(req,res,next)=>{try{
  const owner=await payoutOwnerContext(req);
  if(owner.ownerType!=='store')throw new AppError('Seller settlement export is available only to seller finance workspaces.',403,'SELLER_FINANCE_REQUIRED');
  const filename=`classic-mart-${owner.ownerStorePublicId}-settlement.csv`;
  res.status(200).set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${filename}"`,'Cache-Control':'private, no-store'});
  await streamSellerLedgerCsv({store:owner.store,response:res});
  await writeAudit(req,'seller.settlement.exported',{targetType:'store',targetPublicId:owner.ownerStorePublicId,country:owner.country});
  res.end();
}catch(e){next(e);}});
router.post('/money/payout-accounts',requireAuth,requireVerified,async(req,res,next)=>{try{const method=z.enum(['mobile_money','bank']).parse(req.body.method);const destination={account_bank:String(req.body.account_bank||'').trim(),network:String(req.body.network||'').trim(),account_number:String(req.body.account_number||'').trim(),phone:String(req.body.phone||'').trim(),beneficiary_name:String(req.body.beneficiary_name||'').trim()};if(!(destination.account_bank||destination.network)||!(destination.account_number||destination.phone)||destination.beneficiary_name.length<2)throw new AppError('Complete the payout destination.',422,'PAYOUT_DESTINATION_INVALID');await savePayoutAccount(req,{method,label:z.string().trim().min(2).max(100).parse(req.body.label),destination});res.redirect('/money');}catch(e){next(e);}});
router.post('/money/payouts',requireAuth,requireVerified,async(req,res,next)=>{try{await requestPayout(req,{payoutAccountId:z.string().min(4).max(100).parse(req.body.payoutAccountId),amountMinor:z.coerce.number().int().positive().parse(req.body.amountMinor),idempotencyKey:idem.parse(req.body.idempotencyKey)});res.redirect('/money');}catch(e){next(e);}});
router.post('/finance/refunds',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({orderId:z.string().min(4).max(100),amountMinor:z.coerce.number().int().positive().optional(),reason:z.string().trim().min(3).max(300),idempotencyKey:idem}).parse(req.body);await createRefund(req,input);res.redirect('/finance');}catch(e){next(e);}});
router.post('/finance/refunds/:id/manual-complete',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reference:z.string().trim().min(4).max(180)}).parse(req.body);await completeManualRefund(req,req.params.id,input);res.redirect('/finance');}catch(e){next(e);}});
router.post('/finance/reconciliation',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{await reconcilePayments(req,{hours:z.coerce.number().int().min(1).max(168).default(24).parse(req.body.hours)});res.redirect('/finance');}catch(e){next(e);}});
router.post('/finance/provider-events/:id/replay',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reason:z.string().trim().min(5).max(300)}).parse(req.body||{});const event=await requeueProviderEvent(req,req.params.id,input);await writeAudit(req,'finance.provider_event_requeued',{targetType:'provider_event',targetPublicId:event.publicId,metadata:{reason:input.reason,replayCount:event.manualReplayCount}});res.redirect('/finance');}catch(e){next(e);}});
router.post('/finance/payout-accounts/:id/verify',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const account=await PayoutAccount.findOne({publicId:req.params.id});if(!account)throw new AppError('Payout account not found.',404,'PAYOUT_ACCOUNT_NOT_FOUND');assertOperationalCountry(req.user,account.country,'Payout account is outside your country scope.');account.status='verified';account.verifiedAt=new Date();await account.save();res.redirect('/finance');}catch(e){next(e);}});
router.post('/finance/payouts/:id/approve',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const payout=await Payout.findOne({publicId:req.params.id,status:'requested'});if(!payout)throw new AppError('Requested payout not found.',404,'PAYOUT_NOT_FOUND');const account=await PayoutAccount.findById(payout.payoutAccountId);if(account)assertOperationalCountry(req.user,account.country,'Payout is outside your country scope.');if((payout.requestedByUserId||payout.ownerUserId).equals(req.user._id))throw new AppError('You cannot approve a payout you requested.',403,'FOUR_EYES_REQUIRED');payout.status='approved';payout.approvedByUserId=req.user._id;payout.approvedAt=new Date();await payout.save();res.redirect('/finance');}catch(e){next(e);}});
router.post('/finance/payouts/:id/reject',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reason:z.string().trim().min(3).max(300)}).parse(req.body);const payout=await rejectPayout(req,req.params.id,input);await writeAudit(req,'finance.payout_rejected',{targetType:'payout',targetPublicId:payout.publicId,metadata:{reason:input.reason}});res.redirect('/finance');}catch(e){next(e);}});
router.post('/finance/payouts/:id/submit',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const payout=await submitPayout(req,req.params.id);await writeAudit(req,'finance.payout_submission_started',{targetType:'payout',targetPublicId:payout.publicId,metadata:{submissionAttemptId:payout.submissionAttemptId}});res.redirect('/finance');}catch(e){next(e);}});
router.post('/finance/payouts/:id/submission-confirm',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reference:z.string().trim().min(4).max(180)}).parse(req.body);const payout=await confirmPayoutSubmission(req,req.params.id,input);await writeAudit(req,'finance.payout_submission_confirmed',{targetType:'payout',targetPublicId:payout.publicId,metadata:{submissionAttemptId:payout.submissionAttemptId}});res.redirect('/finance');}catch(e){next(e);}});
router.post('/finance/payouts/:id/unknown',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reason:z.string().trim().min(8).max(400)}).parse(req.body);const payout=await markPayoutUnknown(req,req.params.id,input);await writeAudit(req,'finance.payout_marked_unknown',{targetType:'payout',targetPublicId:payout.publicId,metadata:{reason:input.reason}});res.redirect('/finance');}catch(e){next(e);}});
router.post('/finance/payouts/:id/reconcile',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{const input=z.object({reference:z.string().trim().min(4).max(180),outcome:z.enum(['paid','failed']),message:z.string().trim().max(400).optional().default('')}).parse(req.body);const payout=await reconcilePayout(req,req.params.id,{reference:input.reference,success:input.outcome==='paid',message:input.message});await writeAudit(req,'finance.payout_reconciled',{targetType:'payout',targetPublicId:payout.publicId,metadata:{outcome:input.outcome}});res.redirect('/finance');}catch(e){next(e);}});


export default router;

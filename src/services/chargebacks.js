import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import {
  Chargeback, CommissionEntry, LedgerAccount, LedgerTransaction, Order, PaymentIntent, Refund,
} from '../models/index.js';
import { assertOperationalCountry } from './authorization.js';
import { ensureLedgerAccount, postLedgerTransaction } from './money.js';
import { issueFinancialDocument } from './financial-documents.js';
import { syncLegacyOrderStatus } from './order-state.js';
import { financeAccess } from './finance-workspace-access.js';
import { writeAudit } from './audit.js';
import { getPesapalTransactionStatus } from './pesapal.js';
import { queueFinanceAlert } from './finance-notifications.js';

function payloadHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex');
}

async function transactionByKeys(keys, session) {
  for (const idempotencyKey of keys) {
    const tx = await LedgerTransaction.findOne({ idempotencyKey }).session(session);
    if (tx) return tx;
  }
  return null;
}

async function netPaymentExposure(order, intent, session) {
  const original = await transactionByKeys([
    `payment:${intent.publicId}`,
    `business-invoice-payment:${intent.publicId}`,
  ], session);
  if (!original) throw new AppError('Original payment ledger transaction is missing for the reversed Pesapal payment.', 409, 'CHARGEBACK_LEDGER_MISSING');
  if(original.country!==order.country||original.currency!==intent.currency||original.referencePublicId!==intent.publicId&&original.referenceType!=='business_invoice_payment')throw new AppError('Original payment ledger does not match the chargeback market or payment.',409,'CHARGEBACK_LEDGER_MISMATCH');

  const refunds = await Refund.find({ paymentIntentId: intent._id, status: 'completed' }).select('publicId amountMinor currency orderId').session(session).lean();
  const transactions = [original];
  for (const refund of refunds) {
    const tx = await LedgerTransaction.findOne({ idempotencyKey: `refund:${refund.publicId}` }).session(session);
    if(!tx||String(refund.orderId)!==String(order._id)||refund.currency!==intent.currency||tx.country!==order.country||tx.currency!==intent.currency||tx.referencePublicId!==refund.publicId)throw new AppError('Completed refund ledger evidence is missing or does not match this chargeback.',409,'CHARGEBACK_REFUND_LEDGER_MISSING');
    transactions.push(tx);
  }

  const net = new Map();
  for (const tx of transactions) {
    for (const entry of tx.entries || []) {
      const key = String(entry.accountId);
      const row = net.get(key) || { accountId: entry.accountId, debitMinusCredit: 0 };
      row.debitMinusCredit += Number(entry.debitMinor || 0) - Number(entry.creditMinor || 0);
      net.set(key, row);
    }
  }
  const accountIds = [...net.values()].filter(row => row.debitMinusCredit !== 0).map(row => row.accountId);
  const accounts = await LedgerAccount.find({ _id: { $in: accountIds } }).session(session);
  const byId = new Map(accounts.map(account => [String(account._id), account]));
  const reversalEntries = [];
  for (const row of net.values()) {
    if (!row.debitMinusCredit) continue;
    const account = byId.get(String(row.accountId));
    if (!account) throw new AppError('A ledger account required for chargeback reversal is missing.', 409, 'CHARGEBACK_ACCOUNT_MISSING');
    if (row.debitMinusCredit > 0) reversalEntries.push({ account, debitMinor: 0, creditMinor: row.debitMinusCredit, memo: `Reverse remaining exposure for ${intent.publicId}` });
    else reversalEntries.push({ account, debitMinor: -row.debitMinusCredit, creditMinor: 0, memo: `Reverse remaining exposure for ${intent.publicId}` });
  }
  const completedRefundMinor = refunds.reduce((sum, refund) => sum + Number(refund.amountMinor || 0), 0);
  if(!Number.isSafeInteger(completedRefundMinor)||completedRefundMinor>intent.amountMinor)throw new AppError('Chargeback refund totals exceed the payment.',409,'CHARGEBACK_REFUND_TOTAL_INVALID');
  return { original, reversalEntries, amountMinor: Math.max(0, Number(intent.amountMinor || 0) - completedRefundMinor) };
}

async function reversePromoterExposure(order, chargeback, session) {
  const commissions = await CommissionEntry.find({ orderId: order._id, status: { $in: ['pending', 'payable', 'partially_reversed', 'paid'] } }).session(session);
  const snapshots = [];
  for (const commission of commissions) {
    if(commission.currency!==order.totals.currency)throw new AppError('Promoter exposure currency does not match the chargeback order.',409,'CHARGEBACK_COMMISSION_CHANGED');
    const priorReversed = Number(commission.reversedAmountMinor || 0);
    const remaining = Math.max(0, Number(commission.amountMinor || 0) - priorReversed);
    if (!remaining) continue;
    const priorStatus = commission.status;
    const posted=priorStatus!=='pending'&&Boolean(commission.payableAt);
    snapshots.push({ commissionId: commission._id, commissionPublicId: commission.publicId, amountMinor: remaining, priorStatus, priorReversedAmountMinor: priorReversed, posted });
    if (posted) {
      const payable = await ensureLedgerAccount({ code: 'promoter_payable', type: 'liability', ownerType: 'promoter', ownerId: commission.promoterUserId, ownerPublicId: String(commission.promoterUserId), country: order.country, currency: commission.currency }, session);
      const expense = await ensureLedgerAccount({ code: 'promoter_commission_expense', type: 'expense', ownerType: 'platform', ownerPublicId: 'classic-mart', country: order.country, currency: commission.currency }, session);
      await postLedgerTransaction({ idempotencyKey: `chargeback-commission:${chargeback.publicId}:${commission.publicId}`, referenceType: 'chargeback_commission', referencePublicId: chargeback.publicId, currency: commission.currency, country: order.country, description: `Promoter commission chargeback ${chargeback.publicId}`, entries: [{ account: payable, debitMinor: remaining, creditMinor: 0, memo: 'Claw back promoter payable after provider reversal' }, { account: expense, debitMinor: 0, creditMinor: remaining, memo: 'Reverse promoter acquisition expense after provider reversal' }] }, session);
    }
    commission.reversedAmountMinor = priorReversed + remaining;
    commission.reversalReason = `Provider chargeback ${chargeback.publicId}`;
    commission.reversedAt = new Date();
    commission.status = 'reversed';
    await commission.save({ session });
  }
  return snapshots;
}

export async function recordProviderChargeback({ order: orderLike, intent: intentLike, providerPayload = {}, financeRequest = null, providerOutcome = null }) {
  const existing = await Chargeback.findOne({ paymentIntentId: intentLike._id });
  if (existing) return existing;
  const session = await mongoose.startSession();
  let created;
  try {
    await session.withTransaction(async () => {
      const intent = await PaymentIntent.findById(intentLike._id).session(session);
      const order = await Order.findById(orderLike._id).session(session);
      if (!intent || !order) throw new AppError('Chargeback payment/order records are missing.', 409, 'CHARGEBACK_SOURCE_MISSING');
      if(String(intent.orderId)!==String(order._id)||intent.orderPublicId!==order.publicId||intent.country!==order.country||intent.currency!==order.totals.currency||intent.amountMinor!==order.totals.totalMinor)throw new AppError('Chargeback payment and order market or amount do not match.',409,'CHARGEBACK_SOURCE_CHANGED');
      if(financeRequest)await financeAccess(financeRequest,{session,write:true,workspace:false,country:order.country});
      const raced = await Chargeback.findOne({ paymentIntentId: intent._id }).session(session);
      if (raced) { created = raced; return; }
      if(providerOutcome){
        if(providerOutcome.version!==Number(intent.__v||0)||providerOutcome.providerStatus!=='REVERSED'||providerOutcome.providerTrackingId!==intent.providerTrackingId)throw new AppError('The original payment changed during provider verification.',409,'CHARGEBACK_SOURCE_CHANGED');
        intent.status='reversed';intent.activeKey=undefined;intent.reversedAt=intent.reversedAt||new Date();
        intent.lastVerifiedAt=providerOutcome.lastVerifiedAt;intent.providerStatus='REVERSED';intent.providerTransactionId=providerOutcome.providerTrackingId;
        intent.providerConfirmationCode=providerOutcome.providerConfirmationCode;intent.providerPaymentMethod=providerOutcome.providerPaymentMethod;
      }
      const exposure = await netPaymentExposure(order, intent, session);
      const chargebackPublicId = publicId('cbk');
      const docs = await Chargeback.create([{
        publicId: chargebackPublicId,
        orderId: order._id,
        orderPublicId: order.publicId,
        paymentIntentId: intent._id,
        paymentIntentPublicId: intent.publicId,
        provider: 'pesapal',
        providerTrackingId: intent.providerTrackingId || '',
        providerReference: intent.providerReference || '',
        providerPayloadHash: payloadHash(providerPayload),
        country: order.country,
        currency: intent.currency,
        amountMinor: exposure.amountMinor,
        status: 'open',
        timeline: [{ type: 'chargeback.opened', message: 'Pesapal reported the payment as reversed. Remaining financial exposure was frozen for finance review.' }],
      }], { session });
      const chargeback = docs[0];
      if (exposure.reversalEntries.length) {
        const tx = await postLedgerTransaction({ idempotencyKey: `chargeback:${intent.publicId}`, referenceType: 'chargeback', referencePublicId: chargeback.publicId, currency: intent.currency, country: order.country, description: `Pesapal chargeback reversal for ${order.publicId}`, entries: exposure.reversalEntries }, session);
        chargeback.reversalLedgerTransactionPublicId = tx.publicId;
      }
      chargeback.commissionReversals = await reversePromoterExposure(order, chargeback, session);
      order.paymentState = 'failed';
      syncLegacyOrderStatus(order);
      order.timeline.push({ type: 'payment.chargeback_opened', message: `Pesapal reversal opened finance chargeback ${chargeback.publicId}.` });
      await issueFinancialDocument({ type: 'chargeback_notice', eventKey: `chargeback_notice:${chargeback.publicId}`, order, intent, amountMinor: exposure.amountMinor, extra: { chargeback: { id: chargeback.publicId, status: 'open', openedAt: chargeback.openedAt, provider: 'pesapal' } }, session });
      await chargeback.save({ session });
      await order.save({ session });
      if(providerOutcome)await intent.save({session});
      await queueFinanceAlert({country:order.country,kind:'escalation',href:'/finance/disputes?selected='+encodeURIComponent(chargeback.publicId)+'&country='+order.country},session);
      await writeAudit(financeRequest||{id:'provider-chargeback:'+chargeback.publicId,ip:'',get:()=>''},financeRequest?'finance.payment_provider_verified':'finance.provider_chargeback_recorded',{targetType:'chargeback',targetPublicId:chargeback.publicId,country:order.country,metadata:{providerStatus:'REVERSED',status:'open',amountMinor:exposure.amountMinor,currency:intent.currency},session});
      created = chargeback;
    });
  } catch (error) {
    if (error?.code === 11000) return Chargeback.findOne({ paymentIntentId: intentLike._id });
    throw error;
  } finally { await session.endSession(); }
  return created;
}

function assertFinanceScope(request, chargeback) {
  assertOperationalCountry(request.user, chargeback.country, 'Chargeback is outside your operational country scope.');
}

export async function reviewChargeback(request, chargebackPublicId, note = '') {
  const cleanNote=String(note||'').trim();
  if(cleanNote.length<5||cleanNote.length>500)throw new AppError('Add a review note between 5 and 500 characters.',422,'CHARGEBACK_NOTE_REQUIRED');
  const session=await mongoose.startSession();let result;
  try{await session.withTransaction(async()=>{
    const chargeback=await Chargeback.findOne({publicId:chargebackPublicId,status:'open'}).session(session);
    if(!chargeback)throw new AppError('Open chargeback not found.',404,'CHARGEBACK_NOT_FOUND');
    const access=await financeAccess(request,{session,write:true,workspace:false,country:chargeback.country});
    chargeback.status='reviewing';chargeback.reviewedByUserId=access.actor._id;chargeback.reviewedAt=new Date();chargeback.reviewNote=cleanNote;
    chargeback.timeline.push({type:'chargeback.reviewed',message:cleanNote.slice(0,300),actorUserId:access.actor._id});
    await chargeback.save({session});
    await writeAudit(request,'finance.chargeback_reviewed',{actor:access.actor,targetType:'chargeback',targetPublicId:chargeback.publicId,country:chargeback.country,metadata:{note:cleanNote},session});
    result=chargeback;
  });return result;}finally{await session.endSession();}
}

async function reverseLedgerTransaction(txPublicId, { idempotencyKey, referencePublicId, description, country, currency }, session) {
  if (!txPublicId) return null;
  const tx = await LedgerTransaction.findOne({ publicId: txPublicId }).session(session);
  if (!tx) throw new AppError('Chargeback reversal ledger transaction is missing.', 409, 'CHARGEBACK_REVERSAL_MISSING');
  if(tx.country!==country||tx.currency!==currency||tx.referencePublicId!==referencePublicId)throw new AppError('Chargeback reversal ledger market or reference does not match.',409,'CHARGEBACK_LEDGER_MISMATCH');
  const accountIds = [...new Set(tx.entries.map(entry => String(entry.accountId)))];
  const accounts = await LedgerAccount.find({ _id: { $in: accountIds } }).session(session);
  const byId = new Map(accounts.map(account => [String(account._id), account]));
  const entries = tx.entries.map(entry => {
    const account = byId.get(String(entry.accountId));
    if (!account) throw new AppError('Chargeback recovery ledger account is missing.', 409, 'CHARGEBACK_ACCOUNT_MISSING');
    if(account.country!==country||account.currency!==currency)throw new AppError('Chargeback recovery account market does not match.',409,'CHARGEBACK_LEDGER_MISMATCH');
    return { account, debitMinor: Number(entry.creditMinor || 0), creditMinor: Number(entry.debitMinor || 0), memo: `Recover ${entry.memo || 'chargeback exposure'}` };
  });
  return postLedgerTransaction({ idempotencyKey, referenceType: 'chargeback_recovery', referencePublicId, currency: tx.currency, country: tx.country, description, entries }, session);
}

export async function resolveChargeback(request, chargebackPublicId, { outcome, note = '' }) {
  if (!['won', 'lost'].includes(outcome)) throw new AppError('Chargeback outcome must be won or lost.', 422, 'CHARGEBACK_OUTCOME_INVALID');
  const cleanNote=String(note||'').trim();
  if(cleanNote.length<5||cleanNote.length>500)throw new AppError('Add a resolution note between 5 and 500 characters.',422,'CHARGEBACK_NOTE_REQUIRED');
  const before=await Chargeback.findOne({publicId:chargebackPublicId,status:'reviewing'}).lean();
  if(!before)throw new AppError('Reviewed chargeback not found.',404,'CHARGEBACK_NOT_FOUND');
  const preliminary=await financeAccess(request,{workspace:false,country:before.country});
  if(String(before.reviewedByUserId)===String(preliminary.actor._id))throw new AppError('A different finance operator must resolve a reviewed chargeback.',403,'FOUR_EYES_REQUIRED');
  const source=await PaymentIntent.findById(before.paymentIntentId).lean();
  if(!source||source.provider!=='pesapal'||!source.providerTrackingId)throw new AppError('Verified Pesapal payment reference is required.',409,'CHARGEBACK_SOURCE_MISSING');
  const proof=await getPesapalTransactionStatus(source.providerTrackingId);
  const providerStatus=String(proof?.payment_status_description||proof?.status_description||'').trim().toUpperCase();
  const currencyFactor=['UGX','RWF','JPY','KRW'].includes(source.currency)?1:100;
  const matches=Number.isFinite(Number(proof?.amount))&&Math.round(Number(proof.amount)*currencyFactor)===source.amountMinor&&String(proof?.currency||'').toUpperCase()===source.currency&&String(proof?.merchant_reference||'')===source.providerReference;
  if(!matches||providerStatus!==(outcome==='won'?'COMPLETED':'REVERSED'))throw new AppError('The requested outcome is not supported by the independently verified Pesapal payment.',409,'CHARGEBACK_PROVIDER_UNCONFIRMED');
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const chargeback = await Chargeback.findOne({ publicId: chargebackPublicId, status: 'reviewing' }).session(session);
      if (!chargeback) throw new AppError('Reviewed chargeback not found.', 404, 'CHARGEBACK_NOT_FOUND');
      const access=await financeAccess(request,{session,write:true,workspace:false,country:chargeback.country});
      if (chargeback.reviewedByUserId?.equals(access.actor._id)) throw new AppError('A different finance operator must resolve a reviewed chargeback.', 403, 'FOUR_EYES_REQUIRED');
      const order = await Order.findById(chargeback.orderId).session(session);
      const intent = await PaymentIntent.findById(chargeback.paymentIntentId).session(session);
      if (!order || !intent) throw new AppError('Chargeback source records are missing.', 409, 'CHARGEBACK_SOURCE_MISSING');
      if(String(intent._id)!==String(source._id)||intent.__v!==source.__v||intent.providerTrackingId!==source.providerTrackingId||intent.providerReference!==source.providerReference||intent.amountMinor!==source.amountMinor||intent.currency!==source.currency||intent.country!==chargeback.country||order.country!==chargeback.country||order.totals.currency!==chargeback.currency||intent.orderPublicId!==order.publicId||order.publicId!==chargeback.orderPublicId)throw new AppError('Chargeback payment changed during provider verification. Refresh and retry.',409,'CHARGEBACK_SOURCE_CHANGED');
      if (outcome === 'won') {
        const recovery = await reverseLedgerTransaction(chargeback.reversalLedgerTransactionPublicId, { idempotencyKey: `chargeback-win:${chargeback.publicId}`, referencePublicId: chargeback.publicId, description: `Chargeback recovery ${chargeback.publicId}`,country:chargeback.country,currency:chargeback.currency }, session);
        chargeback.recoveryLedgerTransactionPublicId = recovery?.publicId || '';
        for (const snapshot of chargeback.commissionReversals || []) {
          const commission = await CommissionEntry.findById(snapshot.commissionId).session(session);
          if (!commission||String(commission.orderId)!==String(order._id)||commission.publicId!==snapshot.commissionPublicId||commission.currency!==chargeback.currency||commission.status!=='reversed'||Number(commission.reversedAmountMinor)!==Number(snapshot.priorReversedAmountMinor)+Number(snapshot.amountMinor))throw new AppError('Promoter exposure changed after the provider reversal. Reconcile it before restoring funds.',409,'CHARGEBACK_COMMISSION_CHANGED');
          if ((snapshot.posted || (snapshot.posted===undefined&&snapshot.priorStatus!=='pending'&&commission.payableAt)) && snapshot.amountMinor > 0) {
            const chargebackCommissionTx = await LedgerTransaction.findOne({ idempotencyKey: `chargeback-commission:${chargeback.publicId}:${snapshot.commissionPublicId}` }).session(session);
            if (!chargebackCommissionTx)throw new AppError('Posted promoter chargeback reversal is missing.',409,'CHARGEBACK_REVERSAL_MISSING');
            await reverseLedgerTransaction(chargebackCommissionTx.publicId, { idempotencyKey: `chargeback-win-commission:${chargeback.publicId}:${snapshot.commissionPublicId}`, referencePublicId: chargeback.publicId, description: `Restore promoter commission after chargeback win ${chargeback.publicId}`,country:chargeback.country,currency:chargeback.currency }, session);
          }
          commission.reversedAmountMinor = Number(snapshot.priorReversedAmountMinor || 0);
          commission.status = snapshot.priorStatus;
          commission.reversalReason = '';
          commission.reversedAt = null;
          await commission.save({ session });
        }
        const refundRows = await Refund.find({ paymentIntentId: intent._id, status: 'completed' }).select('amountMinor').session(session).lean();
        const refundedMinor = refundRows.reduce((sum, row) => sum + Number(row.amountMinor || 0), 0);
        if (refundedMinor >= intent.amountMinor) { intent.status = 'refunded'; order.paymentState = 'refunded'; order.refundState = 'complete'; }
        else if (refundedMinor > 0) { intent.status = 'partially_refunded'; order.paymentState = 'partially_refunded'; order.refundState = 'partial'; }
        else { intent.status = 'succeeded'; order.paymentState = 'paid'; order.refundState = 'none'; }
        syncLegacyOrderStatus(order);
        intent.reversedAt = null;
        order.timeline.push({ type: 'payment.chargeback_won', message: `Chargeback ${chargeback.publicId} was resolved in Classic Mart's favour and ledger exposure was restored.` });
      } else {
        order.paymentState = 'failed'; syncLegacyOrderStatus(order);
        order.timeline.push({ type: 'payment.chargeback_lost', message: `Chargeback ${chargeback.publicId} was confirmed lost. Reversed ledger exposure remains applied.` });
      }
      chargeback.status = outcome;
      intent.lastVerifiedAt=new Date();intent.providerStatus=providerStatus;
      chargeback.resolvedByUserId = access.actor._id;
      chargeback.resolvedAt = new Date();
      chargeback.resolutionNote = cleanNote;
      chargeback.timeline.push({ type: `chargeback.${outcome}`, message: cleanNote.slice(0,300), actorUserId: access.actor._id });
      await intent.save({ session });
      await order.save({ session });
      await chargeback.save({ session });
      await writeAudit(request,'finance.chargeback_resolved',{actor:access.actor,targetType:'chargeback',targetPublicId:chargeback.publicId,country:chargeback.country,metadata:{outcome,note:cleanNote,providerStatus},session});
      result = chargeback;
    });
  } finally { await session.endSession(); }
  return result;
}

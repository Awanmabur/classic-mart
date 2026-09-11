import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { currentTraceFields } from '../core/trace.js';
import { LedgerAccount, LedgerTransaction } from '../models/index.js';

export function sellerSettlementBreakdown(sellerOrder) {
  const subtotalMinor = Number(sellerOrder?.subtotalMinor || 0);
  const discountMinor = Number(sellerOrder?.discountMinor || 0);
  const requestedFeeMinor = Number(sellerOrder?.platformFeeMinor || 0);
  for (const value of [subtotalMinor, discountMinor, requestedFeeMinor]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new AppError('Seller settlement amounts are invalid.', 500, 'SETTLEMENT_INVALID');
  }
  const appliedDiscountMinor = Math.min(subtotalMinor, discountMinor);
  const netSubtotalMinor = subtotalMinor - appliedDiscountMinor;
  const platformFeeMinor = Math.min(netSubtotalMinor, requestedFeeMinor);
  return {
    subtotalMinor,
    discountMinor: appliedDiscountMinor,
    netSubtotalMinor,
    platformFeeMinor,
    sellerPayableMinor: netSubtotalMinor - platformFeeMinor,
  };
}

export async function ensureLedgerAccount({code,type,ownerType,ownerId,ownerPublicId='',country,currency},session=null){
  const query={code,ownerType,ownerPublicId,country,currency};
  let account=await LedgerAccount.findOne(query).session(session);
  if(account) return account;
  const docs=await LedgerAccount.create([{publicId:publicId('lac'),code,type,ownerType,ownerId,ownerPublicId,country,currency}],{session});
  return docs[0];
}

export async function postLedgerTransaction({idempotencyKey,referenceType,referencePublicId,currency,description,entries,country},session=null){
  const existing=await LedgerTransaction.findOne({idempotencyKey}).session(session);
  if(existing) return existing;
  const debit=entries.reduce((sum,e)=>sum+e.debitMinor,0); const credit=entries.reduce((sum,e)=>sum+e.creditMinor,0);
  if(!Number.isSafeInteger(debit)||debit<=0||debit!==credit) throw new AppError('Ledger entries are not balanced.',500,'LEDGER_UNBALANCED');
  const docs=await LedgerTransaction.create([{publicId:publicId('ltx'),...currentTraceFields(),idempotencyKey,referenceType,referencePublicId,country:country||entries[0]?.account?.country,currency,description,entries:entries.map(e=>({accountId:e.account._id,accountPublicId:e.account.publicId,debitMinor:e.debitMinor||0,creditMinor:e.creditMinor||0,memo:e.memo||''}))}],{session});
  const accountIds=[...new Set(entries.map(e=>String(e.account._id)))].map(id=>new mongoose.Types.ObjectId(id));
  await LedgerAccount.updateMany({_id:{$in:accountIds}},{$inc:{mutationVersion:1}},{session});
  return docs[0];
}

export async function accountBalanceMinor(accountId,session=null){
  const aggregate=LedgerTransaction.aggregate([{$unwind:'$entries'},{$match:{'entries.accountId':new mongoose.Types.ObjectId(accountId)}},{$group:{_id:null,debits:{$sum:'$entries.debitMinor'},credits:{$sum:'$entries.creditMinor'}}}]);
  if(session)aggregate.session(session);
  const rows=await aggregate;
  const account=await LedgerAccount.findById(accountId).session(session).lean(); if(!account)return 0;
  const d=rows[0]?.debits||0,c=rows[0]?.credits||0;
  return ['asset','expense'].includes(account.type)?d-c:c-d;
}

export async function moneySummary({ownerType,ownerPublicId,country,currency}){
  const accounts=await LedgerAccount.find({ownerType,ownerPublicId,country,currency,active:true}).lean();
  const result=[]; for(const account of accounts) result.push({...account,balanceMinor:await accountBalanceMinor(account._id)});
  return result;
}

function proportionalParts(totalMinor, weights) {
  const total = Number(totalMinor || 0);
  const values = weights.map((value) => Math.max(0, Number(value || 0)));
  const denominator = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total) || total < 0) throw new AppError('Settlement allocation total is invalid.', 500, 'SETTLEMENT_INVALID');
  if (!values.every(Number.isSafeInteger)) throw new AppError('Settlement allocation weight is invalid.', 500, 'SETTLEMENT_INVALID');
  if (!denominator) {
    if (total) throw new AppError('Settlement allocation has no positive base.', 500, 'SETTLEMENT_INVALID');
    return values.map(() => 0);
  }
  if (total > denominator) throw new AppError('Settlement allocation exceeds its base.', 500, 'SETTLEMENT_INVALID');
  let seen = 0;
  let allocated = 0;
  return values.map((weight, index) => {
    seen += weight;
    const target = index === values.length - 1 ? total : Math.floor(total * seen / denominator);
    const part = target - allocated;
    allocated = target;
    return part;
  });
}

/**
 * Freeze the exact seller-side economics for each order line. Later refunds must
 * reverse these persisted amounts instead of recalculating fees/discounts from
 * mutable pricing rules or a new rounding path.
 */
export function allocateSellerLineSettlement(items, { discountMinor = 0, platformFeeMinor = 0 } = {}) {
  const rows = (items || []).map((item) => ({ ...item, grossMinor: Number(item.lineTotalMinor ?? item.grossMinor ?? 0) }));
  const gross = rows.map((row) => row.grossMinor);
  if (!rows.length || gross.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new AppError('Seller settlement lines are invalid.', 500, 'SETTLEMENT_INVALID');
  const discounts = proportionalParts(discountMinor, gross);
  const paid = gross.map((value, index) => value - discounts[index]);
  const fees = proportionalParts(platformFeeMinor, paid);
  return rows.map((row, index) => ({
    ...row,
    grossMinor: gross[index],
    discountMinor: discounts[index],
    customerPaidMinor: paid[index],
    platformFeeMinor: fees[index],
    sellerReceivableMinor: paid[index] - fees[index],
  }));
}

export function proportionalSettlementSlice(totalMinor, consumedMinor, nextMinor, baseMinor) {
  const total = Number(totalMinor || 0), consumed = Number(consumedMinor || 0), next = Number(nextMinor || 0), base = Number(baseMinor || 0);
  if (![total, consumed, next, base].every(Number.isSafeInteger) || total < 0 || consumed < 0 || next < 0 || base <= 0 || consumed + next > base) {
    throw new AppError('Refund settlement slice is invalid.', 409, 'REFUND_SETTLEMENT_INVALID');
  }
  const before = consumed >= base ? total : Math.floor(total * consumed / base);
  const afterAmount = consumed + next;
  const after = afterAmount >= base ? total : Math.floor(total * afterAmount / base);
  return after - before;
}

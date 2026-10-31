import mongoose from 'mongoose';
import crypto from 'node:crypto';
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
  const platformContributionMinor=(sellerOrder.items||[]).reduce((sum,item)=>sum+Number(item.platformContributionMinor||0),0);
  if(!Number.isSafeInteger(platformContributionMinor)||platformContributionMinor<0||platformContributionMinor>appliedDiscountMinor)throw new AppError('Seller funding snapshot is invalid.',409,'SETTLEMENT_INVALID');
  const netSubtotalMinor = subtotalMinor - appliedDiscountMinor + platformContributionMinor;
  const platformFeeMinor = Math.min(netSubtotalMinor, requestedFeeMinor);
  return {
    subtotalMinor,
    discountMinor: appliedDiscountMinor,
    netSubtotalMinor,
    platformContributionMinor,
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

export async function accountBalanceMinor(accountId,session=null,knownAccountType=null){
  const aggregate=LedgerTransaction.aggregate([{$match:{'entries.accountId':new mongoose.Types.ObjectId(accountId)}},{$unwind:'$entries'},{$match:{'entries.accountId':new mongoose.Types.ObjectId(accountId)}},{$group:{_id:null,debits:{$sum:'$entries.debitMinor'},credits:{$sum:'$entries.creditMinor'}}}]);
  if(session)aggregate.session(session);
  const rows=await aggregate;
  const accountType=knownAccountType || (await LedgerAccount.findById(accountId).select('type').session(session).lean())?.type; if(!accountType)return 0;
  const d=rows[0]?.debits||0,c=rows[0]?.credits||0;
  return ['asset','expense'].includes(accountType)?d-c:c-d;
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
  if (!values.every(Number.isSafeInteger)||!Number.isSafeInteger(denominator)) throw new AppError('Settlement allocation weight is invalid.', 500, 'SETTLEMENT_INVALID');
  if (!denominator) {
    if (total) throw new AppError('Settlement allocation has no positive base.', 500, 'SETTLEMENT_INVALID');
    return values.map(() => 0);
  }
  if (total > denominator) throw new AppError('Settlement allocation exceeds its base.', 500, 'SETTLEMENT_INVALID');
  let seen = 0;
  let allocated = 0;
  return values.map((weight, index) => {
    seen += weight;
    const target = index === values.length - 1 ? total : Number(BigInt(total)*BigInt(seen)/BigInt(denominator));
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
export function allocateSellerLineSettlement(items, { discountMinor = 0, platformFeeMinor = 0, lineDiscounts, linePlatformContributions } = {}) {
  const rows = (items || []).map((item) => ({ ...item, grossMinor: Number(item.lineTotalMinor ?? item.grossMinor ?? 0) }));
  const gross = rows.map((row) => row.grossMinor);
  if (!rows.length || gross.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new AppError('Seller settlement lines are invalid.', 500, 'SETTLEMENT_INVALID');
  let discounts;
  if (lineDiscounts === undefined) discounts = proportionalParts(discountMinor, gross);
  else {
    if (!Array.isArray(lineDiscounts) || lineDiscounts.length !== rows.length
      || !Number.isSafeInteger(discountMinor) || discountMinor < 0
      || lineDiscounts.some((amount, index) => !Number.isSafeInteger(amount) || amount < 0 || amount > gross[index])
      || lineDiscounts.reduce((sum, amount) => sum + amount, 0) !== discountMinor) throw new AppError('Seller line discounts do not match the settlement total.', 500, 'SETTLEMENT_INVALID');
    discounts = [...lineDiscounts];
  }
  const paid = gross.map((value, index) => value - discounts[index]);
  const contributions=linePlatformContributions===undefined?rows.map(()=>0):linePlatformContributions;
  if(!Array.isArray(contributions)||contributions.length!==rows.length||contributions.some((value,index)=>!Number.isSafeInteger(value)||value<0||value>discounts[index]||(value>0&&paid[index]<Number(rows[index].quantity||1))))throw new AppError('Seller platform funding allocation is invalid.',500,'SETTLEMENT_INVALID');
  const economic=paid.map((value,index)=>value+contributions[index]);
  const fees = proportionalParts(platformFeeMinor, economic);
  return rows.map((row, index) => ({
    ...row,
    grossMinor: gross[index],
    discountMinor: discounts[index],
    customerPaidMinor: paid[index],
    platformContributionMinor:contributions[index],
    platformFeeMinor: fees[index],
    sellerReceivableMinor: economic[index] - fees[index],
  }));
}

export function proportionalSettlementSlice(totalMinor, consumedMinor, nextMinor, baseMinor) {
  const total = Number(totalMinor || 0), consumed = Number(consumedMinor || 0), next = Number(nextMinor || 0), base = Number(baseMinor || 0);
  if (![total, consumed, next, base].every(Number.isSafeInteger) || total < 0 || consumed < 0 || next < 0 || base <= 0 || consumed + next > base) {
    throw new AppError('Refund settlement slice is invalid.', 409, 'REFUND_SETTLEMENT_INVALID');
  }
  const before = consumed >= base ? total : Number(BigInt(total)*BigInt(consumed)/BigInt(base));
  const afterAmount = consumed + next;
  const after = afterAmount >= base ? total : Number(BigInt(total)*BigInt(afterAmount)/BigInt(base));
  return after - before;
}

export function refundSettlementSlice(line,consumedCashMinor,nextCashMinor){
  const cash=Number(line?.customerPaidMinor||0),funding=Number(line?.platformContributionMinor||0),fee=Number(line?.platformFeeMinor||0),seller=Number(line?.sellerReceivableMinor||0);
  if(![cash,funding,fee,seller].every(value=>Number.isSafeInteger(value)&&value>=0)||cash<=0||fee+seller!==cash+funding)throw new AppError('Immutable seller settlement snapshot is invalid.',409,'SELLER_SETTLEMENT_SNAPSHOT_MISSING');
  const platformContributionMinor=proportionalSettlementSlice(funding,consumedCashMinor,nextCashMinor,cash),platformFeeMinor=proportionalSettlementSlice(fee,consumedCashMinor,nextCashMinor,cash);
  return {grossMinor:nextCashMinor,sourceCashOffsetMinor:consumedCashMinor,platformContributionMinor,platformFeeMinor,sellerReceivableMinor:nextCashMinor+platformContributionMinor-platformFeeMinor};
}

export function sellerLineFinancialHash(line){return crypto.createHash('sha256').update(JSON.stringify({orderLineId:String(line.orderLineId||''),quantity:Number(line.quantity||0),customerPaidMinor:Number(line.customerPaidMinor||0),platformContributionMinor:Number(line.platformContributionMinor||0),platformFeeMinor:Number(line.platformFeeMinor||0),sellerReceivableMinor:Number(line.sellerReceivableMinor||0)})).digest('hex');}

export function validateOrderFunding(order,sellerOrders){
  const snapshot=order.fundingSnapshot||{},fields=['rewardGoodsMinor','rewardShippingMinor','clubShippingMinor','totalMinor'];
  for(const field of fields)if(!Number.isSafeInteger(Number(snapshot[field]||0))||Number(snapshot[field]||0)<0)throw new AppError('Order funding snapshot is invalid.',409,'ORDER_FUNDING_INVALID');
  const goods=Number(snapshot.rewardGoodsMinor||0),shipping=Number(snapshot.rewardShippingMinor||0)+Number(snapshot.clubShippingMinor||0),total=Number(snapshot.totalMinor||0),grossShipping=snapshot.grossShippingMinor===undefined?Number(order.totals.shippingMinor||0):Number(snapshot.grossShippingMinor);
  if(!Number.isSafeInteger(grossShipping)||grossShipping<0||goods+shipping!==total||grossShipping-shipping!==Number(order.totals.shippingMinor||0))throw new AppError('Order funding does not match customer totals.',409,'ORDER_FUNDING_INVALID');
  let contribution=0,credits=Number(order.totals.taxMinor||0)+grossShipping;
  const exactLines=Boolean(order.fundingSnapshot),seenLines=new Set();
  for(const sellerOrder of sellerOrders){
    if(sellerOrder.country!==order.country||sellerOrder.currency!==order.totals.currency)throw new AppError('Seller funding market does not match.',409,'ORDER_FUNDING_INVALID');
    let lineGross=0,lineDiscount=0,lineFee=0,lineSeller=0;
    for(const line of sellerOrder.items||[]){
      const funded=Number(line.platformContributionMinor||0);if(funded>0)refundSettlementSlice(line,0,Number(line.customerPaidMinor));contribution+=funded;
      if(exactLines){
        const values=['grossMinor','discountMinor','customerPaidMinor','platformFeeMinor','sellerReceivableMinor'].map(field=>Number(line[field]));
        const source=(order.items||[]).find(row=>row.linePublicId===line.orderLineId&&row.storePublicId===sellerOrder.storePublicId);
        if(!source||seenLines.has(line.orderLineId)||!values.every(value=>Number.isSafeInteger(value)&&value>=0)||!Number.isSafeInteger(funded)||funded<0||funded>Number(line.discountMinor)||Number(line.grossMinor)-Number(line.discountMinor)!==Number(line.customerPaidMinor)||Number(line.platformFeeMinor)+Number(line.sellerReceivableMinor)!==Number(line.customerPaidMinor)+funded||Number(line.grossMinor)!==Number(source.lineTotalMinor)||Number(line.quantity)!==Number(source.quantity)||line.variantPublicId!==source.variantPublicId)throw new AppError('Order funding line snapshots do not match the purchased goods.',409,'ORDER_FUNDING_INVALID');
        seenLines.add(line.orderLineId);lineGross+=Number(line.grossMinor);lineDiscount+=Number(line.discountMinor);lineFee+=Number(line.platformFeeMinor);lineSeller+=Number(line.sellerReceivableMinor);
      }
    }
    const settlement=sellerSettlementBreakdown(sellerOrder);credits+=settlement.netSubtotalMinor;
    if(exactLines&&(lineGross!==settlement.subtotalMinor||lineDiscount!==settlement.discountMinor||lineFee!==settlement.platformFeeMinor||lineSeller!==settlement.sellerPayableMinor))throw new AppError('Seller funding totals do not match immutable order lines.',409,'ORDER_FUNDING_INVALID');
  }
  if(exactLines&&seenLines.size!==(order.items||[]).length)throw new AppError('Seller funding does not cover every purchased order line.',409,'ORDER_FUNDING_INVALID');
  if(contribution!==goods||credits!==Number(order.totals.totalMinor)+total)throw new AppError('Order funding does not conserve the original settlement.',409,'ORDER_FUNDING_UNBALANCED');
  return {rewardGoodsMinor:goods,shippingContributionMinor:shipping,totalMinor:total,grossShippingMinor:grossShipping};
}

export async function orderFundingLedgerEntries(order,sellerOrders,session){
  const funding=validateOrderFunding(order,sellerOrders);if(!funding.totalMinor)return {funding,entries:[]};
  const account=await ensureLedgerAccount({code:'platform_rewards_expense',type:'expense',ownerType:'platform',ownerPublicId:'classic-mart',country:order.country,currency:order.totals.currency},session);
  return {funding,entries:[{account,debitMinor:funding.totalMinor,creditMinor:0,memo:`Fund customer rewards and Club benefits for ${order.publicId}`}]};
}

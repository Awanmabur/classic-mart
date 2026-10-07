import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { WalletTopUp, LedgerAccount } from '../models/index.js';
import { accountBalanceMinor, ensureLedgerAccount, postLedgerTransaction } from './money.js';
import { getPesapalTransactionStatus, submitPesapalOrder } from './pesapal.js';
import { writeAudit } from './audit.js';

const factor = (currency) => ['UGX','RWF','JPY','KRW'].includes(String(currency||'').toUpperCase()) ? 1 : 100;
const major = (minor,currency) => Number(minor)/factor(currency);
const toMinor = (amount,currency) => Math.round(Number(amount||0)*factor(currency));
function splitName(name){const parts=String(name||'').trim().split(/\s+/).filter(Boolean);return {firstName:parts.shift()||'Customer',lastName:parts.join(' ')||'Customer'};}
function statusOf(payload){return String(payload?.payment_status_description||payload?.status_description||'').trim().toUpperCase();}

export async function customerWalletSummary(user, { includeTopUps = true } = {}) {
  const account = await LedgerAccount.findOne({ code:'customer_wallet', ownerType:'customer', ownerPublicId:user.publicId, country:user.country, currency:user.currency, active:true }).lean();
  const balanceMinor = account ? await accountBalanceMinor(account._id, null, account.type) : 0;
  const topUps = includeTopUps ? await WalletTopUp.find({ userId:user._id }).sort({ createdAt:-1 }).limit(12).lean() : [];
  return { balanceMinor, currency:user.currency, topUps };
}

export async function createWalletTopUp(request,{amountMinor,idempotencyKey}) {
  const amount=Number(amountMinor);
  if(!Number.isSafeInteger(amount)||amount<=0)throw new AppError('Enter a valid top-up amount.',422,'WALLET_AMOUNT_INVALID');
  const minimum=factor(request.user.currency)===1?1000:100;
  const maximum=factor(request.user.currency)===1?20_000_000:2_000_000;
  if(amount<minimum||amount>maximum)throw new AppError('Top-up amount is outside the allowed range.',422,'WALLET_AMOUNT_RANGE');
  const idem=String(idempotencyKey||'').trim();
  if(idem.length<12||idem.length>140)throw new AppError('Top-up request key is invalid.',422,'IDEMPOTENCY_KEY_INVALID');
  const prior=await WalletTopUp.findOne({idempotencyKey:idem,userId:request.user._id});
  if(prior)return prior;
  const topUpPublicId=publicId('wtu');
  let topup;
  try{topup=await WalletTopUp.create({publicId:topUpPublicId,userId:request.user._id,userPublicId:request.user.publicId,country:request.user.country,currency:request.user.currency,amountMinor:amount,idempotencyKey:idem,providerReference:topUpPublicId});}
  catch(error){if(error?.code===11000){const raced=await WalletTopUp.findOne({idempotencyKey:idem,userId:request.user._id});if(raced)return raced;}throw error;}
  const names=splitName(request.user.name);
  try{
    const result=await submitPesapalOrder({
      id:topup.providerReference,currency:topup.currency,amount:major(topup.amountMinor,topup.currency),description:'Classic Mart wallet top-up',callback_url:`${env.baseUrl}/wallet/return`,
      billing_address:{email_address:request.user.email,phone_number:request.user.phone,country_code:topup.country,first_name:names.firstName,last_name:names.lastName,line_1:'Classic Mart customer wallet',line_2:'',city:'',state:'',postal_code:'',zip_code:''},
    });
    if(!result?.redirect_url||!result?.order_tracking_id)throw new AppError('Pesapal did not return a wallet checkout URL.',502,'PESAPAL_ORDER_INVALID');
    topup.checkoutUrl=String(result.redirect_url);topup.providerTrackingId=String(result.order_tracking_id);topup.status='requires_action';await topup.save();
    await writeAudit(request,'customer.wallet_topup_started',{targetType:'wallet_topup',targetPublicId:topup.publicId,country:topup.country,metadata:{amountMinor:topup.amountMinor,currency:topup.currency}});
    return topup;
  }catch(error){topup.status='failed';topup.failureCode=String(error.code||'PESAPAL_SUBMIT_FAILED').slice(0,100);topup.failureMessage=String(error.message||'Wallet top-up failed.').slice(0,400);await topup.save();throw error;}
}

export async function verifyWalletTopUp(topupOrId,trackingId,request=null){
  const topup=typeof topupOrId==='string'?await WalletTopUp.findOne({publicId:topupOrId}):topupOrId;
  if(!topup)throw new AppError('Wallet top-up not found.',404,'WALLET_TOPUP_NOT_FOUND');
  if(topup.status==='succeeded')return topup;
  const tracking=String(trackingId||topup.providerTrackingId||'').trim();
  if(!tracking)throw new AppError('Pesapal tracking ID is missing.',409,'PESAPAL_TRACKING_ID_REQUIRED');
  if(topup.providerTrackingId&&topup.providerTrackingId!==tracking)throw new AppError('Pesapal callback reference mismatch.',400,'PESAPAL_REFERENCE_MISMATCH');
  const data=await getPesapalTransactionStatus(tracking); const providerStatus=statusOf(data);
  topup.lastVerifiedAt=new Date();topup.providerStatus=providerStatus;topup.providerTrackingId=tracking;
  if(data?.confirmation_code)topup.providerConfirmationCode=String(data.confirmation_code);
  if(data?.payment_method)topup.providerPaymentMethod=String(data.payment_method);
  if(providerStatus==='COMPLETED'){
    const matches=toMinor(data?.amount,topup.currency)===topup.amountMinor&&String(data?.currency||'').toUpperCase()===topup.currency&&String(data?.merchant_reference||'')===topup.providerReference;
    if(!matches){topup.status='failed';topup.failureCode='VERIFICATION_MISMATCH';topup.failureMessage='Pesapal amount, currency or merchant reference did not match the wallet top-up.';await topup.save();return topup;}
    const session=await mongoose.startSession();
    try{await session.withTransaction(async()=>{
      const locked=await WalletTopUp.findById(topup._id).session(session);if(!locked||locked.status==='succeeded')return;
      const clearing=await ensureLedgerAccount({code:'provider_clearing',type:'asset',ownerType:'provider',ownerPublicId:'pesapal',country:locked.country,currency:locked.currency},session);
      const wallet=await ensureLedgerAccount({code:'customer_wallet',type:'liability',ownerType:'customer',ownerId:locked.userId,ownerPublicId:locked.userPublicId,country:locked.country,currency:locked.currency},session);
      await postLedgerTransaction({idempotencyKey:`wallet-topup:${locked.publicId}`,referenceType:'wallet_topup',referencePublicId:locked.publicId,country:locked.country,currency:locked.currency,description:`Customer wallet top-up ${locked.publicId}`,entries:[{account:clearing,debitMinor:locked.amountMinor,creditMinor:0,memo:'Verified Pesapal wallet top-up'},{account:wallet,debitMinor:0,creditMinor:locked.amountMinor,memo:'Customer wallet credit'}]},session);
      locked.status='succeeded';locked.paidAt=locked.paidAt||new Date();locked.providerStatus=providerStatus;locked.providerTrackingId=tracking;if(data?.confirmation_code)locked.providerConfirmationCode=String(data.confirmation_code);if(data?.payment_method)locked.providerPaymentMethod=String(data.payment_method);await locked.save({session});
    });}finally{await session.endSession();}
    const done=await WalletTopUp.findById(topup._id);
    if(request)await writeAudit(request,'customer.wallet_topup_succeeded',{targetType:'wallet_topup',targetPublicId:done.publicId,country:done.country,metadata:{amountMinor:done.amountMinor,currency:done.currency}});
    return done;
  }
  if(['FAILED','INVALID'].includes(providerStatus)){topup.status='failed';topup.failureCode=`PESAPAL_${providerStatus}`;topup.failureMessage=String(data?.description||data?.message||`Pesapal reported ${providerStatus}`).slice(0,400);}
  else topup.status='pending';
  await topup.save(); return topup;
}

function notificationFields(body={},query={}){const value=(name)=>body?.[name]??query?.[name]??body?.[name.toLowerCase()]??query?.[name.toLowerCase()]??'';return {trackingId:String(value('OrderTrackingId')).trim(),merchantReference:String(value('OrderMerchantReference')).trim()};}
export async function processWalletPesapalNotification(request,body={},query={}){
  const fields=notificationFields(body,query);if(!fields.merchantReference)return null;
  const topup=await WalletTopUp.findOne({providerReference:fields.merchantReference});if(!topup)return null;
  await verifyWalletTopUp(topup,fields.trackingId,request);return {wallet:true,topUpPublicId:topup.publicId};
}

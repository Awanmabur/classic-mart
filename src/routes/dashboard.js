import { Router } from 'express';
import { z } from 'zod';
import { AppError, asyncHandler } from '../core/errors.js';
import { requireAuth, requireOnboarding, requireVerified } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { setFlash } from '../middleware/view.js';
import { Notification, User, WalletTopUp } from '../models/index.js';
import { customerDashboardPath } from '../dashboard/customer-registry.js';
import { archiveCustomerAddress, createCustomerAddress, setDefaultCustomerAddress, updateCustomerAddress } from '../services/customer-addresses.js';
import { createWalletTopUp, customerWalletSummary, verifyWalletTopUp } from '../services/customer-wallet.js';
import { writeAudit } from '../services/audit.js';
import { hasPermission } from '../core/roles.js';

const router=Router();
function accountOnly(request,_response,next){if(!hasPermission(request.user,'account:read'))return next(new AppError('Customer account access is not available.',403,'CUSTOMER_DASHBOARD_ONLY'));return next();}
const gates=[noStore,requireAuth,requireVerified,requireOnboarding,accountOnly];
const paths=(path)=>[path,path.replace(/^\/dashboard/, '')];

function digits(currency){try{return new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;}catch{return 2;}}
function amountToMinor(value,currency){const numeric=Number(value);if(!Number.isFinite(numeric)||numeric<=0)throw new AppError('Enter a valid amount.',422,'WALLET_AMOUNT_INVALID');return Math.round((numeric+Number.EPSILON)*10**digits(currency));}

function formatDate(value,locale='en-UG'){if(!value)return '—';return new Intl.DateTimeFormat(locale,{dateStyle:'medium'}).format(new Date(value));}

router.get(paths('/dashboard/wallet/statement.csv'),...gates,asyncHandler(async(request,response)=>{
  const wallet=await customerWalletSummary(request.user);
  const escapeCsv=(value)=>{const raw=String(value??'');const safe=/^[\s]*[=+@-]/.test(raw)?`'${raw}`:raw;return `"${safe.replaceAll('"','""')}"`;};
  const rows=[['Date','Type','Status','Method','Amount','Currency','Reference']];
  for(const topup of wallet.topUps||[])rows.push([formatDate(topup.createdAt,request.user.locale),'Wallet top-up',topup.status,topup.providerPaymentMethod||'Pesapal',Number(topup.amountMinor||0)/10**digits(topup.currency),topup.currency,topup.publicId]);
  const csv=rows.map(row=>row.map(escapeCsv).join(',')).join('\r\n');
  response.type('text/csv');
  response.set('Content-Disposition','attachment; filename="classic-wallet-statement.csv"');
  response.send(`${csv}\r\n`);
}));
router.get(paths('/dashboard/wallet/return'),...gates,asyncHandler(async(request,response)=>{
  const tracking=String(request.query.OrderTrackingId||request.query.orderTrackingId||'').trim();
  const reference=String(request.query.OrderMerchantReference||request.query.orderMerchantReference||'').trim();
  let topup=reference?await WalletTopUp.findOne({providerReference:reference,userId:request.user._id}):null;
  if(!topup&&tracking)topup=await WalletTopUp.findOne({providerTrackingId:tracking,userId:request.user._id});
  if(!topup)throw new AppError('Wallet top-up was not found.',404,'WALLET_TOPUP_NOT_FOUND');
  const verified=await verifyWalletTopUp(topup,tracking,request);
  setFlash(request,verified.status==='succeeded'?'success':verified.status==='failed'?'error':'info',verified.status==='succeeded'?'Wallet top-up completed.':verified.status==='failed'?'Wallet top-up could not be verified.':'Wallet top-up is still being verified.');
  response.redirect(customerDashboardPath('wallet'));
}));


router.post(paths('/dashboard/addresses'),...gates,asyncHandler(async(request,response)=>{await createCustomerAddress(request,request.body);setFlash(request,'success','Address added.');response.redirect(customerDashboardPath('addresses'));}));
router.post(paths('/dashboard/addresses/:id'),...gates,asyncHandler(async(request,response)=>{await updateCustomerAddress(request,request.params.id,request.body);setFlash(request,'success','Address updated.');response.redirect(customerDashboardPath('addresses'));}));
router.post(paths('/dashboard/addresses/:id/default'),...gates,asyncHandler(async(request,response)=>{await setDefaultCustomerAddress(request,request.params.id);setFlash(request,'success','Default address updated.');response.redirect(customerDashboardPath('addresses'));}));
router.post(paths('/dashboard/addresses/:id/archive'),...gates,asyncHandler(async(request,response)=>{await archiveCustomerAddress(request,request.params.id);setFlash(request,'success','Address removed.');response.redirect(customerDashboardPath('addresses'));}));

router.post(paths('/dashboard/wallet/top-up'),...gates,asyncHandler(async(request,response)=>{const input=z.object({amount:z.coerce.number().positive(),idempotencyKey:z.string().trim().min(12).max(140)}).parse(request.body);const topup=await createWalletTopUp(request,{amountMinor:amountToMinor(input.amount,request.user.currency),idempotencyKey:input.idempotencyKey});if(topup.status==='succeeded'){setFlash(request,'success','Wallet top-up already completed.');return response.redirect(customerDashboardPath('wallet'));}if(!topup.checkoutUrl)throw new AppError('Wallet checkout is unavailable.',409,'WALLET_CHECKOUT_UNAVAILABLE');return response.redirect(topup.checkoutUrl);}));

router.post(paths('/dashboard/notifications/:id/read'),...gates,asyncHandler(async(request,response)=>{const row=await Notification.findOne({publicId:request.params.id,userId:request.user._id});if(!row)throw new AppError('Notification not found.',404,'NOTIFICATION_NOT_FOUND');if(!row.readAt){row.readAt=new Date();await row.save();}response.redirect(customerDashboardPath('notifications'));}));
router.post(paths('/dashboard/notifications/read-all'),...gates,asyncHandler(async(request,response)=>{await Notification.updateMany({userId:request.user._id,readAt:null},{$set:{readAt:new Date()}});await writeAudit(request,'customer.notifications_read',{targetType:'user',targetPublicId:request.user.publicId});response.redirect(customerDashboardPath('notifications'));}));
router.post(paths('/dashboard/notifications/preferences'),...gates,asyncHandler(async(request,response)=>{const input=z.object({orders:z.string().optional(),wishlist:z.string().optional(),offers:z.string().optional(),club:z.string().optional()}).parse(request.body);const notifications={orders:input.orders==='on',wishlist:input.wishlist==='on',offers:input.offers==='on',club:input.club==='on'};await User.updateOne({_id:request.user._id},{$set:{'preferences.notifications':notifications}});request.user.preferences.notifications=notifications;await writeAudit(request,'customer.notification_preferences_updated',{targetType:'user',targetPublicId:request.user.publicId,metadata:notifications});setFlash(request,'success','Notification preferences saved.');response.redirect(customerDashboardPath('notifications'));}));

export default router;

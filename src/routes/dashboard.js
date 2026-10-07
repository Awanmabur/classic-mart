import { Router } from 'express';
import { z } from 'zod';
import { AppError, asyncHandler } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { requireAuth, requireOnboarding, requireVerified } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { setFlash } from '../middleware/view.js';
import { Notification, User, WalletTopUp } from '../models/index.js';
import { customerDashboardPage, customerDashboardPath, CUSTOMER_DASHBOARD_PAGES } from '../dashboard/customer-registry.js';
import { loadCustomerDashboardPage } from '../dashboard/customer-data.js';
import { archiveCustomerAddress, createCustomerAddress, setDefaultCustomerAddress, updateCustomerAddress } from '../services/customer-addresses.js';
import { createWalletTopUp, customerWalletSummary, verifyWalletTopUp } from '../services/customer-wallet.js';
import { writeAudit } from '../services/audit.js';
import { hasPermission } from '../core/roles.js';

const router=Router();
function accountOnly(request,_response,next){if(!hasPermission(request.user,'account:read'))return next(new AppError('Customer account access is not available.',403,'CUSTOMER_DASHBOARD_ONLY'));return next();}
router.use('/dashboard',noStore,requireAuth,requireVerified,requireOnboarding,accountOnly);

function digits(currency){try{return new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;}catch{return 2;}}
function amountToMinor(value,currency){const numeric=Number(value);if(!Number.isFinite(numeric)||numeric<=0)throw new AppError('Enter a valid amount.',422,'WALLET_AMOUNT_INVALID');return Math.round((numeric+Number.EPSILON)*10**digits(currency));}
function formatMoney(minor,currency,locale='en-UG'){const divisor=10**digits(currency);return new Intl.NumberFormat(locale,{style:'currency',currency,maximumFractionDigits:digits(currency)}).format(Number(minor||0)/divisor);}
function formatDate(value,locale='en-UG'){if(!value)return '—';return new Intl.DateTimeFormat(locale,{dateStyle:'medium'}).format(new Date(value));}

router.get('/dashboard',(_request,response)=>response.redirect(customerDashboardPath('dashboard')));
router.get('/dashboard/wallet/statement.csv',asyncHandler(async(request,response)=>{
  const wallet=await customerWalletSummary(request.user);
  const escapeCsv=(value)=>{const raw=String(value??'');const safe=/^[\s]*[=+@-]/.test(raw)?`'${raw}`:raw;return `"${safe.replaceAll('"','""')}"`;};
  const rows=[['Date','Type','Status','Method','Amount','Currency','Reference']];
  for(const topup of wallet.topUps||[])rows.push([formatDate(topup.createdAt,request.user.locale),'Wallet top-up',topup.status,topup.providerPaymentMethod||'Pesapal',Number(topup.amountMinor||0)/10**digits(topup.currency),topup.currency,topup.publicId]);
  const csv=rows.map(row=>row.map(escapeCsv).join(',')).join('\r\n');
  response.type('text/csv');
  response.set('Content-Disposition','attachment; filename="classic-wallet-statement.csv"');
  response.send(`${csv}\r\n`);
}));
router.get('/dashboard/wallet/return',asyncHandler(async(request,response)=>{
  const tracking=String(request.query.OrderTrackingId||request.query.orderTrackingId||'').trim();
  const reference=String(request.query.OrderMerchantReference||request.query.orderMerchantReference||'').trim();
  let topup=reference?await WalletTopUp.findOne({providerReference:reference,userId:request.user._id}):null;
  if(!topup&&tracking)topup=await WalletTopUp.findOne({providerTrackingId:tracking,userId:request.user._id});
  if(!topup)throw new AppError('Wallet top-up was not found.',404,'WALLET_TOPUP_NOT_FOUND');
  const verified=await verifyWalletTopUp(topup,tracking,request);
  setFlash(request,verified.status==='succeeded'?'success':verified.status==='failed'?'error':'info',verified.status==='succeeded'?'Wallet top-up completed.':verified.status==='failed'?'Wallet top-up could not be verified.':'Wallet top-up is still being verified.');
  response.redirect(customerDashboardPath('wallet'));
}));
router.get('/dashboard/:page',asyncHandler(async(request,response)=>{
  const pageId=String(request.params.page||'dashboard');const page=customerDashboardPage(pageId);if(!page)throw new AppError('Dashboard page not found.',404,'DASHBOARD_PAGE_NOT_FOUND');
  const pageData=await loadCustomerDashboardPage(request,pageId);
  response.render('customer-dashboard',{page,pageId,pages:CUSTOMER_DASHBOARD_PAGES,pageData,walletIdempotencyKey:publicId('idem'),formatMoney:(minor,currency=request.user.currency)=>formatMoney(minor,currency,request.user.locale),formatDate:(value)=>formatDate(value,request.user.locale)});
}));

router.post('/dashboard/addresses',asyncHandler(async(request,response)=>{await createCustomerAddress(request,request.body);setFlash(request,'success','Address added.');response.redirect(customerDashboardPath('addresses'));}));
router.post('/dashboard/addresses/:id',asyncHandler(async(request,response)=>{await updateCustomerAddress(request,request.params.id,request.body);setFlash(request,'success','Address updated.');response.redirect(customerDashboardPath('addresses'));}));
router.post('/dashboard/addresses/:id/default',asyncHandler(async(request,response)=>{await setDefaultCustomerAddress(request,request.params.id);setFlash(request,'success','Default address updated.');response.redirect(customerDashboardPath('addresses'));}));
router.post('/dashboard/addresses/:id/archive',asyncHandler(async(request,response)=>{await archiveCustomerAddress(request,request.params.id);setFlash(request,'success','Address removed.');response.redirect(customerDashboardPath('addresses'));}));

router.post('/dashboard/wallet/top-up',asyncHandler(async(request,response)=>{const input=z.object({amount:z.coerce.number().positive(),idempotencyKey:z.string().trim().min(12).max(140)}).parse(request.body);const topup=await createWalletTopUp(request,{amountMinor:amountToMinor(input.amount,request.user.currency),idempotencyKey:input.idempotencyKey});if(topup.status==='succeeded'){setFlash(request,'success','Wallet top-up already completed.');return response.redirect(customerDashboardPath('wallet'));}if(!topup.checkoutUrl)throw new AppError('Wallet checkout is unavailable.',409,'WALLET_CHECKOUT_UNAVAILABLE');return response.redirect(topup.checkoutUrl);}));

router.post('/dashboard/notifications/:id/read',asyncHandler(async(request,response)=>{const row=await Notification.findOne({publicId:request.params.id,userId:request.user._id});if(!row)throw new AppError('Notification not found.',404,'NOTIFICATION_NOT_FOUND');if(!row.readAt){row.readAt=new Date();await row.save();}response.redirect(customerDashboardPath('notifications'));}));
router.post('/dashboard/notifications/read-all',asyncHandler(async(request,response)=>{await Notification.updateMany({userId:request.user._id,readAt:null},{$set:{readAt:new Date()}});await writeAudit(request,'customer.notifications_read',{targetType:'user',targetPublicId:request.user.publicId});response.redirect(customerDashboardPath('notifications'));}));
router.post('/dashboard/notifications/preferences',asyncHandler(async(request,response)=>{const input=z.object({orders:z.string().optional(),wishlist:z.string().optional(),offers:z.string().optional(),club:z.string().optional()}).parse(request.body);const notifications={orders:input.orders==='on',wishlist:input.wishlist==='on',offers:input.offers==='on',club:input.club==='on'};await User.updateOne({_id:request.user._id},{$set:{'preferences.notifications':notifications}});request.user.preferences.notifications=notifications;await writeAudit(request,'customer.notification_preferences_updated',{targetType:'user',targetPublicId:request.user.publicId,metadata:notifications});setFlash(request,'success','Notification preferences saved.');response.redirect(customerDashboardPath('notifications'));}));

export default router;

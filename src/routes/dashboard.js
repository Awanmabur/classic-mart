import { Router } from 'express';
import { z } from 'zod';
import { AppError, asyncHandler } from '../core/errors.js';
import { requireAuth, requireOnboarding, requireVerified } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { setFlash } from '../middleware/view.js';
import { WalletTopUp, ReturnRequest, Order, Shipment } from '../models/index.js';
import { decryptSensitive } from '../core/sensitive.js';
import { currentCustomerAccess } from '../services/customer-access.js';
import rateLimit from '../middleware/rate-limit.js';
import { customerDashboardPath } from '../dashboard/customer-registry.js';
import { archiveCustomerAddress, createCustomerAddress, setDefaultCustomerAddress, updateCustomerAddress } from '../services/customer-addresses.js';
import { createWalletTopUp, verifyWalletTopUp } from '../services/customer-wallet.js';
import { hasPermission } from '../core/roles.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { moveCustomerCartItemToWishlist } from '../services/customer-controls.js';
import { streamCustomerWalletStatement } from '../services/customer-wallet-history.js';
import { deleteCustomerAvatar, sendCustomerAvatar, updateCustomerAvatar, uploadCustomerAvatar } from '../services/customer-avatars.js';
import { markCustomerNotificationsRead, updateCustomerNotificationPreferences } from '../services/customer-notification-controls.js';

const router=Router();
function accountOnly(request,_response,next){if(!hasPermission(request.user,'account:read'))return next(new AppError('Customer account access is not available.',403,'CUSTOMER_DASHBOARD_ONLY'));return next();}
const gates=[noStore,requireAuth,requireVerified,requireOnboarding,accountOnly];
const paths=(path)=>[path,path.replace(/^\/dashboard/, '')];
const pickupCodeLimit=rateLimit({scope:'customer-return-pickup-code',windowMs:10*60_000,limit:30,standardHeaders:'draft-8',legacyHeaders:false});

router.get('/api/v1/customer/returns/:publicId/pickup-code',...gates,pickupCodeLimit,asyncHandler(async(request,response)=>{
  const actor=await currentCustomerAccess(request);
  const row=await ReturnRequest.findOne({publicId:request.params.publicId,userId:actor._id,returnMethod:'pickup',status:{$in:['approved','awaiting_return']}}).lean();
  if(!row||!row.returnShipmentPublicId||!await Order.exists({_id:row.orderId,publicId:row.orderPublicId,userId:actor._id,country:row.country}))throw new AppError('This return collection code is unavailable.',404,'RETURN_PICKUP_CODE_UNAVAILABLE');
  const shipment=await Shipment.findOne({publicId:row.returnShipmentPublicId,returnRequestId:row._id,orderId:row.orderId,kind:'return',country:row.country,status:'assigned'}).select('+pickupCodeEncrypted').lean();
  if(!shipment?.pickupCodeEncrypted)throw new AppError('This return collection code is unavailable.',404,'RETURN_PICKUP_CODE_UNAVAILABLE');
  await currentCustomerAccess(request);
  response.set({'Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow, noarchive'}).json({shipmentPublicId:shipment.publicId,pickupCode:decryptSensitive(shipment.pickupCodeEncrypted),purpose:'Give this code only when the assigned carrier physically collects these goods.'});
}));

function digits(currency){try{return new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;}catch{return 2;}}
function amountToMinor(value,currency){const numeric=Number(value);if(!Number.isFinite(numeric)||numeric<=0)throw new AppError('Enter a valid amount.',422,'WALLET_AMOUNT_INVALID');return Math.round((numeric+Number.EPSILON)*10**digits(currency));}

router.get(paths('/dashboard/wallet/statement.csv'),...gates,asyncHandler(async(request,response)=>{
  await streamCustomerWalletStatement(request,response);
}));

router.post('/api/v1/customer/cart/move-to-wishlist',...gates,asyncHandler(async(request,response)=>{
  const result=await moveCustomerCartItemToWishlist(request,request.body);
  delete request.session.checkoutReview;
  response.json(result);
}));
router.get('/account/avatar',...gates,asyncHandler(sendCustomerAvatar));
router.post('/account/avatar',...gates,asyncHandler(async(request,response)=>{
  await new Promise((resolve,reject)=>uploadCustomerAvatar(request,response,error=>{
    try{verifyDeferredCsrf(request);}catch(csrfError){reject(csrfError);return;}
    if(error)reject(error);else resolve();
  }));
  await updateCustomerAvatar(request,request.file);
  setFlash(request,'success','Profile photo updated.');
  response.redirect('/profile');
}));
router.post('/account/avatar/delete',...gates,asyncHandler(async(request,response)=>{
  await deleteCustomerAvatar(request);setFlash(request,'success','Profile photo removed.');response.redirect('/profile');
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

router.post(paths('/dashboard/wallet/top-up'),...gates,asyncHandler(async(request,response)=>{const input=z.object({amount:z.coerce.number().positive(),idempotencyKey:z.string().trim().min(12).max(140)}).parse(request.body);const topup=await createWalletTopUp(request,{amountMinor:amountToMinor(input.amount,request.country.currency),idempotencyKey:input.idempotencyKey});if(topup.status==='succeeded'){setFlash(request,'success','Wallet top-up already completed.');return response.redirect(customerDashboardPath('wallet'));}if(!topup.checkoutUrl)throw new AppError('Wallet checkout is unavailable.',409,'WALLET_CHECKOUT_UNAVAILABLE');return response.redirect(topup.checkoutUrl);}));

router.post(paths('/dashboard/notifications/:id/read'),...gates,asyncHandler(async(request,response)=>{await markCustomerNotificationsRead(request,request.params.id);response.redirect(customerDashboardPath('notifications'));}));
router.post(paths('/dashboard/notifications/read-all'),...gates,asyncHandler(async(request,response)=>{await markCustomerNotificationsRead(request);response.redirect(customerDashboardPath('notifications'));}));
router.post(paths('/dashboard/notifications/preferences'),...gates,asyncHandler(async(request,response)=>{const notifications=await updateCustomerNotificationPreferences(request,request.body);request.user.preferences.notifications=notifications;setFlash(request,'success','Notification preferences saved.');response.redirect(customerDashboardPath('notifications'));}));

export default router;

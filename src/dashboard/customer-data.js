import { CountrySetting, CustomerReward, Dispute, LoyaltyEntry, Notification, Order, Product, Refund, ReturnRequest, Shipment, SupportKnowledge, SupportTicket, TrustCase } from '../models/index.js';
import { AppError } from '../core/errors.js';
import { customerHistoryPage, customerHistoryWindow } from '../services/customer-history.js';
import { listCustomerAddresses } from '../services/customer-addresses.js';
import { customerClubSummary } from '../services/customer-club.js';
import { customerLoyalty, customerWallet, customerCatalogue, customerUnread } from './customer-reads.js';
import { getCountries } from '../services/country.js';
import { getStorefront, publishedProductsByPublicIds, publicEligibilityStages } from '../services/storefront.js';
import { cartView, getOrCreateCart } from '../services/checkout.js';
import { supportTicketCustomerDto } from '../services/support-ticket-pages.js';
import { customerReturnDto, customerRefundDto } from '../services/customer-case-projections.js';
import { customerTrustCaseDto } from '../services/moderation-trust-pages.js';
import { customerDisputeDto } from '../services/customer-dispute-pages.js';
import { customerAvatarUrl } from '../services/customer-avatars.js';
import { customerWalletActivity } from '../services/customer-wallet-history.js';
import { customerRewardSummary } from '../services/customer-rewards.js';
import { customerHistoryFocus, customerSourceMap, customerCaseSource, customerEntrySource } from '../services/customer-source-links.js';

function safeHref(value) { const href=String(value||'').trim(); return href.startsWith('/') && !href.startsWith('//') && !/[\\\x00-\x1f\x7f]/.test(href) ? href : ''; }
function activeOrderQuery(userId, country, currency){return {userId,country,'totals.currency':currency,paymentState:{$in:['paid','credit_due']}};}
async function wishlistData(request){
  const state=await customerCatalogue(request), ids=state?.wishlistProductIds||[];
  const window=customerHistoryWindow(request,'wishlistCursor',{binding:request.country.code,limit:24});
  const rows=ids.length?await Product.aggregate([{$match:{$and:[{_id:{$in:ids},status:'published',countries:request.country.code},window.filter]}},...publicEligibilityStages(request.country),{$sort:window.sort},{$limit:window.limit+1},{$project:{_id:1,publicId:1,createdAt:1}}]):[];
  const page=window.finish(rows), products=await publishedProductsByPublicIds(page.items.map(row=>row.publicId),request.country);
  return {products,wishlistCount:ids.length,pagination:page.pagination};
}
async function cartData(request){const cart=await getOrCreateCart(request);return {...await cartView(cart),version:Number(cart.__v||0)};}

async function loadOverview(request){
  const now=new Date();
  const monthStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1));
  const [recentOrders,orderCount,loyalty,wallet,wishlist,cart,unread,spendRows]=await Promise.all([
    Order.find({userId:request.user._id}).select('publicId status paymentState fulfillmentState totals items createdAt').sort({createdAt:-1}).limit(4).lean(),
    Order.countDocuments({userId:request.user._id}),customerLoyalty(request),customerWallet(request),wishlistData(request),cartData(request),
    customerUnread(request),
    Order.aggregate([{$match:{...activeOrderQuery(request.user._id,request.country.code,request.country.currency)}},{$group:{_id:null,total:{$sum:'$totals.totalMinor'},monthlySavings:{$sum:{$cond:[{$gte:['$createdAt',monthStart]},'$totals.discountMinor',0]}}}}]),
  ]);
  return {recentOrders,orderCount,loyalty,wallet,wishlist,cart,unread,monthlySavingsMinor:Number(spendRows[0]?.monthlySavings||0),club:customerClubSummary(loyalty,Number(spendRows[0]?.total||0),await CountrySetting.findOne({code:request.country.code,active:true}).lean())};
}
async function loadOrders(request){
  const status=request.query?.status||'all';
  if(typeof status!=='string'||!['all','processing','shipped','delivered'].includes(status))throw new AppError('Choose a valid order status.',422,'ORDER_FILTER_INVALID');
  const processing=['unfulfilled','processing','partially_ready','ready'],shipped=['partially_shipped','shipped','partially_delivered'];
  const scope={userId:request.user._id},filter={...scope,...(status==='processing'?{fulfillmentState:{$in:processing},status:{$nin:['cancelled','expired']}}:status==='shipped'?{fulfillmentState:{$in:shipped}}:status==='delivered'?{fulfillmentState:'delivered'}:{})};
  const [page,counts]=await Promise.all([
    customerHistoryPage(Order,filter,request,'ordersCursor',{binding:status,select:'publicId status paymentState fulfillmentState cancellationState returnState refundState totals items paymentMethod deliveryMethod createdAt updatedAt'}),
    Order.aggregate([{$match:scope},{$group:{
      _id:null,all:{$sum:1},
      processing: { $sum: { $cond: [
        { $and: [
          { $in: ['$fulfillmentState', processing] },
          { $not: [{ $in: ['$status', ['cancelled', 'expired']] }] },
        ] }, 1, 0,
      ] } },
      shipped:{$sum:{$cond:[{$in:['$fulfillmentState',shipped]},1,0]}},
      returns: { $sum: { $cond: [
        { $and: [
          { $ne: ['$returnState', 'none'] },
          { $ne: [{ $ifNull: ['$returnState', null] }, null] },
        ] }, 1, 0,
      ] } },
    }}]),
  ]);
  return {orders:page.items,pagination:page.pagination,filter:status,counts:counts[0]||{all:0,processing:0,shipped:0,returns:0}};
}
async function loadAddresses(request){
  const addresses=await listCustomerAddresses(request.user._id),edit=request.query?.edit;
  if(edit!==undefined&&(typeof edit!=='string'||edit.length>120||!addresses.some(row=>row.publicId===edit)))throw new AppError('Address not found.',404,'ADDRESS_NOT_FOUND');
  return {addresses,countries:await getCountries(),editingAddress:edit?addresses.find(row=>row.publicId===edit):null};
}
async function loadRewards(request){
  const [summary,page,focused]=await Promise.all([customerRewardSummary({userId:request.user._id,country:request.country.code,currency:request.country.currency}),customerHistoryPage(LoyaltyEntry,{userId:request.user._id,country:request.country.code},request,'rewardsCursor',{binding:request.country.code}),customerHistoryFocus(CustomerReward,request,'reward',{userId:request.user._id,country:request.country.code})]);
  if(focused&&!summary.rewards.some(row=>row.publicId===focused.publicId)){
    const {publicId,rewardKey,label,kind,pointsCost,valueMinor,minimumSpendMinor,maximumDiscountMinor,status,expiresAt,multiplierBps,trialShippingDiscountBps,orderPublicId,currency}=focused;
    summary.rewards.unshift({publicId,rewardKey,label,kind,pointsCost,valueMinor,minimumSpendMinor,maximumDiscountMinor,status,expiresAt,multiplierBps,trialShippingDiscountBps,orderPublicId,currency});
  }
  const issuedRewards=summary.rewards.map(row=>({...row,country:request.country.code,currency:row.currency||request.country.currency}));
  const sources=await customerSourceMap(request.user._id,{entries:page.items,issuedRewards});
  summary.rewards=issuedRewards.map(row=>({...row,status:row.status==='issued'&&new Date(row.expiresAt)<=new Date()?'expired':row.status,
    availableAtCheckout:row.status==='issued'&&new Date(row.expiresAt)>new Date()&&row.currency===request.country.currency,
    orderPublicId:sources.get(`reward_order:${row.publicId}`)?.publicId||'',orderHref:sources.get(`reward_order:${row.publicId}`)?.href||''}));
  return {...summary,loyalty:summary.account,currency:request.country.currency,entries:page.items.map(row=>{const source=customerEntrySource(row,sources);return {...row,sourceHref:source?.href||'',referencePublicId:source?.publicId||''};}),pagination:page.pagination};
}
async function loadWallet(request){const [wallet,activity]=await Promise.all([customerWallet(request,true),customerWalletActivity(request)]);return {wallet:{...wallet,...activity}};}
async function loadReturns(request){
  const refundWindow=customerHistoryWindow(request,'refundsCursor');
  const [returnPage,refundRows,eligiblePage,disputePage,casePage,activeReturns,completedRefunds,focusedReturn,focusedRefund]=await Promise.all([
    customerHistoryPage(ReturnRequest,{userId:request.user._id},request,'returnsCursor'),Refund.aggregate([{$match:refundWindow.filter},{$lookup:{from:Order.collection.name,localField:'orderId',foreignField:'_id',as:'_ownedOrder'}},{$match:{'_ownedOrder.userId':request.user._id}},{$sort:refundWindow.sort},{$limit:refundWindow.limit+1},{$project:{_ownedOrder:0}}]),
    customerHistoryPage(Order,{userId:request.user._id,fulfillmentState:'delivered'},request,'eligibleCursor',{select:'publicId items policySnapshot createdAt'}),
    customerHistoryPage(Dispute,{userId:request.user._id},request,'disputesCursor'),customerHistoryPage(TrustCase,{reporterUserId:request.user._id},request,'casesCursor'),
    ReturnRequest.countDocuments({userId:request.user._id,status:{$nin:['refunded','rejected','closed','cancelled']}}),
    Refund.aggregate([{$match:{status:'completed'}},{$lookup:{from:Order.collection.name,localField:'orderId',foreignField:'_id',as:'_ownedOrder'}},{$match:{'_ownedOrder.userId':request.user._id}},{$count:'count'}]),
    customerHistoryFocus(ReturnRequest,request,'return',{userId:request.user._id}),customerHistoryFocus(Refund,request,'refund',{}),
  ]);
  const orders=eligiblePage.items,refundPage=refundWindow.finish(refundRows);
  if(focusedReturn&&!returnPage.items.some(row=>row.publicId===focusedReturn.publicId))returnPage.items.unshift(focusedReturn);
  if(focusedRefund&&!refundPage.items.some(row=>row.publicId===focusedRefund.publicId))refundPage.items.unshift(focusedRefund);
  const sources=await customerSourceMap(request.user._id,{returns:returnPage.items,refunds:refundPage.items,disputes:disputePage.items});
  if(focusedReturn&&!sources.has(`return:${focusedReturn.publicId}`)||focusedRefund&&!sources.has(`refund:${focusedRefund.publicId}`))throw new AppError('History record not found.',404,'CUSTOMER_HISTORY_RECORD_NOT_FOUND');
  const shipments = await Shipment.find({orderId:{$in:orders.map(order=>order._id)},kind:'outbound',status:'delivered'}).select('orderId deliveredAt').sort({deliveredAt:-1}).lean();
  const deliveredAt = new Map();
  for (const shipment of shipments) if (shipment.deliveredAt && !deliveredAt.has(String(shipment.orderId))) deliveredAt.set(String(shipment.orderId), shipment.deliveredAt);
  const now=Date.now(),returnableLines=[];
  for(const order of orders){const deliveryDate = deliveredAt.get(String(order._id));if(!deliveryDate)continue;const eligibleUntil=new Date(deliveryDate).getTime()+Number(order.policySnapshot?.returnWindowDays??30)*86400000;if(eligibleUntil<now)continue;for(const item of order.items||[]){const remaining=Math.max(0,Number(item.deliveredQuantity||0)-Number(item.returnReservedQuantity||0)-Number(item.returnedQuantity||0));if(remaining>0)returnableLines.push({orderPublicId:order.publicId,orderLineId:item.linePublicId,title:item.title,variantTitle:item.variantTitle,remaining});}}
  return {returns:returnPage.items.map(row=>customerCaseSource(row,customerReturnDto(row),sources,'return')),refunds:refundPage.items.map(row=>customerCaseSource(row,customerRefundDto(row),sources,'refund')),returnableLines,disputes:disputePage.items.map(row=>customerCaseSource(row,customerDisputeDto(row),sources,'dispute')),cases:casePage.items.map(customerTrustCaseDto),counts:{activeReturns,completedRefunds:completedRefunds[0]?.count||0},pagination:{returns:returnPage.pagination,refunds:refundPage.pagination,eligible:eligiblePage.pagination,disputes:disputePage.pagination,cases:casePage.pagination}};
}
async function loadSupport(request){const [ticketPage,knowledge,orderPage]=await Promise.all([customerHistoryPage(SupportTicket,{userId:request.user._id},request,'ticketsCursor',{select:'publicId userId country orderPublicId category subject status priority notes createdAt updatedAt resolvedAt reopenedAt __v'}),SupportKnowledge.find({country:request.user.country,status:'published'}).select('publicId title slug body category').sort({publishedAt:-1}).limit(12).lean(),customerHistoryPage(Order,{userId:request.user._id},request,'supportOrdersCursor',{select:'publicId createdAt'})]);return {tickets:ticketPage.items.map(supportTicketCustomerDto),knowledge,orders:orderPage.items,pagination:{tickets:ticketPage.pagination,orders:orderPage.pagination}};}
async function loadProfile(request){return {countries:await getCountries(),avatarUrl:await customerAvatarUrl(request.user._id)};}
async function loadCategories(request){const storefront=await getStorefront(request.country);return {categories:storefront.categories,featuredProducts:storefront.products.slice(0,12)};}
async function loadCart(request){const [cart,wallet]=await Promise.all([cartData(request),customerWallet(request)]);return {cart,wallet};}
async function loadNotifications(request){const page=await customerHistoryPage(Notification,{userId:request.user._id,$or:[{expiresAt:null},{expiresAt:{$gt:new Date()}}]},request,'notificationsCursor');return {notifications:page.items.map((row)=>({...row,href:safeHref(row.href)})),preferences:request.user.preferences?.notifications||{},pagination:page.pagination};}
async function loadClub(request){return {...await customerRewardSummary({userId:request.user._id,country:request.country.code,currency:request.country.currency}),currency:request.country.currency};}

const LOADERS={dashboard:loadOverview,orders:loadOrders,wishlist:wishlistData,addresses:loadAddresses,rewards:loadRewards,wallet:loadWallet,returns:loadReturns,support:loadSupport,profile:loadProfile,categories:loadCategories,cart:loadCart,notifications:loadNotifications,club:loadClub};
export async function loadCustomerDashboardPage(request,pageId){const loader=LOADERS[pageId];if(!loader)return null;return loader(request);}

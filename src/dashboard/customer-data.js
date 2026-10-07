import { CountrySetting, CustomerCatalogueState, Dispute, LoyaltyAccount, LoyaltyEntry, Notification, Order, Refund, ReturnRequest, Shipment, SupportKnowledge, SupportTicket, TrustCase } from '../models/index.js';
import { listCustomerAddresses } from '../services/customer-addresses.js';
import { customerClubSummary } from '../services/customer-club.js';
import { customerWalletSummary } from '../services/customer-wallet.js';
import { getCountries } from '../services/country.js';
import { getStorefront, publicIdsForMongoIds, publishedProductsByPublicIds } from '../services/storefront.js';
import { cartView, getOrCreateCart } from '../services/checkout.js';

function safeHref(value) { const href=String(value||'').trim(); return href.startsWith('/') && !href.startsWith('//') && !/[\\\x00-\x1f\x7f]/.test(href) ? href : ''; }
function activeOrderQuery(userId){return {userId,paymentState:{$in:['paid','credit_due']}};}
async function catalogueState(userId){return CustomerCatalogueState.findOne({userId}).lean();}
async function wishlistData(request){const state=await catalogueState(request.user._id);const ids=await publicIdsForMongoIds(state?.wishlistProductIds||[]);const products=await publishedProductsByPublicIds(ids,request.country);return {products,wishlistCount:ids.length};}
async function cartData(request){const cart=await getOrCreateCart(request);return cartView(cart);}

async function loadOverview(request){
  const now=new Date();
  const monthStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1));
  const [recentOrders,orderCount,loyalty,wallet,wishlist,cart,unread,spendRows,monthlySavingsRows]=await Promise.all([
    Order.find({userId:request.user._id}).select('publicId status paymentState fulfillmentState totals items createdAt').sort({createdAt:-1}).limit(4).lean(),
    Order.countDocuments({userId:request.user._id}),LoyaltyAccount.findOne({userId:request.user._id}).lean(),customerWalletSummary(request.user),wishlistData(request),cartData(request),
    Notification.countDocuments({userId:request.user._id,readAt:null,$or:[{expiresAt:null},{expiresAt:{$gt:new Date()}}]}),
    Order.aggregate([{$match:{...activeOrderQuery(request.user._id)}},{$group:{_id:null,total:{$sum:'$totals.totalMinor'}}}]),
    Order.aggregate([{$match:{...activeOrderQuery(request.user._id),createdAt:{$gte:monthStart}}},{$group:{_id:null,total:{$sum:'$totals.discountMinor'}}}]),
  ]);
  return {recentOrders,orderCount,loyalty,wallet,wishlist,cart,unread,monthlySavingsMinor:Number(monthlySavingsRows[0]?.total||0),club:customerClubSummary(loyalty,Number(spendRows[0]?.total||0),await CountrySetting.findOne({code:request.country.code,active:true}).lean())};
}
async function loadOrders(request){const orders=await Order.find({userId:request.user._id}).select('publicId status paymentState fulfillmentState cancellationState returnState refundState totals items paymentMethod deliveryMethod createdAt updatedAt').sort({createdAt:-1}).limit(50).lean();return {orders};}
async function loadAddresses(request){return {addresses:await listCustomerAddresses(request.user._id),countries:await getCountries()};}
async function loadRewards(request){const [loyalty,entries]=await Promise.all([LoyaltyAccount.findOne({userId:request.user._id}).lean(),LoyaltyEntry.find({userId:request.user._id}).sort({createdAt:-1}).limit(40).lean()]);return {loyalty,entries};}
async function loadWallet(request){return {wallet:await customerWalletSummary(request.user)};}
async function loadReturns(request){
  const [returns,refunds,orders,disputes,cases]=await Promise.all([
    ReturnRequest.find({userId:request.user._id}).sort({createdAt:-1}).limit(30).lean(),Refund.find({userId:request.user._id}).sort({createdAt:-1}).limit(30).lean(),
    Order.find({userId:request.user._id,fulfillmentState:'delivered'}).select('publicId items policySnapshot createdAt').sort({createdAt:-1}).limit(40).lean(),
    Dispute.find({userId:request.user._id}).sort({createdAt:-1}).limit(20).lean(),TrustCase.find({reporterUserId:request.user._id}).sort({createdAt:-1}).limit(20).lean(),
  ]);
  const shipments = await Shipment.find({orderId:{$in:orders.map(order=>order._id)},kind:'outbound',status:'delivered'}).select('orderId deliveredAt').sort({deliveredAt:-1}).lean();
  const deliveredAt = new Map();
  for (const shipment of shipments) if (shipment.deliveredAt && !deliveredAt.has(String(shipment.orderId))) deliveredAt.set(String(shipment.orderId), shipment.deliveredAt);
  const now=Date.now(),returnableLines=[];
  for(const order of orders){const deliveryDate = deliveredAt.get(String(order._id));if(!deliveryDate)continue;const eligibleUntil=new Date(deliveryDate).getTime()+Number(order.policySnapshot?.returnWindowDays??30)*86400000;if(eligibleUntil<now)continue;for(const item of order.items||[]){const remaining=Math.max(0,Number(item.deliveredQuantity||0)-Number(item.returnReservedQuantity||0)-Number(item.returnedQuantity||0));if(remaining>0)returnableLines.push({orderPublicId:order.publicId,orderLineId:item.linePublicId,title:item.title,variantTitle:item.variantTitle,remaining});}}
  return {returns,refunds,returnableLines,disputes,cases};
}
async function loadSupport(request){const [tickets,knowledge,orders]=await Promise.all([SupportTicket.find({userId:request.user._id}).select('publicId orderPublicId category subject status priority notes createdAt resolvedAt').sort({createdAt:-1}).limit(40).lean(),SupportKnowledge.find({country:request.user.country,status:'published'}).select('publicId title slug body category').sort({publishedAt:-1}).limit(12).lean(),Order.find({userId:request.user._id}).select('publicId createdAt').sort({createdAt:-1}).limit(30).lean()]);return {tickets,knowledge,orders};}
async function loadProfile(request){return {countries:await getCountries()};}
async function loadCategories(request){const storefront=await getStorefront(request.country);return {categories:storefront.categories,featuredProducts:storefront.products.slice(0,12)};}
async function loadCart(request){const [cart,wallet]=await Promise.all([cartData(request),customerWalletSummary(request.user)]);return {cart,wallet};}
async function loadNotifications(request){const notifications=await Notification.find({userId:request.user._id,$or:[{expiresAt:null},{expiresAt:{$gt:new Date()}}]}).sort({createdAt:-1}).limit(60).lean();return {notifications:notifications.map((row)=>({...row,href:safeHref(row.href)})),preferences:request.user.preferences?.notifications||{}};}
async function loadClub(request){const [loyalty,spendRows]=await Promise.all([LoyaltyAccount.findOne({userId:request.user._id}).lean(),Order.aggregate([{$match:{...activeOrderQuery(request.user._id)}},{$group:{_id:null,total:{$sum:'$totals.totalMinor'}}}])]);return {club:customerClubSummary(loyalty,Number(spendRows[0]?.total||0),await CountrySetting.findOne({code:request.country.code,active:true}).lean())};}

const LOADERS={dashboard:loadOverview,orders:loadOrders,wishlist:wishlistData,addresses:loadAddresses,rewards:loadRewards,wallet:loadWallet,returns:loadReturns,support:loadSupport,profile:loadProfile,categories:loadCategories,cart:loadCart,notifications:loadNotifications,club:loadClub};
export async function loadCustomerDashboardPage(request,pageId){const loader=LOADERS[pageId];if(!loader)return null;return loader(request);}

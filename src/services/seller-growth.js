import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import {
  BusinessBudget, Campaign, CountrySetting, CustomerCatalogueState, PriceSchedule, ProcurementRequest, Product, ProductVariant, PurchaseOrder, QuoteRequest,
  SellerPromotion, StoreBroadcast, User,
} from '../models/index.js';
import { addOutboxEvent } from './outbox.js';
import { acceptPurchaseOrderIntoCommerce } from './business-fulfillment.js';
import { issueQuotationDocument } from './business-documents.js';
import { cursorScope, cursorSort, pageResult } from './pagination.js';

function activeWindowQuery(now=new Date()){return {status:'active',startsAt:{$lte:now},$or:[{endsAt:null},{endsAt:{$exists:false}},{endsAt:{$gt:now}}]};}
export async function createSellerPromotion(request,input){
  const type=input.type;const productIds=[...new Set((input.productPublicIds||[]).map(String).filter(Boolean))];
  const products=productIds.length?await Product.find({publicId:{$in:productIds},storeId:request.store._id}).lean():[];
  if(productIds.length!==products.length)throw new AppError('Every promotion product must belong to your store.',422,'PROMOTION_PRODUCT_INVALID');
  const discountBps=Math.max(0,Math.min(9000,Number(input.discountBps||0)));const fixed=Math.max(0,Number(input.fixedDiscountMinor||0));
  if(['voucher','bundle','quantity_break'].includes(type)&&discountBps<=0&&fixed<=0)throw new AppError('Enter a discount for this promotion.',422,'PROMOTION_DISCOUNT_REQUIRED');
  if(type==='voucher'&&!String(input.code||'').trim())throw new AppError('Voucher code is required.',422,'PROMOTION_CODE_REQUIRED');
  if(productIds.length&&['voucher','bundle','quantity_break'].includes(type)){
    const variants=await ProductVariant.find({productId:{$in:products.map(p=>p._id)},active:true}).lean();
    for(const v of variants){const floor=Number(v.minimumPriceMinor||0);const discounted=Math.max(0,v.priceMinor-Math.max(fixed,Math.floor(v.priceMinor*discountBps/10000)));if(floor>0&&discounted<floor)throw new AppError(`Promotion would price ${v.sku} below its minimum price.`,409,'MINIMUM_PRICE_VIOLATION');}
  }
  try{return await SellerPromotion.create({publicId:publicId('spr'),storeId:request.store._id,storePublicId:request.store.publicId,country:request.store.country,currency:request.store.currency,type,name:String(input.name).trim().slice(0,140),code:String(input.code||'').trim().toUpperCase(),productPublicIds:productIds,discountBps,fixedDiscountMinor:fixed,minQuantity:Math.max(1,Number(input.minQuantity||1)),minSubtotalMinor:Math.max(0,Number(input.minSubtotalMinor||0)),disclosureText:String(input.disclosureText||'Sponsored placement.').trim().slice(0,300),startsAt:input.startsAt?new Date(input.startsAt):new Date(),endsAt:input.endsAt?new Date(input.endsAt):undefined,status:input.status==='active'?'active':'draft',createdByUserId:request.user._id});}catch(error){if(error?.code===11000)throw new AppError('That voucher code is already in use.',409,'PROMOTION_CODE_EXISTS');throw error;}
}

export async function promotionMarginPreview(request,input){
  const productIds=[...new Set((input.productPublicIds||[]).map(String).filter(Boolean))];
  const products=productIds.length?await Product.find({publicId:{$in:productIds},storeId:request.store._id}).select('_id publicId title').lean():await Product.find({storeId:request.store._id,status:{$in:['approved','published']}}).select('_id publicId title').limit(100).lean();
  if(!products.length)throw new AppError('Choose at least one product with an active variant.',422,'PROMOTION_PREVIEW_PRODUCTS_REQUIRED');
  const variants=await ProductVariant.find({productId:{$in:products.map(p=>p._id)},storeId:request.store._id,active:true}).select('productId publicId sku priceMinor costMinor minimumPriceMinor').lean();
  const pmap=new Map(products.map(p=>[String(p._id),p]));const nonDiscount=['free_shipping','sponsored'].includes(input.type);const discountBps=nonDiscount?0:Math.max(0,Math.min(9000,Number(input.discountBps||0))),fixed=nonDiscount?0:Math.max(0,Number(input.fixedDiscountMinor||0));
  return variants.map(v=>{const raw=Math.max(fixed,Math.floor(v.priceMinor*discountBps/10000));const floor=Math.min(v.priceMinor,Math.max(0,Number(v.minimumPriceMinor||0)));const discountMinor=Math.min(raw,Math.max(0,v.priceMinor-floor));const netPriceMinor=v.priceMinor-discountMinor;const costMinor=Math.max(0,Number(v.costMinor||0));return{productPublicId:pmap.get(String(v.productId))?.publicId||'',title:pmap.get(String(v.productId))?.title||'',variantPublicId:v.publicId,sku:v.sku,priceMinor:v.priceMinor,minimumPriceMinor:floor,costMinor,discountMinor,netPriceMinor,marginMinor:netPriceMinor-costMinor,marginBps:netPriceMinor>0?Math.floor((netPriceMinor-costMinor)*10000/netPriceMinor):0};});
}

export async function setSellerPromotionStatus(request,id,status){const row=await SellerPromotion.findOne({publicId:id,storeId:request.store._id});if(!row)throw new AppError('Promotion not found.',404,'PROMOTION_NOT_FOUND');row.status=status;await row.save();return row;}
export async function scheduleVariantPrice(request,input){const variant=await ProductVariant.findOne({publicId:input.variantId,storeId:request.store._id,active:true});if(!variant)throw new AppError('Variant not found.',404,'VARIANT_NOT_FOUND');const minimum=Math.max(Number(variant.minimumPriceMinor||0),Number(input.minimumPriceMinor||0));const next=Number(input.newPriceMinor);if(next<minimum)throw new AppError('Scheduled price cannot be below the minimum price.',409,'MINIMUM_PRICE_VIOLATION');variant.minimumPriceMinor=minimum;if(input.costMinor!==undefined)variant.costMinor=Math.max(0,Number(input.costMinor));await variant.save();return PriceSchedule.create({publicId:publicId('psch'),storeId:request.store._id,variantId:variant._id,variantPublicId:variant.publicId,previousPriceMinor:variant.priceMinor,newPriceMinor:next,minimumPriceMinor:minimum,startsAt:new Date(input.startsAt),status:'scheduled',createdByUserId:request.user._id});}
export async function applyDuePriceSchedules(){const due=await PriceSchedule.find({status:'scheduled',startsAt:{$lte:new Date()}}).limit(100);for(const row of due){const variant=await ProductVariant.findById(row.variantId);if(!variant){row.status='failed';row.failureReason='Variant no longer exists.';await row.save();continue;}if(row.newPriceMinor<Math.max(row.minimumPriceMinor,variant.minimumPriceMinor||0)){row.status='failed';row.failureReason='Minimum price changed before schedule execution.';await row.save();continue;}variant.priceMinor=row.newPriceMinor;variant.minimumPriceMinor=Math.max(variant.minimumPriceMinor||0,row.minimumPriceMinor);await variant.save();row.status='applied';row.appliedAt=new Date();await row.save();}}
export async function createStoreBroadcast(request,input){const row=await StoreBroadcast.create({publicId:publicId('brd'),storeId:request.store._id,storePublicId:request.store.publicId,country:request.store.country,subject:String(input.subject).trim().slice(0,180),body:String(input.body).trim().slice(0,4000),status:'draft',createdByUserId:request.user._id});return row;}
export async function queueStoreBroadcast(request,id){const row=await StoreBroadcast.findOne({publicId:id,storeId:request.store._id,status:'draft'});if(!row)throw new AppError('Draft broadcast not found.',404,'BROADCAST_NOT_FOUND');const states=await CustomerCatalogueState.find({followedStoreIds:request.store._id}).select('userId').lean();const ids=states.map(s=>s.userId);const users=ids.length?await User.find({_id:{$in:ids},status:'active',country:request.store.country,'consents.marketing':true}).select('publicId email country').lean():[];for(const user of users)await addOutboxEvent({type:'store.broadcast',aggregateType:'store_broadcast',aggregatePublicId:row.publicId,payload:{userPublicId:user.publicId,email:user.email,subject:row.subject,body:row.body,storePublicId:request.store.publicId,country:user.country,consentBasis:'marketing+follow'}});row.status='queued';row.recipientCount=users.length;row.queuedAt=new Date();await row.save();return row;}
export async function sellerRespondQuote(request,id,{message,offeredUnitMinor=[],validUntil}){
  const session=await mongoose.startSession();let result;
  try{await session.withTransaction(async()=>{
    const row=await QuoteRequest.findOne({publicId:id,storeId:request.store._id,status:{$in:['requested','negotiating','responded']}}).session(session);
    if(!row)throw new AppError('Quotation request not found.',404,'QUOTE_NOT_FOUND');
    const prices=Array.isArray(offeredUnitMinor)?offeredUnitMinor:[offeredUnitMinor];
    if(prices.length!==row.items.length)throw new AppError('Enter one unit price for every quoted SKU.',422,'QUOTE_LINE_PRICE_REQUIRED');
    let total=0;
    for(let i=0;i<row.items.length;i++){
      const unit=Math.max(0,Number(prices[i]));if(!Number.isSafeInteger(unit))throw new AppError('Quotation unit prices must be whole minor-unit amounts.',422,'QUOTE_LINE_PRICE_INVALID');
      row.items[i].offeredUnitMinor=unit;row.items[i].offeredLineMinor=unit*Number(row.items[i].quantity||0);total+=row.items[i].offeredLineMinor;
    }
    if(total<=0)throw new AppError('Enter a valid quotation total.',422,'QUOTE_AMOUNT_REQUIRED');
    row.offeredTotalMinor=total;row.validUntil=validUntil?new Date(validUntil):new Date(Date.now()+7*86400000);
    if(!Number.isFinite(row.validUntil.getTime())||row.validUntil<=new Date())throw new AppError('Quotation validity must end in the future.',422,'QUOTE_VALID_UNTIL');
    row.revision=Math.max(0,Number(row.revision||0))+1;
    row.messages.push({actorType:'seller',actorUserId:request.user._id,message:String(message||'Quotation updated.').trim().slice(0,2000),offeredTotalMinor:total});row.status='responded';await row.save({session});
    await issueQuotationDocument(row,{session,issuedByUserId:request.user._id});result=row;
  });return result;}finally{await session.endSession();}
}

export async function decidePurchaseOrder(request,id,status){
  if(!['accepted','rejected'].includes(status))throw new AppError('Invalid purchase-order decision.',422,'PURCHASE_ORDER_DECISION');
  if(status==='accepted')return (await acceptPurchaseOrderIntoCommerce({request,purchaseOrderPublicId:id})).po;
  const session=await mongoose.startSession();let decided;
  try{await session.withTransaction(async()=>{
    const row=await PurchaseOrder.findOne({publicId:id,storeId:request.store._id,status:'issued'}).session(session);if(!row)throw new AppError('Issued purchase order not found.',404,'PURCHASE_ORDER_NOT_FOUND');
    const procurement=row.procurementRequestId?await ProcurementRequest.findById(row.procurementRequestId).session(session):null;if(!procurement)throw new AppError('Purchase order is missing its approved procurement request.',409,'PROCUREMENT_APPROVAL_REQUIRED');
    row.status='rejected';row.timeline.push({type:'seller.rejected',message:'Seller rejected purchase order.',actorUserId:request.user._id});await row.save({session});
    if(row.quoteRequestId)await QuoteRequest.updateOne({_id:row.quoteRequestId},{$set:{status:'rejected'}},{session});
    const accepted=await PurchaseOrder.exists({procurementRequestId:procurement._id,status:{$in:['accepted','payment_pending','processing','fulfilled']}}).session(session);procurement.status=accepted?'partially_ordered':'approved';procurement.timeline.push({type:'seller_rejected',message:`Seller ${request.store.publicId} rejected its purchase order; the remaining approved procurement stays open for another quotation.`,actorUserId:request.user._id});await procurement.save({session});decided=row;
  });return decided;}finally{await session.endSession();}
}

export async function sellerGrowthWorkspace(request){
  const size=40,storeId=request.store._id;
  const page=async(Model,base,cursor,{field='createdAt',direction=-1,type='date',populate=[],select=''}={})=>{let q=Model.find(cursorScope(base,cursor,{field,direction,type})).sort(cursorSort(field,direction)).limit(size+1);if(select)q=q.select(select);for(const spec of populate)q=q.populate(...spec);const [rows,total]=await Promise.all([q.lean(),Model.countDocuments(base)]);return pageResult(rows,{field,direction,type,limit:size,total});};
  const [promotionsPage,schedulesPage,broadcastsPage,quotesPage,variantsPage,purchaseOrdersPage,productsPage]=await Promise.all([
    page(SellerPromotion,{storeId},request.query.promotionsAfter),
    page(PriceSchedule,{storeId},request.query.schedulesAfter),
    page(StoreBroadcast,{storeId},request.query.broadcastsAfter),
    page(QuoteRequest,{storeId},request.query.quotesAfter,{populate:[['organizationId','companyName']]}),
    page(ProductVariant,{storeId,active:true},request.query.variantsAfter,{field:'sku',direction:1,type:'string'}),
    page(PurchaseOrder,{storeId},request.query.purchaseOrdersAfter,{populate:[['organizationId','companyName']]}),
    page(Product,{storeId,status:{$in:['approved','published']}},request.query.productsAfter,{field:'title',direction:1,type:'string',select:'publicId title status'}),
  ]);
  return {promotions:promotionsPage.items,schedules:schedulesPage.items,broadcasts:broadcastsPage.items,quotes:quotesPage.items,variants:variantsPage.items,purchaseOrders:purchaseOrdersPage.items,products:productsPage.items,queuePages:{promotions:promotionsPage.page,schedules:schedulesPage.page,broadcasts:broadcastsPage.page,quotes:quotesPage.page,variants:variantsPage.page,purchaseOrders:purchaseOrdersPage.page,products:productsPage.page}};
}

export async function promotionQuote({rows,country,codes=[]}){
  if(!rows.length)return {discountMinor:0,freeShipping:false,applications:[],storeDiscounts:{}};
  const now=new Date();const storeIds=[...new Set(rows.map(r=>r.storeId))];const promos=await SellerPromotion.find({country,...activeWindowQuery(now),storePublicId:{$in:storeIds}}).lean();const codeSet=new Set(codes.map(v=>String(v).trim().toUpperCase()).filter(Boolean));let discount=0;let freeShipping=false;const applications=[];const storeDiscounts={};
  const byStore=new Map();const capacity=new Map();for(const row of rows){const arr=byStore.get(row.storeId)||[];arr.push(row);byStore.set(row.storeId,arr);const key=`${row.storeId}:${row.variantId||row.productId}`;const floor=Math.min(Number(row.priceMinor||0),Math.max(0,Number(row.minimumPriceMinor||0)));capacity.set(key,Math.max(0,(Number(row.priceMinor||0)-floor)*Number(row.quantity||0)));}
  for(const promo of promos){const items=byStore.get(promo.storePublicId)||[];if(!items.length)continue;const eligible=promo.productPublicIds.length?items.filter(i=>promo.productPublicIds.includes(i.productId)):items;const eligibleSubtotal=eligible.reduce((sum,item)=>sum+Number(item.priceMinor||0)*Number(item.quantity||0),0);const eligibleQty=eligible.reduce((sum,item)=>sum+Number(item.quantity||0),0);if(!eligible.length||eligibleSubtotal<promo.minSubtotalMinor||eligibleQty<promo.minQuantity)continue;if(promo.type==='voucher'&&!codeSet.has(promo.code))continue;if(promo.type==='bundle'&&!promo.productPublicIds.every(id=>items.some(i=>i.productId===id)))continue;if(promo.type==='free_shipping'){freeShipping=true;applications.push({id:promo.publicId,type:promo.type,name:promo.name,discountMinor:0});continue;}if(promo.type==='sponsored')continue;
    const raw=Math.max(Number(promo.fixedDiscountMinor||0),Math.floor(eligibleSubtotal*Number(promo.discountBps||0)/10000));const availableCapacity=eligible.reduce((sum,row)=>sum+(capacity.get(`${row.storeId}:${row.variantId||row.productId}`)||0),0);let value=Math.min(eligibleSubtotal,raw,availableCapacity);if(value<=0)continue;const applied=value;for(const row of eligible){if(value<=0)break;const key=`${row.storeId}:${row.variantId||row.productId}`;const remaining=capacity.get(key)||0;const consume=Math.min(remaining,value);capacity.set(key,remaining-consume);value-=consume;}discount+=applied;storeDiscounts[promo.storePublicId]=(storeDiscounts[promo.storePublicId]||0)+applied;applications.push({id:promo.publicId,type:promo.type,name:promo.name,discountMinor:applied});}
  return {discountMinor:discount,freeShipping,applications,storeDiscounts};
}
export function marketplacePromoterCampaignPublicId(country) {
  const code = String(country || '').trim().toLowerCase();
  return `cmp_marketplace_${code || 'global'}`;
}

export async function activeSponsoredProducts(country, productPublicIds = []) {
  const countryCode = String(country || '').trim().toUpperCase();
  const now = new Date();
  const ids = [...new Set((productPublicIds || []).map((value) => String(value || '').trim()).filter(Boolean))];
  const [placements, campaigns, setting] = await Promise.all([
    SellerPromotion.find({ country: countryCode, type: 'sponsored', ...activeWindowQuery(now) })
      .select('publicId productPublicIds disclosureText')
      .lean(),
    Campaign.find({
      country: countryCode,
      status: 'active',
      visibility: 'public',
      $and: [
        { $or: [{ startsAt: null }, { startsAt: { $exists: false } }, { startsAt: { $lte: now } }] },
        { $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gt: now } }] },
      ],
    })
      .select('publicId productPublicIds commissionBps disclosureText')
      .lean(),
    CountrySetting.findOne({ code: countryCode, active: true }).select('growth.promoterCommissionBps policyVersion').lean(),
  ]);

  const map = new Map();
  const defaultCommissionBps = Math.max(0, Math.min(5000, Number(setting?.growth?.promoterCommissionBps ?? 300) || 0));
  if (defaultCommissionBps > 0) {
    for (const id of ids) {
      map.set(id, {
        sponsored: false,
        promoterCampaignId: marketplacePromoterCampaignPublicId(countryCode),
        promoterCommissionBps: defaultCommissionBps,
        disclosure: 'Promoters may earn the displayed commission on qualifying Classic Mart purchases.',
      });
    }
  }
  for (const row of placements) {
    for (const id of row.productPublicIds || []) {
      const existing = map.get(id) || {};
      map.set(id, {
        ...existing,
        sponsored: true,
        promotionId: row.publicId,
        disclosure: row.disclosureText || existing.disclosure || 'Sponsored placement.',
        promoterCommissionBps: Number(existing.promoterCommissionBps) || 0,
      });
    }
  }

  for (const campaign of campaigns) {
    const campaignCommissionBps = Math.max(0, Math.min(5000, Number(campaign.commissionBps) || 0));
    for (const id of campaign.productPublicIds || []) {
      const existing = map.get(id) || {};
      map.set(id, {
        ...existing,
        sponsored: true,
        sponsoredCampaignId: campaign.publicId,
        campaignCommissionBps,
        // The public Prom badge always represents the marketplace-wide country rate.
        // Seller campaigns can carry a separate campaign rate without changing that base badge.
        disclosure: campaign.disclosureText || existing.disclosure || 'Sponsored/affiliate promotion for Classic Mart.',
      });
    }
  }
  return map;
}

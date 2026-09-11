import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { currentTraceFields } from '../core/trace.js';
import { orderAccessQuery } from './order-access.js';
import { orderDisplayStatus, syncLegacyOrderStatus } from './order-state.js';
import { promotionQuote } from './seller-growth.js';
import { publicProductImageUrl } from './product-media-url.js';
import { allocateSellerLineSettlement } from './money.js';
import {
  BusinessInvoice,
  Cart,
  CountrySetting,
  DeliveryOffer,
  InventoryMovement,
  InventoryReservation,
  Order,
  Parcel,
  PaymentIntent,
  PickupPoint,
  Product,
  ProductMedia,
  ProductVariant,
  PurchaseOrder,
  SellerOrder,
  SellerPromotion,
  Shipment,
  ShippingZone,
  StockItem,
  Store,
} from '../models/index.js';

const RESERVATION_MS = 15 * 60 * 1000;
function currencyFactor(currency) {
  return ['UGX', 'RWF'].includes(currency) ? 1 : 100;
}

function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function deliveryQuote({ countryCode, currency, city, method, subtotalMinor, pickupPointId, paymentMethod, forceFreeShipping = false }) {
  const setting = await CountrySetting.findOne({ code: countryCode, active: true }).lean();
  if (!setting) throw new AppError('Checkout is unavailable in this country.', 409, 'COUNTRY_UNAVAILABLE');
  if (setting.currency !== currency) throw new AppError('Cart currency does not match the selected country.', 409, 'CURRENCY_CONFLICT');
  if (!setting.payments?.[paymentMethod]) throw new AppError('That payment method is not enabled in this country.', 409, 'PAYMENT_METHOD_UNAVAILABLE');
  const deliveryEnabled = method === 'standard' ? setting.delivery?.standardEnabled !== false : method === 'express' ? setting.delivery?.expressEnabled !== false : setting.delivery?.pickupEnabled !== false;
  if (!deliveryEnabled) throw new AppError('That delivery method is disabled in this country.', 409, 'DELIVERY_METHOD_UNAVAILABLE');

  let shippingMinor = 0;
  let zone = null;
  let pickupPoint = null;
  let slaHours = 0;
  if (method === 'pickup') {
    if (!pickupPointId) throw new AppError('Choose a pickup point.', 422, 'PICKUP_POINT_REQUIRED');
    pickupPoint = await PickupPoint.findOne({ publicId: pickupPointId, country: countryCode, active: true }).lean();
    if (!pickupPoint) throw new AppError('The selected pickup point is unavailable.', 409, 'PICKUP_POINT_UNAVAILABLE');
  } else {
    const cityName = String(city || '').trim();
    if (!cityName) throw new AppError('Enter the delivery city before reviewing checkout.', 422, 'DELIVERY_CITY_REQUIRED');
    zone = await ShippingZone.findOne(mongoose.trusted({
      country: countryCode,
      active: true,
      cities: { $elemMatch: { $regex: `^${escapeRegex(cityName)}$`, $options: 'i' } },
    })).lean();
    if (!zone) throw new AppError('Delivery is not configured for that city yet.', 409, 'DELIVERY_AREA_UNAVAILABLE');
    if (zone.currency !== currency) throw new AppError('Delivery currency does not match the cart.', 409, 'DELIVERY_CURRENCY_CONFLICT');
    shippingMinor = method === 'express' ? Number(zone.expressFeeMinor || 0) : Number(zone.standardFeeMinor || 0);
    slaHours = method === 'express' ? Number(zone.expressSlaHours || 0) : Number(zone.standardSlaHours || 0);
    if (method === 'standard' && ((setting.freeStandardShippingThresholdMinor > 0 && subtotalMinor >= setting.freeStandardShippingThresholdMinor) || forceFreeShipping)) shippingMinor = 0;
  }
  const taxableMinor = Math.max(0, subtotalMinor + shippingMinor);
  const taxMinor = Math.floor(taxableMinor * Number(setting.taxBps || 0) / 10000);
  return {
    shippingMinor,
    taxMinor,
    zonePublicId: zone?.publicId || '',
    pickupPointPublicId: pickupPoint?.publicId || '',
    pickupPoint: pickupPoint ? { id: pickupPoint.publicId, name: pickupPoint.name, city: pickupPoint.city, address: pickupPoint.address, openingHours: pickupPoint.openingHours } : null,
    slaHours,
    policy: { returnWindowDays: setting.returnWindowDays ?? 30, policyVersion: setting.policyVersion || '2026-07', platformFeeBps: Number(setting.platformFeeBps || 0) },
  };
}

export async function checkoutOptions(request, city = '') {
  const setting = await CountrySetting.findOne({ code: request.country.code, active: true }).lean();
  if (!setting) throw new AppError('Checkout is unavailable in this country.', 409, 'COUNTRY_UNAVAILABLE');
  const pickupPoints = await PickupPoint.find({ country: request.country.code, active: true }).sort({ city: 1, name: 1 }).lean();
  const zones = await ShippingZone.find({ country: request.country.code, active: true }).sort({ name: 1 }).lean();
  const normalizedCity = String(city || '').trim().toLowerCase();
  return {
    country: request.country.code,
    currency: setting.currency,
    payments: setting.payments,
    freeStandardShippingThresholdMinor: setting.freeStandardShippingThresholdMinor,
    pickupPoints: pickupPoints.map(point => ({ id: point.publicId, name: point.name, city: point.city, address: point.address, openingHours: point.openingHours })),
    zones: zones.map(zone => ({ id: zone.publicId, name: zone.name, cities: zone.cities, standardFeeMinor: zone.standardFeeMinor, expressFeeMinor: zone.expressFeeMinor, standardSlaHours: zone.standardSlaHours, expressSlaHours: zone.expressSlaHours, matchesCity: normalizedCity ? zone.cities.some(value => value.toLowerCase() === normalizedCity) : false })),
  };
}

function sessionKey(request) {
  if (!request.session.cartKey) request.session.cartKey = crypto.randomUUID();
  return request.session.cartKey;
}

export async function getOrCreateCart(request) {
  const key = sessionKey(request);
  let cart = await Cart.findOne({ sessionKey: key });
  if (!cart) {
    cart = await Cart.create({
      publicId: publicId('crt'),
      sessionKey: key,
      userId: request.user?._id,
      country: request.country.code,
      items: [],
    });
  } else {
    let changed = false;
    if (request.user?._id) {
      const accountCart = await Cart.findOne(mongoose.trusted({ userId: request.user._id, country: request.country.code, sessionKey: { $ne: key } })).sort({ updatedAt: -1 });
      if (accountCart) {
        for (const source of accountCart.items) {
          const target = cart.items.find(item => item.variantId.equals(source.variantId));
          if (target) target.quantity = Math.min(99, target.quantity + source.quantity);
          else cart.items.push({ productId: source.productId, variantId: source.variantId, quantity: source.quantity });
        }
        cart.promotionCodes = [...new Set([...(cart.promotionCodes || []), ...(accountCart.promotionCodes || [])])].slice(0, 10);
        await Cart.deleteOne({ _id: accountCart._id });
        changed = true;
      }
      if (!cart.userId || !cart.userId.equals(request.user._id)) {
        cart.userId = request.user._id;
        changed = true;
      }
    }
    if (cart.country !== request.country.code) {
      cart.country = request.country.code;
      cart.items = [];
      cart.promotionCodes = [];
      changed = true;
    }
    if (changed) await cart.save();
  }
  return cart;
}

async function resolveSellable(productPublicId, variantPublicId, countryCode) {
  const product = await Product.findOne({
    publicId: productPublicId,
    status: 'published',
    countries: countryCode,
  }).lean();
  if (!product) throw new AppError('Product is unavailable.', 404, 'PRODUCT_UNAVAILABLE');

  const variant = variantPublicId
    ? await ProductVariant.findOne({ publicId: variantPublicId, productId: product._id, active: true }).lean()
    : await ProductVariant.findOne({ productId: product._id, active: true }).sort({ priceMinor: 1 }).lean();
  if (!variant) throw new AppError('No sellable variant is available.', 409, 'VARIANT_UNAVAILABLE');

  const stock = await StockItem.aggregate([
    { $match: { variantId: variant._id } },
    { $group: { _id: '$variantId', onHand: { $sum: '$onHand' }, reserved: { $sum: '$reserved' }, damaged: { $sum: '$damaged' }, quarantined: { $sum: '$quarantined' } } },
    { $project: { available: { $subtract: ['$onHand', { $add: ['$reserved', '$damaged', '$quarantined'] }] } } },
  ]);
  if (!stock[0] || stock[0].available <= 0) throw new AppError('This item is out of stock.', 409, 'OUT_OF_STOCK');
  return { product, variant, available: stock[0].available };
}

export async function addCartItem(request, { productId, variantId, quantity }) {
  const cart = await getOrCreateCart(request);
  const sellable = await resolveSellable(productId, variantId, request.country.code);
  const requested = Math.max(1, Math.min(99, Number(quantity) || 1));
  const existing = cart.items.find(item => item.variantId.equals(sellable.variant._id));
  const nextQuantity = Number(existing?.quantity || 0) + requested;
  if (nextQuantity > sellable.available) {
    throw new AppError(`Only ${sellable.available} item(s) are available for this option.`, 409, 'INSUFFICIENT_STOCK');
  }
  if (existing) existing.quantity = nextQuantity;
  else cart.items.push({ productId: sellable.product._id, variantId: sellable.variant._id, quantity: requested });
  await cart.save();
  return cartView(cart);
}

export async function setCartItemQuantity(request, variantPublicId, quantity) {
  const cart = await getOrCreateCart(request);
  const variant = await ProductVariant.findOne({ publicId: variantPublicId, active: true }).lean();
  if (!variant) throw new AppError('Cart item is unavailable.', 404, 'CART_ITEM_NOT_FOUND');
  const item = cart.items.find(entry => entry.variantId.equals(variant._id));
  if (!item) throw new AppError('Cart item was not found.', 404, 'CART_ITEM_NOT_FOUND');
  if (quantity <= 0) cart.items = cart.items.filter(entry => !entry.variantId.equals(variant._id));
  else {
    const stock = await StockItem.aggregate([
      { $match: { variantId: variant._id } },
      { $group: { _id: null, onHand: { $sum: '$onHand' }, reserved: { $sum: '$reserved' }, damaged: { $sum: '$damaged' }, quarantined: { $sum: '$quarantined' } } },
      { $project: { available: { $subtract: ['$onHand', { $add: ['$reserved', '$damaged', '$quarantined'] }] } } },
    ]);
    const available = stock[0]?.available || 0;
    if (quantity > available) throw new AppError(`Only ${available} item(s) are available.`, 409, 'INSUFFICIENT_STOCK');
    item.quantity = Math.min(quantity, 99);
  }
  await cart.save();
  return cartView(cart);
}

export async function removeCartItem(request, variantPublicId) {
  const cart = await getOrCreateCart(request);
  const variant = await ProductVariant.findOne({ publicId: variantPublicId }).lean();
  if (variant) cart.items = cart.items.filter(entry => !entry.variantId.equals(variant._id));
  await cart.save();
  return cartView(cart);
}


export async function applyCartPromotionCode(request, code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) throw new AppError('Enter a promotion code.', 422, 'PROMOTION_CODE_REQUIRED');
  const now = new Date();
  const promotion = await SellerPromotion.findOne({
    code: normalized, type: 'voucher', status: 'active', country: request.country.code,
    startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gt: now } }],
  }).lean();
  if (!promotion) throw new AppError('Seller promotion code not found.', 404, 'SELLER_PROMOTION_NOT_FOUND');
  const cart = await getOrCreateCart(request);
  if (!cart.promotionCodes.includes(normalized)) cart.promotionCodes.push(normalized);
  await cart.save();
  return cartView(cart);
}
export async function removeCartPromotionCode(request, code) {
  const normalized = String(code || '').trim().toUpperCase();
  const cart = await getOrCreateCart(request);
  cart.promotionCodes = (cart.promotionCodes || []).filter((value) => value !== normalized);
  await cart.save();
  return cartView(cart);
}

export async function clearCart(request) {
  const cart = await getOrCreateCart(request);
  cart.items = [];
  await cart.save();
  return cartView(cart);
}

export async function cartView(cart) {
  const cartItems = Array.from(cart.items || []);
  const variantIds = cartItems.map((item) => item.variantId);
  const productIds = cartItems.map((item) => item.productId);
  const [variants, products, media, stock] = await Promise.all([
    variantIds.length ? ProductVariant.find({ _id: mongoose.trusted({ $in: variantIds }), active: true }).lean() : [],
    productIds.length ? Product.find({ _id: mongoose.trusted({ $in: productIds }), status: 'published', countries: cart.country }).lean() : [],
    productIds.length ? ProductMedia.find({ productId: mongoose.trusted({ $in: productIds }), status: 'approved' }).sort({ productId: 1, position: 1, createdAt: 1 }).lean() : [],
    variantIds.length ? StockItem.aggregate([
      { $match: { variantId: { $in: variantIds } } },
      { $group: { _id: '$variantId', onHand: { $sum: '$onHand' }, reserved: { $sum: '$reserved' }, damaged: { $sum: '$damaged' }, quarantined: { $sum: '$quarantined' } } },
      { $project: { available: { $max: [0, { $subtract: ['$onHand', { $add: ['$reserved', '$damaged', '$quarantined'] }] }] } } },
    ]) : [],
  ]);
  const storeIds = [...new Set(variants.map((row) => String(row.storeId)))].map((id) => new mongoose.Types.ObjectId(id));
  const stores = storeIds.length ? await Store.find({ _id: mongoose.trusted({ $in: storeIds }), status: 'verified' }).lean() : [];
  const variantById = new Map(variants.map((row) => [String(row._id), row]));
  const productById = new Map(products.map((row) => [String(row._id), row]));
  const storeById = new Map(stores.map((row) => [String(row._id), row]));
  const mediaByProduct = new Map();
  for (const row of media) if (!mediaByProduct.has(String(row.productId))) mediaByProduct.set(String(row.productId), row);
  const stockByVariant = new Map(stock.map((row) => [String(row._id), Math.max(0, Number(row.available || 0))]));

  const rows = [];
  for (const item of cartItems) {
    const variant = variantById.get(String(item.variantId));
    const product = productById.get(String(item.productId));
    if (!variant || !product) continue;
    const store = storeById.get(String(variant.storeId));
    if (!store) continue;
    const productMedia = mediaByProduct.get(String(product._id));
    rows.push({
      productId: product.publicId,
      variantId: variant.publicId,
      storeId: store.publicId,
      name: product.title,
      variant: variant.title,
      sku: variant.sku,
      quantity: item.quantity,
      priceMinor: variant.priceMinor,
      minimumPriceMinor: Number(variant.minimumPriceMinor || 0),
      price: variant.priceMinor / currencyFactor(variant.currency),
      currency: variant.currency,
      available: stockByVariant.get(String(variant._id)) || 0,
      image: publicProductImageUrl(productMedia, true),
    });
  }
  const currencies = new Set(rows.map((row) => row.currency));
  if (currencies.size > 1) throw new AppError('Cart contains mixed currencies. Remove out-of-country items and try again.', 409, 'CART_CURRENCY_CONFLICT');
  const currency = rows[0]?.currency || (cart.country === 'UG' ? 'UGX' : 'USD');
  const subtotalMinor = rows.reduce((sum, item) => sum + item.priceMinor * item.quantity, 0);
  const promotions = await promotionQuote({ rows, country: cart.country, codes: cart.promotionCodes || [] });
  const discountMinor = Math.min(subtotalMinor, promotions.discountMinor);
  return {
    id: cart.publicId,
    items: rows,
    promotionCodes: [...(cart.promotionCodes || [])],
    promotions: promotions.applications,
    totals: { subtotalMinor, shippingMinor: 0, discountMinor, taxMinor: 0, totalMinor: Math.max(0, subtotalMinor - discountMinor), currency },
  };
}

export async function releaseExpiredReservations() {
  const expired = await InventoryReservation.find({ status: 'active', expiresAt: mongoose.trusted({ $lte: new Date() }) }).limit(200);
  for (const reservation of expired) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const current = await InventoryReservation.findOne({ _id: reservation._id, status: 'active' }).session(session);
        if (!current) return;
        await StockItem.updateOne(
          mongoose.trusted({ _id: current.stockItemId, reserved: mongoose.trusted({ $gte: current.quantity }) }),
          { $inc: { reserved: -current.quantity } },
          { session },
        );
        current.status = 'expired';
        current.releasedAt = new Date();
        await current.save({ session });
        const order = await Order.findOne({ status: 'pending_payment', reservationExpiresAt: mongoose.trusted({ $lte: new Date() }), 'items.reservationPublicId': current.publicId }).session(session);
        if (order) {
          order.status = 'expired';
          order.paymentState = 'failed';
          order.timeline.push({ type: 'reservation.expired', message: 'Payment was not verified before the stock reservation expired.' });
          await order.save({ session });
          await SellerOrder.updateMany({ orderId: order._id, status: 'pending_payment' }, { $set: { status: 'expired' }, $push: { timeline: { type: 'reservation.expired', message: 'Marketplace order expired before payment verification.' } } }, { session });
          if (order.businessInvoiceId) {
            await BusinessInvoice.updateOne(
              { _id: order.businessInvoiceId, status: 'awaiting_payment' },
              { $set: { status: 'void' }, $push: { timeline: { type: 'payment.expired', message: 'Invoice voided because the reserved stock expired before verified payment.' } } },
              { session },
            );
            const po = order.purchaseOrderId ? await PurchaseOrder.findOneAndUpdate(
              { _id: order.purchaseOrderId, status: 'payment_pending' },
              { $set: { status: 'expired' }, $push: { timeline: { type: 'payment.expired', message: 'Purchase order expired before verified Pesapal payment.' } } },
              { session, returnDocument: 'after' },
            ) : null;
            if (po?.procurementRequestId) {
              const { syncProcurementStatus } = await import('./business-fulfillment.js');
              await syncProcurementStatus(po.procurementRequestId, session);
            }
          }
        }
      });
    } finally {
      await session.endSession();
    }
  }
}

export async function reviewCheckout(request, input) {
  await releaseExpiredReservations();
  const cart = await getOrCreateCart(request);
  const view = await cartView(cart);
  if (!view.items.length) throw new AppError('Your cart is empty.', 409, 'CART_EMPTY');
  const currencies = new Set(view.items.map(item => item.currency));
  if (currencies.size !== 1) throw new AppError('Cart items must use one checkout currency.', 409, 'CURRENCY_CONFLICT');
  for (const item of view.items) if (item.quantity > item.available) throw new AppError(`${item.name} no longer has enough stock.`, 409, 'INSUFFICIENT_STOCK');

  const promo = await promotionQuote({ rows: view.items, country: request.country.code, codes: cart.promotionCodes || [] });
  const netSubtotalMinor = Math.max(0, view.totals.subtotalMinor - promo.discountMinor);
  const quote = await deliveryQuote({ countryCode: request.country.code, currency: view.totals.currency, city: input.city, method: input.deliveryMethod, subtotalMinor: netSubtotalMinor, pickupPointId: input.pickupPointId, paymentMethod: input.paymentMethod, forceFreeShipping: promo.freeShipping });
  const checkoutId = publicId('chk');
  const totals = { ...view.totals, discountMinor: promo.discountMinor, shippingMinor: quote.shippingMinor, taxMinor: quote.taxMinor, totalMinor: Math.max(0, view.totals.subtotalMinor - promo.discountMinor) + quote.shippingMinor + quote.taxMinor };
  view.promotions = promo.applications;
  const review = { checkoutId, cart: view, deliveryMethod: input.deliveryMethod, paymentMethod: input.paymentMethod, delivery: quote, totals };
  request.session.checkoutReview = {
    checkoutId,
    cartPublicId: cart.publicId,
    deliveryMethod: input.deliveryMethod,
    paymentMethod: input.paymentMethod,
    city: String(input.city || '').trim(),
    pickupPointId: input.pickupPointId || '',
    zonePublicId: quote.zonePublicId,
    totals,
    promotionCodes: [...(cart.promotionCodes || [])],
    promotionIds: promo.applications.map((row) => row.id),
    policy: quote.policy,
    expiresAt: Date.now() + 10 * 60 * 1000,
  };
  return review;
}

export async function placeOrder(request, input) {
  const key = sessionKey(request);
  const existing = await Order.findOne({ idempotencyKey: input.idempotencyKey, sessionKey: key }).lean();
  if (existing) return orderView(existing);

  await releaseExpiredReservations();
  const cart = await getOrCreateCart(request);
  const savedReview = request.session.checkoutReview;
  if (!savedReview || savedReview.checkoutId !== input.checkoutId || savedReview.cartPublicId !== cart.publicId || savedReview.deliveryMethod !== input.deliveryMethod || savedReview.paymentMethod !== input.paymentMethod || savedReview.city.toLowerCase() !== input.contact.city.trim().toLowerCase() || (savedReview.pickupPointId || '') !== (input.pickupPointId || '') || savedReview.expiresAt <= Date.now()) {
    throw new AppError('Checkout review expired or changed. Review the order again.', 409, 'CHECKOUT_REVIEW_REQUIRED');
  }
  const expiresAt = new Date(Date.now() + RESERVATION_MS);
  const session = await mongoose.startSession();
  try {
    let created;
    await session.withTransaction(async () => {
      const freshCart = await Cart.findById(cart._id).session(session);
      if (!freshCart?.items.length) throw new AppError('Your cart is empty.', 409, 'CART_EMPTY');
      const orderItems = [];
      for (const item of freshCart.items) {
        const variant = await ProductVariant.findById(item.variantId).session(session).lean();
        const product = await Product.findById(item.productId).session(session).lean();
        const store = variant ? await Store.findById(variant.storeId).session(session).lean() : null;
        if (!variant?.active || !product || product.status !== 'published' || !store) throw new AppError('A cart item is no longer available.', 409, 'CART_CHANGED');
        const stock = await StockItem.findOneAndUpdate(
          mongoose.trusted({ variantId: variant._id, storeId: variant.storeId, $expr: { $gte: [{ $subtract: ['$onHand', { $add: ['$reserved', '$damaged', '$quarantined'] }] }, item.quantity] } }),
          { $inc: { reserved: item.quantity } },
          { returnDocument: 'after', session },
        );
        if (!stock) throw new AppError(`${product.title} no longer has enough stock.`, 409, 'INSUFFICIENT_STOCK');
        const reservationPublicId = publicId('rsv');
        await InventoryReservation.create([{ publicId: reservationPublicId, idempotencyKey: `${input.idempotencyKey}:${variant.publicId}`, storeId: variant.storeId, stockItemId: stock._id, variantId: variant._id, quantity: item.quantity, status: 'active', expiresAt, actorUserId: request.user?._id || product.ownerUserId }], { session });
        orderItems.push({ linePublicId: publicId('oli'), productId: product._id, variantId: variant._id, storeId: store._id, reservationPublicId, productPublicId: product.publicId, variantPublicId: variant.publicId, storePublicId: store.publicId, title: product.title, variantTitle: variant.title, sku: variant.sku, quantity: item.quantity, unitPriceMinor: variant.priceMinor, unitCostMinor: Number(variant.costMinor || 0), costSnapshotStatus: 'captured', minimumPriceMinor: Number(variant.minimumPriceMinor || 0), lineTotalMinor: variant.priceMinor * item.quantity, currency: variant.currency });
      }
      const subtotalMinor = orderItems.reduce((sum, item) => sum + item.lineTotalMinor, 0);
      const promoRows = orderItems.map((item) => ({ productId: item.productPublicId, variantId: item.variantPublicId, storeId: item.storePublicId, priceMinor: item.unitPriceMinor, minimumPriceMinor: Number(item.minimumPriceMinor || 0), quantity: item.quantity }));
      const promo = await promotionQuote({ rows: promoRows, country: request.country.code, codes: freshCart.promotionCodes || [] });
      const netSubtotalMinor = Math.max(0, subtotalMinor - promo.discountMinor);
      const quote = await deliveryQuote({ countryCode: request.country.code, currency: orderItems[0].currency, city: input.contact.city, method: input.deliveryMethod, subtotalMinor: netSubtotalMinor, pickupPointId: input.pickupPointId, paymentMethod: input.paymentMethod, forceFreeShipping: promo.freeShipping });
      if (quote.shippingMinor !== savedReview.totals.shippingMinor || quote.taxMinor !== savedReview.totals.taxMinor || promo.discountMinor !== savedReview.totals.discountMinor || quote.zonePublicId !== savedReview.zonePublicId) throw new AppError('Delivery, discount or tax changed. Review checkout again.', 409, 'CHECKOUT_TOTAL_CHANGED');
      const totals = { subtotalMinor, shippingMinor: quote.shippingMinor, discountMinor: promo.discountMinor, taxMinor: quote.taxMinor, totalMinor: netSubtotalMinor + quote.shippingMinor + quote.taxMinor, currency: orderItems[0].currency };
      const [order] = await Order.create([{ publicId: publicId('ord'), ...currentTraceFields(), idempotencyKey: input.idempotencyKey, checkoutId: input.checkoutId, cartPublicId: freshCart.publicId, sessionKey: freshCart.sessionKey, userId: request.user?._id, country: request.country.code, status: 'pending_payment', paymentState: 'pending', fulfillmentState: 'unfulfilled', cancellationState: 'none', returnState: 'none', refundState: 'none', deliveryMethod: input.deliveryMethod, shippingZonePublicId: quote.zonePublicId, pickupPointPublicId: quote.pickupPointPublicId, paymentMethod: input.paymentMethod, contact: input.contact, totals, items: orderItems, policySnapshot: quote.policy, timeline: [{ type: 'order.created', message: 'Order created and stock reserved.' }, { type: 'payment.pending', message: 'Payment has not yet been verified.' }], reservationExpiresAt: expiresAt }], { session });

      const storeGroups = new Map();
      for (const item of orderItems) {
        const list = storeGroups.get(item.storePublicId) || [];
        list.push(item); storeGroups.set(item.storePublicId, list);
      }
      const sellerOrderPublicIds = [];
      let allocatedShipping = 0; let allocatedTax = 0; const groups = [...storeGroups.entries()];
      for (let index = 0; index < groups.length; index++) {
        const [storePublicId, items] = groups[index];
        const storeSubtotal = items.reduce((sum, item) => sum + item.lineTotalMinor, 0);
        const shippingPart = index === groups.length - 1 ? totals.shippingMinor - allocatedShipping : Math.floor(totals.shippingMinor * storeSubtotal / Math.max(1, totals.subtotalMinor));
        const taxPart = index === groups.length - 1 ? totals.taxMinor - allocatedTax : Math.floor(totals.taxMinor * storeSubtotal / Math.max(1, totals.subtotalMinor));
        allocatedShipping += shippingPart; allocatedTax += taxPart;
        const storeDiscount = Math.min(storeSubtotal, Number(promo.storeDiscounts?.[storePublicId] || 0));
        const storeNet = Math.max(0, storeSubtotal - storeDiscount);
        const platformFeeMinor = Math.floor(storeNet * Number(quote.policy.platformFeeBps || 0) / 10000);
        const sellerPublicId = publicId('sord'); sellerOrderPublicIds.push(sellerPublicId);
        const settlementItems = allocateSellerLineSettlement(items, { discountMinor: storeDiscount, platformFeeMinor });
        await SellerOrder.create([{ publicId: sellerPublicId, orderId: order._id, orderPublicId: order.publicId, storeId: items[0].storeId, storePublicId, country: order.country, status: 'pending_payment', subtotalMinor: storeSubtotal, platformFeeMinor, shippingMinor: shippingPart, taxMinor: taxPart, discountMinor: storeDiscount, currency: totals.currency, items: settlementItems.map(item => ({ orderLineId: item.linePublicId, productPublicId: item.productPublicId, variantPublicId: item.variantPublicId, title: item.title, variantTitle: item.variantTitle, sku: item.sku, quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, unitCostMinor: item.unitCostMinor, costSnapshotStatus: item.costSnapshotStatus, lineTotalMinor: item.lineTotalMinor, currency: item.currency, grossMinor: item.grossMinor, discountMinor: item.discountMinor, customerPaidMinor: item.customerPaidMinor, platformFeeMinor: item.platformFeeMinor, sellerReceivableMinor: item.sellerReceivableMinor })), timeline: [{ type: 'seller_order.created', message: 'Seller order created from marketplace checkout with immutable line settlement snapshots.' }] }], { session });
      }
      order.sellerOrderPublicIds = sellerOrderPublicIds;
      await order.save({ session });
      freshCart.items = [];
      freshCart.promotionCodes = [];
      await freshCart.save({ session });
      created = order.toObject();
    });
    delete request.session.checkoutReview;
    try { const { attributeOrder } = await import('./promoters.js'); await attributeOrder(request, created.publicId); } catch (error) { request.log?.warn?.({ error: error.message, orderId: created.publicId }, 'Promoter attribution deferred'); }
    return orderView(created);
  } finally { await session.endSession(); }
}

export function orderView(order) {
  return {
    id: order.publicId,
    status: order.status,
    displayStatus: orderDisplayStatus(order),
    paymentState: order.paymentState || 'unpaid',
    fulfillmentState: order.fulfillmentState || 'unfulfilled',
    cancellationState: order.cancellationState || 'none',
    returnState: order.returnState || 'none',
    refundState: order.refundState || 'none',
    createdAt: order.createdAt,
    isGuest: !order.userId,
    deliveryMethod: order.deliveryMethod,
    paymentMethod: order.paymentMethod,
    shippingZonePublicId: order.shippingZonePublicId || '',
    pickupPointPublicId: order.pickupPointPublicId || '',
    sellerOrderIds: order.sellerOrderPublicIds || [],
    policy: order.policySnapshot || {},
    totals: order.totals,
    items: order.items.map(item => ({ lineId: item.linePublicId, title: item.title, variant: item.variantTitle, sku: item.sku, quantity: item.quantity, deliveredQuantity: Number(item.deliveredQuantity || 0), returnReservedQuantity: Number(item.returnReservedQuantity || 0), returnedQuantity: Number(item.returnedQuantity || 0), refundedQuantity: Number(item.refundedQuantity || 0), lineTotalMinor: item.lineTotalMinor, currency: item.currency })),
    reservationExpiresAt: order.reservationExpiresAt,
    timeline: order.timeline,
  };
}

export async function getOrderForRequest(request, orderId) {
  const order = await Order.findOne(mongoose.trusted(orderAccessQuery(request, orderId))).lean();
  if (!order) throw new AppError('Order not found.', 404, 'ORDER_NOT_FOUND');
  return orderView(order);
}

export async function getOrderForTracking(request, orderId) {
  const order = await Order.findOne(mongoose.trusted(orderAccessQuery(request, orderId, { requiredLevel: 'read' }))).lean();
  if (!order) throw new AppError('Order access verification is required.', 401, 'ORDER_TRACKING_VERIFICATION_REQUIRED');
  const mutable = await Order.exists(mongoose.trusted(orderAccessQuery(request, orderId, { requiredLevel: 'mutate' })));
  return { ...orderView(order), canMutate: Boolean(mutable) };
}


async function restoreOrderInventoryForCancellation(order, request, session) {
  if (order.cancellation?.inventoryRestoredAt) return;
  for (const item of order.items) {
    const reservation = await InventoryReservation.findOne({ publicId: item.reservationPublicId }).session(session);
    if (!reservation) throw new AppError('Order inventory record is missing.', 409, 'ORDER_INVENTORY_MISSING');
    const actorUserId = request.user?._id || reservation.actorUserId;
    if (reservation.status === 'active') {
      const stock = await StockItem.findOneAndUpdate(
        mongoose.trusted({ _id: reservation.stockItemId, reserved: { $gte: reservation.quantity } }),
        { $inc: { reserved: -reservation.quantity } },
        { returnDocument: 'after', session },
      );
      if (!stock) throw new AppError('Reserved stock is inconsistent.', 409, 'STOCK_CONFLICT');
      reservation.status = 'released'; reservation.releasedAt = new Date(); await reservation.save({ session });
      await InventoryMovement.create([{ publicId: publicId('mov'), storeId: reservation.storeId, stockItemId: stock._id, variantId: reservation.variantId, warehouseId: stock.warehouseId, type: 'release', quantity: -reservation.quantity, onHandBefore: stock.onHand, onHandAfter: stock.onHand, reservedBefore: stock.reserved + reservation.quantity, reservedAfter: stock.reserved, damagedBefore: stock.damaged, damagedAfter: stock.damaged, quarantinedBefore: stock.quarantined, quarantinedAfter: stock.quarantined, reason: 'Order cancelled before stock commitment', reference: order.publicId, actorUserId }], { session });
    } else if (reservation.status === 'committed') {
      const stock = await StockItem.findOneAndUpdate({ _id: reservation.stockItemId }, { $inc: { onHand: reservation.quantity } }, { returnDocument: 'after', session });
      if (!stock) throw new AppError('Committed stock record is missing.', 409, 'STOCK_CONFLICT');
      await InventoryMovement.create([{ publicId: publicId('mov'), storeId: reservation.storeId, stockItemId: stock._id, variantId: reservation.variantId, warehouseId: stock.warehouseId, type: 'return', quantity: reservation.quantity, onHandBefore: stock.onHand - reservation.quantity, onHandAfter: stock.onHand, reservedBefore: stock.reserved, reservedAfter: stock.reserved, damagedBefore: stock.damaged, damagedAfter: stock.damaged, quarantinedBefore: stock.quarantined, quarantinedAfter: stock.quarantined, reason: 'Pre-fulfilment order cancellation restock', reference: order.publicId, actorUserId }], { session });
    }
  }
  order.cancellation = order.cancellation || {};
  order.cancellation.inventoryRestoredAt = new Date();
}

async function cancelUnfulfilledLogistics(order, actorUserId, session) {
  const shipment = await Shipment.findOne({ orderId: order._id, kind: 'outbound' }).session(session);
  if (!shipment) return;
  if (['picked_up','in_transit','delivered','return_to_sender','returned'].includes(shipment.status)) throw new AppError('This order has already entered carrier custody and can no longer be cancelled directly.', 409, 'ORDER_ALREADY_IN_TRANSIT');
  shipment.status = 'cancelled';
  shipment.timeline.push({ type: 'cancelled', message: 'Shipment cancelled before carrier pickup.', actorUserId });
  await shipment.save({ session });
  await Parcel.updateMany({ shipmentId: shipment._id, status: { $nin: ['delivered','returned'] } }, { $set: { status: 'cancelled' }, $push: { timeline: { type: 'cancelled', message: 'Parcel cancelled before carrier pickup.', actorUserId } } }, { session });
  await DeliveryOffer.updateMany({ shipmentId: shipment._id, status: 'offered' }, { $set: { status: 'cancelled', respondedAt: new Date() } }, { session });
}

export async function cancelOrder(request, orderId, reason = 'Customer requested cancellation') {
  let order = await Order.findOne(mongoose.trusted(orderAccessQuery(request, orderId, { requiredLevel: 'mutate' })));
  if (!order) throw new AppError('Order not found.', 404, 'ORDER_NOT_FOUND');
  if (order.cancellationState === 'cancelled' || order.status === 'expired' || order.refundState === 'complete') return orderView(order.toObject());
  if (order.cancellationState === 'processing' || ['pending','processing'].includes(order.refundState)) throw new AppError('This order already has an active refund or cancellation process.', 409, 'ORDER_CANCELLATION_STATE');
  const cleanReason = String(reason || '').trim().slice(0, 300) || 'Customer requested cancellation';
  const paidOnline = ['paid','partially_refunded'].includes(order.paymentState) && order.paymentMethod !== 'cod';

  // Freeze fulfilment and restore stock first. External refund submission happens only
  // after this transaction commits, so a provider success can never leave the order fulfilable.
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      order = await Order.findById(order._id).session(session);
      if (!order) throw new AppError('Order not found.', 404, 'ORDER_NOT_FOUND');
      if (order.cancellationState === 'cancelled' || order.status === 'expired' || order.refundState === 'complete') return;
      if (order.cancellationState === 'processing') return;
      await cancelUnfulfilledLogistics(order, request.user?._id || order.userId || null, session);
      await restoreOrderInventoryForCancellation(order, request, session);
      order.cancellation = order.cancellation || {};
      order.cancellation.requestedAt = order.cancellation.requestedAt || new Date();
      order.cancellation.reason = cleanReason;
      order.fulfillmentState = 'cancelled';
      order.cancellationState = paidOnline ? 'processing' : 'cancelled';
      if (paidOnline) order.refundState = 'pending';
      syncLegacyOrderStatus(order);
      order.timeline.push({
        type: paidOnline ? 'cancellation.refund_required' : 'order.cancelled',
        message: paidOnline ? 'Fulfilment frozen and inventory restored; verified provider refund is required.' : 'Order cancelled before carrier pickup.',
      });
      await order.save({ session });
      await SellerOrder.updateMany(
        { orderId: order._id, status: { $nin: ['fulfilled','refunded'] } },
        { $set: { status: paidOnline ? 'cancellation_pending' : 'cancelled' }, $push: { timeline: { type: paidOnline ? 'cancellation.refund_required' : 'order.cancelled', message: paidOnline ? 'Fulfilment frozen; provider refund pending.' : 'Marketplace order cancelled before carrier pickup.' } } },
        { session },
      );
      if (!paidOnline) await PaymentIntent.updateMany({ orderId: order._id, status: { $in: ['created','requires_action','pending','failed','pending_collection'] } }, { $set: { status: 'cancelled', activeKey: null } }, { session });
    });
  } finally { await session.endSession(); }

  if (paidOnline) {
    try {
      const { createRefund } = await import('./payments.js');
      const refund = await createRefund(request, { orderId: order.publicId, amountMinor: order.totals.totalMinor, reason: `Pre-fulfilment cancellation: ${cleanReason}`, idempotencyKey: `cancel:${order.publicId}` });
      await Order.updateOne(
        { _id: order._id, cancellationState: 'processing' },
        { $set: { 'cancellation.refundPublicId': refund.publicId }, $push: { timeline: { type: 'cancellation.refund_started', message: `Refund ${refund.publicId} was submitted/reconciled after fulfilment was frozen.` } } },
      );
    } catch (error) {
      await Order.updateOne(
        { _id: order._id, cancellationState: 'processing' },
        { $push: { timeline: { type: 'cancellation.refund_attention', message: `Refund requires finance reconciliation: ${String(error?.code || 'REFUND_SUBMISSION_FAILED').slice(0, 80)}.` } } },
      );
      request.log?.error?.({ error: error?.message, code: error?.code, orderId: order.publicId }, 'Cancellation refund requires finance reconciliation');
    }
  }
  return orderView((await Order.findById(order._id).lean()));
}

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { randomToken } from '../core/crypto.js';
import { AppError } from '../core/errors.js';
import { decryptSensitive } from '../core/sensitive.js';
import { Shipment } from '../models/index.js';
import {
  addCartItem,
  applyCartPromotionCode,
  removeCartPromotionCode,
  cancelOrder,
  clearCart,
  getOrCreateCart,
  cartView,
  checkoutOptions,
  getOrderForRequest,
  getOrderForTracking,
  placeOrder,
  removeCartItem,
  reviewCheckout,
  setCartItemQuantity,
} from '../services/checkout.js';

const router = Router();
const trackingLimit=rateLimit({windowMs:10*60_000,limit:30,standardHeaders:'draft-8',legacyHeaders:false});
const addSchema = z.object({
  productId: z.string().trim().min(3).max(80),
  variantId: z.string().trim().min(3).max(80).optional(),
  quantity: z.coerce.number().int().min(1).max(99).default(1),
});
const quantitySchema = z.object({ quantity: z.coerce.number().int().min(0).max(99) });
const deliveryLocationSchema = z.object({ city: z.string().trim().min(2).max(120) });
const reviewSchema = z.object({
  deliveryMethod: z.enum(['standard', 'express', 'pickup']),
  paymentMethod: z.enum(['card', 'mobile', 'cod']),
  city: z.string().trim().min(2).max(120),
  pickupPointId: z.string().trim().max(100).optional().default(''),
});
const orderSchema = reviewSchema.extend({
  checkoutId: z.string().trim().min(6).max(120),
  idempotencyKey: z.string().trim().min(12).max(120),
  contact: z.object({
    fullName: z.string().trim().min(2).max(120),
    email: z.string().trim().email().max(254),
    phone: z.string().trim().min(7).max(32),
    address: z.string().trim().min(4).max(240),
    city: z.string().trim().min(2).max(120),
    country: z.string().trim().min(2).max(80),
    note: z.string().trim().max(500).optional().default(''),
  }),
});

function ensureCsrf(request) {
  if (!request.session.csrfToken) request.session.csrfToken = randomToken();
  return request.session.csrfToken;
}

router.get('/api/v1/delivery-location', async (request, response) => {
  response.set('Cache-Control', 'private, no-store');
  response.json({
    city: String(request.session.deliveryCity || ''),
    country: { code: request.country.code, name: request.country.name },
    csrfToken: ensureCsrf(request),
  });
});
router.post('/api/v1/delivery-location', async (request, response, next) => {
  try {
    const { city } = deliveryLocationSchema.parse(request.body);
    const options = await checkoutOptions(request, city);
    if (!options.zones.some((zone) => zone.matchesCity)) {
      throw new AppError('Delivery is not configured for that city yet.', 409, 'DELIVERY_AREA_UNAVAILABLE');
    }
    request.session.deliveryCity = city;
    response.set('Cache-Control', 'private, no-store').json({
      city,
      country: { code: request.country.code, name: request.country.name },
      csrfToken: ensureCsrf(request),
    });
  } catch (error) { next(error); }
});

router.get('/api/v1/cart', async (request, response, next) => {
  try {
    const cart = await getOrCreateCart(request);
    response.set('Cache-Control', 'private, no-store');
    response.json({ cart: await cartView(cart), csrfToken: ensureCsrf(request) });
  } catch (error) { next(error); }
});

router.post('/api/v1/cart/items', async (request, response, next) => {
  try { response.json({ cart: await addCartItem(request, addSchema.parse(request.body)) }); } catch (error) { next(error); }
});
router.patch('/api/v1/cart/items/:variantId', async (request, response, next) => {
  try { response.json({ cart: await setCartItemQuantity(request, request.params.variantId, quantitySchema.parse(request.body).quantity) }); } catch (error) { next(error); }
});
router.delete('/api/v1/cart/items/:variantId', async (request, response, next) => {
  try { response.json({ cart: await removeCartItem(request, request.params.variantId) }); } catch (error) { next(error); }
});
router.delete('/api/v1/cart', async (request, response, next) => {
  try { response.json({ cart: await clearCart(request) }); } catch (error) { next(error); }
});
router.post('/api/v1/cart/promotions', async (request, response, next) => {
  try { const { code } = z.object({ code: z.string().trim().min(2).max(40) }).parse(request.body); response.json({ cart: await applyCartPromotionCode(request, code), kind: 'seller_promotion' }); } catch (error) { next(error); }
});
router.delete('/api/v1/cart/promotions/:code', async (request, response, next) => {
  try { response.json({ cart: await removeCartPromotionCode(request, request.params.code) }); } catch (error) { next(error); }
});
router.get('/api/v1/checkout/options', async (request, response, next) => {
  try { response.json(await checkoutOptions(request, String(request.query.city || ''))); } catch (error) { next(error); }
});
router.post('/api/v1/checkout/review', async (request, response, next) => {
  try { response.json(await reviewCheckout(request, reviewSchema.parse(request.body))); } catch (error) { next(error); }
});
router.post('/api/v1/orders', async (request, response, next) => {
  try { response.status(201).json({ order: await placeOrder(request, orderSchema.parse(request.body)) }); } catch (error) { next(error); }
});
router.get('/api/v1/orders/:orderId', trackingLimit, async (request, response, next) => {
  try { response.set('Cache-Control', 'private, no-store'); const order = await getOrderForTracking(request, request.params.orderId, request.query.identity); const shipment = await Shipment.findOne({ orderPublicId: order.id }).select('+deliveryCodeEncrypted').lean(); let deliveryCode = null; if (shipment?.deliveryCodeEncrypted && ['assigned','picked_up','in_transit','rescheduled'].includes(shipment.status)) { try { deliveryCode = decryptSensitive(shipment.deliveryCodeEncrypted); } catch {} } response.json({ order: { ...order, shipment: shipment ? { id: shipment.publicId, status: shipment.status, deliveryCode, cod: { required: shipment.cod?.required || false, reconciled: Boolean(shipment.cod?.reconciledAt) } } : null }, csrfToken: ensureCsrf(request) }); } catch (error) { next(error); }
});

router.get('/orders/:orderId/receipt', trackingLimit, async (request, response, next) => {
  try {
    const order = await getOrderForRequest(request, request.params.orderId);
    response.set('Cache-Control', 'private, no-store');
    response.render('receipt', { order });
  } catch (error) { next(error); }
});

router.post('/api/v1/orders/:orderId/cancel', trackingLimit, async (request, response, next) => {
  try {
    const input = z.object({ reason: z.string().trim().min(3).max(300).default('Customer requested cancellation') }).parse(request.body || {});
    response.set('Cache-Control', 'private, no-store');
    response.json({ order: await cancelOrder(request, request.params.orderId, input.reason) });
  } catch (error) { next(error); }
});

export default router;

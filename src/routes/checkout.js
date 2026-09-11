import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { randomToken } from '../core/crypto.js';
import { AppError } from '../core/errors.js';
import { decryptSensitive } from '../core/sensitive.js';
import { FinancialDocument, Order, SellerShipment, Shipment } from '../models/index.js';
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
import { ensureHistoricalReceipt } from '../services/financial-documents.js';
import { createGuestOrderChallenge, verifyGuestOrderChallenge } from '../services/guest-order-access.js';

const router = Router();
const trackingLimit=rateLimit({windowMs:10*60_000,limit:30,standardHeaders:'draft-8',legacyHeaders:false});
const trackingChallengeLimit=rateLimit({windowMs:10*60_000,limit:10,standardHeaders:'draft-8',legacyHeaders:false});
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
router.post('/api/v1/orders/:orderId/tracking-challenge', trackingChallengeLimit, async (request, response, next) => {
  try {
    const input = z.object({ identity: z.string().trim().min(3).max(254), purpose: z.enum(['read','mutate']).default('read') }).parse(request.body);
    const challenge = await createGuestOrderChallenge(request, request.params.orderId, input);
    response.set('Cache-Control', 'private, no-store').status(202).json({ challenge, csrfToken: ensureCsrf(request) });
  } catch (error) { next(error); }
});
router.post('/api/v1/orders/:orderId/tracking-verify', trackingChallengeLimit, async (request, response, next) => {
  try {
    const input = z.object({ code: z.string().trim().regex(/^\d{6}$/), purpose: z.enum(['read','mutate']).default('read') }).parse(request.body);
    const access = verifyGuestOrderChallenge(request, request.params.orderId, input);
    response.set('Cache-Control', 'private, no-store').json({ access, csrfToken: ensureCsrf(request) });
  } catch (error) { next(error); }
});
router.get('/api/v1/orders/:orderId', trackingLimit, async (request, response, next) => {
  try {
    response.set('Cache-Control', 'private, no-store');
    const order = await getOrderForTracking(request, request.params.orderId);
    let shipmentQuery = Shipment.findOne({ orderPublicId: order.id });
    if (order.canMutate) shipmentQuery = shipmentQuery.select('+deliveryCodeEncrypted');
    const [shipment, sellerShipments, documents] = await Promise.all([
      shipmentQuery.lean(),
      SellerShipment.find({ orderPublicId: order.id }).select('publicId sellerOrderPublicId storePublicId parcelPublicId status lineCount quantity handedOverAt deliveredAt createdAt').sort({ createdAt: 1 }).lean(),
      FinancialDocument.find({ orderPublicId: order.id }).select('publicId documentNumber type amountMinor currency issuedAt').sort({ issuedAt: 1 }).lean(),
    ]);
    let deliveryCode = null;
    if (order.canMutate && shipment?.deliveryCodeEncrypted && ['assigned','picked_up','in_transit','rescheduled'].includes(shipment.status)) { try { deliveryCode = decryptSensitive(shipment.deliveryCodeEncrypted); } catch {} }
    response.json({ order: { ...order, shipment: shipment ? { id: shipment.publicId, status: shipment.status, deliveryCode, cod: { required: shipment.cod?.required || false, reconciled: Boolean(shipment.cod?.reconciledAt) } } : null, sellerShipments: sellerShipments.map(row => ({ id: row.publicId, sellerOrderId: row.sellerOrderPublicId, storeId: row.storePublicId, parcelId: row.parcelPublicId, status: row.status, lineCount: row.lineCount, quantity: row.quantity, handedOverAt: row.handedOverAt || null, deliveredAt: row.deliveredAt || null })), documents: documents.map(row => ({ id: row.publicId, number: row.documentNumber, type: row.type, amountMinor: row.amountMinor, currency: row.currency, issuedAt: row.issuedAt, href: `/orders/${encodeURIComponent(order.id)}/documents/${encodeURIComponent(row.publicId)}` })) }, csrfToken: ensureCsrf(request) });
  } catch (error) { next(error); }
});

async function renderFinancialDocument(request, response, { orderId, documentId = '' }) {
  const orderView = await getOrderForRequest(request, orderId);
  const order = await Order.findOne({ publicId: orderView.id });
  if (!order) throw new AppError('Order not found.', 404, 'ORDER_NOT_FOUND');
  let document;
  if (documentId) document = await FinancialDocument.findOne({ publicId: documentId, orderId: order._id }).lean();
  else {
    document = await FinancialDocument.findOne({ orderId: order._id, type: { $in: ['payment_receipt', 'cod_receipt'] } }).sort({ issuedAt: 1 }).lean();
    if (!document) document = (await ensureHistoricalReceipt(order))?.toObject?.() || null;
  }
  if (!document) throw new AppError('This financial document has not been issued yet.', 409, 'FINANCIAL_DOCUMENT_NOT_ISSUED');
  const documents = await FinancialDocument.find({ orderId: order._id }).sort({ issuedAt: 1 }).lean();
  response.set('Cache-Control', 'private, no-store');
  response.render('financial-document', { document, documents });
}

router.get('/orders/:orderId/receipt', trackingLimit, async (request, response, next) => {
  try { await renderFinancialDocument(request, response, { orderId: request.params.orderId }); } catch (error) { next(error); }
});
router.get('/orders/:orderId/documents/:documentId', trackingLimit, async (request, response, next) => {
  try { await renderFinancialDocument(request, response, { orderId: request.params.orderId, documentId: request.params.documentId }); } catch (error) { next(error); }
});

router.post('/api/v1/orders/:orderId/cancel', trackingLimit, async (request, response, next) => {
  try {
    const input = z.object({ reason: z.string().trim().min(3).max(300).default('Customer requested cancellation') }).parse(request.body || {});
    response.set('Cache-Control', 'private, no-store');
    response.json({ order: await cancelOrder(request, request.params.orderId, input.reason) });
  } catch (error) { next(error); }
});

export default router;

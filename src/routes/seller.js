import mongoose from 'mongoose';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler, AppError } from '../core/errors.js';
import { publicId, slugify } from '../core/ids.js';
import { encryptSensitive } from '../core/sensitive.js';
import { normalizeEmail } from '../core/crypto.js';
import {
  Brand,
  Category,
  InventoryLot,
  InventoryMovement,
  Order,
  Parcel,
  SellerOrder,
  Shipment,
  Product,
  ProductMedia,
  ProductVariant,
  ProductQuestion,
  SellerContactRequest,
  SellerVerification,
  StockItem,
  StoreMember,
  User,
  VerificationDocument,
  Warehouse,
} from '../models/index.js';
import {
  requireAuth,
  requireOnboarding,
  requirePermission,
  requireVerified,
} from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { loadSellerStore, requireStoreCapability } from '../middleware/store.js';
import { setFlash } from '../middleware/view.js';
import { writeAudit } from '../services/audit.js';
import {
  calculateQualityScore,
  formatMinorUnits,
  inspectProductContent,
  parseCatalogueCsv,
  toMinorUnits,
} from '../services/catalogue.js';
import { getCountries } from '../services/country.js';
import { clearStorefrontCache } from '../services/storefront.js';
import { adjustStock, createInventoryLot, setInventoryLotStatus, setStockCondition } from '../services/inventory.js';
import {
  sanitizeAndStoreProductImage,
  sanitizeAndStoreVerificationDocument,
  uploadProductImage,
  uploadVerificationImage,
} from '../services/media.js';
import { addOutboxEvent } from '../services/outbox.js';
import { createApiClient, createWebhookEndpoint, developerPortalData, revokeApiClient, revokeWebhookEndpoint, rotateApiClient, rotateWebhookSecret, SELLER_API_SCOPES, WEBHOOK_EVENTS, queueWebhookEvent } from '../services/stage11.js';
import { createWarehouseTask, executeWarehouseTask } from '../services/logistics.js';
import {
  bulkImportSchema,
  brandRequestSchema,
  mediaMetadataSchema,
  productSchema,
  stockAdjustmentSchema,
  storeSchema,
  variantSchema,
  verificationAppealSchema,
  verificationSchema,
  warehouseSchema,
} from '../validation/catalogue.js';

const router = Router();
const uploadLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});
const workflowLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 80,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});
const importLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

router.use(
  '/seller',
  noStore,
  requireAuth,
  requireVerified,
  requireOnboarding,
  loadSellerStore,
);
router.use(['/seller/onboarding','/seller/store','/seller/staff'], requireStoreCapability('staff'));
router.use(['/seller/messages','/seller/questions'], requireStoreCapability('support'));
router.use('/seller/orders', requireStoreCapability('fulfilment'));
router.use(['/seller/products','/seller/brands'], requireStoreCapability('catalogue'));
router.use('/seller/developers', requireStoreCapability('staff'));
router.use(['/seller/inventory','/seller/warehouses'], requireStoreCapability('inventory'));

function upload(middleware) {
  return (request, response, next) => {
    middleware(request, response, (error) => {
      if (error) return next(error);
      try { verifyDeferredCsrf(request); } catch (csrfError) { return next(csrfError); }
      return next();
    });
  };
}

function canEditProduct(product) {
  return ['draft', 'changes_requested'].includes(product.status);
}

async function findOwnedProduct(request) {
  const product = await Product.findOne({
    publicId: request.params.publicId,
    storeId: request.store._id,
  });
  if (!product) {
    throw new AppError('Product not found.', 404, 'PRODUCT_NOT_FOUND');
  }
  return product;
}

async function renderWorkspace(request, response, view) {
  return response.render('catalog-workspace', {
    view,
    formatMoney: (amount, currency = request.store.currency) =>
      formatMinorUnits(amount, currency, request.user.locale),
    moneyInput: (amount, currency = request.store.currency) =>
      amount / (['UGX', 'RWF'].includes(currency) ? 1 : 100),
    firstOption: (options) => {
      const entries =
        options instanceof Map
          ? [...options.entries()]
          : Object.entries(options || {});
      return entries[0] || ['', ''];
    },
  });
}

async function assertAvailableCountries(codes) {
  const available = new Set((await getCountries()).map((item) => item.code));
  if (codes.some((code) => !available.has(code))) {
    throw new AppError(
      'One or more selling countries are unavailable.',
      422,
      'COUNTRY_UNAVAILABLE',
    );
  }
}

router.get('/seller', (_request, response) =>
  response.redirect('/seller/products'),
);

router.get(
  '/seller/messages',
  asyncHandler(async (request, response) => {
    const contacts = await SellerContactRequest.find({ storeId: request.store._id })
      .populate('customerUserId', 'name')
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .limit(100)
      .lean();
    return renderWorkspace(request, response, { section: 'messages', contacts });
  }),
);

router.post(
  '/seller/messages/:id/reply',
  asyncHandler(async (request, response) => {
    const body = String(request.body.message || '').trim();
    if (body.length < 2 || body.length > 2000) throw new AppError('Message must be between 2 and 2000 characters.', 422, 'MESSAGE_INVALID');
    const thread = await SellerContactRequest.findOne({ publicId: request.params.id, storeId: request.store._id, status: { $ne: 'resolved' } });
    if (!thread) throw new AppError('Conversation not found or already resolved.', 404, 'CONTACT_NOT_FOUND');
    thread.replies.push({ sender: 'seller', senderUserId: request.user._id, body, at: new Date() });
    thread.status = 'read';
    thread.lastMessageAt = new Date();
    await thread.save();
    await writeAudit(request, 'seller_contact.seller_reply', { targetType: 'seller_contact', targetPublicId: thread.publicId });
    setFlash(request, 'success', 'Reply sent to the customer.');
    response.redirect('/seller/messages');
  }),
);

router.post(
  '/seller/messages/:id/resolve',
  asyncHandler(async (request, response) => {
    const thread = await SellerContactRequest.findOne({ publicId: request.params.id, storeId: request.store._id });
    if (!thread) throw new AppError('Conversation not found.', 404, 'CONTACT_NOT_FOUND');
    thread.status = 'resolved';
    thread.resolvedAt = new Date();
    thread.lastMessageAt = new Date();
    await thread.save();
    await writeAudit(request, 'seller_contact.resolved', { targetType: 'seller_contact', targetPublicId: thread.publicId });
    setFlash(request, 'success', 'Conversation marked resolved.');
    response.redirect('/seller/messages');
  }),
);

router.get(
  '/seller/questions',
  asyncHandler(async (request, response) => {
    const questions = await ProductQuestion.find({ storeId: request.store._id })
      .sort({ status: 1, createdAt: -1 })
      .limit(100)
      .lean();
    return renderWorkspace(request, response, { section: 'questions', questions });
  }),
);

router.post(
  '/seller/questions/:id/answer',
  asyncHandler(async (request, response) => {
    const answer = String(request.body.answer || '').trim();
    if (answer.length < 2 || answer.length > 2000) throw new AppError('Answer must be between 2 and 2000 characters.', 422, 'ANSWER_INVALID');
    const question = await ProductQuestion.findOne({ publicId: request.params.id, storeId: request.store._id, status: 'open' });
    if (!question) throw new AppError('Open question not found.', 404, 'QUESTION_NOT_FOUND');
    question.answer = { body: answer, sellerUserId: request.user._id, answeredAt: new Date() };
    question.status = 'answered';
    await question.save();
    await writeAudit(request, 'product_question.answered', { targetType: 'product_question', targetPublicId: question.publicId, metadata: { productPublicId: question.productPublicId } });
    setFlash(request, 'success', 'Answer published to the product page.');
    response.redirect('/seller/questions');
  }),
);

router.get(
  '/seller/onboarding',
  asyncHandler(async (request, response) => {
    const verification = await SellerVerification.findOneAndUpdate(
      { storeId: request.store._id },
      {
        $setOnInsert: {
          publicId: publicId('kyc'),
          userId: request.user._id,
          sellerType: 'individual',
          legalName: request.user.name,
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );
    const documents = await VerificationDocument.find({
      verificationId: verification._id,
    })
      .sort({ createdAt: -1 })
      .lean();
    return renderWorkspace(request, response, {
      section: 'verification',
      verification,
      documents,
    });
  }),
);

router.post(
  '/seller/store',
  asyncHandler(async (request, response) => {
    const input = storeSchema.parse(request.body);
    request.store.name = input.name;
    request.store.description = input.description;
    await request.store.save();
    await writeAudit(request, 'seller.store_updated', {
      targetType: 'store',
      targetPublicId: request.store.publicId,
    });
    setFlash(request, 'success', 'Store details saved.');
    return response.redirect('/seller/onboarding');
  }),
);

router.post(
  '/seller/onboarding/document',
  uploadLimiter,
  upload(uploadVerificationImage),
  asyncHandler(async (request, response) => {
    const documentType = String(request.body.documentType || '');
    if (!['identity', 'registration', 'tax', 'address'].includes(documentType)) {
      throw new AppError(
        'Choose a valid document type.',
        422,
        'DOCUMENT_TYPE_INVALID',
      );
    }
    const verification = await SellerVerification.findOne({
      storeId: request.store._id,
    });
    if (!verification || !['draft', 'rejected'].includes(verification.status)) {
      throw new AppError(
        'Documents cannot be changed during review.',
        409,
        'VERIFICATION_LOCKED',
      );
    }
    const document = await sanitizeAndStoreVerificationDocument({
      file: request.file,
      verification,
      store: request.store,
      user: request.user,
      documentType,
    });
    verification.documents = [
      ...verification.documents.filter((item) => item.type !== documentType),
      { type: documentType, mediaPublicId: document.publicId },
    ];
    verification.status = 'draft';
    await verification.save();
    await writeAudit(request, 'seller.verification_document_uploaded', {
      targetType: 'seller_verification',
      targetPublicId: verification.publicId,
      metadata: { documentType },
    });
    return response.status(201).json({
      document: {
        publicId: document.publicId,
        documentType: document.documentType,
        status: document.status,
      },
    });
  }),
);

router.post(
  '/seller/onboarding',
  workflowLimiter,
  asyncHandler(async (request, response) => {
    const input = verificationSchema.parse(request.body);
    const verification = await SellerVerification.findOne({
      storeId: request.store._id,
    });
    if (!verification || !['draft', 'rejected'].includes(verification.status)) {
      throw new AppError(
        'This verification is already under review.',
        409,
        'VERIFICATION_LOCKED',
      );
    }
    const requiredTypes =
      input.sellerType === 'business'
        ? ['identity', 'registration']
        : ['identity'];
    const uploadedTypes = new Set(
      (
        await VerificationDocument.find({
          verificationId: verification._id,
          status: 'ready',
        })
          .select('documentType')
          .lean()
      ).map((item) => item.documentType),
    );
    const missing = requiredTypes.filter((type) => !uploadedTypes.has(type));
    if (missing.length) {
      throw new AppError(
        `Upload the required ${missing.join(' and ')} document before submitting.`,
        422,
        'DOCUMENT_REQUIRED',
      );
    }
    verification.sellerType = input.sellerType;
    verification.legalName = input.legalName;
    verification.registrationNumber = encryptSensitive(input.registrationNumber);
    verification.taxNumber = encryptSensitive(input.taxNumber);
    verification.status = 'submitted';
    verification.declarationAcceptedAt = new Date();
    verification.submittedAt = new Date();
    verification.reviewReason = '';
    await verification.save();
    await addOutboxEvent({
      type: 'seller.verification_submitted',
      aggregateType: 'seller_verification',
      aggregatePublicId: verification.publicId,
      payload: { storePublicId: request.store.publicId },
    });
    await writeAudit(request, 'seller.verification_submitted', {
      targetType: 'seller_verification',
      targetPublicId: verification.publicId,
    });
    setFlash(request, 'success', 'Verification submitted for review.');
    return response.redirect('/seller/onboarding');
  }),
);

router.post(
  '/seller/onboarding/appeal',
  asyncHandler(async (request, response) => {
    const input = verificationAppealSchema.parse(request.body);
    const verification = await SellerVerification.findOne({
      storeId: request.store._id,
      status: 'rejected',
    });
    if (!verification) {
      throw new AppError(
        'A rejected verification was not found.',
        404,
        'VERIFICATION_NOT_FOUND',
      );
    }
    verification.status = 'appealed';
    verification.appeal = { message: input.message, submittedAt: new Date() };
    await verification.save();
    await writeAudit(request, 'seller.verification_appealed', {
      targetType: 'seller_verification',
      targetPublicId: verification.publicId,
    });
    setFlash(request, 'success', 'Your appeal was submitted.');
    return response.redirect('/seller/onboarding');
  }),
);



router.get('/seller/staff', asyncHandler(async (request, response) => {
  const members = await StoreMember.find({ storeId: request.store._id }).populate('userId','name email role status').sort({ createdAt: 1 }).lean();
  return renderWorkspace(request, response, { section: 'staff', members });
}));

router.post('/seller/staff', workflowLimiter, asyncHandler(async (request, response) => {
  const emailNormalized = normalizeEmail(String(request.body.email || ''));
  const role = String(request.body.role || '');
  if (!['admin','catalogue','fulfilment','finance','support'].includes(role)) throw new AppError('Choose a valid store staff role.', 422, 'STORE_ROLE_INVALID');
  const user = await User.findOne({ emailNormalized, status: 'active', emailVerifiedAt: { $ne: null } });
  if (!user) throw new AppError('That verified Classic Mart account was not found. Ask the person to create and verify an account first.', 404, 'STAFF_USER_NOT_FOUND');
  if (user._id.equals(request.store.ownerUserId)) throw new AppError('The store owner already has full access.', 409, 'STAFF_ALREADY_OWNER');
  if (await Store.exists({ ownerUserId: user._id })) throw new AppError('A seller-store owner cannot be added as staff to another store in this release.', 409, 'STAFF_OWNS_STORE');
  const member = await StoreMember.findOneAndUpdate(
    { storeId: request.store._id, userId: user._id },
    { $set: { role, status: 'invited', invitedByUserId: request.user._id, invitedAt: new Date(), acceptedAt: null, revokedAt: null }, $setOnInsert: { publicId: publicId('stm') } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
  await writeAudit(request, 'seller.staff_invited', { targetType: 'store_member', targetPublicId: member.publicId, metadata: { role } });
  setFlash(request, 'success', 'Staff invitation created. The user can accept it from their dashboard.');
  response.redirect('/seller/staff');
}));

router.post('/seller/staff/:publicId/revoke', workflowLimiter, asyncHandler(async (request, response) => {
  const member = await StoreMember.findOne({ publicId: request.params.publicId, storeId: request.store._id, role: { $ne: 'owner' } });
  if (!member) throw new AppError('Store staff member not found.', 404, 'STORE_MEMBER_NOT_FOUND');
  member.status = 'revoked'; member.revokedAt = new Date(); await member.save();
  await writeAudit(request, 'seller.staff_revoked', { targetType: 'store_member', targetPublicId: member.publicId });
  setFlash(request, 'success', 'Store access revoked.'); response.redirect('/seller/staff');
}));

async function sellerOrderContext(request, publicOrderId = null) {
  const query = { storeId: request.store._id };
  if (publicOrderId) query.publicId = publicOrderId;
  const orders = await SellerOrder.find(query).sort({ createdAt: -1 }).limit(publicOrderId ? 1 : 100).lean();
  const orderPublicIds = orders.map((order) => order.orderPublicId);
  const shipmentRows = orderPublicIds.length ? await Shipment.find({ orderPublicId: { $in: orderPublicIds }, kind: 'outbound' }).select('publicId orderPublicId status').lean() : [];
  const shipmentIds = shipmentRows.map((row) => row._id);
  const parcels = shipmentIds.length ? await Parcel.find({ shipmentId: { $in: shipmentIds }, storePublicId: request.store.publicId }).lean() : [];
  const shipmentByOrder = new Map(shipmentRows.map((row) => [row.orderPublicId, row]));
  const parcelByOrder = new Map();
  for (const parcel of parcels) parcelByOrder.set(parcel.orderPublicId, parcel);
  return orders.map((order) => ({ ...order, shipment: shipmentByOrder.get(order.orderPublicId) || null, parcel: parcelByOrder.get(order.orderPublicId) || null }));
}

router.get(
  '/seller/orders',
  asyncHandler(async (request, response) => {
    const sellerOrders = await sellerOrderContext(request);
    return renderWorkspace(request, response, { section: 'orders', orders: sellerOrders });
  }),
);

router.post(
  '/seller/orders/:publicId/processing',
  workflowLimiter,
  asyncHandler(async (request, response) => {
    const order = await SellerOrder.findOne({ publicId: request.params.publicId, storeId: request.store._id });
    if (!order) throw new AppError('Seller order not found.', 404, 'SELLER_ORDER_NOT_FOUND');
    if (order.status !== 'confirmed') throw new AppError('Only confirmed seller orders can enter processing.', 409, 'SELLER_ORDER_STATE');
    order.status = 'processing';
    order.timeline.push({ type: 'fulfilment.processing', message: 'Seller started fulfilment.' });
    await order.save();
    await writeAudit(request, 'seller.order_processing', { targetType: 'seller_order', targetPublicId: order.publicId });
    setFlash(request, 'success', 'Order moved to processing.');
    response.redirect('/seller/orders');
  }),
);

router.post(
  '/seller/orders/:publicId/parcel/:action',
  workflowLimiter,
  asyncHandler(async (request, response) => {
    const action = String(request.params.action || '');
    if (!['pick', 'pack', 'dispatch'].includes(action)) throw new AppError('Fulfilment action is invalid.', 422, 'FULFILMENT_ACTION_INVALID');
    const order = await SellerOrder.findOne({ publicId: request.params.publicId, storeId: request.store._id });
    if (!order) throw new AppError('Seller order not found.', 404, 'SELLER_ORDER_NOT_FOUND');
    if (!['confirmed', 'processing', 'ready'].includes(order.status)) throw new AppError('Seller order cannot be fulfilled in its current state.', 409, 'SELLER_ORDER_STATE');
    const shipment = await Shipment.findOne({ orderPublicId: order.orderPublicId, kind: 'outbound' });
    if (!shipment) throw new AppError('Shipment has not been created for this order.', 409, 'SHIPMENT_NOT_READY');
    const parcel = await Parcel.findOne({ shipmentId: shipment._id, storePublicId: request.store.publicId });
    if (!parcel) throw new AppError('Seller parcel was not found.', 404, 'PARCEL_NOT_FOUND');
    const warehouse = await Warehouse.findOne({ storeId: request.store._id, active: true }).sort({ createdAt: 1 });
    if (!warehouse) throw new AppError('Create an active warehouse before fulfilling orders.', 409, 'WAREHOUSE_REQUIRED');
    const task = await createWarehouseTask({ warehouseId: warehouse._id, storeId: request.store._id, orderId: order.orderId, shipmentId: shipment._id, parcelId: parcel._id, type: action, reference: order.publicId, notes: `Seller fulfilment ${action}`, assignedUserId: request.user._id, quantity: 0 });
    await executeWarehouseTask({ task, actorUserId: request.user._id });
    const freshParcel = await Parcel.findById(parcel._id).lean();
    if (freshParcel.status === 'handed_over') {
      order.status = 'ready';
      order.timeline.push({ type: 'fulfilment.ready', message: 'Seller parcel packed and dispatched for carrier handoff.' });
    } else if (order.status === 'confirmed') {
      order.status = 'processing';
      order.timeline.push({ type: 'fulfilment.processing', message: 'Seller started warehouse fulfilment.' });
    }
    await order.save();
    await writeAudit(request, `seller.order_${action}`, { targetType: 'seller_order', targetPublicId: order.publicId, metadata: { parcelPublicId: freshParcel.publicId, parcelStatus: freshParcel.status } });
    setFlash(request, 'success', `Parcel ${action} completed.`);
    response.redirect('/seller/orders');
  }),
);


router.get('/seller/developers', asyncHandler(async (request,response)=>{
  const data=await developerPortalData(request.user,request.store);
  response.render('developer-portal',{...data,revealedSecret:null,revealedKey:null});
}));
router.post('/seller/developers/clients', asyncHandler(async(request,response)=>{
  const scopes=Array.isArray(request.body.scopes)?request.body.scopes:[request.body.scopes].filter(Boolean);
  const {client,apiKey}=await createApiClient({user:request.user,store:request.store,name:request.body.name,scopes,requestsPerMinute:Number(request.body.requestsPerMinute||120),expiresAt:request.body.expiresAt||null});
  await writeAudit(request,'integration.api_client_created',{targetType:'api_client',targetPublicId:client.publicId,metadata:{scopes:client.scopes}});
  const data=await developerPortalData(request.user,request.store);return response.render('developer-portal',{...data,revealedKey:apiKey,revealedSecret:null});
}));
router.post('/seller/developers/clients/:id/rotate', asyncHandler(async(request,response)=>{const {client,apiKey}=await rotateApiClient({user:request.user,store:request.store,publicId:request.params.id});await writeAudit(request,'integration.api_client_rotated',{targetType:'api_client',targetPublicId:client.publicId});const data=await developerPortalData(request.user,request.store);response.render('developer-portal',{...data,revealedKey:apiKey,revealedSecret:null});}));
router.post('/seller/developers/clients/:id/revoke', asyncHandler(async(request,response)=>{const client=await revokeApiClient({user:request.user,store:request.store,publicId:request.params.id});await writeAudit(request,'integration.api_client_revoked',{targetType:'api_client',targetPublicId:client.publicId});setFlash(request,'success','API client revoked.');response.redirect('/seller/developers');}));
router.post('/seller/developers/webhooks', asyncHandler(async(request,response)=>{const events=Array.isArray(request.body.events)?request.body.events:[request.body.events].filter(Boolean);const {endpoint,secret}=await createWebhookEndpoint({user:request.user,store:request.store,url:request.body.url,events});await writeAudit(request,'integration.webhook_created',{targetType:'webhook',targetPublicId:endpoint.publicId,metadata:{events:endpoint.events}});const data=await developerPortalData(request.user,request.store);response.render('developer-portal',{...data,revealedKey:null,revealedSecret:secret});}));
router.post('/seller/developers/webhooks/:id/rotate', asyncHandler(async(request,response)=>{const {endpoint,secret}=await rotateWebhookSecret({user:request.user,store:request.store,publicId:request.params.id});await writeAudit(request,'integration.webhook_rotated',{targetType:'webhook',targetPublicId:endpoint.publicId});const data=await developerPortalData(request.user,request.store);response.render('developer-portal',{...data,revealedKey:null,revealedSecret:secret});}));
router.post('/seller/developers/webhooks/:id/revoke', asyncHandler(async(request,response)=>{const endpoint=await revokeWebhookEndpoint({user:request.user,store:request.store,publicId:request.params.id});await writeAudit(request,'integration.webhook_revoked',{targetType:'webhook',targetPublicId:endpoint.publicId});setFlash(request,'success','Webhook endpoint revoked.');response.redirect('/seller/developers');}));
router.post('/seller/developers/webhooks/:id/test', asyncHandler(async(request,response)=>{const endpoint=(await developerPortalData(request.user,request.store)).webhooks.find(x=>x.publicId===request.params.id&&x.status==='active');if(!endpoint)throw new AppError('Webhook endpoint not found.',404,'WEBHOOK_NOT_FOUND');await queueWebhookEvent({storeId:request.store._id,eventType:'integration.test',resourcePublicId:endpoint.publicId,payload:{message:'Classic Mart webhook test'}});await writeAudit(request,'integration.webhook_test_queued',{targetType:'webhook',targetPublicId:endpoint.publicId});setFlash(request,'success','Webhook test queued for delivery.');response.redirect('/seller/developers');}));

router.get(
  '/seller/products',
  asyncHandler(async (request, response) => {
    const allowedStatuses = new Set([
      'draft',
      'submitted',
      'changes_requested',
      'approved',
      'published',
      'rejected',
      'suspended',
      'archived',
    ]);
    const status = allowedStatuses.has(request.query.status)
      ? request.query.status
      : '';
    const query = { storeId: request.store._id };
    if (status) query.status = status;
    const products = await Product.find(query)
      .populate('categoryId', 'name')
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean();
    const counts = await Product.aggregate([
      { $match: { storeId: request.store._id } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    return renderWorkspace(request, response, {
      section: 'products',
      products,
      counts: Object.fromEntries(counts.map((item) => [item._id, item.count])),
      status,
    });
  }),
);

async function editorReferenceData(request) {
  const [categories, brands, countries] = await Promise.all([
    Category.find({
      active: true,
      $or: [
        { countries: { $size: 0 } },
        { countries: request.store.country },
      ],
    })
      .sort({ name: 1 })
      .lean(),
    Brand.find({ status: 'approved' }).sort({ name: 1 }).lean(),
    getCountries(),
  ]);
  return { categories, brands, countries };
}

router.get(
  '/seller/products/new',
  asyncHandler(async (request, response) => {
    const reference = await editorReferenceData(request);
    return renderWorkspace(request, response, {
      section: 'product-new',
      ...reference,
    });
  }),
);

router.post(
  '/seller/brands',
  workflowLimiter,
  asyncHandler(async (request, response) => {
    const input = brandRequestSchema.parse(request.body);
    const slug = slugify(input.name);
    const existing = await Brand.findOne({ slug });
    if (existing) {
      setFlash(
        request,
        existing.status === 'approved' ? 'success' : 'error',
        existing.status === 'approved'
          ? 'That brand is already available.'
          : 'That brand request is already awaiting a decision.',
      );
      return response.redirect('/seller/products/new');
    }
    const brand = await Brand.create({
      publicId: publicId('brd'),
      name: input.name,
      slug,
      status: 'pending',
      requestedByStoreId: request.store._id,
    });
    await writeAudit(request, 'catalogue.brand_requested', {
      targetType: 'brand',
      targetPublicId: brand.publicId,
    });
    setFlash(request, 'success', 'Brand submitted for catalogue review.');
    return response.redirect('/seller/products/new');
  }),
);

router.post(
  '/seller/products',
  asyncHandler(async (request, response) => {
    const input = productSchema.parse(request.body);
    await assertAvailableCountries(input.countries);
    inspectProductContent(input);
    const category = await Category.findOne({
      publicId: input.categoryPublicId,
      active: true,
      $or: [
        { countries: { $size: 0 } },
        { countries: request.store.country },
      ],
    });
    if (!category) {
      throw new AppError('Category is unavailable.', 422, 'CATEGORY_UNAVAILABLE');
    }
    const brand = input.brandPublicId
      ? await Brand.findOne({
          publicId: input.brandPublicId,
          status: 'approved',
        })
      : null;
    if (input.brandPublicId && !brand) {
      throw new AppError('Brand is unavailable.', 422, 'BRAND_UNAVAILABLE');
    }
    const baseSlug = slugify(input.title);
    let slug = baseSlug;
    let suffix = 1;
    while (await Product.exists({ storeId: request.store._id, slug })) {
      suffix += 1;
      slug = `${baseSlug.slice(0, 110)}-${suffix}`;
    }
    const product = await Product.create({
      publicId: publicId('prd'),
      storeId: request.store._id,
      ownerUserId: request.store.ownerUserId,
      categoryId: category._id,
      brandId: brand?._id,
      title: input.title,
      slug,
      description: input.description,
      countries: input.countries,
      tags: input.tags,
      qualityScore: calculateQualityScore({
        ...input,
        hasBrand: Boolean(brand),
      }),
    });
    await writeAudit(request, 'catalogue.product_created', {
      targetType: 'product',
      targetPublicId: product.publicId,
    });
    setFlash(request, 'success', 'Product draft created. Add a variant and image.');
    return response.redirect(`/seller/products/${product.publicId}`);
  }),
);

router.get(
  '/seller/products/:publicId',
  asyncHandler(async (request, response, next) => {
    if (['import', 'export.csv'].includes(request.params.publicId)) {
      return next('route');
    }
    const product = await findOwnedProduct(request);
    const [variants, media, reference] = await Promise.all([
      ProductVariant.find({ productId: product._id })
        .sort({ createdAt: 1 })
        .lean(),
      ProductMedia.find({
        productId: product._id,
        status: { $ne: 'rejected' },
      })
        .sort({ position: 1, createdAt: 1 })
        .lean(),
      editorReferenceData(request),
    ]);
    return renderWorkspace(request, response, {
      section: 'product-edit',
      product,
      variants,
      media,
      ...reference,
    });
  }),
);

router.post(
  '/seller/products/:publicId',
  asyncHandler(async (request, response, next) => {
    if (request.params.publicId === 'import') return next('route');
    const product = await findOwnedProduct(request);
    if (!canEditProduct(product)) {
      throw new AppError(
        'Only draft products or requested changes can be edited.',
        409,
        'PRODUCT_LOCKED',
      );
    }
    const input = productSchema.parse(request.body);
    await assertAvailableCountries(input.countries);
    inspectProductContent(input);
    const [category, brand] = await Promise.all([
      Category.findOne({
        publicId: input.categoryPublicId,
        active: true,
        $or: [
          { countries: { $size: 0 } },
          { countries: request.store.country },
        ],
      }),
      input.brandPublicId
        ? Brand.findOne({
            publicId: input.brandPublicId,
            status: 'approved',
          })
        : null,
    ]);
    if (!category) {
      throw new AppError('Category is unavailable.', 422, 'CATEGORY_UNAVAILABLE');
    }
    if (input.brandPublicId && !brand) {
      throw new AppError('Brand is unavailable.', 422, 'BRAND_UNAVAILABLE');
    }
    Object.assign(product, {
      title: input.title,
      description: input.description,
      categoryId: category._id,
      brandId: brand?._id,
      countries: input.countries,
      tags: input.tags,
      status: 'draft',
    });
    const [variantCount, mediaCount] = await Promise.all([
      ProductVariant.countDocuments({ productId: product._id, active: true }),
      ProductMedia.countDocuments({ productId: product._id, status: 'ready' }),
    ]);
    product.qualityScore = calculateQualityScore({
      ...input,
      variantCount,
      mediaCount,
      hasBrand: Boolean(brand),
    });
    await product.save();
    await writeAudit(request, 'catalogue.product_updated', {
      targetType: 'product',
      targetPublicId: product.publicId,
    });
    setFlash(request, 'success', 'Product details saved.');
    return response.redirect(`/seller/products/${product.publicId}`);
  }),
);

router.post(
  '/seller/products/:publicId/variants',
  asyncHandler(async (request, response) => {
    const product = await findOwnedProduct(request);
    if (!canEditProduct(product)) {
      throw new AppError('Product is locked during review.', 409, 'PRODUCT_LOCKED');
    }
    const input = variantSchema.parse(request.body);
    const options =
      input.optionName && input.optionValue
        ? { [input.optionName]: input.optionValue }
        : {};
    const variant = await ProductVariant.create({
      publicId: publicId('var'),
      productId: product._id,
      storeId: request.store._id,
      sku: input.sku,
      barcode: input.barcode || '',
      title: input.title,
      options,
      priceMinor: toMinorUnits(input.price, request.store.currency),
      compareAtMinor: input.compareAt
        ? toMinorUnits(input.compareAt, request.store.currency)
        : undefined,
      currency: request.store.currency,
      active: input.active === 'yes',
      weightGrams: input.weightGrams,
    });
    product.qualityScore = calculateQualityScore({
      title: product.title,
      description: product.description,
      tags: product.tags,
      variantCount: await ProductVariant.countDocuments({
        productId: product._id,
        active: true,
      }),
      mediaCount: await ProductMedia.countDocuments({
        productId: product._id,
        status: 'ready',
      }),
      hasBrand: Boolean(product.brandId),
    });
    await product.save();
    await writeAudit(request, 'catalogue.variant_created', {
      targetType: 'product_variant',
      targetPublicId: variant.publicId,
      metadata: { productPublicId: product.publicId },
    });
    setFlash(request, 'success', 'Variant added.');
    return response.redirect(`/seller/products/${product.publicId}`);
  }),
);

router.post(
  '/seller/products/:publicId/variants/:variantPublicId',
  asyncHandler(async (request, response) => {
    const product = await findOwnedProduct(request);
    if (!canEditProduct(product)) {
      throw new AppError('Product is locked during review.', 409, 'PRODUCT_LOCKED');
    }
    const input = variantSchema.parse(request.body);
    const variant = await ProductVariant.findOne({
      publicId: request.params.variantPublicId,
      productId: product._id,
      storeId: request.store._id,
    });
    if (!variant) {
      throw new AppError('Variant not found.', 404, 'VARIANT_NOT_FOUND');
    }
    variant.sku = input.sku;
    variant.barcode = input.barcode || '';
    variant.title = input.title;
    variant.priceMinor = toMinorUnits(input.price, request.store.currency);
    variant.compareAtMinor = input.compareAt
      ? toMinorUnits(input.compareAt, request.store.currency)
      : undefined;
    variant.weightGrams = input.weightGrams;
    variant.active = input.active === 'yes';
    variant.options =
      input.optionName && input.optionValue
        ? new Map([[input.optionName, input.optionValue]])
        : new Map();
    await variant.save();
    await writeAudit(request, 'catalogue.variant_updated', {
      targetType: 'product_variant',
      targetPublicId: variant.publicId,
      metadata: { productPublicId: product.publicId },
    });
    setFlash(request, 'success', 'Variant updated.');
    return response.redirect(`/seller/products/${product.publicId}`);
  }),
);

router.post(
  '/seller/products/:publicId/media',
  uploadLimiter,
  upload(uploadProductImage),
  asyncHandler(async (request, response) => {
    const product = await findOwnedProduct(request);
    if (!canEditProduct(product)) {
      throw new AppError('Product is locked during review.', 409, 'PRODUCT_LOCKED');
    }
    const input = mediaMetadataSchema.parse(request.body);
    const count = await ProductMedia.countDocuments({ productId: product._id });
    if (count >= 12) {
      throw new AppError(
        'A product can have at most 12 images.',
        422,
        'MEDIA_LIMIT',
      );
    }
    const media = await sanitizeAndStoreProductImage({
      file: request.file,
      product,
      altText: input.altText,
      position: count,
    });
    await writeAudit(request, 'catalogue.media_uploaded', {
      targetType: 'product_media',
      targetPublicId: media.publicId,
      metadata: { productPublicId: product.publicId },
    });
    return response.status(201).json({
      media: {
        publicId: media.publicId,
        url: `/media/catalogue/${media.publicId}`,
        altText: media.altText,
        status: media.status,
      },
    });
  }),
);

router.post(
  '/seller/products/:publicId/media/:mediaPublicId',
  asyncHandler(async (request, response) => {
    const product = await findOwnedProduct(request);
    if (!canEditProduct(product)) {
      throw new AppError('Product is locked during review.', 409, 'PRODUCT_LOCKED');
    }
    const input = mediaMetadataSchema.parse(request.body);
    const media = await ProductMedia.findOne({
      publicId: request.params.mediaPublicId,
      productId: product._id,
      storeId: request.store._id,
      status: 'ready',
    });
    if (!media) throw new AppError('Media not found.', 404, 'MEDIA_NOT_FOUND');
    media.altText = input.altText;
    media.position = input.position;
    await media.save();
    await writeAudit(request, 'catalogue.media_updated', {
      targetType: 'product_media',
      targetPublicId: media.publicId,
    });
    setFlash(request, 'success', 'Image details updated.');
    return response.redirect(`/seller/products/${product.publicId}`);
  }),
);

router.post(
  '/seller/products/:publicId/media/:mediaPublicId/remove',
  asyncHandler(async (request, response) => {
    const product = await findOwnedProduct(request);
    if (!canEditProduct(product)) {
      throw new AppError('Product is locked during review.', 409, 'PRODUCT_LOCKED');
    }
    const media = await ProductMedia.findOne({
      publicId: request.params.mediaPublicId,
      productId: product._id,
      storeId: request.store._id,
      status: 'ready',
    });
    if (!media) throw new AppError('Media not found.', 404, 'MEDIA_NOT_FOUND');
    media.status = 'rejected';
    media.moderationReason = 'Removed by seller before submission.';
    await media.save();
    await writeAudit(request, 'catalogue.media_removed', {
      targetType: 'product_media',
      targetPublicId: media.publicId,
    });
    setFlash(request, 'success', 'Image removed from the product.');
    return response.redirect(`/seller/products/${product.publicId}`);
  }),
);

router.post(
  '/seller/products/:publicId/submit',
  workflowLimiter,
  asyncHandler(async (request, response) => {
    const product = await findOwnedProduct(request);
    if (!canEditProduct(product)) {
      throw new AppError('Product cannot be submitted now.', 409, 'PRODUCT_LOCKED');
    }
    if (request.store.status !== 'verified') {
      throw new AppError(
        'Complete seller verification before submitting products.',
        409,
        'STORE_NOT_VERIFIED',
      );
    }
    const [variantCount, mediaCount] = await Promise.all([
      ProductVariant.countDocuments({ productId: product._id, active: true }),
      ProductMedia.countDocuments({ productId: product._id, status: 'ready' }),
    ]);
    if (!variantCount || !mediaCount) {
      throw new AppError(
        'Add at least one active variant and one valid image.',
        422,
        'PRODUCT_INCOMPLETE',
      );
    }
    product.qualityScore = calculateQualityScore({
      title: product.title,
      description: product.description,
      tags: product.tags,
      variantCount,
      mediaCount,
      hasBrand: Boolean(product.brandId),
    });
    if (product.qualityScore < 45) {
      throw new AppError(
        'Improve the product details until quality reaches at least 45%.',
        422,
        'QUALITY_TOO_LOW',
      );
    }
    product.status = 'submitted';
    product.moderation.submittedAt = new Date();
    product.moderation.reason = '';
    await product.save();
    await addOutboxEvent({
      type: 'catalogue.product_submitted',
      aggregateType: 'product',
      aggregatePublicId: product.publicId,
      payload: { storePublicId: request.store.publicId },
    });
    await writeAudit(request, 'catalogue.product_submitted', {
      targetType: 'product',
      targetPublicId: product.publicId,
    });
    setFlash(request, 'success', 'Product submitted for moderation.');
    return response.redirect(`/seller/products/${product.publicId}`);
  }),
);

router.post(
  '/seller/products/:publicId/publish',
  asyncHandler(async (request, response) => {
    const product = await findOwnedProduct(request);
    if (product.status !== 'approved' || request.store.status !== 'verified') {
      throw new AppError(
        'Only an approved product from a verified store can be published.',
        409,
        'PRODUCT_NOT_APPROVED',
      );
    }
    const [variantCount, mediaCount] = await Promise.all([
      ProductVariant.countDocuments({ productId: product._id, active: true }),
      ProductMedia.countDocuments({ productId: product._id, status: 'approved' }),
    ]);
    if (!variantCount || !mediaCount) {
      throw new AppError(
        'Approved variants and media are required.',
        409,
        'PRODUCT_INCOMPLETE',
      );
    }
    product.status = 'published';
    product.publishedAt = new Date();
    await product.save();
    await addOutboxEvent({
      type: 'catalogue.product_published',
      aggregateType: 'product',
      aggregatePublicId: product.publicId,
      payload: { countries: product.countries },
    });
    await writeAudit(request, 'catalogue.product_published', {
      targetType: 'product',
      targetPublicId: product.publicId,
    });
    setFlash(request, 'success', 'Product published.');
    return response.redirect(`/seller/products/${product.publicId}`);
  }),
);

router.post(
  '/seller/products/:publicId/archive',
  asyncHandler(async (request, response) => {
    const product = await findOwnedProduct(request);
    product.status = 'archived';
    product.archivedAt = new Date();
    await product.save();
    await writeAudit(request, 'catalogue.product_archived', {
      targetType: 'product',
      targetPublicId: product.publicId,
    });
    setFlash(request, 'success', 'Product archived.');
    return response.redirect('/seller/products');
  }),
);

router.get(
  '/seller/inventory',
  asyncHandler(async (request, response) => {
    const [warehouses, variants, stock, movements, lots] = await Promise.all([
      Warehouse.find({ storeId: request.store._id, active: true })
        .sort({ name: 1 })
        .lean(),
      ProductVariant.find({ storeId: request.store._id, active: true })
        .populate('productId', 'title')
        .sort({ sku: 1 })
        .lean(),
      StockItem.find({ storeId: request.store._id })
        .populate('warehouseId', 'name')
        .populate('variantId', 'sku title')
        .sort({ updatedAt: -1 })
        .lean({ virtuals: true }),
      InventoryMovement.find({ storeId: request.store._id })
        .sort({ createdAt: -1 })
        .limit(30)
        .lean(),
      InventoryLot.find({ storeId: request.store._id }).populate('warehouseId','name').populate('variantId','sku title').sort({createdAt:-1}).limit(100).lean(),
    ]);
    return renderWorkspace(request, response, {
      section: 'inventory',
      warehouses,
      variants,
      stock,
      movements,
      lots,
    });
  }),
);

router.post(
  '/seller/warehouses',
  asyncHandler(async (request, response) => {
    const input = warehouseSchema.parse(request.body);
    await assertAvailableCountries([input.country]);
    const warehouse = await Warehouse.create({
      publicId: publicId('whs'),
      storeId: request.store._id,
      ownerUserId: request.store.ownerUserId,
      ...input,
    });
    await writeAudit(request, 'inventory.warehouse_created', {
      targetType: 'warehouse',
      targetPublicId: warehouse.publicId,
    });
    setFlash(request, 'success', 'Warehouse created.');
    return response.redirect('/seller/inventory');
  }),
);

router.post(
  '/seller/warehouses/:publicId',
  asyncHandler(async (request, response) => {
    const input = warehouseSchema.parse(request.body);
    await assertAvailableCountries([input.country]);
    const warehouse = await Warehouse.findOne({
      publicId: request.params.publicId,
      storeId: request.store._id,
      active: true,
    });
    if (!warehouse) {
      throw new AppError('Warehouse not found.', 404, 'WAREHOUSE_NOT_FOUND');
    }
    Object.assign(warehouse, input);
    await warehouse.save();
    await writeAudit(request, 'inventory.warehouse_updated', {
      targetType: 'warehouse',
      targetPublicId: warehouse.publicId,
    });
    setFlash(request, 'success', 'Warehouse updated.');
    return response.redirect('/seller/inventory');
  }),
);

router.post(
  '/seller/warehouses/:publicId/archive',
  asyncHandler(async (request, response) => {
    const warehouse = await Warehouse.findOne({
      publicId: request.params.publicId,
      storeId: request.store._id,
      active: true,
    });
    if (!warehouse) {
      throw new AppError('Warehouse not found.', 404, 'WAREHOUSE_NOT_FOUND');
    }
    const stockRemaining = await StockItem.exists({
      warehouseId: warehouse._id,
      $or: [{ onHand: { $gt: 0 } }, { reserved: { $gt: 0 } }, { damaged: { $gt: 0 } }, { quarantined: { $gt: 0 } }],
    });
    if (stockRemaining) {
      throw new AppError(
        'Move or adjust remaining stock before archiving this warehouse.',
        409,
        'WAREHOUSE_HAS_STOCK',
      );
    }
    warehouse.active = false;
    await warehouse.save();
    await writeAudit(request, 'inventory.warehouse_archived', {
      targetType: 'warehouse',
      targetPublicId: warehouse.publicId,
    });
    setFlash(request, 'success', 'Warehouse archived.');
    return response.redirect('/seller/inventory');
  }),
);

router.post(
  '/seller/inventory/adjust',
  asyncHandler(async (request, response) => {
    const input = stockAdjustmentSchema.parse(request.body);
    const [warehouse, variant] = await Promise.all([
      Warehouse.findOne({
        publicId: input.warehousePublicId,
        storeId: request.store._id,
        active: true,
      }),
      ProductVariant.findOne({
        publicId: input.variantPublicId,
        storeId: request.store._id,
        active: true,
      }),
    ]);
    if (!warehouse || !variant) {
      throw new AppError(
        'Warehouse or variant is unavailable.',
        422,
        'INVENTORY_REFERENCE_INVALID',
      );
    }
    const stock = await StockItem.findOneAndUpdate(
      { warehouseId: warehouse._id, variantId: variant._id },
      {
        $setOnInsert: {
          publicId: publicId('stk'),
          storeId: request.store._id,
          onHand: 0,
          reserved: 0,
          damaged: 0,
          quarantined: 0,
          binCode: '',
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );
    await adjustStock({
      stockItemId: stock._id,
      storeId: request.store._id,
      quantity: input.quantity,
      reason: input.reason,
      actorUserId: request.user._id,
      reorderPoint: input.reorderPoint,
    });
    await writeAudit(request, 'inventory.stock_adjusted', {
      targetType: 'stock_item',
      targetPublicId: stock.publicId,
      metadata: { quantity: input.quantity },
    });
    setFlash(request, 'success', 'Stock adjusted and movement recorded.');
    return response.redirect('/seller/inventory');
  }),
);

router.post('/seller/inventory/condition',asyncHandler(async(request,response)=>{
  const input={stockPublicId:String(request.body.stockPublicId||''),damaged:Number(request.body.damaged),quarantined:Number(request.body.quarantined),binCode:String(request.body.binCode||''),reason:String(request.body.reason||'').trim()};
  if(!input.stockPublicId||!Number.isSafeInteger(input.damaged)||!Number.isSafeInteger(input.quarantined)||input.damaged<0||input.quarantined<0||input.reason.length<3)throw new AppError('Complete the stock condition fields.',422,'STOCK_INVALID');
  const stock=await StockItem.findOne({publicId:input.stockPublicId,storeId:request.store._id});if(!stock)throw new AppError('Stock item not found.',404,'STOCK_NOT_FOUND');
  await setStockCondition({stockItemId:stock._id,storeId:request.store._id,damaged:input.damaged,quarantined:input.quarantined,binCode:input.binCode,reason:input.reason.slice(0,300),actorUserId:request.user._id});
  await writeAudit(request,'inventory.condition_changed',{targetType:'stock_item',targetPublicId:stock.publicId,metadata:{damaged:input.damaged,quarantined:input.quarantined,binCode:input.binCode}});setFlash(request,'success','Stock condition and bin updated.');response.redirect('/seller/inventory');
}));
router.post('/seller/inventory/lots',asyncHandler(async(request,response)=>{
  const stock=await StockItem.findOne({publicId:String(request.body.stockPublicId||''),storeId:request.store._id});if(!stock)throw new AppError('Stock item not found.',404,'STOCK_NOT_FOUND');
  const serialNumbers=String(request.body.serialNumbers||'').split(/\r?\n|,/).map(v=>v.trim()).filter(Boolean);
  const lot=await createInventoryLot({storeId:request.store._id,warehouseId:stock.warehouseId,stockItemId:stock._id,variantId:stock.variantId,batchNumber:String(request.body.batchNumber||''),serialNumbers,quantity:Number(request.body.quantity),expiresAt:request.body.expiresAt||null,notes:String(request.body.notes||''),actorUserId:request.user._id});
  await writeAudit(request,'inventory.lot_created',{targetType:'inventory_lot',targetPublicId:lot.publicId});setFlash(request,'success','Inventory lot recorded.');response.redirect('/seller/inventory');
}));
router.post('/seller/inventory/lots/:publicId/status',asyncHandler(async(request,response)=>{
  const lot=await setInventoryLotStatus({lotPublicId:request.params.publicId,storeId:request.store._id,status:String(request.body.status||''),actorUserId:request.user._id,reason:String(request.body.reason||'').slice(0,300)});await writeAudit(request,'inventory.lot_status_changed',{targetType:'inventory_lot',targetPublicId:lot.publicId,metadata:{status:lot.status}});setFlash(request,'success','Inventory lot status updated.');response.redirect('/seller/inventory');
}));

router.get(
  '/seller/products/import',
  asyncHandler(async (request, response) =>
    renderWorkspace(request, response, {
      section: 'bulk-import',
      preview: null,
      csv: 'title,description,category,sku,price\n',
    }),
  ),
);

router.post(
  '/seller/products/import/preview',
  importLimiter,
  asyncHandler(async (request, response) => {
    const input = bulkImportSchema.parse(request.body);
    const preview = parseCatalogueCsv(input.csv);
    return renderWorkspace(request, response, {
      section: 'bulk-import',
      preview,
      csv: input.csv,
    });
  }),
);

router.post(
  '/seller/products/import/errors.csv',
  importLimiter,
  asyncHandler(async (request, response) => {
    const input = bulkImportSchema.parse(request.body);
    const rows = parseCatalogueCsv(input.csv).filter(
      (row) => row.errors.length > 0,
    );
    const output = [
      'row,title,sku,errors',
      ...rows.map((row) =>
        [row.row, row.title, row.sku, row.errors.join('; ')].map(csvCell).join(','),
      ),
    ];
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      'attachment; filename="classic-mart-import-errors.csv"',
    );
    return response.send(`${output.join('\r\n')}\r\n`);
  }),
);

router.post(
  '/seller/products/import',
  importLimiter,
  asyncHandler(async (request, response) => {
    const input = bulkImportSchema.parse(request.body);
    const rows = parseCatalogueCsv(input.csv);
    if (rows.some((row) => row.errors.length)) {
      throw new AppError(
        'Fix every preview error before importing.',
        422,
        'CSV_ROWS_INVALID',
      );
    }
    const categories = await Category.find({
      active: true,
      $or: [
        { countries: { $size: 0 } },
        { countries: request.store.country },
      ],
    }).lean();
    const categoryMap = new Map(
      categories.flatMap((category) => [
        [category.slug.toLowerCase(), category],
        [category.name.toLowerCase(), category],
      ]),
    );
    for (const row of rows) {
      if (!categoryMap.has(row.category.toLowerCase())) {
        throw new AppError(
          `Row ${row.row}: category "${row.category}" does not exist.`,
          422,
          'CSV_CATEGORY_INVALID',
        );
      }
      inspectProductContent(row);
    }
    const duplicateSkus = await ProductVariant.find({
      storeId: request.store._id,
      sku: { $in: rows.map((row) => row.sku) },
    }).select('sku');
    if (duplicateSkus.length) {
      throw new AppError(
        `SKU already exists: ${duplicateSkus.map((item) => item.sku).join(', ')}`,
        409,
        'SKU_EXISTS',
      );
    }
    if (new Set(rows.map((row) => row.sku)).size !== rows.length) {
      throw new AppError('CSV contains duplicate SKUs.', 422, 'CSV_SKU_DUPLICATE');
    }

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        for (const row of rows) {
          const category = categoryMap.get(row.category.toLowerCase());
          const baseSlug = slugify(row.title);
          const slug = `${baseSlug.slice(0, 104)}-${row.sku
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .slice(0, 12)}`;
          const [product] = await Product.create(
            [
              {
                publicId: publicId('prd'),
                storeId: request.store._id,
                ownerUserId: request.store.ownerUserId,
                categoryId: category._id,
                title: row.title,
                slug,
                description: row.description,
                countries: [request.store.country],
                qualityScore: calculateQualityScore(row),
              },
            ],
            { session },
          );
          await ProductVariant.create(
            [
              {
                publicId: publicId('var'),
                productId: product._id,
                storeId: request.store._id,
                sku: row.sku,
                title: 'Default',
                priceMinor: toMinorUnits(row.price, request.store.currency),
                currency: request.store.currency,
              },
            ],
            { session },
          );
        }
        await addOutboxEvent(
          {
            type: 'catalogue.products_imported',
            aggregateType: 'store',
            aggregatePublicId: request.store.publicId,
            payload: { count: rows.length },
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    clearStorefrontCache();
    await writeAudit(request, 'catalogue.products_imported', {
      targetType: 'store',
      targetPublicId: request.store.publicId,
      metadata: { count: rows.length },
    });
    setFlash(request, 'success', `${rows.length} product drafts imported.`);
    return response.redirect('/seller/products');
  }),
);

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

router.get(
  '/seller/products/export.csv',
  asyncHandler(async (request, response) => {
    const products = await Product.find({ storeId: request.store._id })
      .populate('categoryId', 'name')
      .sort({ createdAt: 1 })
      .lean();
    const variants = await ProductVariant.find({
      storeId: request.store._id,
    }).lean();
    const byProduct = new Map();
    for (const variant of variants) {
      if (!byProduct.has(String(variant.productId))) {
        byProduct.set(String(variant.productId), variant);
      }
    }
    const rows = [
      'title,description,category,sku,price,status',
      ...products.map((product) => {
        const variant = byProduct.get(String(product._id));
        const amount = variant
          ? variant.priceMinor /
            (['UGX', 'RWF'].includes(variant.currency) ? 1 : 100)
          : '';
        return [
          product.title,
          product.description,
          product.categoryId?.name,
          variant?.sku,
          amount,
          product.status,
        ]
          .map(csvCell)
          .join(',');
      }),
    ];
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      'attachment; filename="classic-mart-products.csv"',
    );
    return response.send(`${rows.join('\r\n')}\r\n`);
  }),
);

export default router;

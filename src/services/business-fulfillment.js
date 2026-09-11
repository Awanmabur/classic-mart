import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { currentTraceFields } from '../core/trace.js';
import { decryptSensitive } from '../core/sensitive.js';
import {
  BusinessBudget,
  BusinessInvoice,
  BusinessOrganization,
  InventoryMovement,
  InventoryReservation,
  Order,
  Product,
  ProductVariant,
  ProcurementRequest,
  PurchaseOrder,
  SellerOrder,
  Shipment,
  StockItem,
  Store,
} from '../models/index.js';
import { addOutboxEvent } from './outbox.js';
import { allocateSellerLineSettlement, ensureLedgerAccount, postLedgerTransaction, sellerSettlementBreakdown } from './money.js';
import { ensureShipmentForOrder } from './logistics.js';
import { issueDeliveryNoteDocument, issueTaxInvoiceDocument } from './business-documents.js';

function maskTaxId(encrypted) {
  if (!encrypted) return '';
  try {
    const value = String(decryptSensitive(encrypted) || '').trim();
    if (!value) return '';
    return value.length <= 4 ? '*'.repeat(value.length) : `${'*'.repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
  } catch {
    return '';
  }
}

function invoiceAddress(org, kind = 'billing') {
  const delivery = kind === 'delivery';
  const contactName = delivery ? org.deliveryContactName : org.billingContactName;
  const phone = delivery ? org.deliveryPhone : org.billingPhone;
  const address = delivery ? org.deliveryAddress : org.billingAddress;
  const city = delivery ? org.deliveryCity : org.billingCity;
  const email = org.billingEmail;
  if (![contactName, phone, address, city, email].every(value => String(value || '').trim())) {
    throw new AppError(
      `Complete the business ${delivery ? 'delivery' : 'billing'} contact before this purchase order can be accepted.`,
      409,
      delivery ? 'BUSINESS_DELIVERY_PROFILE_REQUIRED' : 'BUSINESS_BILLING_PROFILE_REQUIRED',
    );
  }
  return {
    contactName: String(contactName).trim(),
    companyName: org.companyName,
    email: String(email).trim(),
    phone: String(phone).trim(),
    address: String(address).trim(),
    city: String(city).trim(),
    country: org.country,
    taxIdMasked: maskTaxId(org.taxIdEncrypted),
  };
}

async function reserveOrCommitLine({ po, line, lineKey, actorUserId, immediate, session }) {
  const variant = await ProductVariant.findOne({
    publicId: line.variantPublicId,
    storeId: po.storeId,
    active: true,
    currency: po.currency,
  }).session(session);
  if (!variant || variant.sku !== line.sku) throw new AppError(`SKU ${line.sku} is no longer sellable.`, 409, 'B2B_VARIANT_UNAVAILABLE');
  const product = await Product.findOne({
    _id: variant.productId,
    publicId: line.productPublicId,
    storeId: po.storeId,
    status: 'published',
    countries: po.country,
  }).session(session);
  if (!product) throw new AppError(`Product ${line.productPublicId} is no longer sellable.`, 409, 'B2B_PRODUCT_UNAVAILABLE');

  const stockRows = await StockItem.find({ storeId: po.storeId, variantId: variant._id }).sort({ createdAt: 1 }).session(session);
  let remaining = Number(line.quantity);
  const allocations = [];
  for (const snapshot of stockRows) {
    if (remaining <= 0) break;
    const available = Math.max(0, Number(snapshot.onHand) - Number(snapshot.reserved) - Number(snapshot.damaged) - Number(snapshot.quarantined));
    if (!available) continue;
    const quantity = Math.min(remaining, available);
    const update = immediate ? { $inc: { reserved: quantity } } : { $inc: { onHand: -quantity } };
    const stock = await StockItem.findOneAndUpdate(
      {
        _id: snapshot._id,
        storeId: po.storeId,
        $expr: { $gte: [{ $subtract: ['$onHand', { $add: ['$reserved', '$damaged', '$quarantined'] }] }, quantity] },
      },
      update,
      { returnDocument: 'after', session, runValidators: true },
    );
    if (!stock) continue;
    const reservationPublicId = publicId('rsv');
    const expiresAt = immediate ? new Date(Date.now() + 2 * 60 * 60 * 1000) : new Date(Date.now() + 365 * 86400000);
    const [reservation] = await InventoryReservation.create([{
      publicId: reservationPublicId,
      idempotencyKey: `b2b:${po.publicId}:${lineKey}:${stock.publicId}`.slice(0, 120),
      storeId: po.storeId,
      stockItemId: stock._id,
      variantId: variant._id,
      quantity,
      status: immediate ? 'active' : 'committed',
      expiresAt,
      committedAt: immediate ? undefined : new Date(),
      actorUserId,
    }], { session });
    await InventoryMovement.create([{
      publicId: publicId('mov'),
      storeId: po.storeId,
      stockItemId: stock._id,
      variantId: variant._id,
      warehouseId: stock.warehouseId,
      type: immediate ? 'reservation' : 'sale',
      quantity: immediate ? quantity : -quantity,
      onHandBefore: immediate ? stock.onHand : stock.onHand + quantity,
      onHandAfter: stock.onHand,
      reservedBefore: immediate ? stock.reserved - quantity : stock.reserved,
      reservedAfter: stock.reserved,
      damagedBefore: stock.damaged,
      damagedAfter: stock.damaged,
      quarantinedBefore: stock.quarantined,
      quarantinedAfter: stock.quarantined,
      reason: immediate ? 'B2B purchase-order stock reservation' : 'B2B approved-credit stock commitment',
      reference: po.publicId,
      actorUserId,
    }], { session });
    allocations.push({
      linePublicId: publicId('oli'),
      productId: product._id,
      variantId: variant._id,
      storeId: po.storeId,
      reservationPublicId: reservation.publicId,
      productPublicId: product.publicId,
      variantPublicId: variant.publicId,
      storePublicId: po.storePublicId,
      title: line.title || product.title,
      variantTitle: line.variantTitle || variant.title,
      sku: variant.sku,
      quantity,
      deliveredQuantity: 0,
      returnReservedQuantity: 0,
      returnedQuantity: 0,
      refundedQuantity: 0,
      unitPriceMinor: Number(line.unitMinor),
      unitCostMinor: Number(variant.costMinor || 0),
      costSnapshotStatus: 'captured',
      lineTotalMinor: Number(line.unitMinor) * quantity,
      currency: po.currency,
    });
    remaining -= quantity;
  }
  if (remaining > 0) throw new AppError(`Not enough available stock for ${line.sku}.`, 409, 'INSUFFICIENT_STOCK');
  return allocations;
}

async function outstandingCreditMinor(orgId, session) {
  const rows = await BusinessInvoice.aggregate([
    { $match: { organizationId: new mongoose.Types.ObjectId(orgId), status: { $in: ['credit_pending_delivery', 'open', 'overdue'] } } },
    { $group: { _id: null, total: { $sum: { $subtract: ['$totalMinor', '$paidMinor'] } } } },
  ]).session(session);
  return Number(rows[0]?.total || 0);
}


export async function syncProcurementStatus(procurementId, session = null) {
  if (!procurementId) return null;
  let requestQuery = ProcurementRequest.findById(procurementId);
  if (session) requestQuery = requestQuery.session(session);
  const procurement = await requestQuery;
  if (!procurement || procurement.closedAt || ['rejected', 'cancelled'].includes(procurement.status)) return procurement;
  let poQuery = PurchaseOrder.find({
    procurementRequestId: procurement._id,
    status: { $in: ['accepted', 'payment_pending', 'processing', 'fulfilled'] },
  }).select('items');
  if (session) poQuery = poQuery.session(session);
  const purchaseOrders = await poQuery.lean();
  const covered = new Map();
  for (const po of purchaseOrders) {
    for (const item of po.items || []) {
      const key = String(item.variantPublicId || item.productPublicId || '');
      if (!key) continue;
      covered.set(key, (covered.get(key) || 0) + Number(item.quantity || 0));
    }
  }
  let total = 0;
  let coveredTotal = 0;
  for (const item of procurement.items || []) {
    const key = String(item.variantPublicId || item.productPublicId || '');
    const quantity = Number(item.quantity || 0);
    total += quantity;
    coveredTotal += Math.min(quantity, Number(covered.get(key) || 0));
  }
  const nextStatus = coveredTotal <= 0 ? 'approved' : coveredTotal >= total ? 'ordered' : 'partially_ordered';
  if (procurement.status !== nextStatus) {
    procurement.status = nextStatus;
    procurement.timeline.push({ type: 'coverage.updated', message: `Procurement coverage changed to ${nextStatus.replaceAll('_', ' ')}.` });
    await procurement.save({ session });
  }
  return procurement;
}

export async function ageBusinessInvoices(now = new Date(), { limit = 250 } = {}) {
  const rows = await BusinessInvoice.find({ status: 'open', dueAt: { $lte: now } }).sort({ dueAt: 1 }).limit(limit).select('_id');
  let overdue = 0;
  for (const row of rows) {
    const result = await BusinessInvoice.updateOne(
      { _id: row._id, status: 'open', dueAt: { $lte: now } },
      { $set: { status: 'overdue' }, $push: { timeline: { type: 'overdue', message: 'Invoice passed its payment due date.' } } },
    );
    overdue += result.modifiedCount;
  }
  return { checked: rows.length, overdue };
}

export async function acceptPurchaseOrderIntoCommerce({ request, purchaseOrderPublicId }) {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const po = await PurchaseOrder.findOne({ publicId: purchaseOrderPublicId, storeId: request.store._id, status: 'issued' }).session(session);
      if (!po) throw new AppError('Issued purchase order not found.', 404, 'PURCHASE_ORDER_NOT_FOUND');
      const org = await BusinessOrganization.findById(po.organizationId).select('+taxIdEncrypted').session(session);
      if (!org || org.status !== 'active') throw new AppError('Business organization is not active.', 409, 'BUSINESS_ORG_UNAVAILABLE');
      const store = await Store.findOne({ _id: po.storeId, status: 'verified', country: po.country }).session(session);
      if (!store) throw new AppError('Seller store is no longer verified.', 409, 'STORE_NOT_VERIFIED');
      if (po.currency !== org.currency || po.currency !== store.currency) throw new AppError('Purchase-order currency no longer matches buyer and seller.', 409, 'B2B_CURRENCY_MISMATCH');
      const immediate = po.paymentTerms !== 'credit';
      if (!immediate) {
        if (!org.invoiceTermsApproved || org.invoiceTermsDays <= 0 || org.creditLimitMinor <= 0) throw new AppError('Business credit terms are no longer approved.', 409, 'BUSINESS_CREDIT_NOT_APPROVED');
        const outstanding = await outstandingCreditMinor(org._id, session);
        if (outstanding + po.totalMinor > org.creditLimitMinor) throw new AppError('Business credit limit is no longer sufficient for this purchase order.', 409, 'BUSINESS_CREDIT_LIMIT');
      }
      const billTo = invoiceAddress(org, 'billing');
      const shipTo = invoiceAddress(org, 'delivery');
      const orderItems = [];
      for (let lineIndex = 0; lineIndex < po.items.length; lineIndex += 1) {
        const line = po.items[lineIndex];
        orderItems.push(...await reserveOrCommitLine({ po, line, lineKey: `${lineIndex}:${line.variantPublicId}`, actorUserId: request.user._id, immediate, session }));
      }
      const calculated = orderItems.reduce((sum, line) => sum + Number(line.lineTotalMinor), 0);
      if (calculated !== Number(po.subtotalMinor||0)) throw new AppError('Purchase-order merchandise subtotal changed during fulfilment.', 409, 'B2B_TOTAL_MISMATCH');
      if (Number(po.subtotalMinor||0)+Number(po.taxMinor||0)!==Number(po.totalMinor||0)) throw new AppError('Purchase-order tax snapshot no longer balances to its total.',409,'B2B_TAX_SNAPSHOT_INVALID');
      const orderPublicId = publicId('ord');
      const reservationExpiry = immediate ? new Date(Date.now() + 2 * 60 * 60 * 1000) : new Date(Date.now() + 365 * 86400000);
      const [order] = await Order.create([{
        publicId: orderPublicId,
        ...currentTraceFields(),
        idempotencyKey: `b2b:${po.publicId}`,
        checkoutId: `b2b:${po.publicId}`,
        cartPublicId: `b2b:${po.publicId}`,
        sessionKey: `business:${org.publicId}`,
        userId: po.issuedByUserId,
        country: po.country,
        status: immediate ? 'pending_payment' : 'confirmed',
        deliveryMethod: 'standard',
        paymentMethod: immediate ? 'pesapal' : 'credit_terms',
        businessOrganizationId: org._id,
        purchaseOrderId: po._id,
        purchaseOrderPublicId: po.publicId,
        paymentState: immediate ? 'pending' : 'credit_due',
        fulfillmentState: 'unfulfilled',
        contact: { fullName: shipTo.contactName, email: shipTo.email, phone: shipTo.phone, address: shipTo.address, city: shipTo.city, country: shipTo.country, note: `Business PO ${po.poNumber}` },
        totals: { subtotalMinor: po.subtotalMinor, shippingMinor: 0, discountMinor: 0, taxMinor: po.taxMinor, totalMinor: po.totalMinor, currency: po.currency },
        items: orderItems,
        sellerOrderPublicIds: [],
        policySnapshot: { returnWindowDays: 30, policyVersion: '2026-09-b2b', platformFeeBps: 500, taxBps: po.taxBps },
        timeline: [{ type: 'business.po_accepted', message: `Seller accepted business purchase order ${po.poNumber}.` }],
        reservationExpiresAt: reservationExpiry,
      }], { session });
      const platformFeeMinor = Math.floor(Number(po.subtotalMinor||0) * Number(order.policySnapshot.platformFeeBps || 0) / 10000);
      const sellerOrderPublicId = publicId('sord');
      const settlementItems = allocateSellerLineSettlement(orderItems, { discountMinor: 0, platformFeeMinor });
      const [sellerOrder] = await SellerOrder.create([{
        publicId: sellerOrderPublicId,
        orderId: order._id,
        orderPublicId: order.publicId,
        storeId: po.storeId,
        storePublicId: po.storePublicId,
        country: po.country,
        status: immediate ? 'pending_payment' : 'confirmed',
        subtotalMinor: po.subtotalMinor,
        platformFeeMinor,
        shippingMinor: 0,
        taxMinor: po.taxMinor,
        discountMinor: 0,
        currency: po.currency,
        items: settlementItems.map(line => ({ orderLineId: line.linePublicId, productPublicId: line.productPublicId, variantPublicId: line.variantPublicId, title: line.title, variantTitle: line.variantTitle, sku: line.sku, quantity: line.quantity, unitPriceMinor: line.unitPriceMinor, unitCostMinor: line.unitCostMinor, costSnapshotStatus: line.costSnapshotStatus, lineTotalMinor: line.lineTotalMinor, currency: po.currency, grossMinor: line.grossMinor, discountMinor: line.discountMinor, customerPaidMinor: line.customerPaidMinor, platformFeeMinor: line.platformFeeMinor, sellerReceivableMinor: line.sellerReceivableMinor })),
        timeline: [{ type: 'business.po_accepted', message: 'Business purchase order entered marketplace fulfilment with immutable line settlement snapshots.' }],
      }], { session });
      order.sellerOrderPublicIds = [sellerOrder.publicId];
      const invoicePublicId = publicId('binv');
      const [invoice] = await BusinessInvoice.create([{
        publicId: invoicePublicId,
        invoiceNumber: `INV-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
        organizationId: org._id,
        purchaseOrderId: po._id,
        orderId: order._id,
        orderPublicId: order.publicId,
        storeId: po.storeId,
        storePublicId: po.storePublicId,
        country: po.country,
        currency: po.currency,
        paymentTerms: immediate ? 'immediate' : 'credit',
        termsDays: immediate ? 0 : org.invoiceTermsDays,
        status: immediate ? 'awaiting_payment' : 'credit_pending_delivery',
        subtotalMinor: po.subtotalMinor,
        taxBps:po.taxBps,
        taxPolicyVersion:po.taxPolicyVersion||'legacy-zero-tax',
        taxMinor: po.taxMinor,
        shippingMinor: 0,
        totalMinor: po.totalMinor,
        paidMinor: 0,
        lines: po.items.map(line => ({ ...line.toObject?.() || line })),
        billTo,
        shipTo,
        issuedAt: new Date(),
        timeline: [{ type: 'issued', message: immediate ? 'Invoice issued for immediate Pesapal payment.' : `Invoice issued on approved ${org.invoiceTermsDays}-day credit terms.`, actorUserId: request.user._id }],
      }], { session });
      await issueTaxInvoiceDocument(invoice,{session,issuedByUserId:request.user._id});
      order.businessInvoiceId = invoice._id;
      order.businessInvoicePublicId = invoice.publicId;
      await order.save({ session });
      po.orderPublicId = order.publicId;
      po.invoicePublicId = invoice.publicId;
      po.status = immediate ? 'payment_pending' : 'processing';
      po.timeline.push({ type: 'seller.accepted', message: immediate ? 'Seller accepted PO; stock is reserved pending verified Pesapal payment.' : 'Seller accepted PO; stock was committed under approved credit terms.', actorUserId: request.user._id });
      await po.save({ session });
      await syncProcurementStatus(po.procurementRequestId, session);
      await addOutboxEvent({ type: 'business.purchase_order.accepted', aggregateType: 'purchase_order', aggregatePublicId: po.publicId, payload: { orderPublicId: order.publicId, invoicePublicId: invoice.publicId, paymentTerms: po.paymentTerms } }, session);
      if (!immediate) await ensureShipmentForOrder(order, request.user._id, session);
      result = { po, order, invoice, sellerOrder };
    });
    return result;
  } finally {
    await session.endSession();
  }
}

export async function recordBusinessDelivery({ orderId, actorUserId, session }) {
  const order = await Order.findById(orderId).session(session);
  if (!order?.businessOrganizationId || !order.businessInvoiceId) return null;
  const invoice = await BusinessInvoice.findById(order.businessInvoiceId).session(session);
  const po = order.purchaseOrderId ? await PurchaseOrder.findById(order.purchaseOrderId).session(session) : null;
  if (!invoice) throw new AppError('Business invoice is missing for delivered order.', 409, 'BUSINESS_INVOICE_MISSING');
  if (order.fulfillmentState === 'delivered' && invoice.deliveredAt) return invoice;
  const now = new Date();
  order.fulfillmentState = 'delivered';
  for (const item of order.items) item.deliveredQuantity = Math.max(Number(item.deliveredQuantity || 0), Number(item.quantity || 0));
  order.timeline.push({ type: 'fulfilment.delivered', message: 'Business order delivered with verified proof.' });
  invoice.deliveredAt = now;
  invoice.timeline.push({ type: 'delivered', message: 'Business order delivered with verified proof.', actorUserId });
  if (order.paymentMethod === 'credit_terms') {
    const sellerOrders = await SellerOrder.find({ orderId: order._id }).session(session).lean();
    const receivable = await ensureLedgerAccount({ code: 'business_accounts_receivable', type: 'asset', ownerType: 'business', ownerId: order.businessOrganizationId, ownerPublicId: String(order.businessOrganizationId), country: order.country, currency: order.totals.currency }, session);
    const entries = [{ account: receivable, debitMinor: order.totals.totalMinor, creditMinor: 0, memo: `Business receivable recognized for ${order.publicId}` }];
    let platformFeeTotal = 0;
    for (const sellerOrder of sellerOrders) {
      const settlement = sellerSettlementBreakdown(sellerOrder);platformFeeTotal += settlement.platformFeeMinor;
      const store = await Store.findOne({ publicId: sellerOrder.storePublicId }).session(session);
      const payable = await ensureLedgerAccount({ code: 'seller_payable', type: 'liability', ownerType: 'store', ownerId: store?._id, ownerPublicId: sellerOrder.storePublicId, country: order.country, currency: order.totals.currency }, session);
      if (settlement.sellerPayableMinor > 0) entries.push({ account: payable, debitMinor: 0, creditMinor: settlement.sellerPayableMinor, memo: 'Seller payable from delivered business credit order' });
    }
    const platformAmount = platformFeeTotal + Number(order.totals.shippingMinor || 0);
    if (platformAmount > 0) {
      const revenue = await ensureLedgerAccount({ code: 'platform_revenue', type: 'revenue', ownerType: 'platform', ownerPublicId: 'classic-mart', country: order.country, currency: order.totals.currency }, session);
      entries.push({ account: revenue, debitMinor: 0, creditMinor: platformAmount, memo: 'Marketplace fee from delivered business credit order' });
    }
    if (order.totals.taxMinor > 0) {
      const tax = await ensureLedgerAccount({ code: 'tax_payable', type: 'liability', ownerType: 'platform', ownerPublicId: 'classic-mart', country: order.country, currency: order.totals.currency }, session);
      entries.push({ account: tax, debitMinor: 0, creditMinor: order.totals.taxMinor, memo: 'Business order tax liability' });
    }
    await postLedgerTransaction({ idempotencyKey: `business-credit-delivery:${order.publicId}`, referenceType: 'business_invoice', referencePublicId: invoice.publicId, currency: order.totals.currency, country: order.country, description: `Business credit invoice ${invoice.invoiceNumber} delivered`, entries }, session);
    order.paymentState = 'credit_due';
    invoice.status = 'open';
    invoice.dueAt = new Date(now.getTime() + Math.max(0, Number(invoice.termsDays || 0)) * 86400000);
  }
  if (po) {
    po.status = 'fulfilled';
    po.timeline.push({ type: 'delivery.fulfilled', message: 'Purchase order fulfilled by verified delivery.', actorUserId });
    await po.save({ session });
    if (po.procurementRequestId) {
      const procurement = await (await import('../models/ProcurementRequest.js')).ProcurementRequest.findById(po.procurementRequestId).session(session);
      if (procurement?.budgetId) {
        const approved = Math.max(0, Number(po.approvedAmountMinor || po.totalMinor || 0));
        const budget = await BusinessBudget.findOneAndUpdate({ _id: procurement.budgetId, committedMinor: { $gte: approved } }, { $inc: { committedMinor: -approved, spentMinor: Number(po.totalMinor || 0) } }, { session, returnDocument: 'after' });
        if (!budget) throw new AppError('Business budget settlement could not be recorded safely.', 409, 'BUDGET_SETTLEMENT_CONFLICT');
      }
    }
  }
  await order.save({ session });
  await invoice.save({ session });
  const shipment=await Shipment.findOne({orderId:order._id,kind:'outbound',status:'delivered'}).session(session);
  await issueDeliveryNoteDocument({order,invoice,purchaseOrder:po,shipment,issuedByUserId:actorUserId,session});
  return invoice;
}

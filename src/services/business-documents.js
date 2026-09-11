import crypto from 'node:crypto';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { cursorScope, cursorSort, decodeCursor, pageResult } from './pagination.js';
import {
  BusinessDocument,
  BusinessInvoice,
  BusinessMember,
  BusinessOrganization,
  FinancialDocument,
  Order,
  PurchaseOrder,
  QuoteRequest,
  Shipment,
  Store,
} from '../models/index.js';

function plain(value) {
  if (!value) return value;
  if (typeof value.toObject === 'function') return value.toObject({ depopulate: true, versionKey: false });
  return JSON.parse(JSON.stringify(value));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function digest(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(snapshot))).digest('hex');
}

function lineSnapshot(items = []) {
  return items.map(item => ({
    productPublicId: item.productPublicId || '',
    variantPublicId: item.variantPublicId || '',
    sku: item.sku || '',
    title: item.title || '',
    variantTitle: item.variantTitle || '',
    quantity: Number(item.quantity || 0),
    unitMinor: Number(item.offeredUnitMinor ?? item.unitMinor ?? item.unitPriceMinor ?? 0),
    lineMinor: Number(item.offeredLineMinor ?? item.lineMinor ?? item.lineTotalMinor ?? 0),
  }));
}

async function parties({ organizationId, storeId, session }) {
  const orgQuery = BusinessOrganization.findById(organizationId).select('publicId companyName country currency billingEmail billingContactName billingPhone billingAddress billingCity');
  const storeQuery = Store.findById(storeId).select('publicId name country currency');
  if (session) { orgQuery.session(session); storeQuery.session(session); }
  const [organization, store] = await Promise.all([orgQuery.lean(), storeQuery.lean()]);
  if (!organization || !store) throw new AppError('Business document parties are unavailable.', 409, 'BUSINESS_DOCUMENT_PARTIES_MISSING');
  return {
    organization,
    buyer: {
      publicId: organization.publicId,
      companyName: organization.companyName,
      country: organization.country,
      billingEmail: organization.billingEmail || '',
      billingContactName: organization.billingContactName || '',
      billingPhone: organization.billingPhone || '',
      billingAddress: organization.billingAddress || '',
      billingCity: organization.billingCity || '',
    },
    seller: { publicId: store.publicId, name: store.name, country: store.country },
  };
}

function numberFor(type, source, revision = 1) {
  if (type === 'quotation') return `CM-QTN-${String(source).replace(/[^A-Za-z0-9-]/g, '').toUpperCase()}-R${revision}`.slice(0, 140);
  if (type === 'purchase_order') return String(source).slice(0, 140);
  if (type === 'tax_invoice') return String(source).slice(0, 140);
  if (type === 'delivery_note') return `CM-DN-${String(source).replace(/[^A-Za-z0-9-]/g, '').toUpperCase()}`.slice(0, 140);
  return `CM-DOC-${String(source).replace(/[^A-Za-z0-9-]/g, '').toUpperCase()}`.slice(0, 140);
}

export async function issueBusinessDocument(input) {
  const existing = await BusinessDocument.findOne({ eventKey: input.eventKey }).session(input.session || null);
  if (existing) return existing;
  const snapshot = plain(input.snapshot);
  const docs = await BusinessDocument.create([{
    publicId: publicId('bdoc'),
    eventKey: input.eventKey,
    documentNumber: input.documentNumber,
    type: input.type,
    organizationId: input.organizationId,
    organizationPublicId: input.organizationPublicId,
    storeId: input.storeId,
    storePublicId: input.storePublicId,
    quoteRequestId: input.quoteRequestId || undefined,
    quoteRequestPublicId: input.quoteRequestPublicId || '',
    purchaseOrderId: input.purchaseOrderId || undefined,
    purchaseOrderPublicId: input.purchaseOrderPublicId || '',
    businessInvoiceId: input.businessInvoiceId || undefined,
    businessInvoicePublicId: input.businessInvoicePublicId || '',
    orderId: input.orderId || undefined,
    orderPublicId: input.orderPublicId || '',
    shipmentId: input.shipmentId || undefined,
    shipmentPublicId: input.shipmentPublicId || '',
    country: input.country,
    currency: input.currency,
    revision: Math.max(1, Number(input.revision || 1)),
    legacySnapshot: Boolean(input.legacySnapshot),
    amountMinor: Math.max(0, Number(input.amountMinor || 0)),
    snapshot,
    snapshotDigest: digest(snapshot),
    issuedByUserId: input.issuedByUserId || undefined,
    issuedAt: input.issuedAt || new Date(),
  }], { session: input.session || undefined });
  return docs[0];
}

export async function issueQuotationDocument(quoteLike, { session = null, issuedByUserId = null, legacySnapshot = false } = {}) {
  const quote = plain(quoteLike);
  const revision = Math.max(1, Number(quote.revision || 1));
  const { organization, buyer, seller } = await parties({ organizationId: quote.organizationId, storeId: quote.storeId, session });
  const snapshot = {
    issuer: { name: 'Classic Mart', platform: 'Classic Technologies' },
    buyer,
    seller,
    quotation: {
      publicId: quote.publicId,
      revision,
      status: quote.status,
      validUntil: quote.validUntil || null,
      approvedAmountMinor: Number(quote.approvedAmountMinor || 0),
      offeredTotalMinor: Number(quote.offeredTotalMinor || 0),
      currency: quote.currency,
      items: lineSnapshot(quote.items),
      sellerMessage: [...(quote.messages || [])].reverse().find(row => row.actorType === 'seller')?.message || '',
    },
  };
  return issueBusinessDocument({
    type: 'quotation', eventKey: `quotation:${quote.publicId}:r${revision}`,
    documentNumber: numberFor('quotation', quote.publicId, revision),
    organizationId: quote.organizationId, organizationPublicId: organization.publicId,
    storeId: quote.storeId, storePublicId: quote.storePublicId,
    quoteRequestId: quote._id, quoteRequestPublicId: quote.publicId,
    country: quote.country, currency: quote.currency, revision,
    amountMinor: quote.offeredTotalMinor, snapshot, issuedByUserId, legacySnapshot, session,
  });
}

export async function issuePurchaseOrderDocument(poLike, { session = null, issuedByUserId = null, legacySnapshot = false } = {}) {
  const po = plain(poLike);
  const { organization, buyer, seller } = await parties({ organizationId: po.organizationId, storeId: po.storeId, session });
  const snapshot = {
    issuer: { name: 'Classic Mart', platform: 'Classic Technologies' }, buyer, seller,
    purchaseOrder: {
      publicId: po.publicId, poNumber: po.poNumber, status: po.status,
      paymentTerms: po.paymentTerms, invoiceTermsDays: Number(po.invoiceTermsDays || 0),
      subtotalMinor: Number(po.subtotalMinor || 0), taxBps: Number(po.taxBps || 0), taxMinor: Number(po.taxMinor || 0),
      taxPolicyVersion: po.taxPolicyVersion || 'legacy-zero-tax', totalMinor: Number(po.totalMinor || 0), currency: po.currency,
      items: lineSnapshot(po.items),
    },
  };
  return issueBusinessDocument({
    type: 'purchase_order', eventKey: `purchase_order:${po.publicId}`,
    documentNumber: numberFor('purchase_order', po.poNumber),
    organizationId: po.organizationId, organizationPublicId: organization.publicId,
    storeId: po.storeId, storePublicId: po.storePublicId,
    quoteRequestId: po.quoteRequestId || undefined,
    purchaseOrderId: po._id, purchaseOrderPublicId: po.publicId,
    country: po.country, currency: po.currency, amountMinor: po.totalMinor,
    snapshot, issuedByUserId: issuedByUserId || po.issuedByUserId, legacySnapshot, session,
  });
}

export async function issueTaxInvoiceDocument(invoiceLike, { session = null, issuedByUserId = null, legacySnapshot = false } = {}) {
  const invoice = plain(invoiceLike);
  const { organization, buyer, seller } = await parties({ organizationId: invoice.organizationId, storeId: invoice.storeId, session });
  const snapshot = {
    issuer: { name: 'Classic Mart', platform: 'Classic Technologies' }, buyer, seller,
    invoice: {
      publicId: invoice.publicId, invoiceNumber: invoice.invoiceNumber, status: invoice.status,
      paymentTerms: invoice.paymentTerms, termsDays: Number(invoice.termsDays || 0),
      issuedAt: invoice.issuedAt || null, dueAt: invoice.dueAt || null,
      subtotalMinor: Number(invoice.subtotalMinor || 0), taxBps: Number(invoice.taxBps || 0), taxMinor: Number(invoice.taxMinor || 0),
      taxPolicyVersion: invoice.taxPolicyVersion || 'legacy-zero-tax', shippingMinor: Number(invoice.shippingMinor || 0),
      totalMinor: Number(invoice.totalMinor || 0), currency: invoice.currency,
      billTo: plain(invoice.billTo), shipTo: plain(invoice.shipTo), items: lineSnapshot(invoice.lines),
      orderPublicId: invoice.orderPublicId || '',
    },
  };
  return issueBusinessDocument({
    type: 'tax_invoice', eventKey: `tax_invoice:${invoice.publicId}`,
    documentNumber: numberFor('tax_invoice', invoice.invoiceNumber),
    organizationId: invoice.organizationId, organizationPublicId: organization.publicId,
    storeId: invoice.storeId, storePublicId: invoice.storePublicId,
    purchaseOrderId: invoice.purchaseOrderId, businessInvoiceId: invoice._id, businessInvoicePublicId: invoice.publicId,
    orderId: invoice.orderId, orderPublicId: invoice.orderPublicId,
    country: invoice.country, currency: invoice.currency, amountMinor: invoice.totalMinor,
    snapshot, issuedByUserId, legacySnapshot, session,
  });
}

export async function issueDeliveryNoteDocument({ order: orderLike, invoice: invoiceLike, purchaseOrder: poLike = null, shipment: shipmentLike = null, issuedByUserId = null, session = null, legacySnapshot = false }) {
  const order = plain(orderLike); const invoice = plain(invoiceLike); const po = plain(poLike); const shipment = plain(shipmentLike);
  const { organization, buyer, seller } = await parties({ organizationId: invoice.organizationId, storeId: invoice.storeId, session });
  const deliveredAt = shipment?.deliveredAt || invoice.deliveredAt || new Date();
  const snapshot = {
    issuer: { name: 'Classic Mart', platform: 'Classic Technologies' }, buyer, seller,
    delivery: {
      orderPublicId: order.publicId, purchaseOrderPublicId: po?.publicId || '', purchaseOrderNumber: po?.poNumber || '',
      invoicePublicId: invoice.publicId, invoiceNumber: invoice.invoiceNumber,
      shipmentPublicId: shipment?.publicId || '', deliveredAt,
      proofType: shipment?.proof?.type || 'verified', proofReference: shipment?.proof?.reference || '',
      shipTo: plain(invoice.shipTo), currency: invoice.currency,
      items: (order.items || []).map(item => ({ ...lineSnapshot([item])[0], deliveredQuantity: Number(item.deliveredQuantity || item.quantity || 0) })),
    },
  };
  const source = shipment?.publicId || order.publicId;
  return issueBusinessDocument({
    type: 'delivery_note', eventKey: `delivery_note:${order.publicId}`,
    documentNumber: numberFor('delivery_note', source),
    organizationId: invoice.organizationId, organizationPublicId: organization.publicId,
    storeId: invoice.storeId, storePublicId: invoice.storePublicId,
    purchaseOrderId: invoice.purchaseOrderId, purchaseOrderPublicId: po?.publicId || '',
    businessInvoiceId: invoice._id, businessInvoicePublicId: invoice.publicId,
    orderId: order._id, orderPublicId: order.publicId,
    shipmentId: shipment?._id || undefined, shipmentPublicId: shipment?.publicId || '',
    country: invoice.country, currency: invoice.currency, amountMinor: invoice.totalMinor,
    snapshot, issuedByUserId, issuedAt: deliveredAt, legacySnapshot, session,
  });
}

export async function businessDocumentAccess(actor, documentPublicId, { activeOrganizationPublicId = '' } = {}) {
  const memberships = await BusinessMember.find({ userId: actor._id, status: 'active' }).select('organizationId').lean();
  const memberIds = memberships.map(row => row.organizationId);
  const owned = await BusinessOrganization.find({ ownerUserId: actor._id, status: { $ne: 'suspended' } }).select('_id publicId').lean();
  const allowedIds = [...new Set([...memberIds.map(String), ...owned.map(row => String(row._id))])];
  if (!allowedIds.length) throw new AppError('Business document not found.', 404, 'BUSINESS_DOCUMENT_NOT_FOUND');
  const query = { publicId: documentPublicId, organizationId: { $in: allowedIds } };
  if (activeOrganizationPublicId) {
    const org = await BusinessOrganization.findOne({ publicId: activeOrganizationPublicId, _id: { $in: allowedIds }, status: { $ne: 'suspended' } }).select('_id').lean();
    if (!org) throw new AppError('Selected business workspace is unavailable.', 403, 'BUSINESS_WORKSPACE_FORBIDDEN');
    query.organizationId = org._id;
  }
  const document = await BusinessDocument.findOne(query).lean();
  if (!document) throw new AppError('Business document not found.', 404, 'BUSINESS_DOCUMENT_NOT_FOUND');
  return document;
}

export async function businessDocumentHistory(organizationId, { businessAfter = '', financialAfter = '', limit = 50 } = {}) {
  const size = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const businessBase = { organizationId };
  const [businessRows, businessTotal] = await Promise.all([
    BusinessDocument.find(cursorScope(businessBase,businessAfter,{field:'issuedAt'})).sort(cursorSort('issuedAt')).limit(size+1).lean(),
    BusinessDocument.countDocuments(businessBase),
  ]);
  const businessPage = pageResult(businessRows,{field:'issuedAt',limit:size,total:businessTotal});

  // FinancialDocument predates organization snapshots. Join to the authoritative Order
  // instead of restricting finance history to only the currently visible B2B document page.
  const financialCursor = decodeCursor(financialAfter,{type:'date'});
  const cursorMatch = financialCursor ? {$or:[{issuedAt:{$lt:financialCursor.value}},{issuedAt:financialCursor.value,_id:{$lt:financialCursor.id}}]} : {};
  const lookup = {
    $lookup:{from:Order.collection.name,localField:'orderId',foreignField:'_id',as:'organizationOrder'},
  };
  const organizationMatch = {$match:{'organizationOrder.businessOrganizationId':organizationId}};
  const [financialRows, financialCount] = await Promise.all([
    FinancialDocument.aggregate([{$match:cursorMatch},lookup,organizationMatch,{$sort:{issuedAt:-1,_id:-1}},{$limit:size+1},{$project:{organizationOrder:0}}]),
    FinancialDocument.aggregate([lookup,organizationMatch,{$count:'count'}]),
  ]);
  const financialPage = pageResult(financialRows,{field:'issuedAt',limit:size,total:financialCount[0]?.count||0});
  return {business:businessPage.items,financial:financialPage.items,pages:{business:businessPage.page,financial:financialPage.page}};
}

function pdfEscape(value) { return String(value ?? '').replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)').replace(/[^\x20-\x7E]/g, '?'); }
function money(minor, currency) { const code=String(currency||'').toUpperCase();const value=Number(minor||0);const zeroDecimal=new Set(['UGX','RWF','JPY','KRW']);return zeroDecimal.has(code)?`${code} ${Math.round(value).toLocaleString('en-US')}`.trim():`${code} ${(value/100).toFixed(2)}`.trim(); }

function documentLines(document) {
  const snap = document.snapshot || {}; const lines = [];
  const title = { quotation: 'QUOTATION', purchase_order: 'PURCHASE ORDER', tax_invoice: 'TAX INVOICE', delivery_note: 'DELIVERY NOTE' }[document.type] || 'BUSINESS DOCUMENT';
  lines.push(title, document.documentNumber, `Issued: ${new Date(document.issuedAt).toISOString()}`, `Country: ${document.country}   Currency: ${document.currency}`, '');
  if (snap.buyer) lines.push(`Buyer: ${snap.buyer.companyName || ''}`, `Buyer reference: ${snap.buyer.publicId || ''}`);
  if (snap.seller) lines.push(`Seller: ${snap.seller.name || ''}`, `Seller reference: ${snap.seller.publicId || ''}`, '');
  const body = snap.quotation || snap.purchaseOrder || snap.invoice || snap.delivery || {};
  if (body.revision) lines.push(`Revision: ${body.revision}`);
  if (body.validUntil) lines.push(`Valid until: ${new Date(body.validUntil).toISOString()}`);
  if (body.poNumber) lines.push(`PO: ${body.poNumber}`);
  if (body.invoiceNumber) lines.push(`Invoice: ${body.invoiceNumber}`);
  if (body.orderPublicId) lines.push(`Order: ${body.orderPublicId}`);
  if (body.shipmentPublicId) lines.push(`Shipment: ${body.shipmentPublicId}`);
  if (body.deliveredAt) lines.push(`Delivered: ${new Date(body.deliveredAt).toISOString()}`);
  if (body.paymentTerms) lines.push(`Payment terms: ${body.paymentTerms}${body.termsDays ? ` (${body.termsDays} days)` : ''}`);
  lines.push('');
  for (const item of body.items || []) lines.push(`${item.sku || ''} | ${item.title || ''} ${item.variantTitle || ''} | Qty ${item.deliveredQuantity ?? item.quantity ?? 0} | ${money(item.lineMinor, document.currency)}`);
  if (body.subtotalMinor !== undefined) lines.push('', `Subtotal: ${money(body.subtotalMinor, document.currency)}`);
  if (body.taxMinor !== undefined) lines.push(`Tax (${Number(body.taxBps || 0)} bps): ${money(body.taxMinor, document.currency)}`);
  if (body.shippingMinor !== undefined) lines.push(`Shipping: ${money(body.shippingMinor, document.currency)}`);
  const total = body.totalMinor ?? body.offeredTotalMinor ?? document.amountMinor;
  lines.push(`Total: ${money(total, document.currency)}`, '', `Snapshot SHA-256: ${document.snapshotDigest}`, 'Classic Mart / Classic Technologies');
  return lines;
}

export function renderBusinessDocumentPdf(document) {
  const lines = documentLines(document); const perPage = 46; const pages = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  const objects = [null];
  const catalogId = objects.push('') - 1; const pagesId = objects.push('') - 1; const fontId = objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>') - 1;
  const pageIds = [];
  for (const pageLines of pages) {
    const commands = ['BT', '/F1 10 Tf', '50 790 Td'];
    pageLines.forEach((line, index) => { if (index) commands.push('0 -16 Td'); commands.push(`(${pdfEscape(line).slice(0, 180)}) Tj`); });
    commands.push('ET'); const stream = commands.join('\n');
    const contentId = objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`) - 1;
    const pageId = objects.push(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`) - 1;
    pageIds.push(pageId);
  }
  objects[catalogId] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let output = '%PDF-1.4\n'; const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) { offsets[id] = Buffer.byteLength(output); output += `${id} 0 obj\n${objects[id]}\nendobj\n`; }
  const xref = Buffer.byteLength(output); output += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) output += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, 'binary');
}

export async function backfillBusinessDocuments({ limit = 0 } = {}) {
  const max = Math.max(0, Number(limit || 0)); let processed = 0; const counts = { quotations: 0, purchaseOrders: 0, invoices: 0, deliveryNotes: 0, skippedQuotationHistory: 0 };
  for await (const quote of QuoteRequest.find({ offeredTotalMinor: { $gt: 0 } }).sort({ createdAt: 1 }).cursor()) {
    if (max && processed >= max) break; processed += 1;
    if (!Number(quote.revision || 0)) {
      await QuoteRequest.collection.updateOne({ _id: quote._id, $or: [{ revision: { $exists: false } }, { revision: 0 }] }, { $set: { revision: 1 } });
      quote.revision = 1;
      counts.skippedQuotationHistory += 1;
    }
    const revision = Math.max(1, Number(quote.revision || 1));
    if (!await BusinessDocument.exists({ eventKey: `quotation:${quote.publicId}:r${revision}` })) { await issueQuotationDocument(quote, { legacySnapshot: true }); counts.quotations += 1; }
  }
  for await (const po of PurchaseOrder.find({}).sort({ createdAt: 1 }).cursor()) {
    if (max && processed >= max) break; processed += 1;
    if (!await BusinessDocument.exists({ eventKey: `purchase_order:${po.publicId}` })) { await issuePurchaseOrderDocument(po, { legacySnapshot: true }); counts.purchaseOrders += 1; }
  }
  for await (const invoice of BusinessInvoice.find({}).sort({ createdAt: 1 }).cursor()) {
    if (max && processed >= max) break; processed += 1;
    if (!await BusinessDocument.exists({ eventKey: `tax_invoice:${invoice.publicId}` })) { await issueTaxInvoiceDocument(invoice, { legacySnapshot: true }); counts.invoices += 1; }
    if (invoice.deliveredAt && !await BusinessDocument.exists({ eventKey: `delivery_note:${invoice.orderPublicId}` })) {
      const [order, po, shipment] = await Promise.all([Order.findById(invoice.orderId), PurchaseOrder.findById(invoice.purchaseOrderId), Shipment.findOne({ orderId: invoice.orderId, kind: 'outbound', status: 'delivered' })]);
      if (order) { await issueDeliveryNoteDocument({ order, invoice, purchaseOrder: po, shipment, legacySnapshot: true }); counts.deliveryNotes += 1; }
    }
  }
  return { processed, ...counts };
}

import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { decryptSensitive, decryptPrivateBuffer } from '../core/sensitive.js';
import { DeliveryException, DeliveryOffer, DeliveryProfile, EvidenceDocument, LedgerAccount, Order, Payout, PayoutAccount, Shipment, User, Warehouse } from '../models/index.js';
import { deliveryAccess, deliveryVersion } from './delivery-workspace-access.js';
import { assertWarehouseAccess } from './warehouse-operations.js';
import { deliveryEvidenceFor, shipmentSource } from './delivery-source.js';
import { accountBalanceMinor } from './money.js';
import { prepareVerificationDocument } from './media.js';
import { deleteMediaObject, readMediaObject } from './object-storage.js';
import { acceptDeliveryOffer, canTransitionShipment, ensureShipmentForOrder, offerShipment, recordCodHandover, resolveDeliveryException, transitionShipment } from './logistics.js';
import { cursorScope, cursorSort, decodeCursor, encodeCursor, pageResult } from './pagination.js';
import { writeAudit } from './audit.js';

const TRANSPORTS = ['bicycle', 'motorcycle', 'car', 'van', 'truck', 'other'];
const STATUSES = ['assigned', 'picked_up', 'in_transit', 'failed', 'rescheduled', 'return_to_sender', 'delivered', 'returned'];
const same = (a, b) => String(a || '') === String(b || '');
const fail = (message, code = 'DELIVERY_INPUT_INVALID') => { throw new AppError(message, 422, code); };
function text(value, limit, fallback = '') { if (value !== undefined && typeof value !== 'string') fail('Enter valid text.'); const result = String(value ?? fallback).trim(); if (result.length > limit) fail('The entered text is too long.'); return result; }
function id(value) { const result = text(value, 100); if (!/^[a-z][a-z0-9_-]{4,99}$/.test(result)) fail('Choose a valid record.'); return result; }
function integer(value) { if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) fail('Enter a whole non-negative amount.'); return Number(value); }
function cursor(query) { const after = text(query?.after, 512); if (after && !decodeCursor(after)) fail('Reload this list to continue.', 'DELIVERY_CURSOR_INVALID'); return after; }
function profileView(row) { return row ? { publicId: row.publicId, version: Number(row.__v || 0), transport: row.transport, vehicleLabel: row.vehicleLabel, serviceAreas: row.serviceAreas, verificationStatus: row.verificationStatus, available: row.available, codEnabled: row.codEnabled, reviewReason: row.reviewReason, submittedAt: row.submittedAt, reviewedAt: row.reviewedAt } : { publicId: '', version: 0, transport: 'bicycle', vehicleLabel: '', serviceAreas: [], verificationStatus: 'draft', available: false, codEnabled: false }; }
function shipmentView(row) { return { publicId: row.publicId, orderPublicId: row.orderPublicId, version: Number(row.__v || 0), kind: row.kind, country: row.country, status: row.status, mode: row.mode, parcelCount: row.parcelCount, assignedAt: row.assignedAt, pickedUpAt: row.pickedUpAt, deliveredAt: row.deliveredAt, slaDueAt: row.slaDueAt, rescheduledFor: row.rescheduledFor, failedReason: row.failedReason, proof: row.proof, cod: row.cod, timeline: row.timeline, actions: STATUSES.filter(status => canTransitionShipment(row.status, status) && (status !== 'picked_up' || !row.pickedUpAt) && (!['in_transit','delivered','return_to_sender','returned'].includes(status) || row.pickedUpAt)) }; }
async function transaction(callback) { const session = await mongoose.startSession(); try { let result; await session.withTransaction(async () => { result = await callback(session); }); return result; } finally { await session.endSession(); } }
async function audit(request, access, action, row, session, metadata = {}) { await writeAudit(request, action, { actor: access.actor, targetType: row instanceof DeliveryProfile ? 'delivery_profile' : 'shipment', targetPublicId: row.publicId, country: row.country, metadata, session }); }
const warehouseSignature = access => JSON.stringify({ user: String(access.actor._id), role: access.actor.role, token: access.actor.security.tokenVersion, grant: String(access.grant?._id || ''), scope: access.scope, countries: access.countries.map(row => [row.code,row.currency,row.timeZone]).sort() });
async function assertWarehouseReadAccess(request, original) { const current = await assertWarehouseAccess(request); if (warehouseSignature(current) !== warehouseSignature(original)) throw new AppError('Your Warehouse scope changed during this request.',403,'WAREHOUSE_SCOPE_CHANGED'); return current; }
async function ownShipment(request, access, session = null) { const row = await Shipment.findOne({ publicId: id(request.params.publicId), deliveryUserId: access.actor._id, country: access.market.code }).session(session); if (!row) throw new AppError('Assigned delivery not found.', 404, 'SHIPMENT_NOT_FOUND'); return row; }
async function verificationEvidence(profile, session = null) { return EvidenceDocument.find({ _id: { $in: profile.evidenceDocumentIds || [] }, ownerUserId: profile.userId, country: profile.country, contextType: 'delivery_verification', contextPublicId: profile.publicId, status: 'ready' }).select('publicId documentType description createdAt').session(session).lean(); }
function requireProfileEvidence(profile, evidence) { const types = new Set(evidence.map(row => row.documentType)); if (!types.has('identity')) fail('Upload your identity image before submitting.', 'DELIVERY_IDENTITY_REQUIRED'); if (profile.transport !== 'bicycle' && !types.has('permit') && !types.has('vehicle')) fail('Upload your vehicle or permit image before submitting.', 'DELIVERY_VEHICLE_DOCUMENT_REQUIRED'); }

export async function loadDeliveryPage(request, mode = 'overview') {
  if (!['overview', 'profile', 'offers', 'jobs', 'tracking', 'earnings'].includes(mode)) throw new AppError('Delivery page not found.', 404, 'DELIVERY_PAGE_NOT_FOUND');
  const access = await deliveryAccess(request), after = cursor(request.query);
  const base = { deliveryUserId: access.actor._id, country: access.market.code };
  const grouped = await Shipment.aggregate([{ $match: base }, { $group: { _id: '$status', count: { $sum: 1 } } }]);
  const counts = Object.fromEntries(grouped.map(row => [row._id, row.count]));
  const flow = { mode, country: access.market.code, currency: access.market.currency, profile: profileView(access.profile), transports: TRANSPORTS,
    filters: { after }, summary: { active: STATUSES.filter(status => !['delivered', 'returned'].includes(status)).reduce((n, status) => n + Number(counts[status] || 0), 0), delivered: counts.delivered || 0, exceptions: await DeliveryException.countDocuments({ ...base, status: { $in: ['open', 'investigating'] } }), offers: await DeliveryOffer.countDocuments({ ...base, status: 'offered', expiresAt: { $gt: new Date() } }) }, offers: [], jobs: [], evidence: [], page: { hasMore: false, next: '', total: 0 } };
  if (mode === 'profile' && access.profile) flow.evidence = await verificationEvidence(access.profile);
  if (mode === 'offers' || mode === 'overview') {
    const filter = { ...base, status: 'offered', expiresAt: { $gt: new Date() } };
    const [rows, total] = await Promise.all([DeliveryOffer.find(cursorScope(filter, after)).populate('shipmentId', 'publicId orderPublicId country status kind mode parcelCount cod.currency cod.required').sort(cursorSort()).limit(26).lean(), DeliveryOffer.countDocuments(filter)]);
    const page = pageResult(rows, { limit: 25, total }); flow.page = page.page;
    flow.offers = page.items.filter(row => row.shipmentId && row.shipmentId.publicId === row.shipmentPublicId && row.shipmentId.country === row.country && row.shipmentId.status === 'offered').map(row => ({ publicId: row.publicId, version: row.__v || 0, shipmentPublicId: row.shipmentPublicId, orderPublicId: row.shipmentId.orderPublicId, kind: row.shipmentId.kind, mode: row.shipmentId.mode, parcelCount: row.shipmentId.parcelCount, codRequired: row.shipmentId.cod.required, earningMinor: row.earningMinor, currency: row.currency, expiresAt: row.expiresAt, canAccept: access.profile?.verificationStatus === 'approved' && access.profile.available && (!row.shipmentId.cod.required || access.profile.codEnabled) }));
  }
  if (['jobs', 'tracking', 'overview'].includes(mode)) {
    const status = text(request.query?.status, 30); if (status && !STATUSES.includes(status)) fail('Choose a valid delivery status.'); flow.filters.status = status;
    const filter = { ...base, ...(status ? { status } : mode === 'overview' ? { status: { $nin: ['delivered', 'returned', 'cancelled'] } } : {}) };
    const [rows, total] = await Promise.all([Shipment.find(cursorScope(filter, after)).sort(cursorSort()).limit(26).lean(), Shipment.countDocuments(filter)]);
    const page = pageResult(rows, { limit: 25, total }); flow.jobs = page.items.map(shipmentView); flow.page = page.page;
    const record = text(request.query?.record, 100);
    if (record) {
      const row = await Shipment.findOne({ publicId: id(record), ...base }).lean(); if (!row) throw new AppError('Assigned delivery not found.', 404, 'SHIPMENT_NOT_FOUND');
      const source = await shipmentSource(row); const selected = shipmentView(row);
      selected.evidence = await deliveryEvidenceFor(row); selected.exceptions = await DeliveryException.find({ shipmentId: row._id, shipmentPublicId: row.publicId, ...base }).select('publicId type reasonCode description status resolutionNote evidenceRequired evidenceDocumentIds createdAt').sort({ createdAt: -1, _id: -1 }).limit(25).lean();
      // Contact data is disclosed only after assignment to its current carrier.
      selected.contact = source.order.contact; selected.pickupLocations = source.warehouses.map(({ name, city, address }) => ({ name, city, address }));
      selected.items = (source.returned?.items || source.order.items).map(({ title, sku, quantity }) => ({ title, sku, quantity }));
      flow.selected = selected;
    }
  }
  if (mode === 'earnings') {
    const account = await LedgerAccount.findOne({ ownerType: 'delivery', ownerPublicId: String(access.actor._id), country: access.market.code, currency: access.market.currency, code: 'delivery_payable', active: true }).lean();
    const accounts = await PayoutAccount.find({ ownerUserId: access.actor._id, ownerType: 'delivery', country: access.market.code, currency: access.market.currency }).select('publicId method label status verifiedAt').sort(cursorSort()).limit(100).lean();
    const ids = await PayoutAccount.find({ ownerUserId: access.actor._id, ownerType: 'delivery', country: access.market.code, currency: access.market.currency }).distinct('_id');
    const filter = { ownerUserId: access.actor._id, payoutAccountId: { $in: ids }, currency: access.market.currency, ownerStoreId: { $exists: false } };
    const [rows, total] = await Promise.all([Payout.find(cursorScope(filter, after)).select('publicId amountMinor currency status requestedAt completedAt createdAt').sort(cursorSort()).limit(26).lean(), Payout.countDocuments(filter)]);
    const page = pageResult(rows, { limit: 25, total }); flow.earnings = { availableMinor: account ? await accountBalanceMinor(account._id) : 0, accounts, payouts: page.items }; flow.page = page.page;
  }
  const current = await deliveryAccess(request);
  if (current.market.code !== access.market.code || current.market.currency !== access.market.currency || current.market.timeZone !== access.market.timeZone || String(current.profile?._id || '') !== String(access.profile?._id || '') || current.profile?.verificationStatus !== access.profile?.verificationStatus) throw new AppError('Your delivery account changed during this request.',403,'DELIVERY_ACCESS_CHANGED');
  return flow;
}

export async function saveDeliveryProfile(request) {
  const body = request.body || {}, transport = text(body.transport, 20), vehicleLabel = text(body.vehicleLabel, 120);
  if (!TRANSPORTS.includes(transport)) fail('Choose a valid transport mode.');
  const serviceAreas = text(body.serviceAreas, 1800).split(',').map(value => value.trim()).filter(Boolean);
  if (serviceAreas.length > 30 || serviceAreas.some(value => value.length > 60)) fail('Use at most 30 service areas of up to 60 characters.');
  const action = text(body.action, 20, 'save'); if (!['save', 'submit'].includes(action)) fail('Choose save or submit.');
  if (action === 'submit' && !serviceAreas.length) fail('Choose at least one service area before submitting your profile.');
  return transaction(async session => {
    const access = await deliveryAccess(request, { session, write: true });
    let profile = access.profile; deliveryVersion(body.version, profile ? { __v: Number(profile.__v || 0) - 1 } : null);
    if (profile?.verificationStatus === 'suspended') throw new AppError('Contact support before editing a suspended carrier profile.', 409, 'DELIVERY_SUSPENDED');
    if (!profile) [profile] = await DeliveryProfile.create([{ publicId: publicId('dlp'), userId: access.actor._id, country: access.market.code, transport }], { session });
    profile.transport = transport; profile.vehicleLabel = vehicleLabel; profile.serviceAreas = [...new Set(serviceAreas)]; profile.available = false; profile.codEnabled = false; profile.verificationStatus = 'draft'; profile.approvedAt = null; profile.reviewedAt = null; profile.reviewedByUserId = null;
    if (action === 'submit') { requireProfileEvidence(profile, await verificationEvidence(profile, session)); profile.verificationStatus = 'submitted'; profile.submittedAt = new Date(); profile.submittedByUserId = access.actor._id; profile.reviewReason = ''; }
    await profile.save({ session }); await audit(request, access, 'delivery.profile_' + (action === 'submit' ? 'submitted' : 'saved'), profile, session); return profileView(profile);
  });
}

export async function setDeliveryAvailability(request) {
  if (!['true', 'false'].includes(String(request.body?.available))) fail('Choose available or unavailable.');
  return transaction(async session => { const access = await deliveryAccess(request, { session, write: true, approved: true }); const profile = access.profile;
    deliveryVersion(request.body.version, { __v: Number(profile.__v || 0) - 1 }); profile.available = String(request.body.available) === 'true'; await profile.save({ session }); await audit(request, access, 'delivery.availability_changed', profile, session, { available: profile.available }); return profileView(profile); });
}

/** Stored evidence is private, encrypted, sanitized raster content bound atomically to its source. */
export async function uploadDeliveryEvidence(request, { profile = false, cod = false } = {}) {
  const initial = await deliveryAccess(request, { approved: !profile });
  const source = profile ? initial.profile : await ownShipment(request, initial);
  if (!source) throw new AppError('Save your delivery profile before uploading evidence.', 409, 'DELIVERY_PROFILE_REQUIRED');
  deliveryVersion(request.body.version, source);
  const documentType = cod ? 'cod_handover' : text(request.body.documentType, 40);
  if (!(profile ? ['identity', 'vehicle', 'permit'] : ['delivery_photo', 'delivery_signature', 'failed_attempt', 'address_exception', 'cod_handover']).includes(documentType)) fail('Choose a valid evidence type.');
  if (profile && source.verificationStatus === 'suspended') throw new AppError('Contact support about suspended verification.', 409, 'DELIVERY_SUSPENDED');
  const prepared = await prepareVerificationDocument(request.file, source.publicId); let evidence;
  try {
    evidence = await transaction(async session => {
      const access = await deliveryAccess(request, { session, write: true, approved: !profile }); const current = profile ? access.profile : await ownShipment(request, access, session);
      deliveryVersion(request.body.version, profile ? { __v: Number(current.__v || 0) - 1 } : current);
      if (!profile && ['returned', 'cancelled'].includes(current.status)) throw new AppError('This delivery no longer accepts evidence.', 409, 'DELIVERY_EVIDENCE_STATE');
      const [document] = await EvidenceDocument.create([{ publicId: publicId('evd'), ownerUserId: access.actor._id, country: access.market.code, contextType: profile ? 'delivery_verification' : 'delivery_job', contextPublicId: current.publicId, documentType, storageKey: prepared.storageKey, mimeType: 'image/webp', size: prepared.sizeBytes, status: 'ready', description: text(request.body.description, 300, documentType) }], { session });
      if (profile) { current.evidenceDocumentIds.addToSet(document._id); current.verificationStatus = 'draft'; current.available = false; current.codEnabled = false; current.approvedAt = null; await current.save({ session }); }
      else {
        current.timeline.push({ type: 'evidence_uploaded', message: `Private ${documentType.replaceAll('_', ' ')} recorded.`, actorUserId: access.actor._id }); await current.save({ session });
        if (['failed_attempt', 'address_exception'].includes(documentType)) await DeliveryException.updateMany({ shipmentId: current._id, deliveryUserId: access.actor._id, country: current.country, type: documentType === 'address_exception' ? 'address_exception' : 'failed_delivery', status: { $in: ['open', 'investigating'] } }, { $addToSet: { evidenceDocumentIds: document._id } }, { session });
      }
      await audit(request, access, 'delivery.evidence_uploaded', current, session, { evidencePublicId: document.publicId, documentType }); return document;
    });
  } catch (error) { await deleteMediaObject(prepared.storageKey).catch(() => {}); throw error; }
  if (cod) { const fresh = await Shipment.findById(source._id); await recordCodHandover({ shipment: fresh, request, version: fresh.__v || 0, actorUserId: initial.actor._id, declaredAmountMinor: integer(request.body.declaredAmountMinor), evidenceDocumentId: evidence._id }); }
  return { publicId: evidence.publicId };
}

export async function respondDeliveryOffer(request, decision = 'accept') {
  const access = await deliveryAccess(request, { approved: true, available: true }); const offer = await DeliveryOffer.findOne({ publicId: id(request.params.publicId), deliveryUserId: access.actor._id, country: access.market.code });
  if (!offer) throw new AppError('Offer not found.', 404, 'OFFER_NOT_FOUND');
  if (decision === 'accept') return acceptDeliveryOffer({ offer, actorUserId: access.actor._id, request, version: request.body.version });
  return transaction(async session => { const currentAccess = await deliveryAccess(request, { session, write: true, approved: true }); const current = await DeliveryOffer.findOne({ _id: offer._id, deliveryUserId: currentAccess.actor._id, country: currentAccess.market.code, status: 'offered', expiresAt: { $gt: new Date() } }).session(session);
    if (!current) throw new AppError('This offer is no longer available.', 409, 'OFFER_UNAVAILABLE'); deliveryVersion(request.body.version, current); current.status = 'declined'; current.respondedAt = new Date(); await current.save({ session }); await writeAudit(request, 'delivery.offer_declined', { targetType: 'delivery_offer', targetPublicId: current.publicId, country: current.country, session }); return { publicId: current.publicId }; });
}

export async function advanceDelivery(request, status) {
  if (!STATUSES.includes(status)) fail('Choose a valid delivery action.'); const access = await deliveryAccess(request, { approved: true }); const shipment = await ownShipment(request, access);
  return transitionShipment({ shipment, actorUserId: access.actor._id, request, version: request.body.version, nextStatus: status, proofCode: text(request.body.proofCode, 6), reason: text(request.body.reason, 240), reasonCode: text(request.body.reasonCode, 40, 'other'), rescheduledFor: request.body.rescheduledFor });
}

export async function loadWarehouseDeliveryPage(request, mode = 'deliveries') {
  const access = await assertWarehouseAccess(request), after = cursor(request.query), warehouses = await Warehouse.find(access.scope).select('publicId name country').limit(501).lean();
  if (warehouses.length > 500) fail('Select a narrower warehouse assignment.'); const countries = [...new Set(warehouses.map(row => row.country))];
  const flow = { mode, filters: { after }, warehouses, carriers: [], shipments: [], page: { hasMore: false, next: '', total: 0 } };
  if (mode === 'carriers') {
    const status = text(request.query?.status, 30, 'submitted'); if (!['draft', 'submitted', 'approved', 'rejected', 'suspended'].includes(status)) fail('Choose a valid verification status.'); flow.filters.status = status;
    const base = { country: { $in: countries }, verificationStatus: status };
    const [rows, total] = await Promise.all([DeliveryProfile.find(cursorScope(base, after)).populate('userId', 'publicId name email role status country').sort(cursorSort()).limit(26).lean(), DeliveryProfile.countDocuments(base)]);
    const page = pageResult(rows, { limit: 25, total }); flow.carriers = page.items.filter(row => row.userId?.role === 'delivery' && row.userId.status === 'active' && row.userId.country === row.country).map(row => ({ ...profileView(row), name: row.userId.name, country: row.country })); flow.page = page.page;
    if (request.query?.record) { const row = await DeliveryProfile.findOne({ publicId: id(request.query.record), country: { $in: countries } }).populate('userId', 'publicId name role status country').lean(); if (!row || row.userId?.role !== 'delivery' || row.userId.status !== 'active' || row.userId.country !== row.country) throw new AppError('Carrier not found.', 404, 'DELIVERY_NOT_FOUND'); flow.selected = { ...profileView(row), name: row.userId.name, country: row.country, evidence: await verificationEvidence({ ...row, userId: row.userId._id }) }; }
  } else {
    const status = text(request.query?.status, 30); if (status && !['ready', 'offered', ...STATUSES].includes(status)) fail('Choose a valid shipment status.'); flow.filters.status = status;
    // Page candidates use immutable source joins; every disclosed row must pass the full allocation scope.
    const candidateScope = { country: { $in: countries }, ...(status ? { status } : {}) };
    const candidates = await Shipment.find(cursorScope(candidateScope, after)).sort(cursorSort()).limit(101).lean(); let last;
    for (const row of candidates) { last = row; try { await shipmentSource(row, { warehouseAccess: access }); flow.shipments.push(shipmentView(row)); } catch (error) { if (['WAREHOUSE_SCOPE', 'RETURN_PICKUP_UNAVAILABLE', 'DELIVERY_ALLOCATION_UNAVAILABLE'].includes(error.code)) continue; throw error; } if (flow.shipments.length === 25) break; }
    const hasMore = Boolean(last && (candidates.length > candidates.indexOf(last) + 1 || candidates.length === 101));
    flow.page = { hasMore, next: hasMore ? encodeCursor(last) : '', count: flow.shipments.length, total: null };
    if (request.query?.record) { const row = await Shipment.findOne({ publicId: id(request.query.record), country: { $in: countries } }).select('+pickupCodeEncrypted +deliveryCodeEncrypted').lean(); if (!row) throw new AppError('Shipment not found.', 404, 'SHIPMENT_NOT_FOUND'); const source = await shipmentSource(row, { warehouseAccess: access });
      flow.selected = { ...shipmentView(row), evidence: await deliveryEvidenceFor(row), exceptions: await DeliveryException.find({ shipmentId: row._id, shipmentPublicId: row.publicId, country: row.country }).select('publicId __v type reasonCode description status createdAt').sort(cursorSort()).limit(25).lean(), warehouses: source.warehouses.map(({ publicId, name }) => ({ publicId, name })), code: row.status === 'return_to_sender' || row.kind === 'return' && ['assigned', 'picked_up', 'in_transit', 'rescheduled'].includes(row.status) ? decryptSensitive(row.deliveryCodeEncrypted || '') : row.kind === 'outbound' && ['offered', 'assigned'].includes(row.status) ? decryptSensitive(row.pickupCodeEncrypted || '') : '', codePurpose: row.kind === 'return' || row.status === 'return_to_sender' ? 'Receiving code: give this only when the returned goods physically arrive.' : 'Collection code: give this only after every seller parcel is handed over.' };
      flow.availableCarriers = await DeliveryProfile.find({ country: row.country, verificationStatus: 'approved', available: true, ...(row.cod.required ? { codEnabled: true } : {}) }).populate('userId', 'name status role country').select('publicId userId transport').sort({ createdAt: 1 }).limit(100).lean();
    }
  }
  await assertWarehouseReadAccess(request, access); return flow;
}

export async function reviewDeliveryProfile(request) {
  const decision = text(request.body.decision, 20), reason = text(request.body.reason, 500);
  if (!['approve', 'reject', 'suspend'].includes(decision)) fail('Choose approve, reject or suspend.'); if (decision !== 'approve' && reason.length < 3) fail('Add a review reason.');
  return transaction(async session => { const access = await assertWarehouseAccess(request, { mutation: true, session }); const warehouses = await Warehouse.find(access.scope).select('country __v storeId').session(session).lean(); const countries = [...new Set(warehouses.map(row => row.country))];
    const profile = await DeliveryProfile.findOne({ publicId: id(request.params.publicId), country: { $in: countries } }).session(session); if (!profile) throw new AppError('Carrier not found in your warehouse market.', 404, 'DELIVERY_NOT_FOUND'); deliveryVersion(request.body.version, profile);
    if (same(profile.userId, access.actor._id) || same(profile.submittedByUserId, access.actor._id)) throw new AppError('A different Warehouse operator must review carrier verification.', 403, 'FOUR_EYES_REQUIRED');
    if (decision !== 'suspend' && profile.verificationStatus !== 'submitted') throw new AppError('Only submitted verification can be reviewed.', 409, 'DELIVERY_REVIEW_STATE');
    const carrier = await User.findOne({ _id: profile.userId, role: 'delivery', status: 'active', country: profile.country, platformAccessManagedAt: null }).session(session).lean();
    const market = access.countries.find(row => row.code === profile.country);
    if (!carrier || !market || carrier.currency !== market.currency) throw new AppError('Carrier account or market is unavailable.', 409, 'DELIVERY_ACTOR_INVALID');
    if (decision === 'approve') {
      const evidence = await verificationEvidence(profile, session); requireProfileEvidence(profile, evidence);
      for (const row of evidence) {
        const checked = await EvidenceDocument.updateOne({ _id: row._id, ownerUserId: profile.userId, country: profile.country, contextType: 'delivery_verification', contextPublicId: profile.publicId, status: 'ready' }, { $inc: { moderationEvidenceReadRevision: 1 } }, { session });
        if (checked.modifiedCount !== 1) throw new AppError('Carrier verification evidence changed. Reload before reviewing.',409,'DELIVERY_EVIDENCE_CHANGED');
      }
    }
    for (const warehouse of warehouses.filter(row => row.country === profile.country)) {
      const fenced = await Warehouse.updateOne({ _id: warehouse._id, __v: Number(warehouse.__v || 0), active: true,
        country: warehouse.country, storeId: warehouse.storeId }, { $inc: { __v: 1 } }, { session });
      if (fenced.modifiedCount !== 1) throw new AppError('Your Warehouse assignment changed. Reload before reviewing.', 409, 'WAREHOUSE_SCOPE_CHANGED');
    }
    const fencedCarrier = await User.updateOne({ _id: carrier._id, __v: carrier.__v || 0, role: 'delivery', status: 'active',
      country: profile.country, currency: carrier.currency, 'security.tokenVersion': carrier.security?.tokenVersion }, { $inc: { __v: 1 } }, { session });
    if (fencedCarrier.modifiedCount !== 1) throw new AppError('The carrier account changed. Reload before reviewing.', 409, 'DELIVERY_ACTOR_INVALID');
    profile.verificationStatus = decision === 'approve' ? 'approved' : decision === 'suspend' ? 'suspended' : 'rejected'; profile.available = false; profile.codEnabled = decision === 'approve' && String(request.body.codEnabled) === 'true'; profile.reviewReason = reason; profile.reviewedAt = new Date(); profile.reviewedByUserId = access.actor._id; profile.approvedAt = decision === 'approve' ? new Date() : null; await profile.save({ session }); await audit(request, access, 'warehouse.carrier_' + profile.verificationStatus, profile, session); return profileView(profile);
  });
}

export async function createDeliveryOffer(request) {
  const access = await assertWarehouseAccess(request); const shipment = await Shipment.findOne({ publicId: id(request.params.publicId) }); if (!shipment) throw new AppError('Shipment not found.', 404, 'SHIPMENT_NOT_FOUND'); await shipmentSource(shipment, { warehouseAccess: access });
  const carrier = await DeliveryProfile.findOne({ publicId: id(request.body.carrierPublicId), country: shipment.country, available: true, verificationStatus: 'approved' }); if (!carrier) throw new AppError('Approved available carrier not found.', 404, 'DELIVERY_NOT_FOUND');
  return offerShipment({ shipment, request, version: request.body.version, deliveryUserId: carrier.userId, earningMinor: integer(request.body.earningMinor), currency: text(request.body.currency, 3), actorUserId: access.actor._id });
}

/** Recovery uses current paid/authorized stock; it cannot ship an unpaid cart. */
export async function createWarehouseShipment(request) {
  return transaction(async session => {
    const access = await assertWarehouseAccess(request, { mutation: true, session });
    const order = await Order.findOne({ publicId: id(request.params.publicId) }).session(session);
    if (!order) throw new AppError('Order not found.', 404, 'ORDER_NOT_FOUND');
    deliveryVersion(request.body.version, order);
    if (!['none', 'rejected'].includes(order.cancellationState) || ['cancelled', 'expired', 'cancellation_pending'].includes(order.status)
      || !(['paid', 'partially_refunded'].includes(order.paymentState)
        || order.status === 'confirmed' && (order.paymentMethod === 'cod' && order.paymentState === 'pending'
          || order.paymentMethod === 'credit_terms' && order.paymentState === 'credit_due'))) {
      throw new AppError('The order is not ready for carrier fulfilment.', 409, 'ORDER_NOT_READY');
    }
    await shipmentSource({ orderId: order._id, orderPublicId: order.publicId, country: order.country, kind: 'outbound',
      cod: { currency: order.totals.currency } }, { session, warehouseAccess: access, write: true });
    const shipment = await ensureShipmentForOrder(order, access.actor._id, session);
    await audit(request, access, 'warehouse.shipment_ensured', shipment, session, { orderPublicId: order.publicId });
    return shipmentView(shipment);
  });
}

export async function reviewCodReceipt(request) {
  const reason = text(request.body.reason, 500); if (reason.length < 3) fail('Describe the physical cash receipt review.');
  return transaction(async session => { const access = await assertWarehouseAccess(request, { mutation: true, session }); const shipment = await Shipment.findOne({ publicId: id(request.params.publicId) }).session(session); if (!shipment) throw new AppError('Shipment not found.', 404, 'SHIPMENT_NOT_FOUND'); deliveryVersion(request.body.version, shipment); await shipmentSource(shipment, { session, warehouseAccess: access, write: true });
    if ([shipment.deliveryUserId, shipment.cod.handoverByUserId].some(value => same(value, access.actor._id))) throw new AppError('A different Warehouse operator must receive this cash.', 403, 'FOUR_EYES_REQUIRED');
    if (shipment.status !== 'delivered' || !shipment.cod.required || shipment.cod.reconciledAt || !shipment.cod.handoverAt || shipment.cod.mismatchExceptionPublicId || shipment.cod.handoverDeclaredMinor !== shipment.cod.collectedMinor) throw new AppError('Correct and resolve the recorded handover before reviewing its receipt.', 409, 'COD_REVIEW_NOT_READY');
    const evidence = await EvidenceDocument.findOne({ _id: shipment.cod.handoverEvidenceDocumentId, ownerUserId: shipment.deliveryUserId, country: shipment.country, contextType: 'delivery_job', contextPublicId: shipment.publicId, documentType: 'cod_handover', status: 'ready' }).session(session); if (!evidence) throw new AppError('The exact cash handover receipt is unavailable.', 409, 'COD_HANDOVER_REQUIRED');
    shipment.cod.reviewedAt = new Date(); shipment.cod.reviewedByUserId = access.actor._id; shipment.cod.reviewNote = reason; shipment.timeline.push({ type: 'cod.warehouse_received', message: 'Warehouse independently reviewed the physical cash receipt for Finance reconciliation.', actorUserId: access.actor._id }); await shipment.save({ session }); await audit(request, access, 'warehouse.cod_receipt_reviewed', shipment, session, { amountMinor: shipment.cod.collectedMinor, evidencePublicId: evidence.publicId }); return shipmentView(shipment);
  });
}

export async function closeDeliveryException(request) { return resolveDeliveryException({ exceptionPublicId: id(request.params.publicId), actorUserId: request.user._id, request, version: request.body.version, decision: text(request.body.decision, 20), resolutionNote: text(request.body.resolutionNote, 600) }); }

export async function deliveryEvidenceRecord(request, { warehouse = false, expectedStorageKey = '', auditRead = true } = {}) {
  const access = warehouse ? await assertWarehouseAccess(request) : await deliveryAccess(request);
  const row = await EvidenceDocument.findOne({ publicId: id(request.params.publicId), status: 'ready', contextType: { $in: ['delivery_verification', 'delivery_job'] } }).select('+storageKey').lean();
  if (!row || (expectedStorageKey && expectedStorageKey !== row.storageKey)) throw new AppError('Evidence not found.', 404, 'EVIDENCE_NOT_FOUND');
  if (!warehouse && (!same(row.ownerUserId, access.actor._id) || row.country !== access.market.code)) throw new AppError('Evidence is outside your delivery account.', 403, 'EVIDENCE_FORBIDDEN');
  if (row.contextType === 'delivery_verification') {
    const profile = await DeliveryProfile.findOne({ publicId: row.contextPublicId, userId: row.ownerUserId, country: row.country, evidenceDocumentIds: row._id }).lean(); if (!profile) throw new AppError('Carrier evidence source is unavailable.', 403, 'EVIDENCE_FORBIDDEN');
    if (warehouse && !await Warehouse.exists({ ...access.scope, country: row.country })) throw new AppError('Carrier evidence is outside your warehouse market.', 403, 'WAREHOUSE_SCOPE');
  } else {
    const shipment = await Shipment.findOne({ publicId: row.contextPublicId, country: row.country, deliveryUserId: row.ownerUserId }).lean(); if (!shipment) throw new AppError('Delivery evidence source is unavailable.', 403, 'EVIDENCE_FORBIDDEN'); if (warehouse) await shipmentSource(shipment, { warehouseAccess: access });
  }
  if (auditRead) await transaction(async session => { const fresh = warehouse ? await assertWarehouseAccess(request, { mutation: true, session }) : await deliveryAccess(request, { session, write: true }); await writeAudit(request, warehouse ? 'warehouse.delivery_evidence_viewed' : 'delivery.evidence_viewed', { actor: fresh.actor, targetType: 'evidence', targetPublicId: row.publicId, country: row.country, session }); });
  return row;
}

export async function deliveryEvidenceImage(request, { warehouse = false } = {}) {
  const row = await deliveryEvidenceRecord(request, { warehouse, auditRead: false }); const stored = await readMediaObject(row.storageKey);
  await deliveryEvidenceRecord(request, { warehouse, expectedStorageKey: row.storageKey });
  return row.storageKey.endsWith('.cmv') ? decryptPrivateBuffer(stored.body, row.storageKey) : stored.body;
}

import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { publicId } from '../core/ids.js';
import { env } from '../config/env.js';
import { hasPermission } from '../core/roles.js';
import { User, PlatformGrant, Warehouse, WarehouseTask, WarehouseWave, StockItem, InventoryDiscrepancy,
  Parcel, Store, OperationAction, Order, SellerOrder, Notification } from '../models/index.js';
import { operationalCountryScope, warehouseScopesFor } from './authorization.js';
import { createWarehouseTask, claimWarehouseTask, releaseWarehouseTask, executeWarehouseTask,
  createPickWave, releasePickWave, completeCycleCount, reviewInventoryDiscrepancy,
  warehouseParcelTaskRequirements } from './logistics.js';
import { writeAudit } from './audit.js';
import { refreshOrderLifecycle } from './order-state.js';
import { addOutboxEvent } from './outbox.js';
import { queueWebhookEvent } from './stage11.js';

const ROLES = ['warehouse', 'country_admin', 'super_admin'];
const same = (left, right) => String(left || '') === String(right || '');
const validId = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{4,99}$/.test(value);
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const pages = { receive: 'receiving', put_away: 'receiving', pick: 'picking', pack: 'packing', dispatch: 'dispatch',
  cycle_count: 'inventory', transfer: 'inventory', return_inspection: 'returns' };

function invalid(message) { throw new AppError(message, 422, 'WAREHOUSE_INPUT_INVALID'); }
function recordId(value) { if (!validId(value)) invalid('Choose a valid warehouse record.'); return value; }
function text(value, length) {
  if (value != null && typeof value !== 'string') invalid('Enter text in the required format.');
  const result = String(value || '').trim();
  if (result.length > length) invalid(`Text must be no longer than ${length} characters.`);
  return result;
}
function integer(value, min = 0, max = 2_000_000_000) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value.trim()))) invalid('Enter a whole number.');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) invalid('Enter a whole number in the allowed range.');
  return result;
}
function version(value) {
  if (value === undefined || value === null || value === '') throw new AppError('Reload this warehouse page before continuing.', 428, 'WAREHOUSE_VERSION_REQUIRED');
  return integer(value, 0, Number.MAX_SAFE_INTEGER);
}

/** Rebuild authorization from current database records, including for replayed actions. */
export async function assertWarehouseAccess(request, { mutation = false, session = null } = {}) {
  if (!request.user?._id) throw new AppError('Sign in to access warehouse operations.', 401, 'UNAUTHENTICATED');
  const actor = await User.findById(request.user._id)
    .select('publicId name role status country platformAccessManagedAt security.tokenVersion security.mfaEnabled +operationalCountries').session(session);
  if (!actor || actor.status !== 'active' || actor.security.tokenVersion !== request.user.security?.tokenVersion ||
    (request.session?.tokenVersion !== undefined && request.session.tokenVersion !== actor.security.tokenVersion)) {
    throw new AppError('Your account or session is unavailable.', 403, 'ACCOUNT_UNAVAILABLE');
  }
  const storedRole = actor.role;
  let grant = null;
  const now = new Date();
  if (actor.platformAccessManagedAt) {
    const grants = await PlatformGrant.find({ userId: actor._id, status: 'active', startsAt: { $lte: now }, expiresAt: { $gt: now } })
      .sort({ createdAt: -1 }).limit(2).session(session);
    if (grants.length > 1) throw new AppError('Multiple active platform grants require administrator review.', 403, 'PLATFORM_GRANT_CONFLICT');
    grant = grants[0] || null;
    actor.authorizationContext = { platformManaged: true, activePlatformGrants: grants };
    actor.role = grant?.role || 'customer';
  }
  if (!ROLES.includes(actor.role) && !hasPermission(actor, 'warehouse:manage')) throw new AppError('Warehouse operations access is required.', 403, 'WAREHOUSE_PERMISSION_DENIED');
  if (!env.auth.simpleLogin && env.security.privilegedMfaRequired && !actor.security.mfaEnabled) {
    throw new AppError('Enable multi-factor authentication before using warehouse operations.', 403, 'MFA_ENROLLMENT_REQUIRED');
  }
  const warehouseScopes = grant?.warehouseScopes?.length ? [...grant.warehouseScopes] : warehouseScopesFor(actor);
  const scope = { active: true, ...operationalCountryScope(actor), ...(warehouseScopes.length ? { publicId: { $in: warehouseScopes } } : {}) };
  if (mutation) {
    if (!session) throw new AppError('Warehouse writes require a transaction.', 500, 'WAREHOUSE_TRANSACTION_REQUIRED');
    const accountFence = await User.updateOne({ _id: actor._id, status: 'active', role: storedRole, 'security.tokenVersion': actor.security.tokenVersion },
      { $inc: { __v: 1 } }, { session });
    if (accountFence.matchedCount !== 1) throw new AppError('Your access changed. Reload before continuing.', 403, 'ACCOUNT_UNAVAILABLE');
    if (grant) {
      const grantFence = await PlatformGrant.updateOne({ _id: grant._id, status: 'active', role: grant.role,
        startsAt: { $lte: now }, expiresAt: { $gt: now } }, { $inc: { __v: 1 } }, { session });
      if (grantFence.matchedCount !== 1) throw new AppError('Your warehouse grant is unavailable.', 403, 'WAREHOUSE_PERMISSION_DENIED');
    }
  }
  return { actor, grant, scope, supervisor: ['country_admin', 'super_admin'].includes(actor.role) };
}

async function warehouseFor(access, publicIdValue, session) {
  const warehouse = await Warehouse.findOne({ $and: [access.scope, { publicId: recordId(publicIdValue) }] }).session(session);
  if (!warehouse) throw new AppError('Warehouse not found in your active scope.', 404, 'WAREHOUSE_NOT_FOUND');
  return warehouse;
}
async function warehouseById(access, id, session) {
  const warehouse = await Warehouse.findOne({ ...access.scope, _id: id }).session(session);
  if (!warehouse) throw new AppError('Warehouse record not found in your active scope.', 404, 'WAREHOUSE_NOT_FOUND');
  return warehouse;
}
async function fence(model, row, expectedVersion, session) {
  const query = { _id: row._id };
  if (expectedVersion === 0 && row.__v === undefined) query.$or = [{ __v: 0 }, { __v: { $exists: false } }];
  else query.__v = expectedVersion;
  const result = await model.updateOne(query, { $inc: { __v: 1 } }, { session });
  if (result.matchedCount !== 1) throw new AppError('This record changed. Reload the page and try again.', 409, 'WAREHOUSE_VERSION_CONFLICT');
}
async function fenceWarehouse(warehouse, session) {
  await fence(Warehouse, warehouse, Number(warehouse.__v || 0), session);
}

function inputFor(request, action) {
  const body = request.body || {};
  const input = { action, publicId: request.params?.publicId || body.publicId || '', version: version(body.version), actionKey: text(body.actionKey, 120) };
  if (!['create-task', 'claim', 'release', 'execute', 'create-wave', 'release-wave', 'cycle-count', 'review-discrepancy'].includes(action)) invalid('Choose a valid warehouse action.');
  if (['create-task', 'create-wave', 'cycle-count'].includes(action) && !input.actionKey) invalid('Reload the form to obtain an action key.');
  if (input.actionKey && !/^[A-Za-z0-9._:-]{8,120}$/.test(input.actionKey)) invalid('Reload the form to obtain a valid action key.');
  if (['create-task', 'create-wave'].includes(action)) input.warehousePublicId = recordId(body.warehousePublicId);
  else input.publicId = recordId(input.publicId || body.stockPublicId);
  if (action === 'create-task') {
    input.type = text(body.type, 30);
    if (!['receive', 'put_away', 'transfer', 'pick', 'pack', 'dispatch'].includes(input.type)) invalid('Choose a supported task type. Record physical counts using the immediate stock-count form; return inspections are generated from received returns.');
    if (['pick', 'pack', 'dispatch'].includes(input.type)) input.parcelPublicId = recordId(body.parcelPublicId);
    else {
      input.stockPublicId = recordId(body.stockPublicId);
      input.quantity = integer(body.quantity === undefined || body.quantity === '' ? 0 : body.quantity,
        ['receive', 'transfer'].includes(input.type) ? 1 : 0);
      input.binCode = text(body.binCode, 80);
      if (input.type === 'put_away' && !input.binCode) invalid('Enter the destination bin.');
      if (input.type === 'transfer') input.destinationWarehousePublicId = recordId(body.destinationWarehousePublicId);
    }
    input.reference = text(body.reference, 120); input.notes = text(body.notes, 500);
  }
  if (action === 'execute') {
    if (body.quantity !== undefined) input.quantity = integer(body.quantity);
    if (body.binCode !== undefined) input.binCode = text(body.binCode, 80);
    input.disposition = text(body.disposition, 30);
    if (input.disposition && !['good', 'damaged', 'quarantine'].includes(input.disposition)) invalid('Choose a valid stock disposition.');
  }
  if (action === 'create-wave') input.batchSize = integer(body.batchSize || 20, 2, 50);
  if (action === 'cycle-count') { input.countedOnHand = integer(body.countedOnHand); input.notes = text(body.notes || body.reason || 'Cycle count', 300); }
  if (action === 'review-discrepancy') {
    input.decision = text(body.decision, 20); input.reviewNote = text(body.reviewNote, 300);
    if (!['approve', 'reject'].includes(input.decision)) invalid('Choose approve or reject.');
  }
  return input;
}

async function targetFor(access, input, session) {
  if (['create-task', 'create-wave'].includes(input.action)) return { warehouse: await warehouseFor(access, input.warehousePublicId, session) };
  const model = input.action === 'cycle-count' ? StockItem : input.action === 'review-discrepancy' ? InventoryDiscrepancy :
    input.action === 'release-wave' ? WarehouseWave : WarehouseTask;
  const row = await model.findOne({ publicId: input.publicId }).session(session);
  if (!row) throw new AppError('Warehouse record not found.', 404, 'WAREHOUSE_RECORD_NOT_FOUND');
  const warehouse = await warehouseById(access, row.warehouseId, session);
  if (!same(row.storeId, warehouse.storeId)) throw new AppError('Warehouse record not found.', 404, 'WAREHOUSE_RECORD_NOT_FOUND');
  return { row, model, warehouse };
}

async function createTask(access, warehouse, input, session) {
  const data = { warehouseId: warehouse._id, storeId: warehouse.storeId, type: input.type,
    reference: input.reference, notes: input.notes };
  if (['pick', 'pack', 'dispatch'].includes(input.type)) {
    const store = await Store.findById(warehouse.storeId).select('publicId __v status country').session(session);
    if (!store || store.status !== 'verified' || store.country !== warehouse.country) throw new AppError('This warehouse store is unavailable.', 409, 'WAREHOUSE_STORE_UNAVAILABLE');
    await fence(Store, store, Number(store.__v || 0), session);
    const parcel = await Parcel.findOne({ publicId: input.parcelPublicId, storePublicId: store.publicId }).session(session);
    if (!parcel) throw new AppError('Parcel not found in this warehouse store.', 404, 'WAREHOUSE_PARCEL_NOT_FOUND');
    const requirements = await warehouseParcelTaskRequirements({ parcel, warehouse, session });
    const quantity = requirements.pickQuantity ?? requirements.remainingQuantity ?? requirements.quantity ?? 0;
    if (input.type === 'pick' && (!requirements.canPick || quantity <= 0)) throw new AppError('This parcel has no remaining committed picks in this warehouse.', 409, 'WAREHOUSE_PARCEL_STATE');
    if (input.type === 'pack' && !requirements.canPack) throw new AppError('Complete every required pick before packing at an eligible warehouse.', 409, 'WAREHOUSE_PARCEL_STATE');
    if (input.type === 'dispatch' && !requirements.canDispatch) throw new AppError('Dispatch must use the warehouse that completed packing.', 409, 'WAREHOUSE_PARCEL_STATE');
    const root = await Order.findById(requirements.orderId).session(session);
    if (!root) throw new AppError('This parcel order is unavailable.', 409, 'WAREHOUSE_PARCEL_STATE');
    await fence(Order, root, Number(root.__v || 0), session);
    await fence(Parcel, requirements.parcel, Number(requirements.parcel.__v || 0), session);
    const activeTask = await WarehouseTask.findOne({ parcelId: parcel._id, type: input.type, status: { $in: ['open', 'in_progress'] },
      ...(input.type === 'pick' ? { warehouseId: warehouse._id } : {}) }).session(session);
    if (activeTask) {
      if (!same(activeTask.warehouseId, warehouse._id)) throw new AppError('Preparation is already queued at another warehouse. Complete it at the queued location.', 409, 'WAREHOUSE_TASK_ALREADY_QUEUED');
      if (input.type === 'pick' && activeTask.quantity > 0 && activeTask.quantity !== requirements.pickQuantity) {
        throw new AppError('The queued pick quantity requires reconciliation before new preparation can be scheduled.', 409, 'WAREHOUSE_PARCEL_STATE');
      }
      return activeTask;
    }
    const sourceKey = 'warehouse-parcel:' + digest(parcel.publicId + ':' + warehouse.publicId + ':' + input.type);
    const existing = await WarehouseTask.findOne({ sourceKey }).session(session);
    if (existing) return existing;
    Object.assign(data, { sourceKey, parcelId: parcel._id, shipmentId: parcel.shipmentId,
      orderId: requirements.orderId, quantity: input.type === 'pick' ? quantity : 0 });
  } else {
    const stock = await StockItem.findOne({ publicId: input.stockPublicId, warehouseId: warehouse._id, storeId: warehouse.storeId }).session(session);
    if (!stock) throw new AppError('Stock not found in the selected warehouse.', 404, 'WAREHOUSE_STOCK_NOT_FOUND');
    Object.assign(data, { stockItemId: stock._id, variantId: stock.variantId, quantity: input.quantity, binCode: input.binCode,
      sourceKey: 'warehouse-action:' + digest(access.actor.publicId + ':' + input.actionKey) });
    if (input.type === 'transfer') {
      const destination = await warehouseFor(access, input.destinationWarehousePublicId, session);
      if (same(destination._id, warehouse._id) || !same(destination.storeId, warehouse.storeId) || destination.country !== warehouse.country) {
        invalid('Choose a different warehouse in the same store and country.');
      }
      await fenceWarehouse(destination, session); data.destinationWarehouseId = destination._id;
    }
  }
  return createWarehouseTask(data, session);
}

async function prepareTask(row, warehouse, session) {
  if (!['pick', 'pack', 'dispatch'].includes(row.type)) return false;
  const parcel = await Parcel.findById(row.parcelId).session(session);
  if (!parcel) throw new AppError('This task parcel is unavailable.', 409, 'WAREHOUSE_PARCEL_STATE');
  const requirements = await warehouseParcelTaskRequirements({ parcel, warehouse, session });
  if ((row.orderId && !same(row.orderId, requirements.orderId)) || (row.shipmentId && !same(row.shipmentId, requirements.shipmentId))) {
    throw new AppError('This task has conflicting parcel links and requires reconciliation.', 409, 'WAREHOUSE_TASK_LINK_MISMATCH');
  }
  if (!requirements['can' + row.type[0].toUpperCase() + row.type.slice(1)] ||
    (row.type === 'pick' && row.quantity > 0 && row.quantity !== requirements.pickQuantity)) {
    throw new AppError('This task no longer matches the current committed warehouse preparation requirements.', 409, 'WAREHOUSE_PARCEL_STATE');
  }
  const root = await Order.findById(requirements.orderId).session(session);
  await fence(Order, root, Number(root.__v || 0), session);
  const store = await Store.findOne({ _id: row.storeId, status: 'verified', country: warehouse.country }).session(session);
  if (!store) throw new AppError('This task store is unavailable.', 409, 'WAREHOUSE_STORE_UNAVAILABLE');
  await fence(Store, store, Number(store.__v || 0), session);
  const repair = {};
  if (!row.orderId) repair.orderId = requirements.orderId;
  if (!row.shipmentId) repair.shipmentId = requirements.shipmentId;
  if (row.type === 'pick' && row.quantity === 0) repair.quantity = requirements.pickQuantity;
  if (Object.keys(repair).length) {
    await WarehouseTask.updateOne({ _id: row._id }, { $set: repair }, { session });
    Object.assign(row, repair);
  }
  return Object.keys(repair).length > 0;
}

async function syncFulfilment(task, access, session) {
  if (!['pick', 'pack', 'dispatch'].includes(task.type)) return;
  const parcel = await Parcel.findById(task.parcelId).session(session);
  const root = await Order.findById(task.orderId).session(session);
  const seller = await SellerOrder.findOne({ orderId: task.orderId, storeId: task.storeId, country: root?.country }).session(session);
  if (!parcel || !root || !seller || !['confirmed', 'processing', 'ready'].includes(seller.status)) {
    throw new AppError('This seller order requires fulfilment reconciliation.', 409, 'WAREHOUSE_SELLER_ORDER_STATE');
  }
  seller.status = task.type === 'dispatch' ? 'ready' : 'processing';
  seller.timeline.push({ type: 'warehouse.' + task.type, message: task.type === 'dispatch' ?
    'Warehouse completed preparation; parcel is ready for carrier pickup.' : 'Warehouse completed parcel ' + task.type + '.', at: new Date() });
  await seller.save({ session });
  await refreshOrderLifecycle(root._id, { session });
  if (task.type === 'dispatch' && root.userId) {
    const buyer = await User.findOne({ _id: root.userId, status: 'active' }).select('email emailVerifiedAt').session(session);
    if (buyer) {
      await Notification.create([{ publicId: publicId('ntf'), userId: buyer._id, country: root.country, type: 'order.fulfilment',
        title: 'Your order is ready for carrier pickup', body: 'Warehouse preparation is complete. Track your order for carrier pickup and delivery updates.',
        href: '/track-order?order=' + encodeURIComponent(root.publicId), importance: 'normal' }], { session });
      if (buyer.emailVerifiedAt) await addOutboxEvent({ type: 'seller.order_notification', aggregateType: 'seller_order', aggregatePublicId: seller.publicId,
        payload: { email: buyer.email, subject: 'Your Classic Mart order is ready for carrier pickup',
          body: 'Warehouse preparation is complete for order ' + root.publicId + '. Sign in to Classic Mart to view tracking. Carrier pickup and delivery have not yet been confirmed.' } }, session);
    }
  }
  await queueWebhookEvent({ storeId: task.storeId, eventType: 'order.updated', resourcePublicId: seller.publicId,
    payload: { status: seller.status, version: Number(seller.__v || 0), parcelStatus: parcel.status }, session,
    eventId: 'warehouse-order:' + seller.publicId + ':' + Number(seller.__v || 0) });
}

/** Every mutation, its audit, and its replay receipt commit or roll back together. */
export async function mutateWarehouse(request, action) {
  const input = inputFor(request, action);
  const inputHash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const access = await assertWarehouseAccess(request, { mutation: true, session });
      const { row, model, warehouse } = await targetFor(access, input, session);
      if (['claim', 'execute'].includes(action) && row?.type === 'cycle_count') {
        invalid('Queued physical counts are no longer accepted. Record a fresh count using the stock record’s immediate cycle-count form.');
      }
      // Replays retain the current scope checks for both ends of a transfer.
      if ((action === 'create-task' && input.type === 'transfer') || row?.type === 'transfer') {
        const destination = input.destinationWarehousePublicId ? await warehouseFor(access, input.destinationWarehousePublicId, session) :
          await warehouseById(access, row.destinationWarehouseId, session);
        if (same(destination._id, warehouse._id) || !same(destination.storeId, warehouse.storeId) || destination.country !== warehouse.country) {
          invalid('Transfer destination must remain in the same store and country.');
        }
      }
      if (input.actionKey) {
        const existing = await OperationAction.findOne({ userId: access.actor._id, clientActionId: input.actionKey }).session(session);
        if (existing) {
          if (existing.status !== 'completed' || existing.action !== `warehouse.${action}` || existing.result?.inputHash !== inputHash) {
            throw new AppError('This action key was already used for a different request.', 409, 'WAREHOUSE_ACTION_CONFLICT');
          }
          await writeAudit(request, 'warehouse.action_replayed', { session, targetType: 'warehouse_action', targetPublicId: existing.publicId,
            country: warehouse.country, metadata: { action, targetPublicId: existing.targetPublicId } });
          return { ...existing.result.response, duplicate: true };
        }
      }
      if (['create-task', 'create-wave'].includes(action)) await fence(Warehouse, warehouse, input.version, session);
      else { await fence(model, row, input.version, session); await fenceWarehouse(warehouse, session); }
      const legacyLinksRebound = ['claim', 'execute'].includes(action) ? await prepareTask(row, warehouse, session) : false;
      let result;
      if (action === 'create-task') result = await createTask(access, warehouse, input, session);
      if (action === 'claim') result = await claimWarehouseTask({ taskPublicId: row.publicId, actorUserId: access.actor._id, session });
      if (action === 'release') {
        if (row.wavePublicId) result = await releasePickWave({ wavePublicId: row.wavePublicId, actorUserId: access.actor._id, force: access.supervisor, session });
        else result = await releaseWarehouseTask({ taskPublicId: row.publicId, actorUserId: access.actor._id, force: access.supervisor, session });
      }
      if (action === 'execute') {
        if ((input.quantity !== undefined && input.quantity !== row.quantity) || (input.binCode !== undefined && input.binCode !== (row.binCode || ''))) {
          invalid('Task quantities and destination bins are authoritative. Reload this task before completing it.');
        }
        if (row.type === 'transfer') {
          const destination = await warehouseById(access, row.destinationWarehouseId, session);
          if (!same(destination.storeId, warehouse.storeId) || destination.country !== warehouse.country) invalid('Transfer destination scope changed.');
          await fenceWarehouse(destination, session);
        }
        result = await executeWarehouseTask({ task: row, actorUserId: access.actor._id, disposition: input.disposition, session });
        await syncFulfilment(result, access, session);
      }
      if (action === 'create-wave') result = await createPickWave({ warehouseId: warehouse._id, actorUserId: access.actor._id, batchSize: input.batchSize, session });
      if (action === 'release-wave') result = await releasePickWave({ wavePublicId: row.publicId, actorUserId: access.actor._id, force: access.supervisor, session });
      if (action === 'cycle-count') result = await completeCycleCount({ stockItem: await StockItem.findById(row._id).session(session), countedOnHand: input.countedOnHand,
        actorUserId: access.actor._id, reason: input.notes, sourceKey: 'warehouse-count:' + digest(access.actor.publicId + ':' + input.actionKey), session });
      if (action === 'review-discrepancy') {
        if (!access.supervisor) throw new AppError('A warehouse supervisor must review stock discrepancies.', 403, 'WAREHOUSE_REVIEW_FORBIDDEN');
        result = await reviewInventoryDiscrepancy({ discrepancyPublicId: row.publicId, decision: input.decision, actorUserId: access.actor._id,
          reviewNote: input.reviewNote, session });
      }
      const response = { publicId: result.publicId, version: Number(result.__v || 0), status: result.status,
        page: action === 'create-wave' || action === 'release-wave' || (action === 'release' && row?.wavePublicId) ? 'picking' :
          action === 'cycle-count' || action === 'review-discrepancy' ? 'inventory' : pages[input.type || row?.type] || 'overview', duplicate: false };
      await writeAudit(request, `warehouse.${action.replaceAll('-', '_')}`, { session, targetType: 'warehouse_operation',
        targetPublicId: result.publicId, country: warehouse.country, metadata: { warehousePublicId: warehouse.publicId, type: input.type || row?.type,
          legacyLinksRebound,
          supervisorRelease: access.supervisor && ['release', 'release-wave'].includes(action) && !same(row?.assignedUserId, access.actor._id) } });
      if (input.actionKey) await OperationAction.create([{ publicId: publicId('opa'), clientActionId: input.actionKey, userId: access.actor._id,
        country: warehouse.country, action: `warehouse.${action}`, targetPublicId: result.publicId, status: 'completed', result: { inputHash, response } }], { session });
      return response;
    });
  } finally { await session.endSession(); }
}

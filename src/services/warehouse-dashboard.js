import { AppError } from '../core/errors.js';
import { InventoryDiscrepancy, InventoryMovement, ProductVariant, StockItem, Warehouse, WarehouseTask,
  WarehouseWave, Parcel, Order, InventoryReservation, Store, Shipment, AuditLog } from '../models/index.js';
import { assertWarehouseAccess } from './warehouse-operations.js';
import { warehouseParcelOptions } from './warehouse-parcel-options.js';
import { cursorScope, cursorSort, decodeCursor, pageResult } from './pagination.js';
import { hashValue } from '../core/crypto.js';

const modes = ['overview', 'inventory', 'receiving', 'picking', 'packing', 'dispatch', 'returns', 'reports', 'settings'];
const types = { receiving: ['receive', 'put_away'], picking: ['pick'], packing: ['pack'], dispatch: ['dispatch'], returns: ['return_inspection'] };
const active = ['open', 'in_progress'];
const available = row => Math.max(0, Number(row.onHand || 0) - Number(row.reserved || 0) - Number(row.damaged || 0) - Number(row.quarantined || 0));
const label = value => String(value || '').replaceAll('_', ' ').replace(/^./, character => character.toUpperCase());
const same = (a, b) => String(a || '') === String(b || '');
const version = row => Number(row.__v || 0);
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stockProjection = 'publicId __v warehouseId variantId onHand reserved damaged quarantined binCode reorderPoint updatedAt';
const taskProjection = 'publicId __v warehouseId destinationWarehouseId stockItemId variantId parcelId returnRequestId quantity binCode disposition type status assignedUserId wavePublicId dueAt reference notes completedAt createdAt';

function filtersFor(query = {}) {
  for (const key of ['warehousePublicId', 'taskStatus', 'scanCode', 'mine', 'after', 'readyAfter', 'reviewAfter', 'from', 'to']) {
    if (query[key] !== undefined && typeof query[key] !== 'string') throw new AppError('Warehouse filters must contain text.', 422, 'WAREHOUSE_FILTER_INVALID');
  }
  const result = { warehousePublicId: String(query.warehousePublicId || '').trim(), taskStatus: String(query.taskStatus || ''),
    scanCode: String(query.scanCode || '').trim(), mine: String(query.mine || '') === '1', after: String(query.after || ''), readyAfter: String(query.readyAfter || ''),
    reviewAfter: String(query.reviewAfter || ''), from: String(query.from || ''), to: String(query.to || '') };
  if (result.warehousePublicId && !/^[a-z][a-z0-9_-]{4,99}$/.test(result.warehousePublicId)) throw new AppError('Choose a valid warehouse.', 422, 'WAREHOUSE_FILTER_INVALID');
  if (result.taskStatus === 'all') result.taskStatus = '';
  if (result.taskStatus && !['open', 'in_progress', 'completed', 'cancelled'].includes(result.taskStatus)) throw new AppError('Choose a valid task status.', 422, 'WAREHOUSE_FILTER_INVALID');
  if (result.scanCode.length > 100 || (result.after && !decodeCursor(result.after)) || (result.readyAfter && !decodeCursor(result.readyAfter)) ||
    (result.reviewAfter && !decodeCursor(result.reviewAfter))) {
    throw new AppError('This filter or cursor is invalid.', 422, 'WAREHOUSE_FILTER_INVALID');
  }
  for (const key of ['from', 'to']) {
    if (result[key] && (!/^\d{4}-\d{2}-\d{2}$/.test(result[key]) || !Number.isFinite(new Date(result[key]).getTime()) ||
      new Date(result[key]).toISOString().slice(0, 10) !== result[key])) throw new AppError('Use valid report dates in YYYY-MM-DD format.', 422, 'WAREHOUSE_FILTER_INVALID');
  }
  if (result.from && result.to && result.from > result.to) throw new AppError('The start date must be before the end date.', 422, 'WAREHOUSE_FILTER_INVALID');
  return result;
}
function movementScope(ids, filters) {
  const result = { warehouseId: { $in: ids } };
  if (filters.from || filters.to) {
    result.createdAt = {};
    if (filters.from) result.createdAt.$gte = new Date(filters.from + 'T00:00:00.000Z');
    if (filters.to) result.createdAt.$lt = new Date(new Date(filters.to + 'T00:00:00.000Z').getTime() + 86400_000);
  }
  return result;
}

async function scopeFor(request) {
  const access = await assertWarehouseAccess(request);
  const filters = filtersFor(request.query);
  const all = await Warehouse.find(access.scope).select('publicId __v storeId name country city address active').sort({ country: 1, name: 1 }).limit(501).lean();
  if (all.length > 500) throw new AppError('Select a narrower warehouse assignment before opening this workspace.', 422, 'WAREHOUSE_SCOPE_TOO_LARGE');
  if (filters.warehousePublicId && !all.some(row => row.publicId === filters.warehousePublicId)) throw new AppError('Warehouse not found in your scope.', 404, 'WAREHOUSE_NOT_FOUND');
  const selected = filters.warehousePublicId ? all.filter(row => row.publicId === filters.warehousePublicId) : all;
  return { access, filters, all, selected, ids: selected.map(row => row._id) };
}
function warehouseView(row) { return { publicId: row.publicId, version: version(row), name: row.name, country: row.country, city: row.city, address: row.address }; }
function stockView(row) {
  return { publicId: row.publicId, version: version(row), warehousePublicId: row.warehouseId?.publicId || '', warehouseName: row.warehouseId?.name || '',
    sku: row.variantId?.sku || '', title: row.variantId?.title || '', barcode: row.variantId?.barcode || '', onHand: row.onHand, reserved: row.reserved,
    damaged: row.damaged, quarantined: row.quarantined, available: available(row), binCode: row.binCode, reorderPoint: row.reorderPoint, updatedAt: row.updatedAt };
}
function taskView(row, access) {
  const mine = same(row.assignedUserId?._id || row.assignedUserId, access.actor._id);
  return { publicId: row.publicId, version: version(row), type: row.type, status: row.status, statusLabel: label(row.status), quantity: row.quantity,
    binCode: row.binCode, disposition: row.disposition, reference: row.reference, notes: row.notes, createdAt: row.createdAt, dueAt: row.dueAt,
    completedAt: row.completedAt, warehousePublicId: row.warehouseId?.publicId || '', warehouseName: row.warehouseId?.name || '',
    destinationWarehousePublicId: row.destinationWarehouseId?.publicId || '', destinationWarehouseName: row.destinationWarehouseId?.name || '',
    sku: row.variantId?.sku || '', title: row.variantId?.title || '', stockPublicId: row.stockItemId?.publicId || '', parcelPublicId: row.parcelId?.publicId || '',
    parcelBarcode: row.parcelId?.barcode || '', returnPublicId: row.returnRequestId?.publicId || '', wavePublicId: row.wavePublicId || '',
    parcelItems: row.type === 'pick' ? [] : (row.parcelId?.items || []).map(item => ({ sku: item.sku, title: item.title, quantity: item.quantity })),
    parcelQuantity: (row.parcelId?.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0),
    mine, assignedName: row.assignedUserId?.name || '', actions: { claim: row.status === 'open' && !row.assignedUserId,
      release: row.status === 'in_progress' && (mine || access.supervisor), execute: row.status === 'in_progress' && mine } };
}
function movementView(row) {
  return { publicId: row.publicId, warehousePublicId: row.warehouseId?.publicId || '', warehouseName: row.warehouseId?.name || '',
    country: row.warehouseId?.country || '', stockPublicId: row.stockItemId?.publicId || '', sku: row.variantId?.sku || '',
    type: row.type, quantity: row.quantity, onHandBefore: row.onHandBefore, onHandAfter: row.onHandAfter, reservedBefore: row.reservedBefore,
    reservedAfter: row.reservedAfter, damagedBefore: row.damagedBefore, damagedAfter: row.damagedAfter, quarantinedBefore: row.quarantinedBefore,
    quarantinedAfter: row.quarantinedAfter, binBefore: row.binBefore || '', binAfter: row.binAfter || '', reference: row.reference, reason: row.reason, actorName: row.actorUserId?.name || '', createdAt: row.createdAt };
}
function populateStock(query) { return query.populate('warehouseId', 'publicId name').populate('variantId', 'sku barcode title'); }
function populateTask(query) { return query.populate('warehouseId', 'publicId name').populate('destinationWarehouseId', 'publicId name')
  .populate('variantId', 'sku title').populate('stockItemId', 'publicId').populate('parcelId', 'publicId __v barcode shipmentId orderPublicId storePublicId status pickedQuantity items')
  .populate('returnRequestId', 'publicId').populate('assignedUserId', 'name'); }
function populateMovement(query) { return query.populate('warehouseId', 'publicId name country').populate('stockItemId', 'publicId')
  .populate('variantId', 'sku').populate('actorUserId', 'name'); }

async function scanScope(code, ids) {
  if (!code) return null;
  const stores = await Warehouse.find({ _id: { $in: ids } }).distinct('storeId');
  const pattern = new RegExp(escape(code), 'i');
  const variants = await ProductVariant.find({ storeId: { $in: stores }, $or: [{ sku: pattern }, { barcode: pattern }, { title: pattern }] }).select('_id').limit(1001).lean();
  if (variants.length > 1000) throw new AppError('Enter a more specific SKU or barcode.', 422, 'WAREHOUSE_SCAN_TOO_BROAD');
  return { $or: [{ publicId: pattern }, { variantId: { $in: variants.map(row => row._id) } }, { binCode: pattern }] };
}
async function parcelScan(code, stores) {
  if (!code) return null;
  const pattern = new RegExp(escape(code), 'i');
  const variants = await ProductVariant.find({ storeId: { $in: stores.map(row => row._id) }, $or: [{ sku: pattern }, { barcode: pattern }] }).select('publicId').limit(1001).lean();
  if (variants.length > 1000) throw new AppError('Enter a more specific SKU or barcode.', 422, 'WAREHOUSE_SCAN_TOO_BROAD');
  return { $or: [{ publicId: pattern }, { barcode: pattern }, { 'items.sku': pattern }, { 'items.variantPublicId': { $in: variants.map(row => row.publicId) } }] };
}

async function summaries(ids, actorId) {
  const scope = { warehouseId: { $in: ids } };
  const now = new Date(), since = new Date(now.getTime() - 30 * 86400_000);
  const [taskRows, stocks, discrepancyCount, waveRows, movementRows] = await Promise.all([
    WarehouseTask.aggregate([{ $match: scope }, { $facet: {
      summary: [{ $group: { _id: null, totalOpen: { $sum: { $cond: [{ $in: ['$status', active] }, 1, 0] } },
        mineOpen: { $sum: { $cond: [{ $and: [{ $in: ['$status', active] }, { $eq: ['$assignedUserId', actorId] }] }, 1, 0] } },
        overdueOpen: { $sum: { $cond: [{ $and: [{ $in: ['$status', active] }, { $eq: [{ $type: '$dueAt' }, 'date'] }, { $lt: ['$dueAt', now] }] }, 1, 0] } },
        completed30d: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'completed'] }, { $gte: ['$completedAt', since] }] }, 1, 0] } },
        returnInspections: { $sum: { $cond: [{ $and: [{ $eq: ['$type', 'return_inspection'] }, { $in: ['$status', active] }] }, 1, 0] } } } }],
      types: [{ $group: { _id: '$type', count: { $sum: 1 } } }], statuses: [{ $group: { _id: '$status', count: { $sum: 1 } } }] } }]),
    StockItem.aggregate([{ $match: scope }, { $set: { available: { $max: [0, { $subtract: ['$onHand', { $add: ['$reserved', '$damaged', '$quarantined'] }] }] } } },
      { $group: { _id: null, skuCount: { $sum: 1 }, onHandUnits: { $sum: '$onHand' }, availableUnits: { $sum: '$available' },
        reservedUnits: { $sum: '$reserved' }, damagedUnits: { $sum: '$damaged' }, quarantinedUnits: { $sum: '$quarantined' },
        lowStockCount: { $sum: { $cond: [{ $lte: ['$available', '$reorderPoint'] }, 1, 0] } } } }]),
    InventoryDiscrepancy.countDocuments({ ...scope, status: 'pending_review' }),
    WarehouseWave.aggregate([{ $match: scope }, { $group: { _id: '$status', count: { $sum: 1 }, tasks: { $sum: '$taskCount' } } }]),
    InventoryMovement.aggregate([{ $match: { ...scope, createdAt: { $gte: since } } }, { $group: { _id: '$type', count: { $sum: 1 }, quantity: { $sum: '$quantity' } } }]),
  ]);
  const task = taskRows[0] || {};
  const counts = rows => Object.fromEntries((rows || []).map(row => [row._id, Number(row.count || 0)]));
  const stock = stocks[0] || {}, taskSummary = task.summary?.[0] || {};
  return { summary: { warehouseCount: ids.length, totalOpen: taskSummary.totalOpen || 0, mineOpen: taskSummary.mineOpen || 0,
    overdueOpen: taskSummary.overdueOpen || 0, completed30d: taskSummary.completed30d || 0, skuCount: stock.skuCount || 0, onHandUnits: stock.onHandUnits || 0,
    availableUnits: stock.availableUnits || 0, reservedUnits: stock.reservedUnits || 0, damagedUnits: stock.damagedUnits || 0,
    quarantinedUnits: stock.quarantinedUnits || 0, lowStockCount: stock.lowStockCount || 0, pendingDiscrepancies: discrepancyCount,
    activeWaves: waveRows.find(row => row._id === 'in_progress')?.count || 0, returnInspections: taskSummary.returnInspections || 0 },
    reports: { taskCounts: counts(task.types), taskStatusCounts: counts(task.statuses),
      movementCounts: Object.fromEntries(movementRows.map(row => [row._id, { count: row.count, quantity: row.quantity }])),
      waveCounts: Object.fromEntries(waveRows.map(row => [row._id, { count: row.count, tasks: row.tasks }])) } };
}

async function readyParcels(scope, mode) {
  if (!['picking', 'packing', 'dispatch'].includes(mode) || !scope.ids.length) return { rows: [], page: { hasMore: false, next: '', count: 0, total: 0 } };
  const statuses = mode === 'picking' ? ['created', 'picking'] : mode === 'packing' ? ['picked'] : ['packed', 'handed_over'];
  const stores = await Store.find({ _id: { $in: scope.selected.map(row => row.storeId) }, status: 'verified' }).select('publicId').lean();
  const scan = await parcelScan(scope.filters.scanCode, stores);
  const match = cursorScope({ status: { $in: statuses }, storePublicId: { $in: stores.map(row => row.publicId) },
    ...(scan || {}) }, scope.filters.readyAfter);
  const rows = await Parcel.aggregate([{ $match: match }, { $sort: cursorSort() },
    { $lookup: { from: Order.collection.name, let: { order: '$orderPublicId', store: '$storePublicId' }, pipeline: [
      { $match: { $expr: { $eq: ['$publicId', '$$order'] }, status: { $in: ['confirmed', 'paid'] }, cancellationState: { $in: ['none', 'rejected'] }, refundState: 'none' } },
      { $project: { items: { $filter: { input: '$items', as: 'line', cond: { $eq: ['$$line.storePublicId', '$$store'] } } } } },
    ], as: 'root' } }, { $unwind: '$root' },
    { $lookup: { from: InventoryReservation.collection.name, localField: 'root.items.reservationPublicId', foreignField: 'publicId', as: 'reservations' } },
    { $lookup: { from: StockItem.collection.name, localField: 'reservations.stockItemId', foreignField: '_id', pipeline: [{ $match: { warehouseId: { $in: scope.ids } } }], as: 'scopedStock' } },
    { $match: { 'scopedStock.0': { $exists: true } } }, { $set: { scopedWarehouseIds: '$scopedStock.warehouseId' } },
    { $project: { root: 0, reservations: 0, scopedStock: 0, timeline: 0 } }, { $limit: 26 }]);
  const paged = pageResult(rows, { limit: 25 });
  const options = await warehouseParcelOptions({ parcels: paged.items, warehouses: scope.selected });
  const result = [];
  for (const parcel of paged.items) {
    const option = options.get(parcel.publicId);
    if (!option) continue;
    const current = option.parcel || parcel;
    result.push({ publicId: current.publicId, version: version(current), barcode: current.barcode, status: current.status,
      quantity: current.items.reduce((sum, row) => sum + Number(row.quantity || 0), 0), pickedQuantity: current.pickedQuantity,
      parcelItems: current.items.map(item => ({ sku: item.sku, title: item.title, quantity: item.quantity })),
      warehouseGroups: option.warehouseGroups, actions: option.actions, packWarehousePublicId: option.packWarehousePublicId, labelUrl: option.labelUrl });
  }
  return { rows: result, page: { ...paged.page, count: result.length } };
}

export async function loadWarehousePage(request, page = 'overview') {
  const mode = String(page).replace(/^warehouse-/, '');
  if (!modes.includes(mode)) throw new AppError('Warehouse page not found.', 404, 'WAREHOUSE_PAGE_NOT_FOUND');
  const scope = await scopeFor(request), base = { warehouseId: { $in: scope.ids } };
  const totals = await summaries(scope.ids, scope.access.actor._id);
  const selectedWarehouse = scope.filters.warehousePublicId ? scope.all.find(row => row.publicId === scope.filters.warehousePublicId) : scope.all.length === 1 ? scope.all[0] : null;
  const flow = { mode, warehouses: scope.all.map(warehouseView), filters: scope.filters,
    transferDestinations: selectedWarehouse ? scope.all.filter(row => !same(row._id, selectedWarehouse._id) && same(row.storeId, selectedWarehouse.storeId) && row.country === selectedWarehouse.country).map(warehouseView) : [],
    permissions: { supervisor: scope.access.supervisor, createTask: true, reviewDiscrepancy: scope.access.supervisor }, ...totals,
    page: { hasMore: false, next: '', count: 0, total: 0 }, tasks: [], inventory: [], stockOptions: [], discrepancies: [], waves: [], movements: [], scanResults: [],
    readyParcels: [], readyPage: { hasMore: false, next: '', count: 0, total: 0 }, reviewPage: { hasMore: false, next: '', count: 0, total: 0 },
    settings: { locations: scope.all.map(warehouseView), securityUrl: '/account/security' }, auxiliaryLimit: 25 };
  const stockScan = ['overview', 'inventory', 'receiving'].includes(mode) ? await scanScope(scope.filters.scanCode, scope.ids) : null;
  if (['inventory', 'receiving', 'overview'].includes(mode)) {
    const stockScope = stockScan ? { $and: [base, stockScan] } : base;
    const stockQuery = mode === 'inventory' ? cursorScope(stockScope, scope.filters.after, { field: 'updatedAt' }) : stockScope;
    const [rows, count] = await Promise.all([populateStock(StockItem.find(stockQuery).select(stockProjection)).sort(cursorSort('updatedAt')).limit(mode === 'inventory' ? 26 : 25).lean(), StockItem.countDocuments(stockScope)]);
    const paged = pageResult(rows, { field: 'updatedAt', limit: 25, total: count });
    flow.inventory = paged.items.map(stockView); flow.stockOptions = flow.inventory; flow.scanResults = stockScan ? flow.inventory : [];
    if (mode === 'inventory') flow.page = paged.page;
  }
  if (!['inventory', 'reports', 'settings'].includes(mode)) {
    const taskScope = { ...base, ...(types[mode] ? { type: { $in: types[mode] } } : {}),
      ...(scope.filters.taskStatus ? { status: scope.filters.taskStatus } : {}), ...(scope.filters.mine ? { assignedUserId: scope.access.actor._id } : {}) };
    if (scope.filters.scanCode) {
      const pattern = new RegExp(escape(scope.filters.scanCode), 'i');
      const stores = await Store.find({ _id: { $in: scope.selected.map(row => row.storeId) } }).select('publicId').lean();
      const scan = await parcelScan(scope.filters.scanCode, stores);
      const variants = await ProductVariant.find({ storeId: { $in: stores.map(row => row._id) }, $or: [{ sku: pattern }, { barcode: pattern }, { title: pattern }] }).select('_id').limit(1001).lean();
      if (variants.length > 1000) throw new AppError('Enter a more specific SKU or barcode.', 422, 'WAREHOUSE_SCAN_TOO_BROAD');
      const parcels = await Parcel.find({ ...scan, storePublicId: { $in: stores.map(row => row.publicId) } }).select('_id').limit(1001).lean();
      if (parcels.length > 1000) throw new AppError('Enter a more specific parcel barcode.', 422, 'WAREHOUSE_SCAN_TOO_BROAD');
      taskScope.$or = [{ publicId: pattern }, { reference: pattern }, { parcelId: { $in: parcels.map(row => row._id) } }, { variantId: { $in: variants.map(row => row._id) } }];
    }
    const [rows, count] = await Promise.all([populateTask(WarehouseTask.find(cursorScope(taskScope, scope.filters.after)).select(taskProjection)).sort(cursorSort()).limit(26).lean(), WarehouseTask.countDocuments(taskScope)]);
    const paged = pageResult(rows, { limit: 25, total: count }); flow.tasks = paged.items.map(row => taskView(row, scope.access)); flow.page = paged.page;
    const parcels = [...new Map(paged.items.filter(row => ['pick', 'pack', 'dispatch'].includes(row.type) && row.parcelId).map(row => [row.parcelId.publicId, row.parcelId])).values()];
    const options = await warehouseParcelOptions({ parcels, warehouses: scope.selected });
    for (let index = 0; index < flow.tasks.length; index += 1) {
      const task = flow.tasks[index], row = paged.items[index];
      if (task.type === 'cycle_count' && active.includes(task.status)) {
        task.blockedReason = 'Record a fresh physical count using the stock record’s immediate cycle-count form.';
        task.actions.claim = false; task.actions.execute = false;
      }
      if (!['pick', 'pack', 'dispatch'].includes(task.type)) continue;
      const option = options.get(task.parcelPublicId), group = option?.warehouseGroups.find(item => item.warehousePublicId === task.warehousePublicId);
      if (task.type === 'pick' && group) { task.parcelItems = group.parcelItems; task.manifestIsAllocation = true; task.partialPick = task.quantity < group.quantity; }
      if (active.includes(task.status) && (!group || (task.type === 'pick' && (!['created', 'picking'].includes(row.parcelId?.status) || group.remaining <= 0 ||
        (task.quantity > 0 && task.quantity !== group.remaining))) || (task.type === 'pack' && row.parcelId?.status !== 'picked') ||
        (task.type === 'dispatch' && (row.parcelId?.status !== 'packed' || option?.packWarehousePublicId !== task.warehousePublicId)))) {
        task.blockedReason = 'This task requires reconciliation with the current order and warehouse preparation state.';
        task.actions.claim = false; task.actions.execute = false;
      }
    }
  }
  if (['inventory', 'reports'].includes(mode)) {
    const discrepancyQuery = query => InventoryDiscrepancy.find(query).select('publicId __v warehouseId variantId expectedOnHand countedOnHand variance reason status stockVersionSnapshot countedAt countedByUserId reviewedByUserId reviewedAt reviewNote createdAt')
      .populate('warehouseId', 'publicId name').populate('variantId', 'sku title').populate('countedByUserId', 'name').populate('reviewedByUserId', 'name')
      .lean();
    const pendingCount = totals.summary.pendingDiscrepancies;
    const reviewScope = { ...base, status: pendingCount > 0 ? 'pending_review' : { $ne: 'pending_review' } };
    const direction = pendingCount > 0 ? 1 : -1;
    const [reviewRows, reviewCount] = await Promise.all([discrepancyQuery(cursorScope(reviewScope, scope.filters.reviewAfter, { direction })).sort(cursorSort('createdAt', direction)).limit(26),
      pendingCount > 0 ? Promise.resolve(pendingCount) : InventoryDiscrepancy.countDocuments(reviewScope)]);
    const review = pageResult(reviewRows, { limit: 25, direction, total: reviewCount });
    const rows = review.items; flow.reviewPage = { ...review.page, mode: pendingCount > 0 ? 'pending' : 'history' };
    flow.discrepancies = rows.map(row => ({ publicId: row.publicId, version: version(row), warehousePublicId: row.warehouseId?.publicId || '', warehouseName: row.warehouseId?.name || '',
      sku: row.variantId?.sku || '', title: row.variantId?.title || '', expectedOnHand: row.expectedOnHand, countedOnHand: row.countedOnHand, variance: row.variance,
      reason: row.reason, status: row.status, countedAt: row.countedAt, countedByName: row.countedByUserId?.name || '', reviewedAt: row.reviewedAt,
      reviewedByName: row.reviewedByUserId?.name || '', reviewNote: row.reviewNote,
      recountRequired: !Number.isSafeInteger(row.stockVersionSnapshot), canApprove: Number.isSafeInteger(row.stockVersionSnapshot) && scope.access.supervisor && row.status === 'pending_review' && !same(row.countedByUserId?._id, scope.access.actor._id),
      canReview: scope.access.supervisor && row.status === 'pending_review' && !same(row.countedByUserId?._id, scope.access.actor._id) }));
  }
  if (mode === 'picking' || mode === 'overview') {
    const waveQuery = query => WarehouseWave.find(query).select('publicId __v warehouseId status assignedUserId taskCount totalQuantity dueAt startedAt')
      .populate('warehouseId', 'publicId name').populate('assignedUserId', 'name').sort(cursorSort()).limit(25).lean();
    const pending = await waveQuery({ ...base, status: 'in_progress' });
    const history = pending.length < 25 ? await waveQuery({ ...base, status: { $ne: 'in_progress' } }).limit(25 - pending.length) : [];
    const rows = [...pending, ...history];
    flow.waves = rows.map(row => ({ publicId: row.publicId, version: version(row), warehousePublicId: row.warehouseId?.publicId || '', warehouseName: row.warehouseId?.name || '',
      status: row.status, taskCount: row.taskCount, totalQuantity: row.totalQuantity, dueAt: row.dueAt, startedAt: row.startedAt, assignedName: row.assignedUserId?.name || '',
      mine: same(row.assignedUserId?._id, scope.access.actor._id), canRelease: row.status === 'in_progress' && (scope.access.supervisor || same(row.assignedUserId?._id, scope.access.actor._id)) }));
  }
  if (mode === 'reports') {
    const reportScope = movementScope(scope.ids, scope.filters);
    const [rows, count] = await Promise.all([populateMovement(InventoryMovement.find(cursorScope(reportScope, scope.filters.after))).sort(cursorSort()).limit(26).lean(), InventoryMovement.countDocuments(reportScope)]);
    const paged = pageResult(rows, { limit: 25, total: count }); flow.movements = paged.items.map(movementView); flow.page = paged.page;
  }
  const ready = await readyParcels(scope, mode); flow.readyParcels = ready.rows; flow.readyPage = ready.page;
  return flow;
}

export async function loadWarehouseDashboard(request) { return loadWarehousePage(request, 'overview'); }

export async function warehouseReportRows(request) {
  const scope = await scopeFor(request);
  const rows = await populateMovement(InventoryMovement.find(movementScope(scope.ids, scope.filters))).sort({ createdAt: 1, _id: 1 }).limit(501).lean();
  if (rows.length > 500) throw new AppError('This export exceeds 500 movements. Select one warehouse or a narrower reporting period.', 422, 'WAREHOUSE_EXPORT_LIMIT');
  // Required export evidence must succeed before any rows leave this service.
  const countries = [...new Set(scope.selected.map(row => row.country))];
  if (!countries.length) countries.push(scope.access.actor.country);
  await AuditLog.create(countries.map(country => ({ requestId: request.id, actorId: scope.access.actor._id, actorPublicId: scope.access.actor.publicId,
    country, action: 'warehouse.inventory_audit_exported', targetType: 'inventory_movement', targetPublicId: 'inventory-audit', result: 'success',
    ipHash: hashValue(request.ip || ''), userAgentHash: hashValue(request.get?.('user-agent') || ''),
    metadata: { rowCount: rows.filter(row => row.warehouseId?.country === country).length, warehousePublicId: scope.filters.warehousePublicId,
      from: scope.filters.from, to: scope.filters.to } })));
  return { rows: rows.map(movementView), warehouses: scope.all.map(warehouseView), filters: scope.filters };
}

export async function warehouseParcelLabel(request) {
  const scope = await scopeFor(request);
  const id = String(request.params?.publicId || '');
  if (!/^[a-z][a-z0-9_-]{4,99}$/.test(id)) throw new AppError('Parcel not found.', 404, 'WAREHOUSE_PARCEL_NOT_FOUND');
  const parcel = await Parcel.findOne({ publicId: id, status: { $in: ['packed', 'handed_over', 'in_transit', 'delivered', 'returned'] } })
    .select('publicId shipmentId orderPublicId storePublicId barcode status items').lean();
  if (!parcel) throw new AppError('Packed parcel not found.', 404, 'WAREHOUSE_PARCEL_NOT_FOUND');
  const packing = await WarehouseTask.findOne({ parcelId: parcel._id, type: 'pack', status: 'completed', warehouseId: { $in: scope.ids } })
    .sort({ completedAt: -1 }).select('warehouseId storeId shipmentId').lean();
  const warehouse = scope.selected.find(row => same(row._id, packing?.warehouseId));
  const store = warehouse ? await Store.findOne({ _id: packing.storeId, publicId: parcel.storePublicId }).select('_id').lean() : null;
  const shipment = store ? await Shipment.findOne({ _id: parcel.shipmentId, country: warehouse.country, kind: 'outbound' }).select('publicId country kind').lean() : null;
  if (!packing || !warehouse || !same(warehouse.storeId, packing.storeId) || !same(parcel.shipmentId, packing.shipmentId) || !shipment) {
    throw new AppError('Parcel not found in your packing warehouse scope.', 404, 'WAREHOUSE_PARCEL_NOT_FOUND');
  }
  return { parcel: { publicId: parcel.publicId, orderPublicId: parcel.orderPublicId, storePublicId: parcel.storePublicId, barcode: parcel.barcode, status: parcel.status,
    items: parcel.items.map(item => ({ sku: item.sku, title: item.title, quantity: item.quantity, productPublicId: item.productPublicId, variantPublicId: item.variantPublicId })) },
    shipment: { publicId: shipment.publicId, country: shipment.country, kind: shipment.kind } };
}

import {
  InventoryDiscrepancy,
  InventoryMovement,
  ProductVariant,
  StockItem,
  Warehouse,
  WarehouseTask,
  WarehouseWave,
} from '../models/index.js';
import { operationalCountriesFor, operationalCountryScope, warehouseScopesFor } from './authorization.js';

const ACTIVE_TASK_STATUSES = ['open', 'in_progress'];
const TASK_STATUSES = ['open', 'in_progress', 'completed', 'cancelled'];

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function taskFilters(query = {}) {
  const taskStatus = TASK_STATUSES.includes(String(query.taskStatus || '')) ? String(query.taskStatus) : '';
  return {
    taskStatus,
    taskOverdue: String(query.taskOverdue || '') === '1',
    scanCode: String(query.scanCode || '').trim().slice(0, 100),
  };
}

function taskScopeFor(warehouseIds, filters, now) {
  const scope = { warehouseId: { $in: warehouseIds } };
  if (filters.taskStatus) scope.status = filters.taskStatus;
  if (filters.taskOverdue) {
    scope.status = { $in: ACTIVE_TASK_STATUSES };
    scope.dueAt = { $lt: now };
  }
  return scope;
}

function countBy(rows, field) {
  const counts = {};
  for (const row of rows) {
    const key = String(row?.[field] || 'unknown');
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function availableUnits(stock) {
  return Math.max(0, Number(stock.onHand || 0) - Number(stock.reserved || 0) - Number(stock.damaged || 0) - Number(stock.quarantined || 0));
}

async function scanInventory(scanCode, warehouseIds) {
  if (scanCode.length >= 2) {
    const pattern = new RegExp(escapeRegex(scanCode), 'i');
    const variants = await ProductVariant.find({ $or: [{ sku: pattern }, { barcode: pattern }, { title: pattern }] })
      .select('_id publicId sku barcode title').limit(25).lean();
    const variantIds = variants.map((row) => row._id);
    const stock = await StockItem.find({
      warehouseId: { $in: warehouseIds },
      $or: [{ publicId: pattern }, { variantId: { $in: variantIds } }],
    }).populate('warehouseId', 'publicId name country city').populate('variantId', 'publicId sku barcode title').sort({ updatedAt: -1 }).limit(25).lean();
    return stock.map((row) => ({ ...row, available: availableUnits(row) }));
  }
  return [];
}

export async function loadWarehouseDashboard(request) {
  const user = request.user;
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
  const countryScope = operationalCountryScope(user, 'country');
  const assignedWarehousePublicIds = warehouseScopesFor(user);
  const warehouseQuery = {
    ...countryScope,
    active: true,
    ...(assignedWarehousePublicIds.length ? { publicId: { $in: assignedWarehousePublicIds } } : {}),
  };
  const warehouses = await Warehouse.find(warehouseQuery)
    .select('publicId storeId name country city address active').sort({ country: 1, name: 1 }).lean();
  const warehouseIds = warehouses.map((row) => row._id);
  const filters = taskFilters(request.query || {});
  const taskScope = taskScopeFor(warehouseIds, filters, now);

  const [
    tasks,
    inventory,
    discrepancies,
    waves,
    movements,
    scanResults,
    totalOpen,
    mineOpen,
    overdueOpen,
    completed30d,
    movementCountsRows,
    waveCountsRows,
  ] = await Promise.all([
    WarehouseTask.find(taskScope)
      .select('publicId warehouseId storeId orderId shipmentId parcelId returnRequestId stockItemId variantId destinationWarehouseId quantity binCode disposition type status assignedUserId wavePublicId claimedAt dueAt reference notes result completedAt createdAt updatedAt')
      .populate('warehouseId', 'publicId name country city')
      .populate('destinationWarehouseId', 'publicId name country city')
      .populate('assignedUserId', 'publicId name email')
      .populate('variantId', 'publicId sku barcode title')
      .populate('stockItemId', 'publicId binCode onHand reserved damaged quarantined')
      .populate('parcelId', 'publicId barcode status')
      .populate('returnRequestId', 'publicId orderPublicId status reason resolution')
      .sort({ dueAt: 1, createdAt: -1 }).limit(180).lean(),
    StockItem.find({ warehouseId: { $in: warehouseIds } })
      .select('publicId warehouseId variantId onHand reserved damaged quarantined binCode reorderPoint updatedAt')
      .populate('warehouseId', 'publicId name country city')
      .populate('variantId', 'publicId sku barcode title currency').sort({ updatedAt: -1 }).limit(180).lean(),
    InventoryDiscrepancy.find({ warehouseId: { $in: warehouseIds } })
      .select('publicId stockItemId warehouseId variantId country expectedOnHand countedOnHand variance reason status countedByUserId countedAt reviewedByUserId reviewedAt reviewNote createdAt')
      .populate('warehouseId', 'publicId name country').populate('variantId', 'publicId sku barcode title')
      .populate('countedByUserId', 'publicId name').populate('reviewedByUserId', 'publicId name')
      .sort({ createdAt: -1 }).limit(60).lean(),
    WarehouseWave.find({ warehouseId: { $in: warehouseIds } })
      .select('publicId warehouseId country status assignedUserId taskCount totalQuantity dueAt startedAt completedAt releasedAt createdAt')
      .populate('warehouseId', 'publicId name country').populate('assignedUserId', 'publicId name')
      .sort({ createdAt: -1 }).limit(60).lean(),
    InventoryMovement.find({ warehouseId: { $in: warehouseIds } })
      .select('publicId warehouseId stockItemId variantId type quantity onHandBefore onHandAfter reservedBefore reservedAfter reason reference actorUserId createdAt')
      .populate('warehouseId', 'publicId name country').populate('stockItemId', 'publicId')
      .populate('variantId', 'publicId sku barcode title').populate('actorUserId', 'publicId name')
      .sort({ createdAt: -1 }).limit(80).lean(),
    scanInventory(filters.scanCode, warehouseIds),
    WarehouseTask.countDocuments({ warehouseId: { $in: warehouseIds }, status: { $in: ACTIVE_TASK_STATUSES } }),
    WarehouseTask.countDocuments({ warehouseId: { $in: warehouseIds }, status: { $in: ACTIVE_TASK_STATUSES }, assignedUserId: user._id }),
    WarehouseTask.countDocuments({ warehouseId: { $in: warehouseIds }, status: { $in: ACTIVE_TASK_STATUSES }, dueAt: { $lt: now } }),
    WarehouseTask.countDocuments({ warehouseId: { $in: warehouseIds }, status: 'completed', completedAt: { $gte: thirtyDaysAgo } }),
    InventoryMovement.aggregate([{ $match: { warehouseId: { $in: warehouseIds }, createdAt: { $gte: thirtyDaysAgo } } }, { $group: { _id: '$type', count: { $sum: 1 }, quantity: { $sum: '$quantity' } } }]),
    WarehouseWave.aggregate([{ $match: { warehouseId: { $in: warehouseIds }, createdAt: { $gte: thirtyDaysAgo } } }, { $group: { _id: '$status', count: { $sum: 1 }, tasks: { $sum: '$taskCount' } } }]),
  ]);

  const inventoryRows = inventory.map((row) => ({ ...row, available: availableUnits(row) }));
  const lowStock = inventoryRows.filter((row) => row.available <= Number(row.reorderPoint || 0));
  const movementCounts = Object.fromEntries(movementCountsRows.map((row) => [String(row._id), { count: Number(row.count || 0), quantity: Number(row.quantity || 0) }]));
  const waveCounts = Object.fromEntries(waveCountsRows.map((row) => [String(row._id), { count: Number(row.count || 0), tasks: Number(row.tasks || 0) }]));
  const taskGroups = {
    receiving: tasks.filter((row) => ['receive', 'put_away'].includes(row.type)),
    picking: tasks.filter((row) => row.type === 'pick'),
    packing: tasks.filter((row) => row.type === 'pack'),
    dispatch: tasks.filter((row) => row.type === 'dispatch'),
    returns: tasks.filter((row) => row.type === 'return_inspection'),
    other: tasks.filter((row) => ['cycle_count', 'transfer'].includes(row.type)),
  };

  return {
    user: {
      publicId: user.publicId,
      name: user.name,
      email: user.email,
      role: user.role,
      country: user.country,
      preferences: user.preferences?.dashboard || {},
    },
    operationalCountries: operationalCountriesFor(user),
    warehouses,
    filters,
    scanResults,
    inventory: inventoryRows,
    discrepancies,
    waves,
    movements,
    tasks,
    taskGroups,
    summary: {
      warehouseCount: warehouses.length,
      totalOpen,
      mineOpen,
      overdueOpen,
      completed30d,
      skuCount: inventoryRows.length,
      availableUnits: inventoryRows.reduce((sum, row) => sum + row.available, 0),
      reservedUnits: inventoryRows.reduce((sum, row) => sum + Number(row.reserved || 0), 0),
      damagedUnits: inventoryRows.reduce((sum, row) => sum + Number(row.damaged || 0), 0),
      lowStockCount: lowStock.length,
      pendingDiscrepancies: discrepancies.filter((row) => row.status === 'pending_review').length,
      activeWaves: waves.filter((row) => row.status === 'in_progress').length,
      returnInspections: taskGroups.returns.filter((row) => ACTIVE_TASK_STATUSES.includes(row.status)).length,
    },
    reports: {
      taskCounts: countBy(tasks, 'type'),
      taskStatusCounts: countBy(tasks, 'status'),
      movementCounts,
      waveCounts,
    },
  };
}

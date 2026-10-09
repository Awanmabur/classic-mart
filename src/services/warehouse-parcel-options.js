import { AppError } from '../core/errors.js';
import { InventoryReservation, Order, Shipment, StockItem, Store, Warehouse, WarehouseTask } from '../models/index.js';
import { warehouseParcelRequirementsFromContext } from './logistics.js';

const same = (left, right) => String(left || '') === String(right || '');
const unique = values => [...new Set(values.filter(Boolean).map(String))];
const byId = rows => new Map(rows.map(row => [String(row._id), row]));
const groupBy = (rows, key) => {
  const groups = new Map();
  for (const row of rows) {
    const value = String(row[key] || '');
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return groups;
};

/**
 * Build advisory preparation controls for one already scoped cursor page.
 * Every collection is read once for the whole page. Mutation handlers rebuild
 * this context under their own transaction and never trust these controls.
 */
export async function warehouseParcelOptions({ parcels, warehouses }) {
  if (!Array.isArray(parcels) || parcels.length > 26 || !Array.isArray(warehouses) || warehouses.length > 500) {
    throw new AppError('Warehouse parcel options require a bounded workspace page.', 500, 'WAREHOUSE_OPTIONS_PAGE_INVALID');
  }
  if (!parcels.length || !warehouses.length) return new Map();

  const parcelIds = parcels.map(row => row._id);
  const [stores, shipments, orders, tasks] = await Promise.all([
    Store.find({ publicId: { $in: unique(parcels.map(row => row.storePublicId)) } })
      .select('publicId country status').lean(),
    Shipment.find({ _id: { $in: unique(parcels.map(row => row.shipmentId)) } })
      .select('orderId orderPublicId country kind status').lean(),
    Order.find({ publicId: { $in: unique(parcels.map(row => row.orderPublicId)) } })
      .select('publicId country status paymentMethod paymentState fulfillmentState cancellationState refundState items.storeId items.storePublicId items.reservationPublicId items.variantId items.productPublicId items.variantPublicId items.sku items.title items.quantity').lean(),
    WarehouseTask.find({ parcelId: { $in: parcelIds }, type: { $in: ['pick', 'pack', 'dispatch'] }, status: { $in: ['completed', 'open', 'in_progress'] } })
      .select('publicId parcelId orderId shipmentId storeId warehouseId type status result.pickedQuantity completedAt').lean(),
  ]);
  const storeByPublicId = new Map(stores.map(row => [row.publicId, row]));
  const shipmentById = byId(shipments);
  const orderByPublicId = new Map(orders.map(row => [row.publicId, row]));
  const tasksByParcelId = groupBy(tasks, 'parcelId');
  const reservationIds = unique(parcels.flatMap(parcel => {
    const store = storeByPublicId.get(parcel.storePublicId);
    return (orderByPublicId.get(parcel.orderPublicId)?.items || [])
      .filter(line => line.storePublicId === parcel.storePublicId && same(line.storeId, store?._id))
      .map(line => line.reservationPublicId);
  }));
  const reservations = await InventoryReservation.find({ publicId: { $in: reservationIds }, status: 'committed' })
    .select('publicId storeId stockItemId variantId quantity status').lean();
  const stocks = await StockItem.find({ _id: { $in: unique(reservations.map(row => row.stockItemId)) } })
    .select('storeId warehouseId variantId binCode').lean();
  const sourceWarehouses = await Warehouse.find({ _id: { $in: unique(stocks.map(row => row.warehouseId)) }, active: true })
    .select('publicId name storeId country active __v').lean();
  const reservationByPublicId = new Map(reservations.map(row => [row.publicId, row]));
  const stockById = byId(stocks);
  const sourceWarehouseById = byId(sourceWarehouses);
  const selectedById = byId(warehouses);
  const result = new Map();

  for (const parcel of parcels) {
    const store = storeByPublicId.get(parcel.storePublicId);
    const shipment = shipmentById.get(String(parcel.shipmentId));
    const order = orderByPublicId.get(parcel.orderPublicId);
    const lines = (order?.items || []).filter(line => line.storePublicId === parcel.storePublicId && same(line.storeId, store?._id));
    const parcelReservations = lines.map(line => reservationByPublicId.get(line.reservationPublicId)).filter(Boolean);
    const parcelStocks = unique(parcelReservations.map(row => row.stockItemId)).map(id => stockById.get(id)).filter(Boolean);
    const parcelWarehouses = unique(parcelStocks.map(row => row.warehouseId)).map(id => sourceWarehouseById.get(id)).filter(Boolean);
    const parcelTasks = tasksByParcelId.get(String(parcel._id)) || [];
    const completedTasks = parcelTasks.filter(row => row.status === 'completed');
    const warehouseGroups = [], actions = { pick: false, pack: false, dispatch: false };
    let packWarehousePublicId = '';

    for (const source of parcelWarehouses) {
      const warehouse = selectedById.get(String(source._id));
      if (!warehouse) continue;
      try {
        const requirements = warehouseParcelRequirementsFromContext({ parcel, warehouse, shipment, order, store,
          reservations: parcelReservations, stocks: parcelStocks, warehouses: parcelWarehouses, completedTasks });
        const existingTaskPublicIds = {};
        const groupActions = {};
        for (const action of ['pick', 'pack', 'dispatch']) {
          const existing = parcelTasks.find(task => ['open', 'in_progress'].includes(task.status) && task.type === action &&
            same(task.warehouseId, warehouse._id) && same(task.storeId, store?._id) && same(task.orderId, order?._id) && same(task.shipmentId, shipment?._id));
          if (existing) existingTaskPublicIds[action] = existing.publicId;
          groupActions[action] = Boolean(requirements['can' + action[0].toUpperCase() + action.slice(1)]) && !existing;
          actions[action] ||= groupActions[action];
        }
        warehouseGroups.push({ warehousePublicId: warehouse.publicId, warehouseName: warehouse.name,
          quantity: requirements.groupQuantity, remaining: requirements.pickQuantity, version: Number(warehouse.__v || 0),
          parcelItems: requirements.pickItems, actions: groupActions, existingTaskPublicIds });
        if (same(requirements.packedWarehouseId, warehouse._id)) packWarehousePublicId = warehouse.publicId;
      } catch (error) {
        if (!(error instanceof AppError) || error.status >= 500) throw error;
      }
    }
    if (warehouseGroups.length) result.set(parcel.publicId, { parcel, warehouseGroups, actions, packWarehousePublicId,
      labelUrl: packWarehousePublicId && ['packed', 'handed_over'].includes(parcel.status) ? '/warehouse/parcels/' + parcel.publicId + '/label' : '' });
  }
  return result;
}

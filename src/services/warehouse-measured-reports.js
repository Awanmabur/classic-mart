import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { InventoryDiscrepancy, Parcel, Warehouse, WarehouseTask } from '../models/index.js';
import { assertWarehouseAccess } from './warehouse-operations.js';
import { cursorScope, cursorSort, decodeCursor, pageResult } from './pagination.js';
import { writeAudit } from './audit.js';

const kinds = ['tasks', 'handover', 'counts'];
function scalar(value, max = 100) { if (value !== undefined && (typeof value !== 'string' || value.length > max)) throw new AppError('Invalid warehouse report filter.', 422, 'WAREHOUSE_REPORT_FILTER_INVALID'); return value || ''; }
function date(value) { if (!value) return ''; if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(new Date(value).getTime()) || new Date(value).toISOString().slice(0, 10) !== value) throw new AppError('Choose valid report dates.', 422, 'WAREHOUSE_REPORT_FILTER_INVALID'); return value; }
async function reportAccess(request) {
  const access = await assertWarehouseAccess(request), query = request.query || {};
  const filters = { warehousePublicId: scalar(query.warehousePublicId), kind: scalar(query.measure || 'tasks'), after: scalar(query.measureAfter, 512), from: date(scalar(query.from, 10)), to: date(scalar(query.to, 10)) };
  if (!kinds.includes(filters.kind) || (filters.after && !decodeCursor(filters.after)) || (filters.from && filters.to && filters.from > filters.to)) throw new AppError('Reload the report with valid filters.', 422, 'WAREHOUSE_REPORT_FILTER_INVALID');
  const warehouses = await Warehouse.find(access.scope).select('publicId name country __v storeId').sort({ publicId: 1 }).limit(501).lean();
  if (warehouses.length > 500) throw new AppError('Select a narrower warehouse assignment.', 422, 'WAREHOUSE_SCOPE_TOO_LARGE');
  if (filters.warehousePublicId && !warehouses.some(row => row.publicId === filters.warehousePublicId)) throw new AppError('Warehouse not found in your current scope.', 404, 'WAREHOUSE_NOT_FOUND');
  const selected = filters.warehousePublicId ? warehouses.filter(row => row.publicId === filters.warehousePublicId) : warehouses;
  const range = {}; if (filters.from) range.$gte = new Date(filters.from + 'T00:00:00.000Z'); if (filters.to) range.$lt = new Date(new Date(filters.to + 'T00:00:00.000Z').getTime() + 86400000);
  const base = { warehouseId: { $in: selected.map(row => row._id) } };
  const context = { access, filters, selected, warehouses, base, range };
  context.signature = JSON.stringify({ user: String(access.actor._id), token: access.actor.security.tokenVersion, role: access.actor.role, grant: String(access.grant?._id || ''), grantExpiry: access.grant?.expiresAt, countries: access.countries.map(row => row.code + ':' + row.currency + ':' + row.timeZone).sort(), warehouses: selected.map(row => String(row._id) + ':' + row.publicId + ':' + row.country + ':' + String(row.storeId)).sort() });
  return context;
}
const within = (context, field) => ({ ...context.base, ...(Object.keys(context.range).length ? { [field]: context.range } : {}) });
const finiteDate = field => ({ $eq: [{ $type: '$' + field }, 'date'] });
const durationValid = { $and: [finiteDate('claimedAt'), finiteDate('completedAt'), { $gte: ['$completedAt', '$claimedAt'] }] };
const slaEligible = { $and: [finiteDate('completedAt'), finiteDate('dueAt')] };
const sumWhen = expression => ({ $sum: { $cond: [expression, 1, 0] } });

async function measurements(context) {
  const [tasks, handover, counts] = await Promise.all([
    WarehouseTask.aggregate([{ $match: { ...within(context, 'completedAt'), status: 'completed' } }, { $group: { _id: null, completed: { $sum: 1 }, durationSamples: sumWhen(durationValid), totalDurationMs: { $sum: { $cond: [durationValid, { $subtract: ['$completedAt', '$claimedAt'] }, 0] } }, slaSamples: sumWhen(slaEligible), onTime: sumWhen({ $and: [slaEligible, { $lte: ['$completedAt', '$dueAt'] }] }), late: sumWhen({ $and: [slaEligible, { $gt: ['$completedAt', '$dueAt'] }] }) } }]),
    WarehouseTask.aggregate(handoverPipeline(context).concat([{ $group: { _id: null, dispatches: { $sum: 1 }, custodySamples: sumWhen({ $and: [finiteDate('handoverAt'), { $gte: ['$handoverAt', '$completedAt'] }] }), totalHandoverMs: { $sum: { $cond: [{ $and: [finiteDate('handoverAt'), { $gte: ['$handoverAt', '$completedAt'] }] }, { $subtract: ['$handoverAt', '$completedAt'] }, 0] } } } }])),
    InventoryDiscrepancy.aggregate([{ $match: within(context, 'countedAt') }, { $group: { _id: null, countRecords: { $sum: 1 }, measuredCounts: sumWhen({ $and: [{ $isNumber: '$stockVersionSnapshot' }, { $isNumber: '$expectedOnHand' }, { $isNumber: '$countedOnHand' }] }), exactCounts: sumWhen({ $and: [{ $isNumber: '$stockVersionSnapshot' }, { $eq: ['$expectedOnHand', '$countedOnHand'] }] }), absoluteVarianceUnits: { $sum: { $cond: [{ $isNumber: '$stockVersionSnapshot' }, { $abs: '$variance' }, 0] } }, expectedUnits: { $sum: { $cond: [{ $isNumber: '$stockVersionSnapshot' }, '$expectedOnHand', 0] } } } }]),
  ]);
  const task = tasks[0] || {}, hand = handover[0] || {}, count = counts[0] || {};
  return { completedTasks: task.completed || 0, durationSamples: task.durationSamples || 0, unmeasuredDurations: (task.completed || 0) - (task.durationSamples || 0), averageTaskMinutes: task.durationSamples ? task.totalDurationMs / task.durationSamples / 60000 : null, slaSamples: task.slaSamples || 0, onTime: task.onTime || 0, late: task.late || 0, onTimePercent: task.slaSamples ? task.onTime / task.slaSamples * 100 : null,
    dispatches: hand.dispatches || 0, custodySamples: hand.custodySamples || 0, averageHandoverMinutes: hand.custodySamples ? hand.totalHandoverMs / hand.custodySamples / 60000 : null, countRecords: count.countRecords || 0, measuredCounts: count.measuredCounts || 0, exactCounts: count.exactCounts || 0, excludedCounts: (count.countRecords || 0) - (count.measuredCounts || 0), countAccuracyPercent: count.measuredCounts ? count.exactCounts / count.measuredCounts * 100 : null, absoluteVarianceUnits: count.absoluteVarianceUnits || 0, expectedUnits: count.expectedUnits || 0 };
}
function handoverPipeline(context) {
  return [{ $match: { ...within(context, 'completedAt'), type: 'dispatch', status: 'completed', parcelId: { $exists: true } } },
    { $lookup: { from: Parcel.collection.name, let: { parcel: '$parcelId', shipment: '$shipmentId' }, pipeline: [
      { $match: { $expr: { $and: [{ $eq: ['$_id', '$$parcel'] }, { $eq: ['$shipmentId', '$$shipment'] }] } } },
      { $project: { publicId: 1, status: 1, handoverEvents: { $filter: { input: '$timeline', as: 'event', cond: { $eq: ['$$event.type', 'picked_up'] } } } } },
    ], as: 'sourceParcel' } }, { $unwind: '$sourceParcel' }, { $set: { handoverAt: { $min: '$sourceParcel.handoverEvents.at' } } }];
}
function reportQuery(context, after = context.filters.after, direction = -1, limit = 26) {
  const kind = context.filters.kind;
  if (kind === 'counts') return InventoryDiscrepancy.find(cursorScope(within(context, 'countedAt'), after, { field: 'countedAt', direction })).select('publicId warehouseId countedAt expectedOnHand countedOnHand variance status stockVersionSnapshot createdAt').sort(cursorSort('countedAt', direction)).limit(limit).lean();
  if (kind === 'tasks') return WarehouseTask.find(cursorScope({ ...within(context, 'completedAt'), completedAt: { $type: 'date', ...context.range }, status: 'completed' }, after, { field: 'completedAt', direction })).select('publicId warehouseId type status claimedAt completedAt dueAt createdAt').sort(cursorSort('completedAt', direction)).limit(limit).lean();
  const match = cursorScope({ ...within(context, 'completedAt'), completedAt: { $type: 'date', ...context.range }, type: 'dispatch', status: 'completed', parcelId: { $exists: true } }, after, { field: 'completedAt', direction });
  return WarehouseTask.aggregate([{ $match: match }, ...handoverPipeline(context).slice(1), { $sort: cursorSort('completedAt', direction) }, { $limit: limit }, { $project: { publicId: 1, warehouseId: 1, parcelPublicId: '$sourceParcel.publicId', completedAt: 1, handoverAt: 1, createdAt: 1 } }]);
}
function rowView(row, context) {
  const warehouse = context.selected.find(item => String(item._id) === String(row.warehouseId));
  const durationMs = row.claimedAt && row.completedAt ? new Date(row.completedAt) - new Date(row.claimedAt) : null;
  const handoverMs = row.handoverAt && row.completedAt ? new Date(row.handoverAt) - new Date(row.completedAt) : null;
  return { publicId: row.publicId, warehousePublicId: warehouse?.publicId || '', warehouseName: warehouse?.name || '', country: warehouse?.country || '', type: row.type || context.filters.kind, status: row.status || '', recordedAt: row.countedAt || row.completedAt, claimedAt: row.claimedAt || null, completedAt: row.completedAt || null, dueAt: row.dueAt || null, durationMinutes: durationMs !== null && durationMs >= 0 ? durationMs / 60000 : null, onTime: row.dueAt && row.completedAt ? row.completedAt <= row.dueAt : null, parcelPublicId: row.parcelPublicId || '', handoverAt: row.handoverAt || null, handoverMinutes: handoverMs !== null && handoverMs >= 0 ? handoverMs / 60000 : null, expectedOnHand: row.expectedOnHand ?? null, countedOnHand: row.countedOnHand ?? null, variance: row.variance ?? null, measuredCount: Number.isSafeInteger(row.stockVersionSnapshot) };
}
export async function loadWarehouseMeasuredReport(request) {
  const context = await reportAccess(request), summary = await measurements(context), rows = await reportQuery(context);
  const field = context.filters.kind === 'counts' ? 'countedAt' : 'completedAt', result = pageResult(rows, { limit: 25, field });
  const current = await reportAccess(request); if (current.signature !== context.signature) throw new AppError('Warehouse report authority changed.', 403, 'WAREHOUSE_SCOPE_CHANGED');
  return { filters: context.filters, summary, rows: result.items.map(row => rowView(row, context)), page: result.page };
}
export async function prepareWarehouseMeasuredExport(request) {
  const context = await reportAccess(request), summary = await measurements(context);
  // Audit succeeds before a response body is released. Every following chunk rechecks the same active authority and scope.
  const session = await mongoose.startSession();
  try { await session.withTransaction(async () => {
    const access = await assertWarehouseAccess(request, { mutation: true, session });
    if (String(access.grant?._id || '') !== String(context.access.grant?._id || '') || JSON.stringify(access.scope) !== JSON.stringify(context.access.scope)) throw new AppError('Warehouse export authority changed.', 403, 'WAREHOUSE_SCOPE_CHANGED');
    for (const country of [...new Set(context.selected.map(row => row.country))]) await writeAudit(request, 'warehouse.measured_report_exported', { actor: access.actor, country, targetType: 'warehouse_report', targetPublicId: context.filters.kind, metadata: { filters: context.filters, warehouses: context.selected.filter(row => row.country === country).map(row => row.publicId), summary }, session });
  }); } finally { await session.endSession(); }
  return { context, summary };
}
async function* warehouseMeasuredExportRows(request, prepared) {
  const { context } = prepared; let after = '';
  while (true) {
    const fresh = await reportAccess(request); if (fresh.signature !== context.signature) throw new AppError('Warehouse export authority changed.', 403, 'WAREHOUSE_SCOPE_CHANGED');
    const rows = await reportQuery(context, after, 1, 101); if (!rows.length) return;
    const current = await reportAccess(request); if (current.signature !== context.signature) throw new AppError('Warehouse export authority changed.', 403, 'WAREHOUSE_SCOPE_CHANGED');
    const page = pageResult(rows, { field: context.filters.kind === 'counts' ? 'countedAt' : 'completedAt', direction: 1, limit: 100 });
    for (const row of page.items) yield rowView(row, context);
    if (!page.page.hasMore) return; after = page.page.next;
  }
}
export { warehouseMeasuredExportRows };

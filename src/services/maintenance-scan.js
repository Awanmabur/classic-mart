import { MaintenanceScanCursor } from '../models/index.js';

export async function scanMaintenanceBatch(Model, scanName, base = {}, { limit = 250, select = '' } = {}) {
  const size = Math.max(1, Math.min(1000, Number(limit) || 250));
  const state = await MaintenanceScanCursor.findOne({ scanName }).lean();
  const scope = state?.lastId ? { $and: [base, { _id: { $gt: state.lastId } }] } : base;
  let query = Model.find(scope).sort({ _id: 1 }).limit(size);
  if (select) query = query.select(select);
  const rows = await query.lean();
  const passCompleted = rows.length < size;
  const nextId = passCompleted ? null : rows.at(-1)?._id || null;
  await MaintenanceScanCursor.findOneAndUpdate(
    { scanName },
    {
      $set: { lastId: nextId, lastBatchSize: rows.length, lastScannedAt: new Date() },
      ...(passCompleted ? { $inc: { completedPasses: 1 } } : {}),
    },
    { upsert: true, setDefaultsOnInsert: true },
  );
  return { rows, passCompleted, nextId };
}

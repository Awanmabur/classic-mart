import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Router } from 'express';
import rateLimit from '../middleware/rate-limit.js';
import { AppError, asyncHandler } from '../core/errors.js';
import { hasPermission } from '../core/roles.js';
import { env } from '../config/env.js';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { noStore } from '../middleware/request.js';
import { setFlash } from '../middleware/view.js';
import { allowedWorkspacesFor } from '../dashboard/access.js';
import { DASHBOARD_PAGES } from '../dashboard/registry.js';
import { WAREHOUSE_ROUTES, warehousePath } from '../dashboard/warehouse-routes.js';
import { liveAccountHeader } from '../dashboard/live-account-header.js';
import { mutateWarehouse } from '../services/warehouse-operations.js';
import { loadWarehousePage, warehouseReportRows, warehouseParcelLabel } from '../services/warehouse-dashboard.js';
import { code39Geometry } from '../dashboard/parcel-barcode.js';
import { uploadVerificationImage } from '../services/media.js';
import { loadWarehouseReturnIntakes, uploadWarehouseReturnIntakeEvidence, recordWarehouseReturnIntake } from '../services/support-case-pages.js';
import { prepareWarehouseMeasuredExport, warehouseMeasuredExportRows } from '../services/warehouse-measured-reports.js';

const router = Router();
const privatePage = (_request, response, next) => { response.set('X-Robots-Tag', 'noindex, nofollow, noarchive'); next(); };
const operationalAccess = (request, response, next) => {
  if (!hasPermission(request.user, 'warehouse:manage') && !['country_admin', 'super_admin'].includes(request.user.role)) {
    return next(new AppError('Warehouse operations access is required.', 403, 'WAREHOUSE_FORBIDDEN'));
  }
  if (env.auth.simpleLogin || !env.security.privilegedMfaRequired || request.user.security?.mfaEnabled) return next();
  if (request.accepts(['html', 'json']) === 'json') return next(new AppError('Multi-factor authentication enrollment is required for warehouse operations.', 403, 'MFA_ENROLLMENT_REQUIRED'));
  return response.redirect('/account/security?next=' + encodeURIComponent(request.originalUrl));
};
const access = [noStore, privatePage, requireAuth, requireVerified, requireOnboarding, operationalAccess];
const mutationLimit = rateLimit({ scope: 'warehouse:1', windowMs: 15 * 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false });
const intakeUploadLimit = rateLimit({ scope: 'warehouse:2', windowMs: 15 * 60_000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false });
const exportLimit = rateLimit({ scope: 'warehouse:3', windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
const navigation = DASHBOARD_PAGES.warehouse.map(([id, label, icon]) => ({ id, label, icon, href: WAREHOUSE_ROUTES[id], ready: true }));

async function renderPage(request, response, mode, error = '') {
  let pageRequest = request;
  if (error && mode !== 'returns' && typeof request.body.warehousePublicId === 'string' && /^[a-z][a-z0-9_-]{4,99}$/.test(request.body.warehousePublicId)) {
    pageRequest = Object.create(request);
    Object.defineProperty(pageRequest, 'query', { value: { ...request.query, warehousePublicId: request.body.warehousePublicId } });
  }
  let flow;
  try { flow = await loadWarehousePage(pageRequest, mode); } catch (failure) {
    if (!error || pageRequest === request || failure.status !== 404) throw failure;
    flow = await loadWarehousePage(request, mode);
  }
  const draft = error ? Object.fromEntries(['type', 'stockPublicId', 'quantity', 'binCode', 'reference', 'notes'].map(key => [key,
    ['string', 'number'].includes(typeof request.body[key]) ? String(request.body[key]).slice(0, key === 'notes' ? 500 : key === 'reference' ? 120 : 100) : ''])) : {};
  const intakeDraft = error && mode === 'returns' ? {
    returnPublicId: String(request.params.publicId || ''),
    ...Object.fromEntries(['orderLineId', 'warehousePublicId', 'evidencePublicId', 'note'].map(key => [key,
      typeof request.body[key] === 'string' ? request.body[key].slice(0, key === 'note' ? 300 : 100) : ''])),
  } : {};
  const wantsJson = request.accepts(['html', 'json']) === 'json';
  const header = wantsJson ? null : await liveAccountHeader(request);
  if (mode === 'returns') {
    flow.returnIntakes = { ...await loadWarehouseReturnIntakes(pageRequest), after: pageRequest.query.intakesAfter || '' };
    const warehouseCoverage = rows => rows.map(row => row.country + ':' + row.publicId).sort().join(',');
    if (warehouseCoverage(flow.returnIntakes.warehouses) !== warehouseCoverage(flow.warehouses)) {
      throw new AppError('Your receiving locations changed. Reload this workspace.', 403, 'WAREHOUSE_SCOPE_CHANGED');
    }
  }
  if (wantsJson) return response.json(flow);
  return response.render('approved-dashboard', {
    ...header, workspace: 'warehouse', initialPage: 'warehouse-' + mode,
    allowedWorkspaces: [...new Set([...allowedWorkspacesFor(request.user), 'warehouse'])],
    customerRoutes: { ...header.customerRoutes, ...WAREHOUSE_ROUTES },
    liveWarehouse: { profileRole: 'Warehouse', navigation, flow: { ...flow, mode, error, draft, intakeDraft, actionKey: randomUUID() } },
  });
}

for (const [page, path] of Object.entries(WAREHOUSE_ROUTES)) {
  router.get(path, ...access, asyncHandler((request, response) => renderPage(request, response, page.replace('warehouse-', ''))));
  router.get('/dashboard/' + page, ...access, (request, response) => response.redirect(308, path + new URL(request.originalUrl, 'http://localhost').search));
}
router.get('/operations/logistics', ...access, (request, response) => response.redirect(308, '/warehouse' + new URL(request.originalUrl, 'http://localhost').search));
// Retired preference toggles had no operational effect. Warehouse settings expose
// authoritative locations and access; personal security remains on the account page.
router.post('/operations/logistics/dashboard/settings', ...access, (_request, response) => response.redirect(303, '/warehouse/settings'));

function intakeReturnPath(request) {
  const query = new URLSearchParams();
  for (const key of ['warehousePublicId', 'taskStatus', 'scanCode', 'mine', 'after', 'intakesAfter']) {
    const value = request.query[key];
    if (typeof value === 'string' && value.length <= 512) query.set(key, value);
  }
  return '/warehouse/returns' + (query.size ? '?' + query.toString() : '');
}

function parseIntakeImage(request, response, next) {
  uploadVerificationImage(request, response, error => {
    // Multipart data must be parsed before checking its form token. No image or
    // return workflow is persisted until this check succeeds.
    try { verifyDeferredCsrf(request); } catch (csrfError) { return next(csrfError); }
    if (error) request.warehouseIntakeUploadError = error.name === 'MulterError'
      ? new AppError(error.code === 'LIMIT_FILE_SIZE' ? 'Choose a receipt image up to 8 MB.' : 'Choose one receipt image in the Document field.', 422, 'RETURN_INTAKE_UPLOAD_INVALID')
      : error;
    return next();
  });
}

for (const [action, operation, message] of [
  ['intake-evidence', uploadWarehouseReturnIntakeEvidence, 'Receipt image saved. Confirm the goods received against this exact order line.'],
  ['intake', recordWarehouseReturnIntake, 'Physical return receipt recorded. Received goods proceed to their warehouse inspection tasks.'],
]) {
  router.post('/warehouse/returns/:publicId/' + action, ...access,
    ...(action === 'intake-evidence' ? [intakeUploadLimit, parseIntakeImage] : [mutationLimit]),
    asyncHandler(async (request, response) => {
      try {
        verifyDeferredCsrf(request);
        if (request.warehouseIntakeUploadError) throw request.warehouseIntakeUploadError;
        const result = await operation(request, request.params.publicId, request.body || {}, request.file);
        if (request.accepts(['html', 'json']) === 'json') return response.status(action === 'intake-evidence' ? 201 : 200).json(result);
        setFlash(request, 'success', message);
        return response.redirect(303, intakeReturnPath(request));
      } catch (error) {
        const status = error.name === 'ZodError' ? 422 : error.status;
        if (![409, 422].includes(status) || request.accepts(['html', 'json']) === 'json') throw error;
        response.status(status);
        return renderPage(request, response, 'returns', error.name === 'ZodError' ? error.issues[0].message : error.message);
      }
    }));
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
router.get('/warehouse/reports/export.csv', ...access, exportLimit, asyncHandler(async (request, response) => {
  const report = await warehouseReportRows(request);
  const rows = [['Movement', 'Created at', 'Country', 'Warehouse', 'Stock', 'SKU', 'Type', 'Quantity', 'On hand before', 'On hand after', 'Reserved before', 'Reserved after', 'Damaged before', 'Damaged after', 'Quarantined before', 'Quarantined after', 'Bin before', 'Bin after', 'Reference', 'Reason'],
    ...report.rows.map(row => [row.publicId, new Date(row.createdAt).toISOString(), row.country, row.warehouseName, row.stockPublicId, row.sku,
      row.type, row.quantity, row.onHandBefore, row.onHandAfter, row.reservedBefore, row.reservedAfter, row.damagedBefore, row.damagedAfter, row.quarantinedBefore, row.quarantinedAfter, row.binBefore, row.binAfter, row.reference, row.reason])];
  response.set('Content-Disposition', 'attachment; filename="classic-mart-warehouse-movements.csv"');
  return response.type('text/csv; charset=utf-8').send(rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
}));
router.get('/operations/logistics/inventory-audit.csv', ...access, (request, response) => response.redirect(308, '/warehouse/reports/export.csv' + new URL(request.originalUrl, 'http://localhost').search));
router.get('/warehouse/reports/measured.csv', ...access, exportLimit, asyncHandler(async (request, response) => {
  const prepared = await prepareWarehouseMeasuredExport(request);
  response.set('Content-Disposition', 'attachment; filename="classic-mart-warehouse-' + prepared.context.filters.kind + '.csv"');
  response.type('text/csv; charset=utf-8');
  const columns = ['Reference', 'Country', 'Warehouse', 'Type', 'Status', 'Recorded at', 'Claimed at', 'Completed at', 'Due at', 'Task minutes', 'On time', 'Parcel', 'Carrier custody at', 'Handover minutes', 'Expected count', 'Physical count', 'Variance', 'Count measured'];
  response.write(columns.map(csvCell).join(',') + '\r\n');
  const date = value => value ? new Date(value).toISOString() : '';
  for await (const row of warehouseMeasuredExportRows(request, prepared)) {
    if (response.destroyed) break;
    const cells = [row.publicId, row.country, row.warehouseName, row.type, row.status, date(row.recordedAt), date(row.claimedAt), date(row.completedAt), date(row.dueAt), row.durationMinutes ?? '', row.onTime === null ? '' : row.onTime ? 'yes' : 'no', row.parcelPublicId, date(row.handoverAt), row.handoverMinutes ?? '', row.expectedOnHand ?? '', row.countedOnHand ?? '', row.variance ?? '', row.type === 'counts' ? row.measuredCount ? 'yes' : 'no' : ''];
    if (!response.write(cells.map(csvCell).join(',') + '\r\n')) await Promise.race([once(response, 'drain'), once(response, 'close')]);
  }
  if (!response.destroyed) response.end();
}));
router.get('/warehouse/parcels/:publicId/label', ...access, asyncHandler(async (request, response) => {
  const label = await warehouseParcelLabel(request);
  return response.render('parcel-label', { ...label, barcodeGeometry: code39Geometry(label.parcel.barcode) });
}));
router.get('/operations/logistics/parcels/:publicId/label', ...access, (request, response) => response.redirect(308, '/warehouse/parcels/' + encodeURIComponent(request.params.publicId) + '/label'));

const actionRoutes = [
  ['/tasks', 'create-task'], ['/tasks/:publicId/claim', 'claim'], ['/tasks/:publicId/release', 'release'], ['/tasks/:publicId/execute', 'execute'],
  ['/pick-waves', 'create-wave'], ['/pick-waves/:publicId/release', 'release-wave'],
  ['/stock/:publicId/cycle-count', 'cycle-count'], ['/discrepancies/:publicId/review', 'review-discrepancy'],
];
for (const [path, action] of actionRoutes) {
  const run = asyncHandler(async (request, response) => {
    try {
      const result = await mutateWarehouse(request, action);
      if (request.accepts(['html', 'json']) === 'json') return response.json(result);
      setFlash(request, 'success', result.duplicate ? 'This action was already completed.' : 'Warehouse action completed.');
      return response.redirect(303, warehousePath(result.page));
    } catch (error) {
      const status = error.name === 'ZodError' ? 422 : error.status;
      if (![409, 422].includes(status) || request.accepts(['html', 'json']) === 'json') throw error;
      const page = String(request.body.returnPage || 'overview').replace(/^warehouse-/, '');
      const mode = WAREHOUSE_ROUTES['warehouse-' + page] ? page : 'overview';
      response.status(status);
      return renderPage(request, response, mode, error.name === 'ZodError' ? error.issues[0].message : error.message);
    }
  });
  router.post('/warehouse' + path, ...access, mutationLimit, run);
  const legacy = path.replace('/stock/:publicId/cycle-count', '/cycle-count');
  const aliases = action === 'execute' ? [legacy, legacy.replace('/execute', '/complete')] : [legacy];
  for (const alias of aliases) router.post('/operations/logistics' + alias, ...access, mutationLimit, (request, _response, next) => {
      if (action === 'cycle-count') request.params.publicId = String(request.body.stockPublicId || '');
      next();
    }, run);
}
export default router;

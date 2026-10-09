import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { AppError, asyncHandler } from '../core/errors.js';
import { hasPermission } from '../core/roles.js';
import { env } from '../config/env.js';
import { requireAuth, requireVerified, requireOnboarding } from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { setFlash } from '../middleware/view.js';
import { allowedWorkspacesFor } from '../dashboard/access.js';
import { DASHBOARD_PAGES } from '../dashboard/registry.js';
import { WAREHOUSE_ROUTES, warehousePath } from '../dashboard/warehouse-routes.js';
import { liveAccountHeader } from '../dashboard/live-account-header.js';
import { mutateWarehouse } from '../services/warehouse-operations.js';
import { loadWarehousePage, warehouseReportRows, warehouseParcelLabel } from '../services/warehouse-dashboard.js';
import { code39Geometry } from '../dashboard/parcel-barcode.js';

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
const mutationLimit = rateLimit({ windowMs: 15 * 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false });
const exportLimit = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
const navigation = DASHBOARD_PAGES.warehouse.map(([id, label, icon]) => ({ id, label, icon, href: WAREHOUSE_ROUTES[id], ready: true }));

async function renderPage(request, response, mode, error = '') {
  let pageRequest = request;
  if (error && typeof request.body.warehousePublicId === 'string' && /^[a-z][a-z0-9_-]{4,99}$/.test(request.body.warehousePublicId)) {
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
  if (request.accepts(['html', 'json']) === 'json') return response.json(flow);
  const header = await liveAccountHeader(request);
  return response.render('approved-dashboard', {
    ...header, workspace: 'warehouse', initialPage: 'warehouse-' + mode,
    allowedWorkspaces: [...new Set([...allowedWorkspacesFor(request.user), 'warehouse'])],
    customerRoutes: { ...header.customerRoutes, ...WAREHOUSE_ROUTES },
    liveWarehouse: { profileRole: 'Warehouse', navigation, flow: { ...flow, mode, error, draft, actionKey: randomUUID() } },
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

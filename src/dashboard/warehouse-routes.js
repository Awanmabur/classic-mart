export const WAREHOUSE_ROUTES = Object.freeze({
  'warehouse-overview': '/warehouse',
  'warehouse-inventory': '/warehouse/inventory',
  'warehouse-receiving': '/warehouse/receiving',
  'warehouse-picking': '/warehouse/picking',
  'warehouse-packing': '/warehouse/packing',
  'warehouse-dispatch': '/warehouse/dispatch',
  'warehouse-returns': '/warehouse/returns',
  'warehouse-reports': '/warehouse/reports',
  'warehouse-settings': '/warehouse/settings',
});

export function warehousePath(mode = 'overview') {
  return WAREHOUSE_ROUTES['warehouse-' + String(mode).replace(/^warehouse-/, '')] || '/warehouse';
}

import { Router } from 'express';
import { ZodError } from 'zod';
import { AppError, asyncHandler } from '../core/errors.js';
import { sellerPageGates, renderSellerPage } from '../dashboard/seller-page-view.js';
import { setFlash } from '../middleware/view.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { loadSellerInventoryPage, createSellerWarehouse, updateSellerWarehouse, archiveSellerWarehouse,
  recordSellerStockMovement, changeSellerStockCondition, recordSellerInventoryLot, changeSellerInventoryLotStatus } from '../services/seller-inventory-pages.js';

const router = Router();
router.use(['/seller/inventory','/seller/warehouses'],...sellerPageGates('inventory'));
router.get('/seller/inventory',asyncHandler(async(request,response)=>renderSellerPage(request,response,'seller-inventory',await loadSellerInventoryPage(request))));
router.get('/dashboard/seller-inventory',...sellerPageGates('inventory'),(request,response)=>response.redirect(308,'/seller/inventory'+new URL(request.originalUrl,'http://localhost').search));

const draftFields = ['name','country','city','address','variantPublicId','warehousePublicId','stockPublicId','quantity','reason','reorderPoint','damaged','quarantined','binCode','batchNumber','serialNumbers','expiresAt','notes','status'];
function safeDraft(body) {
  return Object.fromEntries(draftFields.filter(key=>typeof body?.[key]==='string').map(key=>[key,body[key].slice(0,key==='serialNumbers'?40_000:600)]));
}
function mutation(section, operation, message) {
  return asyncHandler(async(request,response)=>{
    verifyDeferredCsrf(request);
    try {
      await operation(request,request.body||{});
      setFlash(request,'success',message);
      const stock = typeof request.body?.stockPublicId==='string' ? request.body.stockPublicId : '';
      return response.redirect('/seller/inventory'+(stock?'?stock='+encodeURIComponent(stock)+'#stock-editor':''));
    } catch(error) {
      if (error instanceof ZodError) error = new AppError(error.issues[0]?.message || 'Check the inventory fields.',422,'VALIDATION_ERROR');
      if (error?.code===11000) error = new AppError('That warehouse name or stock location already exists. Refresh inventory and retry.',409,'INVENTORY_DUPLICATE');
      if (error?.name==='VersionError') error = new AppError('Inventory changed. Refresh the item and retry.',409,'INVENTORY_VERSION_CONFLICT');
      if (!(error instanceof AppError) || ![409,422].includes(error.status) || request.accepts(['html','json'])==='json') throw error;
      response.status(error.status);
      return renderSellerPage(request,response,'seller-inventory',await loadSellerInventoryPage(request,{error:error.message,section,draft:{...safeDraft(request.body),targetPublicId:request.params.publicId||''}}));
    }
  });
}
router.post('/seller/warehouses',mutation('warehouse-create',createSellerWarehouse,'Warehouse created.'));
router.post('/seller/warehouses/:publicId/archive',mutation('warehouse-archive',(request,body)=>archiveSellerWarehouse(request,request.params.publicId,body),'Warehouse archived.'));
router.post('/seller/warehouses/:publicId',mutation('warehouse-edit',(request,body)=>updateSellerWarehouse(request,request.params.publicId,body),'Warehouse updated.'));
router.post('/seller/inventory/adjust',mutation('movement',recordSellerStockMovement,'Stock adjusted and movement recorded.'));
router.post('/seller/inventory/condition',mutation('condition',changeSellerStockCondition,'Stock condition and bin updated.'));
router.post('/seller/inventory/lots',mutation('lot',recordSellerInventoryLot,'Inventory lot recorded.'));
router.post('/seller/inventory/lots/:publicId/status',mutation('lot-status',(request,body)=>changeSellerInventoryLotStatus(request,request.params.publicId,body),'Inventory lot status updated.'));
export default router;
